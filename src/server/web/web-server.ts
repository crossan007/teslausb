import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../core/logger';
import {
  SystemStatusView,
  TransferSessionViewService,
  SnapshotListViewService,
} from '../view-services';

export interface WebServerOptions {
  port?: number;
  corsOrigins?: string | string[];
  publicApiBaseUrl?: string;
  publicWsUrl?: string;
  systemStatusView: SystemStatusView;
  transferSessionView: TransferSessionViewService;
  snapshotListView: SnapshotListViewService;
}

/**
 * Express REST API + WebSocket server for UI communication
 */
export class WebServer {
  private app: Express;
  private httpServer: HttpServer;
  private wss: WebSocketServer;
  private port: number;
  private corsOrigins: string | string[];
  private publicApiBaseUrl: string;
  private publicWsUrl: string;
  private readonly systemStatusView: SystemStatusView;
  private readonly transferSessionView: TransferSessionViewService;
  private readonly snapshotListView: SnapshotListViewService;

  constructor(options: WebServerOptions) {
    this.port = options.port ?? 3000;
    this.corsOrigins = options.corsOrigins ?? '*';
    this.publicApiBaseUrl = options.publicApiBaseUrl ?? `http://localhost:${this.port}`;
    this.publicWsUrl = options.publicWsUrl ?? `ws://localhost:${this.port}`;
    this.systemStatusView = options.systemStatusView;
    this.transferSessionView = options.transferSessionView;
    this.snapshotListView = options.snapshotListView;

    this.app = express();
    this.httpServer = new (require('http') as typeof import('http')).Server(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddleware(): void {
    this.app.use(
      cors({
        origin: this.corsOrigins === '*' ? '*' : this.corsOrigins,
        credentials: this.corsOrigins !== '*',
      }),
    );
    this.app.use(express.json());

    this.app.use((_req, _res, next) => {
      logger.debug(`${_req.method} ${_req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // System status
    this.app.get('/api/system-status', async (_req: Request, res: Response) => {
      try {
        const status = await this.systemStatusView.readStatus();
        res.json(status ?? {});
      } catch (error) {
        logger.warn({ err: error }, 'Failed to read system status');
        res.status(500).json({ error: 'Failed to read system status' });
      }
    });

    // Current transfer session
    this.app.get('/api/transfer-session', (_req: Request, res: Response) => {
      try {
        res.json(this.transferSessionView.snapshot());
      } catch (error) {
        logger.warn({ err: error }, 'Failed to read transfer session');
        res.status(500).json({ error: 'Failed to read transfer session' });
      }
    });

    // Transfer session files detail
    this.app.get(
      '/api/transfer-session/files',
      (_req: Request, res: Response) => {
        try {
          res.json(this.transferSessionView.getAllFilesProgress());
        } catch (error) {
          logger.warn(
            { err: error },
            'Failed to read transfer session files',
          );
          res.status(500).json({ error: 'Failed to read files' });
        }
      },
    );

    // Snapshots list
    this.app.get('/api/snapshots', (_req: Request, res: Response) => {
      try {
        res.json(this.snapshotListView.snapshot());
      } catch (error) {
        logger.warn({ err: error }, 'Failed to read snapshots');
        res.status(500).json({ error: 'Failed to read snapshots' });
      }
    });

    // Frontend config (backend URL, api endpoints, etc)
    this.app.get('/api/config', (_req: Request, res: Response) => {
      res.json({
        apiBaseUrl: this.publicApiBaseUrl,
        wsUrl: this.publicWsUrl,
      });
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      logger.debug('WebSocket client connected');

      // Subscribe to view updates and push to client
      const subs = [
        this.transferSessionView.subscribe((session) => {
          ws.send(JSON.stringify({ type: 'transfer-session-update', data: session }), (err?: Error) => {
            if (err) logger.debug({ err }, 'WebSocket send failed');
          });
        }),
        this.snapshotListView.subscribe((snapshots) => {
          ws.send(JSON.stringify({ type: 'snapshots-update', data: snapshots }), (err?: Error) => {
            if (err) logger.debug({ err }, 'WebSocket send failed');
          });
        }),
      ];

      // Periodic system status updates (every 5 seconds)
      const statusInterval = setInterval(async () => {
        try {
          const status = await this.systemStatusView.readStatus();
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({ type: 'system-status-update', data: status }),
              (err?: Error) => {
                if (err) logger.debug({ err }, 'WebSocket send failed');
              },
            );
          }
        } catch (error) {
          logger.debug({ err: error }, 'Failed to send status update');
        }
      }, 5000);

      ws.on('close', () => {
        logger.debug('WebSocket client disconnected');
        clearInterval(statusInterval);
        for (const sub of subs) {
          sub.unsubscribe();
        }
      });

      ws.on('error', (error: Error) => {
        logger.warn({ err: error }, 'WebSocket error');
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        logger.info(
          { port: this.port },
          'Web server listening',
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.clients.forEach((ws: WebSocket) => ws.close());
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

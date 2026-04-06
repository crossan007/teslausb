import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { existsSync } from 'fs';
import { logger } from '../core/logger';
import { stateManager } from '../core';
import { ClipRegistryEntry } from '../../types';
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
  staticPath?: string;
  webUsername?: string;
  webPassword?: string;
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
  private publicApiBaseUrl?: string;
  private publicWsUrl?: string;
  private staticPath: string;
  private webUsername?: string;
  private webPassword?: string;
  private readonly systemStatusView: SystemStatusView;
  private readonly transferSessionView: TransferSessionViewService;
  private readonly snapshotListView: SnapshotListViewService;

  constructor(options: WebServerOptions) {
    this.port = options.port ?? 80;
    this.corsOrigins = options.corsOrigins ?? '*';
    this.publicApiBaseUrl = options.publicApiBaseUrl;
    this.publicWsUrl = options.publicWsUrl;
    this.staticPath = options.staticPath ?? '/root/teslausb-node/html';
    this.webUsername = options.webUsername;
    this.webPassword = options.webPassword;
    this.systemStatusView = options.systemStatusView;
    this.transferSessionView = options.transferSessionView;
    this.snapshotListView = options.snapshotListView;

    this.app = express();
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddleware(): void {
    // Optional basic auth (applied before everything else)
    if (this.webUsername && this.webPassword) {
      const user = this.webUsername;
      const pass = this.webPassword;
      this.app.use((_req: Request, res: Response, next: NextFunction) => {
        const auth = _req.headers.authorization;
        if (auth && auth.startsWith('Basic ')) {
          const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':', 2);
          if (u === user && p === pass) {
            return next();
          }
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="TeslaUSB"');
        res.status(401).send('Unauthorized');
      });
    }

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

    this.app.get('/api/transfer-queue', (_req: Request, res: Response) => {
      try {
        res.json(this.transferSessionView.getTransferQueueSnapshot());
      } catch (error) {
        logger.warn({ err: error }, 'Failed to read transfer queue');
        res.status(500).json({ error: 'Failed to read transfer queue' });
      }
    });

    // Debug diagnostics for clip registry ingest/projection
    this.app.get('/api/debug/clip-registry', (_req: Request, res: Response) => {
      try {
        const limitRaw = Number(_req.query.limit ?? '25');
        const sampleLimit = Number.isFinite(limitRaw)
          ? Math.min(200, Math.max(1, Math.floor(limitRaw)))
          : 25;

        const registry = stateManager.readClipRegistry();
        const pendingClips = stateManager.readPendingClips();
        const transferSession = stateManager.readTransferSession();
        const snapshotState = stateManager.readSnapshot();
        const startupRecovery = stateManager.readStartupRecoveryStatus();

        const entries = registry?.entries ?? [];
        const statusCounts = this.buildStatusCounts(entries);

        const firstSeenSummary = this.groupBySnapshot(entries, 'firstSeenSnapshotId');
        const preferredSummary = this.groupBySnapshot(entries, 'preferredSnapshotId');
        const firstSeenBySnapshot = new Map(firstSeenSummary.map((row) => [row.snapshotId, row]));
        const preferredBySnapshot = new Map(preferredSummary.map((row) => [row.snapshotId, row]));

        const unresolvedByFirstSeenSnapshot = firstSeenSummary.map((row) => ({
          ...row,
          unresolvedCount: row.statusCounts.pending + row.statusCounts.transferring + row.statusCounts.failed,
        }));

        const recentFirstSeen = [...entries]
          .sort((left, right) => right.firstSeenAt - left.firstSeenAt)
          .slice(0, sampleLimit)
          .map((entry) => this.entrySample(entry));

        const recentUpdated = [...entries]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, sampleLimit)
          .map((entry) => this.entrySample(entry));

        const transferQueueSnapshot = this.transferSessionView.getTransferQueueSnapshot();
        const activeSnapshotId = snapshotState?.id;
        const activeFirstSeen = activeSnapshotId ? firstSeenBySnapshot.get(activeSnapshotId)?.totalEntries ?? 0 : 0;
        const activePreferred = activeSnapshotId ? preferredBySnapshot.get(activeSnapshotId)?.totalEntries ?? 0 : 0;

        const alerts: Array<{
          level: 'info' | 'warning';
          code: string;
          message: string;
        }> = [];

        if (activeSnapshotId && activePreferred > 0 && activeFirstSeen === 0) {
          alerts.push({
            level: 'warning',
            code: 'active_snapshot_no_first_seen',
            message: `Active snapshot ${activeSnapshotId} has ${activePreferred} preferred entries but 0 first-seen entries`,
          });
        }

        if (statusCounts.failed > 0) {
          alerts.push({
            level: 'warning',
            code: 'failed_registry_entries',
            message: `${statusCounts.failed} clip registry entries are in failed state`,
          });
        }

        if (entries.length === 0 && (pendingClips?.totalFiles ?? 0) > 0) {
          alerts.push({
            level: 'warning',
            code: 'pending_without_registry_entries',
            message: `Pending clips reports ${pendingClips?.totalFiles ?? 0} files but registry is empty`,
          });
        }

        if (transferQueueSnapshot.length > 0 && (pendingClips?.totalFiles ?? 0) === 0) {
          alerts.push({
            level: 'info',
            code: 'queue_without_pending_snapshot_count',
            message: `Transfer queue has ${transferQueueSnapshot.length} items while pending_clips reports 0`,
          });
        }

        const startupRecoveryCount = startupRecovery?.clipRegistryRecoveredTransferring ?? 0;
        if ((startupRecovery?.transferSessionRecovered ?? false) || startupRecoveryCount > 0) {
          const parts: string[] = [];
          if (startupRecovery?.transferSessionRecovered) {
            parts.push('transfer session');
          }
          if (startupRecoveryCount > 0) {
            parts.push(`${startupRecoveryCount} clip registry entries`);
          }
          alerts.push({
            level: 'info',
            code: 'startup_recovery_performed',
            message: `Startup recovery converted stale state: ${parts.join(', ')}`,
          });
        }

        res.json({
          generatedAt: Date.now(),
          summary: {
            totalEntries: entries.length,
            statusCounts,
            distinctFirstSeenSnapshots: firstSeenSummary.length,
            distinctPreferredSnapshots: preferredSummary.length,
            queueDepth: transferQueueSnapshot.length,
          },
          snapshots: {
            firstSeen: unresolvedByFirstSeenSnapshot,
            preferred: preferredSummary,
          },
          runtime: {
            activeSnapshot: snapshotState
              ? {
                  id: snapshotState.id,
                  createdAt: snapshotState.createdAt,
                  mountPath: snapshotState.mountPath,
                  isLinked: snapshotState.isLinked,
                }
              : null,
            pendingClips: pendingClips
              ? {
                  totalFiles: pendingClips.totalFiles,
                  totalEvents: pendingClips.totalEvents,
                  oldestAgeSec: pendingClips.oldestAgeSec,
                }
              : null,
            transferSession: transferSession
              ? {
                  sessionId: transferSession.sessionId,
                  phase: transferSession.phase,
                  filesTotal: transferSession.filesTotal,
                  filesCompleted: transferSession.filesCompleted,
                  filesFailed: transferSession.filesFailed,
                  currentFilePath: transferSession.currentFilePath,
                  updatedAt: transferSession.updatedAt,
                }
              : null,
            startupRecovery: startupRecovery
              ? {
                  updatedAt: startupRecovery.updatedAt,
                  transferSessionRecovered: startupRecovery.transferSessionRecovered,
                  clipRegistryRecoveredTransferring: startupRecovery.clipRegistryRecoveredTransferring,
                }
              : null,
          },
          alerts,
          recentSamples: {
            byFirstSeenAtDesc: recentFirstSeen,
            byUpdatedAtDesc: recentUpdated,
          },
        });
      } catch (error) {
        logger.warn({ err: error }, 'Failed to build clip registry debug diagnostics');
        res.status(500).json({ error: 'Failed to build clip registry debug diagnostics' });
      }
    });

    this.app.post('/api/debug/startup-recovery/clear', (_req: Request, res: Response) => {
      try {
        stateManager.writeStartupRecoveryStatus({
          updatedAt: Date.now(),
          transferSessionRecovered: false,
          clipRegistryRecoveredTransferring: 0,
        });

        res.json({
          ok: true,
          message: 'Startup recovery status cleared',
        });
      } catch (error) {
        logger.warn({ err: error }, 'Failed to clear startup recovery status');
        res.status(500).json({ error: 'Failed to clear startup recovery status' });
      }
    });

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
      const host = _req.get('host') ?? `localhost:${this.port}`;
      const forwardedProto = _req.headers['x-forwarded-proto'];
      const effectiveProto = typeof forwardedProto === 'string'
        ? forwardedProto.split(',')[0].trim()
        : _req.protocol;
      const isSecure = effectiveProto === 'https';
      const derivedApiBaseUrl = `${isSecure ? 'https' : 'http'}://${host}`;
      const derivedWsUrl = `${isSecure ? 'wss' : 'ws'}://${host}`;

      res.json({
        apiBaseUrl: this.publicApiBaseUrl ?? derivedApiBaseUrl,
        wsUrl: this.publicWsUrl ?? derivedWsUrl,
      });
    });

    // TeslaCam video/clip browser — served from FUSE mount (cttseraser for Chrome compat)
    this.app.use('/TeslaCam', express.static('/mnt/TeslaCam', { index: false }));

    // React SPA static files
    if (existsSync(this.staticPath)) {
      this.app.use(express.static(this.staticPath));
      // SPA fallback: all non-API, non-TeslaCam routes serve index.html
      this.app.get('*', (_req: Request, res: Response) => {
        res.sendFile('index.html', { root: this.staticPath });
      });
    } else {
      logger.warn({ staticPath: this.staticPath }, 'Static files path does not exist; SPA not served');
    }
  }

  private buildStatusCounts(entries: ClipRegistryEntry[]): Record<'pending' | 'transferring' | 'failed' | 'transferred', number> {
    return entries.reduce(
      (acc, entry) => {
        acc[entry.status] += 1;
        return acc;
      },
      {
        pending: 0,
        transferring: 0,
        failed: 0,
        transferred: 0,
      },
    );
  }

  private groupBySnapshot(
    entries: ClipRegistryEntry[],
    key: 'firstSeenSnapshotId' | 'preferredSnapshotId',
  ): Array<{
    snapshotId: string;
    totalEntries: number;
    statusCounts: Record<'pending' | 'transferring' | 'failed' | 'transferred', number>;
    oldestFirstSeenAt: number;
    newestUpdatedAt: number;
  }> {
    const grouped = new Map<string, ClipRegistryEntry[]>();
    for (const entry of entries) {
      const snapshotId = entry[key];
      const list = grouped.get(snapshotId) ?? [];
      list.push(entry);
      grouped.set(snapshotId, list);
    }

    return Array.from(grouped.entries())
      .map(([snapshotId, snapshotEntries]) => ({
        snapshotId,
        totalEntries: snapshotEntries.length,
        statusCounts: this.buildStatusCounts(snapshotEntries),
        oldestFirstSeenAt: snapshotEntries.reduce((min, entry) => Math.min(min, entry.firstSeenAt), Number.MAX_SAFE_INTEGER),
        newestUpdatedAt: snapshotEntries.reduce((max, entry) => Math.max(max, entry.updatedAt), 0),
      }))
      .sort((left, right) => right.totalEntries - left.totalEntries || left.snapshotId.localeCompare(right.snapshotId));
  }

  private entrySample(entry: ClipRegistryEntry): {
    key: string;
    relPath: string;
    status: ClipRegistryEntry['status'];
    firstSeenSnapshotId: string;
    preferredSnapshotId: string;
    firstSeenAt: number;
    updatedAt: number;
    ageSec: number;
  } {
    return {
      key: entry.key,
      relPath: entry.relPath,
      status: entry.status,
      firstSeenSnapshotId: entry.firstSeenSnapshotId,
      preferredSnapshotId: entry.preferredSnapshotId,
      firstSeenAt: entry.firstSeenAt,
      updatedAt: entry.updatedAt,
      ageSec: entry.ageSec,
    };
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

          ws.send(
            JSON.stringify({
              type: 'transfer-queue-update',
              data: this.transferSessionView.getTransferQueueSnapshot(),
            }),
            (err?: Error) => {
              if (err) logger.debug({ err }, 'WebSocket send failed');
            },
          );
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

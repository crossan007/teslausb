import { logger } from '../../core/logger';
import { ArchiveEventBusLike } from '../../orchestrator/events';
import { SystemStatusManager } from '../../core/system-status-manager';
import { SnapshotManager } from '../../orchestrator/snapshot-manager';
import { TeslaUSBConfig } from '../../types';
import {
  SystemStatusView,
  TransferSessionViewService,
  SnapshotListViewService,
} from '../view-services';
import { WebServer, WebServerOptions } from './web-server';
import { ClipDiscoveryResult } from '../../orchestrator/clip-discovery-manager';

/**
 * Wires view services to orchestrator event bus and coordinators
 */
export class WebServerIntegration {
  private webServer: WebServer;
  private transferSessionView: TransferSessionViewService;
  private snapshotListView: SnapshotListViewService;

  constructor(
    eventBus: ArchiveEventBusLike,
    statusManager: SystemStatusManager,
    snapshotManager: SnapshotManager,
    config: TeslaUSBConfig,
    options?: Partial<WebServerOptions>,
  ) {
    // Inject snapshot manager and config overrides into system status manager
    statusManager = new SystemStatusManager({
      snapshotManager,
      defaultGateway: config.systemStatusDefaultGateway,
      pingPacketSize: config.systemStatusPingPacketSize,
      commandRunner: (statusManager as any).commandRunner,
    });

    const systemStatusView = new SystemStatusView(statusManager);
    this.transferSessionView = new TransferSessionViewService(eventBus);
    this.snapshotListView = new SnapshotListViewService(eventBus);

    this.webServer = new WebServer({
      port: 3000,
      corsOrigins: config.uiCorsOrigins,
      systemStatusView,
      transferSessionView: this.transferSessionView,
      snapshotListView: this.snapshotListView,
      publicApiBaseUrl: config.publicApiBaseUrl,
      publicWsUrl: config.publicWsUrl,
      ...options,
    });

    // Wire transfer progress events to views
    this.setupTransferWiring(eventBus);

    // Wire pending clips to transfer session
    this.setupStateWiring();
  }

  private setupTransferWiring(
    eventBus: ArchiveEventBusLike,
  ): void {
    // Subscribe to archive events to track file transfers
    eventBus.subscribe(async (event) => {
      if (event.type === 'archive-start') {
        logger.debug({ totalFiles: event.totalFiles }, 'Recording archive start');
      } else if (event.type === 'archive-finish') {
        logger.debug(
          { succeeded: event.succeeded },
          'Recording archive finish',
        );
      }
    });
  }

  private setupStateWiring(): void {
    // Hook into state manager to observe pending clips changes
    // This would be an observer on the state manager firing updates to transfer view
  }

  async start(): Promise<void> {
    await this.webServer.start();
  }

  async stop(): Promise<void> {
    await this.webServer.stop();
  }

  /**
   * Called from lifecycle loop to update transfer progress
   */
  updateDiscoveryResult(result: ClipDiscoveryResult): void {
    // Snapshot added
    if (result.snapshot) {
      this.snapshotListView.addSnapshot(result.snapshot);
    }

    // Files discovered for this snapshot
    this.snapshotListView.setSnapshotFiles(
      result.snapshot?.id ?? 'unknown',
      result.filePaths,
    );

    // Initial pending clips state
    this.transferSessionView.setPendingClips(result.pendingClips);
  }

  /**
   * Called from archive coordinator to update file transfer status
   */
  updateFileTransferStart(filePath: string, totalBytes: number): void {
    this.transferSessionView.setFileTransferring(filePath, totalBytes);
  }

  /**
   * Called from archive coordinator during transfer progress
   */
  updateFileTransferProgress(filePath: string, transferredBytes: number): void {
    this.transferSessionView.updateTransferProgress(filePath, transferredBytes);
  }

  /**
   * Called from archive coordinator when file transfer completes
   */
  updateFileTransferCompleted(filePath: string): void {
    this.transferSessionView.setFileCompleted(filePath);
  }

  /**
   * Called from archive coordinator when file transfer fails
   */
  updateFileTransferFailed(filePath: string): void {
    this.transferSessionView.setFileFailed(filePath);
  }
}

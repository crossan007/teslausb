import { TransferSessionView, FileTransferProgress } from './types';
import { BaseViewService } from './base-view-service';
import { ArchiveEventBusLike } from '../orchestrator/events';
import { ClipRegistry } from '../../types';

/**
 * Tracks current transferring batch and file-level progress
 */
export class TransferSessionViewService extends BaseViewService<TransferSessionView> {
  private currentSession: TransferSessionView = {
    isActive: false,
    filesFailed: 0,
    overallProgressPercent: 0,
  };

  private fileProgress = new Map<string, FileTransferProgress>();
  constructor(private readonly eventBus: ArchiveEventBusLike) {
    super();

    // Subscribe to archive lifecycle and transfer progress events
    this.eventBus.subscribe(async (event) => {
      if (event.type === 'archive-start') {
        this.handleArchiveStart();
      } else if (event.type === 'archive-finish') {
        this.handleArchiveFinish();
      }
      // Note: Transfer progress events from backend will be pushed via WebSocket
      // and trigger emit() when data updates
    });
  }

  snapshot(): TransferSessionView {
    return this.currentSession;
  }

  /**
   * Projects clip registry state into the web view model.
   */
  applyClipRegistry(registry: ClipRegistry): void {
    this.fileProgress.clear();
    for (const entry of registry.entries) {
      if (entry.status === 'transferred') {
        continue;
      }

      const status: FileTransferProgress['status'] =
        entry.status === 'transferring'
          ? 'transferring'
          : entry.status === 'failed'
            ? 'failed'
            : 'pending';

      this.fileProgress.set(entry.relPath, {
        relPath: entry.relPath,
        isSymlink: entry.isSymlink,
        ageSec: entry.ageSec,
        status,
      });
    }

    this.emit();
  }

  getTransferQueueSnapshot(): FileTransferProgress[] {
    return Array.from(this.fileProgress.values());
  }

  private handleArchiveStart(): void {
    this.currentSession.isActive = true;
    this.currentSession.filesFailed = 0;
    this.currentSession.startedAtEpoch = Math.floor(Date.now() / 1000);
    this.emit();
  }

  private handleArchiveFinish(): void {
    this.currentSession.isActive = false;
    this.currentSession.currentFile = undefined;
    this.emit();

    // Could add history tracking here if desired
  }
}

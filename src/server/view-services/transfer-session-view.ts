import { TransferSessionView, FileTransferProgress } from './types';
import { BaseViewService } from './base-view-service';
import { ArchiveEventBusLike } from '../orchestrator/events';
import { TransferQueue, TransferSession } from '../../types';

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
   * Applies queue-centric transfer state persisted by the orchestrator.
   */
  applyTransferQueue(queue: TransferQueue): void {
    this.fileProgress.clear();
    for (const file of queue.files) {
      const status: FileTransferProgress['status'] =
        file.status === 'transferring' ? 'transferring' : 'pending';

      this.fileProgress.set(file.relPath, {
        relPath: file.relPath,
        isSymlink: file.isSymlink,
        ageSec: file.ageSec,
        status,
      });
    }

    this.emit();
  }

  /**
   * Projects persisted transfer session state into the web view model.
   */
  applyTransferSession(session: TransferSession): void {
    this.currentSession.isActive =
      session.phase === 'starting' ||
      session.phase === 'transferring' ||
      session.phase === 'finalizing';
    this.currentSession.filesFailed = session.filesFailed;
    this.currentSession.startedAtEpoch = session.startedAt;
    this.currentSession.overallProgressPercent = session.batchPercent ?? this.currentSession.overallProgressPercent;

    for (const file of session.files) {
      const status: FileTransferProgress['status'] =
        file.status === 'completed'
          ? 'archived'
          : file.status === 'transferring'
            ? 'transferring'
            : file.status === 'failed'
              ? 'failed'
              : 'pending';

      const existing = this.fileProgress.get(file.path);
      this.fileProgress.set(file.path, {
        relPath: file.path,
        isSymlink: existing?.isSymlink ?? true,
        ageSec: existing?.ageSec ?? 0,
        status,
        totalBytes: file.totalBytes,
        transferredBytes: file.bytesTransferred,
        progressPercent: file.percent,
      });
    }

    for (const [relPath, file] of this.fileProgress.entries()) {
      if (!session.files.some((sessionFile) => sessionFile.path === relPath)) {
        this.fileProgress.set(relPath, {
          ...file,
          status: file.status === 'transferring' ? 'pending' : file.status,
        });
      }
    }

    const currentFilePath = session.currentFilePath;
    this.currentSession.currentFile = currentFilePath
      ? this.fileProgress.get(currentFilePath)
      : undefined;

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

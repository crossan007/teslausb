import { TransferSessionView, FileTransferProgress } from './types';
import { BaseViewService } from './base-view-service';
import { ArchiveEventBusLike } from '../../orchestrator/events';
import { PendingClips } from '../../types';

/**
 * Tracks current transferring batch and file-level progress
 */
export class TransferSessionViewService extends BaseViewService<TransferSessionView> {
  private currentSession: TransferSessionView = {
    isActive: false,
    totalFilesInBatch: 0,
    filesCompleted: 0,
    filesFailed: 0,
    overallProgressPercent: 0,
  };

  private fileProgress = new Map<string, FileTransferProgress>();
  private currentFile: FileTransferProgress | undefined;

  constructor(private readonly eventBus: ArchiveEventBusLike) {
    super();

    // Subscribe to archive lifecycle and transfer progress events
    this.eventBus.subscribe(async (event) => {
      if (event.type === 'archive-start') {
        this.handleArchiveStart(event.totalFiles);
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
   * Called when discovery completes and archive batch starts
   */
  setPendingClips(pending: PendingClips): void {
    this.currentSession.totalFilesInBatch = pending.totalFiles;
    this.fileProgress.clear();

    // Initialize progress for each file
    for (const file of pending.files) {
      this.fileProgress.set(file.relPath, {
        ...file,
        status: 'pending',
      });
    }

    this.emit();
  }

  /**
   * Called when transfer starts on a file
   */
  setFileTransferring(relPath: string, totalBytes: number): void {
    const progress = this.fileProgress.get(relPath);
    if (!progress) {
      return;
    }

    progress.status = 'transferring';
    progress.totalBytes = totalBytes;
    progress.transferredBytes = 0;
    progress.progressPercent = 0;
    this.currentFile = progress;

    if (!this.currentSession.startedAtEpoch) {
      this.currentSession.startedAtEpoch = Math.floor(Date.now() / 1000);
      this.currentSession.isActive = true;
    }

    this.emit();
  }

  /**
   * Called to update transfer progress on current file
   */
  updateTransferProgress(relPath: string, transferredBytes: number): void {
    const progress = this.fileProgress.get(relPath);
    if (!progress || !progress.totalBytes) {
      return;
    }

    progress.transferredBytes = transferredBytes;
    progress.progressPercent = Math.round(
      (transferredBytes / progress.totalBytes) * 100,
    );

    this.updateOverallProgress();
    this.emit();
  }

  /**
   * Called when file transfer completes
   */
  setFileCompleted(relPath: string): void {
    const progress = this.fileProgress.get(relPath);
    if (!progress) {
      return;
    }

    progress.status = 'archived';
    progress.progressPercent = 100;
    progress.transferredBytes = progress.totalBytes;
    this.currentSession.filesCompleted++;

    if (this.currentFile?.relPath === relPath) {
      this.currentFile = undefined;
    }

    this.updateOverallProgress();
    this.emit();
  }

  /**
   * Called when file transfer fails
   */
  setFileFailed(relPath: string): void {
    const progress = this.fileProgress.get(relPath);
    if (!progress) {
      return;
    }

    progress.status = 'failed';
    this.currentSession.filesFailed++;

    if (this.currentFile?.relPath === relPath) {
      this.currentFile = undefined;
    }

    this.updateOverallProgress();
    this.emit();
  }

  /**
   * Get all file progress in current batch
   */
  getAllFilesProgress(): FileTransferProgress[] {
    return Array.from(this.fileProgress.values());
  }

  private handleArchiveStart(totalFiles: number): void {
    this.currentSession.isActive = true;
    this.currentSession.totalFilesInBatch = totalFiles;
    this.currentSession.filesCompleted = 0;
    this.currentSession.filesFailed = 0;
    this.currentSession.startedAtEpoch = Math.floor(Date.now() / 1000);
    this.fileProgress.clear();
    this.emit();
  }

  private handleArchiveFinish(): void {
    this.currentSession.isActive = false;
    this.emit();

    // Could add history tracking here if desired
  }

  private updateOverallProgress(): void {
    if (this.currentSession.totalFilesInBatch === 0) {
      this.currentSession.overallProgressPercent = 0;
      return;
    }

    let totalBytes = 0;
    let transferredBytes = 0;

    for (const progress of this.fileProgress.values()) {
      if (progress.totalBytes) {
        totalBytes += progress.totalBytes;
        transferredBytes +=
          progress.transferredBytes ?? (progress.status === 'archived' ? progress.totalBytes : 0);
      }
    }

    if (totalBytes === 0) {
      this.currentSession.overallProgressPercent = 0;
    } else {
      this.currentSession.overallProgressPercent = Math.round(
        (transferredBytes / totalBytes) * 100,
      );
    }
  }
}

import { SnapshotView, FileTransferProgress } from './types';
import { BaseViewService } from './base-view-service';
import { ArchiveEventBusLike } from '../../orchestrator/events';
import { Snapshot } from '../../types';

/**
 * Tracks active snapshots and file-level progress per snapshot
 */
export class SnapshotListViewService extends BaseViewService<SnapshotView[]> {
  private snapshots = new Map<string, SnapshotView>();
  private snapshotFiles = new Map<string, Map<string, FileTransferProgress>>();

  constructor(private readonly eventBus: ArchiveEventBusLike) {
    super();

    this.eventBus.subscribe(async (event) => {
      if (event.type === 'snapshot-ready') {
        this.addSnapshot(event.snapshot);
      }
    });
  }

  snapshot(): SnapshotView[] {
    return Array.from(this.snapshots.values()).sort(
      (a, b) => b.snapshot.createdAt - a.snapshot.createdAt,
    );
  }

  /**
   * Add snapshot to list
   */
  addSnapshot(snapshot: Snapshot): void {
    if (!this.snapshots.has(snapshot.id)) {
      this.snapshots.set(snapshot.id, {
        snapshot,
        newFilesCount: 0,
        filesInProgress: [],
      });
      this.snapshotFiles.set(snapshot.id, new Map());
      this.emit();
    }
  }

  /**
   * Set files discovered for this snapshot
   */
  setSnapshotFiles(snapshotId: string, filePaths: string[]): void {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      return;
    }

    snap.newFilesCount = filePaths.length;
    const files = this.snapshotFiles.get(snapshotId);
    if (files) {
      files.clear();
      for (const relPath of filePaths) {
        files.set(relPath, {
          relPath,
          isSymlink: true,
          ageSec: 0,
          status: 'pending',
        });
      }
    }

    snap.filesInProgress = Array.from(files?.values() ?? []);
    this.emit();
  }

  /**
   * Update file progress for a snapshot
   */
  updateSnapshotFileProgress(
    snapshotId: string,
    relPath: string,
    status: 'pending' | 'transferring' | 'archived' | 'failed',
    progressPercent?: number,
  ): void {
    const files = this.snapshotFiles.get(snapshotId);
    if (!files) {
      return;
    }

    const file = files.get(relPath);
    if (!file) {
      return;
    }

    file.status = status;
    if (progressPercent !== undefined) {
      file.progressPercent = progressPercent;
    }

    const snap = this.snapshots.get(snapshotId);
    if (snap) {
      snap.filesInProgress = Array.from(files.values());
      this.emit();
    }
  }

  /**
   * Remove completed snapshot from view
   */
  removeSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
    this.snapshotFiles.delete(snapshotId);
    this.emit();
  }
}

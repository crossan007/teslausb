import { SnapshotView, FileTransferProgress } from './types';
import { BaseViewService } from './base-view-service';
import { ActiveSnapshotSource } from '../orchestrator/snapshot/snapshot-manager';
import { ClipRegistry, Snapshot } from '../../types';

/**
 * Tracks active snapshots and file-level progress per snapshot
 */
export class SnapshotListViewService extends BaseViewService<SnapshotView[]> {
  private snapshots = new Map<string, SnapshotView>();
  private snapshotFiles = new Map<string, Map<string, FileTransferProgress>>();

  constructor(snapshotSource: ActiveSnapshotSource) {
    super();
    snapshotSource.subscribeActiveSnapshots((snapshots) => {
      this.syncActiveSnapshots(snapshots);
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

  private syncActiveSnapshots(snapshots: Snapshot[]): void {
    const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));

    for (const snapshotId of Array.from(this.snapshots.keys())) {
      if (!activeIds.has(snapshotId)) {
        this.snapshots.delete(snapshotId);
        this.snapshotFiles.delete(snapshotId);
      }
    }

    for (const snapshot of snapshots) {
      const existing = this.snapshots.get(snapshot.id);
      if (existing) {
        existing.snapshot = snapshot;
        continue;
      }

      this.snapshots.set(snapshot.id, {
        snapshot,
        newFilesCount: 0,
        filesInProgress: [],
      });
      this.snapshotFiles.set(snapshot.id, new Map());
    }

    this.emit();
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
   * Projects clip registry into per-snapshot file lists and first-seen counts.
   */
  applyClipRegistry(registry: ClipRegistry): void {
    const bySnapshotId = new Map<string, Map<string, FileTransferProgress>>();
    const firstSeenCounts = new Map<string, number>();

    for (const entry of registry.entries) {
      firstSeenCounts.set(
        entry.firstSeenSnapshotId,
        (firstSeenCounts.get(entry.firstSeenSnapshotId) ?? 0) + 1,
      );

      if (entry.status === 'transferred') {
        continue;
      }

      const status: FileTransferProgress['status'] =
        entry.status === 'transferring'
          ? 'transferring'
          : entry.status === 'failed'
            ? 'failed'
            : 'pending';

      const mapForSnapshot = bySnapshotId.get(entry.firstSeenSnapshotId) ?? new Map<string, FileTransferProgress>();
      if (!mapForSnapshot.has(entry.relPath)) {
        mapForSnapshot.set(entry.relPath, {
          relPath: entry.relPath,
          isSymlink: entry.isSymlink,
          ageSec: entry.ageSec,
          status,
        });
      }
      bySnapshotId.set(entry.firstSeenSnapshotId, mapForSnapshot);
    }

    this.snapshotFiles = bySnapshotId;

    for (const snap of this.snapshots.values()) {
      const files = bySnapshotId.get(snap.snapshot.id);
      snap.filesInProgress = Array.from(files?.values() ?? []);
      snap.newFilesCount = firstSeenCounts.get(snap.snapshot.id) ?? 0;
    }

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

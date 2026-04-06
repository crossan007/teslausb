import { Snapshot, TransferQueue, TransferQueueFile } from '../../types';
import { ClipDiscoveryResult, ClipMetadata } from './clip-discovery-manager';

interface SnapshotRef {
  snapshot: Snapshot;
  refCount: number;
  releasing: boolean;
}

interface TransferQueueManagerOptions {
  persistQueue?: (queue: TransferQueue) => void;
}

export interface TransferBatch {
  sourceRootPath: string;
  sourceSnapshotId: string;
  clips: TransferQueueFile[];
}

export class TransferQueueManager {
  private readonly queueByKey = new Map<string, TransferQueueFile>();
  private readonly snapshotRefs = new Map<string, SnapshotRef>();

  constructor(private readonly options: TransferQueueManagerOptions = {}) {}

  async ingestDiscovery(result: ClipDiscoveryResult): Promise<void> {
    const snapshot = result.snapshot;
    if (!snapshot) {
      return;
    }

    this.ensureSnapshotRef(snapshot);

    const now = Date.now();
    for (const clip of result.clips) {
      const key = clip.key;
      const existing = this.queueByKey.get(key);

      if (!existing) {
        const queued: TransferQueueFile = {
          key,
          clipName: clip.fileName,
          relPath: clip.relPath,
          status: 'queued',
          isSymlink: clip.isSymlink,
          ageSec: clip.ageSec,
          sourceSnapshotId: snapshot.id,
          sourceRootPath: result.rootPath,
          sourceSnapshotCreatedAt: snapshot.createdAt ?? 0,
          updatedAt: now,
        };
        this.queueByKey.set(key, queued);
        this.incrementSnapshotRef(snapshot.id);
        continue;
      }

      if (existing.relPath !== clip.relPath) {
        continue;
      }

      existing.clipName = clip.fileName;
      existing.ageSec = clip.ageSec;
      existing.isSymlink = clip.isSymlink;

      if (
        existing.status === 'queued' &&
        snapshot.id !== existing.sourceSnapshotId &&
        (snapshot.createdAt ?? 0) >= existing.sourceSnapshotCreatedAt
      ) {
        this.decrementSnapshotRef(existing.sourceSnapshotId);
        existing.sourceSnapshotId = snapshot.id;
        existing.sourceRootPath = result.rootPath;
        existing.sourceSnapshotCreatedAt = snapshot.createdAt ?? 0;
        this.incrementSnapshotRef(snapshot.id);
      }

      existing.updatedAt = now;
    }

    await this.releaseUnusedSnapshots();
    this.persist();
  }

  nextQueuedClip(): TransferQueueFile | undefined {
    const queued = Array.from(this.queueByKey.values())
      .filter((file) => file.status === 'queued')
      .sort((left, right) => {
        if (left.updatedAt !== right.updatedAt) {
          return left.updatedAt - right.updatedAt;
        }
        return left.relPath.localeCompare(right.relPath);
      });

    if (queued.length === 0) {
      return undefined;
    }

    return { ...queued[0] };
  }

  markTransferring(clips: Pick<ClipMetadata, 'key'>[]): void {
    const now = Date.now();
    for (const clip of clips) {
      const queueFile = this.getByKey(clip.key);
      if (!queueFile) {
        continue;
      }
      queueFile.status = 'transferring';
      queueFile.updatedAt = now;
    }
    this.persist();
  }

  async markCompleted(clips: Pick<ClipMetadata, 'key'>[]): Promise<void> {
    for (const clip of clips) {
      const queueFile = this.getByKey(clip.key);
      if (!queueFile) {
        continue;
      }

      this.queueByKey.delete(queueFile.key);
      this.decrementSnapshotRef(queueFile.sourceSnapshotId);
    }

    await this.releaseUnusedSnapshots();
    this.persist();
  }

  resetToQueued(clips: Pick<ClipMetadata, 'key'>[]): void {
    const now = Date.now();
    for (const clip of clips) {
      const queueFile = this.getByKey(clip.key);
      if (!queueFile || queueFile.status !== 'transferring') {
        continue;
      }
      queueFile.status = 'queued';
      queueFile.updatedAt = now;
    }
    this.persist();
  }

  snapshot(): TransferQueue {
    return {
      updatedAt: Date.now(),
      files: Array.from(this.queueByKey.values())
        .map((file) => ({ ...file }))
        .sort((left, right) => left.relPath.localeCompare(right.relPath)),
    };
  }

  private getByKey(key: string): TransferQueueFile | undefined {
    return this.queueByKey.get(key);
  }

  private ensureSnapshotRef(snapshot: Snapshot): void {
    const existing = this.snapshotRefs.get(snapshot.id);
    if (existing) {
      existing.snapshot = snapshot;
      return;
    }

    this.snapshotRefs.set(snapshot.id, {
      snapshot,
      refCount: 0,
      releasing: false,
    });
  }

  private incrementSnapshotRef(snapshotId: string): void {
    const ref = this.snapshotRefs.get(snapshotId);
    if (!ref) {
      return;
    }
    ref.refCount += 1;
  }

  private decrementSnapshotRef(snapshotId: string): void {
    const ref = this.snapshotRefs.get(snapshotId);
    if (!ref) {
      return;
    }
    ref.refCount = Math.max(0, ref.refCount - 1);
  }

  private async releaseUnusedSnapshots(): Promise<void> {
    for (const [snapshotId, ref] of this.snapshotRefs.entries()) {
      if (ref.refCount > 0 || ref.releasing) {
        continue;
      }

      const release = ref.snapshot.release;
      if (!release) {
        this.snapshotRefs.delete(snapshotId);
        continue;
      }

      ref.releasing = true;
      try {
        await release();
      } finally {
        this.snapshotRefs.delete(snapshotId);
      }
    }
  }

  private persist(): void {
    this.options.persistQueue?.(this.snapshot());
  }
}

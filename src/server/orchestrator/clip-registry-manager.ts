import { ClipRegistry, ClipRegistryEntry, Snapshot, TransferQueue, TransferQueueFile } from '../../types';
import { ClipDiscoveryResult } from './clip-discovery-manager';
import { logger } from '../core';

interface SnapshotRef {
  snapshot: Snapshot;
  releasing: boolean;
}

interface ClipRegistryManagerOptions {
  initialRegistry?: ClipRegistry;
  persistRegistry?: (registry: ClipRegistry) => void;
}

export class ClipRegistryManager {
  private readonly entriesByKey = new Map<string, ClipRegistryEntry>();
  private readonly snapshotRefs = new Map<string, SnapshotRef>();
  private readonly recoveredTransferringAtStartup: number;

  constructor(private readonly options: ClipRegistryManagerOptions = {}) {
    const initial = options.initialRegistry;
    const now = Date.now();
    let recoveredTransferring = 0;
    for (const entry of initial?.entries ?? []) {
      const hydrated = { ...entry };
      if (hydrated.status === 'transferring') {
        hydrated.status = 'failed';
        hydrated.updatedAt = now;
        recoveredTransferring += 1;
      }

      this.entriesByKey.set(hydrated.key, hydrated);
    }

    this.recoveredTransferringAtStartup = recoveredTransferring;

    if (recoveredTransferring > 0) {
      this.persist();
      logger.warn(
        {
          recoveredTransferring,
          registryEntriesTotal: this.entriesByKey.size,
        },
        'Recovered stale transferring clip registry entries at startup',
      );
    }
  }

  startupRecoveredTransferringCount(): number {
    return this.recoveredTransferringAtStartup;
  }

  async ingestDiscovery(result: ClipDiscoveryResult): Promise<void> {
    const snapshot = result.snapshot;
    if (!snapshot) {
      return;
    }

    this.ensureSnapshotRef(snapshot);

    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    for (const clip of result.clips) {
      const existing = this.entriesByKey.get(clip.key);

      if (!existing) {
        inserted += 1;
        this.entriesByKey.set(clip.key, {
          key: clip.key,
          clipName: clip.fileName,
          relPath: clip.relPath,
          firstSeenSnapshotId: snapshot.id,
          firstSeenSnapshotCreatedAt: snapshot.createdAt ?? 0,
          firstSeenAt: now,
          preferredSnapshotId: snapshot.id,
          preferredRootPath: result.rootPath,
          preferredSnapshotCreatedAt: snapshot.createdAt ?? 0,
          status: 'pending',
          isSymlink: clip.isSymlink,
          ageSec: clip.ageSec,
          updatedAt: now,
        });
        continue;
      }

      updated += 1;
      existing.clipName = clip.fileName;
      existing.ageSec = clip.ageSec;
      existing.isSymlink = clip.isSymlink;

      if (
        existing.status !== 'transferred' &&
        (snapshot.createdAt ?? 0) >= existing.preferredSnapshotCreatedAt
      ) {
        existing.preferredSnapshotId = snapshot.id;
        existing.preferredRootPath = result.rootPath;
        existing.preferredSnapshotCreatedAt = snapshot.createdAt ?? 0;
      }

      existing.updatedAt = now;
    }

    await this.releaseSnapshotsIfEligible();
    this.persist();
    logger.info(
      {
        snapshotId: snapshot.id,
        discovered: result.clips.length,
        inserted,
        updated,
        unresolvedFirstSeenForSnapshot: this.unresolvedCountForFirstSeenSnapshot(snapshot.id),
        firstSeenCountForSnapshot: this.countFirstSeenForSnapshot(snapshot.id),
        registryEntriesTotal: this.entriesByKey.size,
      },
      'Clip registry ingest applied',
    );
  }

  nextClipForTransfer(): ClipRegistryEntry | undefined {
    const candidates = Array.from(this.entriesByKey.values())
      .filter((entry) => entry.status === 'pending' || entry.status === 'failed')
      .sort((left, right) => {
        if (left.firstSeenSnapshotCreatedAt !== right.firstSeenSnapshotCreatedAt) {
          return left.firstSeenSnapshotCreatedAt - right.firstSeenSnapshotCreatedAt;
        }
        if (left.updatedAt !== right.updatedAt) {
          return left.updatedAt - right.updatedAt;
        }
        return left.relPath.localeCompare(right.relPath);
      });

    return candidates[0] ? { ...candidates[0] } : undefined;
  }

  markTransferring(key: string): void {
    const entry = this.entriesByKey.get(key);
    if (!entry || entry.status === 'transferred') {
      return;
    }
    const now = Date.now();
    entry.status = 'transferring';
    entry.lastAttemptAt = now;
    entry.updatedAt = now;
    this.persist();
  }

  async markTransferred(key: string): Promise<void> {
    const entry = this.entriesByKey.get(key);
    if (!entry) {
      return;
    }
    const now = Date.now();
    entry.status = 'transferred';
    entry.transferredAt = now;
    entry.updatedAt = now;

    await this.releaseSnapshotsIfEligible();
    this.persist();
  }

  markTransferFailed(key: string): void {
    const entry = this.entriesByKey.get(key);
    if (!entry || entry.status === 'transferred') {
      return;
    }

    entry.status = 'failed';
    entry.updatedAt = Date.now();
    this.persist();
  }

  snapshotRegistry(): ClipRegistry {
    return {
      updatedAt: Date.now(),
      entries: Array.from(this.entriesByKey.values())
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.relPath.localeCompare(right.relPath)),
    };
  }

  snapshotTransferQueue(): TransferQueue {
    const files: TransferQueueFile[] = Array.from(this.entriesByKey.values())
      .filter((entry) => entry.status !== 'transferred')
      .map((entry): TransferQueueFile => {
        const status: TransferQueueFile['status'] =
          entry.status === 'transferring' ? 'transferring' : 'queued';

        return {
          key: entry.key,
          clipName: entry.clipName,
          relPath: entry.relPath,
          status,
          isSymlink: entry.isSymlink,
          ageSec: entry.ageSec,
          sourceSnapshotId: entry.preferredSnapshotId,
          sourceRootPath: entry.preferredRootPath,
          sourceSnapshotCreatedAt: entry.preferredSnapshotCreatedAt,
          updatedAt: entry.updatedAt,
        };
      })
      .sort((left, right) => left.relPath.localeCompare(right.relPath));

    return {
      updatedAt: Date.now(),
      files,
    };
  }

  pendingSummary(): { totalFiles: number; oldestAgeSec: number } {
    const pending = Array.from(this.entriesByKey.values()).filter((entry) => entry.status !== 'transferred');
    const oldestAgeSec = pending.reduce((oldest, entry) => Math.max(oldest, entry.ageSec), 0);
    return {
      totalFiles: pending.length,
      oldestAgeSec,
    };
  }

  private ensureSnapshotRef(snapshot: Snapshot): void {
    const existing = this.snapshotRefs.get(snapshot.id);
    if (existing) {
      existing.snapshot = snapshot;
      return;
    }

    this.snapshotRefs.set(snapshot.id, {
      snapshot,
      releasing: false,
    });
  }

  private unresolvedCountForFirstSeenSnapshot(snapshotId: string): number {
    let count = 0;
    for (const entry of this.entriesByKey.values()) {
      if (entry.firstSeenSnapshotId === snapshotId && entry.status !== 'transferred') {
        count += 1;
      }
    }
    return count;
  }

  private countFirstSeenForSnapshot(snapshotId: string): number {
    let count = 0;
    for (const entry of this.entriesByKey.values()) {
      if (entry.firstSeenSnapshotId === snapshotId) {
        count += 1;
      }
    }
    return count;
  }

  private async releaseSnapshotsIfEligible(): Promise<void> {
    for (const [snapshotId, ref] of this.snapshotRefs.entries()) {
      if (ref.releasing) {
        continue;
      }

      if (this.unresolvedCountForFirstSeenSnapshot(snapshotId) > 0) {
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
    this.options.persistRegistry?.(this.snapshotRegistry());
  }
}

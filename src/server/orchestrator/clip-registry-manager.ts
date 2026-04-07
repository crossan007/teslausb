import { ClipRegistry, ClipRegistryEntry, PendingClips, Snapshot, TransferQueue, TransferQueueFile } from '../../types';
import { ClipDiscoveryResult } from './clip-discovery/clip-discovery-manager';
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

  // Selects next clip for transfer based on 4-tier priority:
  // Tier 1: Metadata artifacts from SavedClips and SentryClips (event.json, event.mp4, thumb.png)
  // Tier 2: SavedClips content files (non-metadata)
  // Tier 3: SentryClips content files (non-metadata)
  // Tier 4: All other clips (RecentClips, etc.)
  // Within each tier: sorted oldest-first by firstSeenSnapshotCreatedAt, then firstSeenAt, then updatedAt, then relPath
  nextClipForTransfer(): ClipRegistryEntry | undefined {
    const candidates = Array.from(this.entriesByKey.values())
      .filter((entry) => entry.status === 'pending' || entry.status === 'failed');

    if (candidates.length === 0) {
      return undefined;
    }

    const hasPendingMetadataArtifacts = candidates.some((entry) =>
      this.isMetadataArtifact(entry.relPath),
    );

    const hasPendingNonMetadataSavedClips = candidates.some(
      (entry) => this.isSavedClip(entry.relPath) && !this.isMetadataArtifact(entry.relPath),
    );

    const hasPendingNonMetadataSentryClips = candidates.some(
      (entry) => this.isSentryClip(entry.relPath) && !this.isMetadataArtifact(entry.relPath),
    );

    const sorted = candidates
      .sort((left, right) => {
        const leftPriority = this.transferCategoryPriority(
          left.relPath,
          hasPendingMetadataArtifacts,
          hasPendingNonMetadataSavedClips,
          hasPendingNonMetadataSentryClips,
        );
        const rightPriority = this.transferCategoryPriority(
          right.relPath,
          hasPendingMetadataArtifacts,
          hasPendingNonMetadataSavedClips,
          hasPendingNonMetadataSentryClips,
        );

        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }

        if (left.firstSeenSnapshotCreatedAt !== right.firstSeenSnapshotCreatedAt) {
          return left.firstSeenSnapshotCreatedAt - right.firstSeenSnapshotCreatedAt;
        }
        if (left.firstSeenAt !== right.firstSeenAt) {
          return left.firstSeenAt - right.firstSeenAt;
        }
        if (left.updatedAt !== right.updatedAt) {
          return left.updatedAt - right.updatedAt;
        }
        return left.relPath.localeCompare(right.relPath);
      });

    return sorted[0] ? { ...sorted[0] } : undefined;
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

  snapshotPendingClips(): PendingClips {
    const pendingEntries = Array.from(this.entriesByKey.values())
      .filter((entry) => entry.status !== 'transferred')
      .sort((left, right) => left.relPath.localeCompare(right.relPath));

    const eventDirs = new Set<string>();
    for (const entry of pendingEntries) {
      if (entry.relPath.startsWith('SavedClips/') || entry.relPath.startsWith('SentryClips/')) {
        const index = entry.relPath.lastIndexOf('/');
        if (index > 0) {
          eventDirs.add(entry.relPath.slice(0, index));
        }
      }
    }

    const oldestAgeSec = pendingEntries.reduce((oldest, entry) => Math.max(oldest, entry.ageSec), 0);

    return {
      totalFiles: pendingEntries.length,
      totalEvents: eventDirs.size,
      oldestAgeSec,
      files: pendingEntries.map((entry) => ({
        relPath: entry.relPath,
        isSymlink: entry.isSymlink,
        ageSec: entry.ageSec,
      })),
    };
  }

  /**
   * Identifies snapshots between the oldest-with-active-transfers and the newest
   * that can be pruned because all their un-transferred files also exist in
   * newer snapshots. Preserves the oldest-with-active-transfers and the newest.
   *
   * Algorithm:
   * 1. Find oldest snapshot that has any un-transferred files (status: pending/transferring/failed)
   * 2. Get all unique snapshot IDs from registry entries (both firstSeenSnapshotId and preferredSnapshotId)
   * 3. For each snapshot between oldest-with-active and newest-1:
   *    - Collect all un-transferred files first-seen in this snapshot
   *    - Check if all those files appear elsewhere in the registry (different snapshot)
   *    - If yes, and not the oldest or newest, mark for pruning
   *
   * Returns array of snapshot IDs that can be safely released.
   */
  identifyPrunableSnapshots(): string[] {
    const allEntries = Array.from(this.entriesByKey.values());

    const snapshotOrder = new Map<string, number>();
    for (const entry of allEntries) {
      const firstSeenTs = entry.firstSeenSnapshotCreatedAt ?? 0;
      const preferredTs = entry.preferredSnapshotCreatedAt ?? 0;

      snapshotOrder.set(
        entry.firstSeenSnapshotId,
        Math.max(snapshotOrder.get(entry.firstSeenSnapshotId) ?? 0, firstSeenTs),
      );
      snapshotOrder.set(
        entry.preferredSnapshotId,
        Math.max(snapshotOrder.get(entry.preferredSnapshotId) ?? 0, preferredTs),
      );
    }

    if (snapshotOrder.size < 3) {
      // Need at least 3 snapshots to prune (oldest-active, middle, newest)
      return [];
    }

    // Sort snapshots by created-at timestamp (oldest to newest).
    const sortedSnapshots = Array.from(snapshotOrder.entries())
      .sort((left, right) => {
        if (left[1] !== right[1]) {
          return left[1] - right[1];
        }
        return left[0].localeCompare(right[0]);
      })
      .map(([snapshotId]) => snapshotId);

    const snapshotIndexById = new Map<string, number>();
    for (let i = 0; i < sortedSnapshots.length; i += 1) {
      snapshotIndexById.set(sortedSnapshots[i], i);
    }

    // Find oldest snapshot with un-transferred files
    let oldestWithActiveTransfersIdx = sortedSnapshots.length - 1;
    for (let i = 0; i < sortedSnapshots.length; i++) {
      const snapshotId = sortedSnapshots[i];
      const hasUnTransferred = allEntries.some(
        (e) => e.firstSeenSnapshotId === snapshotId && e.status !== 'transferred',
      );
      if (hasUnTransferred) {
        oldestWithActiveTransfersIdx = i;
        break;
      }
    }

    const newestSnapshotIdx = sortedSnapshots.length - 1;

    // Collect candidates to prune: between oldest-active+1 and newest-1
    const prunableSnapshots: string[] = [];
    for (let i = oldestWithActiveTransfersIdx + 1; i < newestSnapshotIdx; i++) {
      const candidateId = sortedSnapshots[i];

      // Get all un-transferred files first-seen in this candidate snapshot
      const unTransferredInCandidate = allEntries.filter(
        (e) => e.firstSeenSnapshotId === candidateId && e.status !== 'transferred',
      );

      if (unTransferredInCandidate.length === 0) {
        // No un-transferred files in this snapshot, safe to prune
        prunableSnapshots.push(candidateId);
        continue;
      }

      // Check if all un-transferred files in candidate exist in a newer snapshot
      let allExistInNewer = true;
      for (const candidateFile of unTransferredInCandidate) {
        // File is available in newer snapshot if its preferred source snapshot is newer.
        const preferredIdx = snapshotIndexById.get(candidateFile.preferredSnapshotId) ?? -1;
        const existsInNewer = preferredIdx > i;
        if (!existsInNewer) {
          // This file is unique to this snapshot and not yet transferred
          allExistInNewer = false;
          break;
        }
      }

      if (allExistInNewer) {
        prunableSnapshots.push(candidateId);
      }
    }

    return prunableSnapshots;
  }

  onSnapshotPruned(snapshotId: string): void {
    this.snapshotRefs.delete(snapshotId);
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

  private transferCategoryPriority(
    relPath: string,
    hasPendingMetadataArtifacts: boolean,
    hasPendingNonMetadataSavedClips: boolean,
    hasPendingNonMetadataSentryClips: boolean,
  ): number {
    // Tier 1: Metadata artifacts (both SavedClips and SentryClips) are highest priority
    if (hasPendingMetadataArtifacts) {
      return this.isMetadataArtifact(relPath) ? 0 : 3;
    }

    // Tier 2: SavedClips content (non-metadata) comes next
    if (hasPendingNonMetadataSavedClips) {
      if (this.isSavedClip(relPath) && !this.isMetadataArtifact(relPath)) {
        return 0;
      }
      return 3;
    }

    // Tier 3: SentryClips content (non-metadata) comes after SavedClips
    if (hasPendingNonMetadataSentryClips) {
      if (this.isSentryClip(relPath) && !this.isMetadataArtifact(relPath)) {
        return 0;
      }
      return 1;
    }

    // Tier 4: Everything else
    return 1;
  }

  private isSavedClip(relPath: string): boolean {
    return relPath.startsWith('SavedClips/');
  }

  private isSentryClip(relPath: string): boolean {
    return relPath.startsWith('SentryClips/');
  }

  private isMetadataArtifact(relPath: string): boolean {
    const isSavedOrSentry = relPath.startsWith('SavedClips/') || relPath.startsWith('SentryClips/');
    if (!isSavedOrSentry) {
      return false;
    }

    const fileName = relPath.split('/').at(-1)?.toLowerCase() ?? '';
    return fileName === 'event.json' || fileName === 'event.mp4' || fileName === 'thumb.png';
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

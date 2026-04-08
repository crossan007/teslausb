/**
 * Legacy lineage:
 * - run/archiveloop (main wait/reachability/archive lifecycle loop)
 */
import { lstat } from 'fs/promises';
import { posix as posixPath } from 'path';
import { logger, stateManager } from '../core';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { ClipRegistryEntry, DefaultSyncStatus, PendingClips, SyncStatus } from '../../types';
import { ClipDiscoveryManager, ClipDiscoveryOptions, ClipDiscoveryResult } from './clip-discovery/clip-discovery-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend } from '../../types/archive';
import { ArchiveEventBus, ArchiveEventBusLike, SnapshotReadyEvent } from './events';
import { ClipRegistryManager } from './clip-registry-manager';
import { SnapshotManager } from './snapshot/snapshot-manager';

/**
 * Controls polling cadence and lifecycle hook behavior around archive cycles.
 */
export interface RuntimeLifecycleLoopOptions {
  /** Path to persisted archived file list. */
  archivedListPath: string;
  /** Delay before each archive attempt once backend is reachable. */
  archiveDelaySec: number;
  /** Poll interval while waiting for reachability. */
  reachabilityPollMs?: number;
  /** Optional cap for reachability checks (useful in tests). */
  maxReachabilityChecks?: number;
  /** Relative trigger file paths emitted at archive-start (optional, opt-in). */
  startTriggerFilePaths?: string[];
  /** Relative trigger file paths emitted at archive-finish (legacy-compatible default). */
  finishTriggerFilePaths?: string[];
  /** Stop queue drain after this many consecutive transfer failures. Defaults to 3. */
  maxConsecutiveTransferFailures?: number;
  includeSavedclips?: boolean;
  includeSentryclips?: boolean;
  includeTrackmodeclips?: boolean;
  includeRecentclips?: boolean;
  minClipSizeBytes?: number;
  statConcurrency?: number;
  includePredicate?: ClipDiscoveryOptions['includePredicate'];
  nowEpochSec?: number;
}

/**
 * Minimal sync-status writer contract used while waiting for archive reachability.
 */
export interface SyncStatusWriter {
  /** Persists the current sync state. */
  writeSyncStatus(status: SyncStatus): void;
}

/**
 * Minimal logger contract used for runtime lifecycle events.
 */
export interface RuntimeLifecycleLogger {
  /** Records informational lifecycle events. */
  info(payload: unknown, message?: string): void;
  /** Records warning lifecycle events. */
  warn(payload: unknown, message?: string): void;
  /** Records error lifecycle events. */
  error(payload: unknown, message?: string): void;
}

/**
 * Coordinates clip discovery events with runtime lifecycle hooks and archive execution.
 */
export class RuntimeLifecycleLoop {
  private unsubscribeSnapshotEvents: (() => void) | null = null;
  private readonly pendingSnapshotEvents: SnapshotReadyEvent[] = [];
  private processingSnapshotEvents = false;
  private transferWorkerActive = false;
  private transferWorkerWakeResolver: (() => void) | null = null;
  private transferWorkerGeneration = 0;
  /** State writer used while waiting for backend reachability. */
  private readonly syncStatusWriter: SyncStatusWriter;
  /** Logger used for runtime lifecycle events. */
  private readonly runtimeLogger: RuntimeLifecycleLogger;
  /** Event bus used to emit lifecycle events. */
  private readonly eventBus: ArchiveEventBusLike;
  /** Pending-clips persistence sink for diagnostics/UI surfaces. */
  private readonly persistPendingClips: (pending: PendingClips) => void;
  /** Clip registry source-of-truth owning transfer eligibility and snapshot release. */
  private readonly clipRegistryManager: ClipRegistryManager;
  /** Snapshot manager for pruning obsolete snapshots. */
  private readonly snapshotManager?: SnapshotManager;
  /** Determines whether a clip's preferred source path currently exists. */
  private readonly isTransferSourceAvailable: (entry: ClipRegistryEntry) => Promise<boolean>;

  /**
   * Builds a runtime lifecycle loop instance.
   */
  constructor(
    private readonly discoveryManager: ClipDiscoveryManager,
    private readonly clipArchiveCoordinator: ClipArchiveCoordinator,
    private readonly backend: ArchiveBackend,
    private readonly options: RuntimeLifecycleLoopOptions,
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
    dependencies?: {
      syncStatusWriter?: SyncStatusWriter;
      runtimeLogger?: RuntimeLifecycleLogger;
      eventBus?: ArchiveEventBusLike;
      persistPendingClips?: (pending: PendingClips) => void;
      clipRegistryManager?: ClipRegistryManager;
      snapshotManager?: SnapshotManager;
      isTransferSourceAvailable?: (entry: ClipRegistryEntry) => Promise<boolean>;
    },
  ) {
    this.syncStatusWriter = dependencies?.syncStatusWriter ?? stateManager;
    this.runtimeLogger = dependencies?.runtimeLogger ?? logger;
    this.eventBus = dependencies?.eventBus ?? new ArchiveEventBus();
    this.persistPendingClips = dependencies?.persistPendingClips ?? ((pending) => stateManager.writePendingClips(pending));
    this.clipRegistryManager = dependencies?.clipRegistryManager ?? new ClipRegistryManager();
    this.snapshotManager = dependencies?.snapshotManager;
    this.isTransferSourceAvailable = dependencies?.isTransferSourceAvailable
      ?? this.defaultTransferSourceAvailabilityCheck.bind(this);
  }

  /**
   * Starts the lifecycle loop and subscribes to discovery events.
   */
  start(): void {
    if (this.unsubscribeSnapshotEvents) {
      return;
    }

    this.transferWorkerActive = true;
    this.transferWorkerGeneration += 1;
    const generation = this.transferWorkerGeneration;

    this.unsubscribeSnapshotEvents = this.eventBus.subscribe(async (event) => {
      if (event.type !== 'snapshot-ready') {
        return;
      }
      await this.consumeSnapshotEvent(event);
    });

    void this.runTransferWorker(generation);
  }

  /**
   * Stops discovery and unsubscribes lifecycle processing.
   */
  stop(): void {
    this.transferWorkerActive = false;
    this.transferWorkerGeneration += 1;
    this.wakeTransferWorker();
    this.unsubscribeSnapshotEvents?.();
    this.unsubscribeSnapshotEvents = null;
    this.pendingSnapshotEvents.length = 0;
  }

  /**
   * Handles one discovered clip batch through lifecycle hooks and archive execution.
   */
  private async consumeSnapshotEvent(event: SnapshotReadyEvent): Promise<void> {
    this.pendingSnapshotEvents.push(event);
    if (this.processingSnapshotEvents) {
      return;
    }

    this.processingSnapshotEvents = true;
    try {
      while (this.pendingSnapshotEvents.length > 0) {
        const next = this.pendingSnapshotEvents.shift();
        if (!next) {
          continue;
        }
        await this.handleSnapshotReady(next);
      }
    } finally {
      this.processingSnapshotEvents = false;
    }
  }

  private async handleSnapshotReady(event: SnapshotReadyEvent): Promise<void> {
    let discoveryResult: ClipDiscoveryResult;

    try {
      const discovered = await this.discoveryManager.discoverPending({
        rootPath: event.scanRootPath,
        archivedListPath: this.options.archivedListPath,
        includeSavedclips: this.options.includeSavedclips,
        includeSentryclips: this.options.includeSentryclips,
        includeTrackmodeclips: this.options.includeTrackmodeclips,
        includeRecentclips: this.options.includeRecentclips,
        minClipSizeBytes: this.options.minClipSizeBytes,
        statConcurrency: this.options.statConcurrency,
        includePredicate: this.options.includePredicate,
        nowEpochSec: this.options.nowEpochSec,
      });

      discoveryResult = {
        ...discovered,
        snapshot: event.snapshot,
      };
    } catch (error) {
      this.runtimeLogger.warn(
        { err: error, scanRootPath: event.scanRootPath, snapshotId: event.snapshot.id },
        'Snapshot discovery failed in runtime lifecycle loop',
      );
      return;
    }

    await this.clipRegistryManager.ingestDiscovery(discoveryResult);
    this.persistPendingFromRegistry();
    await this.pruneObsoleteSnapshots();
    this.wakeTransferWorker();
  }

  private async runTransferWorker(generation: number): Promise<void> {
    while (this.transferWorkerActive && generation === this.transferWorkerGeneration) {
      try {
        await this.drainTransferQueue();
      } catch (error) {
        this.runtimeLogger.error({ err: error }, 'Transfer worker iteration failed');
      }

      if (!this.transferWorkerActive || generation !== this.transferWorkerGeneration) {
        return;
      }

      await this.waitForTransferWorkerWakeOrTimeout(Math.max(100, this.options.reachabilityPollMs ?? 1000));
    }
  }

  private wakeTransferWorker(): void {
    const resolver = this.transferWorkerWakeResolver;
    this.transferWorkerWakeResolver = null;
    resolver?.();
  }

  private async waitForTransferWorkerWakeOrTimeout(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.transferWorkerWakeResolver = null;
        resolve();
      }, timeoutMs);

      this.transferWorkerWakeResolver = () => {
        clearTimeout(timer);
        this.transferWorkerWakeResolver = null;
        resolve();
      };
    });
  }

  /**
   * Prunes snapshots between oldest-with-active-transfers and newest
   * that contain only files also present in newer snapshots.
   */
  private async pruneObsoleteSnapshots(): Promise<void> {
    if (!this.snapshotManager) {
      return;
    }

    const prunableIds = this.clipRegistryManager.identifyPrunableSnapshots();
    if (prunableIds.length === 0) {
      return;
    }

    stateManager.writeSnapshotPruningStatus({
      updatedAt: Date.now(),
      lastPrunedSnapshotIds: prunableIds,
      totalPruned: prunableIds.length,
    });

    for (const snapshotId of prunableIds) {
      try {
        await this.snapshotManager.releaseSnapshot(snapshotId);
        this.clipRegistryManager.onSnapshotPruned(snapshotId);
        this.runtimeLogger.info(
          { snapshotId, totalPruned: prunableIds.length },
          'Pruned obsolete snapshot with redundant files',
        );
      } catch (error) {
        this.runtimeLogger.warn(
          { err: error, snapshotId },
          'Failed to prune obsolete snapshot',
        );
      }
    }
  }

  /**
   * Continuously processes queued clips one-at-a-time until queue is empty.
   */
  private async drainTransferQueue(): Promise<void> {
    const maxConsecutiveFailures = Math.max(1, this.options.maxConsecutiveTransferFailures ?? 3);
    let consecutiveFailures = 0;

    while (this.transferWorkerActive) {
      const nextClip = await this.clipRegistryManager.nextClipForTransferIfSourceAvailable(
        this.isTransferSourceAvailable,
      );
      if (!nextClip) {
        return;
      }

      const pending = this.clipRegistryManager.snapshotPendingClips();
      const reachable = await this.waitUntilReachable(pending);
      if (!reachable) {
        return;
      }

      await this.trySyncTime();
      this.clipRegistryManager.markTransferring(nextClip.key);
      this.persistPendingFromRegistry();

      await this.eventBus.publish({
        type: 'archive-start',
        occurredAtMs: Date.now(),
        totalFiles: 1,
        totalEvents: 0,
        triggerFilePaths: this.options.startTriggerFilePaths ?? [],
      });
      await this.sleepMs(Math.max(0, this.options.archiveDelaySec) * 1000);

      let cycleSucceeded = false;
      let archivedMarkedCount = 0;

      try {
        let cycleResult;
        try {
          cycleResult = await this.clipArchiveCoordinator.runArchiveCycle({
            fromPath: nextClip.preferredRootPath,
            files: [nextClip.relPath],
          });
          cycleSucceeded = Boolean(cycleResult && !cycleResult.skipped && cycleResult.failed === 0);
        } catch (error) {
          this.runtimeLogger.error({ err: error }, 'Archive cycle failed for queued clip');
        }

        const archivedNowPaths = await this.resolveArchivedPaths(
          nextClip.preferredRootPath,
          [nextClip.relPath],
        );
        const archived = archivedNowPaths.includes(nextClip.relPath);

        if (cycleSucceeded && archived) {
          archivedMarkedCount = 1;
          await this.discoveryManager.markArchived([nextClip.relPath], this.options.archivedListPath);
          await this.clipRegistryManager.markTransferred(nextClip.key);
          this.persistPendingFromRegistry();
          consecutiveFailures = 0;
        } else {
          this.clipRegistryManager.markTransferFailed(nextClip.key);
          this.persistPendingFromRegistry();
          consecutiveFailures += 1;
          const failureReason = !cycleSucceeded
            ? 'archive_cycle_failed'
            : 'source_not_archived_after_transfer';
          this.runtimeLogger.warn(
            {
              relPath: nextClip.relPath,
              cycleSucceeded,
              archived,
              failureReason,
              consecutiveFailures,
              maxConsecutiveFailures,
            },
            'Queued clip transfer did not complete',
          );

          if (consecutiveFailures >= maxConsecutiveFailures) {
            this.runtimeLogger.warn(
              { consecutiveFailures, maxConsecutiveFailures },
              'Stopping queue drain after consecutive transfer failures',
            );
            return;
          }

          continue;
        }

        this.runtimeLogger.info(
          { archivedMarked: archivedMarkedCount, cycleSucceeded, result: cycleResult, relPath: nextClip.relPath },
          'Archive cycle completed for queued clip',
        );
      } finally {
        await this.eventBus.publish({
          type: 'archive-finish',
          occurredAtMs: Date.now(),
          totalFiles: 1,
          totalEvents: 0,
          archivedFiles: archivedMarkedCount,
          succeeded: cycleSucceeded,
          triggerFilePaths: cycleSucceeded ? (this.options.finishTriggerFilePaths ?? []) : [],
        });
      }
    }
  }

  private persistPendingFromRegistry(): void {
    this.persistPendingClips(this.clipRegistryManager.snapshotPendingClips());
  }

  private async resolveArchivedPaths(rootPath: string, filePaths: string[]): Promise<string[]> {
    if (typeof this.backend.verifyArchived === 'function') {
      try {
        return await this.backend.verifyArchived(filePaths);
      } catch (error) {
        this.runtimeLogger.warn(
          { err: error, fileCount: filePaths.length },
          'Backend destination verification failed; treating files as not archived',
        );
        return [];
      }
    }

    return this.discoveryManager.resolveArchivedFromSource(rootPath, filePaths);
  }

  /**
   * Waits until backend is reachable while publishing waiting sync status.
   */
  private async waitUntilReachable(pending: PendingClips): Promise<boolean> {
    const reachabilityPollMs = Math.max(100, this.options.reachabilityPollMs ?? 1000);
    const maxChecks = this.options.maxReachabilityChecks;
    let checks = 0;

    while (this.transferWorkerActive) {
      const reachable = await this.backend.isReachable();
      if (reachable) {
        return true;
      }

      checks += 1;
      this.syncStatusWriter.writeSyncStatus({
        ...DefaultSyncStatus,
        state: 'waiting',
        queueFiles: pending.totalFiles,
        queueEvents: pending.totalEvents,
        queueOldestAgeSec: pending.oldestAgeSec,
      });

      if (maxChecks !== undefined && checks >= maxChecks) {
        this.runtimeLogger.warn({ checks }, 'Reachability checks exhausted for pending batch');
        return false;
      }

      await this.sleepMs(reachabilityPollMs);
    }

    return false;
  }

  /**
   * Best-effort time synchronization with the same host used in bash flow.
   */
  private async trySyncTime(): Promise<void> {
    const sntp = await this.commandRunner.run('sntp', ['-S', 'time.google.com']);
    if (sntp.code === 0) {
      return;
    }

    const ntpdig = await this.commandRunner.run('ntpdig', ['-S', 'time.google.com']);
    if (ntpdig.code === 0) {
      return;
    }

    this.runtimeLogger.warn({ sntpCode: sntp.code, ntpdigCode: ntpdig.code }, 'Time synchronization failed');
  }

  /**
   * Sleeps for the requested interval.
   */
  private async sleepMs(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }

  private async defaultTransferSourceAvailabilityCheck(entry: ClipRegistryEntry): Promise<boolean> {
    const absPath = posixPath.join(entry.preferredRootPath, entry.relPath);
    try {
      await lstat(absPath);
      return true;
    } catch {
      return false;
    }
  }
}

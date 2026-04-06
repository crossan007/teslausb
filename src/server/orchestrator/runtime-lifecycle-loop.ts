/**
 * Legacy lineage:
 * - run/archiveloop (main wait/reachability/archive lifecycle loop)
 */
import { concatMap, Observable, Subscription } from 'rxjs';
import { logger, stateManager } from '../core';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { DefaultSyncStatus, PendingClips, SyncStatus } from '../../types';
import { ClipDiscoveryManager, ClipDiscoveryResult } from './clip-discovery-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend } from '../../types/archive';
import { ArchiveEventBus, ArchiveEventBusLike } from './events';
import { ClipRegistryManager } from './clip-registry-manager';
import { SnapshotManager } from './snapshot-manager';

/**
 * Structural contract expected from any discovery source (snapshot consumer, test fake, etc.).
 */
export interface DiscoverySource {
  readonly discovered$: Observable<ClipDiscoveryResult>;
  start(): void;
  stop(): void;
}

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
  /** Subscription for the serialized discovery processing stream. */
  private subscription: Subscription | null = null;
  /** State writer used while waiting for backend reachability. */
  private readonly syncStatusWriter: SyncStatusWriter;
  /** Logger used for runtime lifecycle events. */
  private readonly runtimeLogger: RuntimeLifecycleLogger;
  /** Event bus used to emit lifecycle events. */
  private readonly eventBus: ArchiveEventBusLike;
  /** Clip registry source-of-truth owning transfer eligibility and snapshot release. */
  private readonly clipRegistryManager: ClipRegistryManager;
  /** Snapshot manager for pruning obsolete snapshots. */
  private readonly snapshotManager?: SnapshotManager;

  /**
   * Builds a runtime lifecycle loop instance.
   */
  constructor(
    private readonly discoveryLoop: DiscoverySource,
    private readonly discoveryManager: ClipDiscoveryManager,
    private readonly clipArchiveCoordinator: ClipArchiveCoordinator,
    private readonly backend: ArchiveBackend,
    private readonly options: RuntimeLifecycleLoopOptions,
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
    dependencies?: {
      syncStatusWriter?: SyncStatusWriter;
      runtimeLogger?: RuntimeLifecycleLogger;
      eventBus?: ArchiveEventBusLike;
      clipRegistryManager?: ClipRegistryManager;
      snapshotManager?: SnapshotManager;
    },
  ) {
    this.syncStatusWriter = dependencies?.syncStatusWriter ?? stateManager;
    this.runtimeLogger = dependencies?.runtimeLogger ?? logger;
    this.eventBus = dependencies?.eventBus ?? new ArchiveEventBus();
    this.clipRegistryManager = dependencies?.clipRegistryManager ?? new ClipRegistryManager();
    this.snapshotManager = dependencies?.snapshotManager;
  }

  /**
   * Starts the lifecycle loop and subscribes to discovery events.
   */
  start(): void {
    if (this.subscription) {
      return;
    }

    this.subscription = this.discoveryStream()
      .pipe(concatMap(async (discoveryResult) => this.handleDiscovery(discoveryResult)))
      .subscribe({
        error: (error) => {
          this.runtimeLogger.error({ err: error }, 'Runtime lifecycle stream failed');
        },
      });

    this.discoveryLoop.start();
  }

  /**
   * Stops discovery and unsubscribes lifecycle processing.
   */
  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.discoveryLoop.stop();
  }

  /**
   * Returns the discovery observable to support targeted tests.
   */
  protected discoveryStream(): Observable<ClipDiscoveryResult> {
    return this.discoveryLoop.discovered$;
  }

  /**
   * Handles one discovered clip batch through lifecycle hooks and archive execution.
   */
  private async handleDiscovery(discoveryResult: ClipDiscoveryResult): Promise<void> {
    if (!discoveryResult.snapshot) {
      await this.handleDirectBatch(discoveryResult);
      return;
    }

    await this.clipRegistryManager.ingestDiscovery(discoveryResult);
    await this.pruneObsoleteSnapshots();
    await this.drainTransferQueue();
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

    while (true) {
      const nextClip = this.clipRegistryManager.nextClipForTransfer();
      if (!nextClip) {
        return;
      }

      const pending = this.buildPendingFromQueue();
      const reachable = await this.waitUntilReachable(pending);
      if (!reachable) {
        return;
      }

      await this.trySyncTime();
      this.clipRegistryManager.markTransferring(nextClip.key);

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

        const archivedNowPaths = await this.discoveryManager.resolveArchivedFromSource(
          nextClip.preferredRootPath,
          [nextClip.relPath],
        );
        const archived = archivedNowPaths.includes(nextClip.relPath);

        if (cycleSucceeded && archived) {
          archivedMarkedCount = 1;
          await this.discoveryManager.markArchived([nextClip.relPath], this.options.archivedListPath);
          await this.clipRegistryManager.markTransferred(nextClip.key);
          consecutiveFailures = 0;
        } else {
          this.clipRegistryManager.markTransferFailed(nextClip.key);
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

  /**
   * Legacy-compatible processing path for direct discovery batches without snapshot metadata.
   */
  private async handleDirectBatch(discoveryResult: ClipDiscoveryResult): Promise<void> {
    const reachable = await this.waitUntilReachable(discoveryResult.pendingClips);
    if (!reachable) {
      return;
    }

    await this.trySyncTime();
    await this.eventBus.publish({
      type: 'archive-start',
      occurredAtMs: Date.now(),
      totalFiles: discoveryResult.pendingClips.totalFiles,
      totalEvents: discoveryResult.pendingClips.totalEvents,
      triggerFilePaths: this.options.startTriggerFilePaths ?? [],
    });
    await this.sleepMs(Math.max(0, this.options.archiveDelaySec) * 1000);

    let cycleSucceeded = false;
    let archivedMarkedCount = 0;

    try {
      let cycleResult;
      try {
        cycleResult = await this.clipArchiveCoordinator.runArchiveCycle({
          fromPath: discoveryResult.rootPath,
          files: discoveryResult.filePaths,
        });
        cycleSucceeded = Boolean(cycleResult && !cycleResult.skipped && cycleResult.failed === 0);
      } catch (error) {
        this.runtimeLogger.error({ err: error }, 'Archive cycle failed for direct discovery batch');
      }

      const archivedNow = await this.discoveryManager.resolveArchivedFromSource(
        discoveryResult.rootPath,
        discoveryResult.filePaths,
      );

      if (cycleSucceeded) {
        archivedMarkedCount = archivedNow.length;
        if (archivedNow.length > 0) {
          await this.discoveryManager.markArchived(archivedNow, this.options.archivedListPath);
        }
      } else {
        this.runtimeLogger.info(
          { filePaths: discoveryResult.filePaths.length },
          'Archive cycle did not succeed – skipping markArchived so files remain pending',
        );
      }

      this.runtimeLogger.info(
        { archivedMarked: archivedMarkedCount, cycleSucceeded, result: cycleResult },
        'Archive cycle completed from direct discovery batch',
      );
    } finally {
      await this.eventBus.publish({
        type: 'archive-finish',
        occurredAtMs: Date.now(),
        totalFiles: discoveryResult.pendingClips.totalFiles,
        totalEvents: discoveryResult.pendingClips.totalEvents,
        archivedFiles: archivedMarkedCount,
        succeeded: cycleSucceeded,
        triggerFilePaths: cycleSucceeded ? (this.options.finishTriggerFilePaths ?? []) : [],
      });
    }
  }

  /**
   * Builds sync status pending summary from queued transfer files.
   */
  private buildPendingFromQueue(): PendingClips {
    const queue = this.clipRegistryManager.snapshotTransferQueue();
    const summary = this.clipRegistryManager.pendingSummary();

    return {
      totalFiles: summary.totalFiles,
      totalEvents: 0,
      oldestAgeSec: summary.oldestAgeSec,
      files: queue.files.map((file) => ({
        relPath: file.relPath,
        isSymlink: file.isSymlink,
        ageSec: file.ageSec,
      })),
    };
  }

  /**
   * Waits until backend is reachable while publishing waiting sync status.
   */
  private async waitUntilReachable(pending: PendingClips): Promise<boolean> {
    const reachabilityPollMs = Math.max(100, this.options.reachabilityPollMs ?? 1000);
    const maxChecks = this.options.maxReachabilityChecks;
    let checks = 0;

    while (true) {
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
}

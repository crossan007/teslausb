/**
 * Legacy lineage:
 * - run/archiveloop (main wait/reachability/archive lifecycle loop)
 */
import { concatMap, Observable, Subscription } from 'rxjs';
import { logger, stateManager } from '../core';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { DefaultSyncStatus, PendingClips, SyncStatus } from '../types';
import { ClipDiscoveryManager, ClipDiscoveryResult } from './clip-discovery-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend } from '../types/archive';
import { ArchiveEventBus, ArchiveEventBusLike } from './events';

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
    },
  ) {
    this.syncStatusWriter = dependencies?.syncStatusWriter ?? stateManager;
    this.runtimeLogger = dependencies?.runtimeLogger ?? logger;
    this.eventBus = dependencies?.eventBus ?? new ArchiveEventBus();
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
          this.runtimeLogger.error({ error }, 'Runtime lifecycle stream failed');
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
        this.runtimeLogger.error({ error }, 'Archive cycle failed for discovery batch');
      }

      const archivedNow = await this.discoveryManager.resolveArchivedFromSource(
        discoveryResult.rootPath,
        discoveryResult.filePaths,
      );

      if (archivedNow.length > 0) {
        await this.discoveryManager.markArchived(archivedNow, this.options.archivedListPath);
      }
      archivedMarkedCount = archivedNow.length;

      this.runtimeLogger.info({ archivedMarked: archivedNow.length, result: cycleResult }, 'Archive cycle completed from lifecycle loop');
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

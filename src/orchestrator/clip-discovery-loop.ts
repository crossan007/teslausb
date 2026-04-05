/**
 * Legacy lineage:
 * - run/archiveloop (continuous loop that waits and re-checks for archive work)
 */
import { Observable, Subject } from 'rxjs';
import { PendingClips } from '../types';
import { logger } from '../core/logger';
import {
  ClipDiscoveryManager,
  ClipDiscoveryOptions,
  ClipDiscoveryResult,
} from './clip-discovery-manager';
import { ArchiveEventBusLike } from './events';

export interface ClipDiscoveryLoopOptions extends Omit<ClipDiscoveryOptions, 'rootPath'> {
  rootPath?: string;
  intervalMs?: number;
  emitOnChangeOnly?: boolean;
  persistPendingClips?: (pending: PendingClips) => void;
  eventBus?: ArchiveEventBusLike;
}

export class ClipDiscoveryLoop {
  private readonly eventsSubject = new Subject<ClipDiscoveryResult>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastEmittedFingerprint = '';
  private unsubscribeBus: (() => void) | null = null;

  readonly discovered$: Observable<ClipDiscoveryResult> = this.eventsSubject.asObservable();

  constructor(
    private readonly discoveryManager: ClipDiscoveryManager,
    private readonly options: ClipDiscoveryLoopOptions,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    if (this.options.eventBus) {
      this.unsubscribeBus = this.options.eventBus.subscribe(async (event) => {
        if (event.type !== 'snapshot-ready') {
          return;
        }
        await this.pollNow(event.snapshotMountPath);
      });
      return;
    }

    void this.pollNow(this.options.rootPath);
  }

  stop(): void {
    this.running = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.eventsSubject.complete();
  }

  async pollNow(rootPath = this.options.rootPath): Promise<void> {
    if (!rootPath || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const result = await this.discoveryManager.discoverPending({
        ...this.buildDiscoveryOptions(rootPath),
        rootPath,
      });
      this.options.persistPendingClips?.(result.pendingClips);

      const filePaths = result.filePaths;
      if (filePaths.length > 0) {
        const fingerprint = `${result.rootPath}\n${filePaths.join('\n')}`;
        const emitOnChangeOnly = this.options.emitOnChangeOnly ?? true;
        if (!emitOnChangeOnly || fingerprint !== this.lastEmittedFingerprint) {
          this.lastEmittedFingerprint = fingerprint;
          this.eventsSubject.next(result);
        }
      } else {
        this.lastEmittedFingerprint = '';
      }
    } catch (error) {
      logger.warn({ error, rootPath }, 'Clip discovery poll failed');
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }

  private buildDiscoveryOptions(rootPath: string): ClipDiscoveryOptions {
    return {
      rootPath,
      archivedListPath: this.options.archivedListPath,
      includeSavedclips: this.options.includeSavedclips,
      includeSentryclips: this.options.includeSentryclips,
      includeTrackmodeclips: this.options.includeTrackmodeclips,
      includeRecentclips: this.options.includeRecentclips,
      minClipSizeBytes: this.options.minClipSizeBytes,
      statConcurrency: this.options.statConcurrency,
      includePredicate: this.options.includePredicate,
      nowEpochSec: this.options.nowEpochSec,
    };
  }

  private scheduleNext(): void {
    if (!this.running || this.options.eventBus || this.options.intervalMs === undefined) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.pollNow(this.options.rootPath);
    }, Math.max(100, this.options.intervalMs));
  }
}

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

export interface ClipDiscoveryLoopOptions extends ClipDiscoveryOptions {
  intervalMs: number;
  emitOnChangeOnly?: boolean;
  persistPendingClips?: (pending: PendingClips) => void;
}

export class ClipDiscoveryLoop {
  private readonly eventsSubject = new Subject<ClipDiscoveryResult>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastEmittedFingerprint = '';

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
    void this.pollNow();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.eventsSubject.complete();
  }

  async pollNow(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const result = await this.discoveryManager.discoverPending(this.options);
      this.options.persistPendingClips?.(result.pendingClips);

      const filePaths = result.filePaths;
      if (filePaths.length > 0) {
        const fingerprint = filePaths.join('\n');
        const emitOnChangeOnly = this.options.emitOnChangeOnly ?? true;
        if (!emitOnChangeOnly || fingerprint !== this.lastEmittedFingerprint) {
          this.lastEmittedFingerprint = fingerprint;
          this.eventsSubject.next(result);
        }
      } else {
        this.lastEmittedFingerprint = '';
      }
    } catch (error) {
      logger.warn({ error }, 'Clip discovery poll failed');
    } finally {
      this.inFlight = false;
      this.scheduleNextPoll();
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.pollNow();
    }, Math.max(100, this.options.intervalMs));
  }
}

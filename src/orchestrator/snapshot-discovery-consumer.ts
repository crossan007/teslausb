/**
 * Consumes immutable snapshot-ready events and emits one discovery result per snapshot scan root.
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

export interface SnapshotDiscoveryConsumerOptions extends Omit<ClipDiscoveryOptions, 'rootPath'> {
  emitOnChangeOnly?: boolean;
  persistPendingClips?: (pending: PendingClips) => void;
  eventBus: ArchiveEventBusLike;
}

export class SnapshotDiscoveryConsumer {
  private readonly eventsSubject = new Subject<ClipDiscoveryResult>();
  private readonly pendingScanRoots: string[] = [];
  private running = false;
  private processing = false;
  private lastEmittedFingerprint = '';
  private unsubscribeBus: (() => void) | null = null;

  readonly discovered$: Observable<ClipDiscoveryResult> = this.eventsSubject.asObservable();

  constructor(
    private readonly discoveryManager: ClipDiscoveryManager,
    private readonly options: SnapshotDiscoveryConsumerOptions,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.unsubscribeBus = this.options.eventBus.subscribe(async (event) => {
      if (event.type !== 'snapshot-ready') {
        return;
      }
      await this.consume(event.scanRootPath);
    });
  }

  stop(): void {
    this.running = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.pendingScanRoots.length = 0;
    this.eventsSubject.complete();
  }

  async consume(rootPath: string): Promise<void> {
    if (!rootPath) {
      return;
    }

    this.pendingScanRoots.push(rootPath);
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (this.running && this.pendingScanRoots.length > 0) {
        const nextRoot = this.pendingScanRoots.shift();
        if (!nextRoot) {
          continue;
        }
        await this.processRoot(nextRoot);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processRoot(rootPath: string): Promise<void> {
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
      logger.warn({ error, rootPath }, 'Snapshot discovery failed');
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
}

/**
 * Consumes immutable snapshot-ready events and emits one discovery result per snapshot scan root.
 */
import { Observable, Subject } from 'rxjs';
import { PendingClips } from '../../../types';
import { logger } from '../../core/logger';
import {
  buildPendingClips,
  ClipDiscoveryManager,
  ClipDiscoveryOptions,
  ClipDiscoveryResult,
} from './clip-discovery-manager';
import { ArchiveEventBusLike, SnapshotReadyEvent } from '../events';
import { DiscoverySource } from '../discovery-source';

export interface SnapshotDiscoveryConsumerOptions extends Omit<ClipDiscoveryOptions, 'rootPath'> {
  emitOnChangeOnly?: boolean;
  persistPendingClips?: (pending: PendingClips) => void;
  eventBus: ArchiveEventBusLike;
}

export class SnapshotDiscoveryConsumer implements DiscoverySource {
  private readonly eventsSubject = new Subject<ClipDiscoveryResult>();
  private readonly pendingScanRoots: SnapshotReadyEvent[] = [];
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
      logger.debug({ scanRootPath: event.scanRootPath }, 'snapshot-ready received by discovery consumer');
      await this.consume(event);
    });
    logger.debug('SnapshotDiscoveryConsumer started');
  }

  stop(): void {
    this.running = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.pendingScanRoots.length = 0;
    this.eventsSubject.complete();
  }

  async consume(item: SnapshotReadyEvent): Promise<void> {
    if (!item.scanRootPath) {
      return;
    }

    this.pendingScanRoots.push(item);
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (this.running && this.pendingScanRoots.length > 0) {
        const nextItem = this.pendingScanRoots.shift();
        if (!nextItem) {
          continue;
        }
        await this.processRoot(nextItem);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processRoot(item: SnapshotReadyEvent): Promise<void> {
    const rootPath = item.scanRootPath;
    logger.info({ rootPath }, 'Discovery scan starting for snapshot root');
    try {
      const discoveryResult = await this.discoveryManager.discoverPending({
        ...this.buildDiscoveryOptions(rootPath),
        rootPath,
      });
      const result: ClipDiscoveryResult = {
        ...discoveryResult,
        snapshot: item.snapshot,
      };
      const filePaths = result.clips.map((clip) => clip.relPath);
      const pendingClips = buildPendingClips(result.clips);

      this.options.persistPendingClips?.(pendingClips);
      logger.info(
        {
          rootPath,
          candidatesDiscovered: result.candidatesDiscovered,
          candidatesFiltered: result.candidatesFiltered,
          filePaths: filePaths.length,
          previouslyArchivedRetained: result.previouslyArchivedRetained,
        },
        'Discovery scan complete',
      );

      if (filePaths.length > 0) {
        const fingerprint = `${result.rootPath}\n${filePaths.join('\n')}`;
        const emitOnChangeOnly = this.options.emitOnChangeOnly ?? true;
        if (!emitOnChangeOnly || fingerprint !== this.lastEmittedFingerprint) {
          this.lastEmittedFingerprint = fingerprint;
          logger.info(
            {
              rootPath: result.rootPath,
              totalFiles: filePaths.length,
              filePaths,
            },
            'Discovered files from snapshot',
          );
          this.eventsSubject.next(result);
        } else {
          logger.debug(
            {
              rootPath: result.rootPath,
              totalFiles: filePaths.length,
            },
            'Snapshot discovery unchanged; suppressing duplicate emission',
          );
        }
      } else {
        this.lastEmittedFingerprint = '';
      }
    } catch (error) {
      logger.warn({ err: error, rootPath }, 'Snapshot discovery failed');
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

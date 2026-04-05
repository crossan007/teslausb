import { logger } from '../core/logger';
import { Subject, Subscription, concatMap, debounceTime, filter } from 'rxjs';
import { ArchiveEventBusLike, BackingImageChangedEvent } from './events';
import { SnapshotManager } from './snapshot-manager';

export interface SnapshotEventCoordinatorOptions {
  eventBus: ArchiveEventBusLike;
  snapshotManager: SnapshotManager;
  debounceMs?: number;
  nowMsProvider?: () => number;
}

export class SnapshotEventCoordinator {
  private readonly eventBus: ArchiveEventBusLike;
  private readonly snapshotManager: SnapshotManager;
  private readonly debounceMs: number;
  private readonly nowMsProvider: () => number;
  private unsubscribe: (() => void) | null = null;
  private eventStreamSubscription: Subscription | null = null;
  private readonly changes$ = new Subject<BackingImageChangedEvent>();

  constructor(options: SnapshotEventCoordinatorOptions) {
    this.eventBus = options.eventBus;
    this.snapshotManager = options.snapshotManager;
    this.debounceMs = (options.debounceMs ?? 1500);
    this.nowMsProvider = options.nowMsProvider ?? (() => Date.now());
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }

    this.eventStreamSubscription = this.changes$
      .pipe(
        filter((event) => event.type === 'backing-image-changed'),
        debounceTime(this.debounceMs),
        concatMap(async (change) => this.processChange(change)),
      )
      .subscribe();

    this.unsubscribe = this.eventBus.subscribe(async (event) => {
      if (event.type !== 'backing-image-changed') {
        return;
      }
      this.changes$.next(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.eventStreamSubscription?.unsubscribe();
    this.eventStreamSubscription = null;
  }

  private async processChange(change: BackingImageChangedEvent): Promise<void> {
    try {
      const mounted = await this.snapshotManager.createMountedSnapshot();
      const scanRootPath = await this.snapshotManager.resolveDiscoveryRoot(mounted);
      await this.eventBus.publish({
        type: 'snapshot-ready',
        occurredAtMs: this.nowMsProvider(),
        snapshot: mounted,
        scanRootPath,
      });
      logger.info({
        snapshotId: mounted.id,
        imagePath: change.imagePath,
        imageMtimeMs: change.imageMtimeMs,
        scanRootPath,
      }, 'Snapshot created and mounted from backing image change');
    } catch (error) {
      logger.warn({ err: error, imagePath: change.imagePath }, 'Failed to create mounted snapshot from backing image change');
    }
  }
}

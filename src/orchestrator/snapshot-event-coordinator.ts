import { logger } from '../core/logger';
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
  private timer: NodeJS.Timeout | null = null;
  private latestChange: BackingImageChangedEvent | null = null;
  private inFlight = false;
  private pendingChange = false;

  constructor(options: SnapshotEventCoordinatorOptions) {
    this.eventBus = options.eventBus;
    this.snapshotManager = options.snapshotManager;
    this.debounceMs = Math.max(0, options.debounceMs ?? 1500);
    this.nowMsProvider = options.nowMsProvider ?? (() => Date.now());
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }

    this.unsubscribe = this.eventBus.subscribe(async (event) => {
      if (event.type !== 'backing-image-changed') {
        return;
      }
      this.handleChange(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private handleChange(event: BackingImageChangedEvent): void {
    this.latestChange = event;
    this.pendingChange = true;
    this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.timer = setTimeout(() => {
      void this.flushPendingChange();
    }, this.debounceMs);
  }

  private async flushPendingChange(): Promise<void> {
    this.timer = null;
    if (this.inFlight || !this.pendingChange || !this.latestChange) {
      return;
    }

    this.inFlight = true;
    const change = this.latestChange;
    this.pendingChange = false;

    try {
      const mounted = await this.snapshotManager.createMountedSnapshot();
      const scanRootPath = await this.snapshotManager.resolveDiscoveryRoot(mounted);
      await this.eventBus.publish({
        type: 'snapshot-ready',
        occurredAtMs: this.nowMsProvider(),
        snapshotId: mounted.id,
        snapshotFilePath: mounted.filePath,
        snapshotMountPath: mounted.mountPath,
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
    } finally {
      this.inFlight = false;
      if (this.pendingChange) {
        this.scheduleSnapshot();
      }
    }
  }
}

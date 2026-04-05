import { stat } from 'fs/promises';
import { Subject, Subscription, exhaustMap, timer } from 'rxjs';
import { logger } from '../core/logger';
import { ArchiveEventBusLike } from './events';

export interface BackingImageChangeDetectorOptions {
  imagePath: string;
  eventBus: ArchiveEventBusLike;
  pollIntervalMs?: number;
  emitInitialEvent?: boolean;
  statProvider?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
}

export class BackingImageChangeDetector {
  private readonly imagePath: string;
  private readonly eventBus: ArchiveEventBusLike;
  private readonly pollIntervalMs: number;
  private readonly emitInitialEvent: boolean;
  private readonly statProvider: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  private running = false;
  private pollSubscription: Subscription | null = null;
  private readonly manualPoll$ = new Subject<void>();
  private manualPollSubscription: Subscription | null = null;
  private lastFingerprint = '';

  constructor(options: BackingImageChangeDetectorOptions) {
    this.imagePath = options.imagePath;
    this.eventBus = options.eventBus;
    this.pollIntervalMs = (options.pollIntervalMs ?? 100);
    this.emitInitialEvent = options.emitInitialEvent ?? true;
    this.statProvider = options.statProvider ?? (async (path) => stat(path));
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.pollSubscription = timer(0, this.pollIntervalMs)
      .pipe(exhaustMap(async () => this.pollNow()))
      .subscribe();

    this.manualPollSubscription = this.manualPoll$
      .pipe(exhaustMap(async () => this.pollNow()))
      .subscribe();
  }

  stop(): void {
    this.running = false;
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = null;
    this.manualPollSubscription?.unsubscribe();
    this.manualPollSubscription = null;
  }

  async pollNow(scheduleWhenRunning = false): Promise<void> {
    if (scheduleWhenRunning && this.running) {
      this.manualPoll$.next();
      return;
    }

    try {
      const current = await this.statProvider(this.imagePath);
      const fingerprint = `${current.size}:${Math.floor(current.mtimeMs)}`;
      const changed = fingerprint !== this.lastFingerprint;
      const shouldEmit = this.lastFingerprint === ''
        ? this.emitInitialEvent
        : changed;

      this.lastFingerprint = fingerprint;

      if (shouldEmit) {
        await this.eventBus.publish({
          type: 'backing-image-changed',
          occurredAtMs: Date.now(),
          imagePath: this.imagePath,
          imageSize: current.size,
          imageMtimeMs: current.mtimeMs,
        });
      }
    } catch (error) {
      logger.warn({ err: error, imagePath: this.imagePath }, 'Backing image change poll failed');
    }
  }
}

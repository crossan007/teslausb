import { stat } from 'fs/promises';
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
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastFingerprint = '';

  constructor(options: BackingImageChangeDetectorOptions) {
    this.imagePath = options.imagePath;
    this.eventBus = options.eventBus;
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1000);
    this.emitInitialEvent = options.emitInitialEvent ?? true;
    this.statProvider = options.statProvider ?? (async (path) => stat(path));
  }

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
  }

  async pollNow(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
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
      logger.warn({ error, imagePath: this.imagePath }, 'Backing image change poll failed');
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.pollNow();
    }, this.pollIntervalMs);
  }
}

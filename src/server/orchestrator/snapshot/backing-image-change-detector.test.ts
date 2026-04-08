import { describe, expect, it } from 'vitest';
import { BackingImageChangeDetector } from './backing-image-change-detector';
import { ArchiveEvent } from '../events';

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('BackingImageChangeDetector', () => {
  it('emits initial and changed image events', async () => {
    const events: ArchiveEvent[] = [];
    const stats = [
      { size: 100, mtimeMs: 1000 },
      { size: 100, mtimeMs: 1000 },
      { size: 120, mtimeMs: 2000 },
    ];

    const detector = new BackingImageChangeDetector({
      imagePath: '/backingfiles/cam_disk.bin',
      pollIntervalMs: 10_000,
      emitDebounceMs: 5,
      eventBus: {
        publish: async (event: ArchiveEvent) => {
          events.push(event);
        },
        subscribe: () => () => undefined,
      },
      statProvider: async () => stats.shift() ?? { size: 120, mtimeMs: 2000 },
    });

    detector.start();
    try {
      await detector.pollNow();
      await waitForCondition(() => events.length === 1);
      await detector.pollNow();
      await detector.pollNow();
      await waitForCondition(() => events.length === 2);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('backing-image-changed');
      expect(events[1].type).toBe('backing-image-changed');
      if (events[1].type === 'backing-image-changed') {
        expect(events[1].imageSize).toBe(120);
      }
    } finally {
      detector.stop();
    }
  });
});

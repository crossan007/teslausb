import { describe, expect, it } from 'vitest';
import { BackingImageChangeDetector } from './backing-image-change-detector';
import { ArchiveEvent } from '../events';

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
      eventBus: {
        publish: async (event: ArchiveEvent) => {
          events.push(event);
        },
        subscribe: () => () => undefined,
      },
      statProvider: async () => stats.shift() ?? { size: 120, mtimeMs: 2000 },
    });

    await detector.pollNow(true);
    await detector.pollNow();
    await detector.pollNow();

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('backing-image-changed');
    expect(events[1].type).toBe('backing-image-changed');
    if (events[1].type === 'backing-image-changed') {
      expect(events[1].imageSize).toBe(120);
    }
  });
});

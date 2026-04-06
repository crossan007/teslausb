import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveEvent } from '../events';
import { SnapshotManager } from './snapshot-manager';

describe('SnapshotManager event handling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces backing image changes into one mounted snapshot event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    const events: ArchiveEvent[] = [];
    const consumers = new Set<(event: ArchiveEvent) => void | Promise<void>>();
    const snapshotManager = new SnapshotManager(300, { changeDebounceMs: 100 });
    const createMountedSnapshot = vi
      .spyOn(snapshotManager, 'createMountedSnapshot')
      .mockResolvedValue({
        id: 'snap-000001',
        createdAt: 123,
        filePath: '/backingfiles/snapshots/snap-000001/snap.bin',
        tocPath: '/backingfiles/snapshots/snap-000001/snap.bin.toc',
        mountPath: '/backingfiles/snapshots/snap-000001/mnt',
        size: 100,
        isLinked: true,
      });
    vi
      .spyOn(snapshotManager, 'resolveDiscoveryRoot')
      .mockResolvedValue('/backingfiles/snapshots/snap-000001/mnt/TeslaCam');

    const eventBus = {
      publish: async (event: ArchiveEvent) => {
        events.push(event);
        for (const consumer of consumers) {
          await consumer(event);
        }
      },
      subscribe: (consumer: (event: ArchiveEvent) => void | Promise<void>) => {
        consumers.add(consumer);
        return () => {
          consumers.delete(consumer);
        };
      },
    };

    snapshotManager.start(eventBus);

    await eventBus.publish({
      type: 'backing-image-changed',
      occurredAtMs: 1000,
      imagePath: '/backingfiles/cam_disk.bin',
      imageSize: 100,
      imageMtimeMs: 1000,
    });
    await eventBus.publish({
      type: 'backing-image-changed',
      occurredAtMs: 1010,
      imagePath: '/backingfiles/cam_disk.bin',
      imageSize: 110,
      imageMtimeMs: 1010,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(createMountedSnapshot).toHaveBeenCalledTimes(1);
    const snapshotReadyEvents = events.filter(
      (event): event is Extract<ArchiveEvent, { type: 'snapshot-ready' }> => event.type === 'snapshot-ready',
    );
    expect(snapshotReadyEvents).toHaveLength(1);
    expect(snapshotReadyEvents[0].occurredAtMs).toBe(5100);

    snapshotManager.stop();
  });
});

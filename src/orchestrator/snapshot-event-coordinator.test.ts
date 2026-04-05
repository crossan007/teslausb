import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveEvent } from './events';
import { SnapshotEventCoordinator } from './snapshot-event-coordinator';

describe('SnapshotEventCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces backing image changes into one mounted snapshot event', async () => {
    vi.useFakeTimers();

    const events: ArchiveEvent[] = [];
    const consumers = new Set<(event: ArchiveEvent) => void | Promise<void>>();
    const snapshotManager = {
      createMountedSnapshot: vi.fn(async () => ({
        id: 'snap-000001',
        createdAt: 123,
        filePath: '/backingfiles/snapshots/snap-000001/snap.bin',
        tocPath: '/backingfiles/snapshots/snap-000001/snap.bin.toc',
        mountPath: '/backingfiles/snapshots/snap-000001/mnt',
        size: 100,
        isLinked: true,
      })),
    };

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

    const coordinator = new SnapshotEventCoordinator({
      eventBus,
      snapshotManager: snapshotManager as never,
      debounceMs: 100,
      nowMsProvider: () => 5000,
    });

    coordinator.start();

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

    expect(snapshotManager.createMountedSnapshot).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'snapshot-ready')).toHaveLength(1);

    coordinator.stop();
  });
});

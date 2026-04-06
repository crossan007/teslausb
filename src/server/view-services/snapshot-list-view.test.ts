import { describe, expect, it } from 'vitest';
import { ArchiveEvent } from '../orchestrator/events';
import { SnapshotListViewService } from './snapshot-list-view';
import { ClipRegistry } from '../../types';

class FakeEventBus {
  subscribe(_consumer: (event: ArchiveEvent) => Promise<void>): () => void {
    return () => undefined;
  }
}

describe('SnapshotListViewService', () => {
  it('computes newFilesCount from first-seen snapshot ownership', () => {
    const service = new SnapshotListViewService(new FakeEventBus());

    service.addSnapshot({
      id: 'snap-1',
      createdAt: 100,
      filePath: '/s1/snap.bin',
      tocPath: '/s1/snap.bin.toc',
      mountPath: '/s1/mnt',
      size: 0,
      isLinked: true,
    });
    service.addSnapshot({
      id: 'snap-2',
      createdAt: 200,
      filePath: '/s2/snap.bin',
      tocPath: '/s2/snap.bin.toc',
      mountPath: '/s2/mnt',
      size: 0,
      isLinked: true,
    });

    const registry: ClipRegistry = {
      updatedAt: Date.now(),
      entries: [
        {
          key: 'k1',
          clipName: 'a.mp4',
          relPath: 'SavedClips/a.mp4',
          firstSeenSnapshotId: 'snap-1',
          firstSeenSnapshotCreatedAt: 100,
          firstSeenAt: Date.now() - 5000,
          preferredSnapshotId: 'snap-2',
          preferredRootPath: '/s2/mnt/TeslaCam',
          preferredSnapshotCreatedAt: 200,
          status: 'pending',
          isSymlink: true,
          ageSec: 5,
          updatedAt: Date.now(),
        },
        {
          key: 'k2',
          clipName: 'b.mp4',
          relPath: 'SavedClips/b.mp4',
          firstSeenSnapshotId: 'snap-2',
          firstSeenSnapshotCreatedAt: 200,
          firstSeenAt: Date.now() - 4000,
          preferredSnapshotId: 'snap-2',
          preferredRootPath: '/s2/mnt/TeslaCam',
          preferredSnapshotCreatedAt: 200,
          status: 'transferred',
          isSymlink: true,
          ageSec: 4,
          transferredAt: Date.now() - 1000,
          updatedAt: Date.now(),
        },
      ],
    };

    service.applyClipRegistry(registry);
    const snapshotViews = service.snapshot();

    const snap1 = snapshotViews.find((entry) => entry.snapshot.id === 'snap-1');
    const snap2 = snapshotViews.find((entry) => entry.snapshot.id === 'snap-2');

    expect(snap1?.newFilesCount).toBe(1);
    expect(snap2?.newFilesCount).toBe(1);
    expect(snap1?.filesInProgress.map((file) => file.relPath)).toEqual(['SavedClips/a.mp4']);
    expect(snap2?.filesInProgress).toEqual([]);
  });
});

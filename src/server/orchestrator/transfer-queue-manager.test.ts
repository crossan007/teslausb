import { describe, expect, it } from 'vitest';
import { PendingClips, Snapshot, TransferQueue } from '../../types';
import { ClipDiscoveryResult } from './clip-discovery-manager';
import { TransferQueueManager } from './transfer-queue-manager';
import { blake2s256 } from '../shared';

function snapshot(id: string, createdAt: number, onRelease: () => Promise<void>): Snapshot {
  return {
    id,
    createdAt,
    filePath: `/backingfiles/snapshots/${id}/snap.bin`,
    tocPath: `/backingfiles/snapshots/${id}/snap.bin.toc`,
    mountPath: `/backingfiles/snapshots/${id}/mnt`,
    size: 0,
    isLinked: true,
    release: onRelease,
  };
}

function pending(relPath: string): PendingClips {
  return {
    totalFiles: 1,
    totalEvents: 1,
    oldestAgeSec: 10,
    files: [{ relPath, isSymlink: true, ageSec: 10 }],
  };
}

function discovery(rootPath: string, relPath: string, snap: Snapshot): ClipDiscoveryResult {
  const key = `b2s:${blake2s256(relPath)}`;
  return {
    rootPath,
    clips: [
      {
        key,
        fileName: relPath.split('/').at(-1) ?? relPath,
        relPath,
        absPath: `${rootPath}/${relPath}`,
        ageSec: 10,
        isSymlink: true,
      },
    ],
    filePaths: [relPath],
    pendingClips: pending(relPath),
    candidatesDiscovered: 1,
    candidatesFiltered: 0,
    previouslyArchivedRetained: 0,
    snapshot: snap,
  };
}

describe('TransferQueueManager', () => {
  it('queues files and releases snapshot after completion', async () => {
    const released: string[] = [];
    const persisted: TransferQueue[] = [];
    const manager = new TransferQueueManager({
      persistQueue: (queue) => persisted.push(queue),
    });

    const snap = snapshot('snap-1', 100, async () => {
      released.push('snap-1');
    });

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/a.mp4', snap),
    );

    const clip = manager.nextQueuedClip();
    expect(clip?.relPath).toEqual('SavedClips/a.mp4');

    manager.markTransferring([{ key: clip!.key }]);
    await manager.markCompleted([{ key: clip!.key }]);

    expect(manager.snapshot().files).toHaveLength(0);
    expect(released).toEqual(['snap-1']);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('remaps queued duplicate file to newest snapshot source and releases old snapshot', async () => {
    const released: string[] = [];
    const manager = new TransferQueueManager();
    const relPath = 'SavedClips/event-x/front.mp4';

    const oldSnap = snapshot('snap-1', 100, async () => {
      released.push('snap-1');
    });
    const newSnap = snapshot('snap-2', 200, async () => {
      released.push('snap-2');
    });

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', relPath, oldSnap),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', relPath, newSnap),
    );

    const queue = manager.snapshot();
    expect(queue.files).toHaveLength(1);
    expect(queue.files[0].sourceSnapshotId).toBe('snap-2');
    expect(released).toContain('snap-1');
    expect(released).not.toContain('snap-2');
  });
});

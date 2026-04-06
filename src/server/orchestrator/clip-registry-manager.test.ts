import { describe, expect, it } from 'vitest';
import { Snapshot } from '../../types';
import { blake2s256 } from '../shared';
import { ClipDiscoveryResult } from './clip-discovery-manager';
import { ClipRegistryManager } from './clip-registry-manager';

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
    pendingClips: {
      totalFiles: 1,
      totalEvents: 1,
      oldestAgeSec: 10,
      files: [{ relPath, isSymlink: true, ageSec: 10 }],
    },
    candidatesDiscovered: 1,
    candidatesFiltered: 0,
    previouslyArchivedRetained: 0,
    snapshot: snap,
  };
}

describe('ClipRegistryManager', () => {
  it('tracks first-seen snapshot while preferring newest source snapshot for transfer', async () => {
    const released: string[] = [];
    const manager = new ClipRegistryManager();
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

    const next = manager.nextClipForTransfer();
    expect(next?.firstSeenSnapshotId).toBe('snap-1');
    expect(next?.preferredSnapshotId).toBe('snap-2');

    manager.markTransferring(next!.key);
    await manager.markTransferred(next!.key);

    expect(released).toContain('snap-1');
    expect(released).toContain('snap-2');
  });

  it('derives transfer queue from untransferred clip registry entries', async () => {
    const manager = new ClipRegistryManager();
    const snap = snapshot('snap-1', 100, async () => undefined);

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/a.mp4', snap),
    );

    const queue = manager.snapshotTransferQueue();
    expect(queue.files).toHaveLength(1);
    expect(queue.files[0].status).toBe('queued');

    manager.markTransferring(queue.files[0].key);
    const queueDuringTransfer = manager.snapshotTransferQueue();
    expect(queueDuringTransfer.files[0].status).toBe('transferring');
  });
});

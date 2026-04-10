import { describe, expect, it } from 'vitest';
import { ClipRegistry, Snapshot } from '../../types';
import { blake2s256 } from '../shared';
import { ClipDiscoveryResult } from './clip-discovery/clip-discovery-manager';
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

function discovery(
  rootPath: string,
  relPath: string,
  snap: Snapshot,
  source?: { sizeBytes: number; mtimeMs: number },
): ClipDiscoveryResult {
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
        sizeBytes: source?.sizeBytes,
        mtimeMs: source?.mtimeMs,
      },
    ],
    candidatesDiscovered: 1,
    candidatesFiltered: 0,
    previouslyArchivedRetained: 0,
    snapshot: snap,
  };
}

describe('ClipRegistryManager', () => {
  it('recovers stale transferring entries to failed at startup', () => {
    const initialRegistry: ClipRegistry = {
      updatedAt: 100,
      entries: [
        {
          key: 'k1',
          clipName: 'a.mp4',
          relPath: 'RecentClips/a.mp4',
          firstSeenSnapshotId: 'snap-1',
          firstSeenSnapshotCreatedAt: 100,
          firstSeenAt: 100,
          preferredSnapshotId: 'snap-1',
          preferredRootPath: '/backingfiles/snapshots/snap-1/mnt/TeslaCam',
          preferredSnapshotCreatedAt: 100,
          status: 'transferring',
          isSymlink: true,
          ageSec: 10,
          updatedAt: 100,
          lastAttemptAt: 100,
        },
      ],
    };

    const persisted: ClipRegistry[] = [];
    const manager = new ClipRegistryManager({
      initialRegistry,
      persistRegistry: (registry) => persisted.push(registry),
    });

    const recovered = manager.snapshotRegistry().entries.find((entry) => entry.key === 'k1');
    expect(recovered?.status).toBe('failed');
    expect(persisted.length).toBe(1);

    const next = manager.nextClipForTransfer();
    expect(next?.key).toBe('k1');
    expect(next?.status).toBe('failed');
  });

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

  it('re-queues clip when same relPath is reused with changed file content', async () => {
    const released: string[] = [];
    const manager = new ClipRegistryManager();
    const relPath = 'RecentClips/front.mp4';

    const snap1 = snapshot('snap-1', 100, async () => {
      released.push('snap-1');
    });
    const snap2 = snapshot('snap-2', 200, async () => {
      released.push('snap-2');
    });

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', relPath, snap1, {
        sizeBytes: 120_000,
        mtimeMs: 1_000,
      }),
    );

    let next = manager.nextClipForTransfer();
    expect(next?.relPath).toBe(relPath);
    await manager.markTransferred(next!.key);
    expect(released).toContain('snap-1');

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', relPath, snap2, {
        sizeBytes: 130_000,
        mtimeMs: 2_000,
      }),
    );

    next = manager.nextClipForTransfer();
    expect(next?.relPath).toBe(relPath);
    expect(next?.firstSeenSnapshotId).toBe('snap-2');

    await manager.markTransferred(next!.key);
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

  it('derives pending clips snapshot from registry entries', async () => {
    const manager = new ClipRegistryManager();
    const snap = snapshot('snap-1', 100, async () => undefined);

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/event-a/front.mp4', snap),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/event-a/rear.mp4', snap),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'RecentClips/latest.mp4', snap),
    );

    const pending = manager.snapshotPendingClips();
    expect(pending.totalFiles).toBe(3);
    expect(pending.totalEvents).toBe(1);

    const next = manager.nextClipForTransfer();
    expect(next).toBeDefined();
    await manager.markTransferred(next!.key);

    const pendingAfterTransfer = manager.snapshotPendingClips();
    expect(pendingAfterTransfer.totalFiles).toBe(2);
  });

  it('prioritizes SavedClips, then SentryClips, then remaining clips (oldest to newest)', async () => {
    const manager = new ClipRegistryManager();
    const snap1 = snapshot('snap-1', 100, async () => undefined);
    const snap2 = snapshot('snap-2', 200, async () => undefined);
    const snap3 = snapshot('snap-3', 300, async () => undefined);

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'RecentClips/r-new.mp4', snap3),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SentryClips/s-old.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/a-old.mp4', snap1),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/b-newer.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'SentryClips/t-newer.mp4', snap3),
    );

    const order: string[] = [];
    while (true) {
      const next = manager.nextClipForTransfer();
      if (!next) {
        break;
      }
      order.push(next.relPath);
      await manager.markTransferred(next.key);
    }

    expect(order).toEqual([
      'SavedClips/a-old.mp4',
      'SavedClips/b-newer.mp4',
      'SentryClips/s-old.mp4',
      'SentryClips/t-newer.mp4',
      'RecentClips/r-new.mp4',
    ]);
  });

  it('transfers saved metadata artifacts for all events before saved videos, then sentry/recent', async () => {
    const manager = new ClipRegistryManager();
    const snap1 = snapshot('snap-1', 100, async () => undefined);
    const snap2 = snapshot('snap-2', 200, async () => undefined);
    const snap3 = snapshot('snap-3', 300, async () => undefined);

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/evt-a/front.mp4', snap1),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/evt-a/event.json', snap1),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/evt-b/event.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/evt-b/rear.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'SavedClips/evt-c/thumb.png', snap3),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'SentryClips/evt-z/front.mp4', snap3),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'RecentClips/latest.mp4', snap3),
    );

    const order: string[] = [];
    while (true) {
      const next = manager.nextClipForTransfer();
      if (!next) {
        break;
      }
      order.push(next.relPath);
      await manager.markTransferred(next.key);
    }

    expect(order).toEqual([
      'SavedClips/evt-a/event.json',
      'SavedClips/evt-b/event.mp4',
      'SavedClips/evt-c/thumb.png',
      'SavedClips/evt-a/front.mp4',
      'SavedClips/evt-b/rear.mp4',
      'SentryClips/evt-z/front.mp4',
      'RecentClips/latest.mp4',
    ]);
  });

  it('processes non-metadata sentry clips before other non-sentry clips after metadata and saved tiers', async () => {
    const manager = new ClipRegistryManager();
    const snap1 = snapshot('snap-1', 100, async () => undefined);
    const snap2 = snapshot('snap-2', 200, async () => undefined);
    const snap3 = snapshot('snap-3', 300, async () => undefined);

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/evt-a/event.json', snap1),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/evt-a/front.mp4', snap1),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SentryClips/evt-z/event.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SentryClips/evt-z/front.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'RecentClips/latest.mp4', snap3),
    );

    const order: string[] = [];
    while (true) {
      const next = manager.nextClipForTransfer();
      if (!next) {
        break;
      }
      order.push(next.relPath);
      await manager.markTransferred(next.key);
    }

    expect(order).toEqual([
      'SavedClips/evt-a/event.json',
      'SentryClips/evt-z/event.mp4',
      'SavedClips/evt-a/front.mp4',
      'SentryClips/evt-z/front.mp4',
      'RecentClips/latest.mp4',
    ]);
  });

  it('accepts missing source loss by transitioning missing queued clips to transferred', async () => {
    const manager = new ClipRegistryManager();
    const snap = snapshot('snap-1', 100, async () => undefined);

    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'RecentClips/missing.mp4', snap),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'RecentClips/existing.mp4', snap),
    );

    const validation = await manager.validatePendingClipSources(
      async (entry) => entry.relPath === 'RecentClips/existing.mp4',
      { onMissing: 'transferred' },
    );

    expect(validation.checked).toBe(2);
    expect(validation.missing).toBe(1);
    expect(validation.eligibleKeys.size).toBe(1);

    const queue = manager.snapshotTransferQueue();
    expect(queue.files.map((file) => file.relPath)).toEqual(['RecentClips/existing.mp4']);

    const next = manager.nextClipForTransfer();
    expect(next?.relPath).toBe('RecentClips/existing.mp4');
  });

  it('identifies pruneable snapshots with redundant files', async () => {
    const manager = new ClipRegistryManager();
    const snap1 = snapshot('snap-1', 100, async () => undefined);
    const snap2 = snapshot('snap-2', 200, async () => undefined);
    const snap3 = snapshot('snap-3', 300, async () => undefined);

    // snap-1: discovers a.mp4 and b.mp4 (pending file)
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/a.mp4', snap1),
    );
    // snap-2: discovers same a.mp4 and unique c.mp4
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/a.mp4', snap2),
    );
    await manager.ingestDiscovery(
      discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/c.mp4', snap2),
    );
    // snap-3: discovers both a.mp4 and c.mp4 (newest snapshot has both)
      await manager.ingestDiscovery(
        discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'SavedClips/a.mp4', snap3),
      );
      await manager.ingestDiscovery(
        discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'SavedClips/c.mp4', snap3),
      );

      // snap-1 has a.mp4 transferring; snap-2 has all files in snap-3, so prune snap-2
      const registry = manager.snapshotRegistry();
      const snap1FileA = registry.entries.find((e) => e.relPath === 'SavedClips/a.mp4');
      manager.markTransferring(snap1FileA!.key);

      const pruneable = manager.identifyPrunableSnapshots();
      // snap-2 is between snap-1 (oldest with active) and snap-3 (newest)
      // snap-2's unique files (a.mp4, c.mp4) all exist in snap-3, so snap-2 is prunable
      expect(pruneable).toContain('snap-2');
      expect(pruneable).not.toContain('snap-1'); // oldest, never prune
      expect(pruneable).not.toContain('snap-3'); // newest, never prune
    });

    it('preserves snapshots with unique un-transferred files not in newer snapshots', async () => {
      const manager = new ClipRegistryManager();
      const snap1 = snapshot('snap-1', 100, async () => undefined);
      const snap2 = snapshot('snap-2', 200, async () => undefined);
      const snap3 = snapshot('snap-3', 300, async () => undefined);

      // snap-1: discovers a.mp4 (will transfer from snap-2)
      await manager.ingestDiscovery(
        discovery('/backingfiles/snapshots/snap-1/mnt/TeslaCam', 'SavedClips/a.mp4', snap1),
      );
      // snap-2: discovers same a.mp4 and unique b.mp4
      await manager.ingestDiscovery(
        discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/a.mp4', snap2),
      );
      await manager.ingestDiscovery(
        discovery('/backingfiles/snapshots/snap-2/mnt/TeslaCam', 'SavedClips/b.mp4', snap2),
      );
      // snap-3: only discovers a.mp4 (missing b.mp4)
      await manager.ingestDiscovery(
        discovery('/backingfiles/snapshots/snap-3/mnt/TeslaCam', 'SavedClips/a.mp4', snap3),
      );

      // snap-1 has active file; snap-2 has unique b.mp4 not in snap-3, so don't prune
      const registry = manager.snapshotRegistry();
      const snap1FileA = registry.entries.find((e) => e.relPath === 'SavedClips/a.mp4');
      manager.markTransferring(snap1FileA!.key);

      const pruneable = manager.identifyPrunableSnapshots();
      // snap-2 is between snap-1 and snap-3, but b.mp4 is unique to snap-2, so keep it
      expect(pruneable).not.toContain('snap-2');
    });
});

import { describe, expect, it, vi } from 'vitest';
import { PendingClips } from '../types';
import { ClipDiscoveryLoop } from './clip-discovery-loop';
import { ClipDiscoveryManager, ClipDiscoveryResult } from './clip-discovery-manager';

class FakeDiscoveryManager extends ClipDiscoveryManager {
  private readonly queue: ClipDiscoveryResult[];

  constructor(queue: ClipDiscoveryResult[]) {
    super();
    this.queue = [...queue];
  }

  override async discoverPending(): Promise<ClipDiscoveryResult> {
    return this.queue.shift() ?? makeResult([]);
  }
}

function makePending(filePaths: string[]): PendingClips {
  return {
    totalFiles: filePaths.length,
    totalEvents: 0,
    oldestAgeSec: 0,
    files: filePaths.map((path) => ({ relPath: path, isSymlink: true, ageSec: 0 })),
  };
}

function makeResult(filePaths: string[]): ClipDiscoveryResult {
  return {
    rootPath: '/tmp/snapshots/snap-000001',
    filePaths,
    pendingClips: makePending(filePaths),
    candidatesDiscovered: filePaths.length,
    candidatesFiltered: 0,
    previouslyArchivedRetained: 0,
  };
}

describe('ClipDiscoveryLoop', () => {
  it('emits only when clips are discovered and changed', async () => {
    const manager = new FakeDiscoveryManager([
      makeResult([]),
      makeResult(['TeslaCam/SavedClips/a.mp4']),
      makeResult(['TeslaCam/SavedClips/a.mp4']),
      makeResult(['TeslaCam/SavedClips/b.mp4']),
    ]);

    const received: string[][] = [];
    const loop = new ClipDiscoveryLoop(manager, {
      rootPath: '/tmp/root',
      archivedListPath: '/tmp/archived',
      intervalMs: 10_000,
    });

    const subscription = loop.discovered$.subscribe((result) => {
      received.push(result.filePaths);
    });

    await loop.pollNow();
    await loop.pollNow();
    await loop.pollNow();
    await loop.pollNow();

    subscription.unsubscribe();
    loop.stop();

    expect(received).toEqual([
      ['TeslaCam/SavedClips/a.mp4'],
      ['TeslaCam/SavedClips/b.mp4'],
    ]);
  });

  it('persists pending clips for every poll', async () => {
    const manager = new FakeDiscoveryManager([
      makeResult([]),
      makeResult(['TeslaCam/SentryClips/a.mp4', 'TeslaCam/SentryClips/b.mp4']),
    ]);

    const persist = vi.fn();
    const loop = new ClipDiscoveryLoop(manager, {
      rootPath: '/tmp/root',
      archivedListPath: '/tmp/archived',
      intervalMs: 10_000,
      persistPendingClips: persist,
    });

    await loop.pollNow();
    await loop.pollNow();
    loop.stop();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0].totalFiles).toBe(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PendingClips, Snapshot } from '../types';
import { ClipDiscoveryManager, ClipDiscoveryResult } from './clip-discovery-manager';
import { SnapshotDiscoveryConsumer } from './snapshot-discovery-consumer';
import { ArchiveEvent } from './events';

type BusSubscriber = (event: ArchiveEvent) => Promise<void>;

class FakeEventBus {
  private subscribers: BusSubscriber[] = [];

  async publish(event: ArchiveEvent): Promise<void> {
    await Promise.all(this.subscribers.map((s) => s(event)));
  }

  subscribe(handler: BusSubscriber): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== handler);
    };
  }
}

class FakeDiscoveryManager extends ClipDiscoveryManager {
  private readonly queue: ClipDiscoveryResult[];

  constructor(queue: ClipDiscoveryResult[]) {
    super();
    this.queue = [...queue];
  }

  override async discoverPending(options: { rootPath: string }): Promise<ClipDiscoveryResult> {
    return this.queue.shift() ?? makeResult(options.rootPath, []);
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

function makeResult(rootPath: string, filePaths: string[]): ClipDiscoveryResult {
  return {
    rootPath,
    filePaths,
    pendingClips: makePending(filePaths),
    candidatesDiscovered: filePaths.length,
    candidatesFiltered: 0,
    previouslyArchivedRetained: 0,
  };
}

const ROOT_A = '/backingfiles/snapshots/snap-000001/mnt/TeslaCam';
const ROOT_B = '/backingfiles/snapshots/snap-000002/mnt/TeslaCam';

async function snapshotReady(bus: FakeEventBus, scanRootPath: string): Promise<void> {
  const snapshot: Snapshot = {
    id: 'snap-000001',
    createdAt: Math.floor(Date.now() / 1000),
    filePath: '/backingfiles/snapshots/snap-000001/snap.bin',
    tocPath: '/backingfiles/snapshots/snap-000001/snap.bin.toc',
    mountPath: '/backingfiles/snapshots/snap-000001/mnt',
    size: 100,
    isLinked: true,
  };

  await bus.publish({
    type: 'snapshot-ready',
    occurredAtMs: Date.now(),
    snapshot,
    scanRootPath,
  });
}

describe('SnapshotDiscoveryConsumer', () => {
  it('emits a result for each snapshot root with clips', async () => {
    const bus = new FakeEventBus();
    const manager = new FakeDiscoveryManager([
      makeResult(ROOT_A, ['SavedClips/a.mp4']),
      makeResult(ROOT_B, ['SentryClips/b.mp4']),
    ]);
    const consumer = new SnapshotDiscoveryConsumer(manager, {
      archivedListPath: '/tmp/archived',
      eventBus: bus,
    });

    const received: ClipDiscoveryResult[] = [];
    consumer.start();
    consumer.discovered$.subscribe((r) => received.push(r));

    await snapshotReady(bus, ROOT_A);
    await snapshotReady(bus, ROOT_B);

    consumer.stop();

    expect(received).toHaveLength(2);
    expect(received[0].filePaths).toEqual(['SavedClips/a.mp4']);
    expect(received[1].filePaths).toEqual(['SentryClips/b.mp4']);
  });

  it('does not emit when discovery returns no clips', async () => {
    const bus = new FakeEventBus();
    const manager = new FakeDiscoveryManager([
      makeResult(ROOT_A, []),
    ]);
    const consumer = new SnapshotDiscoveryConsumer(manager, {
      archivedListPath: '/tmp/archived',
      eventBus: bus,
    });

    const received: ClipDiscoveryResult[] = [];
    consumer.start();
    consumer.discovered$.subscribe((r) => received.push(r));

    await snapshotReady(bus, ROOT_A);
    consumer.stop();

    expect(received).toHaveLength(0);
  });

  it('deduplicates identical results by fingerprint (emitOnChangeOnly=true default)', async () => {
    const bus = new FakeEventBus();
    const manager = new FakeDiscoveryManager([
      makeResult(ROOT_A, ['SavedClips/a.mp4']),
      makeResult(ROOT_A, ['SavedClips/a.mp4']),
      makeResult(ROOT_A, ['SavedClips/b.mp4']),
    ]);
    const consumer = new SnapshotDiscoveryConsumer(manager, {
      archivedListPath: '/tmp/archived',
      eventBus: bus,
    });

    const received: string[][] = [];
    consumer.start();
    consumer.discovered$.subscribe((r) => received.push(r.filePaths));

    await snapshotReady(bus, ROOT_A);
    await snapshotReady(bus, ROOT_A);
    await snapshotReady(bus, ROOT_A);
    consumer.stop();

    expect(received).toEqual([['SavedClips/a.mp4'], ['SavedClips/b.mp4']]);
  });

  it('emits duplicates when emitOnChangeOnly is false', async () => {
    const bus = new FakeEventBus();
    const manager = new FakeDiscoveryManager([
      makeResult(ROOT_A, ['SavedClips/a.mp4']),
      makeResult(ROOT_A, ['SavedClips/a.mp4']),
    ]);
    const consumer = new SnapshotDiscoveryConsumer(manager, {
      archivedListPath: '/tmp/archived',
      emitOnChangeOnly: false,
      eventBus: bus,
    });

    const received: string[][] = [];
    consumer.start();
    consumer.discovered$.subscribe((r) => received.push(r.filePaths));

    await snapshotReady(bus, ROOT_A);
    await snapshotReady(bus, ROOT_A);
    consumer.stop();

    expect(received).toHaveLength(2);
  });

  it('persists pending clips for each processed root', async () => {
    const bus = new FakeEventBus();
    const manager = new FakeDiscoveryManager([
      makeResult(ROOT_A, []),
      makeResult(ROOT_B, ['SentryClips/b.mp4', 'SentryClips/c.mp4']),
    ]);
    const persist = vi.fn();
    const consumer = new SnapshotDiscoveryConsumer(manager, {
      archivedListPath: '/tmp/archived',
      persistPendingClips: persist,
      eventBus: bus,
    });

    consumer.start();
    await snapshotReady(bus, ROOT_A);
    await snapshotReady(bus, ROOT_B);
    consumer.stop();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0].totalFiles).toBe(2);
  });

  it('ignores non-snapshot-ready events', async () => {
    const bus = new FakeEventBus();
    const manager = new FakeDiscoveryManager([makeResult(ROOT_A, ['SavedClips/a.mp4'])]);
    const consumer = new SnapshotDiscoveryConsumer(manager, {
      archivedListPath: '/tmp/archived',
      eventBus: bus,
    });

    const received: ClipDiscoveryResult[] = [];
    consumer.start();
    consumer.discovered$.subscribe((r) => received.push(r));

    await bus.publish({ type: 'backing-image-changed', occurredAtMs: Date.now(), imagePath: '/x', imageSize: 0, imageMtimeMs: 0 });
    consumer.stop();

    expect(received).toHaveLength(0);
  });
});

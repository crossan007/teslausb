import { Observable, Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { PendingClips, Snapshot, SyncStatus } from '../../types';
import { CommandResult, CommandRunner } from '../shared/command-runner';
import { RuntimeLifecycleLoop } from './runtime-lifecycle-loop';
import { ClipDiscoveryManager, ClipDiscoveryResult } from './clip-discovery-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend } from '../../types/archive';
import { ArchiveEvent } from './events';
import { blake2s256 } from '../shared';

class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command === 'sntp') {
      return { code: 1, stdout: '', stderr: '' };
    }
    if (command === 'ntpdig') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async runStreaming(command: string, args: string[]): Promise<CommandResult> {
    return this.run(command, args);
  }
}

class FakeBackend implements ArchiveBackend {
  name = 'fake';
  private checks = 0;

  constructor(private readonly reachableAfterChecks: number) {}

  async verify(): Promise<void> {
    return;
  }

  async isReachable(): Promise<boolean> {
    this.checks += 1;
    return this.checks >= this.reachableAfterChecks;
  }

  async connect(): Promise<void> {
    return;
  }

  archiveClips() {
    throw new Error('not used in this test');
  }

  async disconnect(): Promise<void> {
    return;
  }
}

class FakeOrchestrator {
  calls = 0;

  async runArchiveCycle() {
    this.calls += 1;
    return { skipped: false, archived: 1, failed: 0 };
  }
}

class FakeOrchestratorSequence {
  calls = 0;

  constructor(private readonly sequence: Array<'success' | 'fail'>) {}

  async runArchiveCycle() {
    this.calls += 1;
    const action = this.sequence.shift() ?? 'success';
    if (action === 'fail') {
      return { skipped: false, archived: 0, failed: 1 };
    }
    return { skipped: false, archived: 1, failed: 0 };
  }
}

class FakeDiscoveryManager {
  marked: string[] = [];

  async resolveArchivedFromSource(_rootPath: string, filePaths: string[]): Promise<string[]> {
    return filePaths;
  }

  async markArchived(filePaths: string[]): Promise<void> {
    this.marked.push(...filePaths);
  }
}

class FakeDiscoveryLoop {
  readonly subject = new Subject<ClipDiscoveryResult>();
  started = false;
  stopped = false;

  get discovered$(): Observable<ClipDiscoveryResult> {
    return this.subject.asObservable();
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
    this.subject.complete();
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pending(totalFiles = 1): PendingClips {
  return {
    totalFiles,
    totalEvents: 1,
    oldestAgeSec: 10,
    files: [
      {
        relPath: 'SavedClips/evt1/file.mp4',
        isSymlink: true,
        ageSec: 10,
      },
    ],
  };
}

function snapshotWithRelease(snapshotId: string, release: () => Promise<void>): Snapshot {
  return {
    id: snapshotId,
    createdAt: 0,
    filePath: `/backingfiles/snapshots/${snapshotId}/snap.bin`,
    tocPath: `/backingfiles/snapshots/${snapshotId}/snap.bin.toc`,
    mountPath: `/backingfiles/snapshots/${snapshotId}/mnt`,
    size: 0,
    isLinked: true,
    release,
  };
}

function clip(relPath: string, rootPath: string) {
  return {
    key: `b2s:${blake2s256(relPath)}`,
    fileName: 'file.mp4',
    relPath,
    absPath: `${rootPath}/${relPath}`,
    ageSec: 10,
    isSymlink: true,
  };
}

describe('RuntimeLifecycleLoop', () => {
  it('waits for reachability and processes archive batch with lifecycle hooks', async () => {
    const discoveryLoop = new FakeDiscoveryLoop();
    const manager = new FakeDiscoveryManager();
    const orchestrator = new FakeOrchestrator();
    const backend = new FakeBackend(2);
    const runner = new FakeCommandRunner();

    const syncStatusWrites: SyncStatus[] = [];
    const triggerEvents: ArchiveEvent[] = [];
    const releasedSnapshots: string[] = [];

    const loop = new RuntimeLifecycleLoop(
      discoveryLoop,
      manager as unknown as ClipDiscoveryManager,
      orchestrator as unknown as ClipArchiveCoordinator,
      backend,
      {
        archivedListPath: '/mutable/sentry_files_archived',
        archiveDelaySec: 0,
        reachabilityPollMs: 1,
      },
      runner,
      {
        syncStatusWriter: {
          writeSyncStatus: (status: SyncStatus) => {
            syncStatusWrites.push(status);
          },
        },
        runtimeLogger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        eventBus: {
          publish: async (event: ArchiveEvent) => {
            triggerEvents.push(event);
          },
          subscribe: () => () => undefined,
        },
      },
    );

    loop.start();
    const rootPath = '/backingfiles/snapshots/snap-000001/mnt/TeslaCam';
    const relPath = 'SavedClips/evt1/file.mp4';
    discoveryLoop.subject.next({
      rootPath,
      clips: [clip(relPath, rootPath)],
      filePaths: [relPath],
      pendingClips: pending(),
      candidatesDiscovered: 1,
      candidatesFiltered: 0,
      previouslyArchivedRetained: 0,
      snapshot: snapshotWithRelease('snap-000001', async () => {
        releasedSnapshots.push('snap-000001');
      }),
    });

    await waitForCondition(() => orchestrator.calls === 1, 1000);

    expect(orchestrator.calls).toBe(1);
    expect(manager.marked).toEqual(['SavedClips/evt1/file.mp4']);
    expect(releasedSnapshots).toEqual(['snap-000001']);
    expect(triggerEvents.map((event) => event.type)).toEqual(['archive-start', 'archive-finish']);
    expect(syncStatusWrites.length).toBeGreaterThan(0);

    loop.stop();
  });

  it('skips archive when reachability checks are exhausted', async () => {
    const discoveryLoop = new FakeDiscoveryLoop();
    const manager = new FakeDiscoveryManager();
    const orchestrator = new FakeOrchestrator();
    const backend = new FakeBackend(100);

    const syncStatusWrites: SyncStatus[] = [];

    const loop = new RuntimeLifecycleLoop(
      discoveryLoop,
      manager as unknown as ClipDiscoveryManager,
      orchestrator as unknown as ClipArchiveCoordinator,
      backend,
      {
        archivedListPath: '/mutable/sentry_files_archived',
        archiveDelaySec: 0,
        reachabilityPollMs: 1,
        maxReachabilityChecks: 2,
      },
      new FakeCommandRunner(),
      {
        syncStatusWriter: {
          writeSyncStatus: (status: SyncStatus) => {
            syncStatusWrites.push(status);
          },
        },
        runtimeLogger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
    );

    loop.start();
    const rootPath = '/backingfiles/snapshots/snap-000001/mnt/TeslaCam';
    const relPath = 'SavedClips/evt1/file.mp4';
    discoveryLoop.subject.next({
      rootPath,
      clips: [clip(relPath, rootPath)],
      filePaths: [relPath],
      pendingClips: pending(),
      candidatesDiscovered: 1,
      candidatesFiltered: 0,
      previouslyArchivedRetained: 0,
    });

    await waitForCondition(() => syncStatusWrites.length >= 2, 1000);

    expect(orchestrator.calls).toBe(0);
    expect(manager.marked).toEqual([]);
    expect(syncStatusWrites.at(-1)?.state).toBe('waiting');

    loop.stop();
  });

  it('stops queue drain after 3 consecutive transfer failures', async () => {
    const discoveryLoop = new FakeDiscoveryLoop();
    const manager = new FakeDiscoveryManager();
    const orchestrator = new FakeOrchestratorSequence(['fail', 'fail', 'fail', 'fail']);
    const backend = new FakeBackend(1);
    const warned: string[] = [];

    const loop = new RuntimeLifecycleLoop(
      discoveryLoop,
      manager as unknown as ClipDiscoveryManager,
      orchestrator as unknown as ClipArchiveCoordinator,
      backend,
      {
        archivedListPath: '/mutable/sentry_files_archived',
        archiveDelaySec: 0,
        reachabilityPollMs: 1,
        maxConsecutiveTransferFailures: 3,
      },
      new FakeCommandRunner(),
      {
        syncStatusWriter: {
          writeSyncStatus: () => undefined,
        },
        runtimeLogger: {
          info: () => undefined,
          warn: (_payload: unknown, message?: string) => {
            warned.push(message ?? '');
          },
          error: () => undefined,
        },
      },
    );

    loop.start();
    const rootPath = '/backingfiles/snapshots/snap-000001/mnt/TeslaCam';
    const relPath = 'SavedClips/evt1/file.mp4';
    discoveryLoop.subject.next({
      rootPath,
      clips: [clip(relPath, rootPath)],
      filePaths: [relPath],
      pendingClips: pending(),
      candidatesDiscovered: 1,
      candidatesFiltered: 0,
      previouslyArchivedRetained: 0,
      snapshot: snapshotWithRelease('snap-000001', async () => undefined),
    });

    await waitForCondition(() => orchestrator.calls === 3, 1000);

    expect(orchestrator.calls).toBe(3);
    expect(warned).toContain('Stopping queue drain after consecutive transfer failures');

    loop.stop();
  });

  it('resets consecutive failure counter after a success', async () => {
    const discoveryLoop = new FakeDiscoveryLoop();
    const manager = new FakeDiscoveryManager();
    const orchestrator = new FakeOrchestratorSequence(['fail', 'success', 'fail', 'fail', 'fail']);
    const backend = new FakeBackend(1);
    const warned: string[] = [];

    const loop = new RuntimeLifecycleLoop(
      discoveryLoop,
      manager as unknown as ClipDiscoveryManager,
      orchestrator as unknown as ClipArchiveCoordinator,
      backend,
      {
        archivedListPath: '/mutable/sentry_files_archived',
        archiveDelaySec: 0,
        reachabilityPollMs: 1,
        maxConsecutiveTransferFailures: 3,
      },
      new FakeCommandRunner(),
      {
        syncStatusWriter: {
          writeSyncStatus: () => undefined,
        },
        runtimeLogger: {
          info: () => undefined,
          warn: (_payload: unknown, message?: string) => {
            warned.push(message ?? '');
          },
          error: () => undefined,
        },
      },
    );

    loop.start();
    const rootPath = '/backingfiles/snapshots/snap-000001/mnt/TeslaCam';
    const relPathA = 'SavedClips/evt1/a.mp4';
    const relPathB = 'SavedClips/evt1/b.mp4';
    discoveryLoop.subject.next({
      rootPath,
      clips: [clip(relPathA, rootPath), clip(relPathB, rootPath)],
      filePaths: [relPathA, relPathB],
      pendingClips: pending(2),
      candidatesDiscovered: 2,
      candidatesFiltered: 0,
      previouslyArchivedRetained: 0,
      snapshot: snapshotWithRelease('snap-000001', async () => undefined),
    });

    await waitForCondition(() => orchestrator.calls === 5, 1000);

    expect(orchestrator.calls).toBe(5);
    expect(manager.marked.length).toBe(1);
    expect(warned).toContain('Stopping queue drain after consecutive transfer failures');

    loop.stop();
  });
});

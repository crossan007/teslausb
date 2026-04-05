import { Observable, Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { PendingClips, SyncStatus } from '../types';
import { CommandResult, CommandRunner } from '../shared/command-runner';
import { RuntimeLifecycleLoop } from './runtime-lifecycle-loop';
import { ClipDiscoveryLoop } from './clip-discovery-loop';
import { ClipDiscoveryManager, ClipDiscoveryResult } from './clip-discovery-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend } from '../types/archive';
import { ArchiveEvent } from './events';

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

describe('RuntimeLifecycleLoop', () => {
  it('waits for reachability and processes archive batch with lifecycle hooks', async () => {
    const discoveryLoop = new FakeDiscoveryLoop();
    const manager = new FakeDiscoveryManager();
    const orchestrator = new FakeOrchestrator();
    const backend = new FakeBackend(2);
    const runner = new FakeCommandRunner();

    const syncStatusWrites: SyncStatus[] = [];
    const triggerEvents: ArchiveEvent[] = [];

    const loop = new RuntimeLifecycleLoop(
      discoveryLoop as unknown as ClipDiscoveryLoop,
      manager as unknown as ClipDiscoveryManager,
      orchestrator as unknown as ClipArchiveCoordinator,
      backend,
      {
        clipDiscoveryRoot: '/mutable/TeslaCam',
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
    discoveryLoop.subject.next({
      rootPath: '/tmp/snapshots/snap-000001',
      filePaths: ['TeslaCam/SavedClips/evt1/file.mp4'],
      pendingClips: pending(),
      candidatesDiscovered: 1,
      candidatesFiltered: 0,
      previouslyArchivedRetained: 0,
    });

    await waitForCondition(() => orchestrator.calls === 1, 1000);

    expect(orchestrator.calls).toBe(1);
    expect(manager.marked).toEqual(['TeslaCam/SavedClips/evt1/file.mp4']);
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
      discoveryLoop as unknown as ClipDiscoveryLoop,
      manager as unknown as ClipDiscoveryManager,
      orchestrator as unknown as ClipArchiveCoordinator,
      backend,
      {
        clipDiscoveryRoot: '/mutable/TeslaCam',
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
    discoveryLoop.subject.next({
      rootPath: '/tmp/snapshots/snap-000001',
      filePaths: ['TeslaCam/SavedClips/evt1/file.mp4'],
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
});

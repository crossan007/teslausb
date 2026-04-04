import { describe, it, expect } from 'vitest';
import { ArchiveBackend, ArchiveTransferExecution, SyncStatus, OperationResult, createCompletedTransferExecution } from '../types';
import { Orchestrator, StateSink } from './orchestrator';

class MockBackend implements ArchiveBackend {
  name = 'mock';
  reachable = true;
  connectCalls = 0;
  disconnectCalls = 0;
  archiveCalls = 0;
  failArchive = false;

  async verify(): Promise<void> {
    return;
  }

  async isReachable(): Promise<boolean> {
    return this.reachable;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  archiveClips(_fromPath: string, filePaths: string[]): ArchiveTransferExecution {
    this.archiveCalls += 1;
    const result = (async () => {
      if (this.failArchive) {
        throw new Error('archive failed');
      }
      return { archived: filePaths.length, failed: 0 };
    })();

    return {
      session$: createCompletedTransferExecution(this.name, filePaths, {
        archived: this.failArchive ? 0 : filePaths.length,
        failed: this.failArchive ? filePaths.length : 0,
      }, 'mock-session').session$,
      result,
    };
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

class InMemoryStateSink implements StateSink {
  statuses: SyncStatus[] = [];
  results: OperationResult<any>[] = [];
  transfers = 0;

  writeSyncStatus(status: SyncStatus): void {
    this.statuses.push(status);
  }

  writeOperationResult(_operation: string, result: OperationResult<any>): void {
    this.results.push(result);
  }

  writeTransferSession(): void {
    this.transfers += 1;
  }
}

describe('Orchestrator', () => {
  it('runs archive lifecycle when backend is reachable', async () => {
    const backend = new MockBackend();
    const state = new InMemoryStateSink();
    const orchestrator = new Orchestrator(backend, undefined, undefined, state);

    const result = await orchestrator.runArchiveCycle({
      fromPath: '/tmp/mnt',
      files: ['a.mp4', 'b.mp4'],
    });

    expect(result.skipped).toBe(false);
    expect(result.archived).toBe(2);
    expect(backend.connectCalls).toBe(1);
    expect(backend.archiveCalls).toBe(1);
    expect(backend.disconnectCalls).toBe(1);
    expect(state.results).toHaveLength(1);
    expect(state.transfers).toBeGreaterThan(0);
    expect(state.results[0].success).toBe(true);
  });

  it('skips cycle when backend is unreachable', async () => {
    const backend = new MockBackend();
    backend.reachable = false;

    const orchestrator = new Orchestrator(backend);
    const result = await orchestrator.runArchiveCycle({
      fromPath: '/tmp/mnt',
      files: ['a.mp4'],
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('archive_unreachable');
    expect(backend.connectCalls).toBe(0);
    expect(backend.archiveCalls).toBe(0);
    expect(backend.disconnectCalls).toBe(0);
  });

  it('always disconnects when archive operation throws', async () => {
    const backend = new MockBackend();
    backend.failArchive = true;

    const orchestrator = new Orchestrator(backend);

    await expect(
      orchestrator.runArchiveCycle({ fromPath: '/tmp/mnt', files: ['a.mp4'] }),
    ).rejects.toThrow('archive failed');

    expect(backend.connectCalls).toBe(1);
    expect(backend.disconnectCalls).toBe(1);
  });

  it('decides to create snapshot when interval elapsed', () => {
    const backend = new MockBackend();
    const orchestrator = new Orchestrator(backend);

    const result = orchestrator.evaluateMaintenance({
      lastSnapshotEpoch: 100,
      nowEpoch: 1000,
      freeBytes: 2 * 1024 * 1024 * 1024,
      totalBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(result.snapshot.shouldCreate).toBe(true);
  });

  it('flags cleanup when free space threshold is low', () => {
    const backend = new MockBackend();
    const orchestrator = new Orchestrator(backend);

    const result = orchestrator.evaluateMaintenance({
      lastSnapshotEpoch: null,
      nowEpoch: 1000,
      freeBytes: 50 * 1024 * 1024,
      totalBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(result.freeSpace.needsCleanup).toBe(true);
    expect(result.freeSpace.targetBytesToFree).toBeGreaterThan(0);
  });
});

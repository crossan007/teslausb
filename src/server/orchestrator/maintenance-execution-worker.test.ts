import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { FreeSpaceManager } from './free-space-manager';
import { MaintenanceExecutionWorker } from './maintenance-execution-worker';
import { SnapshotManager } from './snapshot/snapshot-manager';

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'teslausb-maintenance-test-'));
}

async function plainSnapshotCopy(sourcePath: string, destinationPath: string): Promise<void> {
  const content = await readFile(sourcePath);
  await writeFile(destinationPath, content);
}

describe('MaintenanceExecutionWorker', () => {
  it('creates native snapshots and skips until interval elapses', async () => {
    const workspace = await createTempWorkspace();
    const camDiskPath = join(workspace, 'backingfiles', 'cam_disk.bin');
    const snapshotRootPath = join(workspace, 'backingfiles', 'snapshots');

    try {
      await mkdir(join(workspace, 'backingfiles'), { recursive: true });
      await writeFile(camDiskPath, Buffer.alloc(1024));

      const worker = new MaintenanceExecutionWorker(
        new SnapshotManager(300, {
          camDiskPath,
          snapshotRootPath,
          snapshotCopier: plainSnapshotCopy,
          stateSink: {
            writeSnapshot: () => undefined,
          },
        }),
        new FreeSpaceManager(1, 1),
        {
          camDiskPath,
          nowEpochProvider: (() => {
            let now = 1_000;
            return () => {
              const current = now;
              now += 100;
              return current;
            };
          })(),
          diskUsageProvider: async () => ({
            freeBytes: 9 * 1024 * 1024 * 1024,
            totalBytes: 10 * 1024 * 1024 * 1024,
          }),
        },
      );

      const first = await worker.runCycle();
      const second = await worker.runCycle();
      const third = await worker.runCycle();

      expect(first.snapshot.executed).toBe(true);
      expect(second.snapshot.executed).toBe(false);
      expect(third.snapshot.executed).toBe(false);

      const firstSnapshot = await readFile(join(snapshotRootPath, 'snap-000000', 'snap.bin'));
      expect(firstSnapshot.length).toBe(1024);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('releases oldest snapshot and stale links when cleanup is needed', async () => {
    const workspace = await createTempWorkspace();
    const camDiskPath = join(workspace, 'backingfiles', 'cam_disk.bin');
    const snapshotRootPath = join(workspace, 'backingfiles', 'snapshots');
    const mutableTeslaCamPath = join(workspace, 'mutable', 'TeslaCam');

    try {
      await mkdir(join(snapshotRootPath, 'snap-000001'), { recursive: true });
      await mkdir(join(snapshotRootPath, 'snap-000002'), { recursive: true });
      await writeFile(join(snapshotRootPath, 'snap-000001', 'snap.bin'), Buffer.alloc(1));
      await writeFile(join(snapshotRootPath, 'snap-000002', 'snap.bin'), Buffer.alloc(1));
      await mkdir(join(workspace, 'backingfiles'), { recursive: true });
      await writeFile(camDiskPath, Buffer.alloc(1));

      const linkedDir = join(mutableTeslaCamPath, 'SavedClips', 'evt1');
      await mkdir(linkedDir, { recursive: true });
      await symlink(
        join(snapshotRootPath, 'snap-000001', 'mnt', 'TeslaCam', 'SavedClips', 'evt1', 'video.mp4'),
        join(linkedDir, 'video.mp4'),
      );

      const worker = new MaintenanceExecutionWorker(
        new SnapshotManager(10_000, {
          camDiskPath,
          snapshotRootPath,
          mutableTeslaCamPath,
          snapshotCopier: plainSnapshotCopy,
          stateSink: {
            writeSnapshot: () => undefined,
          },
        }),
        new FreeSpaceManager(50, 100),
        {
          camDiskPath,
          nowEpochProvider: () => 5_000,
          diskUsageProvider: (() => {
            let callCount = 0;
            return async () => {
              callCount += 1;
              if (callCount <= 2) {
                return { freeBytes: 100, totalBytes: 1000 };
              }
              return { freeBytes: 900, totalBytes: 1000 };
            };
          })(),
        },
      );

      const result = await worker.runCycle();

      expect(result.freeSpace.needsCleanup).toBe(true);
      expect(result.freeSpace.executed).toBe(true);

      await expect(readFile(join(snapshotRootPath, 'snap-000001', 'snap.bin'))).rejects.toThrow();
      await expect(readFile(join(snapshotRootPath, 'snap-000002', 'snap.bin'))).resolves.toBeDefined();
      await expect(readFile(join(linkedDir, 'video.mp4'))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns an error when low space remains with only one snapshot', async () => {
    const workspace = await createTempWorkspace();
    const camDiskPath = join(workspace, 'backingfiles', 'cam_disk.bin');
    const snapshotRootPath = join(workspace, 'backingfiles', 'snapshots');

    try {
      await mkdir(join(snapshotRootPath, 'snap-000001'), { recursive: true });
      await writeFile(join(snapshotRootPath, 'snap-000001', 'snap.bin'), Buffer.alloc(1));
      await mkdir(join(workspace, 'backingfiles'), { recursive: true });
      await writeFile(camDiskPath, Buffer.alloc(1));

      const worker = new MaintenanceExecutionWorker(
        new SnapshotManager(10_000, {
          camDiskPath,
          snapshotRootPath,
          snapshotCopier: plainSnapshotCopy,
          stateSink: {
            writeSnapshot: () => undefined,
          },
        }),
        new FreeSpaceManager(50, 1024),
        {
          camDiskPath,
          nowEpochProvider: () => 5_000,
          diskUsageProvider: async () => ({
            freeBytes: 100,
            totalBytes: 1000,
          }),
        },
      );

      const result = await worker.runCycle();
      expect(result.freeSpace.executed).toBe(false);
      expect(result.freeSpace.error).toBe('low_space_only_one_snapshot');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

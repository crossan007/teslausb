/**
 * Legacy lineage:
 * - run/archiveloop (snapshotloop + freespacemanager workers)
 * - run/make_snapshot.sh
 * - run/manage_free_space.sh
 */
import { constants } from 'fs';
import { copyFile, lstat, mkdir, readdir, readlink, rm, statfs, unlink } from 'fs/promises';
import { join } from 'path';
import { logger } from '../core/logger';
import { FreeSpaceDecision, FreeSpaceManager } from './free-space-manager';
import { SnapshotDecision, SnapshotManager } from './snapshot-manager';

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
}

type SnapshotCopier = (sourcePath: string, destinationPath: string) => Promise<void>;

export interface MaintenanceExecutionWorkerOptions {
  camDiskPath?: string;
  snapshotRootPath?: string;
  mutableTeslaCamPath?: string;
  diskUsageProvider?: () => Promise<DiskUsage>;
  nowEpochProvider?: () => number;
  snapshotCopier?: SnapshotCopier;
}

export interface MaintenanceExecutionResult {
  snapshot: SnapshotDecision & { executed: boolean; error?: string };
  freeSpace: FreeSpaceDecision & { executed: boolean; reserveBytes?: number; error?: string };
}

const DEFAULT_CAM_DISK_PATH = '/backingfiles/cam_disk.bin';
const DEFAULT_SNAPSHOT_ROOT = '/backingfiles/snapshots';
const DEFAULT_MUTABLE_TESLACAM_PATH = '/mutable/TeslaCam';

export class MaintenanceExecutionWorker {
  private lastSnapshotEpoch: number | null = null;
  private readonly camDiskPath: string;
  private readonly snapshotRootPath: string;
  private readonly mutableTeslaCamPath: string;
  private readonly diskUsageProvider: () => Promise<DiskUsage>;
  private readonly nowEpochProvider: () => number;
  private readonly snapshotCopier: SnapshotCopier;

  constructor(
    private readonly snapshotManager: SnapshotManager = new SnapshotManager(),
    private readonly freeSpaceManager: FreeSpaceManager = new FreeSpaceManager(),
    options: MaintenanceExecutionWorkerOptions = {},
  ) {
    this.camDiskPath = options.camDiskPath ?? DEFAULT_CAM_DISK_PATH;
    this.snapshotRootPath = options.snapshotRootPath ?? DEFAULT_SNAPSHOT_ROOT;
    this.mutableTeslaCamPath = options.mutableTeslaCamPath ?? DEFAULT_MUTABLE_TESLACAM_PATH;
    this.diskUsageProvider = options.diskUsageProvider ?? (() => this.readDiskUsage());
    this.nowEpochProvider = options.nowEpochProvider ?? (() => Math.floor(Date.now() / 1000));
    this.snapshotCopier = options.snapshotCopier ?? ((sourcePath, destinationPath) => this.copySnapshotReflink(sourcePath, destinationPath));
  }

  async runCycle(): Promise<MaintenanceExecutionResult> {
    const nowEpoch = this.nowEpochProvider();
    const usage = await this.diskUsageProvider();

    const snapshotDecision = this.snapshotManager.shouldCreateSnapshot(this.lastSnapshotEpoch, nowEpoch);
    const freeSpaceDecision = this.freeSpaceManager.evaluate(usage.freeBytes, usage.totalBytes);

    const result: MaintenanceExecutionResult = {
      snapshot: {
        ...snapshotDecision,
        executed: false,
      },
      freeSpace: {
        ...freeSpaceDecision,
        executed: false,
      },
    };

    if (snapshotDecision.shouldCreate) {
      try {
        await this.createSnapshot();
        this.lastSnapshotEpoch = nowEpoch;
        result.snapshot.executed = true;
      } catch (error) {
        result.snapshot.error = this.formatError(error, 'snapshot_execution_failed');
        logger.warn({ error }, 'Snapshot execution failed');
      }
    }

    if (freeSpaceDecision.needsCleanup) {
      const reserveBytes = Math.max(
        0,
        Math.floor(usage.freeBytes + freeSpaceDecision.targetBytesToFree),
      );
      result.freeSpace.reserveBytes = reserveBytes;

      try {
        await this.cleanupSnapshotsToReserve(reserveBytes);
        result.freeSpace.executed = true;
      } catch (error) {
        result.freeSpace.error = this.formatError(error, 'free_space_cleanup_failed');
        logger.warn({ error }, 'Free-space management execution failed');
      }
    }

    return result;
  }

  private async readDiskUsage(): Promise<DiskUsage> {
    const stats = await statfs(this.camDiskPath);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return { freeBytes, totalBytes };
  }

  private async createSnapshot(): Promise<void> {
    await mkdir(this.snapshotRootPath, { recursive: true });

    const snapshotDirs = await this.listSnapshotDirs();
    const highestExisting = snapshotDirs.length === 0
      ? -1
      : Math.max(...snapshotDirs.map((name) => this.snapshotNumber(name)));
    const nextNumber = highestExisting + 1;
    const snapshotName = this.snapshotName(nextNumber);
    const snapshotDir = join(this.snapshotRootPath, snapshotName);
    const snapshotPath = join(snapshotDir, 'snap.bin');

    await mkdir(snapshotDir, { recursive: true });

    await this.snapshotCopier(this.camDiskPath, snapshotPath);

    logger.info({ snapshotPath }, 'Snapshot created');
  }

  private async copySnapshotReflink(sourcePath: string, destinationPath: string): Promise<void> {
    try {
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`snapshot_copy_on_write_required: ${detail}`);
    }
  }

  private async cleanupSnapshotsToReserve(reserveBytes: number): Promise<void> {
    while (true) {
      const usage = await this.diskUsageProvider();
      if (usage.freeBytes > reserveBytes) {
        return;
      }

      const snapshotDirs = await this.listSnapshotDirs();
      if (snapshotDirs.length === 0) {
        throw new Error('low_space_no_snapshots');
      }

      if (snapshotDirs.length < 2) {
        throw new Error('low_space_only_one_snapshot');
      }

      const oldest = snapshotDirs[0];
      await this.releaseSnapshot(oldest);
    }
  }

  private async releaseSnapshot(snapshotName: string): Promise<void> {
    const snapshotDir = join(this.snapshotRootPath, snapshotName);
    await rm(snapshotDir, { recursive: true, force: true });
    await this.removeLinksReferencingSnapshot(snapshotName);
    logger.info({ snapshotName }, 'Released oldest snapshot during free-space cleanup');
  }

  private async removeLinksReferencingSnapshot(snapshotName: string): Promise<void> {
    const stack = [this.mutableTeslaCamPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absPath);
          continue;
        }

        if (!entry.isSymbolicLink()) {
          continue;
        }

        try {
          const target = await readlink(absPath);
          if (target.includes(`/${snapshotName}/`)) {
            await unlink(absPath).catch(() => undefined);
          }
        } catch {
          continue;
        }
      }
    }
  }

  private async listSnapshotDirs(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.snapshotRootPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!/^snap-\d{6}$/.test(entry.name)) {
        continue;
      }

      const snapshotPath = join(this.snapshotRootPath, entry.name, 'snap.bin');
      try {
        const stats = await lstat(snapshotPath);
        if (stats.isFile()) {
          candidates.push(entry.name);
        }
      } catch {
        continue;
      }
    }

    return candidates.sort();
  }

  private snapshotName(number: number): string {
    return `snap-${String(number).padStart(6, '0')}`;
  }

  private snapshotNumber(snapshotName: string): number {
    const value = Number(snapshotName.replace('snap-', ''));
    if (Number.isNaN(value)) {
      return -1;
    }
    return value;
  }

  private formatError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }
}

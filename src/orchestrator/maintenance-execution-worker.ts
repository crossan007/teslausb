/**
 * Legacy lineage:
 * - run/archiveloop (snapshotloop + freespacemanager workers)
 * - run/make_snapshot.sh
 * - run/manage_free_space.sh
 */
import { statfs } from 'fs/promises';
import { logger } from '../core/logger';
import { FreeSpaceDecision, FreeSpaceManager } from './free-space-manager';
import { SnapshotDecision, SnapshotManager } from './snapshot-manager';

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
}

export interface MaintenanceExecutionWorkerOptions {
  camDiskPath?: string;
  diskUsageProvider?: () => Promise<DiskUsage>;
  nowEpochProvider?: () => number;
}

export interface MaintenanceExecutionResult {
  snapshot: SnapshotDecision & { executed: boolean; error?: string };
  freeSpace: FreeSpaceDecision & { executed: boolean; reserveBytes?: number; error?: string };
}

const DEFAULT_CAM_DISK_PATH = '/backingfiles/cam_disk.bin';

export class MaintenanceExecutionWorker {
  private lastSnapshotEpoch: number | null = null;
  private readonly camDiskPath: string;
  private readonly diskUsageProvider: () => Promise<DiskUsage>;
  private readonly nowEpochProvider: () => number;

  constructor(
    private readonly snapshotManager: SnapshotManager = new SnapshotManager(),
    private readonly freeSpaceManager: FreeSpaceManager = new FreeSpaceManager(),
    options: MaintenanceExecutionWorkerOptions = {},
  ) {
    this.camDiskPath = options.camDiskPath ?? DEFAULT_CAM_DISK_PATH;
    this.diskUsageProvider = options.diskUsageProvider ?? (() => this.readDiskUsage());
    this.nowEpochProvider = options.nowEpochProvider ?? (() => Math.floor(Date.now() / 1000));
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
        await this.snapshotManager.createSnapshot();
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

  private async cleanupSnapshotsToReserve(reserveBytes: number): Promise<void> {
    while (true) {
      const usage = await this.diskUsageProvider();
      if (usage.freeBytes > reserveBytes) {
        return;
      }

      const snapshotIds = await this.snapshotManager.listSnapshotIds();
      if (snapshotIds.length === 0) {
        throw new Error('low_space_no_snapshots');
      }

      if (snapshotIds.length < 2) {
        throw new Error('low_space_only_one_snapshot');
      }

      await this.snapshotManager.releaseSnapshot(snapshotIds[0]);
    }
  }

  private formatError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }
}

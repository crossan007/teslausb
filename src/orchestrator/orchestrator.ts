/**
 * Legacy lineage:
 * - run/archiveloop (archive lifecycle loop: verify/reachability/connect/archive/disconnect)
 */
import { ArchiveBackend, DefaultSyncStatus, OperationResult, SyncStatus, TransferSession } from '../types';
import { logger } from '../core/logger';
import { SnapshotDecision, SnapshotManager } from './snapshot-manager';
import { FreeSpaceDecision, FreeSpaceManager } from './free-space-manager';

export interface SyncCycleInput {
  fromPath: string;
  files: string[];
}

export interface SyncCycleResult {
  skipped: boolean;
  reason?: string;
  archived: number;
  failed: number;
}

export interface MaintenanceInput {
  lastSnapshotEpoch: number | null;
  nowEpoch: number;
  freeBytes: number;
  totalBytes: number;
}

export interface MaintenanceResult {
  snapshot: SnapshotDecision;
  freeSpace: FreeSpaceDecision;
}

export interface StateSink {
  writeSyncStatus(status: SyncStatus): void;
  writeOperationResult(operation: string, result: OperationResult<SyncCycleResult>): void;
  writeTransferSession?(session: TransferSession): void;
}

export class Orchestrator {
  constructor(
    private readonly backend: ArchiveBackend,
    private readonly snapshotManager: SnapshotManager = new SnapshotManager(),
    private readonly freeSpaceManager: FreeSpaceManager = new FreeSpaceManager(),
    private readonly stateSink?: StateSink,
  ) {}

  async runArchiveCycle(input: SyncCycleInput): Promise<SyncCycleResult> {
    const startedAt = Date.now();
    const startEpoch = Math.floor(startedAt / 1000);

    await this.backend.verify();

    const reachable = await this.backend.isReachable();
    if (!reachable) {
      const skipped: SyncCycleResult = {
        skipped: true,
        reason: 'archive_unreachable',
        archived: 0,
        failed: 0,
      };
      this.recordCycle('waiting', startEpoch, startedAt, skipped, true);
      return skipped;
    }

    let cycleResult: SyncCycleResult = {
      skipped: false,
      archived: 0,
      failed: 0,
    };

    this.writeStatus({
      ...DefaultSyncStatus,
      state: 'archiving',
      queueFiles: input.files.length,
      lastStartEpoch: startEpoch,
    });

    try {
      await this.backend.connect();

      const result = await this.backend.archiveClips(input.fromPath, input.files, {
        onProgress: (session) => {
          this.stateSink?.writeTransferSession?.(session);
        },
      });
      cycleResult = {
        skipped: false,
        archived: result.archived,
        failed: result.failed,
      };

      this.recordCycle('idle', startEpoch, startedAt, cycleResult, result.failed === 0);
      return cycleResult;
    } catch (error) {
      logger.error({ error }, 'Archive cycle failed');
      cycleResult = {
        skipped: false,
        archived: 0,
        failed: input.files.length,
      };
      this.recordCycle('idle', startEpoch, startedAt, cycleResult, false);
      throw error;
    } finally {
      await this.backend.disconnect();
    }
  }

  evaluateMaintenance(input: MaintenanceInput): MaintenanceResult {
    return {
      snapshot: this.snapshotManager.shouldCreateSnapshot(input.lastSnapshotEpoch, input.nowEpoch),
      freeSpace: this.freeSpaceManager.evaluate(input.freeBytes, input.totalBytes),
    };
  }

  private recordCycle(
    state: SyncStatus['state'],
    startEpoch: number,
    startedAtMs: number,
    result: SyncCycleResult,
    success: boolean,
  ): void {
    const endedAt = Date.now();
    const endEpoch = Math.floor(endedAt / 1000);

    this.writeStatus({
      ...DefaultSyncStatus,
      state,
      queueFiles: 0,
      lastStartEpoch: startEpoch,
      lastEndEpoch: endEpoch,
      lastDurationSec: Math.max(Math.floor((endedAt - startedAtMs) / 1000), 0),
      lastResult: success ? 'success' : 'error',
    });

    this.stateSink?.writeOperationResult('archive_cycle', {
      success,
      data: result,
      durationMs: endedAt - startedAtMs,
      error: success ? undefined : 'archive_cycle_failed',
    });
  }

  private writeStatus(status: SyncStatus): void {
    this.stateSink?.writeSyncStatus(status);
  }
}

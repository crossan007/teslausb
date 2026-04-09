/**
 * Legacy lineage:
 * - run/archiveloop (archive lifecycle loop: verify/reachability/connect/archive/disconnect)
 */
import { ArchiveBackend, DefaultSyncStatus, OperationResult, SyncStatus, TransferFileProgress, TransferSession } from '../../types';
import { logger } from '../core/logger';
import { SnapshotDecision, SnapshotManager } from './snapshot/snapshot-manager';
import { FreeSpaceDecision, FreeSpaceManager } from './free-space-manager';

const DEFAULT_PROGRESS_LOG_INCREMENT_PERCENT = 25;

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
}

export interface ClipArchiveCoordinatorOptions {
  progressLogIncrementPercent?: number;
}

/**
 * Coordinates one archive transfer cycle for discovered clip files.
 */
export class ClipArchiveCoordinator {
  private readonly progressLogIncrementPercent: number;

  constructor(
    private readonly backend: ArchiveBackend,
    private readonly snapshotManager: SnapshotManager = new SnapshotManager(),
    private readonly freeSpaceManager: FreeSpaceManager = new FreeSpaceManager(),
    private readonly stateSink?: StateSink,
    options: ClipArchiveCoordinatorOptions = {},
  ) {
    this.progressLogIncrementPercent = this.normalizeProgressIncrement(options.progressLogIncrementPercent);
  }

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

      const transfer = this.backend.archiveClips(input.fromPath, input.files);
      const transferLogger = this.createTransferLogger();
      const subscription = transfer.session$.subscribe((session: TransferSession) => {
        transferLogger(session);
      });

      try {
        const result = await transfer.result;
        cycleResult = {
          skipped: false,
          archived: result.archived,
          failed: result.failed,
        };

        this.recordCycle('idle', startEpoch, startedAt, cycleResult, result.failed === 0);
        return cycleResult;
      } finally {
        subscription.unsubscribe();
      }
    } catch (error) {
      logger.error({ err: error }, 'Archive cycle failed');
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

  private createTransferLogger(): (session: TransferSession) => void {
    const startedFiles = new Set<string>();
    const completedFiles = new Set<string>();
    const failedFiles = new Set<string>();
    const loggedPercentByFile = new Map<string, number>();

    return (session: TransferSession): void => {
      for (const file of session.files) {
        this.logFileTransferStarted(file, session, startedFiles);
        this.logFileTransferProgress(file, session, loggedPercentByFile);
        this.logFileTransferCompleted(file, session, completedFiles);
        this.logFileTransferFailed(file, session, failedFiles);
      }
    };
  }

  private logFileTransferStarted(
    file: TransferFileProgress,
    session: TransferSession,
    startedFiles: Set<string>,
  ): void {
    if (file.status !== 'transferring' || startedFiles.has(file.path)) {
      return;
    }

    startedFiles.add(file.path);
    logger.info(
      {
        sessionId: session.sessionId,
        backend: session.backend,
        filePath: file.path,
      },
      'File transfer started',
    );
  }

  private logFileTransferProgress(
    file: TransferFileProgress,
    session: TransferSession,
    loggedPercentByFile: Map<string, number>,
  ): void {
    if (file.status !== 'transferring' && file.status !== 'completed') {
      return;
    }

    const currentPercent = Math.floor(file.percent ?? 0);
    if (currentPercent <= 0) {
      return;
    }

    const milestone = Math.min(
      100,
      Math.floor(currentPercent / this.progressLogIncrementPercent) * this.progressLogIncrementPercent,
    );
    if (milestone <= 0) {
      return;
    }

    const lastLogged = loggedPercentByFile.get(file.path) ?? 0;
    if (milestone <= lastLogged) {
      return;
    }

    loggedPercentByFile.set(file.path, milestone);
    logger.info(
      {
        sessionId: session.sessionId,
        backend: session.backend,
        filePath: file.path,
        percent: milestone,
        bytesTransferred: file.bytesTransferred,
        speedBytesPerSec: file.speedBytesPerSec,
        etaSeconds: file.etaSeconds,
      },
      'File transfer progress',
    );
  }

  private logFileTransferCompleted(
    file: TransferFileProgress,
    session: TransferSession,
    completedFiles: Set<string>,
  ): void {
    if (file.status !== 'completed' || completedFiles.has(file.path)) {
      return;
    }

    completedFiles.add(file.path);
    logger.info(
      {
        sessionId: session.sessionId,
        backend: session.backend,
        filePath: file.path,
        bytesTransferred: file.bytesTransferred,
      },
      'File transfer completed',
    );
  }

  private logFileTransferFailed(
    file: TransferFileProgress,
    session: TransferSession,
    failedFiles: Set<string>,
  ): void {
    if (file.status !== 'failed' || failedFiles.has(file.path)) {
      return;
    }

    failedFiles.add(file.path);
    logger.warn(
      {
        sessionId: session.sessionId,
        backend: session.backend,
        filePath: file.path,
        error: file.error,
      },
      'File transfer failed',
    );
  }

  private normalizeProgressIncrement(value?: number): number {
    const normalized = Math.floor(value ?? DEFAULT_PROGRESS_LOG_INCREMENT_PERCENT);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      return DEFAULT_PROGRESS_LOG_INCREMENT_PERCENT;
    }
    return normalized;
  }
}

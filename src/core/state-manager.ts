import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from './logger';
import { SyncStatus, Snapshot, PendingClips, OperationResult } from '../types';
import { ensureDir } from '../shared';

/**
 * Type-safe filesystem-backed state manager for TeslaUSB.
 * Wraps state files in /mutable/ with proper error handling and logging.
 */
export class StateManager {
  constructor(private readonly baseDir: string = '/mutable') {}

  private statePath(fileName: string): string {
    return `${this.baseDir}/${fileName}`;
  }

  /**
   * Read sync status from /mutable/sync_status.
   */
  readSyncStatus(): SyncStatus | null {
    try {
      const path = this.statePath('sync_status');
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      return this.validateSyncStatus(data);
    } catch (error) {
      logger.warn({ error }, 'Failed to read sync status');
      return null;
    }
  }

  /**
   * Write sync status to /mutable/sync_status.
   */
  writeSyncStatus(status: SyncStatus): void {
    try {
      const path = this.statePath('sync_status');
      ensureDir(dirname(path));
      writeFileSync(path, JSON.stringify(status, null, 2), 'utf-8');
      logger.debug({ status }, 'Sync status written');
    } catch (error) {
      logger.error({ error, status }, 'Failed to write sync status');
      throw error;
    }
  }

  /**
   * Read current snapshot status.
   */
  readSnapshot(): Snapshot | null {
    try {
      const path = this.statePath('snapshot');
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      return this.validateSnapshot(data);
    } catch (error) {
      logger.warn({ error }, 'Failed to read snapshot');
      return null;
    }
  }

  /**
   * Write snapshot status.
   */
  writeSnapshot(snapshot: Snapshot): void {
    try {
      const path = this.statePath('snapshot');
      ensureDir(dirname(path));
      writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf-8');
      logger.debug({ snapshot }, 'Snapshot written');
    } catch (error) {
      logger.error({ error, snapshot }, 'Failed to write snapshot');
      throw error;
    }
  }

  /**
   * Read pending clips queue.
   */
  readPendingClips(): PendingClips | null {
    try {
      const path = this.statePath('pending_clips');
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      return this.validatePendingClips(data);
    } catch (error) {
      logger.warn({ error }, 'Failed to read pending clips');
      return null;
    }
  }

  /**
   * Write pending clips queue.
   */
  writePendingClips(clips: PendingClips): void {
    try {
      const path = this.statePath('pending_clips');
      ensureDir(dirname(path));
      writeFileSync(path, JSON.stringify(clips, null, 2), 'utf-8');
      logger.debug({ clipCount: clips.files.length }, 'Pending clips written');
    } catch (error) {
      logger.error({ error }, 'Failed to write pending clips');
      throw error;
    }
  }

  /**
   * Record an operation result (success/failure) for audit + recovery.
   */
  writeOperationResult(operation: string, result: OperationResult<any>): void {
    try {
      const auditPath = this.statePath(`audit/${operation}.json`);
      ensureDir(dirname(auditPath));
      writeFileSync(auditPath, JSON.stringify(result, null, 2), 'utf-8');
      logger.debug({ operation, success: result.success }, 'Operation result recorded');
    } catch (error) {
      logger.warn({ error, operation }, 'Failed to record operation result');
    }
  }

  /**
   * Internal: validate SyncStatus shape at runtime.
   */
  private validateSyncStatus(data: any): SyncStatus {
    if (
      typeof data !== 'object'
      || !('state' in data)
      || !('queueFiles' in data)
    ) {
      throw new Error('Invalid SyncStatus format');
    }
    return {
      state: data.state || 'idle',
      queueFiles: data.queueFiles || 0,
      queueEvents: data.queueEvents || 0,
      queueOldestAgeSec: data.queueOldestAgeSec || 0,
      lastStartEpoch: data.lastStartEpoch || 0,
      lastEndEpoch: data.lastEndEpoch || 0,
      lastDurationSec: data.lastDurationSec || 0,
      lastResult: data.lastResult || 'never',
    };
  }

  /**
   * Internal: validate Snapshot shape at runtime.
   */
  private validateSnapshot(data: any): Snapshot {
    if (typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') {
      throw new Error('Invalid Snapshot format');
    }
    return {
      id: data.id,
      createdAt: data.createdAt || 0,
      filePath: data.filePath || '',
      tocPath: data.tocPath || '',
      size: data.size || 0,
      isLinked: data.isLinked || false,
    };
  }

  /**
   * Internal: validate PendingClips shape at runtime.
   */
  private validatePendingClips(data: any): PendingClips {
    if (typeof data !== 'object' || !Array.isArray(data.files)) {
      throw new Error('Invalid PendingClips format');
    }
    return {
      totalFiles: data.totalFiles || 0,
      totalEvents: data.totalEvents || 0,
      oldestAgeSec: data.oldestAgeSec || 0,
      files: data.files || [],
    };
  }
}

export const stateManager = new StateManager();

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from './logger';
import {
  SyncStatus,
  Snapshot,
  PendingClips,
  OperationResult,
  SyncStatusSchema,
  SnapshotSchema,
  PendingClipsSchema,
} from '../types';
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
      const parsed = SyncStatusSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Invalid SyncStatus format');
        return null;
      }
      return parsed.data;
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
      const parsed = SnapshotSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Invalid Snapshot format');
        return null;
      }
      return parsed.data;
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
      const parsed = PendingClipsSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Invalid PendingClips format');
        return null;
      }
      return parsed.data;
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

}

export const stateManager = new StateManager();

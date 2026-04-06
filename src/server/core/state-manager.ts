/**
 * Legacy lineage:
 * - run/archiveloop (/mutable/sync_status and runtime state updates)
 * - run/make_snapshot.sh and run/release_snapshot.sh (snapshot metadata/state)
 * - teslausb-www/html/cgi-bin/status.sh (consumption of state files for status output)
 */
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
  TransferSession,
  TransferSessionSchema,
  ClipRegistry,
  ClipRegistrySchema,
} from '../../types';
import { ensureDir } from '../shared';

/**
 * Type-safe filesystem-backed state manager for TeslaUSB.
 * Wraps state files in /mutable/ with proper error handling and logging.
 */
export class StateManager {
  /** Legacy shell-compatible sync status file consumed by CGI status endpoint. */
  private static readonly LegacySyncStatusFile = 'sync_status';
  /** JSON sidecar for typed TS consumers during transition away from CGI. */
  private static readonly JsonSyncStatusFile = 'sync_status.json';

  constructor(private readonly baseDir: string = '/mutable') {}

  private statePath(fileName: string): string {
    return `${this.baseDir}/${fileName}`;
  }

  /**
   * Reads sync status, preferring JSON sidecar and falling back to legacy shell format.
   */
  readSyncStatus(): SyncStatus | null {
    const jsonPath = this.statePath(StateManager.JsonSyncStatusFile);
    if (existsSync(jsonPath)) {
      const parsedJson = this.readSyncStatusJson(jsonPath);
      if (parsedJson) {
        return parsedJson;
      }
    }

    const legacyPath = this.statePath(StateManager.LegacySyncStatusFile);
    if (!existsSync(legacyPath)) {
      return null;
    }

    const parsedLegacy = this.readSyncStatusLegacy(legacyPath);
    if (parsedLegacy) {
      return parsedLegacy;
    }

    return this.readSyncStatusJson(legacyPath);
  }

  /**
   * Reads sync status from a JSON file and validates schema.
   */
  private readSyncStatusJson(path: string): SyncStatus | null {
    try {
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      const parsed = SyncStatusSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Invalid SyncStatus format');
        return null;
      }
      return parsed.data;
    } catch (error) {
      logger.warn({ err: error, path }, 'Failed to read sync status JSON');
      return null;
    }
  }

  /**
   * Reads sync status from legacy shell-style key/value file.
   */
  private readSyncStatusLegacy(path: string): SyncStatus | null {
    try {
      const content = readFileSync(path, 'utf-8');
      const values = new Map<string, string>();

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        const equals = trimmed.indexOf('=');
        if (equals <= 0) {
          continue;
        }

        const key = trimmed.slice(0, equals);
        const value = trimmed.slice(equals + 1);
        values.set(key, value);
      }

      if (values.size === 0 || !values.has('SYNC_STATE')) {
        return null;
      }

      const status: SyncStatus = {
        state: this.parseState(values.get('SYNC_STATE')),
        queueFiles: this.parseNumber(values.get('SYNC_QUEUE_FILES')),
        queueEvents: this.parseNumber(values.get('SYNC_QUEUE_EVENTS')),
        queueOldestAgeSec: this.parseNumber(values.get('SYNC_QUEUE_OLDEST_AGE_SEC')),
        lastStartEpoch: this.parseNumber(values.get('SYNC_LAST_START_EPOCH')),
        lastEndEpoch: this.parseNumber(values.get('SYNC_LAST_END_EPOCH')),
        lastDurationSec: this.parseNumber(values.get('SYNC_LAST_DURATION_SEC')),
        lastResult: this.parseResult(values.get('SYNC_LAST_RESULT')),
      };

      const parsed = SyncStatusSchema.safeParse(status);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues, path }, 'Invalid legacy SyncStatus format');
        return null;
      }
      return parsed.data;
    } catch (error) {
      logger.warn({ err: error, path }, 'Failed to read legacy sync status');
      return null;
    }
  }

  /**
   * Writes sync status for both legacy CGI consumers and TS JSON consumers.
   *
   * Compatibility shim: remove legacy shell output once frontend no longer sources
   * /mutable/sync_status from CGI scripts.
   */
  writeSyncStatus(status: SyncStatus): void {
    try {
      const legacyPath = this.statePath(StateManager.LegacySyncStatusFile);
      const jsonPath = this.statePath(StateManager.JsonSyncStatusFile);

      ensureDir(dirname(legacyPath));

      writeFileSync(legacyPath, this.toLegacySyncStatus(status), 'utf-8');
      writeFileSync(jsonPath, JSON.stringify(status, null, 2), 'utf-8');
      logger.debug({ status }, 'Sync status written');
    } catch (error) {
      logger.error({ err: error, status }, 'Failed to write sync status');
      throw error;
    }
  }

  /**
   * Converts sync status to legacy shell-style variables for CGI compatibility.
   */
  private toLegacySyncStatus(status: SyncStatus): string {
    return [
      `SYNC_STATE=${status.state}`,
      `SYNC_QUEUE_FILES=${status.queueFiles}`,
      `SYNC_QUEUE_EVENTS=${status.queueEvents}`,
      `SYNC_QUEUE_OLDEST_AGE_SEC=${status.queueOldestAgeSec}`,
      `SYNC_LAST_START_EPOCH=${status.lastStartEpoch}`,
      `SYNC_LAST_END_EPOCH=${status.lastEndEpoch}`,
      `SYNC_LAST_DURATION_SEC=${status.lastDurationSec}`,
      `SYNC_LAST_RESULT=${status.lastResult}`,
      '',
    ].join('\n');
  }

  /**
   * Parses a number-like string, returning 0 on invalid or missing values.
   */
  private parseNumber(raw: string | undefined): number {
    const value = Number(raw ?? '0');
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  }

  /**
   * Parses legacy SYNC_STATE values into typed sync states.
   */
  private parseState(raw: string | undefined): SyncStatus['state'] {
    if (raw === 'archiving' || raw === 'waiting' || raw === 'idle') {
      return raw;
    }
    return 'idle';
  }

  /**
   * Parses legacy SYNC_LAST_RESULT values into typed result states.
   */
  private parseResult(raw: string | undefined): SyncStatus['lastResult'] {
    if (raw === 'success' || raw === 'error' || raw === 'never') {
      return raw;
    }
    return 'never';
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
      logger.error({ err: error, snapshot }, 'Failed to write snapshot');
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
   * Read current transfer session progress.
   */
  readTransferSession(): TransferSession | null {
    try {
      const path = this.statePath('transfer_session');
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      const parsed = TransferSessionSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Invalid TransferSession format');
        return null;
      }
      return parsed.data;
    } catch (error) {
      logger.warn({ error }, 'Failed to read transfer session');
      return null;
    }
  }

  /**
   * Write current transfer session progress.
   */
  writeTransferSession(session: TransferSession): void {
    try {
      const path = this.statePath('transfer_session');
      ensureDir(dirname(path));
      writeFileSync(path, JSON.stringify(session, null, 2), 'utf-8');
      logger.debug({ sessionId: session.sessionId, phase: session.phase }, 'Transfer session written');
    } catch (error) {
      logger.error({ err: error, sessionId: session.sessionId }, 'Failed to write transfer session');
      throw error;
    }
  }

  /**
   * Read clip registry source-of-truth.
   */
  readClipRegistry(): ClipRegistry | null {
    try {
      const path = this.statePath('clip_registry');
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      const parsed = ClipRegistrySchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Invalid ClipRegistry format');
        return null;
      }
      return parsed.data;
    } catch (error) {
      logger.warn({ error }, 'Failed to read clip registry');
      return null;
    }
  }

  /**
   * Write clip registry source-of-truth.
   */
  writeClipRegistry(registry: ClipRegistry): void {
    try {
      const path = this.statePath('clip_registry');
      ensureDir(dirname(path));
      writeFileSync(path, JSON.stringify(registry, null, 2), 'utf-8');
      logger.debug({ entries: registry.entries.length }, 'Clip registry written');
    } catch (error) {
      logger.error({ err: error }, 'Failed to write clip registry');
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
      logger.warn({ err: error, operation }, 'Failed to record operation result');
    }
  }

}

export const stateManager = new StateManager();

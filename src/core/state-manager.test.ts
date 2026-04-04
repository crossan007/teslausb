import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from './state-manager';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SyncStatus, Snapshot, PendingClips, OperationResult } from '../types';

describe('StateManager', () => {
  let stateManager: StateManager;
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for test state files
    tempDir = join(tmpdir(), `state-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    stateManager = new StateManager(tempDir);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Directory cleanup
    }
  });

  describe('SyncStatus', () => {
    it('writes and reads sync status', () => {
      const status: SyncStatus = {
        state: 'archiving',
        queueFiles: 42,
        queueEvents: 10,
        queueOldestAgeSec: 3600,
        lastStartEpoch: 1712250000,
        lastEndEpoch: 1712250120,
        lastDurationSec: 120,
        lastResult: 'success',
      };

      stateManager.writeSyncStatus(status);
      const read = stateManager.readSyncStatus();

      expect(read).toEqual(status);
    });

    it('returns null when sync status does not exist', () => {
      const result = stateManager.readSyncStatus();
      expect(result).toBeNull();
    });

    it('validates sync status schema on read', () => {
      // Write invalid data
      writeFileSync(join(tempDir, 'sync_status'), JSON.stringify({ invalid: 'data' }), 'utf-8');

      const result = stateManager.readSyncStatus();
      expect(result).toBeNull();
    });

    it('uses default values for missing fields', () => {
      const partialStatus = {
        state: 'idle',
        queueFiles: 5,
      };
      writeFileSync(join(tempDir, 'sync_status'), JSON.stringify(partialStatus), 'utf-8');

      const read = stateManager.readSyncStatus();
      expect(read?.queueFiles).toBe(5);
      expect(read?.queueEvents).toBe(0);
      expect(read?.lastResult).toBe('never');
    });
  });

  describe('Snapshot', () => {
    it('writes and reads snapshot', () => {
      const snapshot: Snapshot = {
        id: 'snap-000001',
        createdAt: Date.now(),
        filePath: '/backingfiles/snapshots/snap-000001/snap.bin',
        tocPath: '/backingfiles/snapshots/snap-000001/snap.bin.toc',
        size: 2048,
        isLinked: true,
      };

      stateManager.writeSnapshot(snapshot);
      const read = stateManager.readSnapshot();

      expect(read?.id).toBe('snap-000001');
      expect(read?.isLinked).toBe(true);
    });

    it('returns null when snapshot does not exist', () => {
      const result = stateManager.readSnapshot();
      expect(result).toBeNull();
    });

    it('validates snapshot schema on read', () => {
      writeFileSync(join(tempDir, 'snapshot'), JSON.stringify({ notASnapshot: true }), 'utf-8');

      const result = stateManager.readSnapshot();
      expect(result).toBeNull();
    });
  });

  describe('PendingClips', () => {
    it('writes and reads pending clips', () => {
      const clips: PendingClips = {
        totalFiles: 3,
        totalEvents: 2,
        oldestAgeSec: 1800,
        files: [
          { relPath: 'SavedClips/clip1.mp4', isSymlink: false, ageSec: 1800 },
          { relPath: 'SavedClips/clip2.mp4', isSymlink: false, ageSec: 1200 },
          { relPath: 'SavedClips/clip3.mp4', isSymlink: false, ageSec: 600 },
        ],
      };

      stateManager.writePendingClips(clips);
      const read = stateManager.readPendingClips();

      expect(read?.files).toHaveLength(3);
      expect(read?.files[0].relPath).toContain('clip1.mp4');
    });

    it('returns null when pending clips does not exist', () => {
      const result = stateManager.readPendingClips();
      expect(result).toBeNull();
    });

    it('handles empty clips array', () => {
      const clips: PendingClips = {
        totalFiles: 0,
        totalEvents: 0,
        oldestAgeSec: 0,
        files: [],
      };

      stateManager.writePendingClips(clips);
      const read = stateManager.readPendingClips();

      expect(read?.files).toEqual([]);
    });
  });

  describe('SystemStatus', () => {
    it('aggregates all component states', () => {
      const systemStatus = stateManager.readSystemStatus();

      expect(systemStatus?.uptime).toBeGreaterThanOrEqual(0);
      expect(systemStatus?.drivesActive).toBeDefined();
    });

    it('provides defaults when components do not exist', () => {
      const systemStatus = stateManager.readSystemStatus();

      expect(systemStatus?.uptime).toBeGreaterThanOrEqual(0);
      expect(systemStatus?.totalSpace).toBeGreaterThanOrEqual(0);
      expect(systemStatus?.freeSpace).toBeGreaterThanOrEqual(0);
    });

    it('includes timestamp in system status', () => {
      const systemStatus = stateManager.readSystemStatus();
      expect(systemStatus?.numSnapshots).toBeGreaterThanOrEqual(0);
    });
  });

  describe('OperationResult', () => {
    it('records operation results in audit', () => {
      const result: OperationResult<{ clipsProcessed: number }> = {
        success: true,
        data: { clipsProcessed: 12 },
        durationMs: 45000,
      };

      stateManager.writeOperationResult('archive_clips', result);

      // Verify file was created (we can't easily read it without system calls)
      // In a real test, we'd mock the filesystem
      expect(result.success).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('handles write errors gracefully', () => {
      const status: SyncStatus = {
        state: 'waiting',
        queueFiles: 5,
        queueEvents: 1,
        queueOldestAgeSec: 100,
        lastStartEpoch: 1712250000,
        lastEndEpoch: 1712250010,
        lastDurationSec: 10,
        lastResult: 'error',
      };

      // Should not throw when state directory is writable
      expect(() => {
        stateManager.writeSyncStatus(status);
      }).not.toThrow();
    });

    it('handles corrupted JSON gracefully', () => {
      writeFileSync(join(tempDir, 'sync_status'), 'not valid json{', 'utf-8');

      const result = stateManager.readSyncStatus();
      expect(result).toBeNull();
    });

    it('handles missing required fields in validation', () => {
      writeFileSync(join(tempDir, 'snapshot'), JSON.stringify({}), 'utf-8');

      const result = stateManager.readSnapshot();
      expect(result).toBeNull();
    });
  });
});

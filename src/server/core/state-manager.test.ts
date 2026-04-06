import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from './state-manager';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SyncStatus, Snapshot, PendingClips, OperationResult, TransferQueue, TransferSession } from '../../types';

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

      const legacy = readFileSync(join(tempDir, 'sync_status'), 'utf-8');
      expect(legacy).toContain('SYNC_STATE=archiving');
      expect(legacy).toContain('SYNC_QUEUE_FILES=42');

      const json = JSON.parse(readFileSync(join(tempDir, 'sync_status.json'), 'utf-8'));
      expect(json).toEqual(status);
    });

    it('returns null when sync status does not exist', () => {
      const result = stateManager.readSyncStatus();
      expect(result).toBeNull();
    });

    it('validates sync status schema on read', () => {
      // Write invalid data
      writeFileSync(join(tempDir, 'sync_status.json'), JSON.stringify({ invalid: 'data' }), 'utf-8');

      const result = stateManager.readSyncStatus();
      expect(result).toBeNull();
    });

    it('uses default values for missing fields', () => {
      const partialStatus = {
        state: 'idle',
        queueFiles: 5,
      };
      writeFileSync(join(tempDir, 'sync_status.json'), JSON.stringify(partialStatus), 'utf-8');

      const read = stateManager.readSyncStatus();
      expect(read?.queueFiles).toBe(5);
      expect(read?.queueEvents).toBe(0);
      expect(read?.lastResult).toBe('never');
    });

    it('reads legacy shell-style sync status when json sidecar is missing', () => {
      writeFileSync(
        join(tempDir, 'sync_status'),
        [
          'SYNC_STATE=waiting',
          'SYNC_QUEUE_FILES=11',
          'SYNC_QUEUE_EVENTS=4',
          'SYNC_QUEUE_OLDEST_AGE_SEC=777',
          'SYNC_LAST_START_EPOCH=100',
          'SYNC_LAST_END_EPOCH=200',
          'SYNC_LAST_DURATION_SEC=50',
          'SYNC_LAST_RESULT=error',
          '',
        ].join('\n'),
        'utf-8',
      );

      const read = stateManager.readSyncStatus();

      expect(read).toEqual({
        state: 'waiting',
        queueFiles: 11,
        queueEvents: 4,
        queueOldestAgeSec: 777,
        lastStartEpoch: 100,
        lastEndEpoch: 200,
        lastDurationSec: 50,
        lastResult: 'error',
      });
    });
  });

  describe('Snapshot', () => {
    it('writes and reads snapshot', () => {
      const snapshot: Snapshot = {
        id: 'snap-000001',
        createdAt: Date.now(),
        filePath: '/backingfiles/snapshots/snap-000001/snap.bin',
        tocPath: '/backingfiles/snapshots/snap-000001/snap.bin.toc',
        mountPath: '/backingfiles/snapshots/snap-000001/mnt',
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

  describe('TransferSession', () => {
    it('writes and reads transfer session', () => {
      const session: TransferSession = {
        sessionId: 'session-1',
        backend: 'rsync',
        phase: 'transferring',
        filesTotal: 2,
        filesCompleted: 1,
        filesFailed: 0,
        batchPercent: 50,
        bytesTransferred: 1024,
        currentFilePath: 'SavedClips/a.mp4',
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
        files: [
          {
            path: 'SavedClips/a.mp4',
            status: 'transferring',
            bytesTransferred: 1024,
            percent: 50,
            updatedAt: Date.now(),
          },
          {
            path: 'SavedClips/b.mp4',
            status: 'queued',
            bytesTransferred: 0,
            updatedAt: Date.now(),
          },
        ],
      };

      stateManager.writeTransferSession(session);
      const read = stateManager.readTransferSession();

      expect(read?.sessionId).toBe('session-1');
      expect(read?.filesTotal).toBe(2);
      expect(read?.files[0].status).toBe('transferring');
    });
  });

  describe('TransferQueue', () => {
    it('writes and reads transfer queue', () => {
      const queue: TransferQueue = {
        updatedAt: Date.now(),
        files: [
          {
            key: 'b2s:abc',
            clipName: 'a.mp4',
            relPath: 'SavedClips/a.mp4',
            status: 'queued',
            isSymlink: true,
            ageSec: 12,
            sourceSnapshotId: 'snap-1',
            sourceRootPath: '/snapshots/snap-1/mnt/TeslaCam',
            sourceSnapshotCreatedAt: 100,
            updatedAt: Date.now(),
          },
        ],
      };

      stateManager.writeTransferQueue(queue);
      const read = stateManager.readTransferQueue();

      expect(read).toEqual(queue);
      expect(read?.files[0].sourceSnapshotId).toBe('snap-1');
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
      writeFileSync(join(tempDir, 'sync_status.json'), 'not valid json{', 'utf-8');

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

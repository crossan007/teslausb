/**
 * Sync status represents the current state of the archiveloop sync operation.
 * Written to /mutable/sync_status by the orchestrator.
 */
export interface SyncStatus {
  state: 'idle' | 'archiving' | 'waiting';
  queueFiles: number;
  queueEvents: number;
  queueOldestAgeSec: number;
  lastStartEpoch: number;
  lastEndEpoch: number;
  lastDurationSec: number;
  lastResult: 'never' | 'success' | 'error';
}

export const DefaultSyncStatus: SyncStatus = {
  state: 'idle',
  queueFiles: 0,
  queueEvents: 0,
  queueOldestAgeSec: 0,
  lastStartEpoch: 0,
  lastEndEpoch: 0,
  lastDurationSec: 0,
  lastResult: 'never',
};

/**
 * Snapshot metadata
 */
export interface Snapshot {
  id: string; // e.g., "snap-000001"
  createdAt: number; // Unix timestamp
  filePath: string; // /backingfiles/snapshots/snap-XXXXXX/snap.bin
  tocPath: string; // /backingfiles/snapshots/snap-XXXXXX/snap.bin.toc
  size: number; // bytes
  isLinked: boolean; // if mnt symlink exists
}

/**
 * Represents a batch of camera clips pending archival
 */
export interface PendingClips {
  totalFiles: number;
  totalEvents: number;
  oldestAgeSec: number;
  files: ClipFile[];
}

export interface ClipFile {
  relPath: string; // Relative to mount point, e.g., "SavedClips/2026-04-04_12-34/video.mp4"
  isSymlink: boolean;
  ageSec: number;
}

/**
 * System health status
 */
export interface SystemStatus {
  uptime: number; // seconds
  cpuTempC?: number;
  drivesActive: boolean; // USB gadget mounted
  totalSpace: number; // bytes
  freeSpace: number; // bytes
  numSnapshots: number;
  snapshotOldest?: number; // Unix timestamp
  snapshotNewest?: number; // Unix timestamp
  ethSpeed?: string;
  ethIp?: string;
  wifiSsid?: string;
  wifiFreqGHz?: number;
  wifiSignalStrength?: number; // 0-100
  wifiIp?: string;
}

/**
 * Generic result wrapper for operations
 */
export interface OperationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  durationMs?: number;
}

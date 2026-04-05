import { z } from 'zod';

/**
 * Sync status represents the current state of the archiveloop sync operation.
 * Written to /mutable/sync_status by the orchestrator.
 */
export const SyncStatusSchema = z.object({
  state: z.enum(['idle', 'archiving', 'waiting']),
  queueFiles: z.number(),
  queueEvents: z.number().default(0),
  queueOldestAgeSec: z.number().default(0),
  lastStartEpoch: z.number().default(0),
  lastEndEpoch: z.number().default(0),
  lastDurationSec: z.number().default(0),
  lastResult: z.enum(['never', 'success', 'error']).default('never'),
});

export type SyncStatus = z.infer<typeof SyncStatusSchema>;

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
export const SnapshotSchema = z.object({
  id: z.string(), // e.g., "snap-000001"
  createdAt: z.number().default(0), // Unix timestamp
  filePath: z.string().default(''), // /backingfiles/snapshots/snap-XXXXXX/snap.bin
  tocPath: z.string().default(''), // /backingfiles/snapshots/snap-XXXXXX/snap.bin.toc
  mountPath: z.string().default(''), // /tmp/snapshots/snap-XXXXXX
  size: z.number().default(0), // bytes
  isLinked: z.boolean().default(false), // if mnt symlink exists
});

export type Snapshot = z.infer<typeof SnapshotSchema> & {
  /** Optional runtime callback for releasing the snapshot resources. */
  release?: () => Promise<void>;
};

/**
 * Represents a batch of camera clips pending archival
 */
export const ClipFileSchema = z.object({
  relPath: z.string(), // Relative to mount point, e.g., "SavedClips/2026-04-04_12-34/video.mp4"
  isSymlink: z.boolean(),
  ageSec: z.number(),
});

export type ClipFile = z.infer<typeof ClipFileSchema>;

export const PendingClipsSchema = z.object({
  totalFiles: z.number().default(0),
  totalEvents: z.number().default(0),
  oldestAgeSec: z.number().default(0),
  files: z.array(ClipFileSchema),
});

export type PendingClips = z.infer<typeof PendingClipsSchema>;

/**
 * System health status
 */
export const SystemStatusSchema = z.object({
  uptime: z.number(), // seconds
  cpuTempC: z.number().optional(),
  drivesActive: z.boolean(), // USB gadget mounted
  totalSpace: z.number(), // bytes
  freeSpace: z.number(), // bytes
  numSnapshots: z.number(),
  snapshotOldest: z.number().optional(), // Unix timestamp
  snapshotNewest: z.number().optional(), // Unix timestamp
  ethSpeed: z.string().optional(),
  ethIp: z.string().optional(),
  wifiSsid: z.string().optional(),
  wifiFreqGHz: z.number().optional(),
  wifiSignalStrength: z.number().optional(), // 0-100
  wifiIp: z.string().optional(),
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

/**
 * Generic result wrapper for operations
 */
export interface OperationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  durationMs?: number;
}

import { z } from 'zod';

export const TransferFileStatusSchema = z.enum(['queued', 'transferring', 'completed', 'failed', 'skipped']);
export type TransferFileStatus = z.infer<typeof TransferFileStatusSchema>;

export const TransferPhaseSchema = z.enum(['starting', 'transferring', 'finalizing', 'completed', 'failed']);
export type TransferPhase = z.infer<typeof TransferPhaseSchema>;

export const ClipRegistryStatusSchema = z.enum(['pending', 'transferring', 'failed', 'transferred']);
export type ClipRegistryStatus = z.infer<typeof ClipRegistryStatusSchema>;

export const ClipRegistryEntrySchema = z.object({
  key: z.string(),
  clipName: z.string().default(''),
  relPath: z.string(),
  firstSeenSnapshotId: z.string(),
  firstSeenSnapshotCreatedAt: z.number().default(0),
  firstSeenAt: z.number(),
  preferredSnapshotId: z.string(),
  preferredRootPath: z.string(),
  preferredSnapshotCreatedAt: z.number().default(0),
  status: ClipRegistryStatusSchema.default('pending'),
  isSymlink: z.boolean().default(true),
  ageSec: z.number().default(0),
  lastAttemptAt: z.number().optional(),
  transferredAt: z.number().optional(),
  updatedAt: z.number(),
});

export type ClipRegistryEntry = z.infer<typeof ClipRegistryEntrySchema>;

export const ClipRegistrySchema = z.object({
  updatedAt: z.number(),
  entries: z.array(ClipRegistryEntrySchema).default([]),
});

export type ClipRegistry = z.infer<typeof ClipRegistrySchema>;

export const TransferQueueFileStatusSchema = z.enum(['queued', 'transferring']);
export type TransferQueueFileStatus = z.infer<typeof TransferQueueFileStatusSchema>;

export const TransferQueueFileSchema = z.object({
  key: z.string(),
  clipName: z.string().default(''),
  relPath: z.string(),
  status: TransferQueueFileStatusSchema.default('queued'),
  isSymlink: z.boolean().default(true),
  ageSec: z.number().default(0),
  sourceSnapshotId: z.string(),
  sourceRootPath: z.string(),
  sourceSnapshotCreatedAt: z.number().default(0),
  updatedAt: z.number(),
});

export type TransferQueueFile = z.infer<typeof TransferQueueFileSchema>;

export const TransferQueueSchema = z.object({
  updatedAt: z.number(),
  files: z.array(TransferQueueFileSchema).default([]),
});

export type TransferQueue = z.infer<typeof TransferQueueSchema>;

export const TransferFileProgressSchema = z.object({
  path: z.string(),
  status: TransferFileStatusSchema.default('queued'),
  bytesTransferred: z.number().default(0),
  totalBytes: z.number().optional(),
  percent: z.number().min(0).max(100).optional(),
  speedBytesPerSec: z.number().optional(),
  etaSeconds: z.number().optional(),
  error: z.string().optional(),
  updatedAt: z.number(),
});

export type TransferFileProgress = z.infer<typeof TransferFileProgressSchema>;

export const TransferSessionSchema = z.object({
  sessionId: z.string(),
  backend: z.string(),
  phase: TransferPhaseSchema,
  filesTotal: z.number(),
  filesCompleted: z.number().default(0),
  filesFailed: z.number().default(0),
  batchPercent: z.number().min(0).max(100).optional(),
  bytesTransferred: z.number().default(0),
  totalBytes: z.number().optional(),
  currentFilePath: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  files: z.array(TransferFileProgressSchema).default([]),
});

export type TransferSession = z.infer<typeof TransferSessionSchema>;

export function cloneTransferSession(session: TransferSession): TransferSession {
  return {
    ...session,
    files: session.files.map((file) => ({ ...file })),
  };
}

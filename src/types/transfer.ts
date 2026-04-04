import { z } from 'zod';

export const TransferFileStatusSchema = z.enum(['queued', 'transferring', 'completed', 'failed', 'skipped']);
export type TransferFileStatus = z.infer<typeof TransferFileStatusSchema>;

export const TransferPhaseSchema = z.enum(['starting', 'transferring', 'finalizing', 'completed', 'failed']);
export type TransferPhase = z.infer<typeof TransferPhaseSchema>;

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

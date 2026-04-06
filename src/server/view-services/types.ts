import { Snapshot, ClipFile, SystemStatus } from '../../types';

/**
 * File transfer progress extends base ClipFile with transfer-specific state
 */
export interface FileTransferProgress extends ClipFile {
  status: 'pending' | 'transferring' | 'archived' | 'failed';
  progressPercent?: number;
  transferredBytes?: number;
  totalBytes?: number;
}

/**
 * Snapshot view with discovered files and transfer progress
 */
export interface SnapshotView {
  snapshot: Snapshot;
  /** Number of new files discovered in this snapshot */
  newFilesCount: number;
  /** Files in current archive session with transfer progress */
  filesInProgress: FileTransferProgress[];
}

/**
 * Current active transfer session
 */
export interface TransferSessionView {
  isActive: boolean;
  startedAtEpoch?: number;
  filesFailed: number;
  currentFile?: FileTransferProgress;
  overallProgressPercent: number;
}

/**
 * Observable-friendly subscription handle
 */
export interface Subscription {
  unsubscribe(): void;
}

/**
 * Re-export commonly used types from core
 */
export type { SystemStatus, Snapshot, ClipFile };

/**
 * Subscribable view service
 */
export interface ViewService<T> {
  /** Get current snapshot of data. */
  snapshot(): T;

  /** Subscribe to changes; fires immediately with current value, then on updates. */
  subscribe(listener: (data: T) => void): Subscription;
}

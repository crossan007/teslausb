import { Observable, ReplaySubject } from 'rxjs';
import { TransferSession } from './transfer';

export interface ArchiveTransferOptions {
  sessionId?: string;
}

export interface ArchiveTransferResult {
  archived: number;
  failed: number;
  errors?: string[];
}

export interface ArchiveTransferExecution {
  session$: Observable<TransferSession>;
  result: Promise<ArchiveTransferResult>;
}

/**
 * Optional capability for archive backends that can write trigger files directly.
 */
export interface TriggerFileWritableArchiveBackend {
  /**
   * Writes one or more trigger files to the backend destination.
   */
  writeTriggerFiles(relativePaths: string[]): Promise<void>;
}

/**
 * Returns true when the given backend supports direct trigger file writes.
 */
export function supportsTriggerFileWrites(
  backend: ArchiveBackend,
): backend is ArchiveBackend & TriggerFileWritableArchiveBackend {
  return typeof (backend as Partial<TriggerFileWritableArchiveBackend>).writeTriggerFiles === 'function';
}

export function createCompletedTransferExecution(
  backend: string,
  filePaths: string[],
  result: ArchiveTransferResult,
  sessionId = `${backend}-${Date.now()}`,
): ArchiveTransferExecution {
  const now = Date.now();
  const subject = new ReplaySubject<TransferSession>(1);

  subject.next({
    sessionId,
    backend,
    phase: result.failed > 0 ? 'failed' : 'completed',
    filesTotal: filePaths.length,
    filesCompleted: result.archived,
    filesFailed: result.failed,
    batchPercent: filePaths.length === 0 ? 100 : result.failed > 0 ? undefined : 100,
    bytesTransferred: 0,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    files: filePaths.map((path) => ({
      path,
      status: result.failed > 0 ? 'failed' : 'completed',
      bytesTransferred: 0,
      percent: result.failed > 0 ? undefined : 100,
      updatedAt: now,
      error: result.failed > 0 ? 'transfer_failed' : undefined,
    })),
  });
  subject.complete();

  return {
    session$: subject.asObservable(),
    result: Promise.resolve(result),
  };
}

/**
 * Abstract interface that all archive backends must implement.
 */
export interface ArchiveBackend {
  /** Human-readable name of the backend */
  name: string;

  /**
   * Verify that the backend is configured correctly and can be used.
   * Throws if configuration is invalid or missing.
   */
  verify(): Promise<void>;

  /**
   * Check if the archive destination is currently reachable.
   */
  isReachable(): Promise<boolean>;

  /**
   * Connect to the archive destination (e.g., mount CIFS share, start SSH tunnel).
   * Should be idempotent.
   */
  connect(): Promise<void>;

  /**
   * Archive a list of clip files to the destination.
   * Files are expected to exist at the current mount path.
   */
  archiveClips(
    fromPath: string, // Source mount path
    filePaths: string[], // Relative paths to archive
    options?: ArchiveTransferOptions,
  ): ArchiveTransferExecution;

  /**
   * Copy music from source to music archive.
   * Only implemented by backends that support music sharing (cifs, nfs).
   */
  copyMusic?(fromPath: string, toPath: string): Promise<void>;

  /**
   * Disconnect from the archive destination.
   * Should be idempotent and handle graceful cleanup.
   */
  disconnect(): Promise<void>;
}

/**
 * Archive backend factory. Returns a backend instance given a config.
 */
export type ArchiveBackendFactory = (config: Record<string, any>) => ArchiveBackend;

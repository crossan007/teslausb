import { TransferSession } from './transfer';

export interface ArchiveTransferOptions {
  sessionId?: string;
  onProgress?: (session: TransferSession) => void;
}

export interface ArchiveTransferResult {
  archived: number;
  failed: number;
  errors?: string[];
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
  ): Promise<ArchiveTransferResult>;

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

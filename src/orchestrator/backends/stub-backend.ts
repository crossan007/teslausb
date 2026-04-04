/**
 * Legacy lineage:
 * - run/cifs_archive/*
 * - run/nfs_archive/*
 * - run/rclone_archive/*
 * - run/none_archive/*
 *
 * These stubs preserve the script contract surface during Phase 2 dry-run mode.
 */
import { ArchiveBackend, ArchiveTransferExecution, createCompletedTransferExecution } from '../../types';

export class StubArchiveBackend implements ArchiveBackend {
  name: string;
  private reachable = true;

  constructor(name: string) {
    this.name = name;
  }

  setReachable(reachable: boolean): void {
    this.reachable = reachable;
  }

  async verify(): Promise<void> {
    return;
  }

  async isReachable(): Promise<boolean> {
    return this.reachable;
  }

  async connect(): Promise<void> {
    return;
  }

  archiveClips(_fromPath: string, filePaths: string[]): ArchiveTransferExecution {
    return createCompletedTransferExecution(this.name, filePaths, {
      archived: filePaths.length,
      failed: 0,
    });
  }

  async disconnect(): Promise<void> {
    return;
  }
}

export class CifsBackendStub extends StubArchiveBackend {
  constructor() {
    super('cifs');
  }

  async copyMusic(_fromPath: string, _toPath: string): Promise<void> {
    return;
  }
}

export class NfsBackendStub extends StubArchiveBackend {
  constructor() {
    super('nfs');
  }

  async copyMusic(_fromPath: string, _toPath: string): Promise<void> {
    return;
  }
}

export class RcloneBackendStub extends StubArchiveBackend {
  constructor() {
    super('rclone');
  }
}

export class NoneBackendStub extends StubArchiveBackend {
  constructor() {
    super('none');
  }
}

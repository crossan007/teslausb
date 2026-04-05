/**
 * Legacy lineage:
 * - run/make_snapshot.sh
 * - run/release_snapshot.sh
 */
import { constants } from 'fs';
import { copyFile, mkdir, readdir, readlink, rm, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { logger, stateManager } from '../core';
import { pathExists } from '../shared';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { Snapshot } from '../types';

export interface SnapshotDecision {
  shouldCreate: boolean;
  reason: string;
}

export interface SnapshotStateSink {
  writeSnapshot(snapshot: Snapshot): void;
}

type SnapshotCopier = (sourcePath: string, destinationPath: string) => Promise<void>;
type SnapshotMountAction = (imagePath: string, mountPath: string) => Promise<void>;
type SnapshotUnmountAction = (mountPath: string) => Promise<void>;

export interface SnapshotManagerOptions {
  camDiskPath?: string;
  snapshotRootPath?: string;
  snapshotMountRootPath?: string;
  mutableTeslaCamPath?: string;
  nowEpochProvider?: () => number;
  snapshotCopier?: SnapshotCopier;
  mountSnapshot?: SnapshotMountAction;
  unmountSnapshot?: SnapshotUnmountAction;
  stateSink?: SnapshotStateSink;
}

const DEFAULT_CAM_DISK_PATH = '/backingfiles/cam_disk.bin';
const DEFAULT_SNAPSHOT_ROOT = '/backingfiles/snapshots';
const DEFAULT_MUTABLE_TESLACAM_PATH = '/mutable/TeslaCam';

export class SnapshotManager {
  private readonly camDiskPath: string;
  private readonly snapshotRootPath: string;
  private readonly snapshotMountRootPath: string;
  private readonly mutableTeslaCamPath: string;
  private readonly nowEpochProvider: () => number;
  private readonly snapshotCopier: SnapshotCopier;
  private readonly mountSnapshotAction: SnapshotMountAction;
  private readonly unmountSnapshotAction: SnapshotUnmountAction;
  private readonly stateSink?: SnapshotStateSink;

  constructor(
    private readonly minIntervalSec: number = 300,
    options: SnapshotManagerOptions = {},
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
  ) {
    this.camDiskPath = options.camDiskPath ?? DEFAULT_CAM_DISK_PATH;
    this.snapshotRootPath = options.snapshotRootPath ?? DEFAULT_SNAPSHOT_ROOT;
    this.snapshotMountRootPath = options.snapshotMountRootPath ?? this.snapshotRootPath;
    this.mutableTeslaCamPath = options.mutableTeslaCamPath ?? DEFAULT_MUTABLE_TESLACAM_PATH;
    this.nowEpochProvider = options.nowEpochProvider ?? (() => Math.floor(Date.now() / 1000));
    this.snapshotCopier = options.snapshotCopier ?? ((sourcePath, destinationPath) => this.copySnapshotReflink(sourcePath, destinationPath));
    this.mountSnapshotAction = options.mountSnapshot ?? ((imagePath, mountPath) => this.mountSnapshotAtPath(imagePath, mountPath));
    this.unmountSnapshotAction = options.unmountSnapshot ?? ((mountPath) => this.unmountSnapshotAtPath(mountPath));
    this.stateSink = options.stateSink ?? stateManager;
  }

  shouldCreateSnapshot(lastSnapshotEpoch: number | null, nowEpoch: number): SnapshotDecision {
    if (lastSnapshotEpoch === null) {
      return { shouldCreate: true, reason: 'no_previous_snapshot' };
    }

    const elapsed = nowEpoch - lastSnapshotEpoch;
    if (elapsed >= this.minIntervalSec) {
      return { shouldCreate: true, reason: 'interval_elapsed' };
    }

    return { shouldCreate: false, reason: 'interval_not_elapsed' };
  }

  async createSnapshot(): Promise<Snapshot> {
    await mkdir(this.snapshotRootPath, { recursive: true });

    const snapshotIds = await this.listSnapshotIds();
    const highestExisting = snapshotIds.length === 0
      ? -1
      : Math.max(...snapshotIds.map((name) => this.snapshotNumber(name)));
    const nextNumber = highestExisting + 1;
    const snapshotId = this.snapshotName(nextNumber);
    const snapshotDir = join(this.snapshotRootPath, snapshotId);
    const snapshotFilePath = join(snapshotDir, 'snap.bin');

    await mkdir(snapshotDir, { recursive: true });
    await this.snapshotCopier(this.camDiskPath, snapshotFilePath);

    const snapshot = await this.buildSnapshotMetadata(snapshotId, false);
    this.stateSink?.writeSnapshot(snapshot);
    logger.info({ snapshotPath: snapshot.filePath }, 'Snapshot created');
    return snapshot;
  }

  async mountSnapshot(snapshotOrId: Snapshot | string): Promise<Snapshot> {
    const snapshotId = typeof snapshotOrId === 'string' ? snapshotOrId : snapshotOrId.id;
    const snapshot = await this.buildSnapshotMetadata(snapshotId, false);

    await mkdir(snapshot.mountPath, { recursive: true });
    await this.mountSnapshotAction(snapshot.filePath, snapshot.mountPath);

    const mounted = {
      ...snapshot,
      isLinked: true,
    };
    this.stateSink?.writeSnapshot(mounted);
    logger.info({ snapshotId, mountPath: mounted.mountPath }, 'Snapshot mounted');
    return mounted;
  }

  async createMountedSnapshot(): Promise<Snapshot> {
    const snapshot = await this.createSnapshot();
    return this.mountSnapshot(snapshot);
  }

  async resolveDiscoveryRoot(snapshotOrId: Snapshot | string): Promise<string> {
    const snapshotId = typeof snapshotOrId === 'string' ? snapshotOrId : snapshotOrId.id;
    const mountPath = this.buildMountPath(snapshotId);

    if (await pathExists(join(mountPath, 'SavedClips'))
      || await pathExists(join(mountPath, 'SentryClips'))
      || await pathExists(join(mountPath, 'TeslaTrackMode'))
      || await pathExists(join(mountPath, 'RecentClips'))) {
      return mountPath;
    }

    if (await pathExists(join(mountPath, 'TeslaCam'))) {
      return join(mountPath, 'TeslaCam');
    }

    return mountPath;
  }

  async releaseSnapshot(snapshotId: string): Promise<void> {
    const mountPath = this.buildMountPath(snapshotId);
    await this.unmountSnapshotAction(mountPath).catch(() => undefined);
    await rm(mountPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(this.snapshotRootPath, snapshotId), { recursive: true, force: true });
    await this.removeLinksReferencingSnapshot(snapshotId);
    logger.info({ snapshotId }, 'Snapshot released');
  }

  async cleanupStaleSnapshots(): Promise<void> {
    const snapshotIds = await this.listSnapshotIds();
    if (snapshotIds.length === 0) {
      return;
    }

    logger.info({ count: snapshotIds.length }, 'Cleaning stale snapshots from previous runs');

    for (const snapshotId of snapshotIds) {
      try {
        await this.releaseSnapshot(snapshotId);
      } catch (error) {
        logger.warn({ err: error, snapshotId }, 'Failed to release stale snapshot during startup cleanup');
      }
    }
  }

  async listSnapshotIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.snapshotRootPath, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory() && /^snap-\d{6}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  private async buildSnapshotMetadata(snapshotId: string, isLinked: boolean): Promise<Snapshot> {
    const filePath = join(this.snapshotRootPath, snapshotId, 'snap.bin');
    const fileStats = await stat(filePath);
    return {
      id: snapshotId,
      createdAt: this.nowEpochProvider(),
      filePath,
      tocPath: `${filePath}.toc`,
      mountPath: this.buildMountPath(snapshotId),
      size: fileStats.size,
      isLinked,
      release: async () => this.releaseSnapshot(snapshotId),
    };
  }

  private buildMountPath(snapshotId: string): string {
    return join(this.snapshotMountRootPath, snapshotId, 'mnt');
  }

  private async copySnapshotReflink(sourcePath: string, destinationPath: string): Promise<void> {
    try {
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`snapshot_copy_on_write_required: ${detail}`);
    }
  }

  private async mountSnapshotAtPath(imagePath: string, mountPath: string): Promise<void> {
    const result = await this.commandRunner.run('/root/bin/mountimage', [imagePath, mountPath, 'ro']);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `mountimage failed with exit code ${result.code}`);
    }
  }

  private async unmountSnapshotAtPath(mountPath: string): Promise<void> {
    const result = await this.commandRunner.run('umount', [mountPath]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `umount failed with exit code ${result.code}`);
    }
  }

  private async removeLinksReferencingSnapshot(snapshotId: string): Promise<void> {
    const stack = [this.mutableTeslaCamPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absPath);
          continue;
        }

        if (!entry.isSymbolicLink()) {
          continue;
        }

        try {
          const target = await readlink(absPath);
          if (target.includes(`/${snapshotId}/`)) {
            await unlink(absPath).catch(() => undefined);
          }
        } catch {
          continue;
        }
      }
    }
  }

  private snapshotName(value: number): string {
    return `snap-${String(value).padStart(6, '0')}`;
  }

  private snapshotNumber(snapshotId: string): number {
    return Number(snapshotId.replace(/^snap-/, ''));
  }
}

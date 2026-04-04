/**
 * Legacy lineage:
 * - run/rsync_archive/verify-and-configure-archive.sh
 * - run/rsync_archive/archive-is-reachable.sh
 * - run/rsync_archive/connect-archive.sh
 * - run/rsync_archive/archive-clips.sh
 * - run/rsync_archive/disconnect-archive.sh
 */
import { mkdir, rm, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { ReplaySubject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import {
  ArchiveBackend,
  ArchiveTransferExecution,
  ArchiveTransferOptions,
  ArchiveTransferResult,
  TeslaUSBConfig,
  cloneTransferSession,
  createCompletedTransferExecution,
  TransferFileProgress,
  TransferSession,
} from '../../types';
import { CommandRunner, defaultCommandRunner } from '../../shared/command-runner';

export interface RsyncBackendOptions {
  legacyConfigPath?: string;
  tempRootDir?: string;
}

export class RsyncBackend implements ArchiveBackend {
  readonly name = 'rsync';

  constructor(
    private readonly config: Pick<TeslaUSBConfig, 'rsyncServer' | 'rsyncUser' | 'rsyncPath'>,
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
    private readonly options: RsyncBackendOptions = {},
  ) {}

  async verify(): Promise<void> {
    this.requireConfig();
    await rm(this.options.legacyConfigPath ?? '/root/.teslaCamRsyncConfig', { force: true }).catch(() => undefined);
  }

  async isReachable(): Promise<boolean> {
    const { rsyncServer, rsyncUser } = this.requireConfig();

    const pingResult = await this.commandRunner.run('ping', ['-q', '-w', '1', '-c', '1', rsyncServer]);
    if (pingResult.code === 0) {
      return true;
    }

    const sshResult = await this.commandRunner.run('ssh', ['-q', '-o', 'ConnectTimeout=1', `${rsyncUser}@${rsyncServer}`, 'exit']);
    return sshResult.code === 0;
  }

  async connect(): Promise<void> {
    return;
  }

  /**
   * Writes trigger files directly to archive destination for legacy compatibility.
   */
  async writeTriggerFiles(relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) {
      return;
    }

    const { rsyncServer, rsyncUser, rsyncPath } = this.requireConfig();
    const destination = `${rsyncUser}@${rsyncServer}:${rsyncPath}`;
    const tempDir = await mkdtemp(join(this.options.tempRootDir ?? tmpdir(), 'teslausb-trigger-'));
    const triggerRoot = join(tempDir, 'triggers');
    const triggerListPath = join(tempDir, 'trigger-files.txt');

    try {
      for (const triggerPath of relativePaths) {
        const triggerAbsolutePath = join(triggerRoot, triggerPath);
        await mkdir(dirname(triggerAbsolutePath), { recursive: true });
        await writeFile(triggerAbsolutePath, '', 'utf-8');
      }

      await writeFile(triggerListPath, `${relativePaths.join('\n')}\n`, 'utf-8');

      const result = await this.commandRunner.run('rsync', [
        '-avhRL',
        '--timeout=60',
        '--no-perms',
        '--omit-dir-times',
        '--stats',
        '--ignore-missing-args',
        `--files-from=${triggerListPath}`,
        triggerRoot,
        destination,
      ]);

      if (result.code !== 0 && result.code !== 24) {
        throw new Error(result.stderr || result.stdout || `rsync trigger transfer failed with exit code ${result.code}`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  archiveClips(fromPath: string, filePaths: string[], options?: ArchiveTransferOptions): ArchiveTransferExecution {
    const { rsyncServer, rsyncUser, rsyncPath } = this.requireConfig();

    if (filePaths.length === 0) {
      return createCompletedTransferExecution(this.name, filePaths, { archived: 0, failed: 0 }, options?.sessionId);
    }

    const session = this.createTransferSession(filePaths, options?.sessionId);
    const subject = new ReplaySubject<TransferSession>(1);
    this.emitProgress(subject, session);

    const result = (async (): Promise<ArchiveTransferResult> => {
      const tempDir = await mkdtemp(join(this.options.tempRootDir ?? tmpdir(), 'teslausb-rsync-'));
      const fileListPath = join(tempDir, 'files-from.txt');
      const destination = `${rsyncUser}@${rsyncServer}:${rsyncPath}`;

      try {
        await writeFile(fileListPath, `${filePaths.join('\n')}\n`, 'utf-8');

        const commandResult = await this.commandRunner.runStreaming('rsync', [
          '-avhRL',
          '--timeout=60',
          '--remove-source-files',
          '--no-perms',
          '--omit-dir-times',
          '--stats',
          '--info=progress2,name',
          '--ignore-missing-args',
          `--files-from=${fileListPath}`,
          fromPath,
          destination,
        ], {
          onStdoutLine: (line) => {
            this.handleProgressLine(line, session, subject);
          },
          onStderrLine: (line) => {
            this.handleProgressLine(line, session, subject);
          },
        });

        if (commandResult.code !== 0 && commandResult.code !== 24) {
          session.phase = 'failed';
          session.filesFailed = Math.max(filePaths.length - session.filesCompleted, 1);
          session.updatedAt = Date.now();
          session.completedAt = session.updatedAt;
          this.markCurrentFileFailed(session, commandResult.stderr || commandResult.stdout || 'rsync failed');
          this.emitProgress(subject, session);
          throw new Error(commandResult.stderr || commandResult.stdout || `rsync failed with exit code ${commandResult.code}`);
        }

        this.markAllRemainingFilesCompleted(session);
        session.phase = 'completed';
        session.batchPercent = 100;
        session.updatedAt = Date.now();
        session.completedAt = session.updatedAt;
        session.currentFilePath = undefined;
        this.emitProgress(subject, session);

        return {
          archived: filePaths.length,
          failed: 0,
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    })();

    void result.then(
      () => {
        subject.complete();
      },
      () => {
        subject.complete();
      },
    );

    return {
      session$: subject.asObservable(),
      result,
    };
  }

  async disconnect(): Promise<void> {
    return;
  }

  private requireConfig(): Required<Pick<TeslaUSBConfig, 'rsyncServer' | 'rsyncUser' | 'rsyncPath'>> {
    const { rsyncServer, rsyncUser, rsyncPath } = this.config;

    if (!rsyncServer || !rsyncUser || !rsyncPath) {
      throw new Error('Rsync backend requires rsyncServer, rsyncUser, and rsyncPath');
    }

    return { rsyncServer, rsyncUser, rsyncPath };
  }

  private createTransferSession(filePaths: string[], sessionId?: string): TransferSession {
    const now = Date.now();
    return {
      sessionId: sessionId ?? uuidv4(),
      backend: this.name,
      phase: 'starting',
      filesTotal: filePaths.length,
      filesCompleted: 0,
      filesFailed: 0,
      batchPercent: 0,
      bytesTransferred: 0,
      startedAt: now,
      updatedAt: now,
      files: filePaths.map((path) => ({
        path,
        status: 'queued',
        bytesTransferred: 0,
        updatedAt: now,
      })),
    };
  }

  private emitProgress(subject: ReplaySubject<TransferSession>, session: TransferSession): void {
    subject.next(cloneTransferSession(session));
  }

  private handleProgressLine(line: string, session: TransferSession, subject: ReplaySubject<TransferSession>): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const progressMatch = trimmed.match(/^([\d,]+)\s+(\d+)%\s+([^\s]+)\s+([^\s]+)\s+\(xfr#(\d+),\s*to-chk=(\d+)\/(\d+)\)$/);
    if (progressMatch) {
      const [, transferred, percent, rate, eta, xfrCount] = progressMatch;
      session.phase = 'transferring';
      session.bytesTransferred = this.parseIntegerWithCommas(transferred);
      session.batchPercent = Number(percent);
      session.filesCompleted = Math.max(session.filesCompleted, Number(xfrCount));
      session.updatedAt = Date.now();

      if (session.currentFilePath) {
        const file = this.findFile(session, session.currentFilePath);
        if (file) {
          file.status = Number(percent) >= 100 ? 'completed' : 'transferring';
          file.bytesTransferred = session.bytesTransferred;
          file.percent = Number(percent);
          file.speedBytesPerSec = this.parseRate(rate);
          file.etaSeconds = this.parseEta(eta);
          file.updatedAt = session.updatedAt;
        }
      }

      this.emitProgress(subject, session);
      return;
    }

    const currentFile = this.findFile(session, trimmed);
    if (currentFile) {
      session.phase = 'transferring';
      session.currentFilePath = trimmed;
      session.updatedAt = Date.now();
      currentFile.status = 'transferring';
      currentFile.updatedAt = session.updatedAt;
      this.emitProgress(subject, session);
    }
  }

  private findFile(session: TransferSession, path: string): TransferFileProgress | undefined {
    return session.files.find((file) => file.path === path);
  }

  private markAllRemainingFilesCompleted(session: TransferSession): void {
    const now = Date.now();
    for (const file of session.files) {
      if (file.status === 'queued' || file.status === 'transferring') {
        file.status = 'completed';
        file.percent = 100;
        file.updatedAt = now;
      }
    }
    session.filesCompleted = session.files.length - session.filesFailed;
  }

  private markCurrentFileFailed(session: TransferSession, error: string): void {
    if (!session.currentFilePath) {
      return;
    }
    const current = this.findFile(session, session.currentFilePath);
    if (!current) {
      return;
    }
    current.status = 'failed';
    current.error = error;
    current.updatedAt = Date.now();
  }

  private parseIntegerWithCommas(value: string): number {
    return Number(value.replace(/,/g, ''));
  }

  private parseRate(value: string): number | undefined {
    const match = value.match(/^([\d.]+)([kMGT]?B)\/s$/i);
    if (!match) {
      return undefined;
    }
    const numeric = Number(match[1]);
    const unit = match[2].toUpperCase();
    const multiplier: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };
    return numeric * (multiplier[unit] ?? 1);
  }

  private parseEta(value: string): number | undefined {
    const segments = value.split(':').map(Number);
    if (segments.some(Number.isNaN)) {
      return undefined;
    }
    if (segments.length === 2) {
      return segments[0] * 60 + segments[1];
    }
    if (segments.length === 3) {
      return segments[0] * 3600 + segments[1] * 60 + segments[2];
    }
    return undefined;
  }
}

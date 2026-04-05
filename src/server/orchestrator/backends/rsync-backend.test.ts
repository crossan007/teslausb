import { describe, it, expect } from 'vitest';
import { RsyncBackend } from './rsync-backend';
import { CommandRunner, CommandResult, StreamingCommandHandlers } from '../../shared/command-runner';
import { TransferSession } from '../../../types';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

class MockCommandRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  private readonly results = new Map<string, CommandResult>();
  private readonly streamLines = new Map<string, { stdout?: string[]; stderr?: string[] }>();

  setResult(command: string, result: CommandResult): void {
    this.results.set(command, result);
  }

  setStreamLines(command: string, lines: { stdout?: string[]; stderr?: string[] }): void {
    this.streamLines.set(command, lines);
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.results.get(command) ?? { code: 0, stdout: '', stderr: '' };
  }

  async runStreaming(command: string, args: string[], handlers?: StreamingCommandHandlers): Promise<CommandResult> {
    this.calls.push({ command, args });
    const lines = this.streamLines.get(command);
    lines?.stdout?.forEach((line) => handlers?.onStdoutLine?.(line));
    lines?.stderr?.forEach((line) => handlers?.onStderrLine?.(line));
    return this.results.get(command) ?? { code: 0, stdout: '', stderr: '' };
  }
}

describe('RsyncBackend', () => {
  it('validates required config during verify', async () => {
    const backend = new RsyncBackend({ rsyncServer: 'host', rsyncUser: 'user' });
    await expect(backend.verify()).rejects.toThrow('Rsync backend requires');
  });

  it('returns true when ping succeeds', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('ping', { code: 0, stdout: '', stderr: '' });

    const backend = new RsyncBackend({ rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' }, runner);
    await expect(backend.isReachable()).resolves.toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('ping');
  });

  it('falls back to ssh when ping fails', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('ping', { code: 1, stdout: '', stderr: '' });
    runner.setResult('ssh', { code: 0, stdout: '', stderr: '' });

    const backend = new RsyncBackend({ rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' }, runner);
    await expect(backend.isReachable()).resolves.toBe(true);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].command).toBe('ssh');
  });

  it('returns false when both ping and ssh fail', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('ping', { code: 1, stdout: '', stderr: '' });
    runner.setResult('ssh', { code: 255, stdout: '', stderr: 'unreachable' });

    const backend = new RsyncBackend({ rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' }, runner);
    await expect(backend.isReachable()).resolves.toBe(false);
  });

  it('archives files with rsync', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 0, stdout: 'ok', stderr: '' });
    runner.setStreamLines('rsync', {
      stdout: [
        'SavedClips/a.mp4',
        '1,024 50% 512B/s 0:00:01 (xfr#0, to-chk=2/2)',
        'SavedClips/b.mp4',
        '2,048 100% 1.0KB/s 0:00:00 (xfr#2, to-chk=0/2)',
      ],
    });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    const sessions: TransferSession[] = [];

    const transfer = backend.archiveClips('/mnt/cam', ['SavedClips/a.mp4', 'SavedClips/b.mp4']);
    const subscription = transfer.session$.subscribe((session: TransferSession) => {
      sessions.push(session);
    });
    const result = await transfer.result;
    subscription.unsubscribe();

    expect(result.archived).toBe(2);
    expect(result.failed).toBe(0);
    expect(runner.calls.at(-1)?.command).toBe('rsync');
    expect(runner.calls.at(-1)?.args).toContain('/mnt/cam');
    expect(runner.calls.at(-1)?.args).toContain('user@host:/archive');
    expect(runner.calls.at(-1)?.args).toContain('--info=progress2,name');
    expect(runner.calls.at(-1)?.args).toContain('--outbuf=L');
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.at(-1)?.phase).toBe('completed');
    expect(sessions.at(-1)?.filesCompleted).toBe(2);
    expect(sessions.some((session) => session.currentFilePath === 'SavedClips/a.mp4')).toBe(true);
  });

  it('parses progress lines that use ir-chk and updates transfer progress before completion', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'teslausb-rsync-irchk-'));
    const relPath = 'RecentClips/large.mp4';
    const sourcePath = join(sourceRoot, relPath);

    await mkdir(join(sourceRoot, 'RecentClips'), { recursive: true });
    await writeFile(sourcePath, 'x'.repeat(100));

    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 0, stdout: '', stderr: '' });
    runner.setStreamLines('rsync', {
      stdout: [
        relPath,
        '10 10% 1.00MB/s 0:00:09 (xfr#0, ir-chk=1/2)',
        '50 50% 1.00MB/s 0:00:05 (xfr#0, ir-chk=1/2)',
      ],
    });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    const sessions: TransferSession[] = [];
    const transfer = backend.archiveClips(sourceRoot, [relPath]);
    const subscription = transfer.session$.subscribe((session: TransferSession) => {
      sessions.push(session);
    });

    try {
      await transfer.result;

      const sawIntermediateProgress = sessions.some((session) =>
        session.phase === 'transferring'
        && (session.batchPercent ?? 0) >= 50
        && (session.files[0]?.percent ?? 0) >= 50,
      );

      expect(sawIntermediateProgress).toBe(true);
    } finally {
      subscription.unsubscribe();
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('parses human-readable transferred-byte tokens from rsync progress lines', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'teslausb-rsync-humanbytes-'));
    const relPath = 'RecentClips/human.mp4';
    const sourcePath = join(sourceRoot, relPath);

    await mkdir(join(sourceRoot, 'RecentClips'), { recursive: true });
    await writeFile(sourcePath, 'x'.repeat(100));

    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 0, stdout: '', stderr: '' });
    runner.setStreamLines('rsync', {
      stdout: [
        relPath,
        '1.0M 40% 2.00MB/s 0:00:01 (xfr#0, ir-chk=1/2)',
      ],
    });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    const sessions: TransferSession[] = [];
    const transfer = backend.archiveClips(sourceRoot, [relPath]);
    const subscription = transfer.session$.subscribe((session: TransferSession) => {
      sessions.push(session);
    });

    try {
      await transfer.result;

      const sessionWithProgress = sessions.find((session) =>
        session.phase === 'transferring' && (session.batchPercent ?? 0) === 40,
      );

      expect(sessionWithProgress).toBeDefined();
      expect((sessionWithProgress?.bytesTransferred ?? 0)).toBeGreaterThan(1_000_000);
      expect((sessionWithProgress?.files[0]?.bytesTransferred ?? 0)).toBeGreaterThan(30);
    } finally {
      subscription.unsubscribe();
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('treats rsync exit code 24 as success', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 24, stdout: '', stderr: '' });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    const result = await backend.archiveClips('/mnt/cam', ['SavedClips/a.mp4']).result;
    expect(result.archived).toBe(1);
  });

  it('fills transfer bytes from source file size when rsync telemetry is sparse', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'teslausb-rsync-bytes-'));
    const relPath = 'RecentClips/small.mp4';
    const sourcePath = join(sourceRoot, relPath);

    await mkdir(join(sourceRoot, 'RecentClips'), { recursive: true });
    await writeFile(sourcePath, 'hello');

    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 0, stdout: '', stderr: '' });
    runner.setStreamLines('rsync', { stdout: [relPath] });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    const sessions: TransferSession[] = [];
    const transfer = backend.archiveClips(sourceRoot, [relPath]);
    const subscription = transfer.session$.subscribe((session: TransferSession) => {
      sessions.push(session);
    });

    try {
      const result = await transfer.result;
      expect(result.archived).toBe(1);
      const finalSession = sessions.at(-1);
      expect(finalSession?.bytesTransferred).toBe(5);
      expect(finalSession?.files[0].bytesTransferred).toBe(5);
      expect(finalSession?.files[0].totalBytes).toBe(5);
    } finally {
      subscription.unsubscribe();
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('throws when rsync fails', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 12, stdout: '', stderr: 'rsync failed hard' });
    runner.setStreamLines('rsync', { stdout: ['SavedClips/a.mp4'] });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    await expect(backend.archiveClips('/mnt/cam', ['SavedClips/a.mp4']).result).rejects.toThrow('rsync failed hard');
  });

  it('writes trigger files directly via backend capability', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 0, stdout: '', stderr: '' });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    await backend.writeTriggerFiles([
      'SavedClips/saved.trigger',
      'all.trigger',
    ]);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('rsync');
    expect(runner.calls[0].args).toContain('user@host:/archive');
    expect(runner.calls[0].args.join(' ')).toContain('trigger-files.txt');
  });

});

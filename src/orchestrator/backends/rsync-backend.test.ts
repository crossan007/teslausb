import { describe, it, expect } from 'vitest';
import { RsyncBackend } from './rsync-backend';
import { CommandRunner, CommandResult, StreamingCommandHandlers } from './command-runner';
import { TransferSession } from '../../types';

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

    const result = await backend.archiveClips('/mnt/cam', ['SavedClips/a.mp4', 'SavedClips/b.mp4'], {
      onProgress: (session) => sessions.push(session),
    });

    expect(result.archived).toBe(2);
    expect(result.failed).toBe(0);
    expect(runner.calls.at(-1)?.command).toBe('rsync');
    expect(runner.calls.at(-1)?.args).toContain('/mnt/cam');
    expect(runner.calls.at(-1)?.args).toContain('user@host:/archive');
    expect(runner.calls.at(-1)?.args).toContain('--info=progress2,name');
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.at(-1)?.phase).toBe('completed');
    expect(sessions.at(-1)?.filesCompleted).toBe(2);
    expect(sessions.some((session) => session.currentFilePath === 'SavedClips/a.mp4')).toBe(true);
  });

  it('treats rsync exit code 24 as success', async () => {
    const runner = new MockCommandRunner();
    runner.setResult('rsync', { code: 24, stdout: '', stderr: '' });

    const backend = new RsyncBackend(
      { rsyncServer: 'host', rsyncUser: 'user', rsyncPath: '/archive' },
      runner,
      { tempRootDir: '/tmp' },
    );

    const result = await backend.archiveClips('/mnt/cam', ['SavedClips/a.mp4']);
    expect(result.archived).toBe(1);
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

    await expect(backend.archiveClips('/mnt/cam', ['SavedClips/a.mp4'])).rejects.toThrow('rsync failed hard');
  });
});

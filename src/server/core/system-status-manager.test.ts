import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemStatusManager } from './system-status-manager';
import type { CommandResult } from '../shared/command-runner';

const mockRun = vi.fn<[string, string[]], Promise<CommandResult>>();

const mockCommandRunner = { run: mockRun };

describe('SystemStatusManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns system status with required fields', async () => {
    // df output for /mutable
    mockRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'df') {
        return {
          code: 0,
          stdout: 'Filesystem     1B-blocks      Used Available Use% Mounted on\n/dev/sda1     1073741824 536870912 536870912  50% /mutable\n',
          stderr: '',
        };
      }
      if (cmd === 'ping') {
        return {
          code: 0,
          stdout: 'PING 192.168.1.1: 56 data bytes\n--- 192.168.1.1 ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss\nround-trip min/avg/max/stddev = 1.000/2.500/4.000/1.000 ms\n',
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unknown command' };
    });

    const manager = new SystemStatusManager({
      commandRunner: mockCommandRunner,
      thermalZonePath: '/dev/null', // returns "0\n" on Linux
    });

    const status = await manager.readSystemStatus();

    expect(status).not.toBeNull();
    expect(status?.uptime).toBeGreaterThanOrEqual(0);
    expect(status?.drivesActive).toBeDefined();
    expect(status?.totalSpace).toBeGreaterThanOrEqual(0);
    expect(status?.freeSpace).toBeGreaterThanOrEqual(0);
    expect(status?.numSnapshots).toBeGreaterThanOrEqual(0);
    expect(status?.pingTimeMs).toBeGreaterThan(0);
    expect(status?.packetLoss).toBe(0);
    expect(status?.networkHealthHistory.length).toBe(1);
    expect(status?.networkHealthHistory[0].pingMs).toBeGreaterThan(0);
  });

  it('returns status with nullish network fields when ping fails', async () => {
    mockRun.mockImplementation(async (cmd: string) => {
      if (cmd === 'df') {
        return {
          code: 0,
          stdout: 'Filesystem     1B-blocks      Used Available Use% Mounted on\n/dev/sda1     1073741824 536870912 536870912  50% /mutable\n',
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: '' };
    });

    const manager = new SystemStatusManager({
      commandRunner: mockCommandRunner,
      thermalZonePath: '/dev/null',
    });

    const status = await manager.readSystemStatus();

    expect(status).not.toBeNull();
    expect(status?.pingTimeMs).toBeUndefined();
    expect(status?.packetLoss).toBeUndefined();
    expect(status?.networkHealthHistory.length).toBe(1);
    expect(status?.networkHealthHistory[0].pingMs).toBeUndefined();
  });
});

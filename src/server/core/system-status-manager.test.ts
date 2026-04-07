import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemStatusManager } from './system-status-manager';
import type { CommandResult } from '../shared/command-runner';

const mockRun = vi.fn<[string, string[]], Promise<CommandResult>>();

const mockCommandRunner = { run: mockRun };

describe('SystemStatusManager', () => {
  const FULL_DF_OUTPUT = [
    'Filesystem 1B-blocks Used Available Use% Mounted on',
    'tmpfs 189251584 19660800 169590784 11% /run',
    '/dev/mmcblk0p2 4294967296 2147483648 1932735283 53% /',
    '/dev/mmcblk0p1 536870912 84934656 440401920 16% /boot/firmware',
    '/dev/mmcblk0p4 314572800 1572864 276824064 1% /mutable',
    '/dev/mmcblk0p3 251255586816 173946175488 78309498880 70% /backingfiles',
    '/dev/loop0 171798691840 20401094656 151397597184 12% /backingfiles/snapshots/snap-000000/mnt',
    'tmpfs 943718400 0 943718400 0% /tmp',
  ].join('\n');

  const DF_BY_PATH: Record<string, string> = {
    '/mutable': '/dev/mmcblk0p4 314572800 1572864 276824064 1% /mutable',
    '/backingfiles': '/dev/mmcblk0p3 251255586816 173946175488 78309498880 70% /backingfiles',
    '/': '/dev/mmcblk0p2 4294967296 2147483648 1932735283 53% /',
    '/boot/firmware': '/dev/mmcblk0p1 536870912 84934656 440401920 16% /boot/firmware',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns system status with required fields', async () => {
    mockRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ip') {
        return {
          code: 0,
          stdout: 'default via 10.0.0.1 dev wlan0 proto dhcp src 10.0.0.5 metric 600\n',
          stderr: '',
        };
      }
      if (cmd === 'df') {
        if (args.length === 2) {
          return {
            code: 0,
            stdout: `${FULL_DF_OUTPUT}\n`,
            stderr: '',
          };
        }
        const mountPath = args.at(-1) ?? '';
        const line = DF_BY_PATH[mountPath];
        if (!line) {
          return { code: 1, stdout: '', stderr: 'mount path not configured in test' };
        }
        return {
          code: 0,
          stdout: `Filesystem     1B-blocks      Used Available Use% Mounted on\n${line}\n`,
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
      partitionMountPoints: ['/mutable', '/backingfiles'],
    });

    const status = await manager.readSystemStatus();

    expect(status).not.toBeNull();
    expect(status?.uptime).toBeGreaterThanOrEqual(0);
    expect(status?.drivesActive).toBeDefined();
    expect(status?.totalSpace).toBeGreaterThanOrEqual(0);
    expect(status?.freeSpace).toBeGreaterThanOrEqual(0);
    expect(status?.partitions).toHaveLength(4);
    expect(status?.partitions.map((partition) => partition.mountPath)).toEqual([
      '/',
      '/backingfiles',
      '/boot/firmware',
      '/mutable',
    ]);
    expect(status?.partitions.find((partition) => partition.mountPath === '/')?.freeSpace).toBe(1932735283);
    expect(status?.partitions.find((partition) => partition.mountPath === '/boot/firmware')?.freeSpace).toBe(440401920);
    expect(status?.partitions.find((partition) => partition.mountPath === '/mutable')?.freeSpace).toBe(276824064);
    expect(status?.partitions.find((partition) => partition.mountPath === '/backingfiles')?.freeSpace).toBe(78309498880);
    expect(status?.numSnapshots).toBeGreaterThanOrEqual(0);
    expect(status?.pingUnloadedMs).toBeGreaterThan(0);
    expect(status?.packetLossUnloaded).toBe(0);
    expect(status?.pingLoadedMs).toBeGreaterThan(0);
    expect(status?.packetLossLoaded).toBe(0);
    expect(status?.pingTimeMs).toBe(status?.pingUnloadedMs);
    expect(status?.packetLoss).toBe(status?.packetLossUnloaded);
    expect(status?.networkHealthHistory.length).toBe(1);
    expect(status?.networkHealthHistory[0].pingUnloadedMs).toBeGreaterThan(0);
    expect(status?.networkHealthHistory[0].pingLoadedMs).toBeGreaterThan(0);
  });

  it('returns status with nullish network fields when ping fails', async () => {
    mockRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ip') {
        return {
          code: 0,
          stdout: 'default via 10.0.0.1 dev wlan0 proto dhcp src 10.0.0.5 metric 600\n',
          stderr: '',
        };
      }
      if (cmd === 'df') {
        if (args.length === 2) {
          return {
            code: 0,
            stdout: `${FULL_DF_OUTPUT}\n`,
            stderr: '',
          };
        }
        const mountPath = args.at(-1) ?? '';
        const line = DF_BY_PATH[mountPath];
        if (!line) {
          return { code: 1, stdout: '', stderr: 'mount path not configured in test' };
        }
        return {
          code: 0,
          stdout: `Filesystem     1B-blocks      Used Available Use% Mounted on\n${line}\n`,
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: '' };
    });

    const manager = new SystemStatusManager({
      commandRunner: mockCommandRunner,
      thermalZonePath: '/dev/null',
      partitionMountPoints: ['/mutable', '/backingfiles'],
    });

    const status = await manager.readSystemStatus();

    expect(status).not.toBeNull();
    expect(status?.pingUnloadedMs).toBeUndefined();
    expect(status?.packetLossUnloaded).toBeUndefined();
    expect(status?.pingLoadedMs).toBeUndefined();
    expect(status?.packetLossLoaded).toBeUndefined();
    expect(status?.pingTimeMs).toBeUndefined();
    expect(status?.packetLoss).toBeUndefined();
    expect(status?.partitions).toHaveLength(4);
    expect(status?.networkHealthHistory.length).toBe(1);
    expect(status?.networkHealthHistory[0].pingUnloadedMs).toBeUndefined();
    expect(status?.networkHealthHistory[0].pingLoadedMs).toBeUndefined();
  });

  it('captures all SD card partitions from full df output even when configured list is partial', async () => {
    mockRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ip') {
        return {
          code: 0,
          stdout: 'default via 10.0.0.1 dev wlan0 proto dhcp src 10.0.0.5 metric 600\n',
          stderr: '',
        };
      }
      if (cmd === 'df') {
        if (args.length === 2) {
          return {
            code: 0,
            stdout: `${FULL_DF_OUTPUT}\n`,
            stderr: '',
          };
        }
        return { code: 1, stdout: '', stderr: 'single-path df not expected' };
      }
      if (cmd === 'ping') {
        return {
          code: 0,
          stdout: 'PING 192.168.1.1: 56 data bytes\n--- 192.168.1.1 ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss\nround-trip min/avg/max/stddev = 1.000/2.500/4.000/1.000 ms\n',
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: '' };
    });

    const manager = new SystemStatusManager({
      commandRunner: mockCommandRunner,
      thermalZonePath: '/dev/null',
      partitionMountPoints: ['/mutable'],
    });

    const status = await manager.readSystemStatus();
    expect(status?.partitions.map((partition) => partition.mountPath)).toEqual([
      '/',
      '/backingfiles',
      '/boot/firmware',
      '/mutable',
    ]);
  });
});

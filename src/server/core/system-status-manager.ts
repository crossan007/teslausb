/**
 * Legacy lineage:
 * - teslausb-www/html/cgi-bin/status.sh (system status and diagnostics response surface)
 */
import { readFile } from 'fs/promises';
import { logger } from './logger';
import { NetworkHealthSample, SystemStatus } from '../../types';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { SnapshotManager } from '../orchestrator/snapshot-manager';

export interface SystemStatusManagerOptions {
  snapshotManager?: SnapshotManager;
  defaultGateway?: string;
  pingPacketSize?: number;
  thermalZonePath?: string;
  commandRunner?: CommandRunner;
  networkHealthPollMs?: number;
  networkHealthHistorySize?: number;
}

export class SystemStatusManager {
  private readonly snapshotManager?: SnapshotManager;
  private readonly defaultGateway: string;
  private readonly pingPacketSize: number;
  private readonly thermalZonePath: string;
  private readonly commandRunner: CommandRunner;
  private readonly networkHealthPollMs: number;
  private readonly networkHealthHistorySize: number;
  private readonly networkHealthHistory: NetworkHealthSample[] = [];
  private networkProbeInFlight: Promise<void> | null = null;

  constructor(options: SystemStatusManagerOptions = {}) {
    this.snapshotManager = options.snapshotManager;
    this.defaultGateway = options.defaultGateway ?? '192.168.1.1';
    this.pingPacketSize = options.pingPacketSize ?? 1024;
    this.thermalZonePath = options.thermalZonePath ?? '/sys/class/thermal/thermal_zone0/temp';
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.networkHealthPollMs = Math.max(1000, options.networkHealthPollMs ?? 60_000);
    this.networkHealthHistorySize = Math.max(1, options.networkHealthHistorySize ?? 5);

    const timer = setInterval(() => {
      void this.refreshNetworkHealthCache();
    }, this.networkHealthPollMs);
    timer.unref?.();
  }

  async readSystemStatus(): Promise<SystemStatus | null> {
    try {
      const uptime = Math.floor(process.uptime());
      await this.ensureNetworkHealthSample();
      const [diskUsage, numSnapshots, cpuTemp] = await Promise.all([
        this.getDiskUsage(),
        this.getSnapshotCount(),
        this.getCpuTemperature(),
      ]);

      const history = this.getNetworkHealthHistorySnapshot();
      const latestNetworkHealth = history.at(-1);

      const status: SystemStatus = {
        uptime,
        drivesActive: true,
        totalSpace: diskUsage?.total ?? 0,
        freeSpace: diskUsage?.free ?? 0,
        numSnapshots,
        cpuTempC: cpuTemp ?? undefined,
        pingTimeMs: latestNetworkHealth?.pingMs,
        packetLoss: latestNetworkHealth?.packetLoss,
        networkHealthHistory: history,
      };

      return status;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to read system status');
      return null;
    }
  }

  private async getDiskUsage(): Promise<{ total: number; free: number } | null> {
    try {
      const result = await this.commandRunner.run('df', ['-B', '1', '/mutable']);
      if (result.code !== 0) {
        return null;
      }

      const lines = result.stdout.trim().split('\n');
      if (lines.length < 2) {
        return null;
      }

      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      const free = total - used;

      return { total, free };
    } catch (error) {
      logger.debug({ err: error }, 'Failed to read disk usage');
      return null;
    }
  }

  private async getSnapshotCount(): Promise<number> {
    try {
      if (!this.snapshotManager) {
        return 0;
      }
      const ids = await this.snapshotManager.listSnapshotIds();
      return ids.length;
    } catch (error) {
      logger.debug({ err: error }, 'Failed to count snapshots');
      return 0;
    }
  }

  private async getNetworkHealth(): Promise<{
    pingMs: number;
    packetLoss: number;
  } | null> {
    try {
      // Bound ping latency so /api/system-status stays responsive even when gateway is unreachable.
      // -n: numeric output (no reverse DNS)
      // -c 2: two probes
      // -W 1: one-second per-reply timeout
      // -w 3: three-second overall deadline
      const result = await this.commandRunner.run('ping', [
        '-n',
        '-c',
        '2',
        '-s',
        String(this.pingPacketSize),
        '-W',
        '1',
        '-w',
        '3',
        this.defaultGateway,
      ], {
        timeout: 4000,
      });

      if (result.code !== 0) {
        logger.debug({ gateway: this.defaultGateway }, 'Ping failed');
        return null;
      }

      // Parse ping output for min/avg/max/stddev and packet loss
      // Format: "round-trip min/avg/max/stddev = X.XXX/Y.YYY/Z.ZZZ/W.WWW ms"
      const rtMatch = result.stdout.match(
        /min\/avg\/max\/[a-z]+\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/i,
      );
      const lossMatch = result.stdout.match(/(\d+(?:\.\d+)?)%\s+packet loss/i);

      if (!rtMatch) {
        return null;
      }

      const avgMs = parseFloat(rtMatch[2]);
      const packetLoss = lossMatch ? parseFloat(lossMatch[1]) : 0;

      return {
        pingMs: Math.round(avgMs * 100) / 100,
        packetLoss: Math.round(packetLoss * 100) / 100,
      };
    } catch (error) {
      logger.debug({ err: error }, 'Failed to measure network health');
      return null;
    }
  }

  private async ensureNetworkHealthSample(): Promise<void> {
    if (this.networkHealthHistory.length > 0) {
      return;
    }
    await this.refreshNetworkHealthCache();
  }

  private getNetworkHealthHistorySnapshot(): NetworkHealthSample[] {
    return this.networkHealthHistory.map((sample) => ({ ...sample }));
  }

  private async refreshNetworkHealthCache(): Promise<void> {
    if (this.networkProbeInFlight) {
      return this.networkProbeInFlight;
    }

    this.networkProbeInFlight = (async () => {
      const measured = await this.getNetworkHealth();
      this.networkHealthHistory.push({
        timestampMs: Date.now(),
        pingMs: measured?.pingMs,
        packetLoss: measured?.packetLoss,
      });

      if (this.networkHealthHistory.length > this.networkHealthHistorySize) {
        this.networkHealthHistory.splice(
          0,
          this.networkHealthHistory.length - this.networkHealthHistorySize,
        );
      }
    })();

    try {
      await this.networkProbeInFlight;
    } finally {
      this.networkProbeInFlight = null;
    }
  }

  private async getCpuTemperature(): Promise<number | null> {
    try {
      const tempRaw = await readFile(this.thermalZonePath, 'utf-8');
      const tempMilliC = parseInt(tempRaw.trim(), 10);
      return Math.round((tempMilliC / 1000) * 100) / 100;
    } catch (error) {
      logger.debug({ err: error }, 'Failed to read CPU temperature');
      return null;
    }
  }
}

export const systemStatusManager = new SystemStatusManager();

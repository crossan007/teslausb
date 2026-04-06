/**
 * Legacy lineage:
 * - teslausb-www/html/cgi-bin/status.sh (system status and diagnostics response surface)
 */
import { readFile } from 'fs/promises';
import { logger } from './logger';
import { NetworkHealthSample, SystemStatus } from '../../types';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { SnapshotManager } from '../orchestrator/snapshot/snapshot-manager';

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
  private readonly loadedPingPacketSize: number;
  private readonly thermalZonePath: string;
  private readonly commandRunner: CommandRunner;
  private readonly networkHealthPollMs: number;
  private readonly networkHealthHistorySize: number;
  private readonly networkHealthHistory: NetworkHealthSample[] = [];
  private networkProbeInFlight: Promise<void> | null = null;

  constructor(options: SystemStatusManagerOptions = {}) {
    this.snapshotManager = options.snapshotManager;
    this.defaultGateway = options.defaultGateway ?? '192.168.1.1';
    this.loadedPingPacketSize = options.pingPacketSize ?? 1400;
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
      const uptime = await this.getUptimeSeconds();
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
        pingTimeMs: latestNetworkHealth?.pingUnloadedMs,
        packetLoss: latestNetworkHealth?.packetLossUnloaded,
        pingUnloadedMs: latestNetworkHealth?.pingUnloadedMs,
        packetLossUnloaded: latestNetworkHealth?.packetLossUnloaded,
        pingLoadedMs: latestNetworkHealth?.pingLoadedMs,
        packetLossLoaded: latestNetworkHealth?.packetLossLoaded,
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
    pingUnloadedMs?: number;
    packetLossUnloaded?: number;
    pingLoadedMs?: number;
    packetLossLoaded?: number;
  }> {
    try {
      const gateway = await this.getEffectiveGateway();

      const unloaded = await this.measurePing(gateway);
      const loaded = await this.measurePing(gateway, this.loadedPingPacketSize);

      if (!unloaded && !loaded) {
        logger.debug({ gateway }, 'All ping probes failed');
      }

      return {
        pingUnloadedMs: unloaded?.pingMs,
        packetLossUnloaded: unloaded?.packetLoss,
        pingLoadedMs: loaded?.pingMs,
        packetLossLoaded: loaded?.packetLoss,
      };
    } catch (error) {
      logger.debug({ err: error }, 'Failed to measure network health');
      return {};
    }
  }

  private async measurePing(
    gateway: string,
    packetSize?: number,
  ): Promise<{ pingMs: number; packetLoss: number } | null> {
    // Bound ping latency so /api/system-status stays responsive even when gateway is unreachable.
    // -n: numeric output (no reverse DNS)
    // -c 2: two probes
    // -W 1: one-second per-reply timeout
    // -w 3: three-second overall deadline
    const args = [
      '-n',
      '-c',
      '2',
    ];

    if (packetSize !== undefined) {
      args.push('-s', String(packetSize));
    }

    args.push('-W', '1', '-w', '3', gateway);

    const result = await this.commandRunner.run('ping', args, {
      timeout: 4000,
    });

    if (result.code !== 0) {
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
  }

  private async getEffectiveGateway(): Promise<string> {
    const discoveredGateway = await this.discoverDefaultGateway();
    return discoveredGateway ?? this.defaultGateway;
  }

  private async discoverDefaultGateway(): Promise<string | null> {
    try {
      const result = await this.commandRunner.run('ip', ['-4', 'route', 'show', 'default'], {
        timeout: 2000,
      });
      if (result.code !== 0) {
        return null;
      }

      const lines = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const match = line.match(/\bvia\s+((?:\d{1,3}\.){3}\d{1,3})\b/);
        if (match) {
          return match[1];
        }
      }

      return null;
    } catch (error) {
      logger.debug({ err: error }, 'Failed to discover default gateway');
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
        pingUnloadedMs: measured.pingUnloadedMs,
        packetLossUnloaded: measured.packetLossUnloaded,
        pingLoadedMs: measured.pingLoadedMs,
        packetLossLoaded: measured.packetLossLoaded,
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

  private async getUptimeSeconds(): Promise<number> {
    try {
      const uptimeRaw = await readFile('/proc/uptime', 'utf-8');
      const firstField = uptimeRaw.trim().split(/\s+/)[0];
      const parsed = Number.parseFloat(firstField);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
      }
      return Math.floor(process.uptime());
    } catch (error) {
      logger.debug({ err: error }, 'Failed to read system uptime; using process uptime fallback');
      return Math.floor(process.uptime());
    }
  }
}

export const systemStatusManager = new SystemStatusManager();

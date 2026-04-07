import React from 'react';
import { useApi } from '../hooks';
import { SystemStatus } from '../../../types';

interface Props {
  wsMessage?: any;
  wsConnected: boolean;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function formatPartitionLabel(mountPath: string): string {
  if (mountPath === '/') {
    return 'root';
  }
  return mountPath.replace(/^\//, '');
}

export default function SystemStatusComponent({ wsMessage, wsConnected }: Props) {
  const { data: restData, loading, error } = useApi<SystemStatus>('/api/system-status', {
    interval: 10000,
    enabled: !wsConnected,
  });

  const data = wsMessage?.type === 'system-status-update' && wsMessage?.data
    ? (wsMessage.data as SystemStatus)
    : restData;

  if (loading && !data) {
    return <div className="panel system-status loading">Loading system status...</div>;
  }

  if (error) {
    return <div className="panel system-status error">Failed to load system status</div>;
  }

  if (!data) {
    return <div className="panel system-status">No system data available</div>;
  }

  const uptimeHours = Math.floor(data.uptime / 3600);
  const uptimeMinutes = Math.floor((data.uptime % 3600) / 60);

  const unloadedPingMs = data.pingUnloadedMs ?? data.pingTimeMs;
  const unloadedLoss = data.packetLossUnloaded ?? data.packetLoss;
  const loadedPingMs = data.pingLoadedMs;
  const loadedLoss = data.packetLossLoaded;

  const partitions = data.partitions ?? [];

  return (
    <div className="panel system-status">
      <h2>System Status</h2>
      
      <div className="status-grid">
        <div className="status-item">
          <label>Uptime</label>
          <value>
            {uptimeHours}h {uptimeMinutes}m
          </value>
        </div>

        <div className="status-item">
          <label>CPU Temp</label>
          <value className={data.cpuTempC ? (data.cpuTempC > 70 ? 'warning' : '') : ''}>
            {data.cpuTempC?.toFixed(1) ?? 'N/A'}°C
          </value>
        </div>

        <div className="status-item status-item--wide">
          <label>Disk Usage</label>
          <div className="partition-grid">
            {partitions.map((partition) => {
              const usedBytes = Math.max(0, partition.totalSpace - partition.freeSpace);
              const partitionUsedPercent = partition.totalSpace > 0
                ? ((usedBytes / partition.totalSpace) * 100).toFixed(1)
                : '0.0';

              return (
                <div key={partition.mountPath} className="partition-card">
                  <span className="partition-card-label">{formatPartitionLabel(partition.mountPath)}</span>
                  <span className="partition-card-value">{partitionUsedPercent}%</span>
                  <small>
                    {formatBytes(usedBytes)} used / {formatBytes(partition.freeSpace)} free
                  </small>
                </div>
              );
            })}
          </div>
        </div>

        <div className="status-item">
          <label>Network Ping</label>
          <value>{unloadedPingMs?.toFixed(1) ?? 'N/A'}ms</value>
          <small>
            Unloaded: {unloadedPingMs?.toFixed(1) ?? 'N/A'}ms
            {unloadedLoss !== undefined ? ` (${unloadedLoss}% loss)` : ''}
          </small>
          <small>
            Loaded: {loadedPingMs?.toFixed(1) ?? 'N/A'}ms
            {loadedLoss !== undefined ? ` (${loadedLoss}% loss)` : ''}
          </small>
        </div>

        <div className="status-item">
          <label>Active Snapshots</label>
          <value>{data.numSnapshots}</value>
        </div>

        <div className="status-item">
          <label>USB Gadget</label>
          <value>{data.drivesActive ? '✓ Active' : '✗ Inactive'}</value>
        </div>
      </div>
    </div>
  );
}

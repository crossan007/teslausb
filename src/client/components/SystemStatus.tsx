import React from 'react';
import { useApi } from '../hooks';
import { SystemStatus } from '../../../types';

interface Props {
  wsMessage?: any;
  wsConnected: boolean;
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

  const totalGB = (data.totalSpace / (1024 ** 3)).toFixed(1);
  const freeGB = (data.freeSpace / (1024 ** 3)).toFixed(1);
  const usedPercent = data.totalSpace > 0
    ? ((1 - data.freeSpace / data.totalSpace) * 100).toFixed(1)
    : '0.0';

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

        <div className="status-item">
          <label>Disk Usage</label>
          <value>{usedPercent}%</value>
          {(data.partitions ?? []).length > 0
            ? data.partitions.map((partition) => {
              const partitionTotalGB = (partition.totalSpace / (1024 ** 3)).toFixed(1);
              const partitionFreeGB = (partition.freeSpace / (1024 ** 3)).toFixed(1);
              const partitionUsedPercent = partition.totalSpace > 0
                ? ((1 - partition.freeSpace / partition.totalSpace) * 100).toFixed(1)
                : '0.0';

              return (
                <small key={partition.mountPath}>
                  {partition.mountPath}: {partitionFreeGB}GB free / {partitionTotalGB}GB total ({partitionUsedPercent}% used)
                </small>
              );
            })
            : (
              <small>
                {freeGB}GB free / {totalGB}GB total
              </small>
            )}
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

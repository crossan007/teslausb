import React from 'react';
import { useApi } from '../hooks';
import { SystemStatus } from '../../../types';

export default function SystemStatusComponent() {
  const { data, loading, error } = useApi<SystemStatus>('/api/system-status', {
    interval: 5000,
  });

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

  const totalGB = (data.totalSpace / (1024 ** 3)).toFixed(1);
  const freeGB = (data.freeSpace / (1024 ** 3)).toFixed(1);
  const usedPercent = ((1 - data.freeSpace / data.totalSpace) * 100).toFixed(1);

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
          <small>
            {freeGB}GB free / {totalGB}GB total
          </small>
        </div>

        <div className="status-item">
          <label>Network Ping</label>
          <value>{data.pingTimeMs?.toFixed(1) ?? 'N/A'}ms</value>
          <small>
            {data.packetLoss ? `${data.packetLoss}% loss` : 'optimal'}
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

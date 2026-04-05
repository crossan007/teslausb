import { describe, it, expect } from 'vitest';
import { SystemStatusManager } from './system-status-manager';

describe('SystemStatusManager', () => {
  it('returns system status with required fields', () => {
    const manager = new SystemStatusManager();
    const status = manager.readSystemStatus();

    expect(status).not.toBeNull();
    expect(status?.uptime).toBeGreaterThanOrEqual(0);
    expect(status?.drivesActive).toBeDefined();
    expect(status?.totalSpace).toBeGreaterThanOrEqual(0);
    expect(status?.freeSpace).toBeGreaterThanOrEqual(0);
    expect(status?.numSnapshots).toBeGreaterThanOrEqual(0);
  });
});

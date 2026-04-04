/**
 * Legacy lineage:
 * - teslausb-www/html/cgi-bin/status.sh (system status and diagnostics response surface)
 */
import { logger } from './logger';
import { SystemStatus } from '../types';

export class SystemStatusManager {
  readSystemStatus(): SystemStatus | null {
    try {
      const status: SystemStatus = {
        uptime: Math.floor(process.uptime()),
        drivesActive: true,
        totalSpace: 0,
        freeSpace: 0,
        numSnapshots: 0,
      };

      return status;
    } catch (error) {
      logger.warn({ error }, 'Failed to read system status');
      return null;
    }
  }
}

export const systemStatusManager = new SystemStatusManager();

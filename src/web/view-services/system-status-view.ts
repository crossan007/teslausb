import { SystemStatus } from '../../types';
import { SystemStatusManager } from '../../core/system-status-manager';
import { BaseViewService } from './base-view-service';

/**
 * Provides current system health metrics (refreshed on-demand)
 */
export class SystemStatusView extends BaseViewService<SystemStatus | null> {
  constructor(private readonly statusManager: SystemStatusManager) {
    super();
  }

  snapshot(): SystemStatus | null {
    // Note: This is synchronous wrapper; actual reads are async
    // WebSocket/REST handlers will call readSystemStatus() async
    return null;
  }

  /**
   * Async version for REST/WebSocket handlers
   */
  async readStatus(): Promise<SystemStatus | null> {
    return this.statusManager.readSystemStatus();
  }
}

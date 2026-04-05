/**
 * TeslaUSB service entry point.
 * Starts the orchestrator (clip archiving loop) and the web API server
 * in the same process, as run by teslausb-node.service.
 */
import { configLoader } from './config';
import { logger } from './core';
import { SystemStatusManager } from './core/system-status-manager';
import { startOrchestrator } from './orchestrator';
import { WebServerIntegration } from './web';

async function main(): Promise<void> {
  const config = configLoader.get();

  const { eventBus, snapshotManager } = await startOrchestrator(config);

  const statusManager = new SystemStatusManager({
    snapshotManager,
    defaultGateway: config.systemStatusDefaultGateway,
    pingPacketSize: config.systemStatusPingPacketSize,
  });

  const webServer = new WebServerIntegration(eventBus, statusManager, snapshotManager, config);
  await webServer.start();

  logger.info('TeslaUSB service running');

  await new Promise<void>(() => {
    // Keep alive; orchestrator and web server drive execution via event loops.
  });
}

main().catch((error) => {
  logger.error({ error }, 'TeslaUSB service failed to start');
  process.exit(1);
});

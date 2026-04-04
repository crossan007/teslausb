/**
 * Legacy lineage:
 * - run/archiveloop (service entrypoint replacement, currently dry-run only)
 */
import { logger } from '../core/logger';
import { Orchestrator } from './orchestrator';
import { NoneBackendStub } from './backends/stub-backend';

async function main(): Promise<void> {
  const orchestrator = new Orchestrator(new NoneBackendStub());

  const result = await orchestrator.runArchiveCycle({
    fromPath: '/tmp/mnt',
    files: [],
  });

  logger.info({ result }, 'Phase 2 dry-run orchestrator executed');
}

main().catch((error) => {
  logger.error({ error }, 'Orchestrator entrypoint failed');
  process.exit(1);
});

/**
 * Legacy lineage:
 * - run/awake_start
 * - run/awake_stop
 */
import { logger } from '../../core/logger';
import { CommandRunner, defaultCommandRunner } from '../../shared/command-runner';
import { ArchiveEvent, ArchiveEventHandler } from './event-bus';

/**
 * Runs keep-awake integration hooks for archive lifecycle events.
 */
export class TeslaApiInteropEventHandler implements ArchiveEventHandler {
  /**
   * Creates a Tesla API interop handler.
   */
  constructor(private readonly commandRunner: CommandRunner = defaultCommandRunner) {}

  /**
   * Triggers awake_start on archive-start and awake_stop on archive-finish.
   */
  async handle(event: ArchiveEvent): Promise<void> {
    if (event.type === 'archive-start') {
      await this.runHook('/root/bin/awake_start');
      return;
    }

    if (event.type === 'archive-finish') {
      await this.runHook('/root/bin/awake_stop');
    }
  }

  /**
   * Runs one hook script and logs non-zero exits.
   */
  private async runHook(scriptPath: string): Promise<void> {
    const result = await this.commandRunner.run(scriptPath, []);
    if (result.code !== 0) {
      logger.warn({ scriptPath, result }, 'Tesla API interop hook failed');
    }
  }
}

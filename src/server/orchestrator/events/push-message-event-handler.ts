/**
 * Legacy lineage:
 * - run/archiveloop (start/finish notification messages)
 * - run/send-push-message
 */
import { logger } from '../../core/logger';
import { CommandRunner, defaultCommandRunner } from '../../shared/command-runner';
import { ArchiveEvent, ArchiveEventHandler, ArchiveLifecycleEvent } from './event-bus';

/**
 * Sends legacy push notifications for archive lifecycle events.
 */
export class PushMessageEventHandler implements ArchiveEventHandler {
  /**
   * Creates a push-message handler.
   */
  constructor(
    private readonly notificationTitle: string,
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
  ) {}

  /**
   * Sends start/finish push notifications for supported archive events.
   */
  async handle(event: ArchiveEvent): Promise<void> {
    if (event.type !== 'archive-start' && event.type !== 'archive-finish') {
      return;
    }

    const phase = event.type === 'archive-start' ? 'start' : 'finish';
    const message = event.type === 'archive-start'
      ? this.buildStartMessage(event)
      : this.buildFinishMessage(event);

    const result = await this.commandRunner.run('/root/bin/send-push-message', [
      `${this.notificationTitle}:`,
      message,
      phase,
    ]);

    if (result.code !== 0) {
      logger.warn({ phase, result }, 'Push notification hook failed');
    }
  }

  /**
   * Builds start-phase notification text from event payload.
   */
  private buildStartMessage(event: ArchiveLifecycleEvent): string {
    return `Archiving ${event.totalFiles} file(s) including ${event.totalEvents} event folder(s) starting at ${new Date(event.occurredAtMs).toString()}`;
  }

  /**
   * Builds finish-phase notification text from event payload.
   */
  private buildFinishMessage(event: ArchiveLifecycleEvent): string {
    const prefix = event.succeeded ? 'Archiving completed successfully.' : 'Error during archiving.';
    const archivedCount = event.archivedFiles ?? 0;
    return `${prefix} Archived ${archivedCount} file(s).`;
  }
}

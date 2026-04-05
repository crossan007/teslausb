import { describe, expect, it } from 'vitest';
import { CommandResult, CommandRunner } from '../../shared/command-runner';
import { PushMessageEventHandler } from './push-message-event-handler';

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return { code: 0, stdout: '', stderr: '' };
  }

  async runStreaming(command: string, args: string[]): Promise<CommandResult> {
    return this.run(command, args);
  }
}

describe('PushMessageEventHandler', () => {
  it('sends start-phase notification for archive-start events', async () => {
    const runner = new FakeRunner();
    const handler = new PushMessageEventHandler('TeslaUSB', runner);

    await handler.handle({
      type: 'archive-start',
      occurredAtMs: 0,
      totalFiles: 3,
      totalEvents: 2,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('/root/bin/send-push-message');
    expect(runner.calls[0].args[0]).toBe('TeslaUSB:');
    expect(runner.calls[0].args[2]).toBe('start');
  });

  it('sends finish-phase notification for archive-finish events', async () => {
    const runner = new FakeRunner();
    const handler = new PushMessageEventHandler('TeslaUSB', runner);

    await handler.handle({
      type: 'archive-finish',
      occurredAtMs: Date.now(),
      totalFiles: 3,
      totalEvents: 2,
      archivedFiles: 2,
      succeeded: false,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args[2]).toBe('finish');
    expect(runner.calls[0].args[1]).toContain('Error during archiving.');
  });
});

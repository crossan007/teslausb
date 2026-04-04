import { describe, expect, it } from 'vitest';
import { CommandResult, CommandRunner } from '../../shared/command-runner';
import { TeslaApiInteropEventHandler } from './tesla-api-interop-event-handler';

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

describe('TeslaApiInteropEventHandler', () => {
  it('runs awake_start on archive-start', async () => {
    const runner = new FakeRunner();
    const handler = new TeslaApiInteropEventHandler(runner);

    await handler.handle({
      type: 'archive-start',
      occurredAtMs: Date.now(),
      totalFiles: 1,
      totalEvents: 1,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('/root/bin/awake_start');
  });

  it('runs awake_stop on archive-finish', async () => {
    const runner = new FakeRunner();
    const handler = new TeslaApiInteropEventHandler(runner);

    await handler.handle({
      type: 'archive-finish',
      occurredAtMs: Date.now(),
      totalFiles: 1,
      totalEvents: 1,
      archivedFiles: 1,
      succeeded: true,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('/root/bin/awake_stop');
  });
});

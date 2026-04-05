import { spawn, SpawnOptionsWithoutStdio } from 'child_process';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface StreamingCommandHandlers {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: SpawnOptionsWithoutStdio): Promise<CommandResult>;
  runStreaming(
    command: string,
    args: string[],
    handlers?: StreamingCommandHandlers,
    options?: SpawnOptionsWithoutStdio,
  ): Promise<CommandResult>;
}

export class ChildProcessCommandRunner implements CommandRunner {
  run(command: string, args: string[], options?: SpawnOptionsWithoutStdio): Promise<CommandResult> {
    return this.runStreaming(command, args, undefined, options);
  }

  runStreaming(
    command: string,
    args: string[],
    handlers?: StreamingCommandHandlers,
    options?: SpawnOptionsWithoutStdio,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        ...options,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const flushLines = (buffer: string, emit?: (line: string) => void): string => {
        const lines = buffer.split(/\r\n|\r|\n/);
        const remaining = lines.pop() ?? '';
        for (const line of lines) {
          emit?.(line);
        }
        return remaining;
      };

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        handlers?.onStdoutChunk?.(text);
        stdoutBuffer += text;
        stdoutBuffer = flushLines(stdoutBuffer, handlers?.onStdoutLine);
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        handlers?.onStderrChunk?.(text);
        stderrBuffer += text;
        stderrBuffer = flushLines(stderrBuffer, handlers?.onStderrLine);
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (stdoutBuffer.length > 0) {
          handlers?.onStdoutLine?.(stdoutBuffer);
        }
        if (stderrBuffer.length > 0) {
          handlers?.onStderrLine?.(stderrBuffer);
        }
        resolve({ code, stdout, stderr });
      });
    });
  }
}

export const defaultCommandRunner = new ChildProcessCommandRunner();

import { spawn } from 'node:child_process';

/**
 * Bounded child-process runner for ffmpeg/ffprobe.
 *
 * - no shell, fixed argv (user data never reaches a command line except as a
 *   scratch path the worker created);
 * - a minimal environment (no credentials, no proxy variables) so a decoder
 *   cannot reach the network even if a protocol were whitelisted;
 * - wall-clock timeout and abort signal → SIGKILL;
 * - stdout/stderr capture is capped so a hostile file cannot exhaust memory.
 */
export interface ToolLimits {
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}
export interface ToolResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
export class ToolError extends Error {
  constructor(
    readonly reason: 'timeout' | 'aborted' | 'spawn_failed' | 'exit' | 'output_limit',
    readonly result?: ToolResult,
  ) {
    super(`media tool ${reason}${result ? ` (exit ${result.code})` : ''}`);
    this.name = 'ToolError';
  }
}

const SAFE_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' };

export function runTool(bin: string, args: string[], limits: ToolLimits): Promise<ToolResult> {
  const maxStdout = limits.maxStdoutBytes ?? 4 * 1024 * 1024;
  const maxStderr = limits.maxStderrBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    if (limits.signal?.aborted) return reject(new ToolError('aborted'));
    let settled = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: SAFE_ENV });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0,
      errBytes = 0,
      failure: ToolError['reason'] | null = null;
    const kill = (reason: ToolError['reason']) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), limits.timeoutMs);
    const onAbort = () => kill('aborted');
    limits.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) return kill('output_limit');
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only a bounded head of diagnostics; never log it with user content.
      if (errBytes < maxStderr) err.push(chunk.subarray(0, maxStderr - errBytes));
      errBytes += chunk.length;
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', () => finish(() => reject(new ToolError('spawn_failed'))));
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
      };
      finish(() => {
        if (failure) reject(new ToolError(failure, result));
        else if (code !== 0) reject(new ToolError('exit', result));
        else resolve(result);
      });
    });
  });
}

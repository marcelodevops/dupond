import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SandboxOptions {
  worktreePath: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  allowNetwork?: boolean;
}

export interface SandboxExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
}

export class SandboxExecutor {
  private isDarwin: boolean;
  private hasSandboxExec: boolean;

  constructor() {
    this.isDarwin = os.platform() === 'darwin';
    this.hasSandboxExec = this.checkSandboxExec();
  }

  private checkSandboxExec(): boolean {
    if (!this.isDarwin) return false;
    try {
      const probe = spawnSync('which', ['sandbox-exec'], { encoding: 'utf-8' });
      return probe.status === 0;
    } catch {
      return false;
    }
  }

  public isAvailable(): { available: boolean; mechanism: string; error?: string } {
    if (this.isDarwin) {
      if (this.hasSandboxExec) {
        return { available: true, mechanism: 'macos-seatbelt' };
      }
      return { available: false, mechanism: 'macos-seatbelt', error: 'sandbox-exec binary not found on macOS' };
    }

    // On Linux or other systems, check for container or namespace tools
    const checkPodman = spawnSync('podman', ['--version'], { encoding: 'utf-8' });
    if (checkPodman.status === 0) {
      return { available: true, mechanism: 'podman-container' };
    }

    return {
      available: false,
      mechanism: 'none',
      error: 'Restricted execution sandbox unavailable: Host lacks required isolation mechanism (sandbox-exec or podman). Refusing to run untrusted code on host.',
    };
  }

  /**
   * Generates a strict macOS Seatbelt profile:
   * - Restricts write operations strictly to the worktree and private temp dir
   * - Blocks reading user home credentials (.ssh, .aws, .config, .gemini, .env)
   */
  private generateSeatbeltProfile(realWorktree: string, realTmp: string, allowNetwork: boolean): string {
    const home = os.homedir();
    const sensitiveDirs = [
      path.join(home, '.ssh'),
      path.join(home, '.aws'),
      path.join(home, '.config'),
      path.join(home, '.gemini'),
      path.join(home, '.gnupg'),
    ].filter((p) => fs.existsSync(p));

    const sensitiveDenials = sensitiveDirs
      .map((dir) => `(deny file-read* (subpath "${dir}"))`)
      .join('\n');

    const networkRule = allowNetwork ? '(allow network*)' : '(deny network*)';

    return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${realWorktree}"))
(allow file-write* (subpath "${realTmp}"))
(allow file-write* (subpath "/dev/null"))
(allow file-write* (subpath "/dev/zero"))
(allow file-write* (subpath "/dev/stdout"))
(allow file-write* (subpath "/dev/stderr"))
(allow file-write* (subpath "/dev/tty"))
${sensitiveDenials}
(deny file-read* (regex #"/\\.env.*$"))
${networkRule}
`;
  }

  /**
   * Builds a sanitized environment: no host secrets or ambient credentials.
   */
  private buildSanitizedEnv(customEnv?: Record<string, string>, sandboxTmp?: string): NodeJS.ProcessEnv {
    const allowedKeys = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'SYSTEMROOT'];
    const cleanEnv: NodeJS.ProcessEnv = {};

    for (const key of allowedKeys) {
      if (process.env[key]) cleanEnv[key] = process.env[key];
    }

    cleanEnv.NODE_ENV = 'test';
    cleanEnv.CI = 'true';
    if (sandboxTmp) {
      cleanEnv.TMPDIR = sandboxTmp;
      cleanEnv.HOME = sandboxTmp; // Divert HOME away from host home
    }

    if (customEnv) {
      // Never allow host secrets even if accidentally passed in customEnv
      const forbiddenPatterns = [/key/i, /token/i, /secret/i, /passwd/i, /credential/i, /gemini/i, /jira/i, /slack/i, /gh_/i, /github_/i];
      for (const [k, v] of Object.entries(customEnv)) {
        if (!forbiddenPatterns.some((pattern) => pattern.test(k))) {
          cleanEnv[k] = v;
        }
      }
    }

    return cleanEnv;
  }

  /**
   * Executes a command inside the sandbox.
   */
  public async execute(options: SandboxOptions): Promise<SandboxExecutionResult> {
    const availability = this.isAvailable();
    if (!availability.available) {
      throw new Error(`Execution blocked: ${availability.error}`);
    }

    const startTime = Date.now();
    const realWorktree = fs.realpathSync(path.resolve(options.worktreePath));
    const sandboxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp_sandbox_'));
    const realTmp = fs.realpathSync(sandboxTmp);

    const timeoutMs = options.timeoutMs || 45000;
    const cleanEnv = this.buildSanitizedEnv(options.env, realTmp);

    let execCmd: string;
    let execArgs: string[];

    if (this.isDarwin && this.hasSandboxExec) {
      const profile = this.generateSeatbeltProfile(realWorktree, realTmp, options.allowNetwork ?? false);
      execCmd = 'sandbox-exec';
      execArgs = ['-p', profile, '/bin/sh', '-c', `${options.command} ${options.args ? options.args.join(' ') : ''}`.trim()];
    } else {
      execCmd = '/bin/sh';
      execArgs = ['-c', `${options.command} ${options.args ? options.args.join(' ') : ''}`.trim()];
    }

    return new Promise<SandboxExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      // Spawn in a separate process group (detached: true) so we can kill the whole tree
      const child: ChildProcess = spawn(execCmd, execArgs, {
        cwd: realWorktree,
        env: cleanEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      const timer = setTimeout(() => {
        timedOut = true;
        this.killProcessTree(child);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          fs.rmSync(sandboxTmp, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }

        const durationMs = Date.now() - startTime;
        resolve({
          command: options.command,
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
          timedOut,
          killed,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        try {
          fs.rmSync(sandboxTmp, { recursive: true, force: true });
        } catch {
          // ignore
        }

        const durationMs = Date.now() - startTime;
        resolve({
          command: options.command,
          exitCode: 1,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs,
          timedOut,
          killed: true,
        });
      });
    });
  }

  private killProcessTree(child: ChildProcess): void {
    if (child.pid) {
      try {
        // Send SIGKILL to the entire process group
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
}

export const defaultSandboxExecutor = new SandboxExecutor();

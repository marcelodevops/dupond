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
  runId?: string;
  abortSignal?: AbortSignal;
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
  private hasPodman: boolean;
  private hasDocker: boolean;
  private activeProcesses: Map<string, ChildProcess> = new Map();

  constructor() {
    this.isDarwin = os.platform() === 'darwin';
    this.hasSandboxExec = this.checkBinary('sandbox-exec');
    this.hasPodman = this.checkBinary('podman');
    this.hasDocker = this.checkBinary('docker');
  }

  private checkBinary(name: string): boolean {
    try {
      const probe = spawnSync('which', [name], { encoding: 'utf-8' });
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

    // On Linux, strictly require podman or docker for container isolation
    if (this.hasPodman) {
      return { available: true, mechanism: 'podman-container' };
    }
    if (this.hasDocker) {
      return { available: true, mechanism: 'docker-container' };
    }

    return {
      available: false,
      mechanism: 'none',
      error: 'Restricted execution sandbox unavailable: Host lacks required container runtime (podman or docker) on Linux. Refusing to run untrusted code on host.',
    };
  }

  public killRun(runId: string): void {
    const child = this.activeProcesses.get(runId);
    if (child) {
      this.killProcessTree(child);
      this.activeProcesses.delete(runId);
    }
  }

  /**
   * Generates a strict macOS Seatbelt profile:
   * - Restricts write operations strictly to the worktree, git worktree metadata, and private temp dir
   * - Blocks reading any user home files outside the worktree, temp dir, and git repo objects
   */
  private generateSeatbeltProfile(
    realWorktree: string,
    realTmp: string,
    allowNetwork: boolean,
    gitDir?: string,
    gitCommonDir?: string
  ): string {
    const home = os.homedir();
    const networkRule = allowNetwork ? '(allow network*)' : '(deny network*)';

    let gitRules = '';
    if (gitDir) {
      gitRules += `\n(allow file-read-data (subpath "${gitDir}"))\n(allow file-write* (subpath "${gitDir}"))`;
    }
    if (gitCommonDir) {
      gitRules += `\n(allow file-read-data (subpath "${gitCommonDir}"))`;
    }

    return `(version 1)
(allow default)
(deny file-write*)
(allow file-read-metadata)
(deny file-read-data (subpath "${home}"))
(allow file-read-data (subpath "${realWorktree}"))
(allow file-read-data (subpath "${realTmp}"))${gitRules}
(allow file-write* (subpath "${realWorktree}"))
(allow file-write* (subpath "${realTmp}"))
(allow file-write* (subpath "/dev/null"))
(allow file-write* (subpath "/dev/zero"))
(allow file-write* (subpath "/dev/stdout"))
(allow file-write* (subpath "/dev/stderr"))
(allow file-write* (subpath "/dev/tty"))
(deny file-read* (regex #"/\\.env.*$"))
${networkRule}
`;
  }

  private resolveGitDirs(realWorktree: string): { gitDir?: string; gitCommonDir?: string } {
    const gitFilePath = path.join(realWorktree, '.git');
    if (!fs.existsSync(gitFilePath)) return {};
    try {
      const stat = fs.statSync(gitFilePath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitFilePath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitDirPath = path.resolve(realWorktree, match[1]);
          if (fs.existsSync(gitDirPath)) {
            const gitDir = fs.realpathSync(gitDirPath);
            let gitCommonDir: string | undefined;
            const commondirFile = path.join(gitDir, 'commondir');
            if (fs.existsSync(commondirFile)) {
              const commonRel = fs.readFileSync(commondirFile, 'utf-8').trim();
              const commonPath = path.resolve(gitDir, commonRel);
              if (fs.existsSync(commonPath)) {
                gitCommonDir = fs.realpathSync(commonPath);
              }
            }
            return { gitDir, gitCommonDir };
          }
        }
      } else if (stat.isDirectory()) {
        return { gitDir: fs.realpathSync(gitFilePath) };
      }
    } catch {
      // ignore
    }
    return {};
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

    if (options.abortSignal?.aborted) {
      return {
        command: options.command,
        exitCode: 130,
        stdout: '',
        stderr: 'Execution aborted prior to launch',
        durationMs: 0,
        timedOut: false,
        killed: true,
      };
    }

    const startTime = Date.now();
    const realWorktree = fs.realpathSync(path.resolve(options.worktreePath));
    const sandboxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp_sandbox_'));
    const realTmp = fs.realpathSync(sandboxTmp);

    const timeoutMs = options.timeoutMs || 45000;
    const cleanEnv = this.buildSanitizedEnv(options.env, realTmp);

    let execCmd: string;
    let execArgs: string[];

    const { gitDir, gitCommonDir } = this.resolveGitDirs(realWorktree);

    if (this.isDarwin) {
      const profile = this.generateSeatbeltProfile(realWorktree, realTmp, options.allowNetwork ?? false, gitDir, gitCommonDir);
      execCmd = 'sandbox-exec';
      execArgs = ['-p', profile, '/bin/sh', '-c', `${options.command} ${options.args ? options.args.join(' ') : ''}`.trim()];
    } else if (this.hasPodman || this.hasDocker) {
      execCmd = this.hasPodman ? 'podman' : 'docker';
      const containerMounts = [
        '-v', `${realWorktree}:${realWorktree}:rw`,
        '-v', `${realTmp}:${realTmp}:rw`,
      ];
      if (gitDir) {
        containerMounts.push('-v', `${gitDir}:${gitDir}:rw`);
      }
      if (gitCommonDir) {
        containerMounts.push('-v', `${gitCommonDir}:${gitCommonDir}:ro`);
      }

      execArgs = [
        'run', '--rm',
        '--network', options.allowNetwork ? 'bridge' : 'none',
        ...containerMounts,
        '-w', realWorktree,
        '--env', 'NODE_ENV=test',
        '--env', 'CI=true',
        'node:22-bookworm',
        '/bin/sh', '-c', `${options.command} ${options.args ? options.args.join(' ') : ''}`.trim(),
      ];
    } else {
      throw new Error('Restricted execution sandbox unavailable: Host lacks required container runtime (podman or docker) on Linux. Refusing to run untrusted code on host.');
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

      if (options.runId) {
        this.activeProcesses.set(options.runId, child);
      }

      const onAbort = () => {
        killed = true;
        this.killProcessTree(child);
      };

      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', onAbort);
      }

      child.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        this.killProcessTree(child);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onAbort);
        }
        if (options.runId) {
          this.activeProcesses.delete(options.runId);
        }
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
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onAbort);
        }
        if (options.runId) {
          this.activeProcesses.delete(options.runId);
        }
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

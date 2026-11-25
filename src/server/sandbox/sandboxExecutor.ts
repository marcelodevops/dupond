import { DomainError } from '../utils/errors';
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
  /** Invoke command and args directly without wrapping in /bin/sh -c */
  rawArgv?: boolean;
  /** Additional host files or directories to allow read-only inside the sandbox */
  extraReadPaths?: string[];
  /** Keep .git metadata and gitDir read-only inside the sandbox */
  gitReadOnly?: boolean;
  /** Specific paths (e.g. protected files/dirs inside worktree) denied write access */
  denyWritePaths?: string[];
  denyReadPaths?: string[];
  /** Specific env keys from options.env to preserve past secret-name filtering */
  preserveEnvKeys?: string[];
  /** Explicit host files to copy into the sandbox's private HOME (e.g. auth.json) */
  seedHomeFiles?: Array<{ sourcePath: string; targetRelToHome: string; required?: boolean }>;
  /** Explicit synthesized files to write into the sandbox's private HOME (e.g. hardened settings.json) */
  seedHomeContents?: Array<{ content: string; targetRelToHome: string; mode?: number; required?: boolean }>;
  /** Optional host-side hook invoked with the exact ephemeral sandbox HOME before spawning */
  prepareSandboxHome?: (sandboxHomeDir: string) => Promise<void> | void;
  /** Optional incremental output callback fired as stdout/stderr chunks arrive */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
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
  private activeContainers: Map<string, { containerName: string; runtime: string }> = new Map();
  private static imagePrepared: boolean = false;

  constructor() {
    this.isDarwin = os.platform() === 'darwin';
    this.hasSandboxExec = this.checkBinary('sandbox-exec');
    this.hasPodman = this.checkBinary('podman');
    this.hasDocker = this.checkBinary('docker');
  }

  public getContainerRuntime(): 'podman' | 'docker' | null {
    if (this.hasPodman) return 'podman';
    if (this.hasDocker) return 'docker';
    return null;
  }

  /**
   * Pre-pulls the container image with a dedicated preparation timeout
   * so command execution timeout is never consumed by image downloads.
   */
  public async ensureImage(image: string = 'node:22-bookworm', timeoutMs: number = 300000): Promise<boolean> {
    if (this.isDarwin) {
      return true;
    }
    const runtime = this.getContainerRuntime();
    if (!runtime) {
      return false;
    }

    if (SandboxExecutor.imagePrepared) {
      return true;
    }

    // Check if the image exists locally
    try {
      const inspectArgs = runtime === 'podman'
        ? ['image', 'exists', image]
        : ['image', 'inspect', image];
      const checkRes = spawnSync(runtime, inspectArgs, { stdio: 'pipe' });
      if (checkRes.status === 0) {
        SandboxExecutor.imagePrepared = true;
        return true;
      }
    } catch {
      // Proceed to pull
    }

    console.log(`[SandboxExecutor] Pre-pulling container image ${image} using ${runtime} (timeout: ${timeoutMs}ms)...`);
    return new Promise<boolean>((resolve) => {
      let timedOut = false;
      const child = spawn(runtime, ['pull', image], {
        stdio: 'inherit',
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        console.warn(`[SandboxExecutor] Pulling image ${image} timed out after ${timeoutMs}ms`);
        resolve(false);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) {
          SandboxExecutor.imagePrepared = true;
          resolve(true);
        } else {
          resolve(false);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.warn(`[SandboxExecutor] Error pulling image ${image}:`, err.message);
        resolve(false);
      });
    });
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

  public stopAndConfirmContainerRemoval(runtime: string, containerName: string): boolean {
    try {
      // 1. Immediately kill running container (SIGKILL avoids waiting on PID 1 grace period)
      spawnSync(runtime, ['kill', containerName], { stdio: 'pipe', encoding: 'utf-8' });
      // 2. Force-remove container
      spawnSync(runtime, ['rm', '-f', containerName], { stdio: 'pipe', encoding: 'utf-8' });
      // 3. Confirm removal via inspect
      const inspectRes = spawnSync(runtime, ['inspect', containerName], { stdio: 'pipe', encoding: 'utf-8' });
      return inspectRes.status !== 0;
    } catch {
      return false;
    }
  }

  public getActiveContainer(runId: string): { containerName: string; runtime: string } | undefined {
    return this.activeContainers.get(runId);
  }

  public killRun(runId: string): void {
    const container = this.activeContainers.get(runId);
    if (container) {
      this.stopAndConfirmContainerRemoval(container.runtime, container.containerName);
      this.activeContainers.delete(runId);
    }

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
  private formatSeatbeltPathRule(action: 'allow' | 'deny', op: string, targetPath: string): string {
    const escaped = targetPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let isDir = false;
    try {
      isDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      return `(${action} ${op} (subpath "${escaped}"))`;
    }
    if (fs.existsSync(targetPath)) {
      return `(${action} ${op} (literal "${escaped}"))`;
    }
    return `(${action} ${op} (literal "${escaped}"))\n(${action} ${op} (subpath "${escaped}"))`;
  }

  private escapePosixRegex(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private globToPosixRegexBody(glob: string): string {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') {
          if (glob[i + 2] === '/') {
            out += '(.*/)?';
            i += 2;
          } else {
            out += '.*';
            i += 1;
          }
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else {
        out += this.escapePosixRegex(ch);
      }
    }
    return out;
  }

  private resolveProtectedPathRules(
    realWorktree: string,
    patterns: string[],
    platform: 'darwin' | 'container'
  ): { seatbeltRules: string[]; containerReadOnlyPaths: string[] } {
    const seatbeltRules: string[] = [];
    const containerReadOnlyPaths: string[] = [];

    for (const raw of patterns) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (/[{}\[\]]|[!@+*?]\(/.test(trimmed)) {
        throw new DomainError(
          `Unsupported protected-path pattern "${raw}": brace expansions, character classes, and extglobs cannot be enforced by the OS sandbox.`
        );
      }

      const normalized = trimmed.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
      if (!normalized || normalized.split('/').includes('..')) {
        throw new DomainError(
          `Unsafe protected-path pattern "${raw}": empty or path-traversal segments are not permitted.`
        );
      }

      const isSubtreeStarStar = normalized.endsWith('/**');
      const isSubtreeStar = normalized.endsWith('/*');
      const subtreeBase = isSubtreeStarStar
        ? normalized.slice(0, -3)
        : isSubtreeStar
          ? normalized.slice(0, -2)
          : null;

      if (subtreeBase !== null && !/[*?]/.test(subtreeBase)) {
        const absDir = path.resolve(realWorktree, subtreeBase);
        if (absDir !== realWorktree && !absDir.startsWith(`${realWorktree}${path.sep}`)) {
          throw new DomainError(`Unsafe protected-path pattern "${raw}": resolves outside worktree.`);
        }
        const escaped = absDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        // Protect the directory itself as well as its entire subtree
        seatbeltRules.push(`(deny file-write* (literal "${escaped}"))`);
        seatbeltRules.push(`(deny file-write* (subpath "${escaped}"))`);

        if (platform === 'container') {
          if (!fs.existsSync(absDir)) {
            throw new DomainError(
              `Sandbox cannot enforce protected subtree pattern "${raw}" on Linux container runtime because "${subtreeBase}" does not exist to bind-mount read-only.`
            );
          }
          containerReadOnlyPaths.push(fs.realpathSync(absDir));
        }
        continue;
      }

      if (!/[*?]/.test(normalized)) {
        const absPath = path.resolve(realWorktree, normalized);
        if (absPath !== realWorktree && !absPath.startsWith(`${realWorktree}${path.sep}`)) {
          throw new DomainError(`Unsafe protected-path pattern "${raw}": resolves outside worktree.`);
        }
        seatbeltRules.push(this.formatSeatbeltPathRule('deny', 'file-write*', absPath));
        if (platform === 'container') {
          if (!fs.existsSync(absPath)) {
            throw new DomainError(
              `Sandbox cannot enforce protected path "${raw}" on Linux container runtime because "${normalized}" does not exist to bind-mount read-only.`
            );
          }
          containerReadOnlyPaths.push(fs.realpathSync(absPath));
        }
        continue;
      }

      // Filename or path glob (e.g. .env*, *.key, config/*.secret)
      if (platform === 'container') {
        throw new DomainError(
          `Sandbox cannot enforce protected-path glob "${raw}" on Linux container runtime: bind mounts cannot prevent creating new matching files inside a writable worktree.`
        );
      }
      const worktreePrefix = this.escapePosixRegex(realWorktree);
      const regexBody = normalized.includes('/')
        ? this.globToPosixRegexBody(normalized)
        : `(.*/)?${this.globToPosixRegexBody(normalized)}`;
      const seatbeltRegex = `^${worktreePrefix}/${regexBody}$`.replace(/"/g, '\\"');
      seatbeltRules.push(`(deny file-write* (regex #"${seatbeltRegex}"))`);
    }

    return { seatbeltRules, containerReadOnlyPaths };
  }

  private generateSeatbeltProfile(
    realWorktree: string,
    realTmp: string,
    allowNetwork: boolean,
    gitDir?: string,
    gitCommonDir?: string,
    extra?: {
      extraReadPaths?: string[];
      gitReadOnly?: boolean;
      denyWritePaths?: string[];
  denyReadPaths?: string[];
    }
  ): string {
    const home = os.homedir();
    const networkRule = allowNetwork ? '(allow network*)' : '(deny network*)';

    let gitRules = '';
    if (gitDir) {
      gitRules += `\n(allow file-read-data (subpath "${gitDir}"))`;
      if (!extra?.gitReadOnly) {
        gitRules += `\n(allow file-write* (subpath "${gitDir}"))`;
      }
    }
    if (gitCommonDir) {
      gitRules += `\n(allow file-read-data (subpath "${gitCommonDir}"))`;
    }

    const extraReadRules = (extra?.extraReadPaths ?? [])
      .map((p) => {
        const resolved = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
        return `\n${this.formatSeatbeltPathRule('allow', 'file-read-data', resolved)}\n${this.formatSeatbeltPathRule('allow', 'file-read-metadata', resolved)}`;
      })
      .join('');

    const denyWriteRuleLines: string[] = [];
    if (extra?.gitReadOnly) {
      denyWriteRuleLines.push(this.formatSeatbeltPathRule('deny', 'file-write*', path.join(realWorktree, '.git')));
      if (gitDir) denyWriteRuleLines.push(this.formatSeatbeltPathRule('deny', 'file-write*', gitDir));
      if (gitCommonDir) denyWriteRuleLines.push(this.formatSeatbeltPathRule('deny', 'file-write*', gitCommonDir));
    }
    if (extra?.denyWritePaths?.length) {
      const translated = this.resolveProtectedPathRules(realWorktree, extra.denyWritePaths, 'darwin');
      denyWriteRuleLines.push(...translated.seatbeltRules);
    }
    const denyReadRuleLines: string[] = [];
    for (const raw of extra?.denyReadPaths ?? []) {
      const normalized = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
      if (!normalized || normalized.split('/').includes('..') || /[*?{}\[\]]/.test(normalized)) {
        throw new DomainError(`Unsafe denyReadPaths entry "${raw}": only concrete relative paths inside worktree are permitted.`);
      }
      const absPath = path.resolve(realWorktree, normalized);
      if (absPath !== realWorktree && !absPath.startsWith(`${realWorktree}${path.sep}`)) {
        throw new DomainError(`Unsafe denyReadPaths entry "${raw}": resolves outside worktree.`);
      }
      const escaped = absPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      denyReadRuleLines.push(`(deny file-read-data (literal "${escaped}"))`);
      denyReadRuleLines.push(`(deny file-read-data (subpath "${escaped}"))`);
      denyReadRuleLines.push(`(deny file-write* (literal "${escaped}"))`);
      denyReadRuleLines.push(`(deny file-write* (subpath "${escaped}"))`);
    }
    const denyWriteRules = [...denyWriteRuleLines, ...denyReadRuleLines].map((r) => `\n${r}`).join('');

    return `(version 1)
(allow default)
(deny file-write*)
(allow file-read-metadata)
(deny file-read-data (subpath "${home}"))
(allow file-read-data (subpath "${realWorktree}"))
(allow file-read-data (subpath "${realTmp}"))${gitRules}${extraReadRules}
(allow file-write* (subpath "${realWorktree}"))
(allow file-write* (subpath "${realTmp}"))
(allow file-write* (subpath "/dev/null"))
(allow file-write* (subpath "/dev/zero"))
(allow file-write* (subpath "/dev/stdout"))
(allow file-write* (subpath "/dev/stderr"))
(allow file-write* (subpath "/dev/tty"))${denyWriteRules}
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
  private buildSanitizedEnv(
    customEnv?: Record<string, string>,
    sandboxTmp?: string,
    preserveEnvKeys?: string[],
    worktreePath?: string
  ): NodeJS.ProcessEnv {
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
    if (worktreePath) {
      cleanEnv.PWD = worktreePath; // Never inherit parent server's PWD
    }

    if (customEnv) {
      // Never allow host secrets even if accidentally passed in customEnv unless explicitly requested via preserveEnvKeys
      const forbiddenPatterns = [/key/i, /token/i, /secret/i, /passwd/i, /credential/i, /gemini/i, /openai/i, /jira/i, /slack/i, /gh_/i, /github_/i];
      const preserved = new Set(preserveEnvKeys ?? []);
      for (const [k, v] of Object.entries(customEnv)) {
        if (k === 'PWD' || k === 'OLDPWD') {
          continue;
        }
        if (k === 'HOME' && sandboxTmp) {
          const resolvedHome = path.resolve(v);
          if (resolvedHome === sandboxTmp || resolvedHome.startsWith(`${sandboxTmp}${path.sep}`)) {
            cleanEnv[k] = resolvedHome;
          }
          continue;
        }
        if (preserved.has(k) && !k.startsWith('DUPOND_')) {
          cleanEnv[k] = v;
          continue;
        }
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
      throw new DomainError(`Execution blocked: ${availability.error}`);
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

    // Required policy/auth material must exist before any subprocess can launch.
    try {
      const destination = (relative: string): string => {
        const dest = path.resolve(realTmp, relative);
        if (path.isAbsolute(relative) || !dest.startsWith(`${realTmp}${path.sep}`)) {
          throw new Error('Invalid sandbox seed destination');
        }
        return dest;
      };
      for (const seed of options.seedHomeFiles ?? []) {
        try {
          const dest = destination(seed.targetRelToHome);
          if (!fs.statSync(seed.sourcePath).isFile()) throw new Error('Seed source is not a file');
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          fs.copyFileSync(seed.sourcePath, dest);
          fs.chmodSync(dest, 0o600);
        } catch {
          if (seed.required !== false) throw new Error('Required sandbox credential initialization failed');
        }
      }
      for (const seed of options.seedHomeContents ?? []) {
        try {
          const dest = destination(seed.targetRelToHome);
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          fs.writeFileSync(dest, seed.content, { mode: seed.mode ?? 0o600 });
          fs.chmodSync(dest, seed.mode ?? 0o600);
        } catch {
          if (seed.required !== false) throw new Error('Required sandbox policy initialization failed');
        }
      }
      if (options.prepareSandboxHome) {
        await options.prepareSandboxHome(realTmp);
      }
    } catch {
      fs.rmSync(realTmp, { recursive: true, force: true });
      throw new DomainError('Prerequisite missing: Required sandbox initialization failed; no worker launched');
    }

    const timeoutMs = options.timeoutMs || 45000;
    const cleanEnv = this.buildSanitizedEnv(options.env, realTmp, options.preserveEnvKeys, realWorktree);

    let execCmd: string;
    let execArgs: string[];

    const { gitDir, gitCommonDir } = this.resolveGitDirs(realWorktree);

    let containerName: string | undefined;

    if (this.isDarwin) {
      const profile = this.generateSeatbeltProfile(
        realWorktree,
        realTmp,
        options.allowNetwork ?? false,
        gitDir,
        gitCommonDir,
        {
          extraReadPaths: options.extraReadPaths,
          gitReadOnly: options.gitReadOnly,
          denyWritePaths: options.denyWritePaths,
          denyReadPaths: options.denyReadPaths,
        }
      );
      execCmd = 'sandbox-exec';
      execArgs = options.rawArgv
        ? ['-p', profile, options.command, ...(options.args ?? [])]
        : ['-p', profile, '/bin/sh', '-c', `${options.command} ${options.args ? options.args.join(' ') : ''}`.trim()];
    } else if (this.hasPodman || this.hasDocker) {
      // Ensure image is ready before command launch so pull time is decoupled from command timeout
      if (!SandboxExecutor.imagePrepared) {
        const imageOk = await this.ensureImage('node:22-bookworm', 300000);
        if (!imageOk) {
          throw new DomainError('Sandbox container preparation failed: could not pull node:22-bookworm within preparation timeout');
        }
      }

      execCmd = this.hasPodman ? 'podman' : 'docker';
      containerName = `dupond-${options.runId ? options.runId.replace(/[^a-zA-Z0-9_.-]/g, '-') : Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (options.runId) {
        this.activeContainers.set(options.runId, {
          containerName,
          runtime: execCmd,
        });
      }

      const containerMounts = [
        '-v', `${realWorktree}:${realWorktree}:rw`,
        '-v', `${realTmp}:${realTmp}:rw`,
      ];
      if (gitDir) {
        containerMounts.push('-v', `${gitDir}:${gitDir}:${options.gitReadOnly ? 'ro' : 'rw'}`);
      }
      if (gitCommonDir) {
        containerMounts.push('-v', `${gitCommonDir}:${gitCommonDir}:ro`);
      }
      if (options.gitReadOnly) {
        const worktreeGit = path.join(realWorktree, '.git');
        if (fs.existsSync(worktreeGit)) {
          containerMounts.push('-v', `${worktreeGit}:${worktreeGit}:ro`);
        }
      }
      for (const p of options.extraReadPaths ?? []) {
        if (fs.existsSync(p)) {
          const resolved = fs.realpathSync(p);
          containerMounts.push('-v', `${resolved}:${resolved}:ro`);
        }
      }
      if (options.denyWritePaths?.length) {
        const translated = this.resolveProtectedPathRules(realWorktree, options.denyWritePaths, 'container');
        for (const roPath of translated.containerReadOnlyPaths) {
          containerMounts.push('-v', `${roPath}:${roPath}:ro`);
        }
      }
      if (options.denyReadPaths?.length) {
        const emptyMaskDir = path.join(realTmp, '.dp_empty_ro_mask');
        fs.mkdirSync(emptyMaskDir, { recursive: true, mode: 0o555 });
        for (const raw of options.denyReadPaths) {
          const normalized = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
          if (!normalized || normalized.split('/').includes('..') || /[*?{}\[\]]/.test(normalized)) {
            throw new DomainError(`Unsafe denyReadPaths entry "${raw}": only concrete relative paths inside worktree are permitted.`);
          }
          const absPath = path.resolve(realWorktree, normalized);
          if (absPath !== realWorktree && !absPath.startsWith(`${realWorktree}${path.sep}`)) {
            throw new DomainError(`Unsafe denyReadPaths entry "${raw}": resolves outside worktree.`);
          }
          if (fs.existsSync(absPath)) {
            const isDir = fs.statSync(absPath).isDirectory();
            containerMounts.push('-v', `${isDir ? emptyMaskDir : '/dev/null'}:${absPath}:ro`);
          }
        }
      }

      const containerEnvFlags: string[] = [
        '--env', `HOME=${cleanEnv.HOME ?? '/tmp'}`,
        '--env', `TMPDIR=${cleanEnv.TMPDIR ?? '/tmp'}`,
        '--env', 'NODE_ENV=test',
        '--env', 'CI=true',
      ];
      for (const [k, v] of Object.entries(cleanEnv)) {
        if (v !== undefined && !['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'SYSTEMROOT', 'HOME', 'TMPDIR', 'NODE_ENV', 'CI'].includes(k)) {
          containerEnvFlags.push('--env', `${k}=${v}`);
        }
      }

      const containerCmdArgs = options.rawArgv
        ? [options.command, ...(options.args ?? [])]
        : ['/bin/sh', '-c', `${options.command} ${options.args ? options.args.join(' ') : ''}`.trim()];

      execArgs = [
        'run', '--rm',
        '--name', containerName,
        '--network', options.allowNetwork ? 'bridge' : 'none',
        ...containerMounts,
        '-w', realWorktree,
        ...containerEnvFlags,
        'node:22-bookworm',
        ...containerCmdArgs,
      ];
    } else {
      throw new DomainError('Restricted execution sandbox unavailable: Host lacks required container runtime (podman or docker) on Linux. Refusing to run untrusted code on host.');
    }

    // Container CLIs (rootless podman/docker) need host HOME/XDG_DATA_HOME to
    // access pre-pulled image storage instead of re-pulling 1.1 GB into
    // sandboxTmp on every run; container env remains isolated via --env flags.
    const spawnEnv = containerName ? process.env : cleanEnv;

    if (options.abortSignal?.aborted) {
      return {
        command: options.command,
        exitCode: -1,
        stdout: '',
        stderr: 'Execution aborted before start.',
        durationMs: Date.now() - startTime,
        timedOut: false,
        killed: true,
      };
    }

    return new Promise<SandboxExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      // Spawn in a separate process group (detached: true) so we can kill the whole tree
      const child: ChildProcess = spawn(execCmd, execArgs, {
        cwd: realWorktree,
        env: spawnEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (options.runId) {
        this.activeProcesses.set(options.runId, child);
      }

      let settled = false;
      const onAbort = () => {
        killed = true;
        this.killProcessTree(child);
        if (containerName && (this.hasPodman || this.hasDocker)) {
          this.stopAndConfirmContainerRemoval(execCmd, containerName);
          // If abort fired while podman/docker was still creating the container,
          // retry cleanup shortly after so conmon cannot keep pipes open.
          setTimeout(() => {
            if (!settled) {
              this.stopAndConfirmContainerRemoval(execCmd, containerName!);
            }
          }, 300).unref();
          if (options.runId) this.activeContainers.delete(options.runId);
        }
      };

      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', onAbort);
      }

      child.stdout?.on('data', (data) => {
        const text = data.toString('utf-8');
        stdout += text;
        try {
          options.onOutput?.('stdout', text);
        } catch {}
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString('utf-8');
        stderr += text;
        try {
          options.onOutput?.('stderr', text);
        } catch {}
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        if (containerName && (this.hasPodman || this.hasDocker)) {
          this.stopAndConfirmContainerRemoval(execCmd, containerName);
          if (options.runId) this.activeContainers.delete(options.runId);
        }
        this.killProcessTree(child);
      }, timeoutMs);

      child.on('close', (code) => {
        settled = true;
        clearTimeout(timer);
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onAbort);
        }
        if (options.runId) {
          this.activeProcesses.delete(options.runId);
          if (containerName) {
            this.activeContainers.delete(options.runId);
          }
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
          if (containerName) {
            this.activeContainers.delete(options.runId);
          }
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

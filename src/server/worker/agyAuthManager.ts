import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';

const DEFAULT_LOGIN_TTL_MS = 55_000;
const PROBE_TIMEOUT_MS = 10_000;
const TERM_GRACE_MS = 1_500;
const KILL_GRACE_MS = 1_500;
const MAX_PTY_BUFFER_CHARS = 32 * 1024;

export type AgyAuthSessionState =
  | 'idle'
  | 'starting'
  | 'awaiting_code'
  | 'submitting'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface AgyAuthStatusResponse {
  cliAvailable: boolean;
  executablePath: string | null;
  version: string | null;
  profileAuthenticated: boolean;
  availableModelsCount: number;
  session: {
    loginSessionId: string;
    state: AgyAuthSessionState;
    authUrl?: string;
    expiresAt?: string;
    error?: string;
  } | null;
}

export class AgyAuthError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function stripAnsiAndControls(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '\n');
}

export function resolveAgyExecutable(): string | null {
  const override = process.env.DUPOND_AGY_BIN?.trim();
  if (override) {
    return fs.existsSync(override) ? override : null;
  }
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(cmd, ['agy'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    return found && fs.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

export function resolveAgyProfileDir(): string {
  const override = process.env.DUPOND_AGY_PROFILE_DIR?.trim();
  const baseDir = override
    ? path.resolve(override)
    : path.join(path.dirname(path.resolve(process.env.DUPOND_DB_PATH || './dupond.db')), 'agy-profile');
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(baseDir, 0o700);
  return baseDir;
}

function buildIsolatedAgyEnv(profileDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  // Forward only test harness control flags if present; never forward host secrets or auth vars
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k.startsWith('FAKE_AGY_')) {
      env[k] = v;
    }
  }
  env.HOME = profileDir;
  env.TMPDIR = profileDir;
  env.TERM = 'xterm-256color';
  env.LINES = '40';
  env.COLUMNS = '140';
  env.ANTIGRAVITY_DISABLE_EMBEDDED_RIPGREP = 'true';
  return env;
}

export function probeAgyVersion(binPath: string): string | null {
  try {
    const out = execFileSync(binPath, ['--version'], {
      env: { PATH: process.env.PATH || '', TERM: 'dumb' },
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const match = out.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/);
    return match ? match[1] : out || null;
  } catch {
    return null;
  }
}

export interface ProbeAgyModelsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProbeAgyModelsResult {
  authenticated: boolean;
  models: string[];
  error?: string;
  aborted?: boolean;
  timedOut?: boolean;
}

/**
 * Non-inference check: lists available models using ONLY the dedicated profile directory.
 * Executes asynchronously with bounded timeout, cancellation propagation, and process-tree reaping.
 */
export function probeAgyProfileModels(
  profileDir: string,
  binPath?: string | null,
  options?: ProbeAgyModelsOptions,
): Promise<ProbeAgyModelsResult> {
  const exe = binPath ?? resolveAgyExecutable();
  if (!exe) {
    return Promise.resolve({
      authenticated: false,
      models: [],
      error: 'Antigravity CLI (agy) executable not found.',
    });
  }

  if (options?.signal?.aborted) {
    return Promise.resolve({
      authenticated: false,
      models: [],
      error: 'Model probe cancelled.',
      aborted: true,
    });
  }

  const timeoutMs = Math.max(1, options?.timeoutMs ?? PROBE_TIMEOUT_MS);

  return new Promise<ProbeAgyModelsResult>((resolve) => {
    const child = spawn(exe, ['models'], {
      env: buildIsolatedAgyEnv(profileDir),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const maxBytes = 256 * 1024;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killEscalationTimer: NodeJS.Timeout | undefined;

    const signalProbeGroup = (sig: NodeJS.Signals) => {
      if (child.pid && child.pid > 0) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Fall through to direct kill if not process-group leader
        }
      }
      try {
        child.kill(sig);
      } catch {
        // Ignore ESRCH if already exited
      }
    };

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    };

    const stopAndReap = (reason: 'abort' | 'timeout') => {
      if (settled) return;
      if (reason === 'abort') aborted = true;
      else timedOut = true;

      signalProbeGroup('SIGTERM');
      if (!killEscalationTimer) {
        killEscalationTimer = setTimeout(() => {
          signalProbeGroup('SIGKILL');
        }, 150);
      }
    };

    const onAbort = () => {
      stopAndReap('abort');
    };

    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    timeoutTimer = setTimeout(() => {
      stopAndReap('timeout');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) {
        stdout += chunk.toString('utf-8').slice(0, maxBytes - stdout.length);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) {
        stderr += chunk.toString('utf-8').slice(0, maxBytes - stderr.length);
      }
    });

    child.once('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        authenticated: false,
        models: [],
        error: aborted ? 'Model probe cancelled.' : timedOut ? 'Model probe timed out.' : 'Failed to list models.',
        ...(aborted ? { aborted: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (aborted) {
        resolve({ authenticated: false, models: [], error: 'Model probe cancelled.', aborted: true });
        return;
      }
      if (timedOut) {
        resolve({ authenticated: false, models: [], error: 'Model probe timed out.', timedOut: true });
        return;
      }
      if (code === 0) {
        const models = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^[a-z0-9][a-z0-9._-]+\s+\S+/.test(l))
          .map((l) => l.split(/\s+/)[0]);
        resolve({ authenticated: models.length > 0, models });
        return;
      }
      const msg = stderr || 'Not signed in';
      resolve({
        authenticated: false,
        models: [],
        error: msg.includes('Please sign in') ? 'Dedicated Antigravity profile is not signed in.' : 'Failed to list models.',
      });
    });
  });
}

/**
 * Verifies whether identified auth files from the dedicated profile are portable into Dupond's OS sandbox
 * without granting broad host HOME or Keychain access.
 */
export async function verifyAgySandboxPortability(
  profileDir: string,
  worktreePath: string,
  sandbox: SandboxExecutor = defaultSandboxExecutor,
): Promise<{ ok: boolean; exitCode: number; modelsCount: number; error?: string }> {
  const exe = resolveAgyExecutable();
  if (!exe) {
    return { ok: false, exitCode: -1, modelsCount: 0, error: 'Antigravity CLI (agy) executable not found.' };
  }

  const seedHomeFiles: Array<{ sourcePath: string; targetRelToHome: string }> = [];
  const candidateRelPaths = [
    '.gemini/jetski-standalone-oauth-token',
    '.gemini/antigravity-cli/settings.json',
    '.gemini/antigravity-cli/jetski_state.pbtxt',
    '.gemini/antigravity-cli/installation_id',
    '.gemini/antigravity-cli/jetbox_summaries_proto.pb',
  ];
  for (const rel of candidateRelPaths) {
    const full = path.join(profileDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      seedHomeFiles.push({ sourcePath: full, targetRelToHome: rel });
    }
  }

  const realBin = fs.realpathSync(exe);
  const res = await sandbox.execute({
    worktreePath,
    command: exe,
    args: ['models'],
    rawArgv: true,
    timeoutMs: 12_000,
    allowNetwork: true,
    gitReadOnly: true,
    extraReadPaths: [exe, path.dirname(exe), realBin, path.dirname(realBin)],
    seedHomeFiles,
    env: {
      ANTIGRAVITY_DISABLE_EMBEDDED_RIPGREP: 'true',
      TERM: 'dumb',
    },
  });

  const models = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-z0-9][a-z0-9._-]+\s+\S+/.test(l))
    .map((l) => l.split(/\s+/)[0]);

  return {
    ok: res.exitCode === 0 && models.length > 0,
    exitCode: res.exitCode,
    modelsCount: models.length,
    error: res.exitCode === 0 && models.length > 0 ? undefined : 'Sandbox execution could not authenticate from seeded profile files.',
  };
}

function extractValidatedOAuthUrl(cleanText: string): string | null {
  const matches = cleanText.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s\x1b"'<>]+/g);
  if (!matches || matches.length === 0) return null;
  for (const candidate of matches) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com') {
        return parsed.toString();
      }
    } catch {
      // Ignore partial/wrapped URL fragments
    }
  }
  return null;
}

export function validateSubmittedAuthCode(rawCode: unknown): string {
  if (typeof rawCode !== 'string') {
    throw new AgyAuthError(400, 'INVALID_CODE', 'Authorization code is required.');
  }
  if (/[\r\n\x00-\x1f\x7f]/.test(rawCode)) {
    throw new AgyAuthError(
      400,
      'INVALID_CODE_CHARACTERS',
      'Authorization code must not contain CR, LF, or control characters.',
    );
  }
  const trimmed = rawCode.trim();
  if (!trimmed || trimmed.length > 1024) {
    throw new AgyAuthError(400, 'INVALID_CODE', 'Authorization code must be 1 to 1024 characters.');
  }
  return trimmed;
}

interface PendingAgyLoginSession {
  loginSessionId: string;
  operatorBindingHash: string;
  state: AgyAuthSessionState;
  authUrl?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
  profileDir: string;
  binPath: string;
  child: ChildProcess;
  agyPgid?: number;
  ptyBuffer: string;
  sentEnter: boolean;
  suppressPtyCapture: boolean;
  exited: boolean;
  exitPromise: Promise<void>;
  expiryTimer: NodeJS.Timeout;
  probeAbortController: AbortController;
}

export interface UnconfirmedAgyProcessRecord {
  loginSessionId: string;
  bridgePid?: number;
  agyPgid?: number;
  reason: string;
}

const PTY_BRIDGE_PY = `
import os, pty, select, signal, subprocess, sys

cmd = sys.argv[1:]
master, slave = pty.openpty()
proc = subprocess.Popen(
    cmd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
    close_fds=True,
)
os.close(slave)

stdout_fd = sys.stdout.fileno()
os.write(stdout_fd, f"__DUPOND_AGY_PGID__:{proc.pid}\\n".encode("utf-8"))

def _forward_sig(signum, _frame):
    try:
        os.killpg(proc.pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, _forward_sig)
signal.signal(signal.SIGINT, _forward_sig)

stdin_fd = sys.stdin.fileno()
stdin_open = True

while True:
    rfds = [master] + ([stdin_fd] if stdin_open else [])
    r, _, _ = select.select(rfds, [], [], 0.1)
    if master in r:
        try:
            data = os.read(master, 4096)
            if not data:
                break
            os.write(stdout_fd, data)
        except OSError:
            break
    if stdin_fd in r:
        try:
            inp = os.read(stdin_fd, 4096)
            if not inp:
                stdin_open = False
            else:
                os.write(master, inp)
        except OSError:
            stdin_open = False
    if proc.poll() is not None:
        # Drain remaining output briefly
        try:
            while select.select([master], [], [], 0.05)[0]:
                data = os.read(master, 4096)
                if not data:
                    break
                os.write(stdout_fd, data)
        except OSError:
            pass
        break

try:
    os.close(master)
except OSError:
    pass
sys.exit(proc.returncode or 0)
`;

export function hashOperatorBinding(authHeaderOrToken?: string): string {
  const normalized = (authHeaderOrToken || '').replace(/^Bearer\s+/i, '').trim() || 'anonymous';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function isProcessGroupGone(pgid?: number): boolean {
  if (!pgid || pgid <= 0) return true;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err: any) {
    return err?.code === 'ESRCH';
  }
}

export class AgyAuthSessionManager {
  private activeSession: PendingAgyLoginSession | null = null;
  private unconfirmedProcesses: UnconfirmedAgyProcessRecord[] = [];
  private opQueue: Promise<unknown> = Promise.resolve();

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  public getUnconfirmedProcesses(): UnconfirmedAgyProcessRecord[] {
    return [...this.unconfirmedProcesses];
  }

  private getTtlMs(): number {
    const raw = Number(process.env.DUPOND_AGY_AUTH_TTL_MS || DEFAULT_LOGIN_TTL_MS);
    return Number.isFinite(raw) && raw >= 200 ? raw : DEFAULT_LOGIN_TTL_MS;
  }

  private getSubmitTimeoutMs(): number {
    const raw = Number(process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS || 12_000);
    return Number.isFinite(raw) && raw >= 100 ? raw : 12_000;
  }

  private getTermGraceMs(): number {
    const raw = Number(process.env.DUPOND_AGY_TERM_GRACE_MS || TERM_GRACE_MS);
    return Number.isFinite(raw) && raw >= 20 ? raw : TERM_GRACE_MS;
  }

  private getKillGraceMs(): number {
    const raw = Number(process.env.DUPOND_AGY_KILL_GRACE_MS || KILL_GRACE_MS);
    return Number.isFinite(raw) && raw >= 20 ? raw : KILL_GRACE_MS;
  }

  private isSessionProcessesGone(session: PendingAgyLoginSession): boolean {
    const bridgeGone =
      session.exited || session.child.exitCode !== null || session.child.signalCode !== null;
    const agyGone = isProcessGroupGone(session.agyPgid);
    return bridgeGone && agyGone;
  }

  private async waitForProcessTermination(
    session: PendingAgyLoginSession,
    graceMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (this.isSessionProcessesGone(session)) return true;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const stepMs = Math.min(40, remainingMs);
      if (!session.exited) {
        await Promise.race([
          session.exitPromise,
          new Promise<void>((r) => setTimeout(r, stepMs)),
        ]);
        if (this.isSessionProcessesGone(session)) return true;
      }
      const afterRaceRemaining = deadline - Date.now();
      if (afterRaceRemaining <= 0) break;
      await new Promise<void>((r) => setTimeout(r, Math.min(40, afterRaceRemaining)));
    }
    return this.isSessionProcessesGone(session);
  }

  private async terminateSessionProcess(session: PendingAgyLoginSession): Promise<void> {
    clearTimeout(session.expiryTimer);
    if (this.isSessionProcessesGone(session)) {
      session.exited = true;
      return;
    }

    const signalTargets = (sig: NodeJS.Signals) => {
      if (session.agyPgid && session.agyPgid > 0) {
        try {
          process.kill(-session.agyPgid, sig);
        } catch {}
      }
      if (session.child.pid) {
        try {
          process.kill(-session.child.pid, sig);
        } catch {
          try {
            session.child.kill(sig);
          } catch {}
        }
      }
    };

    signalTargets('SIGTERM');
    if (await this.waitForProcessTermination(session, this.getTermGraceMs())) {
      return;
    }

    signalTargets('SIGKILL');
    if (await this.waitForProcessTermination(session, this.getKillGraceMs())) {
      return;
    }

    const reason = `Failed to confirm termination of Antigravity login process (bridgePid=${session.child.pid ?? 'unknown'}, agyPgid=${session.agyPgid ?? 'unknown'}).`;
    if (!this.unconfirmedProcesses.some((p) => p.loginSessionId === session.loginSessionId)) {
      this.unconfirmedProcesses.push({
        loginSessionId: session.loginSessionId,
        bridgePid: session.child.pid,
        agyPgid: session.agyPgid,
        reason,
      });
    }
    throw new AgyAuthError(500, 'AGY_PROCESS_TERMINATION_UNCONFIRMED', reason);
  }

  private expireIfElapsed(session: PendingAgyLoginSession): void {
    if (
      (session.state === 'starting' || session.state === 'awaiting_code' || session.state === 'submitting') &&
      Date.now() >= session.expiresAt
    ) {
      session.state = 'expired';
      session.error = 'Pending Antigravity login session expired. Start a new login session.';
      session.probeAbortController.abort();
      void this.terminateSessionProcess(session).catch(() => {});
    }
  }

  public async getStatus(operatorToken?: string): Promise<AgyAuthStatusResponse> {
    const exe = resolveAgyExecutable();
    const version = exe ? probeAgyVersion(exe) : null;
    const profileDir = resolveAgyProfileDir();
    const profileCheck = await probeAgyProfileModels(profileDir, exe);

    let sessionView: AgyAuthStatusResponse['session'] = null;
    if (this.activeSession) {
      this.expireIfElapsed(this.activeSession);
      const callerHash = hashOperatorBinding(operatorToken);
      if (this.activeSession.operatorBindingHash === callerHash) {
        sessionView = {
          loginSessionId: this.activeSession.loginSessionId,
          state: this.activeSession.state,
          ...(this.activeSession.state === 'awaiting_code' && this.activeSession.authUrl
            ? { authUrl: this.activeSession.authUrl }
            : {}),
          expiresAt: new Date(this.activeSession.expiresAt).toISOString(),
          ...(this.activeSession.error ? { error: this.activeSession.error } : {}),
        };
      }
    }

    return {
      cliAvailable: Boolean(exe),
      executablePath: exe,
      version,
      profileAuthenticated: profileCheck.authenticated,
      availableModelsCount: profileCheck.models.length,
      session: sessionView,
    };
  }

  public async startLogin(operatorToken?: string): Promise<AgyAuthStatusResponse['session']> {
    return this.runSerialized(async () => {
      if (this.unconfirmedProcesses.length > 0) {
        throw new AgyAuthError(
          409,
          'AGY_PROFILE_LOCKED',
          `Dedicated Antigravity profile is locked because ${this.unconfirmedProcesses.length} previous login process(es) failed to confirm termination.`,
        );
      }

      const exe = resolveAgyExecutable();
      if (!exe) {
        throw new AgyAuthError(400, 'AGY_CLI_MISSING', 'Antigravity CLI (agy) executable not found.');
      }
      const profileDir = resolveAgyProfileDir();
      const operatorBindingHash = hashOperatorBinding(operatorToken);

      if (this.activeSession) {
        const prev = this.activeSession;
        this.expireIfElapsed(prev);
        const isActive =
          prev.state === 'starting' || prev.state === 'awaiting_code' || prev.state === 'submitting';
        if (isActive && prev.operatorBindingHash !== operatorBindingHash) {
          throw new AgyAuthError(
            403,
            'SESSION_OWNERSHIP_MISMATCH',
            'An active Antigravity login session belongs to a different authenticated operator and cannot be superseded.',
          );
        }
        if (isActive) {
          prev.state = 'cancelled';
          prev.error = 'Superseded by a new login session.';
          prev.probeAbortController.abort();
        }
        await this.terminateSessionProcess(prev);
        this.activeSession = null;
      }

      const ttlMs = this.getTtlMs();
      const loginSessionId = crypto.randomUUID();

      // Login-only invocation: run `agy` with NO prompt/arguments inside a PTY so no inference runs.
      const child = spawn('python3', ['-c', PTY_BRIDGE_PY, exe], {
        cwd: profileDir,
        env: buildIsolatedAgyEnv(profileDir),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let resolveExit!: () => void;
      const exitPromise = new Promise<void>((r) => {
        resolveExit = r;
      });

      const session: PendingAgyLoginSession = {
        loginSessionId,
        operatorBindingHash,
        state: 'starting',
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        profileDir,
        binPath: exe,
        child,
        ptyBuffer: '',
        sentEnter: false,
        suppressPtyCapture: false,
        exited: false,
        exitPromise,
        expiryTimer: setTimeout(() => {
          this.expireIfElapsed(session);
        }, ttlMs),
        probeAbortController: new AbortController(),
      };
      session.expiryTimer.unref();
      this.activeSession = session;

      child.once('exit', () => {
        session.exited = true;
        clearTimeout(session.expiryTimer);
        if (session.state === 'starting' || session.state === 'awaiting_code') {
          session.state = 'failed';
          session.error = 'Antigravity login process exited before authentication completed.';
        }
        resolveExit();
      });

      child.once('error', () => {
        session.exited = true;
        clearTimeout(session.expiryTimer);
        if (session.state === 'starting' || session.state === 'awaiting_code') {
          session.state = 'failed';
          session.error = 'Failed to launch Antigravity CLI login process.';
        }
        resolveExit();
      });

      const onPtyData = (chunk: Buffer) => {
        if (session.suppressPtyCapture) return; // Never capture or retain echoed authorization codes
        let combined = (session.ptyBuffer + chunk.toString('utf-8')).slice(-MAX_PTY_BUFFER_CHARS);
        const pgidMatch = combined.match(/__DUPOND_AGY_PGID__:(\d+)\r?\n?/);
        if (pgidMatch) {
          session.agyPgid = Number(pgidMatch[1]);
          combined = combined.replace(pgidMatch[0], '');
        }
        session.ptyBuffer = combined;
        const clean = stripAnsiAndControls(session.ptyBuffer);

        if (!session.sentEnter && clean.includes('Select login method')) {
          session.sentEnter = true;
          try {
            child.stdin?.write('\r');
          } catch {}
        }

        const url = extractValidatedOAuthUrl(clean);
        if (url) {
          session.authUrl = url;
        }

        if (
          session.state === 'starting' &&
          session.authUrl &&
          /paste the authorization code/i.test(clean)
        ) {
          session.state = 'awaiting_code';
        }
      };

      child.stdout?.on('data', onPtyData);
      child.stderr?.on('data', onPtyData);

      // Wait up to 8s for either awaiting_code (with validated authUrl) or immediate failure
      const waitDeadline = Date.now() + Math.min(8_000, ttlMs);
      while (Date.now() < waitDeadline) {
        if (session.state !== 'starting') break;
        await new Promise((r) => setTimeout(r, 80));
      }

      if (session.state === 'starting') {
        session.state = 'failed';
        session.error = 'Timed out waiting for Antigravity CLI OAuth prompt.';
        await this.terminateSessionProcess(session);
        throw new AgyAuthError(504, 'AGY_LOGIN_START_TIMEOUT', session.error);
      }

      if (session.state === 'failed') {
        await this.terminateSessionProcess(session);
        throw new AgyAuthError(500, 'AGY_LOGIN_START_FAILED', session.error || 'Failed to start login.');
      }

      if (session.state === 'cancelled' || session.state === 'expired') {
        await this.terminateSessionProcess(session);
        throw new AgyAuthError(409, 'LOGIN_SESSION_INTERRUPTED', session.error || `Login session ${session.state}.`);
      }

      return {
        loginSessionId: session.loginSessionId,
        state: session.state,
        authUrl: session.authUrl,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    });
  }

  private async waitForAbortOrDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  public async submitCode(
    operatorToken: string | undefined,
    loginSessionId: string,
    rawCode: unknown,
  ): Promise<{ state: AgyAuthSessionState; authenticated: boolean; modelsCount: number; error?: string }> {
    const code = validateSubmittedAuthCode(rawCode);
    let exchangeFailureCategory: 'invalid_grant' | 'exchange_failed' | null = null;
    let feedbackListener: ((chunk: Buffer) => void) | undefined;

    // Phase 1: serialize initial state validation, lock, and PTY code write
    const session = await this.runSerialized(async () => {
      const active = this.activeSession;
      if (!active || active.loginSessionId !== loginSessionId) {
        throw new AgyAuthError(
          404,
          'LOGIN_SESSION_NOT_FOUND',
          'Pending Antigravity login session was not found or was invalidated by a server restart. Start a new login.',
        );
      }

      if (active.operatorBindingHash !== hashOperatorBinding(operatorToken)) {
        throw new AgyAuthError(
          403,
          'SESSION_OWNERSHIP_MISMATCH',
          'Login session belongs to a different authenticated operator session.',
        );
      }

      this.expireIfElapsed(active);
      if (active.state === 'expired') {
        throw new AgyAuthError(410, 'LOGIN_SESSION_EXPIRED', active.error || 'Login session expired.');
      }
      if (active.state !== 'awaiting_code') {
        throw new AgyAuthError(
          409,
          'LOGIN_SESSION_NOT_AWAITING_CODE',
          `Cannot submit code while login session is in state "${active.state}".`,
        );
      }

      // Lock session immediately to prevent concurrent/replay submissions and suppress PTY echo capture
      active.state = 'submitting';
      active.suppressPtyCapture = true;
      active.ptyBuffer = '';

      // Never retain raw PTY chunks (which may contain echoed code); record only a fixed failure category
      feedbackListener = (chunk: Buffer) => {
        const clean = stripAnsiAndControls(chunk.toString('utf-8'));
        if (/invalid_grant/i.test(clean)) {
          exchangeFailureCategory = 'invalid_grant';
        } else if (/Got an error:|token exchange failed|OAuth setup failed/i.test(clean)) {
          exchangeFailureCategory = 'exchange_failed';
        }
      };
      active.child.stdout?.on('data', feedbackListener);
      active.child.stderr?.on('data', feedbackListener);

      let localCode = code;
      try {
        active.child.stdin?.write(`${localCode}\r`);
      } finally {
        localCode = '';
      }

      return active;
    });

    try {
      const submitDeadline = Math.min(session.expiresAt, Date.now() + this.getSubmitTimeoutMs());
      let authenticated = false;
      let modelsCount = 0;

      // Phase 2: async bounded verification outside opQueue so cancel/supersede can interrupt active probes
      while (Date.now() < submitDeadline) {
        if (
          this.activeSession !== session ||
          session.state !== 'submitting' ||
          session.probeAbortController.signal.aborted
        ) {
          break;
        }

        if (exchangeFailureCategory) {
          break;
        }

        const remainingMs = submitDeadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }

        const check = await probeAgyProfileModels(session.profileDir, session.binPath, {
          timeoutMs: remainingMs,
          signal: session.probeAbortController.signal,
        });

        // Re-check session identity and state after async probe in case cancel/supersede/expiry ran
        if (
          this.activeSession !== session ||
          session.state !== 'submitting' ||
          session.probeAbortController.signal.aborted
        ) {
          break;
        }

        if (check.authenticated) {
          authenticated = true;
          modelsCount = check.models.length;
          break;
        }

        if (session.exited) {
          break;
        }

        const sleepMs = Math.min(150, Math.max(0, submitDeadline - Date.now()));
        await this.waitForAbortOrDelay(sleepMs, session.probeAbortController.signal);
      }

      // Phase 3: serialize final state commit and process teardown
      return await this.runSerialized(async () => {
        if (feedbackListener) {
          session.child.stdout?.off('data', feedbackListener);
          session.child.stderr?.off('data', feedbackListener);
          feedbackListener = undefined;
        }

        if (
          this.activeSession !== session ||
          session.state !== 'submitting' ||
          session.probeAbortController.signal.aborted
        ) {
          if (this.activeSession === session) {
            await this.terminateSessionProcess(session).catch(() => {});
          }
          return {
            state: session.state,
            authenticated: false,
            modelsCount: 0,
            error: session.error || `Login session ${session.state} during submission.`,
          };
        }

        if (exchangeFailureCategory) {
          session.state = 'failed';
          session.error =
            exchangeFailureCategory === 'invalid_grant'
              ? 'Antigravity OAuth rejected the authorization code (invalid_grant). Start a new login.'
              : 'Antigravity OAuth token exchange failed. Verify the authorization code and start a new login.';
          await this.terminateSessionProcess(session);
          return { state: 'failed', authenticated: false, modelsCount: 0, error: session.error };
        }

        if (authenticated && Date.now() < session.expiresAt) {
          session.state = 'completed';
          await this.terminateSessionProcess(session);
          return { state: 'completed', authenticated: true, modelsCount };
        }

        if (Date.now() >= session.expiresAt) {
          session.state = 'expired';
          session.error = 'Pending Antigravity login session expired during code submission.';
        } else {
          session.state = 'failed';
          session.error = 'Antigravity CLI did not confirm authentication within the submission deadline.';
        }
        await this.terminateSessionProcess(session);
        return { state: session.state, authenticated: false, modelsCount: 0, error: session.error };
      });
    } finally {
      if (feedbackListener) {
        session.child.stdout?.off('data', feedbackListener);
        session.child.stderr?.off('data', feedbackListener);
      }
    }
  }

  public async cancelLogin(operatorToken?: string, loginSessionId?: string): Promise<void> {
    // Interrupt any active model probe immediately if the caller is authorized
    const snapshot = this.activeSession;
    if (
      snapshot &&
      (!loginSessionId || snapshot.loginSessionId === loginSessionId) &&
      snapshot.operatorBindingHash === hashOperatorBinding(operatorToken)
    ) {
      snapshot.probeAbortController.abort();
    }

    return this.runSerialized(async () => {
      const session = this.activeSession;
      if (!session) return;
      if (loginSessionId && session.loginSessionId !== loginSessionId) {
        throw new AgyAuthError(404, 'LOGIN_SESSION_NOT_FOUND', 'Pending Antigravity login session not found.');
      }
      if (session.operatorBindingHash !== hashOperatorBinding(operatorToken)) {
        throw new AgyAuthError(403, 'SESSION_OWNERSHIP_MISMATCH', 'Login session belongs to a different operator.');
      }
      session.probeAbortController.abort();
      session.state = 'cancelled';
      session.error = 'Login cancelled by operator.';
      await this.terminateSessionProcess(session);
    });
  }
}

export const defaultAgyAuthManager = new AgyAuthSessionManager();

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

/**
 * Non-inference check: lists available models using ONLY the dedicated profile directory.
 */
export function probeAgyProfileModels(profileDir: string, binPath?: string | null): {
  authenticated: boolean;
  models: string[];
  error?: string;
} {
  const exe = binPath ?? resolveAgyExecutable();
  if (!exe) {
    return { authenticated: false, models: [], error: 'Antigravity CLI (agy) executable not found.' };
  }
  try {
    const out = execFileSync(exe, ['models'], {
      env: buildIsolatedAgyEnv(profileDir),
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const models = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[a-z0-9][a-z0-9._-]+\s+\S+/.test(l))
      .map((l) => l.split(/\s+/)[0]);
    return { authenticated: models.length > 0, models };
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || 'Not signed in');
    return {
      authenticated: false,
      models: [],
      error: msg.includes('Please sign in') ? 'Dedicated Antigravity profile is not signed in.' : 'Failed to list models.',
    };
  }
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
  ptyBuffer: string;
  sentEnter: boolean;
  suppressPtyCapture: boolean;
  exited: boolean;
  exitPromise: Promise<void>;
  expiryTimer: NodeJS.Timeout;
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

def _forward_sig(signum, _frame):
    try:
        os.killpg(proc.pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, _forward_sig)
signal.signal(signal.SIGINT, _forward_sig)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
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

export class AgyAuthSessionManager {
  private activeSession: PendingAgyLoginSession | null = null;

  private getTtlMs(): number {
    const raw = Number(process.env.DUPOND_AGY_AUTH_TTL_MS || DEFAULT_LOGIN_TTL_MS);
    return Number.isFinite(raw) && raw >= 500 ? raw : DEFAULT_LOGIN_TTL_MS;
  }

  private async terminateSessionProcess(session: PendingAgyLoginSession): Promise<void> {
    clearTimeout(session.expiryTimer);
    if (session.exited || session.child.exitCode !== null || session.child.signalCode !== null) {
      session.exited = true;
      return;
    }

    const killGroup = (sig: NodeJS.Signals) => {
      if (!session.child.pid) return;
      try {
        process.kill(-session.child.pid, sig);
      } catch {
        try {
          session.child.kill(sig);
        } catch {}
      }
    };

    killGroup('SIGTERM');
    const exitedTerm = await Promise.race([
      session.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), TERM_GRACE_MS)),
    ]);

    if (!exitedTerm && !session.exited) {
      killGroup('SIGKILL');
      await Promise.race([
        session.exitPromise.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
      ]);
    }
  }

  private expireIfElapsed(session: PendingAgyLoginSession): void {
    if (
      (session.state === 'starting' || session.state === 'awaiting_code') &&
      Date.now() >= session.expiresAt
    ) {
      session.state = 'expired';
      session.error = 'Pending Antigravity login session expired. Start a new login session.';
      void this.terminateSessionProcess(session);
    }
  }

  public getStatus(operatorToken?: string): AgyAuthStatusResponse {
    const exe = resolveAgyExecutable();
    const version = exe ? probeAgyVersion(exe) : null;
    const profileDir = resolveAgyProfileDir();
    const profileCheck = probeAgyProfileModels(profileDir, exe);

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
    const exe = resolveAgyExecutable();
    if (!exe) {
      throw new AgyAuthError(400, 'AGY_CLI_MISSING', 'Antigravity CLI (agy) executable not found.');
    }
    const profileDir = resolveAgyProfileDir();

    if (this.activeSession) {
      const prev = this.activeSession;
      if (prev.state === 'starting' || prev.state === 'awaiting_code' || prev.state === 'submitting') {
        prev.state = 'cancelled';
        prev.error = 'Superseded by a new login session.';
      }
      await this.terminateSessionProcess(prev);
      this.activeSession = null;
    }

    const ttlMs = this.getTtlMs();
    const loginSessionId = crypto.randomUUID();
    const operatorBindingHash = hashOperatorBinding(operatorToken);

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
      session.ptyBuffer = (session.ptyBuffer + chunk.toString('utf-8')).slice(-MAX_PTY_BUFFER_CHARS);
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

    return {
      loginSessionId: session.loginSessionId,
      state: session.state,
      authUrl: session.authUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  public async submitCode(
    operatorToken: string | undefined,
    loginSessionId: string,
    rawCode: unknown,
  ): Promise<{ state: AgyAuthSessionState; authenticated: boolean; modelsCount: number; error?: string }> {
    const code = validateSubmittedAuthCode(rawCode);
    const session = this.activeSession;
    if (!session || session.loginSessionId !== loginSessionId) {
      throw new AgyAuthError(
        404,
        'LOGIN_SESSION_NOT_FOUND',
        'Pending Antigravity login session was not found or was invalidated by a server restart. Start a new login.',
      );
    }

    if (session.operatorBindingHash !== hashOperatorBinding(operatorToken)) {
      throw new AgyAuthError(
        403,
        'SESSION_OWNERSHIP_MISMATCH',
        'Login session belongs to a different authenticated operator session.',
      );
    }

    this.expireIfElapsed(session);
    if (session.state === 'expired') {
      throw new AgyAuthError(410, 'LOGIN_SESSION_EXPIRED', session.error || 'Login session expired.');
    }
    if (session.state !== 'awaiting_code') {
      throw new AgyAuthError(
        409,
        'LOGIN_SESSION_NOT_AWAITING_CODE',
        `Cannot submit code while login session is in state "${session.state}".`,
      );
    }

    // Lock session immediately to prevent concurrent/replay submissions and suppress PTY echo capture
    session.state = 'submitting';
    session.suppressPtyCapture = true;
    session.ptyBuffer = '';

    let exchangeFeedback = '';
    const feedbackListener = (chunk: Buffer) => {
      const clean = stripAnsiAndControls(chunk.toString('utf-8'));
      if (/Got an error:|token exchange failed|invalid_grant|OAuth setup failed/i.test(clean)) {
        exchangeFeedback = clean;
      }
    };
    session.child.stdout?.on('data', feedbackListener);
    session.child.stderr?.on('data', feedbackListener);

    let localCode = code;
    try {
      session.child.stdin?.write(`${localCode}\r`);
    } finally {
      localCode = '';
    }

    try {
      const verifyDeadline = Date.now() + 12_000;
      let authenticated = false;
      let modelsCount = 0;

      while (Date.now() < verifyDeadline) {
        if (exchangeFeedback) {
          session.state = 'failed';
          session.error = 'Antigravity OAuth token exchange failed. Verify the authorization code and start a new login.';
          return { state: 'failed', authenticated: false, modelsCount: 0, error: session.error };
        }

        const check = probeAgyProfileModels(session.profileDir, session.binPath);
        if (check.authenticated) {
          authenticated = true;
          modelsCount = check.models.length;
          break;
        }

        if (session.exited) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      if (authenticated) {
        session.state = 'completed';
        return { state: 'completed', authenticated: true, modelsCount };
      }

      session.state = 'failed';
      session.error = 'Antigravity CLI did not confirm authentication after submitting the code.';
      return { state: 'failed', authenticated: false, modelsCount: 0, error: session.error };
    } finally {
      session.child.stdout?.off('data', feedbackListener);
      session.child.stderr?.off('data', feedbackListener);
      await this.terminateSessionProcess(session);
    }
  }

  public async cancelLogin(operatorToken?: string, loginSessionId?: string): Promise<void> {
    const session = this.activeSession;
    if (!session) return;
    if (loginSessionId && session.loginSessionId !== loginSessionId) {
      throw new AgyAuthError(404, 'LOGIN_SESSION_NOT_FOUND', 'Pending Antigravity login session not found.');
    }
    if (session.operatorBindingHash !== hashOperatorBinding(operatorToken)) {
      throw new AgyAuthError(403, 'SESSION_OWNERSHIP_MISMATCH', 'Login session belongs to a different operator.');
    }
    session.state = 'cancelled';
    session.error = 'Login cancelled by operator.';
    await this.terminateSessionProcess(session);
  }
}

export const defaultAgyAuthManager = new AgyAuthSessionManager();

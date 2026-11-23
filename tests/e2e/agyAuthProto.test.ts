import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { expect as pwExpect } from 'playwright/test';

const SYNTH_AUTH_TOKEN = 'dp_e2e_agy_auth_token_12345';

async function getFreePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitForHealthy(url: string, proc: ChildProcess, logs: () => string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`App server exited early (${proc.exitCode}):\n${logs()}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}/api/health:\n${logs()}`);
}

describe('Antigravity CLI PTY onboarding browser E2E', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let profileDir: string;
  let fakeBin: string;
  let serverProc: ChildProcess | null = null;
  let serverPort: number;
  let serverUrl: string;
  let serverLogs = '';
  let browser: Browser;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-agy-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    profileDir = path.join(tmpDir, 'agy-profile');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    fakeBin = path.join(tmpDir, 'fake-agy');
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const tokenFile = path.join(process.env.HOME, '.gemini', 'jetski-standalone-oauth-token');
if (args.includes('--version')) { console.log('1.5.11'); process.exit(0); }
if (args[0] === 'models') {
  if (fs.existsSync(tokenFile)) {
    console.log('gemini-4-neon-high              Gemini 4 Neon (High)');
    console.log('gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)');
    process.exit(0);
  }
  console.error('Error: Please sign in to view available models.');
  process.exit(1);
}
if (args.length === 0) {
  process.stdout.write('Select login method:\\n> 1. Google OAuth\\n');
  let step = 'method';
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    if (step === 'method' && (buf.includes('\\r') || buf.includes('\\n'))) {
      buf = '';
      step = 'code';
      process.stdout.write(
        'https://accounts.google.com/o/oauth2/auth?client_id=e2e-client&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=e2e123\\n' +
        'If you are not automatically redirected, paste the authorization code below:\\n'
      );
      return;
    }
    if (step === 'code' && (buf.includes('\\r') || buf.includes('\\n'))) {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ token: 'e2e-oauth-token', auth_method: 'oauth' }), { mode: 0o600 });
    }
  });
}
`,
      { mode: 0o755 },
    );

    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(serverPort),
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_AUTH_TOKEN: SYNTH_AUTH_TOKEN,
      DUPOND_AGY_BIN: fakeBin,
      DUPOND_AGY_PROFILE_DIR: profileDir,
      NODE_ENV: 'production',
    };

    serverProc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (d) => { serverLogs += d.toString(); });
    serverProc.stderr?.on('data', (d) => { serverLogs += d.toString(); });

    await waitForHealthy(serverUrl, serverProc, () => serverLogs);
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    if (serverProc?.pid) {
      try { process.kill(-serverProc.pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('supports masked auth-code submission, reconnect on modal reopen, and zero browser storage retention', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);
    const page: Page = await context.newPage();

    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('agy-auth-badge')).toContainText('Not Signed In');
      await pwExpect(page.getByTestId('agy-auth-verification-states')).toContainText('Credentials present: No');
      await pwExpect(page.getByTestId('agy-auth-verification-states')).toContainText('Profile auth verified: No');
      await pwExpect(page.getByTestId('agy-auth-verification-states')).toContainText('Sandbox auth verified: Unverified');
      await pwExpect(page.getByTestId('agy-auth-verification-states')).toContainText('Coding execution verified: Unverified');

      if (process.platform === 'darwin') {
        await pwExpect(page.getByTestId('agy-auth-unavailable-reason')).toContainText('Keychain');
        await pwExpect(page.getByTestId('agy-auth-start-btn')).toBeDisabled();
        return;
      }

      await page.getByTestId('agy-auth-start-btn').click();
      await pwExpect(page.getByTestId('agy-auth-url')).toContainText('https://accounts.google.com/o/oauth2/auth?');
      await pwExpect(page.getByTestId('agy-auth-code-input')).toHaveAttribute('type', 'password');

      // Reconnect check: close modal and reopen -> pending session still active
      await page.getByTestId('close-app-settings-btn').click();
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('agy-auth-code-input')).toBeVisible();

      const synthCode = '4/0ASynthE2ECodeValue_DoNotStore';
      await page.getByTestId('agy-auth-code-input').fill(synthCode);
      await page.getByTestId('agy-auth-submit-btn').click();

      await pwExpect(page.getByTestId('agy-auth-badge')).toContainText('Authenticated (2 models)', { timeout: 15000 });
      await pwExpect(page.getByTestId('agy-auth-notice')).toContainText('Dedicated profile authenticated');

      // Verify auth code was never persisted in localStorage or sessionStorage
      const storageDump = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      assert.strictEqual(storageDump.includes(synthCode), false);
    } finally {
      await context.close();
    }
  }, 120000);
});

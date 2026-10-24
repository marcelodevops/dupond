/**
 * Track A — execution isolation, path containment, SSRF and credential tests.
 *
 * Kept separate from tests/guardrails.test.ts so Track A and Track B do not
 * collide on one file.
 */

import assert from 'assert';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
// Must precede the coordinator import: redirects server state to a temp file.
import { SENTINELS, SENTINEL_SECRETS, STATE_DIR, STATE_FILE } from './trackAStateFixture.js';
import { coordinator, REDACTED, isMaskedSecret } from '../src/server/coordinator.js';
import { runArtifactVerification } from '../src/server/artifactRunner.js';
import { handleRepositoryDispatch } from '../src/server/deliveryHandler.js';
import { safeRequest, EgressBlockedError } from '../src/server/egress.js';
import { isSafePathSegment, isPathLexicallyContained } from '../src/server/artifactPaths.js';

let passed = 0;
let total = 0;

async function runTest(name: string, fn: () => Promise<void> | void) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`✔ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`✘ [FAIL] ${name}:`, err?.message ?? err);
    throw err;
  }
}

/** Tasks that exercise path resolution must never touch the real state file. */
const TRAVERSAL_KEYS = ['../outside', '../../tmp/evil', '..', 'AEG-104/../../secret'];

async function main() {
  console.log('=== TRACK A: ISOLATION, CONTAINMENT, SSRF, CREDENTIALS ===\n');

  const ARTIFACTS_ROOT = fs.existsSync(path.resolve(import.meta.dirname, '../.dupond_artifacts'))
    ? path.resolve(import.meta.dirname, '../.dupond_artifacts')
    : path.resolve(import.meta.dirname, '../.aegis_artifacts');

  // --- 1. PATH CONTAINMENT ---

  await runTest('path-segment validator rejects traversal and dotfile-style keys', () => {
    for (const bad of [...TRAVERSAL_KEYS, 'a/b', 'a\\b', '', '.', '..', 'AEG 104', '-x', 'x'.repeat(65)]) {
      assert.strictEqual(isSafePathSegment(bad), false, `'${bad}' must be rejected`);
    }
    for (const good of ['AEG-104', 'task-101', 'AEG_104']) {
      assert.strictEqual(isSafePathSegment(good), true, `'${good}' must be accepted`);
    }
  });

  await runTest('containment is not defeated by path.resolve collapsing .. segments', () => {
    // A naive startsWith(base) check passes for this path, which is exactly how
    // the original bug stayed hidden.
    const sneaky = path.resolve(ARTIFACTS_ROOT, '../outside/implementation.js');
    assert.ok(sneaky.startsWith(path.resolve(ARTIFACTS_ROOT).replace(/\.(dupond|aegis)_artifacts$/, '')));
    assert.strictEqual(isPathLexicallyContained(ARTIFACTS_ROOT, sneaky), false);
    assert.strictEqual(isPathLexicallyContained(ARTIFACTS_ROOT, path.resolve(ARTIFACTS_ROOT, 'AEG-104')), true);
  });

  await runTest('quality gate fails closed for a traversal task key', async () => {
    const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'trackA-stage-'));
    fs.writeFileSync(path.join(staged, 'implementation.js'), 'const LEAKED = 1;\n');
    fs.writeFileSync(path.join(staged, 'spec.test.js'), "require('assert').strictEqual(1,1);\n");

    const traversalKey = path.relative(ARTIFACTS_ROOT, path.join(staged, 'x')).split(path.sep).slice(1).join(path.sep);
    const foreignKey = path.join('..', path.relative(ARTIFACTS_ROOT, staged));

    const verdict = await coordinator.verifyTaskQualityGates({
      id: 'trackA-1',
      key: foreignKey,
      status: 'review',
      dependencies: [],
      subtasks: [{ id: 'st-1', title: 'x', completed: true }],
    } as any);

    assert.strictEqual(verdict.passed, false, 'a key outside the artifact store must never pass');
    assert.ok(
      verdict.checks.some((c) => c.rule === 'Inspected Physical Code Artifact on Disk' && !c.passed),
      'artifact check must be the one that fails',
    );
    assert.ok(traversalKey.length > 0);
    fs.rmSync(staged, { recursive: true, force: true });
  });

  await runTest('delivery handler refuses an unsafe task key before reading any artifact', async () => {
    const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'trackA-deliv-'));
    const dest = path.join(staged, 'out');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(staged, 'crown.js'), 'process.env;\n');

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      task: { key: path.join('..', '..', 'tmp') },
      repoConfig: {
        type: 'local_directory',
        localPath: dest,
        targetDirectory: '.',
        localWriteMode: 'direct_write',
      },
    });

    assert.strictEqual(res.status, 400, 'must block with HTTP 400');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('not a safe artifact path segment'));
    assert.strictEqual(fs.readdirSync(dest).length, 0, 'must write nothing');
    fs.rmSync(staged, { recursive: true, force: true });
  });

  // --- 2. EXECUTION ISOLATION ---

  await runTest('artifact child process inherits no parent environment secrets', async () => {
    process.env.DUPOND_TRACKA_SECRET = 'do-not-leak';
    const run = await runArtifactVerification(
      "function probe() { return process.env.DUPOND_TRACKA_SECRET === 'do-not-leak'; }\n",
      "const assert = require('assert');\nassert.strictEqual(typeof probe, 'function');\n",
    );
    delete process.env.DUPOND_TRACKA_SECRET;

    assert.strictEqual(run.testsOk, true, `suite should pass: ${run.detail}`);

    // Read the env from inside the artifact's own execution.
    const leakRun = await runArtifactVerification(
      'const seen = process.env.DUPOND_TRACKA_SECRET || null;\nfunction gotSecret() { return seen; }\n',
      "const assert = require('assert');\nassert.strictEqual(gotSecret(), null, 'child must not see parent env');\n",
    );
    assert.strictEqual(leakRun.testsOk, true, `parent secret leaked to child: ${leakRun.detail}`);
  });

  await runTest('artifact cannot require modules outside the stdlib allowlist', async () => {
    const run = await runArtifactVerification(
      'function noop() { return 1; }\n',
      "const assert = require('assert');\nassert.strictEqual(typeof noop, 'function');\nrequire('fs');\n",
    );
    assert.strictEqual(run.testsOk, false, 'require("fs") must be refused');
    assert.ok(run.detail.includes('not available to artifact verification'), run.detail);

    const childRun = await runArtifactVerification(
      'function noop() { return 1; }\n',
      "const cp = require('child_process');\n",
    );
    assert.strictEqual(childRun.testsOk, false, 'require("child_process") must be refused');
  });

  await runTest('runaway artifact is killed by the timeout instead of hanging the server', async () => {
    const started = Date.now();
    const run = await runArtifactVerification('function spin() {}\n', 'while (true) {}\n', 1200);
    const elapsed = Date.now() - started;

    assert.strictEqual(run.testsOk, false, 'spin loop must not report success');
    assert.ok(run.detail.toLowerCase().includes('timed out'), `expected timeout, got: ${run.detail}`);
    assert.ok(elapsed < 6000, `timeout should land near the budget, took ${elapsed}ms`);
  });

  await runTest('artifact cannot fake a pass by terminating the runner', async () => {
    const run = await runArtifactVerification('function noop() {}\n', 'process.exit(0);\n', 2000);
    assert.strictEqual(run.testsOk, false, 'exit(0) must not be read as a passing suite');
    assert.ok(run.detail.length > 0);
  });

  await runTest('runner reports its own failure rather than throwing into the request', async () => {
    const run = await runArtifactVerification('function a() {}\n', 'a(;\n');
    assert.strictEqual(run.syntaxOk, false);
    assert.strictEqual(run.testsOk, false);
    assert.ok(run.detail.length > 0);
  });

  // --- 3. SSRF ---

  await runTest('loopback, private and metadata addresses are refused', async () => {
    const blocked = [
      'http://127.0.0.1/admin',
      'http://localhost:3000/x',
      'http://10.0.3.7/secrets',
      'http://172.16.0.1/secrets',
      'http://192.168.1.1/secrets',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
      'http://0.0.0.0/x',
      'http://100.64.0.1/x',
      'http://198.18.0.1/benchmark',
      'http://[::ffff:127.0.0.1]/x',
      'http://[::ffff:169.254.169.254]/x',
      'http://[fd12:3456::1]/ulaprefix',
      'http://[fe80::1]/linklocal',
    ];
    for (const url of blocked) {
      await assert.rejects(
        () => safeRequest(url, { allowedHosts: ['*'] }),
        (err: any) => err instanceof EgressBlockedError,
        `${url} should have been blocked`,
      );
    }
  });

  await runTest('non-http protocols and URL credentials are refused', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://1.1.1.1:70/x', 'http://[::ffff:8.8.8.8]:9/x']) {
      await assert.rejects(() => safeRequest(url, { allowedHosts: ['*'] }), EgressBlockedError);
    }
    await assert.rejects(
      () => safeRequest('http://user:pass@8.8.8.8/', { allowedHosts: ['*'] }),
      /credentials embedded/,
    );
  });

  await runTest('host allowlist is enforced before any network access', async () => {
    await assert.rejects(
      () => safeRequest('https://attacker.example/x', { allowedHosts: ['.atlassian.net'] }),
      /not in the allowlist/,
    );
    // Subdomain of an allowed pattern must be accepted by the allowlist stage
    // (it then fails later at DNS/connect, which is a different error).
    await assert.rejects(
      () => safeRequest('https://nonexistent-host-for-tracka.atlassian.net/x', { allowedHosts: ['.atlassian.net'] }),
      (err: any) => !/not in the allowlist/.test(err.message),
    );
  });

  await runTest('redirects are reported, never followed', async () => {
    const lands: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:8080/landed' });
        res.end();
      } else {
        lands.push(req.url || '');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('secret-payload');
      }
    });
    await new Promise<void>((resolve) => server.listen(8080, '127.0.0.1', resolve));

    try {
      const res = await safeRequest('http://127.0.0.1:8080/redirect', {
        allowedHosts: ['*'],
        allowPrivateAddressing: true,
      });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.location, 'http://127.0.0.1:8080/landed');
      assert.strictEqual(res.body, '', 'redirect body must not be returned');
      assert.deepStrictEqual(lands, [], 'the redirect target must never be contacted');
    } finally {
      server.close();
    }
  });

  await runTest('private addressing works only under its explicit opt-in', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(8081, '127.0.0.1', resolve));
    try {
      const open = await safeRequest('http://127.0.0.1:8081/', {
        allowedHosts: ['*'],
        allowPrivateAddressing: true,
      });
      assert.strictEqual(open.status, 200);
      assert.strictEqual(open.body, '{"ok":true}');

      await assert.rejects(
        () => safeRequest('http://127.0.0.1:8081/', { allowedHosts: ['*'] }),
        (err: any) => err instanceof EgressBlockedError,
      );
    } finally {
      server.close();
    }
  });

  await runTest('https targets negotiate TLS instead of hanging on a raw socket', async () => {
    // A plain HTTP listener on a TLS port: the client must reach the handshake
    // and fail fast. Sending the request in cleartext instead never answers.
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('not-tls');
    });
    await new Promise<void>((resolve) => server.listen(8082, '127.0.0.1', resolve));
    const started = Date.now();
    try {
      await assert.rejects(
        () =>
          safeRequest('https://127.0.0.1:8082/', {
            allowedHosts: ['*'],
            allowPrivateAddressing: true,
            timeoutMs: 6000,
          }),
        (err: any) => err instanceof EgressBlockedError && /TLS handshake/.test(err.message),
        'expected a TLS handshake failure',
      );
      assert.ok(Date.now() - started < 5000, 'handshake failure must not consume the whole timeout');
    } finally {
      server.close();
    }
  });

  // --- 4. CREDENTIAL EXPOSURE ---

  await runTest('state view masks every stored credential', () => {
    const secrets = coordinator.getIntegrationSecrets();
    const view = coordinator.getStateView();

    assert.strictEqual(secrets.jira.apiToken, SENTINELS.jiraApiToken, 'fixture must hold a real-shaped secret');
    assert.strictEqual(view.integrationConfig.jira.apiToken, REDACTED);
    assert.strictEqual(view.integrationConfig.slack.webhookUrl, REDACTED);
    assert.strictEqual(view.integrationConfig.repository.apiToken, REDACTED);
    assert.strictEqual(view.integrationConfig.customProviders[0].apiKeyHeader, REDACTED);

    // Whatever the shape of the state file, no stored credential may appear
    // anywhere on the wire view, not even in a field nobody thought to mask.
    const wire = JSON.stringify(view);
    for (const secret of SENTINEL_SECRETS) {
      assert.ok(!wire.includes(secret), `wire view leaked '${secret}'`);
    }

    // Non-secret fields must survive, or the integrations UI cannot render.
    assert.strictEqual(view.integrationConfig.jira.hostUrl, secrets.jira.hostUrl);
    assert.strictEqual(view.integrationConfig.jira.projectKey, secrets.jira.projectKey);
    assert.strictEqual(view.integrationConfig.jira.userEmail, SENTINELS.userEmail);
    assert.strictEqual(view.integrationConfig.slack.channel, secrets.slack.channel);
    assert.strictEqual(view.integrationConfig.repository.localWriteMode, secrets.repository.localWriteMode);
    assert.strictEqual(view.tasks.length, coordinator.getState().tasks.length);
  });

  await runTest('re-saving a masked secret keeps the stored value', () => {
    const original = coordinator.getIntegrationSecrets();
    coordinator.updateState({
      integrationConfig: {
        ...original,
        jira: { ...original.jira, apiToken: SENTINELS.jiraApiToken },
      },
    } as any);

    // The UI only ever sees masks, so the payload it posts back is a mask.
    coordinator.updateState({ integrationConfig: coordinator.getStateView().integrationConfig } as any);
    assert.strictEqual(
      coordinator.getIntegrationSecrets().jira.apiToken,
      SENTINELS.jiraApiToken,
      'mask must not overwrite the stored secret',
    );
    assert.ok(
      fs.readFileSync(STATE_FILE, 'utf-8').includes(SENTINELS.jiraApiToken),
      'the credential must stay held server-side',
    );

    // A genuinely new value must still replace it.
    coordinator.updateState({
      integrationConfig: {
        ...coordinator.getStateView().integrationConfig,
        jira: { ...original.jira, apiToken: 'second-value' },
      },
    } as any);
    assert.strictEqual(coordinator.getIntegrationSecrets().jira.apiToken, 'second-value');

    coordinator.updateState({ integrationConfig: original } as any);
    assert.strictEqual(coordinator.getIntegrationSecrets().jira.apiToken, SENTINELS.jiraApiToken);
  });

  await runTest('mask detection recognises the placeholder it emits', () => {
    assert.strictEqual(isMaskedSecret(REDACTED), true);
    assert.strictEqual(isMaskedSecret('••••'), true);
    assert.strictEqual(isMaskedSecret(''), false);
    assert.strictEqual(isMaskedSecret(undefined), false);
    assert.strictEqual(isMaskedSecret('real-token'), false);
  });

  console.log(`\n=== TRACK A SUITE: ${passed}/${total} PASSED ===`);
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Track A suite crashed:', err);
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  process.exitCode = 1;
});

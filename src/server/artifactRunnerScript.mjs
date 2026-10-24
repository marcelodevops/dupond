#!/usr/bin/env node
/**
 * Out-of-process executor for Dupond artifact verification.
 *
 * The payload arrives on stdin, so no attacker-controlled value ever reaches
 * argv or the process table. Untrusted implementation/spec code is compiled
 * here rather than in the API server's own V8 context.
 *
 * This is containment, not a sandbox: the artifact code is reviewed code, so it
 * is genuinely executed. The meaningful boundary is that this child inherits no
 * secrets, is killed on a hard timeout, and returns only a small fixed schema.
 *
 * stdin payload: { implementationCode, testCode }
 * stdout: one JSON line { ok, reason, detail?, criteria? }
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import crypto from 'node:crypto';
import process from 'node:process';

const ALLOWED_REQUIRE = new Map([
  ['assert', assert],
  ['node:assert', assert],
  ['crypto', crypto],
  ['node:crypto', crypto],
]);

function scopedRequire(name) {
  if (ALLOWED_REQUIRE.has(name)) return ALLOWED_REQUIRE.get(name);
  throw new Error(`require('${name}') is not available to artifact verification`);
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

function describe(err) {
  const name = err && err.name ? `${err.name}: ` : '';
  return `${name}${err && err.message ? err.message : String(err)}`;
}

function checkSyntax(label, code) {
  const probe = spawnSync(process.execPath, ['--check', '/dev/stdin'], {
    input: code,
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (probe.status === 0) return { ok: true };
  const message = (probe.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ').trim();
  return { ok: false, message: `${label}: ${message || 'syntax error'}` };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    respond({ ok: false, reason: 'malformed-runner-input' });
  }

  const { implementationCode, testCode } = input || {};

  if (typeof implementationCode !== 'string' || implementationCode.length === 0) {
    respond({ ok: false, reason: 'no-implementation' });
  }

  const implSyntax = checkSyntax('implementation', implementationCode);
  if (!implSyntax.ok) {
    respond({ ok: false, reason: 'syntax-failed', detail: implSyntax.message });
  }

  if (typeof testCode !== 'string' || testCode.length === 0) {
    respond({ ok: false, reason: 'syntax-ok-no-tests' });
  }

  const testSyntax = checkSyntax('test suite', testCode);
  if (!testSyntax.ok) {
    respond({ ok: false, reason: 'syntax-failed', detail: testSyntax.message });
  }

  /*
   * Implementation and tests are compiled into ONE function scope, matching the
   * previous same-context execution model: the spec suites call the
   * implementation's functions as bare identifiers, which works because
   * function declarations from the first half are visible in the second.
   *
   * `assert`/`crypto` are deliberately NOT injected as parameters. Real specs
   * declare their own `const assert = require('assert')`, and sharing one scope
   * with an injected parameter of the same name throws "Identifier 'assert' has
   * already been declared". They reach the artifact through scopedRequire.
   * `module`/`exports` are injected because artifact sources guard on
   * `typeof module !== 'undefined'` to attach their exports.
   */
  const criteria = [];
  const sandboxModule = { exports: {} };

  let run;
  try {
    run = new Function(
      'require',
      'module',
      'exports',
      'passCriterion',
      'console',
      `${implementationCode}\n${testCode}`,
    );
  } catch (err) {
    respond({
      ok: false,
      reason: 'syntax-failed',
      detail: `${describe(err)} (artifact source may redeclare a runner-injected name: require, module, exports, passCriterion, console)`,
    });
  }

  try {
    run(scopedRequire, sandboxModule, sandboxModule.exports, (id) => {
      if (typeof id === 'string' && !criteria.includes(id)) criteria.push(id);
    }, { log() {}, warn() {}, error() {} });
  } catch (err) {
    respond({ ok: false, reason: 'test-failed', detail: describe(err) });
  }

  respond({ ok: true, reason: 'passed', syntaxOk: true, testsOk: true, criteria });
}

main().catch((err) => respond({ ok: false, reason: 'runner-error', detail: describe(err) }));

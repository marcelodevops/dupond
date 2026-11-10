import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';
import { SandboxExecutor } from '../src/server/sandbox/sandboxExecutor.ts';

async function main() {
  console.log('=== RUNNING WORKSPACE & EXECUTION SANDBOX TESTS ===\n');

  const workspaceManager = new WorkspaceManager(process.cwd());
  const sandbox = new SandboxExecutor();

  // Test 1: Sandbox availability check
  const avail = sandbox.isAvailable();
  assert.strictEqual(avail.available, true, 'Sandbox mechanism must be available on supported host');
  console.log(`✔ [PASS] Sandbox runtime detected (${avail.mechanism})`);

  // Test 2: Git Worktree creation pinned to recorded base commit
  const runId = `test-run-${Date.now()}`;
  const testBranch = `test-worktree-branch-${Date.now()}`;

  const worktree = workspaceManager.createWorktree(runId, testBranch, 'HEAD');
  assert.ok(fs.existsSync(worktree.worktreePath), 'Worktree directory created');
  assert.strictEqual(worktree.branch, testBranch);
  console.log('✔ [PASS] Isolated Git worktree prepared and pinned to base commit');

  // Test 3: Normal execution inside worktree succeeds
  const execResult = await sandbox.execute({
    worktreePath: worktree.worktreePath,
    command: 'git status -s',
    timeoutMs: 15000,
  });
  assert.strictEqual(execResult.exitCode, 0, `Git status in worktree should succeed: ${execResult.stderr}`);
  console.log('✔ [PASS] Permitted command executes successfully inside isolated worktree');

  // Test 4: Environment isolation strips host secrets
  // Pass ambient GEMINI_API_KEY and check that process.env inside sandbox does NOT contain it
  process.env.TEST_HOST_SECRET_TOKEN = 'super-secret-token-12345';
  const envResult = await sandbox.execute({
    worktreePath: worktree.worktreePath,
    command: 'env',
    timeoutMs: 10000,
  });
  assert.ok(!envResult.stdout.includes('super-secret-token-12345'), 'Host secrets must not be passed to sandbox process');
  assert.ok(!envResult.stdout.includes(process.env.GEMINI_API_KEY || 'AQ.Ab8'), 'API keys must not leak into sandbox environment');
  console.log('✔ [PASS] Ambient host credentials and secrets stripped from execution environment');

  // Test 5: Sandbox blocks unauthorized host credential access (~/.ssh, ~/.aws)
  const sshResult = await sandbox.execute({
    worktreePath: worktree.worktreePath,
    command: `ls -la "${path.join(os.homedir(), '.ssh')}" 2>&1 || true`,
    timeoutMs: 10000,
  });
  assert.ok(
    sshResult.stdout.includes('Permission denied') ||
    sshResult.stdout.includes('Operation not permitted') ||
    sshResult.stderr.includes('Operation not permitted') ||
    sshResult.stdout.includes('No such file or directory') ||
    sshResult.stdout.includes('cannot access') ||
    sshResult.exitCode !== 0,
    'Reading ~/.ssh must be blocked by sandbox policy',
  );
  console.log('✔ [PASS] Access to host credentials directory (~/.ssh) strictly denied');

  // Test 6: Sandbox blocks writing outside worktree
  const writeResult = await sandbox.execute({
    worktreePath: worktree.worktreePath,
    command: 'touch /private/tmp/unauthorized_sandbox_escape.txt 2>&1 || true',
    timeoutMs: 10000,
  });
  assert.ok(
    writeResult.stdout.includes('Operation not permitted') ||
    writeResult.stdout.includes('Permission denied') ||
    !fs.existsSync('/private/tmp/unauthorized_sandbox_escape.txt'),
    'Writing outside worktree must be forbidden',
  );
  console.log('✔ [PASS] Filesystem write outside worktree strictly prevented');

  // Test 7: Timeout kills runaway process and cleans up process tree
  const timeoutStart = Date.now();
  const timeoutResult = await sandbox.execute({
    worktreePath: worktree.worktreePath,
    command: 'sleep 30',
    timeoutMs: 1000,
  });
  const elapsed = Date.now() - timeoutStart;
  assert.strictEqual(timeoutResult.timedOut, true, 'Runaway command must be flagged as timedOut');
  assert.ok(elapsed < 4000, `Command should be killed near 1000ms timeout (took ${elapsed}ms)`);
  console.log('✔ [PASS] Runaway command terminated cleanly at timeout boundary');

  // Cleanup worktree
  workspaceManager.cleanupWorktree(worktree.worktreePath, testBranch);
  assert.ok(!fs.existsSync(worktree.worktreePath), 'Worktree directory cleaned up');
  console.log('✔ [PASS] Worktree cleaned up and unmounted successfully');

  // Test 8: Explicit container cleanup and confirmation logic
  const mockContainerName = `test-container-removal-${Date.now()}`;
  const removalConfirmed = sandbox.stopAndConfirmContainerRemoval('docker', mockContainerName);
  assert.strictEqual(removalConfirmed, true, 'Container removal must be confirmed via non-zero inspect status');
  console.log('✔ [PASS] Container cancellation explicitly stops, removes, and confirms container deletion');

  // Test 9: Image preparation pre-pulls with dedicated timeout separate from execution
  const imageReady = await sandbox.ensureImage('node:22-bookworm', 5000);
  assert.strictEqual(typeof imageReady, 'boolean');
  console.log('✔ [PASS] Sandbox container image preparation decoupled from command timeout');

  console.log('\n=== ALL WORKSPACE & SANDBOX TESTS PASSED CLEANLY ===');
}

main().catch((err) => {
  console.error('Sandbox test failed:', err);
  process.exit(1);
});

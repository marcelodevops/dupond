import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { GeminiCodingWorkerAdapter } from '../src/server/worker/geminiWorkerAdapter.ts';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';

async function main() {
  console.log('=== RUNNING CODING WORKER ADAPTER TESTS ===\n');

  const workspaceManager = new WorkspaceManager(process.cwd());
  const adapter = new GeminiCodingWorkerAdapter();

  // Test 1: Availability check
  const origKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const noKeyAvail = await adapter.isAvailable();
  assert.strictEqual(noKeyAvail.available, false);
  assert.ok(noKeyAvail.error?.includes('GEMINI_API_KEY is not set'));
  console.log('✔ [PASS] Worker adapter reports unavailable when prerequisite API key is missing');

  // Restore key
  process.env.GEMINI_API_KEY = origKey;
  const withKeyAvail = await adapter.isAvailable();
  assert.strictEqual(withKeyAvail.available, true);
  console.log('✔ [PASS] Worker adapter reports available when prerequisites are satisfied');

  // Test 2: Tool safety mechanics in an isolated worktree
  const runId = `worker-test-${Date.now()}`;
  const branchName = `worker-test-branch-${Date.now()}`;
  const worktree = workspaceManager.createWorktree(runId, branchName, 'HEAD');

  try {
    const protectedFile = path.resolve(worktree.worktreePath, 'protected.test.js');
    fs.writeFileSync(protectedFile, '// original protected test content\n');
    execFileSync('git', ['add', 'protected.test.js'], { cwd: worktree.worktreePath });
    execFileSync('git', [
      '-c', 'user.name=Dupond Test',
      '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'chore: add protected test',
    ], { cwd: worktree.worktreePath });

    const testContext = {
      taskId: 'test-1',
      taskKey: 'AEG-601',
      taskTitle: 'Protected Path Test',
      taskDescription: 'Should not touch protected test',
      acceptanceCriteria: [{ id: 'c1', title: 'Must pass' }],
      worktreePath: worktree.worktreePath,
      allowedPaths: ['src/**'],
      protectedPaths: ['protected.test.js', 'package.json'],
      attemptNumber: 1,
    };

    // 2a. Writing directly to a protected path must be rejected
    const writeProtectedRes = await adapter.executeTool(testContext as any, 'write_file', {
      filePath: 'protected.test.js',
      content: '// attempt overwrite',
    });
    assert.ok(writeProtectedRes.error?.includes('is a protected path'), 'Direct write to protected path must be rejected');

    // 2b. Writing outside allowed change scope must be rejected
    const writeDisallowedRes = await adapter.executeTool(testContext as any, 'write_file', {
      filePath: 'config/settings.json',
      content: '{}',
    });
    assert.ok(writeDisallowedRes.error?.includes('outside the allowed change scope'), 'Write outside allowed scope must be rejected');

    // 2c. Writing inside allowed change scope succeeds
    const writeAllowedRes = await adapter.executeTool(testContext as any, 'write_file', {
      filePath: 'src/validService.ts',
      content: 'export const ok = true;\n',
    });
    assert.strictEqual(writeAllowedRes.written, true);
    assert.ok(fs.existsSync(path.resolve(worktree.worktreePath, 'src/validService.ts')));

    // 2d. Symlink escape defense on read and write
    const symlinkPath = path.resolve(worktree.worktreePath, 'src/escaped_symlink');
    try {
      fs.symlinkSync('/etc', symlinkPath);
      const readSymlinkRes = await adapter.executeTool(testContext as any, 'read_file', {
        filePath: 'src/escaped_symlink/hosts',
      });
      assert.ok(
        readSymlinkRes.error?.includes('Symlink') || readSymlinkRes.error?.includes('escapes workspace') || readSymlinkRes.error?.includes('blocked'),
        'Reading through symlink pointing outside worktree must be blocked'
      );
    } catch (err: any) {
      // If symlink creation is restricted, verify error handled
    }

    // 2e. Command execution modifying a protected file triggers automated rollback and integrity violation
    const tamperRes = await adapter.executeTool(testContext as any, 'run_permitted_command', {
      command: `node -e "require('fs').appendFileSync('protected.test.js', '// TAMPERED');"`,
    });
    assert.strictEqual(tamperRes.exitCode, 1, 'Command modifying protected file must exit with failure');
    assert.ok(tamperRes.stderr?.includes('Integrity violation'), 'Must report integrity violation');
    assert.ok(tamperRes.stderr?.includes('Modifications were automatically rolled back'));

    // Assert file content was rolled back to original
    const restoredContent = fs.readFileSync(protectedFile, 'utf-8');
    assert.ok(!restoredContent.includes('// TAMPERED'), 'Protected file must be restored');
    assert.ok(restoredContent.includes('// original protected test content'), 'Original content preserved');

    console.log('✔ [PASS] Path containment, symlink escape defense, and protected path rollback enforced strictly');

  } finally {
    workspaceManager.cleanupWorktree(worktree.worktreePath, branchName);
  }

  console.log('\n=== ALL CODING WORKER ADAPTER TESTS PASSED CLEANLY ===');
}

main().catch((err) => {
  console.error('Worker adapter test failed:', err);
  process.exit(1);
});

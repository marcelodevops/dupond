import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, it } from 'vitest';

const TOKEN = 'settings-test-token';
const children: ChildProcess[] = [];
const tempDirs: string[] = [];

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Dupond server');
}

async function startServer(dbPath: string, statePath: string, port: number): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DUPOND_API_KEY: TOKEN,
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitForServer(port);
}

async function stopChildServers(): Promise<void> {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
  }
}

async function stopServers(): Promise<void> {
  await stopChildServers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Stage 4: Project Settings & Repository Verification Suite', () => {
  afterEach(async () => {
    await stopServers();
  });

  it('protects default project identity while allowing secondary project settings and repo verification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp_settings_test_'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const statePath = path.join(dir, 'state.json');
    const port = 38920;

    await startServer(dbPath, statePath, port);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Invariant: Default project fixed identity cannot be modified
    const renameDefaultRes = await fetch(`${baseUrl}/api/projects/default`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': 'default',
      },
      body: JSON.stringify({ name: 'Renamed Default Corp' }),
    });
    assert.strictEqual(renameDefaultRes.status, 400);
    const renameDefaultData = await renameDefaultRes.json();
    assert.strictEqual(renameDefaultData.code, 'CANNOT_MODIFY_DEFAULT_IDENTITY');
    console.log('✔ [PASS] Default project identity protected against rename');

    // 2. Create a secondary project
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Naviera Freight Engine',
        description: 'Initial description',
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const naviera = await createRes.json();
    const navieraId = naviera.id;

    // 3. Create a real git repository in a temp directory for verification tests
    const repoDir = path.join(dir, 'naviera-local-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repoDir]);
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Dupond Tester']);
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@dupond.local']);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Naviera Repository\n');
    execFileSync('git', ['-C', repoDir, 'add', '.']);
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Initial commit']);

    // Also create a non-git directory for failure testing
    const nonGitDir = path.join(dir, 'empty-non-git');
    fs.mkdirSync(nonGitDir, { recursive: true });

    // 4. Test Repository Verification on candidate config:
    // 4a: Missing path
    const verifyEmptyRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        repository: { localPath: '' },
      }),
    });
    assert.strictEqual(verifyEmptyRes.status, 200);
    const verifyEmpty = await verifyEmptyRes.json();
    assert.strictEqual(verifyEmpty.valid, false);
    assert.strictEqual(verifyEmpty.localPathExists, false);

    // 4b: Non-existent directory
    const verifyMissingRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        repository: { localPath: path.join(dir, 'does-not-exist') },
      }),
    });
    const verifyMissing = await verifyMissingRes.json();
    assert.strictEqual(verifyMissing.valid, false);
    assert.strictEqual(verifyMissing.localPathExists, false);

    // 4c: Valid folder but not a git repo
    const verifyNonGitRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        repository: { localPath: nonGitDir },
      }),
    });
    const verifyNonGit = await verifyNonGitRes.json();
    assert.strictEqual(verifyNonGit.valid, false);
    assert.strictEqual(verifyNonGit.localPathExists, true);
    assert.strictEqual(verifyNonGit.isGitRepo, false);

    // 4d: Valid git repo with existing branch "main" -> VALID
    const verifyValidRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        repository: {
          localPath: repoDir,
          defaultBranch: 'main',
          localWriteMode: 'worktree',
        },
      }),
    });
    const verifyValid = await verifyValidRes.json();
    assert.strictEqual(verifyValid.valid, true);
    assert.strictEqual(verifyValid.localPathExists, true);
    assert.strictEqual(verifyValid.isGitRepo, true);
    assert.strictEqual(verifyValid.branchExists, true);
    assert.strictEqual(verifyValid.writable, true);
    assert.ok(verifyValid.headCommit);
    console.log('✔ [PASS] Real local git repository verified successfully with branch resolution');

    // 4e: Valid git repo but non-existent branch
    const verifyBadBranchRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        repository: {
          localPath: repoDir,
          defaultBranch: 'non-existent-feature-branch',
        },
      }),
    });
    const verifyBadBranch = await verifyBadBranchRes.json();
    assert.strictEqual(verifyBadBranch.valid, false);
    assert.strictEqual(verifyBadBranch.branchExists, false);

    // 5. Update secondary project settings via PATCH /api/projects/:id
    const updateRes = await fetch(`${baseUrl}/api/projects/${navieraId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        name: 'Naviera Ocean Logistics',
        description: 'Updated freight quote and logistics platform',
        repository: {
          localPath: repoDir,
          defaultBranch: 'main',
          localWriteMode: 'worktree',
        },
      }),
    });
    assert.strictEqual(updateRes.status, 200);
    const updatedProject = await updateRes.json();
    assert.strictEqual(updatedProject.name, 'Naviera Ocean Logistics');
    assert.strictEqual(updatedProject.repository.localPath, repoDir);
    assert.strictEqual(updatedProject.repository.defaultBranch, 'main');

    // 6. Verify that calling verifyRepository without body now verifies the saved config
    const verifySavedRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({}),
    });
    const verifySaved = await verifySavedRes.json();
    assert.strictEqual(verifySaved.valid, true);
    assert.strictEqual(verifySaved.branchExists, true);
    console.log('✔ [PASS] Saved repository configuration verified from stored project settings');

    // 7. Context mismatch protection on verify endpoint
    const mismatchRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': 'default',
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(mismatchRes.status, 403);
    const mismatchData = await mismatchRes.json();
    assert.strictEqual(mismatchData.code, 'PROJECT_CONTEXT_MISMATCH');
    console.log('✔ [PASS] Context mismatch rejected on repository verification endpoint');
  });
});

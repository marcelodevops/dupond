import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface DisposableRepoFixture {
  tmpBase: string;
  repoDir: string;
  bareRemoteDir: string;
  baseSha: string;
  cleanup: () => void;
}

/**
 * Creates a self-contained disposable Git repository and bare origin remote
 * under os.tmpdir() so tests never create worktrees or refs in process.cwd().
 */
export function createDisposableRepo(prefix = 'dupond-test-repo-'): DisposableRepoFixture {
  const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const bareRemoteDir = path.join(tmpBase, 'origin.git');
  const repoDir = path.join(tmpBase, 'repo');

  fs.mkdirSync(bareRemoteDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', '--template='], { cwd: bareRemoteDir });
  execFileSync('git', ['--git-dir', bareRemoteDir, 'config', 'receive.shallowUpdate', 'true']);

  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main', '--template='], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Dupond Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', bareRemoteDir], { cwd: repoDir });

  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'disposable-test-repo', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(repoDir, '.gitignore'),
    '.dupond_worktrees/\n.env\n*.env\n.env.*\n!.env*.example\n!.env*.sample\n!.env*.template\n',
  );
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Disposable Test Repo\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const placeholder = true;\n');

  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'chore: initial disposable commit'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();

  return {
    tmpBase,
    repoDir,
    bareRemoteDir,
    baseSha,
    cleanup: () => {
      try {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      } catch {}
    },
  };
}

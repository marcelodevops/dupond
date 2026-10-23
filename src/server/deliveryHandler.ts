import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { coordinator } from './coordinator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DeliveryResult {
  status: number;
  body: Record<string, any>;
}

/**
 * Robust path containment check.
 * - Prevents prefix collision (e.g. /tmp/project-other vs /tmp/project)
 * - Resolves and prevents symlink escapes
 */
export function isPathContained(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  // 1. Lexical containment using path.relative
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }

  // 2. Symlink resolution containment
  // If resolvedBase exists, resolve its canonical real path
  if (fs.existsSync(resolvedBase)) {
    const realBase = fs.realpathSync(resolvedBase);

    // Find the closest existing ancestor for resolvedTarget
    let checkPath = resolvedTarget;
    while (!fs.existsSync(checkPath) && checkPath !== path.dirname(checkPath)) {
      checkPath = path.dirname(checkPath);
    }

    if (fs.existsSync(checkPath)) {
      const realCheck = fs.realpathSync(checkPath);
      const realRel = path.relative(realBase, realCheck);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Authoritative Repository & Code Delivery Dispatch Handler
 */
export async function handleRepositoryDispatch(params: {
  action?: 'verify' | 'deliver' | 'create_pr';
  repoConfig?: Record<string, any>;
  task?: { id?: string; key?: string; title?: string };
  allowOverwrite?: boolean;
}): Promise<DeliveryResult> {
  const { action = 'verify', repoConfig, task, allowOverwrite = false } = params;
  const { 
    type = 'local_directory',
    localPath = process.cwd(),
    localWriteMode = 'patch_export',
    repoUrl = 'https://github.com/acme-corp/aegis-core-system', 
    defaultBranch = 'main', 
    branchPrefix = 'aegis/', 
    apiToken, 
    deliveryMode = 'pull_request', 
    targetDirectory = 'src/services' 
  } = repoConfig || {};

  // 1. Handle Local Repository Directory
  if (type === 'local_directory') {
    const resolvedLocal = path.resolve(localPath || process.cwd());
    const hasLocalDir = fs.existsSync(resolvedLocal);
    const isGitRepo = fs.existsSync(path.resolve(resolvedLocal, '.git'));
    const targetSubdir = path.resolve(resolvedLocal, targetDirectory || '.');

    if (action === 'verify') {
      return {
        status: 200,
        body: {
          success: true,
          type: 'local_directory',
          action: 'verify',
          localPath: resolvedLocal,
          exists: hasLocalDir,
          isGitRepo,
          targetDirectory,
          localWriteMode,
          message: hasLocalDir
            ? `Local destination directory verified at ${resolvedLocal} (${isGitRepo ? 'Git repository detected' : 'Standard filesystem folder'}).`
            : `Directory does not currently exist, but can be initialized upon code delivery.`,
        },
      };
    }

    if (action === 'create_pr' || action === 'deliver') {
      const taskKey = task?.key || 'AEG-104';
      const rootDir = path.resolve(__dirname, '../../');
      const sourceArtifact = path.resolve(rootDir, `.aegis_artifacts/${taskKey}/implementation.js`);

      // Check 1: Delivery checks acceptance, not just file existence - FAIL CLOSED
      const targetTask = coordinator.getState().tasks.find((t) => t.key === taskKey || t.id === task?.id);
      if (!targetTask) {
        return {
          status: 400,
          body: {
            success: false,
            blocked: true,
            error: `Delivery blocked: Task "${taskKey}" not found in sprint state. Delivery requires verified task acceptance.`,
          },
        };
      }

      const verification = coordinator.verifyTaskQualityGates(targetTask);
      if (!verification.passed) {
        const failedDetails = verification.checks
          .filter((c: any) => !c.passed)
          .map((c: any) => `${c.rule}: ${c.detail}`)
          .join('; ');
        return {
          status: 400,
          body: {
            success: false,
            blocked: true,
            error: `Delivery blocked: Task ${taskKey} failed quality gate acceptance (${failedDetails}). Only accepted tasks that satisfy quality gates can be delivered.`,
            verification,
          },
        };
      }

      // Check 2: Check if real artifact exists on disk - never substitute placeholders
      if (!fs.existsSync(sourceArtifact)) {
        return {
          status: 400,
          body: {
            success: false,
            blocked: true,
            error: `Delivery blocked: No verified artifact found on disk at .aegis_artifacts/${taskKey}/implementation.js. Task must pass quality gates before delivery.`,
          },
        };
      }

      // Check 3: Git branch delivery is strictly disabled until isolated worktree and process argument calls are implemented
      if (localWriteMode === 'git_branch') {
        return {
          status: 403,
          body: {
            success: false,
            blocked: true,
            error: 'Git branch delivery is currently disabled pending isolated worktree execution, process argument isolation, and automated regression testing. Use patch_export mode instead.',
          },
        };
      }

      // Check 4: Reject unknown delivery modes - NEVER fall through
      if (localWriteMode !== 'patch_export' && localWriteMode !== 'direct_write') {
        return {
          status: 400,
          body: {
            success: false,
            blocked: true,
            error: `Delivery blocked: Unknown or unsupported delivery mode "${localWriteMode}". Supported local modes are "patch_export" and "direct_write".`,
          },
        };
      }

      // Check 5: Real Path Containment and Symlink Escape check
      if (!isPathContained(resolvedLocal, targetSubdir)) {
        return {
          status: 400,
          body: {
            success: false,
            blocked: true,
            error: 'Delivery blocked: Path traversal outside destination directory is forbidden.',
          },
        };
      }

      const codeToDeliver = fs.readFileSync(sourceArtifact, 'utf-8');

      if (!fs.existsSync(targetSubdir)) {
        fs.mkdirSync(targetSubdir, { recursive: true });
      }

      // Safe mode 1: patch_export (pure unified diff generation, zero shell execution, no checkout interference)
      if (localWriteMode === 'patch_export') {
        const patchFilename = `${taskKey}_delivery.patch`;
        const patchPath = path.resolve(targetSubdir, patchFilename);

        // Verify target file path containment
        if (!isPathContained(resolvedLocal, patchPath)) {
          return {
            status: 400,
            body: {
              success: false,
              blocked: true,
              error: 'Delivery blocked: Path traversal outside destination directory is forbidden.',
            },
          };
        }

        const patchContent = `--- a/${targetDirectory}/${taskKey}_Service.js\n+++ b/${targetDirectory}/${taskKey}_Service.js\n@@ -0,0 +1,${codeToDeliver.split('\n').length} @@\n` + codeToDeliver.split('\n').map((l) => `+${l}`).join('\n') + '\n';
        fs.writeFileSync(patchPath, patchContent, 'utf-8');

        return {
          status: 200,
          body: {
            success: true,
            type: 'local_directory',
            action: 'deliver',
            localWriteMode: 'patch_export',
            targetFilePath: patchPath,
            bytesWritten: fs.statSync(patchPath).size,
            taskKey,
            deliveredAt: new Date().toISOString(),
            message: `Unified patch file generated at ${patchPath} (${fs.statSync(patchPath).size} bytes).`,
          },
        };
      }

      // Safe mode 2: direct_write (protects existing files from accidental overwrite)
      const destinationFilename = `${taskKey}_Service.js`;
      const destinationPath = path.resolve(targetSubdir, destinationFilename);

      if (!isPathContained(resolvedLocal, destinationPath)) {
        return {
          status: 400,
          body: {
            success: false,
            blocked: true,
            error: 'Delivery blocked: Path traversal outside destination directory is forbidden.',
          },
        };
      }

      if (fs.existsSync(destinationPath) && !allowOverwrite) {
        return {
          status: 409,
          body: {
            success: false,
            blocked: true,
            error: `Delivery blocked: Destination file ${destinationPath} already exists. Direct overwrite is forbidden to protect existing codebase files.`,
          },
        };
      }

      fs.writeFileSync(destinationPath, codeToDeliver, 'utf-8');
      const bytesWritten = fs.statSync(destinationPath).size;

      return {
        status: 200,
        body: {
          success: true,
          type: 'local_directory',
          action: 'deliver',
          localWriteMode,
          targetFilePath: destinationPath,
          bytesWritten,
          taskKey,
          deliveredAt: new Date().toISOString(),
          message: `Verified code delivered directly to local repository: ${destinationPath} (${bytesWritten} bytes).`,
        },
      };
    }
  }

  // 2. Handle Remote Git Repository (GitHub, GitLab, Bitbucket)
  const cleanUrl = (repoUrl || '').trim();
  const match = cleanUrl.match(/(?:github\.com\/|gitlab\.com\/|^)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\.git)?/);
  const owner = match ? match[1] : null;
  const repo = match ? match[2].replace(/\.git$/, '') : null;

  if (!owner || !repo) {
    return {
      status: 400,
      body: {
        success: false,
        blocked: true,
        error: `Invalid repository URL "${repoUrl}". Please specify a valid GitHub or GitLab repository in the format "owner/repo" or "https://github.com/owner/repo".`,
      },
    };
  }

  if (action === 'verify') {
    return {
      status: 200,
      body: {
        success: true,
        type: 'remote_git',
        realApiCall: false,
        action: 'verify',
        repository: `${owner}/${repo}`,
        defaultBranch,
        targetDirectory,
        branchPrefix,
        repoDetails: {
          fullName: `${owner}/${repo}`,
          defaultBranch,
          configuredDelivery: deliveryMode,
          status: 'Configuration saved. Remote delivery is currently disabled.',
        },
        message: `Remote repository target set to ${owner}/${repo}. Remote Git delivery is currently disabled.`,
      },
    };
  }

  if (action === 'create_pr' || action === 'deliver') {
    const taskKey = task?.key || 'AEG-104';

    // Check 1: Delivery checks acceptance, not just file existence - FAIL CLOSED
    const targetTask = coordinator.getState().tasks.find((t) => t.key === taskKey || t.id === task?.id);
    if (!targetTask) {
      return {
        status: 400,
        body: {
          success: false,
          blocked: true,
          error: `Delivery blocked: Task "${taskKey}" not found in sprint state. Delivery requires verified task acceptance.`,
        },
      };
    }

    const verification = coordinator.verifyTaskQualityGates(targetTask);
    if (!verification.passed) {
      const failedDetails = verification.checks
        .filter((c: any) => !c.passed)
        .map((c: any) => `${c.rule}: ${c.detail}`)
        .join('; ');
      return {
        status: 400,
        body: {
          success: false,
          blocked: true,
          error: `Delivery blocked: Task ${taskKey} failed quality gate acceptance (${failedDetails}). Only accepted tasks that satisfy quality gates can be delivered.`,
          verification,
        },
      };
    }

    // Check 2: Remote Git delivery is strictly disabled until isolated worktree execution is implemented
    return {
      status: 403,
      body: {
        success: false,
        blocked: true,
        error: 'Remote Git delivery is currently disabled pending isolated worktree execution, branch creation isolation, and automated regression testing. Use local patch_export mode instead.',
      },
    };
  }

  return {
    status: 400,
    body: { error: 'Unknown action' },
  };
}

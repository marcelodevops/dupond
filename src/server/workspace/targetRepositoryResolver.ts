import { DomainError } from '../utils/errors';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';

export interface ResolveTargetOptions {
  targetRepo?: string;
  targetRepoPath?: string;
  integrationConfig?: any;
  allowOrchestratorRepo?: boolean;
}

export interface ResolvedTargetRepository {
  repoPath: string;
  repoIdentity: string;
  remoteOriginUrl?: string;
  isOrchestratorRepo: boolean;
}

/**
 * Validates that a directory is a functional Git repository.
 */
function isValidGitRepo(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return false;
  try {
    const gitDir = path.join(dirPath, '.git');
    if (!fs.existsSync(gitDir)) return false;
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dirPath,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the remote origin URL of a Git repository if configured.
 */
function getOriginUrl(dirPath: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dirPath,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a repository URL or slug for comparison:
 * e.g. "git@github.com:owner/repo.git" -> "owner/repo"
 * e.g. "https://github.com/owner/repo" -> "owner/repo"
 * e.g. "/path/to/repo.git" -> "repo"
 */
export function normalizeRepoSlug(urlOrSlug: string): string {
  if (!urlOrSlug) return '';
  let cleaned = urlOrSlug.trim();
  cleaned = cleaned.replace(/\.git$/, '');
  const ghMatch = cleaned.match(/(?:github\.com[:/])([^/]+\/[^/]+)$/i);
  if (ghMatch) return ghMatch[1].toLowerCase();
  const parts = cleaned.split(/[\/\\]/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
  }
  return cleaned.toLowerCase();
}

/**
 * True when a remote points at a local filesystem repository rather than a
 * network one, which is the only remote shape a test may use as a stand-in for
 * a real origin. Decided by transport, never by the repository's name: a GitHub
 * repository called "disposable-payments" is a network remote and must still be
 * identity-checked.
 */
export function isLocalRemoteOrigin(originUrl?: string): boolean {
  if (!originUrl) return false;
  const cleaned = originUrl.trim();
  return (
    cleaned.startsWith('/') ||
    cleaned.startsWith('file:') ||
    cleaned.startsWith('./') ||
    cleaned.startsWith('../')
  );
}

/** Slug of the repository this orchestrator process is checked out in, if any. */
export function orchestratorRepoSlug(): string {
  const origin = getOriginUrl(fs.realpathSync(path.resolve(process.cwd())));
  return origin ? normalizeRepoSlug(origin) : '';
}

/**
 * Canonicalizes repository slugs to recognize renamed repositories and preserve
 * compatibility with legacy slugs and GitHub redirects:
 * e.g. "marcelodevops/dupond-project-leader" -> "marcelodevops/dupond"
 */
export function canonicalizeRepoSlug(urlOrSlug?: string): string {
  if (!urlOrSlug) return '';
  const norm = normalizeRepoSlug(urlOrSlug);
  if (norm === 'marcelodevops/dupond-project-leader') {
    return 'marcelodevops/dupond';
  }
  return norm;
}

/**
 * Checks whether two repository slugs/URLs are equivalent, accounting for
 * normalization and historical repository renames.
 */
export function areRepoSlugsCompatible(slugA?: string, slugB?: string): boolean {
  if (!slugA || !slugB) return false;
  const normA = normalizeRepoSlug(slugA);
  const normB = normalizeRepoSlug(slugB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  return canonicalizeRepoSlug(normA) === canonicalizeRepoSlug(normB);
}

/**
 * Whether a target names the orchestrator's own repository, judged against the
 * real origin of this checkout instead of a hardcoded literal, so a task cannot
 * claim the exemption by naming an alias. Recognizes both current and legacy slugs.
 */
export function isOrchestratorSelfTarget(nameOrUrl?: string): boolean {
  if (!nameOrUrl) return false;
  const own = orchestratorRepoSlug();
  return !!own && areRepoSlugsCompatible(nameOrUrl, own);
}

/**
 * Authoritatively resolves and validates the target workspace repository.
 * Never silently defaults to the orchestrator workspace.
 * Fails closed on missing, invalid, or mismatched repository configurations.
 */
export function resolveTargetRepository(options: ResolveTargetOptions): ResolvedTargetRepository {
  const orchestratorPath = fs.realpathSync(path.resolve(process.cwd()));
  const orchestratorOrigin = getOriginUrl(orchestratorPath);
  const orchestratorSlug = orchestratorOrigin ? normalizeRepoSlug(orchestratorOrigin) : '';

  const configuredTargetRepo = options.targetRepo ||
    options.integrationConfig?.repository?.repoUrl ||
    process.env.DUPOND_TARGET_REPO;

  const configuredTargetRepoPath = options.targetRepoPath ||
    options.integrationConfig?.repository?.localPath;

  // 1. Fail closed if neither targetRepo nor targetRepoPath is specified
  if (!configuredTargetRepo && !configuredTargetRepoPath) {
    throw new DomainError(
      'Target repository configuration failed: No target repository configured. Explicit target configuration (targetRepo or targetRepoPath) is required. Refusing to silently select the orchestrator repository.'
    );
  }

  let resolvedPath: string | undefined;

  // 2. Check explicitly provided targetRepoPath
  if (configuredTargetRepoPath) {
    const absPath = path.resolve(configuredTargetRepoPath);
    if (!fs.existsSync(absPath)) {
      throw new DomainError(
        `Target repository configuration failed: Specified target repository path "${configuredTargetRepoPath}" does not exist. A valid local checkout is required.`
      );
    }
    if (!isValidGitRepo(absPath)) {
      throw new DomainError(
        `Target repository configuration failed: Path "${configuredTargetRepoPath}" exists but is not a valid Git repository.`
      );
    }
    resolvedPath = fs.realpathSync(absPath);
  } else if (configuredTargetRepo) {
    // Check if targetRepo explicitly matches orchestrator repository and caller explicitly allowed it
    const targetSlug = normalizeRepoSlug(configuredTargetRepo);
    if (options.allowOrchestratorRepo && targetSlug && orchestratorSlug && targetSlug === orchestratorSlug) {
      resolvedPath = orchestratorPath;
    } else if (path.isAbsolute(configuredTargetRepo) || configuredTargetRepo.startsWith('.') || fs.existsSync(configuredTargetRepo)) {
      // If targetRepo is an existing local filesystem directory
      const absPath = path.resolve(configuredTargetRepo);
      if (!isValidGitRepo(absPath)) {
        throw new DomainError(
          `Target repository configuration failed: Path "${configuredTargetRepo}" is not a valid Git repository.`
        );
      }
      resolvedPath = fs.realpathSync(absPath);
    }
  }

  // 3. If targetRepo is a remote identifier without an existing local path
  if (!resolvedPath && configuredTargetRepo) {
    // Check if a managed checkout exists under .dupond_checkouts/
    const checkoutsRoot = path.resolve(orchestratorPath, '.dupond_checkouts');
    const sanitizedName = configuredTargetRepo.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const managedCheckout = path.join(checkoutsRoot, sanitizedName);

    if (isValidGitRepo(managedCheckout)) {
      resolvedPath = fs.realpathSync(managedCheckout);
    } else {
      // Remote-only target without local checkout: explain that local checkout is required
      throw new DomainError(
        `Target repository configuration failed: Target repository "${configuredTargetRepo}" is a remote reference with no local checkout. A valid local checkout is required (specify targetRepoPath or prepare the workspace repository).`
      );
    }
  }

  if (!resolvedPath) {
    throw new DomainError(
      `Target repository configuration failed: Could not resolve repository for target "${configuredTargetRepo || configuredTargetRepoPath}".`
    );
  }

  const isOrchestratorRepo = resolvedPath === orchestratorPath;
  const targetOrigin = getOriginUrl(resolvedPath);
  const targetOriginSlug = targetOrigin ? normalizeRepoSlug(targetOrigin) : '';
  const expectedSlug = configuredTargetRepo ? normalizeRepoSlug(configuredTargetRepo) : '';

  // 4. Strict check: Never silently select orchestrator repository
  if (isOrchestratorRepo) {
    // Only allow if targetRepo explicitly names this repository and caller explicitly permits it
    const explicitlyTargetsOrchestrator = expectedSlug && orchestratorSlug && areRepoSlugsCompatible(expectedSlug, orchestratorSlug);
    if (!explicitlyTargetsOrchestrator && !options.allowOrchestratorRepo) {
      throw new DomainError(
        `Target repository mismatch: Configured target repository "${configuredTargetRepo || 'unspecified'}" resolved to the orchestrator workspace at "${orchestratorPath}". Never silently select the orchestrator repository.`
      );
    }
  }

  // 5. Validate that workspace repository origin matches the configured target
  // repo. A local filesystem remote stands in for a real origin in tests and has
  // no network identity to compare, so it is exempted by transport.
  if (expectedSlug && targetOriginSlug && !isLocalRemoteOrigin(targetOrigin)) {
    if (!areRepoSlugsCompatible(targetOriginSlug, expectedSlug)) {
      throw new DomainError(
        `Target repository mismatch: Workspace repository origin "${targetOriginSlug}" does not match configured target "${expectedSlug}". Refusing to execute on mismatched repository.`
      );
    }
  }

  const repoIdentity = configuredTargetRepo || targetOriginSlug || path.basename(resolvedPath);

  return {
    repoPath: resolvedPath,
    repoIdentity,
    remoteOriginUrl: targetOrigin,
    isOrchestratorRepo,
  };
}

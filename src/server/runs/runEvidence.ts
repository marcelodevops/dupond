import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  DeliveryRecord,
  RunAttemptRecord,
  TaskRecord,
  TaskRunRecord,
  VerificationRecord,
} from '../db/schema.js';
import { isSafeGitRef } from '../utils/gitRefs.js';
import { sanitizeGeminiError } from '../gemini.js';
import { verifiedRefForRun } from '../verification/evidenceBinding.js';

export const MAX_DIFF_CHARS = 64 * 1024;
export const MAX_LOG_CHARS = 48 * 1024;
export const MAX_CHECK_OUTPUT_CHARS = 16 * 1024;

export type CandidateDiffProvenance = 'persisted_attempt_diff' | 'immutable_git_commit' | 'unavailable';

export interface SanitizedVerificationCheck {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  passed: boolean;
  durationMs: number;
}

export interface SanitizedVerificationRecord extends Omit<VerificationRecord, 'checks'> {
  checks: SanitizedVerificationCheck[];
}

export interface SanitizedAttemptRecord extends Omit<RunAttemptRecord, 'prompt'> {
  diffTruncated?: boolean;
  logsTruncated?: boolean;
}

export interface CandidateEvidencePayload {
  runId: string;
  taskId: string;
  projectId: string;
  candidateRevision: string | null;
  baseCommit: string | null;
  targetRepo: string | null;
  targetBranch: string | null;
  provider: string | null;
  model: string | null;
  changedFiles: string[];
  candidateDiff: string | null;
  candidateDiffStatus: 'available' | 'unavailable';
  candidateDiffTruncated: boolean;
  candidateDiffUnavailableReason: string | null;
  provenance: CandidateDiffProvenance;
}

export function sanitizeEvidenceText(raw: string | null | undefined): string {
  if (!raw) return '';
  let text = sanitizeGeminiError(raw);

  const envSecrets = [
    process.env.GEMINI_API_KEY,
    process.env.DUPOND_AUTH_TOKEN,
    process.env.DUPOND_API_KEY,
    process.env.DUPOND_APPROVAL_TOKEN,
    process.env.GITHUB_TOKEN,
  ];
  for (const secret of envSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 6) {
      text = text.split(trimmed).join('[REDACTED]');
    }
  }

  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  text = text.replace(/\bdp_[0-9a-f]{16,}\b/gi, '[REDACTED]');
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]');
  text = text.replace(/([?&](?:key|token|apiKey|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
  return text;
}

export function boundText(
  raw: string | null | undefined,
  maxChars: number,
): { text: string; truncated: boolean } {
  const sanitized = sanitizeEvidenceText(raw);
  if (sanitized.length <= maxChars) {
    return { text: sanitized, truncated: false };
  }
  return {
    text: `${sanitized.slice(0, maxChars)}\n... [truncated ${sanitized.length - maxChars} characters]`,
    truncated: true,
  };
}

function isCommitSha(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value.trim());
}

function resolveTrustedRepoPath(params: {
  task: TaskRecord | null;
  projectRepoLocalPath?: string | null;
}): string | null {
  const candidates = [params.task?.targetRepoPath, params.projectRepoLocalPath];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = path.resolve(candidate.trim());
    if (fs.existsSync(path.join(resolved, '.git')) || fs.existsSync(path.join(resolved, 'HEAD'))) {
      return resolved;
    }
  }
  return null;
}

function parseProviderModel(
  boundAttempt: RunAttemptRecord | undefined,
  attempts: RunAttemptRecord[],
): { provider: string | null; model: string | null } {
  const targetAttempt = boundAttempt ?? attempts[attempts.length - 1];
  if (targetAttempt?.workerType && targetAttempt.workerType.trim()) {
    const raw = targetAttempt.workerType.trim();
    const idx = raw.indexOf(':');
    if (idx > 0) {
      return {
        provider: raw.slice(0, idx),
        model: raw.slice(idx + 1) || null,
      };
    }
    return { provider: raw, model: null };
  }
  return { provider: null, model: null };
}

function readImmutableGitDiff(params: {
  repoPath: string;
  baseCommit: string;
  candidateSha: string;
  expectedTreeSha?: string | null;
}): { ok: true; diff: string; changedFiles: string[] } | { ok: false; reason: string } {
  const { repoPath, baseCommit, candidateSha, expectedTreeSha } = params;
  if (!isSafeGitRef(baseCommit) || !isCommitSha(candidateSha)) {
    return {
      ok: false,
      reason: 'Recorded base commit or candidate revision is not a valid Git reference.',
    };
  }
  try {
    // Verify both base and candidate commit objects exist in the immutable object store
    execFileSync('git', ['-C', repoPath, 'cat-file', '-e', `${candidateSha}^{commit}`], {
      stdio: 'pipe',
    });
    execFileSync('git', ['-C', repoPath, 'cat-file', '-e', `${baseCommit}^{commit}`], {
      stdio: 'pipe',
    });

    if (expectedTreeSha) {
      const actualTreeSha = execFileSync(
        'git',
        ['-C', repoPath, 'rev-parse', '--verify', `${candidateSha}^{tree}`],
        { encoding: 'utf-8', stdio: 'pipe' },
      ).trim();
      if (actualTreeSha !== expectedTreeSha) {
        return {
          ok: false,
          reason: `Candidate commit ${candidateSha.slice(0, 12)} tree (${actualTreeSha.slice(0, 12)}) does not match verified tree (${expectedTreeSha.slice(0, 12)}).`,
        };
      }
    }

    const nameOut = execFileSync(
      'git',
      ['-C', repoPath, 'diff', '--name-only', '--no-ext-diff', '--no-textconv', baseCommit, candidateSha],
      { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 2 * 1024 * 1024 },
    );
    const diffOut = execFileSync(
      'git',
      ['-C', repoPath, 'diff', '--no-ext-diff', '--no-textconv', baseCommit, candidateSha],
      { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 },
    );
    const changedFiles = nameOut
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { ok: true, diff: diffOut, changedFiles };
  } catch {
    return {
      ok: false,
      reason: `Candidate commit ${candidateSha.slice(0, 12)} or base commit could not be reconstructed from immutable Git history.`,
    };
  }
}

export function buildSanitizedRunEvidence(params: {
  run: TaskRunRecord;
  task: TaskRecord | null;
  attempts: RunAttemptRecord[];
  verification: VerificationRecord | null;
  delivery: DeliveryRecord | null;
  projectRepoLocalPath?: string | null;
}): {
  run: TaskRunRecord;
  attempts: SanitizedAttemptRecord[];
  verification: SanitizedVerificationRecord | null;
  delivery: DeliveryRecord | null;
  evidence: CandidateEvidencePayload;
} {
  const { run, task, attempts, verification, delivery, projectRepoLocalPath } = params;

  const sanitizedAttempts: SanitizedAttemptRecord[] = attempts.map((attempt) => {
    const { prompt: _omittedPrompt, ...rest } = attempt;
    const boundedDiff = attempt.diff ? boundText(attempt.diff, MAX_DIFF_CHARS) : null;
    const boundedLogs = attempt.logs ? boundText(attempt.logs, MAX_LOG_CHARS) : null;
    return {
      ...rest,
      diff: boundedDiff ? boundedDiff.text : null,
      diffTruncated: boundedDiff?.truncated ?? false,
      logs: boundedLogs ? boundedLogs.text : null,
      logsTruncated: boundedLogs?.truncated ?? false,
      errorMessage: attempt.errorMessage ? sanitizeEvidenceText(attempt.errorMessage) : null,
    };
  });

  const sanitizedVerification: SanitizedVerificationRecord | null = verification
    ? {
        ...verification,
        failureReason: verification.failureReason
          ? sanitizeEvidenceText(verification.failureReason)
          : null,
        checks: (verification.checks || []).map((check) => {
          const out = boundText(check.stdout, MAX_CHECK_OUTPUT_CHARS);
          const err = boundText(check.stderr, MAX_CHECK_OUTPUT_CHARS);
          return {
            ...check,
            command: sanitizeEvidenceText(check.command),
            stdout: out.text,
            stderr: err.text,
            stdoutTruncated: out.truncated,
            stderrTruncated: err.truncated,
          };
        }),
      }
    : null;

  const sanitizedRun: TaskRunRecord = {
    ...run,
    failureReason: run.failureReason ? sanitizeEvidenceText(run.failureReason) : null,
  };

  // Explicitly validate run <-> verification <-> attempt bindings.
  // Never substitute an unrelated attempt when verification.attemptId is missing or mismatched.
  let bindingError: string | null = null;
  let boundAttempt: RunAttemptRecord | undefined;

  if (verification) {
    if (verification.runId !== run.id) {
      bindingError = `Verification record ${verification.id} belongs to run ${verification.runId}, not ${run.id}.`;
    } else if (!verification.attemptId) {
      bindingError = `Verification record ${verification.id} does not reference an attempt.`;
    } else {
      const matched = attempts.find((a) => a.id === verification.attemptId);
      if (!matched) {
        bindingError = `Verification record ${verification.id} references attempt ${verification.attemptId}, which is not recorded for run ${run.id}.`;
      } else if (matched.runId !== run.id) {
        bindingError = `Verified attempt ${matched.id} belongs to run ${matched.runId}, not ${run.id}.`;
      } else {
        boundAttempt = matched;
      }
    }
  }

  const { provider, model } = parseProviderModel(boundAttempt, attempts);

  const candidateRevision =
    !bindingError && isCommitSha(verification?.revisionSha)
      ? verification!.revisionSha
      : !verification && isCommitSha(delivery?.deliveredCommit)
        ? delivery!.deliveredCommit
        : null;

  let changedFiles: string[] = [];
  let candidateDiff: string | null = null;
  let candidateDiffTruncated = false;
  let provenance: CandidateDiffProvenance = 'unavailable';
  let candidateDiffUnavailableReason: string | null = null;

  if (bindingError) {
    candidateDiffUnavailableReason = bindingError;
  } else if (candidateRevision) {
    const trustedRepoPath = resolveTrustedRepoPath({ task, projectRepoLocalPath });
    if (trustedRepoPath && isSafeGitRef(run.baseCommit)) {
      void verifiedRefForRun(run.id);
      const gitResult = readImmutableGitDiff({
        repoPath: trustedRepoPath,
        baseCommit: run.baseCommit,
        candidateSha: candidateRevision,
        expectedTreeSha: verification?.revisionTreeSha,
      });
      if (gitResult.ok) {
        const bounded = boundText(gitResult.diff, MAX_DIFF_CHARS);
        candidateDiff = bounded.text;
        candidateDiffTruncated = bounded.truncated;
        changedFiles = gitResult.changedFiles;
        provenance = 'immutable_git_commit';
      } else {
        candidateDiffUnavailableReason = gitResult.reason;
      }
    } else {
      candidateDiffUnavailableReason =
        'Target repository path or base commit is unavailable for immutable candidate commit inspection.';
    }
  } else {
    candidateDiffUnavailableReason =
      run.status === 'failed' || run.status === 'cancelled'
        ? 'No verified candidate revision was committed because the run did not produce a verified candidate.'
        : 'No verified candidate revision is recorded for this run yet.';
  }

  return {
    run: sanitizedRun,
    attempts: sanitizedAttempts,
    verification: sanitizedVerification,
    delivery,
    evidence: {
      runId: run.id,
      taskId: run.taskId,
      projectId: run.projectId,
      candidateRevision,
      baseCommit: run.baseCommit || null,
      targetRepo: run.targetRepo || task?.targetRepo || null,
      targetBranch: run.targetBranch || null,
      provider,
      model,
      changedFiles,
      candidateDiff,
      candidateDiffStatus: candidateDiff !== null ? 'available' : 'unavailable',
      candidateDiffTruncated,
      candidateDiffUnavailableReason,
      provenance,
    },
  };
}

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = path.join(__dirname, 'artifactRunnerScript.mjs');

const DEFAULT_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1000;
const MAX_STDOUT_BYTES = 1024 * 1024;

/** stdlib only, no project secrets. Nothing the artifact needs to do its job. */
const CHILD_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
};

export interface ArtifactRunResult {
  /** Compilation of the implementation source. */
  syntaxOk: boolean;
  /** Test suite ran without throwing. */
  testsOk: boolean;
  /** Acceptance criteria the suite declared as covered. */
  criteria: string[];
  detail: string;
}

interface RunnerProtocol {
  ok?: boolean;
  reason?: string;
  detail?: string;
  criteria?: string[];
}

function failure(detail: string, syntaxOk = false): ArtifactRunResult {
  return { syntaxOk, testsOk: false, criteria: [], detail };
}

/**
 * Runs untrusted artifact code (implementation + spec suite) in a short-lived
 * child process instead of `node:vm`.
 *
 * vm.Script/runInContext is not a security boundary, and the previous sandbox
 * handed artifacts `require`, `crypto` and `assert` directly inside the API
 * server's own process. The child here receives its payload on stdin (never
 * argv), inherits no environment secrets, is killed on timeout with a
 * SIGTERM->SIGKILL escalation, and can only return a small fixed schema.
 *
 * Threat model: artifact code is reviewed code. This limits blast radius
 * (stolen credentials, state files, the request stream) and execution time; it
 * is not a defence against a determined malicious artifact.
 */
export function runArtifactVerification(
  implementationCode: string,
  testCode: string | null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ArtifactRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stdoutTruncated = false;
    let stderr = '';
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const child = spawn(process.execPath, [RUNNER_SCRIPT], {
      env: CHILD_ENV,
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const settle = (result: ArtifactRunResult) => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length >= MAX_STDOUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });

    // Payload travels on stdin so no source text appears in the process table.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ implementationCode, testCode: testCode ?? '' }));

    child.on('error', (err) => {
      settle(failure(`runner could not start: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (stdoutTruncated) {
        settle(failure('runner exceeded its output limit'));
        return;
      }
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      if (!lastLine) {
        settle(
          failure(
            signal === 'SIGTERM'
              ? `runner timed out after ${timeoutMs}ms and was terminated`
              : `runner produced no result (exit ${code ?? 'unknown'})`,
          ),
        );
        return;
      }
      let parsed: RunnerProtocol;
      try {
        parsed = JSON.parse(lastLine) as RunnerProtocol;
      } catch {
        settle(failure('runner returned a malformed result'));
        return;
      }

      switch (parsed.reason) {
        case 'passed':
          settle({
            syntaxOk: true,
            testsOk: true,
            criteria: Array.isArray(parsed.criteria) ? parsed.criteria.filter((c) => typeof c === 'string') : [],
            detail: '',
          });
          return;
        case 'syntax-ok-no-tests':
          settle({ syntaxOk: true, testsOk: false, criteria: [], detail: 'Automated unit test suite not found on disk' });
          return;
        case 'syntax-failed':
          settle({ syntaxOk: false, testsOk: false, criteria: [], detail: String(parsed.detail || 'syntax error') });
          return;
        case 'test-failed':
          settle({ syntaxOk: true, testsOk: false, criteria: [], detail: String(parsed.detail || 'test failure') });
          return;
        default:
          settle(failure(`runner reported ${parsed.reason || 'an unknown failure'}`));
      }
    });

    // Escalate explicitly: a plain timeout only guarantees SIGTERM, which a
    // child that installs a handler could ignore and outlive the verification.
    termTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}

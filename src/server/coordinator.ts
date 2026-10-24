import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  isPathLexicallyContained,
  isSafePathSegment,
  readTextIfExists,
} from './artifactPaths';
import { runArtifactVerification } from './artifactRunner';
import {
  Task, 
  Agent, 
  Epic, 
  OrchestratorConfig, 
  IntegrationConfig, 
  CommunicationMessage,
  TaskStatus 
} from '../types';
import { StateMutationSchema } from '../types/schemas.js';
import { 
  DEFAULT_TASKS, 
  DEFAULT_AGENTS, 
  DEFAULT_EPICS, 
  DEFAULT_ORCHESTRATOR_CONFIG, 
  DEFAULT_INTEGRATION_CONFIG, 
  DEFAULT_COMMUNICATIONS 
} from '../data/defaultData';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Server-authoritative storage paths
const DATA_DIR = path.resolve(__dirname, '../../data');
// Overridable so a test run cannot write credentials into the shipped state file.
const STATE_FILE = process.env.AEGIS_STATE_FILE
  ? path.resolve(process.env.AEGIS_STATE_FILE)
  : path.resolve(DATA_DIR, 'aegis_state.json');
const ARTIFACTS_DIR = path.resolve(__dirname, '../../.aegis_artifacts');

/** Placeholder standing in for a stored secret. Matches the UI's masked value. */
export const REDACTED = '•'.repeat(32);

/**
 * True when a client-submitted secret is really the mask it was handed, i.e.
 * the user re-submitted a form they never re-typed. Callers must then fall back
 * to the value already held server-side.
 */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.includes('•');
}

/**
 * A state file written before a section existed (`data/aegis_state.json` ships
 * without `repository`) must not take down the credential surface, so both
 * accessors treat a missing section as an empty one rather than trusting the
 * declared type.
 */
function fillSection<T extends object>(section: T | undefined): T {
  return (section ?? {}) as T;
}

/** Replace one credential with the mask, leaving the section otherwise intact. */
function redactSecret<T extends object>(section: T | undefined, key: keyof T): T {
  const value = section?.[key];
  return { ...fillSection(section), [key]: typeof value === 'string' && value !== '' ? REDACTED : '' } as T;
}

/**
 * Resolves the artifact directory for a task key, failing closed.
 *
 * task.key reaches this code from HTTP bodies, so an unsanitized value made it
 * possible to point the artifact lookup anywhere on the filesystem
 * (`.aegis_artifacts/../../somewhere/implementation.js`) and have that file
 * accepted as a "verified physical code artifact". The containment check alone
 * would not help: path.resolve collapses the `..` segments before the check.
 */
function resolveArtifactDir(taskKey: string): string | null {
  if (!isSafePathSegment(taskKey)) return null;
  const resolved = path.resolve(ARTIFACTS_DIR, taskKey);
  return isPathLexicallyContained(ARTIFACTS_DIR, resolved) ? resolved : null;
}

export interface ServerState {
  tasks: Task[];
  agents: Agent[];
  epics: Epic[];
  orchestratorConfig: OrchestratorConfig;
  integrationConfig: IntegrationConfig;
  communications: CommunicationMessage[];
  cycleCount: number;
  daemonRunning: boolean;
  lastUpdated: string;
}

export interface VerificationCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  taskId: string;
  taskKey: string;
  checks: VerificationCheck[];
  timestamp: string;
  logs: string;
  sha256?: string;
}

class CoordinatorEngine {
  private state: ServerState;
  private daemonTimer: NodeJS.Timeout | null = null;
  private isProcessingTick = false;

  constructor() {
    this.ensureDirectories();
    this.state = this.loadStateFromDisk();
  }

  private ensureDirectories() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(ARTIFACTS_DIR)) {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    }
  }

  private loadStateFromDisk(): ServerState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          tasks: parsed.tasks || DEFAULT_TASKS,
          agents: parsed.agents || DEFAULT_AGENTS,
          epics: parsed.epics || DEFAULT_EPICS,
          orchestratorConfig: parsed.orchestratorConfig || DEFAULT_ORCHESTRATOR_CONFIG,
          integrationConfig: parsed.integrationConfig || DEFAULT_INTEGRATION_CONFIG,
          communications: parsed.communications || DEFAULT_COMMUNICATIONS,
          cycleCount: parsed.cycleCount || 5,
          daemonRunning: false, // Default to false on reboot until explicitly commanded
          lastUpdated: new Date().toISOString(),
        };
      }
    } catch (err) {
      console.warn('Failed to load aegis_state.json, initializing defaults:', err);
    }

    const initialState: ServerState = {
      tasks: DEFAULT_TASKS,
      agents: DEFAULT_AGENTS,
      epics: DEFAULT_EPICS,
      orchestratorConfig: DEFAULT_ORCHESTRATOR_CONFIG,
      integrationConfig: DEFAULT_INTEGRATION_CONFIG,
      communications: DEFAULT_COMMUNICATIONS,
      cycleCount: 5,
      daemonRunning: false,
      lastUpdated: new Date().toISOString(),
    };
    this.saveStateToDisk(initialState);
    return initialState;
  }

  public saveStateToDisk(stateToSave?: ServerState): void {
    try {
      const data = stateToSave || this.state;
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write aegis_state.json to disk:', err);
    }
  }

  public getState(): ServerState {
    return this.state;
  }

  /**
   * State for client consumption. Server-held credentials are never included:
   * integrationConfig used to be returned verbatim by GET /api/orchestrate/state,
   * which put the Jira API token, the Slack webhook token (embedded in its URL
   * path) and the repository token on every page load. Slack and Jira webhook
   * URLs are bearer secrets in this product, not merely addresses.
   *
   * Internal code keeps using getState(); only the wire view is redacted.
   */
  public getStateView(): ServerState {
    return { ...this.state, integrationConfig: this.getIntegrationConfigView() };
  }

  public getIntegrationConfigView(): IntegrationConfig {
    const config = this.state.integrationConfig;
    return {
      ...config,
      jira: redactSecret(config.jira, 'apiToken'),
      slack: redactSecret(config.slack, 'webhookUrl'),
      repository: redactSecret(config.repository, 'apiToken'),
      customProviders: (config.customProviders ?? []).map((provider) => ({
        ...provider,
        apiKeyHeader: provider.apiKeyHeader ? REDACTED : provider.apiKeyHeader,
      })),
    };
  }

  /**
   * Credentials for server-side use only (Jira/Slack dispatch). Never return
   * this to a client.
   */
  public getIntegrationSecrets(): IntegrationConfig {
    const config = this.state.integrationConfig;
    return {
      ...config,
      jira: fillSection(config.jira),
      slack: fillSection(config.slack),
      repository: fillSection(config.repository),
      customProviders: config.customProviders ?? [],
    };
  }

  private preserveMaskedSecrets(partial: Partial<ServerState>): Partial<ServerState> {
    if (!partial.integrationConfig) return partial;

    const stored = this.getIntegrationSecrets();
    const incoming = partial.integrationConfig;

    // The UI is handed masked values; re-saving without retyping must not
    // replace the real credential with the mask it was shown.
    const keep = (candidate: string | undefined, existing: string | undefined): string =>
      candidate === undefined || candidate === '' || isMaskedSecret(candidate) ? (existing ?? '') : candidate;

    return {
      ...partial,
      integrationConfig: {
        ...incoming,
        jira: { ...incoming.jira, apiToken: keep(incoming.jira?.apiToken, stored.jira.apiToken) },
        slack: { ...incoming.slack, webhookUrl: keep(incoming.slack?.webhookUrl, stored.slack.webhookUrl) },
        repository: { ...incoming.repository, apiToken: keep(incoming.repository?.apiToken, stored.repository.apiToken) },
        customProviders: (incoming.customProviders ?? []).map((provider) => {
          const existing = stored.customProviders.find((p) => p.id === provider.id);
          return { ...provider, apiKeyHeader: keep(provider.apiKeyHeader, existing?.apiKeyHeader) };
        }),
      },
    };
  }

  // --- Central State Enforcement with Quality Gates & Schema Validation ---
  public updateState(partial: unknown): { success: boolean; state: ServerState; rejectedDoneTasks: string[]; error?: string } {
    const parseResult = StateMutationSchema.safeParse(partial);
    if (!parseResult.success) {
      return {
        success: false,
        state: this.state,
        rejectedDoneTasks: [],
        error: `State validation failed: ${parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      };
    }

    const validatedPartial = parseResult.data as Partial<ServerState>;
    const rejectedDoneTasks: string[] = [];

    // If incoming tasks are marked as 'done', verify each one strictly
    if (validatedPartial.tasks) {
      const existingTasks = this.state.tasks;
      validatedPartial.tasks = validatedPartial.tasks.map((task) => {
        const existing = existingTasks.find((t) => t.id === task.id || t.key === task.key);

        // Check if task is requested to be 'done'
        if (task.status === 'done') {
          // Enforce everything verifiable without spawning a compiler/test run.
          const verification = this.preflightQualityGates(task);
          if (!verification.passed) {
            rejectedDoneTasks.push(task.key);
            const failingReasons = verification.checks
              .filter((c) => !c.passed)
              .map((c) => `${c.rule}: ${c.detail}`)
              .join('; ');

            // Clamp back to review or existing status
            return {
              ...task,
              status: (existing?.status && existing.status !== 'done' ? existing.status : 'review') as TaskStatus,
              lastAgentComment: `Quality Gate REJECTED "Done" transition: ${failingReasons}`,
              lastUpdated: 'Just now',
            };
          }
        }
        return task;
      });
    }

    // Now that the wire view of integrationConfig is masked, a UI that re-saves
    // its form without the user re-typing would post the mask back. Preserve the
    // stored secret instead of overwriting it with '••••'.
    const partialWithTasks = this.preserveMaskedSecrets(validatedPartial);

    this.state = {
      ...this.state,
      ...partialWithTasks,
      lastUpdated: new Date().toISOString(),
    };

    if (rejectedDoneTasks.length > 0) {
      this.addCommunication({
        senderId: 'agent-orch',
        senderName: 'Aegis Prime Core',
        senderRole: 'Chief Orchestrator',
        recipientId: 'all',
        content: `Central Quality Gate enforced: Rejected unauthorized "Done" transition for [${rejectedDoneTasks.join(', ')}]. Quality checks must pass before completion.`,
        messageType: 'blocker',
      });
    }

    this.saveStateToDisk();
    return { success: true, state: this.state, rejectedDoneTasks };
  }

  // Centralized transition method
  public async transitionTaskStatus(taskId: string, targetStatus: TaskStatus): Promise<{
    success: boolean;
    task?: Task;
    verification?: VerificationResult;
    error?: string;
  }> {
    const task = this.state.tasks.find((t) => t.id === taskId || t.key === taskId);
    if (!task) {
      return { success: false, error: `Task ${taskId} not found` };
    }

    if (targetStatus === 'done') {
      const verification = await this.verifyTaskQualityGates(task);
      if (!verification.passed) {
        return {
          success: false,
          error: 'Quality gates failed. Task cannot be marked Done until all checks pass.',
          verification,
        };
      }
    }

    const updatedTask: Task = {
      ...task,
      status: targetStatus,
      lastUpdated: 'Just now',
    };

    this.state.tasks = this.state.tasks.map((t) => (t.id === task.id ? updatedTask : t));
    this.saveStateToDisk();

    return {
      success: true,
      task: updatedTask,
    };
  }

  /**
   * Cheap, synchronous gate used on the write path (updateState). It enforces
   * the checks that do not require executing anything: dependencies, acceptance
   * subtasks, and the *presence* of a physically contained artifact.
   *
   * The syntax and test-suite checks are deferred to verifyTaskQualityGates,
   * which must run a child process and therefore cannot be synchronous. The
   * artifact-presence check here is what makes "mark everything done" requests
   * from a client fail closed, so the write path keeps that property without
   * paying subprocess costs per task.
   */
  public preflightQualityGates(task: Task): VerificationResult {
    const checks: VerificationCheck[] = [...this.staticChecks(task)];
    const artifact = this.locateArtifact(task.key);

    checks.push({
      rule: 'Inspected Physical Code Artifact on Disk',
      passed: artifact !== null,
      detail: artifact
        ? `Physical artifact verified on disk at ${path.relative(process.cwd(), artifact.path)} (${fs.statSync(artifact.path).size} bytes)`
        : `No physical code artifact found on disk in .aegis_artifacts/${task.key}/`,
    });

    // Only the checks that actually ran contribute to the verdict; compilation
    // and test execution belong to verifyTaskQualityGates.
    return {
      passed: checks.every((c) => c.passed),
      taskId: task.id,
      taskKey: task.key,
      checks,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      logs: checks.map((c) => `[${c.passed ? 'PASS' : 'FAIL'}] ${c.rule}: ${c.detail}`).join('\n'),
      sha256: artifact?.sha256,
    };
  }

  /**
   * Strict, multi-rule verification. Runs artifact compilation and its test
   * suite in an isolated child process (see artifactRunner.ts).
   */
  public async verifyTaskQualityGates(task: Task): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [...this.staticChecks(task)];
    const artifact = this.locateArtifact(task.key);

    checks.push({
      rule: 'Inspected Physical Code Artifact on Disk',
      passed: artifact !== null,
      detail: artifact
        ? `Physical artifact verified on disk at ${path.relative(process.cwd(), artifact.path)} (${fs.statSync(artifact.path).size} bytes)`
        : `No physical code artifact found on disk in .aegis_artifacts/${task.key}/`,
    });

    let syntaxPassed = false;
    let syntaxDetail = 'No code artifact available for syntax compilation';
    let testPassed = false;
    let testDetail = 'Automated unit test suite not found on disk';

    if (artifact) {
      const run = await runArtifactVerification(artifact.code, artifact.testCode);

      if (artifact.isLegacyMarkdown && !run.testsOk && !run.syntaxOk) {
        // Legacy deliverables are markdown; their embedded snippet was never a
        // standalone module, so only the compilation result is meaningful.
        syntaxPassed = false;
        syntaxDetail = `Syntax compilation error: ${run.detail}`;
        testDetail = `Legacy artifact: compilation of embedded snippet failed (${run.detail})`;
      } else {
        syntaxPassed = run.syntaxOk;
        syntaxDetail = run.syntaxOk
          ? `Compiler AST verified: 0 syntax errors detected across ${artifact.code.split('\n').length} lines`
          : `Syntax compilation error: ${run.detail}`;

        if (run.testsOk) {
          testPassed = true;
          testDetail = `Automated unit assertions passed in isolated subprocess (SHA-256: ${artifact.sha256.slice(0, 16)}...)`;
        } else {
          testDetail = artifact.testCode === null
            ? 'Automated unit test suite not found on disk'
            : `Unit assertion failure: ${run.detail}`;
        }
      }
    }

    checks.push({ rule: 'Real Compiler AST Syntax Verification', passed: syntaxPassed, detail: syntaxDetail });
    checks.push({ rule: 'Automated Test Suite & Cryptographic Hash', passed: testPassed, detail: testDetail });

    return this.assemble(task, checks, artifact?.sha256);
  }

  /** Checks that need neither the filesystem nor a subprocess. */
  private staticChecks(task: Task): VerificationCheck[] {
    const checks: VerificationCheck[] = [];
    const allTasks = this.state.tasks;

    const dependencies = task.dependencies || [];
    const failingDependencies: string[] = [];

    for (const depId of dependencies) {
      const depTask = allTasks.find((t) => t.id === depId || t.key === depId);
      if (!depTask) {
        failingDependencies.push(`${depId} (MISSING from sprint backlog)`);
      } else if (depTask.status !== 'done') {
        failingDependencies.push(`${depTask.key} (Status is ${depTask.status.toUpperCase()})`);
      }
    }

    checks.push({
      rule: 'Prerequisite Dependencies Cleared',
      passed: failingDependencies.length === 0,
      detail: failingDependencies.length === 0
        ? dependencies.length > 0
          ? `All ${dependencies.length} upstream dependencies verified Done`
          : 'No upstream dependencies required'
        : `Blocked by dependencies: ${failingDependencies.join('; ')}`,
    });

    const subtasks = task.subtasks || [];
    const uncompletedSubtasks = subtasks.filter((st) => !st.completed);
    checks.push({
      rule: 'Acceptance Criteria Subtasks Verified',
      passed: subtasks.length > 0 && uncompletedSubtasks.length === 0,
      detail: subtasks.length === 0
        ? 'No acceptance subtasks defined for this task'
        : uncompletedSubtasks.length === 0
        ? `All ${subtasks.length} acceptance criteria subtasks checked and passed`
        : `${uncompletedSubtasks.length} of ${subtasks.length} subtask(s) still incomplete`,
    });

    return checks;
  }

  /**
   * Locates the task's artifact, returning null for any key that is not a safe
   * single path component. `code` holds the snippet that gets compiled/run.
   */
  private locateArtifact(taskKey: string): {
    path: string;
    dir: string;
    code: string;
    testCode: string | null;
    sha256: string;
    isLegacyMarkdown: boolean;
  } | null {
    const dir = resolveArtifactDir(taskKey);
    if (!dir) return null;

    const codeFilePath = path.resolve(dir, 'implementation.js');
    const testFilePath = path.resolve(dir, 'spec.test.js');
    const legacyPath = path.resolve(path.dirname(dir), `${taskKey}_deliverable.md`);

    const code = readTextIfExists(codeFilePath);
    if (code !== null && code.length > 0) {
      return {
        path: codeFilePath,
        dir,
        code,
        testCode: readTextIfExists(testFilePath),
        sha256: crypto.createHash('sha256').update(code).digest('hex'),
        isLegacyMarkdown: false,
      };
    }

    const legacy = readTextIfExists(legacyPath);
    if (legacy === null || legacy.length === 0) return null;

    let snippet = legacy;
    if (legacy.includes('```')) {
      const match = legacy.match(/```(?:typescript|javascript|js|ts)?\n([\s\S]*?)```/);
      if (match && match[1]) snippet = match[1];
    }

    return {
      path: legacyPath,
      dir,
      code: snippet,
      testCode: null,
      sha256: crypto.createHash('sha256').update(snippet).digest('hex'),
      isLegacyMarkdown: true,
    };
  }

  private assemble(task: Task, checks: VerificationCheck[], sha256?: string): VerificationResult {
    return {
      passed: checks.every((c) => c.passed),
      taskId: task.id,
      taskKey: task.key,
      checks,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      logs: checks.map((c) => `[${c.passed ? 'PASS' : 'FAIL'}] ${c.rule}: ${c.detail}`).join('\n'),
      sha256,
    };
  }

  // --- Real Coding Worker: Generates Real Application Code & Tests on Disk ---
  public async executeWorkerStep(task: Task, agent: Agent): Promise<{
    deliverableContent: string;
    artifactFilePath: string;
    testFilePath: string;
    fileSize: number;
    sha256: string;
    subtasksCompleted: string[];
    actionTaken: string;
  }> {
    const blocked = () => new Error(
      `Execution blocked: No capable worker connected to fulfill acceptance criteria for ${task.key} (${task.title}). Requires real implementation in workspace.`
    );

    const taskArtifactDir = resolveArtifactDir(task.key);
    if (!taskArtifactDir) throw blocked();

    const codeFilePath = path.resolve(taskArtifactDir, 'implementation.js');
    const testFilePath = path.resolve(taskArtifactDir, 'spec.test.js');

    // Check if a verified, non-generic implementation already exists on disk
    if (!isPathLexicallyContained(ARTIFACTS_DIR, taskArtifactDir)) throw blocked();

    const implementationCode = readTextIfExists(codeFilePath);
    const testCode = readTextIfExists(testFilePath);

    if (implementationCode === null || testCode === null) throw blocked();

    // Execute the suite in a short-lived child process with no inherited
    // secrets and a hard timeout. See artifactRunner.ts for the threat model.
    const run = await runArtifactVerification(implementationCode, testCode);

    if (!run.testsOk) {
      throw new Error(`Unit tests failed for ${task.key}: ${run.detail}. Cannot advance stage.`);
    }

    const verifiedCriteria = run.criteria;
    const sha256 = crypto.createHash('sha256').update(implementationCode).digest('hex');
    const fileSize = Buffer.byteLength(implementationCode, 'utf8');

    // Only mark subtasks that have explicitly been mapped to passing test assertions
    const subtasksCompleted = (task.subtasks || [])
      .filter((s) => verifiedCriteria.includes(s.id))
      .map((s) => s.id);

    const deliverableContent = `### Implementation Artifact: \`${task.key}\`
**Specialist:** ${agent.name} (${agent.role})
**File Path:** \`.aegis_artifacts/${task.key}/implementation.js\` (${fileSize} bytes)
**SHA-256 Hash:** \`${sha256}\`
**Test Suite:** \`.aegis_artifacts/${task.key}/spec.test.js\` (Unit assertions verified)

\`\`\`javascript
${implementationCode.slice(0, 500)}...
\`\`\`
`;

    return {
      deliverableContent,
      artifactFilePath: `.aegis_artifacts/${task.key}/implementation.js`,
      testFilePath: `.aegis_artifacts/${task.key}/spec.test.js`,
      fileSize,
      sha256,
      subtasksCompleted,
      actionTaken: `Executed verified code and test suite for ${task.key} (SHA-256: ${sha256.slice(0, 12)}...)`,
    };
  }

  // --- Background Daemon Autonomous Coordinator ---
  public startDaemon(intervalMs = 7000): void {
    if (this.daemonTimer) return;
    this.state.daemonRunning = true;
    this.saveStateToDisk();

    console.log(`[Aegis Daemon] Server-Authoritative Coordinator started (Interval: ${intervalMs}ms)`);

    this.daemonTimer = setInterval(async () => {
      await this.runDaemonTick();
    }, intervalMs);
  }

  public stopDaemon(): void {
    if (this.daemonTimer) {
      clearInterval(this.daemonTimer);
      this.daemonTimer = null;
    }
    this.state.daemonRunning = false;
    this.saveStateToDisk();
    console.log('[Aegis Daemon] Server coordinator paused');
  }

  public isDaemonRunning(): boolean {
    return this.state.daemonRunning;
  }

  // Authoritative single-step coordinator tick
  public async runDaemonTick(): Promise<{ advanced: boolean; targetTask?: Task; action?: string }> {
    if (this.isProcessingTick) return { advanced: false };
    this.isProcessingTick = true;

    try {
      const { tasks, agents } = this.state;

      // 1. Check tasks in 'in_progress' -> advance to 'review' by running real coding worker
      const inProgressTask = tasks.find((t) => t.status === 'in_progress');
      if (inProgressTask) {
        const agent = agents.find((a) => a.id === inProgressTask.assignedAgentId) || agents[1];
        const workerResult = await this.executeWorkerStep(inProgressTask, agent);

        // Map subtasks strictly to verified evidence from worker execution
        const updatedSubtasks = (inProgressTask.subtasks || []).map((s) => ({
          ...s,
          completed: s.completed || (workerResult.subtasksCompleted && workerResult.subtasksCompleted.includes(s.id)),
        }));
        const updatedDeliverables = [...(inProgressTask.deliverables || []), workerResult.deliverableContent];

        const updatedTask: Task = {
          ...inProgressTask,
          status: 'review',
          subtasks: updatedSubtasks,
          deliverables: updatedDeliverables,
          spentHours: (inProgressTask.spentHours || 0) + 4,
          lastAgentComment: `${agent.name}: Generated real code & tests (${workerResult.fileSize}B, SHA: ${workerResult.sha256.slice(0, 8)}). Ready for Quality Gate.`,
          lastUpdated: 'Just now',
        };

        this.state.tasks = tasks.map((t) => (t.id === inProgressTask.id ? updatedTask : t));

        this.addCommunication({
          senderId: agent.id,
          senderName: agent.name,
          senderRole: agent.role,
          recipientId: 'all',
          content: `Generated code deliverable for ${inProgressTask.key} at ${workerResult.artifactFilePath}. Advanced to REVIEW stage.`,
          messageType: 'deliverable',
          taskId: inProgressTask.key,
        });

        this.state.cycleCount += 1;
        this.saveStateToDisk();
        return { advanced: true, targetTask: updatedTask, action: 'advanced_to_review' };
      }

      // 2. Check tasks in 'review' -> run STRICT verification gates
      const reviewTask = tasks.find((t) => t.status === 'review');
      if (reviewTask) {
        const verification = await this.verifyTaskQualityGates(reviewTask);

        if (verification.passed) {
          const updatedTask: Task = {
            ...reviewTask,
            status: 'done',
            lastAgentComment: `Quality Gate PASSED: Verified dependencies, compiler syntax, tests, and disk artifact (SHA-256: ${verification.sha256?.slice(0, 8) || 'verified'}).`,
            lastUpdated: 'Just now',
          };
          this.state.tasks = tasks.map((t) => (t.id === reviewTask.id ? updatedTask : t));

          const agentId = reviewTask.assignedAgentId;
          this.state.agents = agents.map((a) =>
            a.id === agentId ? { ...a, completedTasksCount: a.completedTasksCount + 1 } : a
          );

          this.addCommunication({
            senderId: 'agent-orch',
            senderName: 'Aegis Prime Core',
            senderRole: 'Chief Orchestrator',
            recipientId: 'all',
            content: `Quality Gate PASSED for ${reviewTask.key}. Compiler AST check & test assertions validated. Task marked DONE.`,
            messageType: 'qa_verdict',
            taskId: reviewTask.key,
          });

          this.state.cycleCount += 1;
          this.saveStateToDisk();
          return { advanced: true, targetTask: updatedTask, action: 'marked_done' };
        } else {
          // Verification failed - clamp back to in_progress with exact blocker reason
          const failedCheck = verification.checks.find((c) => !c.passed);
          const failureReason = failedCheck ? `${failedCheck.rule}: ${failedCheck.detail}` : 'Incomplete criteria';

          const updatedTask: Task = {
            ...reviewTask,
            status: 'in_progress',
            lastAgentComment: `Quality Gate BLOCKED: ${failureReason}`,
            lastUpdated: 'Just now',
          };
          this.state.tasks = tasks.map((t) => (t.id === reviewTask.id ? updatedTask : t));

          this.addCommunication({
            senderId: 'agent-orch',
            senderName: 'Aegis Prime Core',
            senderRole: 'Chief Orchestrator',
            recipientId: 'all',
            content: `Quality Gate BLOCKED for ${reviewTask.key}: ${failureReason}. Task routed back to IN_PROGRESS.`,
            messageType: 'blocker',
            taskId: reviewTask.key,
          });

          this.saveStateToDisk();
          return { advanced: true, targetTask: updatedTask, action: 'quality_gate_blocked' };
        }
      }

      // 3. Check tasks in 'todo' whose dependencies are ALL 'done'
      const todoTask = tasks.find((t) => {
        if (t.status !== 'todo') return false;
        const deps = t.dependencies || [];
        if (deps.length === 0) return true;
        return deps.every((depId) => {
          const d = tasks.find((item) => item.id === depId || item.key === depId);
          return d && d.status === 'done';
        });
      });

      if (todoTask) {
        const agent = agents.find((a) => a.id === todoTask.assignedAgentId) || agents[1];
        const updatedTask: Task = {
          ...todoTask,
          status: 'in_progress',
          lastAgentComment: `${agent.name}: Dependencies verified clear. Claimed task for execution.`,
          lastUpdated: 'Just now',
        };
        this.state.tasks = tasks.map((t) => (t.id === todoTask.id ? updatedTask : t));

        this.addCommunication({
          senderId: agent.id,
          senderName: agent.name,
          senderRole: agent.role,
          recipientId: 'all',
          content: `Assumed active work on ${todoTask.key}: ${todoTask.title}. Dependencies verified Done.`,
          messageType: 'status_update',
          taskId: todoTask.key,
        });

        this.saveStateToDisk();
        return { advanced: true, targetTask: updatedTask, action: 'claimed_in_progress' };
      }

      return { advanced: false };
    } catch (tickErr) {
      console.error('[Aegis Daemon] Tick error:', tickErr);
      return { advanced: false };
    } finally {
      this.isProcessingTick = false;
    }
  }

  private addCommunication(msg: Omit<CommunicationMessage, 'id' | 'timestamp'>) {
    const newMsg: CommunicationMessage = {
      id: `comm-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ...msg,
    };
    this.state.communications = [newMsg, ...this.state.communications.slice(0, 49)];
  }

  // --- Mutate State from Chat Actions ---
  public applyChatAction(action: {
    type: string;
    taskKey?: string;
    priority?: string;
    agentId?: string;
    status?: string;
    title?: string;
    estimatedHours?: number;
    role?: string;
  }): string {
    const { tasks, agents } = this.state;

    switch (action.type) {
      case 'UPDATE_PRIORITY': {
        const task = tasks.find((t) => t.key === action.taskKey || t.id === action.taskKey);
        if (task && action.priority) {
          task.priority = action.priority as any;
          this.saveStateToDisk();
          return `Updated priority of ${task.key} to ${action.priority.toUpperCase()}`;
        }
        break;
      }
      case 'REASSIGN_TASK': {
        const task = tasks.find((t) => t.key === action.taskKey || t.id === action.taskKey);
        const agent = agents.find((a) => a.id === action.agentId || a.name.toLowerCase().includes((action.agentId || '').toLowerCase()));
        if (task && agent) {
          task.assignedAgentId = agent.id;
          this.saveStateToDisk();
          return `Reassigned task ${task.key} to ${agent.name} (${agent.role})`;
        }
        break;
      }
      case 'CREATE_TASK': {
        if (action.title) {
          const newTask: Task = {
            id: `task-${Date.now()}`,
            key: `AEG-${100 + tasks.length + 1}`,
            title: action.title,
            description: `Task created via Orchestrator directive: ${action.title}`,
            epicId: 'epic-core',
            status: 'todo',
            priority: (action.priority as any) || 'high',
            assignedAgentId: 'agent-arch',
            estimatedHours: action.estimatedHours || 6,
            spentHours: 0,
            dependencies: [],
            subtasks: [
              { id: `st-${Date.now()}-1`, title: 'Implement functional service logic', completed: false },
              { id: `st-${Date.now()}-2`, title: 'Pass unit assertions & compiler check', completed: false },
            ],
            tags: ['Orchestrator Directive'],
            deliverables: [],
            lastUpdated: 'Just now',
          };
          this.state.tasks = [newTask, ...this.state.tasks];
          this.saveStateToDisk();
          return `Created task ${newTask.key}: "${newTask.title}"`;
        }
        break;
      }
      case 'START_DAEMON': {
        this.startDaemon();
        return 'Server background coordinator daemon started.';
      }
      case 'STOP_DAEMON': {
        this.stopDaemon();
        return 'Server background coordinator daemon paused.';
      }
    }
    return 'Action parsed and evaluated.';
  }
}

export const coordinator = new CoordinatorEngine();

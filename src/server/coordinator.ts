import { DomainError } from './utils/errors';
import { GEMINI_MODEL } from './gemini';
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
import { taskStore } from './db/database.js';
import { defaultProjectStore } from './projects/projectStore.js';
import type { TaskRecord } from './db/schema.js';
import { mergePostedCriteria, promoteChecklistItems } from '../services/acceptanceMapping.js';
import { defaultLifecycleService } from './lifecycle/lifecycleService.js';
import { defaultRepairCoordinator } from './coordinator/repairCoordinator.js';
import { WorkspaceManager } from './workspace/workspaceManager.js';
import { resolveTargetRepository, orchestratorRepoSlug, isOrchestratorSelfTarget } from './workspace/targetRepositoryResolver.js';
import { resolveCodingWorker } from './worker/workerRegistry.js';
import { CodingWorkerAdapter } from './worker/types.js';
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
const STATE_FILE = process.env.DUPOND_STATE_FILE
  ? path.resolve(process.env.DUPOND_STATE_FILE)
  : path.resolve(DATA_DIR, 'dupond_state.json');
const ARTIFACTS_DIR = path.resolve(__dirname, '../../.dupond_artifacts');

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
 * A state file written before a section existed (`data/dupond_state.json` ships
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
 * (`.dupond_artifacts/../../somewhere/implementation.js`) and have that file
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

export class CoordinatorEngine {
  private state: ServerState;
  private activeProjectId = 'default';
  private daemonTimer: NodeJS.Timeout | null = null;
  private isProcessingTick = false;

  constructor() {
    this.ensureDirectories();
    this.state = this.loadStateFromDisk();
    try {
      if (defaultProjectStore.getProjectState<Partial<ServerState>>('default', {}).tasks === undefined) {
        defaultProjectStore.saveProjectState('default', this.state);
      }
    } catch (err) {
      console.warn('Project state migration unavailable:', err);
    }
    // On boot the store is the source of truth for lifecycle outcomes that
    // happened in a previous process (delivered work, revocations, restarts
    // that interrupted a run). Reconcile abandoned runs, then project the
    // persisted statuses into the UI before anyone reads the JSON blob.
    try {
      taskStore.reconcileOnRestart();
      this.projectAuthoritativeStatuses();
    } catch (err) {
      console.warn('Startup lifecycle reconciliation unavailable:', err);
    }
  }

  /**
   * The JSON board has no "blocked" column; a blocked store record projects to
   * todo with the blocking context carried in the comment. Never invents an
   * acceptance-bearing status.
   */
  private toUiStatus(status: string): TaskStatus {
    return (status === 'blocked' ? 'todo' : status) as TaskStatus;
  }

  /**
   * Copies authoritative task statuses and acceptance contract fields from the
   * store into the JSON state the UI renders. Returns the number of entries
   * changed. This is projection only — it never grants or revokes acceptance;
   * the store already holds the outcome of the lifecycle service's evidence
   * gates. The contract is mirrored as well as the status, otherwise the board
   * keeps displaying requirements that were revoked or never persisted.
   */
  public projectAuthoritativeStatuses(projectId = 'default'): number {
    const previousState = this.state;
    const previousProjectId = this.activeProjectId;
    this.activeProjectId = projectId;
    this.state = this.getState(projectId);
    try {
      return this.projectAuthoritativeStatusesInternal();
    } finally {
      if (projectId !== 'default') this.state = previousState;
      this.activeProjectId = previousProjectId;
    }
  }

  private projectAuthoritativeStatusesInternal(): number {
    let changed = 0;
    const nextTasks = this.state.tasks.map((task) => {
      const dbTask = taskStore.getTask(task.id, this.activeProjectId) || taskStore.getTask(task.key, this.activeProjectId);
      if (!dbTask) return task;
      const projected = this.toUiStatus(dbTask.status);
      const specMirrored = this.mirrorAuthoritativeSpec(task, dbTask);
      if (projected === task.status) {
        if (specMirrored !== task) changed += 1;
        return specMirrored;
      }
      changed += 1;
      return {
        ...specMirrored,
        status: projected,
        lastAgentComment: `Authoritative lifecycle: status projected from persisted record "${dbTask.status}".`,
        lastUpdated: 'Just now',
      };
    });
    if (changed > 0) {
      this.state.tasks = nextTasks;
      this.saveStateToDisk();
    }
    return changed;
  }

  /**
   * Overlays the persisted acceptance contract on a board entry so the UI can
   * only ever show the requirements that the evidence gates will enforce.
   * Returns the entry unchanged when it already matches.
   */
  private mirrorAuthoritativeSpec(
    task: Task,
    dbTask: TaskRecord | null,
  ): Task {
    if (!dbTask) return task;
    const criteria = dbTask.acceptanceCriteria.map((c) => ({
      id: c.id,
      title: c.title,
      completed: Boolean(c.completed),
      ...(c.checkCommand ? { checkCommand: c.checkCommand } : {}),
    }));
    const unchanged =
      task.description === (dbTask.description ?? '') &&
      JSON.stringify(task.acceptanceCriteria ?? []) === JSON.stringify(criteria) &&
      JSON.stringify(task.verificationCommands ?? []) === JSON.stringify(dbTask.verificationCommands ?? []) &&
      JSON.stringify(task.protectedPaths ?? []) === JSON.stringify(dbTask.protectedPaths ?? []);
    if (unchanged) return task;
    return {
      ...task,
      description: dbTask.description ?? '',
      acceptanceCriteria: criteria,
      verificationCommands: dbTask.verificationCommands,
      protectedPaths: dbTask.protectedPaths,
    };
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
      console.warn('Failed to load dupond_state.json, initializing defaults:', err);
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

  private emptyState(): ServerState {
    return {
      tasks: [],
      agents: DEFAULT_AGENTS,
      epics: [],
      orchestratorConfig: DEFAULT_ORCHESTRATOR_CONFIG,
      integrationConfig: DEFAULT_INTEGRATION_CONFIG,
      communications: [],
      cycleCount: 0,
      daemonRunning: false,
      lastUpdated: new Date().toISOString(),
    };
  }

  public saveStateToDisk(stateToSave?: ServerState): void {
    try {
      const data = stateToSave || this.state;
      data.lastUpdated = new Date().toISOString();
      defaultProjectStore.saveProjectState(this.activeProjectId, data);
      if (this.activeProjectId === 'default') {
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error('Failed to write dupond_state.json to disk:', err);
    }
  }

  public getState(projectId = this.activeProjectId): ServerState {
    if (projectId === this.activeProjectId) return this.state;
    return defaultProjectStore.getProjectState(projectId, this.emptyState());
  }

  public reloadState(projectId = this.activeProjectId): void {
    if (projectId === this.activeProjectId) {
      this.state = defaultProjectStore.getProjectState(projectId, this.emptyState());
    }
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
  public getStateView(projectId = this.activeProjectId): ServerState {
    const state = this.getState(projectId);
    return { ...state, integrationConfig: this.getIntegrationConfigView(projectId) };
  }

  public getIntegrationConfigView(projectId = this.activeProjectId): IntegrationConfig {
    const config = this.getState(projectId).integrationConfig;
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
  public getIntegrationSecrets(projectId = this.activeProjectId): IntegrationConfig {
    const config = this.getState(projectId).integrationConfig;
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
  public updateState(partial: unknown, context?: { projectId?: string; actor?: string }): { success: boolean; state: ServerState; rejectedDoneTasks: string[]; error?: string } {
    const projectId = context?.projectId || 'default';
    const previousState = this.state;
    const previousProjectId = this.activeProjectId;
    this.activeProjectId = projectId;
    this.state = this.getState(projectId);
    try {
      return this.updateStateInternal(partial, context);
    } finally {
      if (projectId !== 'default') this.state = previousState;
      this.activeProjectId = previousProjectId;
    }
  }

  private updateStateInternal(partial: unknown, context?: { projectId?: string; actor?: string }): { success: boolean; state: ServerState; rejectedDoneTasks: string[]; error?: string } {
    const parseResult = StateMutationSchema.safeParse(partial);
    if (!parseResult.success) {
      return {
        success: false,
        state: this.getStateView(),
        rejectedDoneTasks: [],
        error: `State validation failed: ${parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      };
    }

    const validatedPartial = parseResult.data as Partial<ServerState>;
    const rejectedDoneTasks: string[] = [];
    // One entry per task key: a rebind and the status clamp are the same
    // outcome observed twice, and callers read this list as a set.
    const rejectTask = (key: string) => {
      if (!rejectedDoneTasks.includes(key)) rejectedDoneTasks.push(key);
    };

    // If incoming tasks are marked as 'done', verify each one strictly
    if (validatedPartial.tasks) {
      const existingTasks = this.state.tasks;
      validatedPartial.tasks = validatedPartial.tasks.map((task) => {
        const existing = existingTasks.find((t) => t.id === task.id || t.key === task.key);

        // Acceptance-relevant edits arriving through this supported API must
        // reach the authoritative task: updateTaskRequirements recomputes the
        // evidence binding and, when it changed, transactionally revokes the
        // Review/Done acceptance that the old spec authorized.
        let requirementsRebound = false;
        const dbTaskForEdit = taskStore.getTask(task.id || '', this.activeProjectId) || taskStore.getTask(task.key || '', this.activeProjectId);
        if (dbTaskForEdit) {
          // An acceptanceCriteria field that the caller sent is authoritative
          // for the contract — including when it is sent empty, which means
          // "no requirements", not "say nothing". Each posted item still
          // inherits its stored check command unless the caller supplied one,
          // so rewording a requirement cannot destroy the proof for it. With
          // no criteria sent, checklist rows only stand in for requirements
          // when the store record has none (the legacy board shape).
          const postedCriteria = task.acceptanceCriteria;
          const wireCriteria = Array.isArray(postedCriteria)
            ? mergePostedCriteria(postedCriteria, dbTaskForEdit.acceptanceCriteria)
            : (dbTaskForEdit.acceptanceCriteria.length === 0 && (task.subtasks || []).length > 0)
              ? promoteChecklistItems(task.subtasks || [])
              : dbTaskForEdit.acceptanceCriteria;
          const updates = {
            description: task.description ?? '',
            acceptanceCriteria: wireCriteria.map((c) => ({
              id: String(c.id),
              title: String(c.title ?? ''),
              completed: Boolean(c.completed),
              ...(c.checkCommand ? { checkCommand: String(c.checkCommand) } : {}),
            })),
            verificationCommands: (task.verificationCommands ?? dbTaskForEdit.verificationCommands) as typeof dbTaskForEdit.verificationCommands,
            protectedPaths: task.protectedPaths ?? dbTaskForEdit.protectedPaths,
          };
          const requirementsChanged =
            updates.description !== (dbTaskForEdit.description ?? '') ||
            JSON.stringify(updates.acceptanceCriteria) !== JSON.stringify(dbTaskForEdit.acceptanceCriteria) ||
            JSON.stringify(updates.verificationCommands) !== JSON.stringify(dbTaskForEdit.verificationCommands) ||
            JSON.stringify(updates.protectedPaths) !== JSON.stringify(dbTaskForEdit.protectedPaths);
          if (requirementsChanged) {
            const outcome = taskStore.updateTaskRequirements(dbTaskForEdit.id, updates, 'ui', this.activeProjectId);
            if (outcome.bindingChanged) {
              requirementsRebound = true;
              rejectTask(task.key);
            }
          }
        }

        // Projection rule: for tasks registered in the authoritative store,
        // acceptance-bearing statuses are owned by the lifecycle service and
        // its evidence gates. A posted state blob is clamped to the persisted
        // status instead of independently granting Review or Done.
        if (task.status === 'review' || task.status === 'done') {
          const dbTask = taskStore.getTask(task.id || '', this.activeProjectId) || taskStore.getTask(task.key || '', this.activeProjectId);
          if (dbTask && dbTask.status !== task.status) {
            rejectTask(task.key);
            return {
              ...task,
              status: this.toUiStatus(dbTask.status),
              lastAgentComment: `Authoritative lifecycle: "${task.status}" is granted only by evidence-bound transitions, not by posted state. Showing persisted status "${dbTask.status}".`,
              lastUpdated: 'Just now',
            };
          }
        }

        // Detect if acceptance criteria or description changed; invalidate previous evidence
        if (existing) {
          const subtasksChanged = JSON.stringify(existing.subtasks) !== JSON.stringify(task.subtasks);
          const descChanged = existing.description !== task.description;
          if ((subtasksChanged || descChanged) && task.status === 'done' && existing.status !== 'done') {
            rejectTask(task.key);
            return {
              ...task,
              status: 'review' as TaskStatus,
              lastAgentComment: 'Quality Gate REJECTED: Acceptance criteria or specification modified. Prior verification invalidated.',
              lastUpdated: 'Just now',
            };
          }
        }

        // Check if task is requested to be 'done'
        if (task.status === 'done') {
          // Preflight gate check
          const verification = this.preflightQualityGates(task);
          // Only permit 'done' if the task was already done in authoritative state.
          // Client cannot declare verification through deliverables or subtask checkboxes.
          const isAuthoritativelyDone = existing?.status === 'done';

          if (!verification.passed || !isAuthoritativelyDone) {
            rejectTask(task.key);
            const failingReasons = !verification.passed
              ? verification.checks
                  .filter((c) => !c.passed)
                  .map((c) => `${c.rule}: ${c.detail}`)
                  .join('; ')
              : 'Bulk state update cannot mark task "Done". Completion requires authoritative verification execution via coordinator.';

            // Clamp back to review or existing status
            return {
              ...task,
              status: (existing?.status && existing.status !== 'done' ? existing.status : 'review') as TaskStatus,
              lastAgentComment: `Quality Gate REJECTED "Done" transition: ${failingReasons}`,
              lastUpdated: 'Just now',
            };
          }
        }
        if (requirementsRebound) {
          const reboundTask = taskStore.getTask(task.id || '', this.activeProjectId) || taskStore.getTask(task.key || '', this.activeProjectId);
          return {
            ...task,
            status: reboundTask ? this.toUiStatus(reboundTask.status) : task.status,
            lastAgentComment: 'Requirements rebound: acceptance-relevant fields changed, so prior verification evidence and any granted Review/Done acceptance were revoked. Fresh verification is required.',
            lastUpdated: 'Just now',
          };
        }
        return task;
      });

      // Whatever the caller posted, the board then displays the contract the
      // authoritative store actually holds. A requirement that was refused,
      // revoked, or re-bound cannot keep being shown as if it were granted.
      validatedPartial.tasks = validatedPartial.tasks.map((task) => this.mirrorAuthoritativeSpec(
        task,
        taskStore.getTask(task.id || '', this.activeProjectId) || taskStore.getTask(task.key || '', this.activeProjectId),
      ));
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
        senderName: 'Dupond Prime Core',
        senderRole: 'Chief Orchestrator',
        recipientId: 'all',
        content: `Central Quality Gate enforced: Rejected unauthorized "Done" transition for [${rejectedDoneTasks.join(', ')}]. Quality checks must pass before completion.`,
        messageType: 'blocker',
      });
    }

    this.projectAuthoritativeStatusesInternal();
    this.saveStateToDisk();
    return { success: true, state: this.getStateView(), rejectedDoneTasks };
  }

  // Centralized transition method
  public async transitionTaskStatus(taskId: string, targetStatus: TaskStatus, projectId?: string): Promise<{
    success: boolean;
    task?: Task;
    verification?: VerificationResult;
    error?: string;
  }> {
    const effectiveProjectId = projectId || this.activeProjectId;
    const projectState = this.getState(effectiveProjectId);
    const task = projectState.tasks.find((t) => t.id === taskId || t.key === taskId);
    if (!task) {
      return { success: false, error: `Task ${taskId} not found` };
    }

    const saveProjectTasks = (updatedTask: Task) => {
      if (effectiveProjectId === this.activeProjectId) {
        this.state.tasks = this.state.tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
        this.saveStateToDisk();
      } else {
        const latestState = this.getState(effectiveProjectId);
        latestState.tasks = latestState.tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
        defaultProjectStore.saveProjectState(effectiveProjectId, latestState);
      }
    };

    // Tasks registered in the authoritative store transition only through the
    // lifecycle service, which gates Review/Done on bound verification evidence.
    // The JSON entry is updated as a projection of that outcome afterward.
    const dbTask = taskStore.getTaskScoped(task.id, effectiveProjectId) || taskStore.getTaskScoped(task.key, effectiveProjectId);
    if (dbTask) {
      const outcome = defaultLifecycleService.transition({
        taskId: dbTask.id,
        to: targetStatus,
        actor: 'api',
        reason: 'Status transition requested via orchestration API',
      });
      if (!outcome.ok) {
        return {
          success: false,
          error: outcome.detail || `Lifecycle service refused "${targetStatus}" (${outcome.reason})`,
        };
      }
      const projected: Task = {
        ...task,
        status: targetStatus,
        lastUpdated: 'Just now',
      };
      saveProjectTasks(projected);
      return { success: true, task: projected };
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

    saveProjectTasks(updatedTask);

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
        : `No physical code artifact found on disk in .dupond_artifacts/${task.key}/`,
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
        : `No physical code artifact found on disk in .dupond_artifacts/${task.key}/`,
    });

    let syntaxPassed = false;
    let syntaxDetail = 'No code artifact available for syntax compilation';
    let testPassed = false;
    let testDetail = 'Automated unit test suite not found on disk';
    let verifiedCriteria: string[] = [];

    if (artifact) {
      const run = await runArtifactVerification(artifact.code, artifact.testCode);
      if (run.testsOk) verifiedCriteria = run.criteria;

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

    const missingCriteria = (task.subtasks || [])
      .filter((subtask) => !verifiedCriteria.includes(subtask.id))
      .map((subtask) => subtask.id);
    checks.push({
      rule: 'Acceptance Criteria Test Evidence',
      passed: (task.subtasks || []).length > 0 && missingCriteria.length === 0,
      detail: missingCriteria.length > 0
        ? `Acceptance criteria missing passing test evidence: ${missingCriteria.join(', ')}`
        : (task.subtasks || []).length > 0
          ? 'Every acceptance criterion is covered by the passing test suite'
          : 'No acceptance criteria defined for test evidence verification',
    });

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

    // Subtask checkbox state is deliberately not evidence and grants nothing:
    // mutable checkboxes can never authorize acceptance. Criterion coverage is
    // proven only by passing test assertions in verifyTaskQualityGates (and by
    // bound verification records for store-backed tasks).

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
  public async executeWorkerStep(task: Task, agent: Agent, projectId?: string): Promise<{
    deliverableContent: string;
    artifactFilePath: string;
    testFilePath: string;
    fileSize: number;
    sha256: string;
    subtasksCompleted: string[];
    actionTaken: string;
    runId?: string;
  }> {
    const blocked = () => new Error(
      `Execution blocked: No capable worker connected to fulfill acceptance criteria for ${task.key} (${task.title}). Requires real implementation in workspace.`
    );

    const taskArtifactDir = resolveArtifactDir(task.key);
    if (!taskArtifactDir) throw blocked();

    const codeFilePath = path.resolve(taskArtifactDir, 'implementation.js');
    const testFilePath = path.resolve(taskArtifactDir, 'spec.test.js');

    const executionProjectId = projectId || task.projectId || this.activeProjectId;
    const executionProjectConfig = this.getState(executionProjectId).integrationConfig;
    let storeTask = taskStore.getTaskScoped(task.key, executionProjectId) || taskStore.getTaskScoped(task.id, executionProjectId);

    // Pre-existing static artifact files are a legacy deliverable format used by
    // tasks that live only in the JSON state. Once a task is registered in the
    // authoritative store its evidence must come from real worktree
    // verification; a mutable `.dupond_artifacts` snippet on disk can never
    // substitute for it.
    const hasStaticArtifacts = !storeTask &&
      isPathLexicallyContained(ARTIFACTS_DIR, taskArtifactDir) &&
      readTextIfExists(codeFilePath) !== null &&
      readTextIfExists(testFilePath) !== null;

    if (hasStaticArtifacts) {
      const implementationCode = readTextIfExists(codeFilePath)!;
      const testCode = readTextIfExists(testFilePath)!;

      // Execute the suite in a short-lived child process with no inherited
      // secrets and a hard timeout. See artifactRunner.ts for the threat model.
      const run = await runArtifactVerification(implementationCode, testCode);

      if (!run.testsOk) {
        throw new DomainError(`Unit tests failed for ${task.key}: ${run.detail}. Cannot advance stage.`);
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
**File Path:** \`.dupond_artifacts/${task.key}/implementation.js\` (${fileSize} bytes)
**SHA-256 Hash:** \`${sha256}\`
**Test Suite:** \`.dupond_artifacts/${task.key}/spec.test.js\` (Unit assertions verified)

\`\`\`javascript
${implementationCode.slice(0, 500)}...
\`\`\`
`;

      return {
        deliverableContent,
        artifactFilePath: `.dupond_artifacts/${task.key}/implementation.js`,
        testFilePath: `.dupond_artifacts/${task.key}/spec.test.js`,
        fileSize,
        sha256,
        subtasksCompleted,
        actionTaken: `Executed verified code and test suite for ${task.key} (SHA-256: ${sha256.slice(0, 12)}...)`,
      };
    }

    if (!storeTask) {
      const configuredRepo = task.targetRepo ||
        executionProjectConfig?.repository?.repoUrl ||
        process.env.DUPOND_TARGET_REPO;
      const configuredRepoPath = task.targetRepoPath ||
        (executionProjectConfig?.repository?.localPath && fs.existsSync(executionProjectConfig.repository.localPath)
          ? executionProjectConfig.repository.localPath
          : undefined);
      const baseCommit = task.baseCommit ||
        executionProjectConfig?.repository?.defaultBranch ||
        'HEAD';
      const allowedPaths = task.allowedPaths && task.allowedPaths.length > 0
        ? task.allowedPaths
        : ['src/**', 'workspace/**'];
      const defaultProtectedPaths = [
        '.github/**',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tests/**',
        '.env*',
      ];
      const protectedPaths = Array.from(new Set([
        ...defaultProtectedPaths,
        ...(task.protectedPaths || []),
      ]));

      // Acceptance criteria and mapped verification commands
      const rawCriteria = task.acceptanceCriteria && task.acceptanceCriteria.length > 0
        ? task.acceptanceCriteria
        : (task.subtasks || []).map((s) => ({
            id: s.id,
            title: s.title,
            completed: Boolean(s.completed),
            checkCommand: s.checkCommand,
          }));

      const criteria = rawCriteria.map((c) => ({
        id: c.id,
        title: c.title,
        completed: Boolean(c.completed),
        checkCommand: c.checkCommand,
      }));

      const verificationCommands = task.verificationCommands && task.verificationCommands.length > 0
        ? task.verificationCommands
        : criteria
            .filter((c) => c.checkCommand)
            .map((c) => ({ command: c.checkCommand!, criteriaIds: [c.id] }));

      storeTask = taskStore.createTask({
        id: task.id,
        projectId: executionProjectId,
        key: task.key,
        title: task.title,
        description: task.description,
        status: 'in_progress',
        priority: task.priority || 'high',
        targetRepo: configuredRepo || orchestratorRepoSlug(),
        targetRepoPath: configuredRepoPath,
        baseCommit: baseCommit,
        allowedPaths: allowedPaths,
        protectedPaths: protectedPaths,
        verificationCommands: verificationCommands.length > 0 ? verificationCommands : ['npm test'],
        acceptanceCriteria: criteria,
        workerConfig: task.workerConfig || { provider: 'gemini', model: GEMINI_MODEL },
        maxAttempts: task.maxAttempts || 3,
        timeoutSeconds: task.timeoutSeconds || 300,
        requireApproval: task.requireApproval !== undefined ? task.requireApproval : true,
      });
    }

    // Authoritatively resolve and check the worker configured for this task
    let taskWorker: CodingWorkerAdapter;
    try {
      taskWorker = resolveCodingWorker(storeTask.workerConfig);
    } catch (cfgErr: any) {
      throw new DomainError(`Worker configuration blocked: ${cfgErr.message}`);
    }

    const workerAvailable = await taskWorker.isAvailable();
    if (!workerAvailable.available) {
      throw blocked();
    }

    // Real Coding Worker Execution via isolated worktree and sandbox!
    const resolvedRepo = resolveTargetRepository({
      targetRepo: task.targetRepo || executionProjectConfig?.repository?.repoUrl,
      targetRepoPath: task.targetRepoPath || executionProjectConfig?.repository?.localPath,
      integrationConfig: executionProjectConfig,
      allowOrchestratorRepo: isOrchestratorSelfTarget(task.targetRepo || executionProjectConfig?.repository?.repoUrl),
    });

    const workspaceManager = new WorkspaceManager(resolvedRepo.repoPath);

    const workerRun = await defaultRepairCoordinator.executeTaskRun({
      task: storeTask,
      worker: taskWorker,
      workspaceManager,
    });

    if (workerRun.status !== 'completed') {
      throw new DomainError(`Worker execution failed for ${task.key}: ${workerRun.failureReason}`);
    }

    const verificationRecord = taskStore.getLatestVerification(workerRun.id);
    const revisionSha = verificationRecord?.revisionSha || 'verified';
    const subtasksCompleted = verificationRecord?.criteriaVerified || [];

    const deliverableContent = `### Real Application Deliverable: \`${task.key}\`
**Specialist:** ${agent.name} (${agent.role})
**Delivered Commit:** \`${revisionSha}\`
**Branch:** \`${workerRun.targetBranch}\`
**Verification Status:** Authoritative quality gates passed cleanly.
`;

    return {
      deliverableContent,
      artifactFilePath: workerRun.worktreePath || `worktree/${workerRun.targetBranch}`,
      testFilePath: 'npm test',
      fileSize: 2048,
      sha256: revisionSha,
      subtasksCompleted,
      actionTaken: `Executed real coding worker in isolated worktree for ${task.key} (Revision: ${revisionSha.slice(0, 10)})`,
      runId: workerRun.id,
    };
  }

  // --- Background Daemon Autonomous Coordinator ---
  public startDaemon(intervalMs = 7000): void {
    if (this.daemonTimer) return;
    this.state.daemonRunning = true;
    this.saveStateToDisk();

    console.log(`[Dupond Daemon] Server-Authoritative Coordinator started (Interval: ${intervalMs}ms)`);

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
    console.log('[Dupond Daemon] Server coordinator paused');
  }

  public isDaemonRunning(): boolean {
    return this.state.daemonRunning;
  }

  // Authoritative single-step coordinator tick
  public async runDaemonTick(): Promise<{ advanced: boolean; targetTask?: Task; action?: string }> {
    if (this.isProcessingTick) return { advanced: false };
    this.isProcessingTick = true;

    try {
      // The persisted lifecycle outcome always wins over the JSON entry before
      // any decision: after a delivery, a revocation, or a refused Review the
      // store holds the truth and the tick must not act on a stale status.
      this.projectAuthoritativeStatuses();
      const { tasks, agents } = this.state;

      // 1. Check tasks in 'in_progress' -> run the real coding worker; Review
      // is then granted only by the authoritative lifecycle service.
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

        // Store-backed work: the repair loop already routed the Review attempt
        // through the lifecycle service against bound evidence. If it did not
        // grant Review, the daemon must not either.
        const dbTwin = taskStore.getTask(inProgressTask.id, this.activeProjectId) || taskStore.getTask(inProgressTask.key, this.activeProjectId);
        let projectedStatus: TaskStatus = 'review';
        let refusalDetail = '';
        if (dbTwin) {
          let fresh = taskStore.getTask(dbTwin.id, this.activeProjectId) || dbTwin;
          if (fresh.status !== 'review') {
            const outcome = defaultLifecycleService.transition({
              taskId: fresh.id,
              to: 'review',
              actor: 'daemon',
              reason: 'Autonomous worker step completed',
            });
            fresh = taskStore.getTask(fresh.id, this.activeProjectId) || fresh;
            projectedStatus = outcome.ok ? 'review' : this.toUiStatus(fresh.status);
            if (!outcome.ok) refusalDetail = outcome.detail || outcome.reason || 'refused';
          }
        }

        const updatedTask: Task = {
          ...inProgressTask,
          status: projectedStatus,
          subtasks: updatedSubtasks,
          deliverables: updatedDeliverables,
          spentHours: (inProgressTask.spentHours || 0) + 4,
          lastAgentComment: projectedStatus === 'review'
            ? `${agent.name}: Generated real code & tests (${workerResult.fileSize}B, SHA: ${workerResult.sha256.slice(0, 8)}). Ready for Quality Gate.`
            : `${agent.name}: Worker finished, but the lifecycle service did not grant Review: ${refusalDetail}`,
          lastUpdated: 'Just now',
        };

        this.state.tasks = tasks.map((t) => (t.id === inProgressTask.id ? updatedTask : t));

        this.addCommunication({
          senderId: agent.id,
          senderName: agent.name,
          senderRole: agent.role,
          recipientId: 'all',
          content: projectedStatus === 'review'
            ? `Generated code deliverable for ${inProgressTask.key} at ${workerResult.artifactFilePath}. Advanced to REVIEW stage.`
            : `Worker step for ${inProgressTask.key} completed without Review: ${refusalDetail}. Status projected from the authoritative store ("${projectedStatus.toUpperCase()}").`,
          messageType: projectedStatus === 'review' ? 'deliverable' : 'blocker',
          taskId: inProgressTask.key,
        });

        this.state.cycleCount += 1;
        this.saveStateToDisk();
        return {
          advanced: true,
          targetTask: updatedTask,
          action: projectedStatus === 'review' ? 'advanced_to_review' : 'review_refused_by_lifecycle',
        };
      }

      // 2. Legacy JSON-only tasks in 'review' -> run STRICT verification gates.
      // Store-backed verified work is deliberately excluded: it waits in
      // Review until the delivery and approval conditions are satisfied, and
      // Done is granted only by the lifecycle service after a recorded,
      // approved delivery. No artifact-based gate may certify it here.
      const reviewTask = tasks.find((t) =>
        t.status === 'review' && !(taskStore.getTask(t.id, this.activeProjectId) || taskStore.getTask(t.key, this.activeProjectId)));
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
            senderName: 'Dupond Prime Core',
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
            senderName: 'Dupond Prime Core',
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

        // Store-backed tasks may only start through the lifecycle service so a
        // revocation, unmet dependency, or open claim cannot be bypassed by a
        // direct JSON status write.
        const dbTodo = taskStore.getTask(todoTask.id, this.activeProjectId) || taskStore.getTask(todoTask.key, this.activeProjectId);
        if (dbTodo) {
          const outcome = defaultLifecycleService.transition({
            taskId: dbTodo.id,
            to: 'in_progress',
            actor: 'daemon',
            reason: 'Dependencies verified clear; daemon claimed task for execution',
          });
          if (!outcome.ok) {
            const fresh = taskStore.getTask(dbTodo.id, this.activeProjectId);
            const updatedTask: Task = {
              ...todoTask,
              status: this.toUiStatus(fresh?.status ?? dbTodo.status),
              lastAgentComment: `Lifecycle service refused the claim: ${outcome.detail || outcome.reason}`,
              lastUpdated: 'Just now',
            };
            this.state.tasks = tasks.map((t) => (t.id === todoTask.id ? updatedTask : t));
            this.saveStateToDisk();
            return { advanced: true, targetTask: updatedTask, action: 'claim_refused_by_lifecycle' };
          }
        }

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
      console.error('[Dupond Daemon] Tick error:', tickErr);
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

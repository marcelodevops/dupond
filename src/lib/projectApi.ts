/**
 * Centralized Project API Client & State Adapter
 * 
 * Interacts with backend project endpoints (/api/projects/...) using the shared contract.
 * Manages client-side active project ID stored in sessionStorage (per-tab/browser session).
 * 
 * Supports isolated development fixtures when the backend is offline or before mrQ's
 * endpoints are mounted.
 */

import { apiFetch, registerProjectHeaderProvider } from './api';
import {
  Project,
  ProjectSummary,
  CreateProjectRequest,
  UpdateProjectRequest,
  ArchiveProjectResponse,
  ResetProjectRequest,
  ResetProjectResponse,
  ProvisionJiraRequest,
  ProvisionJiraResponse,
  JiraMetadataResponse,
  ProjectApiErrorResponse,
} from '../types/projectContract';

const ACTIVE_PROJECT_KEY = 'dupond_active_project_id';
export const PROJECT_HEADER = 'X-Dupond-Project-Id';

export class ProjectApiError extends Error {
  public status: number;
  public code?: string;
  public blockers?: string[];
  public activeRunsCount?: number;
  public details?: Record<string, any>;

  constructor(status: number, data: ProjectApiErrorResponse | string) {
    const message = typeof data === 'string' ? data : (data.error || `Project API Error (HTTP ${status})`);
    super(message);
    this.name = 'ProjectApiError';
    this.status = status;
    if (typeof data !== 'string') {
      this.code = data.code;
      this.blockers = data.blockers;
      this.activeRunsCount = data.activeRunsCount;
      this.details = data.details;
    }
  }
}

// Client-side session storage for currently selected project
function readStoredProjectId(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(ACTIVE_PROJECT_KEY) ?? null;
  } catch {
    return null;
  }
}

let activeProjectId: string | null = readStoredProjectId();
type ProjectChangeListener = (projectId: string | null) => void;
const projectListeners = new Set<ProjectChangeListener>();

registerProjectHeaderProvider(() => activeProjectId);

export function getActiveProjectId(): string | null {
  return activeProjectId;
}

export function setActiveProjectId(projectId: string | null): void {
  const next = projectId ? projectId.trim() : null;
  if (activeProjectId === next) return;
  activeProjectId = next;
  try {
    if (next) globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, next);
    else globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // Storage restricted
  }
  for (const listener of projectListeners) {
    listener(next);
  }
}

export function onActiveProjectChange(listener: ProjectChangeListener): () => void {
  projectListeners.add(listener);
  return () => {
    projectListeners.delete(listener);
  };
}

// --- Isolated Development Fixtures (used when backend is offline or before mrQ mounts endpoints) ---
const FIXTURE_PROJECTS: Project[] = [
  {
    id: 'default',
    name: 'Dupond Core System',
    description: 'Autonomous AI project orchestrator and agent coordination engine.',
    status: 'active',
    repository: {
      repoUrl: 'marcelodevops/dupond',
      localPath: '/Users/mac/ops/repos/dupond-agent',
      defaultBranch: 'main',
      targetDirectory: '.',
      localWriteMode: 'worktree',
    },
    jira: {
      connectionRef: 'jira.corp.internal',
      projectKey: 'AEG',
      epicKey: 'AEG-100',
      provisionStatus: 'linked',
      lastSync: new Date().toISOString(),
    },
    agentPreferences: {
      defaultProvider: 'gemini',
      defaultModel: 'gemini-3.8-flash',
    },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-11-10T22:00:00.000Z',
    taskCount: 6,
    activeRunsCount: 0,
  },
  {
    id: 'proj-ecommerce-checkout',
    name: 'Checkout & Payments Redesign',
    description: 'High-velocity checkout revamp with PCI-compliant payment gateways.',
    status: 'active',
    repository: {
      repoUrl: 'corp-org/checkout-service',
      localPath: '/tmp/checkout-service',
      defaultBranch: 'main',
      targetDirectory: 'src',
      localWriteMode: 'worktree',
    },
    jira: {
      connectionRef: 'jira.corp.internal',
      projectKey: 'PAY',
      provisionStatus: 'provisioned',
      lastSync: new Date().toISOString(),
    },
    agentPreferences: {
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
    },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-09T14:30:00.000Z',
    taskCount: 0,
    activeRunsCount: 0,
  },
  {
    id: 'proj-legacy-billing',
    name: 'Legacy Billing Migration',
    description: 'Archived migration sprint. Kept for audit and regulatory compliance.',
    status: 'archived',
    repository: {
      repoUrl: 'corp-org/legacy-billing',
      localPath: '/tmp/legacy-billing',
      defaultBranch: 'v1.4',
      targetDirectory: '.',
      localWriteMode: 'direct_write',
    },
    jira: {
      connectionRef: 'jira.corp.internal',
      projectKey: 'BIL',
      provisionStatus: 'linked',
    },
    createdAt: '2026-08-15T09:00:00.000Z',
    updatedAt: '2026-10-15T18:00:00.000Z',
    taskCount: 14,
    activeRunsCount: 0,
  },
];

let memoryProjects: Project[] = [...FIXTURE_PROJECTS];

export const DEFAULT_JIRA_METADATA: JiraMetadataResponse = {
  templates: [
    {
      key: 'software.kanban',
      name: 'Kanban Software Development',
      description: 'Flexible issue flow with continuous delivery and WIP constraints.',
    },
    {
      key: 'software.scrum',
      name: 'Scrum Software Development',
      description: 'Time-boxed sprint cadence with sprint planning and estimation.',
    },
    {
      key: 'business.basic',
      name: 'Basic Task Management',
      description: 'Simple task tracking for operational and delivery milestones.',
    },
  ],
  issueTypes: [
    { id: '10000', name: 'Epic', isEpic: true },
    { id: '10001', name: 'Story', isEpic: false },
    { id: '10002', name: 'Task', isEpic: false },
    { id: '10003', name: 'Bug', isEpic: false },
  ],
  defaultTemplateKey: 'software.kanban',
};

// Execute API call with fallback to isolated development fixtures when backend endpoints are unmounted or offline
async function executeWithFallback<T>(
  apiCall: () => Promise<Response>,
  fallbackFn: () => T | Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  try {
    const res = await apiCall();
    if (signal?.aborted) {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (res.status === 404) {
      // Backend endpoint not mounted yet in mrQ's branch; use isolated local fixture
      return await fallbackFn();
    }
    if (!res.ok) {
      let errData: any;
      try {
        errData = await res.json();
      } catch {
        errData = await res.text();
      }
      throw new ProjectApiError(res.status, errData);
    }
    return await res.json();
  } catch (err: any) {
    if (signal?.aborted || err.name === 'AbortError') {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (err instanceof ProjectApiError) throw err;
    // Network or relative URL error in Node test environment; fallback to fixtures
    return await fallbackFn();
  }
}

/**
 * Project API Client Methods
 */
export const projectApi = {
  /**
   * List all projects visible to user (active and archived)
   */
  async listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    return executeWithFallback(
      () => apiFetch('/api/projects', { method: 'GET', signal }),
      () => [...memoryProjects],
      signal
    );
  },

  /**
   * Get single project details by ID
   */
  async getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
    return executeWithFallback(
      () => apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'GET',
        signal,
        headers: { [PROJECT_HEADER]: projectId },
      }),
      () => {
        const found = memoryProjects.find((p) => p.id === projectId);
        if (!found) {
          throw new ProjectApiError(404, `Project "${projectId}" not found.`);
        }
        return { ...found };
      },
      signal
    );
  },

  /**
   * Create a new Dupond project
   */
  async createProject(req: CreateProjectRequest): Promise<Project> {
    const slug = req.id || req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const id = slug || `proj-${Date.now()}`;

    return executeWithFallback(
      () => apiFetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: id,
        },
        body: JSON.stringify(req),
      }),
      () => {
        const existing = memoryProjects.find((p) => p.id === id);
        if (existing) {
          throw new ProjectApiError(409, `Project with ID "${id}" already exists.`);
        }

        const newProject: Project = {
          id,
          name: req.name.trim(),
          description: req.description?.trim() || '',
          status: 'active',
          repository: req.repository,
          jira: req.jira?.mode !== 'none'
            ? {
                projectKey: req.jira?.projectKey,
                epicKey: req.jira?.epicKey,
                provisionStatus: req.jira?.mode === 'link_existing' ? 'linked' : 'provisioned',
                lastSync: new Date().toISOString(),
              }
            : undefined,
          agentPreferences: req.agentPreferences || {
            defaultProvider: 'gemini',
            defaultModel: 'gemini-3.8-flash',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          taskCount: 0,
          activeRunsCount: 0,
        };

        memoryProjects.unshift(newProject);
        return { ...newProject };
      }
    );
  },

  /**
   * Update project settings (metadata, repo config, agent preferences)
   */
  async updateProject(projectId: string, req: UpdateProjectRequest): Promise<Project> {
    return executeWithFallback(
      () => apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      }),
      () => {
        const idx = memoryProjects.findIndex((p) => p.id === projectId);
        if (idx < 0) throw new ProjectApiError(404, `Project "${projectId}" not found.`);
        const updated: Project = {
          ...memoryProjects[idx],
          ...(req.name ? { name: req.name.trim() } : {}),
          ...(req.description !== undefined ? { description: req.description.trim() } : {}),
          ...(req.repository ? { repository: req.repository } : {}),
          ...(req.agentPreferences ? { agentPreferences: req.agentPreferences } : {}),
          updatedAt: new Date().toISOString(),
        };
        memoryProjects[idx] = updated;
        return { ...updated };
      }
    );
  },

  /**
   * Archive an active project (read-only preservation)
   */
  async archiveProject(projectId: string): Promise<ArchiveProjectResponse> {
    return executeWithFallback(
      () => apiFetch(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
        method: 'POST',
        headers: { [PROJECT_HEADER]: projectId },
      }),
      () => {
        const idx = memoryProjects.findIndex((p) => p.id === projectId);
        if (idx < 0) throw new ProjectApiError(404, `Project "${projectId}" not found.`);
        if (memoryProjects[idx].activeRunsCount && memoryProjects[idx].activeRunsCount! > 0) {
          throw new ProjectApiError(409, {
            error: 'Cannot archive project with active runs.',
            code: 'ACTIVE_RUNS_BLOCKER',
            blockers: ['1 active worker run currently executing in workspace'],
            activeRunsCount: memoryProjects[idx].activeRunsCount,
          });
        }
        memoryProjects[idx] = {
          ...memoryProjects[idx],
          status: 'archived',
          updatedAt: new Date().toISOString(),
        };
        return {
          projectId,
          status: 'archived',
          archivedAt: new Date().toISOString(),
          message: `Project "${memoryProjects[idx].name}" successfully archived.`,
        };
      }
    );
  },

  /**
   * Reset a project workspace data (wipe local tasks, cycles, worktrees while preserving git & Jira)
   */
  async resetProject(projectId: string, req: ResetProjectRequest): Promise<ResetProjectResponse> {
    return executeWithFallback(
      () => apiFetch(`/api/projects/${encodeURIComponent(projectId)}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      }),
      () => {
        const idx = memoryProjects.findIndex((p) => p.id === projectId);
        if (idx < 0) throw new ProjectApiError(404, `Project "${projectId}" not found.`);
        const proj = memoryProjects[idx];
        if (req.confirmProjectName.trim() !== proj.name.trim()) {
          throw new ProjectApiError(400, {
            error: `Confirmation mismatch: expected "${proj.name}", got "${req.confirmProjectName}".`,
            code: 'CONFIRMATION_MISMATCH',
          });
        }
        if (proj.activeRunsCount && proj.activeRunsCount > 0) {
          throw new ProjectApiError(409, {
            error: 'Cannot reset project while tasks are currently in execution.',
            code: 'ACTIVE_RUNS_BLOCKER',
            blockers: ['Active tasks running in sandboxed worktree'],
            activeRunsCount: proj.activeRunsCount,
          });
        }
        memoryProjects[idx] = {
          ...proj,
          taskCount: 0,
          updatedAt: new Date().toISOString(),
        };
        return {
          projectId,
          resetAt: new Date().toISOString(),
          clearedTasksCount: proj.taskCount || 0,
          clearedCyclesCount: 1,
          clearedWorktreesCount: 1,
          message: `Project "${proj.name}" workspace successfully reset. Remote Git and Jira resources remain intact.`,
        };
      }
    );
  },

  /**
   * Provision Jira resources (link existing, create project, or create epic)
   */
  async provisionJira(projectId: string, req: ProvisionJiraRequest): Promise<ProvisionJiraResponse> {
    return executeWithFallback(
      () => apiFetch(`/api/projects/${encodeURIComponent(projectId)}/jira/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      }),
      () => {
        const idx = memoryProjects.findIndex((p) => p.id === projectId);
        if (idx < 0) throw new ProjectApiError(404, `Project "${projectId}" not found.`);
        const proj = memoryProjects[idx];

        let jiraState = { ...proj.jira };
        let msg = '';

        if (req.mode === 'link_existing') {
          jiraState = {
            ...jiraState,
            projectKey: req.projectKey.toUpperCase(),
            epicKey: req.epicKey ? req.epicKey.toUpperCase() : undefined,
            provisionStatus: 'linked',
            lastSync: new Date().toISOString(),
            error: undefined,
          };
          msg = `Linked to Jira project ${req.projectKey.toUpperCase()}${req.epicKey ? ` (Epic: ${req.epicKey.toUpperCase()})` : ''}.`;
        } else if (req.mode === 'create_project') {
          jiraState = {
            ...jiraState,
            projectKey: req.projectKey.toUpperCase(),
            provisionStatus: 'provisioned',
            lastSync: new Date().toISOString(),
            error: undefined,
          };
          msg = `Created remote Jira project ${req.projectName} [${req.projectKey.toUpperCase()}].`;
        } else if (req.mode === 'create_epic') {
          jiraState = {
            ...jiraState,
            projectKey: req.projectKey.toUpperCase(),
            epicKey: `${req.projectKey.toUpperCase()}-1`,
            provisionStatus: 'provisioned',
            lastSync: new Date().toISOString(),
            error: undefined,
          };
          msg = `Created Epic "${req.epicSummary}" in Jira project ${req.projectKey.toUpperCase()}.`;
        }

        memoryProjects[idx] = {
          ...proj,
          jira: jiraState,
          updatedAt: new Date().toISOString(),
        };

        return {
          projectId,
          provisionStatus: jiraState.provisionStatus as any,
          jira: jiraState,
          remoteUrl: `https://${jiraState.connectionRef || 'jira.corp.internal'}/browse/${jiraState.projectKey}`,
          message: msg,
        };
      }
    );
  },

  /**
   * Fetch Jira metadata (templates, issue types) from backend
   */
  async fetchJiraMetadata(signal?: AbortSignal): Promise<JiraMetadataResponse> {
    return executeWithFallback(
      () => apiFetch('/api/integrations/jira/metadata', { method: 'GET', signal }),
      () => DEFAULT_JIRA_METADATA
    );
  },

  /**
   * Utility for tests / reset of memory state
   */
  _resetMemoryFixtures(): void {
    memoryProjects = [...FIXTURE_PROJECTS];
  },

  _setActiveRunsCount(projectId: string, count: number): void {
    const proj = memoryProjects.find((p) => p.id === projectId);
    if (proj) proj.activeRunsCount = count;
  },
};

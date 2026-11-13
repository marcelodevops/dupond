/**
 * Centralized Project API Client
 * 
 * Interacts with backend project endpoints (/api/projects/...) using the shared contract.
 * Manages client-side active project ID stored in sessionStorage (per-tab/browser session).
 * 
 * Strict Production API Policy:
 * All operations execute real HTTP requests against the backend.
 * Unmounted routes (404), network errors, server failures (500), and blocker rejections (409)
 * produce honest, actionable ProjectApiError instances. Never fabricates fake local success.
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
  PlanningReadiness,
  ProjectSourcePlan,
  ParsePlanRequest,
  AdoptPlanRequest,
  AdoptPlanResponse,
  RepositoryVerificationResult,
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

/**
 * Executes a real HTTP request against the Dupond backend.
 * Fails loudly on network errors, HTTP 404, HTTP 500, or invalid responses.
 */
async function callProjectApi<T>(
  endpoint: string,
  options: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const effectiveSignal = signal || options.signal;
  if (effectiveSignal?.aborted) {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  let res: Response;
  try {
    res = await apiFetch(endpoint, {
      ...options,
      signal: effectiveSignal,
    });
  } catch (err: any) {
    if (effectiveSignal?.aborted || err.name === 'AbortError') {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw new ProjectApiError(0, {
      error: `Network error connecting to Dupond API: ${err.message || String(err)}`,
      code: 'NETWORK_ERROR',
      details: { endpoint },
    });
  }

  if (effectiveSignal?.aborted) {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  if (res.status === 404) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {}
    throw new ProjectApiError(404, {
      error: `Project endpoint not found on server (HTTP 404): ${endpoint}. Backend multi-project routes are not mounted or not implemented yet.`,
      code: 'ROUTE_NOT_FOUND',
      details: { endpoint, response: bodyText },
    });
  }

  if (!res.ok) {
    let errData: any;
    try {
      errData = await res.json();
    } catch {
      try {
        errData = await res.text();
      } catch {
        errData = `HTTP ${res.status}`;
      }
    }
    throw new ProjectApiError(res.status, errData);
  }

  try {
    return (await res.json()) as T;
  } catch (parseErr: any) {
    throw new ProjectApiError(res.status, {
      error: `Malformed JSON response from ${endpoint}: ${parseErr.message}`,
      code: 'MALFORMED_RESPONSE',
    });
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
    return callProjectApi<ProjectSummary[]>('/api/projects', { method: 'GET' }, signal);
  },

  /**
   * Get single project details by ID
   */
  async getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
    return callProjectApi<Project>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'GET',
        headers: { [PROJECT_HEADER]: projectId },
      },
      signal
    );
  },

  /**
   * Create a new Dupond project
   */
  async createProject(req: CreateProjectRequest, signal?: AbortSignal): Promise<Project> {
    const projectHeaderValue = req.id || req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return callProjectApi<Project>(
      '/api/projects',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(projectHeaderValue ? { [PROJECT_HEADER]: projectHeaderValue } : {}),
        },
        body: JSON.stringify(req),
      },
      signal
    );
  },

  /**
   * Update project settings (metadata, repo config, agent preferences)
   */
  async updateProject(projectId: string, req: UpdateProjectRequest, signal?: AbortSignal): Promise<Project> {
    return callProjectApi<Project>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      },
      signal
    );
  },

  /**
   * Archive an active project (read-only preservation)
   */
  async archiveProject(projectId: string, signal?: AbortSignal): Promise<ArchiveProjectResponse> {
    return callProjectApi<ArchiveProjectResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/archive`,
      {
        method: 'POST',
        headers: { [PROJECT_HEADER]: projectId },
      },
      signal
    );
  },

  /**
   * Reset a project workspace data (wipe local tasks, cycles, worktrees while preserving git & Jira)
   */
  async resetProject(projectId: string, req: ResetProjectRequest, signal?: AbortSignal): Promise<ResetProjectResponse> {
    return callProjectApi<ResetProjectResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/reset`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      },
      signal
    );
  },

  /**
   * Provision Jira resources (link existing, create project, or create epic)
   */
  async provisionJira(projectId: string, req: ProvisionJiraRequest, signal?: AbortSignal): Promise<ProvisionJiraResponse> {
    return callProjectApi<ProvisionJiraResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/jira/provision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      },
      signal
    );
  },

  /**
   * Fetch Jira metadata (templates, issue types) from backend
   */
  async fetchJiraMetadata(signal?: AbortSignal): Promise<JiraMetadataResponse> {
    return callProjectApi<JiraMetadataResponse>(
      '/api/integrations/jira/metadata',
      { method: 'GET' },
      signal
    );
  },

  /**
   * Get planning engine readiness and effective model
   */
  async getPlanningReadiness(signal?: AbortSignal): Promise<PlanningReadiness> {
    return callProjectApi<PlanningReadiness>(
      '/api/planning/readiness',
      { method: 'GET' },
      signal
    );
  },

  /**
   * Get project source plan and revision history
   */
  async getProjectPlan(projectId: string, signal?: AbortSignal): Promise<{ latest: ProjectSourcePlan | null; history: ProjectSourcePlan[] }> {
    return callProjectApi<{ latest: ProjectSourcePlan | null; history: ProjectSourcePlan[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/plan`,
      {
        method: 'GET',
        headers: { [PROJECT_HEADER]: projectId },
      },
      signal
    );
  },

  /**
   * Parse and decompose a plan for a specific project
   */
  async parseProjectPlan(
    projectId: string,
    req: ParsePlanRequest,
    signal?: AbortSignal
  ): Promise<any> {
    return callProjectApi<any>(
      `/api/projects/${encodeURIComponent(projectId)}/plan/parse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      },
      signal
    );
  },

  /**
   * Atomically adopt planned epics and tasks into the project workspace
   */
  async adoptPlan(
    projectId: string,
    req: AdoptPlanRequest,
    signal?: AbortSignal
  ): Promise<AdoptPlanResponse> {
    return callProjectApi<AdoptPlanResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/plan/adopt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify(req),
      },
      signal
    );
  },

  /**
   * Verify local repository path, git structure, branch, and permissions
   */
  async verifyRepository(
    projectId: string,
    repository?: ProjectRepositoryConfig,
    signal?: AbortSignal
  ): Promise<RepositoryVerificationResult> {
    return callProjectApi<RepositoryVerificationResult>(
      `/api/projects/${encodeURIComponent(projectId)}/repository/verify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PROJECT_HEADER]: projectId,
        },
        body: JSON.stringify({ repository }),
      },
      signal
    );
  },
};

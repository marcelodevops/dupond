/**
 * Dupond Project API & Persistence Contract
 * 
 * Shared contract between backend (mrQ) and frontend (AGY).
 * Defines exact request/response shapes, project models, lifecycle states,
 * and Jira provisioning variants.
 * 
 * SECURITY INVARIANT: Never include credentials (tokens, secrets, private keys)
 * in project records or API responses.
 */

import { RepositoryConfig } from './index';

export type { RepositoryConfig };

export interface ProjectRepositoryConfig {
  repoUrl?: string;
  localPath?: string;
  defaultBranch?: string;
  defaultBaseBranch?: string;
  slug?: string;
  path?: string;
  targetDirectory?: string;
  localWriteMode?: 'worktree' | 'direct_write' | 'git_branch' | 'patch_export';
  branchPrefix?: string;
  deliveryMode?: 'pull_request' | 'branch_push' | 'local_artifacts';
}

export type ProjectStatus = 'active' | 'archived';

export type JiraProvisionStatus = 'unlinked' | 'linked' | 'provisioned' | 'failed';

export interface ProjectJiraState {
  connectionRef?: string;       // Public/opaque host connection reference, e.g. "jira.corp.internal"
  connectionId?: string | null;
  hostUrl?: string | null;
  projectKey?: string;          // Jira Project Key (e.g. "AEG", "DUP")
  epicKey?: string;             // Optional Epic Issue Key (e.g. "AEG-100")
  provisionStatus?: JiraProvisionStatus;
  provisioningState?: JiraProvisionStatus | 'unconfigured';
  lastSync?: string;            // ISO timestamp
  error?: string;               // Last sync/provision error message
}

export interface ProjectAgentPreferences {
  defaultProvider?: 'gemini' | 'openai' | 'custom';
  defaultModel?: string;
}

export type ProjectPreferences = ProjectAgentPreferences & {
  requireApprovalByDefault?: boolean;
};

export type ProjectResetScope = 'tasks' | 'cycles' | 'runs' | 'evidence' | 'deliveries' | 'worktrees' | 'artifacts';

export interface ProjectResetResult {
  projectId: string;
  cleared: Record<ProjectResetScope, number>;
  auditEventId: string;
  skipped: Array<{ scope: ProjectResetScope; reason: string }>;
}

export const PROJECT_CONTEXT_HEADER = 'x-dupond-project-id';
export const DEFAULT_PROJECT_ID = 'default';

export interface ProjectCapabilities {
  jira: {
    linkExisting: boolean;
    createProject: boolean;
    createEpic: boolean;
    reason?: string;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  repository?: ProjectRepositoryConfig;
  jira?: ProjectJiraState;
  createdAt: string;
  updatedAt: string;
  taskCount?: number;
  activeRunsCount?: number;
  capabilities?: ProjectCapabilities;
}

export interface Project extends ProjectSummary {
  agentPreferences?: ProjectAgentPreferences;
  preferences?: ProjectPreferences;
  archivedAt?: string | null;
}

export type PlanSourceStatus = 'submitted' | 'parsed' | 'parse_failed' | 'adopted';

export interface ProjectSourcePlan {
  id: string;
  projectId: string;
  revision: number;
  sourceText: string;
  summary?: string;
  status: PlanSourceStatus;
  errorMessage?: string;
  breakdownJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParsePlanRequest {
  planText: string;
  currentAgents?: Array<{ name: string; role: string; skills?: string[] }>;
}

export interface AdoptPlanRequest {
  sourcePlanId?: string;
  planRevision?: number;
  summary: string;
  epics: Array<{
    id: string;
    title: string;
    description?: string;
    color?: string;
  }>;
  tasks: Array<{
    id: string;
    key: string;
    title: string;
    description: string;
    epicId: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    estimatedHours?: number;
    recommendedRole?: string;
    dependencies?: string[];
    tags?: string[];
    subtasks?: Array<{ id: string; title: string; completed?: boolean; checkCommand?: string }>;
  }>;
}

export interface AdoptPlanResponse {
  success: boolean;
  adoptedCount: number;
  sourcePlanRevision?: number;
  tasks: any[];
  epics: any[];
}

export interface PlanningReadiness {
  provider: string;
  model: string;
  ready: boolean;
  error?: string;
}

export interface RepositoryVerificationResult {
  valid: boolean;
  localPathExists: boolean;
  isGitRepo: boolean;
  branchExists: boolean;
  writable: boolean;
  headCommit?: string;
  resolvedBranch?: string;
  error?: string;
  details: string[];
}

/**
 * Request payload for POST /api/projects
 */
export interface CreateProjectRequest {
  id?: string;                  // Optional custom slug; auto-generated if omitted
  name: string;                 // Required project display name
  description?: string;
  repository?: ProjectRepositoryConfig;
  jira?: {
    mode: 'none' | 'link_existing' | 'create_project' | 'create_epic';
    connectionRef?: string;
    projectKey?: string;
    projectName?: string;
    epicKey?: string;
    epicSummary?: string;
    templateKey?: string;
    confirmRemoteCreation?: boolean;
    operationId?: string;
  };
  agentPreferences?: ProjectAgentPreferences;
}

/**
 * Request payload for PATCH /api/projects/:projectId
 */
export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  repository?: ProjectRepositoryConfig;
  agentPreferences?: ProjectAgentPreferences;
}

/**
 * Response payload for POST /api/projects/:projectId/archive
 */
export interface ArchiveProjectResponse {
  projectId: string;
  status: 'archived';
  archivedAt: string;
  message?: string;
}

/**
 * Request payload for POST /api/projects/:projectId/reset
 */
export interface ResetProjectRequest {
  confirmProjectName: string;   // User must re-type the exact project name
  scope: {
    wipeTasks: boolean;
    wipeCycles: boolean;
    wipeWorktrees: boolean;
    preserveRemoteGit: true;    // Invariant: remote git & Jira are always preserved
    preserveRemoteJira: true;
  };
}

/**
 * Response payload for POST /api/projects/:projectId/reset
 */
export interface ResetProjectResponse {
  projectId: string;
  resetAt: string;
  clearedTasksCount: number;
  clearedCyclesCount: number;
  clearedWorktreesCount: number;
  message: string;
}

/**
 * Jira Provisioning Variants for POST /api/projects/:projectId/jira/provision
 */
export type JiraProvisionMode = 'link_existing' | 'create_project' | 'create_epic';

export interface ProvisionJiraLinkExisting {
  mode: 'link_existing';
  projectKey: string;
  epicKey?: string;
  connectionRef?: string;
}

export interface ProvisionJiraCreateProject {
  mode: 'create_project';
  projectKey: string;           // Key to create (e.g. "PRJ")
  projectName: string;          // Name of project to create
  templateKey?: string;         // e.g. "software.kanban", "software.scrum"
  projectTypeKey?: string;      // "software" or "business"
  confirmRemoteCreation?: boolean;
  operationId?: string;
  connectionRef?: string;
}

export interface ProvisionJiraCreateEpic {
  mode: 'create_epic';
  projectKey: string;           // Target existing Jira project key
  epicSummary: string;          // Summary for the epic issue
  issueType?: string;           // Issue type name or id for Epic
  confirmRemoteCreation?: boolean;
  operationId?: string;
  connectionRef?: string;
}

export type ProvisionJiraRequest =
  | ProvisionJiraLinkExisting
  | ProvisionJiraCreateProject
  | ProvisionJiraCreateEpic;

export type JiraProvisionRequest = {
  mode: JiraProvisionMode | 'none';
  connectionId?: string;
  connectionRef?: string;
  projectKey?: string;
  projectName?: string;
  epicSummary?: string;
  issueType?: string;
  templateKey?: string;
  connection?: {
    hostUrl: string;
    userEmail: string;
    apiToken?: string;
  };
  confirmRemoteCreation?: boolean;
  operationId?: string;
  epicKey?: string;
  createProject?: {
    key: string;
    name: string;
    projectTypeKey: 'business' | 'software' | 'service_desk' | 'customer_service';
    projectTemplateKey: string;
    leadAccountId: string;
    description?: string;
  };
  createEpic?: { summary: string; description?: string };
};

export interface JiraProvisionResult {
  projectId: string;
  operationId: string;
  mode: JiraProvisionMode | 'none';
  status: 'succeeded' | 'failed' | 'reconciled' | 'replayed' | 'no_change';
  connectionId?: string | null;
  projectKey?: string | null;
  epicKey?: string | null;
  error?: { code: string; httpStatus?: number; message: string; requiredPermissions?: string[] };
  note?: string;
}

export interface ProvisionJiraResponse {
  projectId: string;
  provisionStatus: 'linked' | 'provisioned';
  jira: ProjectJiraState;
  remoteUrl?: string;
  message: string;
  operationId?: string;
  code?: string;
  details?: Record<string, any>;
}

/**
 * Backend-supported Jira Templates and Issue Types metadata
 */
export interface JiraTemplateOption {
  key: string;
  name: string;
  description: string;
}

export interface JiraIssueTypeOption {
  id: string;
  name: string;
  isEpic: boolean;
}

export interface JiraMetadataResponse {
  templates: JiraTemplateOption[];
  issueTypes: JiraIssueTypeOption[];
  defaultTemplateKey: string;
  capabilities?: ProjectCapabilities['jira'];
}

/**
 * Standard Error Response
 */
export interface ProjectApiErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, any>;
  blockers?: string[];
  activeRunsCount?: number;
}

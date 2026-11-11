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
  repoUrl: string;
  localPath?: string;
  defaultBranch?: string;
  targetDirectory?: string;
  localWriteMode?: 'worktree' | 'direct_write' | 'git_branch' | 'patch_export';
  branchPrefix?: string;
  deliveryMode?: 'pull_request' | 'branch_push' | 'local_artifacts';
}

export type ProjectStatus = 'active' | 'archived';

export type JiraProvisionStatus = 'unlinked' | 'linked' | 'provisioned' | 'failed';

export interface ProjectJiraState {
  connectionRef?: string;       // Public/opaque host connection reference, e.g. "jira.corp.internal"
  projectKey?: string;          // Jira Project Key (e.g. "AEG", "DUP")
  epicKey?: string;             // Optional Epic Issue Key (e.g. "AEG-100")
  provisionStatus?: JiraProvisionStatus;
  lastSync?: string;            // ISO timestamp
  error?: string;               // Last sync/provision error message
}

export interface ProjectAgentPreferences {
  defaultProvider?: 'gemini' | 'openai' | 'custom';
  defaultModel?: string;
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
}

export interface Project extends ProjectSummary {
  agentPreferences?: ProjectAgentPreferences;
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
}

export interface ProvisionJiraCreateProject {
  mode: 'create_project';
  projectKey: string;           // Key to create (e.g. "PRJ")
  projectName: string;          // Name of project to create
  templateKey?: string;         // e.g. "software.kanban", "software.scrum"
  projectTypeKey?: string;      // "software" or "business"
}

export interface ProvisionJiraCreateEpic {
  mode: 'create_epic';
  projectKey: string;           // Target existing Jira project key
  epicSummary: string;          // Summary for the epic issue
  issueType?: string;           // Issue type name or id for Epic
}

export type ProvisionJiraRequest =
  | ProvisionJiraLinkExisting
  | ProvisionJiraCreateProject
  | ProvisionJiraCreateEpic;

export interface ProvisionJiraResponse {
  projectId: string;
  provisionStatus: 'linked' | 'provisioned';
  jira: ProjectJiraState;
  remoteUrl?: string;
  message: string;
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

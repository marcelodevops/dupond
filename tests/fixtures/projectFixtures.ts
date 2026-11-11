/**
 * Dupond Project Management Test Fixtures
 * 
 * Used EXCLUSIVELY in tests to verify contract parsing, UI rendering,
 * and test server responses.
 * 
 * Never imported into production project API client or production state adapters.
 */

import { Project, JiraMetadataResponse } from '../../src/types/projectContract';

export const FIXTURE_PROJECTS: Project[] = [
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
      lastSync: '2026-11-10T22:00:00.000Z',
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
      lastSync: '2026-11-10T12:00:00.000Z',
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

export const FIXTURE_JIRA_METADATA: JiraMetadataResponse = {
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

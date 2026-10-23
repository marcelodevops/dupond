export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type AutonomyMode = 'full_autonomous' | 'semi_autonomous' | 'step_by_step';

export type ReasoningLevel = 'standard' | 'deep_thinking';

export type RiskTolerance = 'conservative' | 'balanced' | 'aggressive';

export interface SubTask {
  id: string;
  title: string;
  completed: boolean;
}

export interface Task {
  id: string;
  key: string; // e.g. AEG-101
  title: string;
  description: string;
  epicId: string;
  status: TaskStatus;
  priority: Priority;
  assignedAgentId: string;
  estimatedHours: number;
  spentHours: number;
  dependencies: string[]; // array of Task IDs that must be 'done' first
  subtasks: SubTask[];
  tags: string[];
  deliverables?: string[];
  lastAgentComment?: string;
  jiraSynced?: boolean;
  slackNotified?: boolean;
  lastUpdated?: string;
}

export interface Epic {
  id: string;
  title: string;
  description: string;
  color: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  baseRole: string;
  avatar: string;
  model: string;
  status: 'idle' | 'working' | 'reviewing' | 'blocked';
  currentTaskId?: string;
  completedTasksCount: number;
  velocity: number; // Story points / capacity index
  skills: string[];
  communicationCount: number;
  providerType: 'gemini' | 'custom_api';
  customEndpointId?: string;
  dynamicRoleHistory?: { role: string; taskKey: string; timestamp: string }[];
}

export interface OrchestratorConfig {
  personaName: string;
  systemPrompt: string;
  autonomyMode: AutonomyMode;
  model: string;
  temperature: number;
  reasoningLevel: ReasoningLevel;
  riskTolerance: RiskTolerance;
  delegationRules: string[];
  requireHumanApprovalForCritical: boolean;
  autoJiraSync: boolean;
  autoSlackBroadcast: boolean;
}

export interface CommunicationMessage {
  id: string;
  timestamp: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  recipientId?: string; // 'all' or agentId
  content: string;
  messageType: 'directive' | 'handoff' | 'qa_verdict' | 'blocker' | 'status_update' | 'deliverable';
  taskId?: string;
}

export interface StatusReport {
  id: string;
  title: string;
  period: string;
  generatedAt: string;
  executiveSummary: string;
  metrics: {
    velocity: number;
    completionRate: number;
    blockerCount: number;
    sprintHealth: 'Green' | 'Amber' | 'Red';
  };
  highlights: string[];
  risksAndBlockers: string[];
  nextMilestones: string[];
  slackDigest: string;
  jiraDigest: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  endpointUrl: string;
  apiKeyHeader?: string;
  providerType: 'llm' | 'webhook' | 'agent_rpc' | 'ci_cd';
  active: boolean;
  latencyMs?: number;
}

export interface IntegrationConfig {
  jira: {
    enabled: boolean;
    hostUrl: string;
    projectKey: string;
    userEmail?: string;
    apiToken: string;
    webhookUrl: string;
    syncEnabled: boolean;
  };
  slack: {
    enabled: boolean;
    webhookUrl: string;
    channel: string;
    notifyOnStatusChange: boolean;
    notifyOnBlocker: boolean;
    notifyOnCompletion: boolean;
  };
  customProviders: CustomProvider[];
}

export interface PlanTemplate {
  id: string;
  title: string;
  category: string;
  description: string;
  planContent: string;
}

import { z } from 'zod';

export const TASK_KEY_REGEX = /^AEG-\d+$/;

export const TaskStatusSchema = z.enum(['backlog', 'todo', 'in_progress', 'review', 'done']);
export const PrioritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export const AutonomyModeSchema = z.enum(['full_autonomous', 'semi_autonomous', 'step_by_step']);
export const ReasoningLevelSchema = z.enum(['standard', 'deep_thinking']);
export const RiskToleranceSchema = z.enum(['conservative', 'balanced', 'aggressive']);

export const SubTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  completed: z.boolean(),
  checkCommand: z.string().optional(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  key: z.string().regex(TASK_KEY_REGEX, 'Task key must match format AEG-<number>'),
  title: z.string().min(1),
  description: z.string().default(''),
  epicId: z.string().min(1),
  status: TaskStatusSchema,
  priority: PrioritySchema,
  assignedAgentId: z.string().default(''),
  estimatedHours: z.number().nonnegative().default(6),
  spentHours: z.number().nonnegative().default(0),
  dependencies: z.array(z.string()).default([]),
  subtasks: z.array(SubTaskSchema).default([]),
  tags: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).optional().default([]),
  lastAgentComment: z.string().optional(),
  jiraSynced: z.boolean().optional().default(false),
  slackNotified: z.boolean().optional().default(false),
  targetBranch: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  lastUpdated: z.string().optional(),
  targetRepo: z.string().optional(),
  baseCommit: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  protectedPaths: z.array(z.string()).optional(),
  verificationCommands: z.array(z.union([z.string(), z.record(z.string(), z.any())])).optional(),
  acceptanceCriteria: z.array(z.object({
    id: z.string(),
    title: z.string(),
    completed: z.boolean().optional(),
    checkCommand: z.string().optional(),
  })).optional(),
  requireApproval: z.boolean().optional(),
  workerConfig: z.object({
    provider: z.string(),
    model: z.string(),
  }).optional(),
  maxAttempts: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  baseRole: z.string().min(1),
  avatar: z.string().default(''),
  model: z.string().default('gemini-3.8-flash'),
  status: z.enum(['idle', 'working', 'reviewing', 'blocked']).default('idle'),
  currentTaskId: z.string().optional(),
  completedTasksCount: z.number().int().nonnegative().default(0),
  velocity: z.number().nonnegative().default(30),
  skills: z.array(z.string()).default([]),
  communicationCount: z.number().int().nonnegative().default(0),
  providerType: z.enum(['gemini', 'custom_api']).default('gemini'),
  customEndpointId: z.string().optional(),
  dynamicRoleHistory: z.array(z.object({
    role: z.string(),
    taskKey: z.string(),
    timestamp: z.string(),
  })).optional().default([]),
});

export const EpicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  color: z.string().default('#3B82F6'),
});

export const CommunicationMessageSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  senderId: z.string().min(1),
  senderName: z.string().min(1),
  senderRole: z.string().min(1),
  recipientId: z.string().optional(),
  content: z.string().min(1),
  messageType: z.enum(['directive', 'handoff', 'qa_verdict', 'blocker', 'status_update', 'deliverable']),
  taskId: z.string().optional(),
});

export const StateMutationSchema = z.object({
  tasks: z.array(TaskSchema).optional(),
  agents: z.array(AgentSchema).optional(),
  epics: z.array(EpicSchema).optional(),
  orchestratorConfig: z.record(z.string(), z.any()).optional(),
  integrationConfig: z.record(z.string(), z.any()).optional(),
  communications: z.array(CommunicationMessageSchema).optional(),
  cycleCount: z.number().int().nonnegative().optional(),
  daemonRunning: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
});

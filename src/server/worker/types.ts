export interface WorkerToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface WorkerExecutionContext {
  taskId: string;
  taskKey: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: Array<{ id: string; title: string }>;
  worktreePath: string;
  allowedPaths: string[];
  protectedPaths: string[];
  attemptNumber: number;
  repairFeedback?: {
    failingCommand?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    unmetCriteria?: string[];
  };
  timeoutMs?: number;
  runId?: string;
  abortSignal?: AbortSignal;
}

export interface WorkerExecutionResult {
  success: boolean;
  filesModified: string[];
  diff: string;
  commitMessage: string;
  logs: string[];
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  durationMs: number;
  errorMessage?: string;
}

export interface CodingWorkerAdapter {
  readonly name: string;
  isAvailable(): Promise<{ available: boolean; error?: string }>;
  execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult>;
}

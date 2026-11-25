export interface WorkerToolCall {
  name: string;
  arguments: Record<string, any>;
}

export type WorkerProvider = 'gemini' | 'openai' | 'opencode' | 'agy';

export interface WorkerConfig {
  provider: WorkerProvider | string;
  model: string;
  maxTokens?: number;
  temperature?: number;
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
  operatorReviewFeedback?: Array<{
    id: string;
    actor: string;
    comment: string;
    revisionSha: string;
    createdAt: string;
  }>;
  timeoutMs?: number;
  runId?: string;
  abortSignal?: AbortSignal;
  workerConfig?: WorkerConfig;
  /** Optional incremental log sink called while a worker attempt is running */
  onLog?: (line: string) => void;
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
  /** True when the failure is a deterministic startup/configuration/prerequisite error that should not be retried */
  nonRetryable?: boolean;
}

export interface CodingWorkerAdapter {
  readonly name: string;
  readonly provider?: WorkerProvider;
  readonly model?: string;
  isAvailable(): Promise<{ available: boolean; error?: string }>;
  execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult>;
}

export interface ProviderToolCall {
  id?: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ProviderTurnResult {
  toolCalls?: ProviderToolCall[];
  textOutput?: string;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  rawResponse?: any;
}

export interface ProviderTurnInput {
  systemPrompt: string;
  conversationHistory: any[];
  abortSignal?: AbortSignal;
}

export interface ModelProviderAdapter {
  readonly provider: WorkerProvider;
  readonly model: string;
  isAvailable(): Promise<{ available: boolean; error?: string }>;
  initConversation(systemPrompt: string): any[];
  generateTurn(input: ProviderTurnInput): Promise<ProviderTurnResult>;
  appendModelResponse(history: any[], turnResult: ProviderTurnResult): void;
  appendToolResults(history: any[], results: Array<{ callId?: string; toolName: string; result: any }>): void;
}

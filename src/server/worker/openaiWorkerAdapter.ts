import { DomainError } from '../utils/errors';
import {
  CodingWorkerAdapter,
  WorkerExecutionContext,
  WorkerExecutionResult,
  WorkerProvider,
} from './types.js';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';
import { OpenAIProviderAdapter, SUPPORTED_OPENAI_MODELS } from './providers/openaiProvider.js';
import { runCodingWorkerLoop } from './codingWorkerLoop.js';
import { resolveSafePath, executeWorkspaceTool, PathResolutionResult } from './tools.js';

export class OpenAICodingWorkerAdapter implements CodingWorkerAdapter {
  readonly name = 'openai_coding_worker';
  readonly provider: WorkerProvider = 'openai';
  readonly model: string;
  private sandbox: SandboxExecutor;
  private providerAdapter: OpenAIProviderAdapter;

  constructor(
    model: string = 'gpt-4o-mini',
    sandbox: SandboxExecutor = defaultSandboxExecutor,
    providerAdapter?: OpenAIProviderAdapter
  ) {
    this.model = model;
    this.sandbox = sandbox;
    this.providerAdapter = providerAdapter || new OpenAIProviderAdapter(this.model);
  }

  public async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const providerAvail = await this.providerAdapter.isAvailable();
    if (!providerAvail.available) {
      return providerAvail;
    }
    const sandboxAvail = this.sandbox.isAvailable();
    if (!sandboxAvail.available) {
      return {
        available: false,
        error: `Prerequisite missing: Execution sandbox unavailable: ${sandboxAvail.error}`,
      };
    }
    return { available: true };
  }

  public resolveSafePath(
    realWorktree: string,
    relPath: string,
    context: { allowedPaths?: string[]; protectedPaths?: string[] }
  ): PathResolutionResult {
    return resolveSafePath(realWorktree, relPath, context);
  }

  public async executeTool(
    context: WorkerExecutionContext,
    name: string,
    args: Record<string, any>,
    log: (msg: string) => void = () => {}
  ): Promise<any> {
    return executeWorkspaceTool(context, name, args, this.sandbox, log);
  }

  public async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    const avail = await this.isAvailable();
    if (!avail.available) {
      throw new DomainError(`Worker execution blocked: ${avail.error}`);
    }
    return runCodingWorkerLoop(this.providerAdapter, context, this.sandbox);
  }
}

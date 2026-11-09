import {
  CodingWorkerAdapter,
  WorkerExecutionContext,
  WorkerExecutionResult,
  WorkerProvider,
} from './types.js';
export * from './types.js';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';
import { GeminiProviderAdapter, SUPPORTED_GEMINI_MODELS } from './providers/geminiProvider.js';
import { runCodingWorkerLoop } from './codingWorkerLoop.js';
import { resolveSafePath, executeWorkspaceTool, PathResolutionResult } from './tools.js';

export class GeminiCodingWorkerAdapter implements CodingWorkerAdapter {
  readonly name = 'gemini_coding_worker';
  readonly provider: WorkerProvider = 'gemini';
  readonly model: string;
  private sandbox: SandboxExecutor;
  private providerAdapter: GeminiProviderAdapter;

  constructor(
    model?: string,
    sandbox: SandboxExecutor = defaultSandboxExecutor,
    providerAdapter?: GeminiProviderAdapter
  ) {
    this.model = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    this.sandbox = sandbox;
    this.providerAdapter = providerAdapter || new GeminiProviderAdapter(this.model);
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
      throw new Error(`Worker execution blocked: ${avail.error}`);
    }
    return runCodingWorkerLoop(this.providerAdapter, context, this.sandbox);
  }
}

export const defaultCodingWorker = new GeminiCodingWorkerAdapter();

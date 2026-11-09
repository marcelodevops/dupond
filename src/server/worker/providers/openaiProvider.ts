import OpenAI from 'openai';
import {
  ModelProviderAdapter,
  ProviderTurnInput,
  ProviderTurnResult,
  ProviderToolCall,
} from '../types.js';
import { getOpenAIToolDeclarations } from '../tools.js';

export const SUPPORTED_OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o3-mini',
  'gpt-4.5-preview',
] as const;

export class OpenAIProviderAdapter implements ModelProviderAdapter {
  readonly provider = 'openai' as const;
  readonly model: string;
  private client?: OpenAI;

  constructor(model?: string, client?: OpenAI) {
    this.model = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.client = client;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = (process.env.OPENAI_API_KEY || '').trim();
      this.client = new OpenAI({
        apiKey,
        defaultHeaders: {
          'User-Agent': 'dupond-coding-worker-openai',
        },
      });
    }
    return this.client;
  }

  public async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const key = process.env.OPENAI_API_KEY;
    if (!key || !key.trim()) {
      return {
        available: false,
        error: 'Prerequisite missing: OPENAI_API_KEY is not set in environment or .env. A valid OpenAI API key is required.',
      };
    }
    return { available: true };
  }

  public initConversation(systemPrompt: string): any[] {
    return [
      { role: 'user', content: systemPrompt },
    ];
  }

  public async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    const client = this.getClient();
    const tools = getOpenAIToolDeclarations();

    let callAttempts = 0;
    const maxCallAttempts = 4;
    let response: any;

    while (callAttempts < maxCallAttempts) {
      if (input.abortSignal?.aborted) {
        throw new Error('Worker execution cancelled by user');
      }

      try {
        callAttempts++;
        const requestParams: any = {
          model: this.model,
          input: input.conversationHistory,
          tools,
        };

        // Reasoning models like o1/o3-mini do not support temperature
        const isReasoningModel = this.model.startsWith('o1') || this.model.startsWith('o3');
        if (!isReasoningModel) {
          requestParams.temperature = 0.2;
        }

        response = await client.responses.create(requestParams, {
          signal: input.abortSignal,
        });
        break;
      } catch (callErr: any) {
        if (input.abortSignal?.aborted) {
          throw new Error('Worker execution cancelled by user');
        }

        // Fail-closed immediately on non-transient authentication, authorization, quota exhaustion, or invalid configuration
        const isQuotaExhausted =
          callErr?.error?.type === 'insufficient_quota' ||
          callErr?.error?.code === 'credit_balance_exhausted' ||
          callErr?.code === 'credit_balance_exhausted' ||
          (callErr?.message && callErr.message.includes('credit_balance_exhausted'));

        if (isQuotaExhausted) {
          throw new Error(`OpenAI account credit balance exhausted (429 insufficient_quota): ${callErr.message}`);
        }

        if (
          callErr instanceof OpenAI.AuthenticationError ||
          callErr?.status === 401 ||
          callErr instanceof OpenAI.PermissionDeniedError ||
          callErr?.status === 403 ||
          callErr instanceof OpenAI.BadRequestError ||
          callErr?.status === 400 ||
          callErr instanceof OpenAI.NotFoundError ||
          callErr?.status === 404
        ) {
          throw new Error(`OpenAI API error (${callErr.status || 'client'}): ${callErr.message || 'Invalid request or credentials'}`);
        }

        const isRateLimit = callErr instanceof OpenAI.RateLimitError || callErr?.status === 429;
        const isTransient =
          callErr instanceof OpenAI.APIConnectionError ||
          callErr instanceof OpenAI.APIConnectionTimeoutError ||
          (callErr?.status && callErr.status >= 500);

        if ((isRateLimit || isTransient) && callAttempts < maxCallAttempts) {
          // Check for retry-after header
          const retryAfterHeader = callErr?.headers?.['retry-after'];
          const waitSec = retryAfterHeader ? Math.ceil(parseFloat(retryAfterHeader)) + 1 : Math.min(callAttempts * 5, 20);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
        } else {
          throw callErr;
        }
      }
    }

    if (!response || !response.output) {
      return {
        textOutput: '',
        rawResponse: response,
      };
    }

    const toolCalls: ProviderToolCall[] = [];
    let textOutput = '';

    for (const item of response.output) {
      if (item.type === 'function_call') {
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments || {};
        } catch {
          parsedArgs = { rawArguments: item.arguments };
        }
        toolCalls.push({
          id: item.call_id || item.id,
          name: item.name,
          arguments: parsedArgs,
        });
      } else if (item.type === 'message' && item.content) {
        if (typeof item.content === 'string') {
          textOutput += item.content + '\n';
        } else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'text' && c.text) {
              textOutput += c.text + '\n';
            }
          }
        }
      }
    }

    const tokenUsage = response.usage ? {
      promptTokens: response.usage.input_tokens || 0,
      completionTokens: response.usage.output_tokens || 0,
      totalTokens: response.usage.total_tokens || ((response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)),
    } : undefined;

    return {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      textOutput: textOutput.trim(),
      tokenUsage,
      rawResponse: response,
    };
  }

  public appendModelResponse(history: any[], turnResult: ProviderTurnResult): void {
    if (turnResult.rawResponse?.output && Array.isArray(turnResult.rawResponse.output)) {
      for (const item of turnResult.rawResponse.output) {
        history.push(item);
      }
    }
  }

  public appendToolResults(history: any[], results: Array<{ callId?: string; toolName: string; result: any }>): void {
    for (const r of results) {
      history.push({
        type: 'function_call_output',
        call_id: r.callId,
        output: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
      });
    }
  }
}

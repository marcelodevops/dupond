import { GoogleGenAI } from '@google/genai';
import {
  ModelProviderAdapter,
  ProviderTurnInput,
  ProviderTurnResult,
  ProviderToolCall,
} from '../types.js';
import { getGeminiToolDeclarations } from '../tools.js';

export const SUPPORTED_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash'] as const;

export class GeminiProviderAdapter implements ModelProviderAdapter {
  readonly provider = 'gemini' as const;
  readonly model: string;
  private client?: GoogleGenAI;

  constructor(model?: string, client?: GoogleGenAI) {
    this.model = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    this.client = client;
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      this.client = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'dupond-coding-worker-gemini',
          },
        },
      });
    }
    return this.client;
  }

  public async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !key.trim()) {
      return {
        available: false,
        error: 'Prerequisite missing: GEMINI_API_KEY is not set in environment or .env. A valid Gemini API key is required.',
      };
    }
    return { available: true };
  }

  public initConversation(systemPrompt: string): any[] {
    return [
      { role: 'user', parts: [{ text: systemPrompt }] },
    ];
  }

  public async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    const ai = this.getClient();
    const toolDeclarations = getGeminiToolDeclarations();

    let callAttempts = 0;
    const maxCallAttempts = 4;
    let response: any;

    while (callAttempts < maxCallAttempts) {
      if (input.abortSignal?.aborted) {
        throw new Error('Worker execution cancelled by user');
      }

      try {
        callAttempts++;
        response = await ai.models.generateContent({
          model: this.model,
          contents: input.conversationHistory,
          config: {
            tools: [{ functionDeclarations: toolDeclarations as any }],
            temperature: 0.2,
          },
        });
        break;
      } catch (callErr: any) {
        if (input.abortSignal?.aborted) {
          throw new Error('Worker execution cancelled by user');
        }

        const errStr = callErr.message || JSON.stringify(callErr);
        const isRateLimit = errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED');
        const isDailyQuotaExhausted = errStr.includes('per day limit exceeded') || errStr.includes('requests per day');
        const retryMatch = errStr.match(/retry in ([0-9.]+)s/i) || errStr.match(/"retryDelay":\s*"(\d+)s"/);
        const parsedWaitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 5 * callAttempts;

        if (isRateLimit && !isDailyQuotaExhausted && parsedWaitSec <= 60 && callAttempts < maxCallAttempts) {
          await new Promise((r) => setTimeout(r, parsedWaitSec * 1000));
        } else {
          // If non-transient, quota exhausted, delay excessive (> 60s), or retries exhausted, fail closed immediately
          throw new Error(`Gemini API rate limit or quota exceeded: ${errStr}`);
        }
      }
    }

    const candidate = response?.candidates?.[0];
    if (!candidate || !candidate.content) {
      return {
        textOutput: '',
        rawResponse: response,
      };
    }

    const toolCalls: ProviderToolCall[] = [];
    const functionCalls = candidate.content.parts?.filter((p: any) => p.functionCall);
    if (functionCalls && functionCalls.length > 0) {
      for (const part of functionCalls) {
        toolCalls.push({
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        });
      }
    }

    const textParts = candidate.content.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('\n') || '';

    const tokenUsage = response.usageMetadata ? {
      promptTokens: response.usageMetadata.promptTokenCount || 0,
      completionTokens: response.usageMetadata.candidatesTokenCount || 0,
      totalTokens: (response.usageMetadata.promptTokenCount || 0) + (response.usageMetadata.candidatesTokenCount || 0),
    } : undefined;

    return {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      textOutput: textParts,
      tokenUsage,
      rawResponse: { candidate },
    };
  }

  public appendModelResponse(history: any[], turnResult: ProviderTurnResult): void {
    if (turnResult.rawResponse?.candidate?.content) {
      history.push(turnResult.rawResponse.candidate.content);
    }
  }

  public appendToolResults(history: any[], results: Array<{ callId?: string; toolName: string; result: any }>): void {
    const parts = results.map((r) => ({
      functionResponse: {
        name: r.toolName,
        response: { result: r.result },
      },
    }));
    history.push({
      role: 'user',
      parts,
    });
  }
}

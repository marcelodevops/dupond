import { GoogleGenAI } from '@google/genai';

const geminiApiKey = process.env.GEMINI_API_KEY;

/**
 * Single source of truth for the worker/assistant Gemini model identifier.
 * Configurable via GEMINI_MODEL so deployments can pin a different generation.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

let ai: GoogleGenAI | null = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function getGeminiClient(): GoogleGenAI | null {
  return ai;
}

export function hasGeminiKey(): boolean {
  return Boolean(geminiApiKey);
}

export async function callGeminiWithTimeout<T>(promise: Promise<T>, timeoutMs = 7000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('AI request timeout')), timeoutMs)),
  ]);
}

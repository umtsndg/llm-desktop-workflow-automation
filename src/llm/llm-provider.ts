import { GeminiChatClient } from './GeminiChatClient';
import { LoggingChatClient } from './LoggingChatClient';
import { OpenAIChatClient } from './OpenAIChatClient';
import type { LLMChatClient } from './llm-types';

export type LLMProvider = 'openai' | 'gemini';

export function normalizeLLMProvider(value: unknown): LLMProvider {
    const provider = String(value ?? process.env.LLM_PROVIDER ?? 'openai').trim().toLowerCase();
    if (provider === 'openai' || provider === 'gemini') return provider;
    throw new Error(`Unsupported LLM provider: ${String(value)}. Use "openai" or "gemini".`);
}

export function providerApiKeyEnv(provider: LLMProvider): string {
    return provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
}

export function providerModel(provider: LLMProvider): string {
    return provider === 'gemini'
        ? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
        : process.env.OPENAI_MODEL ?? 'gpt-5.1';
}

export function buildLlmClient(options?: { provider?: unknown; showLlm?: boolean }): LLMChatClient {
    const provider = normalizeLLMProvider(options?.provider);
    const base = provider === 'gemini' ? new GeminiChatClient() : new OpenAIChatClient();
    if (!options?.showLlm) return base;
    return new LoggingChatClient(base, { logRequests: false, logResponses: true });
}

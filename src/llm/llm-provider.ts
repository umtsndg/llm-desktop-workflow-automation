import { ClaudeChatClient } from './ClaudeChatClient';
import { GeminiChatClient } from './GeminiChatClient';
import { LoggingChatClient } from './LoggingChatClient';
import { OpenAIChatClient } from './OpenAIChatClient';
import type { LLMChatClient } from './llm-types';

export type LLMProvider = 'openai' | 'gemini' | 'claude';

const DEFAULT_MODELS: Record<LLMProvider, string> = {
    openai: 'gpt-5.1',
    gemini: 'gemini-2.5-flash',
    claude: 'claude-sonnet-4-5-20250929',
};

const SUGGESTED_MODELS: Record<LLMProvider, string[]> = {
    openai: ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    claude: [
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-1-20250805',
        'claude-sonnet-4-20250514',
    ],
};

export function normalizeLLMProvider(value: unknown): LLMProvider {
    const provider = String(value ?? process.env.LLM_PROVIDER ?? 'openai').trim().toLowerCase();
    if (provider === 'openai' || provider === 'gemini' || provider === 'claude') return provider;
    throw new Error(`Unsupported LLM provider: ${String(value)}. Use "openai", "gemini", or "claude".`);
}

export function normalizeLLMModel(value: unknown): string | undefined {
    const model = typeof value === 'string' ? value.trim() : '';
    return model.length > 0 ? model : undefined;
}

export function providerApiKeyEnv(provider: LLMProvider): string {
    if (provider === 'claude') return 'ANTHROPIC_API_KEY';
    return provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
}

export function providerModel(provider: LLMProvider): string {
    if (provider === 'claude') return process.env.ANTHROPIC_MODEL ?? DEFAULT_MODELS.claude;
    return provider === 'gemini'
        ? process.env.GEMINI_MODEL ?? DEFAULT_MODELS.gemini
        : process.env.OPENAI_MODEL ?? DEFAULT_MODELS.openai;
}

export function providerModelOptions(provider: LLMProvider): string[] {
    return Array.from(new Set([providerModel(provider), ...SUGGESTED_MODELS[provider]]));
}

export function buildLlmClient(options?: { provider?: unknown; model?: unknown; showLlm?: boolean }): LLMChatClient {
    const provider = normalizeLLMProvider(options?.provider);
    const model = normalizeLLMModel(options?.model);
    const base =
        provider === 'claude'
            ? new ClaudeChatClient({ model })
            : provider === 'gemini'
                ? new GeminiChatClient({ model })
                : new OpenAIChatClient({ model });
    if (!options?.showLlm) return base;
    return new LoggingChatClient(base, { logRequests: false, logResponses: true });
}

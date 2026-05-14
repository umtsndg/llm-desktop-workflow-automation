import { OpenAIChatClient } from './OpenAIChatClient';
import type { LLMChatClient, LLMChatResult, LLMMessage } from './llm-types';

type GeminiChatClientOptions = {
    apiKey: string;
    baseUrl?: string;
    model: string;
    visionModel?: string;
    temperature?: number;
};

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
}

export class GeminiChatClient implements LLMChatClient {
    private readonly inner: OpenAIChatClient;

    constructor(options?: Partial<GeminiChatClientOptions>) {
        const model = options?.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

        this.inner = new OpenAIChatClient({
            apiKey: options?.apiKey ?? requiredEnv('GEMINI_API_KEY'),
            baseUrl: options?.baseUrl ?? process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
            model,
            visionModel: options?.visionModel ?? process.env.GEMINI_VISION_MODEL ?? model,
            temperature: options?.temperature,
            providerName: 'Gemini',
            chatCompletionsPath: '/chat/completions',
        });
    }

    chat(messages: LLMMessage[]): Promise<LLMChatResult> {
        return this.inner.chat(messages);
    }
}

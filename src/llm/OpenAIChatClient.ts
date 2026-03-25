import type { LLMChatClient, LLMChatResult, LLMMessage } from './llm-types';

type OpenAIChatClientOptions = {
    apiKey: string;
    baseUrl?: string;
    model: string;
    temperature?: number;
};

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
}

export class OpenAIChatClient implements LLMChatClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly temperature: number;

    constructor(options?: Partial<OpenAIChatClientOptions>) {
        this.apiKey = options?.apiKey ?? requiredEnv('OPENAI_API_KEY');
        this.baseUrl = (options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
        this.model = options?.model ?? (process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
        this.temperature = options?.temperature ?? 0.2;
    }

    async chat(messages: LLMMessage[]): Promise<LLMChatResult> {
        const maxRetries = 6;
        let lastErr: unknown;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${this.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: this.model,
                        temperature: this.temperature,
                        messages,
                        response_format: { type: 'json_object' },
                    }),
                });

                if (!res.ok) {
                    const text = await res.text().catch(() => '');

                    // Retry on transient errors and rate limits.
                    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
                        const retryAfterHeader = res.headers.get('retry-after');
                        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
                        const hintedMs = parseRetryAfterMsFromBody(text);
                        const baseDelayMs = Number.isFinite(retryAfterMs)
                            ? (retryAfterMs as number)
                            : Number.isFinite(hintedMs)
                                ? (hintedMs as number)
                                : 350;
                        const backoffMs = Math.min(10_000, Math.round(baseDelayMs * Math.pow(1.6, attempt)));
                        const jitterMs = Math.floor(Math.random() * 150);
                        await sleep(backoffMs + jitterMs);
                        continue;
                    }

                    throw new Error(`OpenAI chat failed (${res.status}): ${text || res.statusText}`);
                }

                const json = (await res.json()) as any;
                const content = json?.choices?.[0]?.message?.content;
                if (typeof content !== 'string') {
                    throw new Error('OpenAI chat returned no message content');
                }

                return {
                    content,
                    model: json?.model,
                    raw: json,
                };
            } catch (e) {
                lastErr = e;
                // Network errors: retry a few times.
                if (attempt < maxRetries) {
                    const backoffMs = Math.min(10_000, Math.round(350 * Math.pow(1.6, attempt)));
                    const jitterMs = Math.floor(Math.random() * 150);
                    await sleep(backoffMs + jitterMs);
                    continue;
                }
                break;
            }
        }

        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMsFromBody(bodyText: string): number {
    // OpenAI sometimes returns: "Please try again in 675ms."
    const m = bodyText.match(/try again in\s+(\d+)\s*ms/i);
    if (!m?.[1]) return NaN;
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? ms : NaN;
}

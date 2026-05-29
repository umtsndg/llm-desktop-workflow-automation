import type { LLMChatClient, LLMChatResult, LLMMessage, LLMMessageContent } from './llm-types';

type ClaudeChatClientOptions = {
    apiKey: string;
    baseUrl?: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
};

type ClaudeContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

type ClaudeMessage = {
    role: 'user' | 'assistant';
    content: string | ClaudeContentBlock[];
};

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
}

export class ClaudeChatClient implements LLMChatClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;

    constructor(options?: Partial<ClaudeChatClientOptions>) {
        this.apiKey = options?.apiKey ?? requiredEnv('ANTHROPIC_API_KEY');
        this.baseUrl = (options?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
        this.model = options?.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929';
        this.maxTokens = options?.maxTokens ?? Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4096);
        this.temperature = options?.temperature ?? 0.2;
    }

    async chat(messages: LLMMessage[]): Promise<LLMChatResult> {
        const maxRetries = 6;
        let lastErr: unknown;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const converted = convertMessages(messages);
                const body: Record<string, unknown> = {
                    model: this.model,
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    messages: converted.messages,
                };
                if (converted.system) {
                    body.system = converted.system;
                }

                const res = await fetch(`${this.baseUrl}/v1/messages`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': this.apiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify(body),
                });

                if (!res.ok) {
                    const text = await res.text().catch(() => '');

                    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
                        const retryAfterHeader = res.headers.get('retry-after');
                        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
                        const baseDelayMs = Number.isFinite(retryAfterMs) ? (retryAfterMs as number) : 350;
                        const backoffMs = Math.min(10_000, Math.round(baseDelayMs * Math.pow(1.6, attempt)));
                        const jitterMs = Math.floor(Math.random() * 150);
                        await sleep(backoffMs + jitterMs);
                        continue;
                    }

                    throw new Error(`Claude chat failed (${res.status}): ${text || res.statusText}`);
                }

                const json = (await res.json()) as any;
                const content = Array.isArray(json?.content)
                    ? json.content
                        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                        .map((part: any) => part.text)
                        .join('\n')
                    : '';

                if (!content) {
                    throw new Error('Claude chat returned no text content');
                }

                return {
                    content,
                    model: json?.model,
                    raw: json,
                };
            } catch (e) {
                lastErr = e;
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

function convertMessages(messages: LLMMessage[]): { system?: string; messages: ClaudeMessage[] } {
    const systemParts: string[] = [];
    const out: ClaudeMessage[] = [];

    for (const message of messages) {
        if (message.role === 'system') {
            const text = contentToSystemText(message.content);
            if (text) systemParts.push(text);
            continue;
        }

        const role = message.role;
        const content = contentToClaudeContent(message.content);
        const last = out[out.length - 1];

        if (last?.role === role) {
            last.content = mergeClaudeContent(last.content, content);
        } else {
            out.push({ role, content });
        }
    }

    if (out.length === 0 || out[0]?.role === 'assistant') {
        out.unshift({ role: 'user', content: 'Continue.' });
    }

    return {
        ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
        messages: out,
    };
}

function contentToSystemText(content: LLMMessageContent): string {
    if (typeof content === 'string') return content;
    return content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
}

function contentToClaudeContent(content: LLMMessageContent): string | ClaudeContentBlock[] {
    if (typeof content === 'string') return content;

    const blocks: ClaudeContentBlock[] = [];
    for (const part of content) {
        if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
            continue;
        }

        const image = parseDataUrlImage(part.image_url.url);
        if (image) {
            blocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: image.mediaType,
                    data: image.data,
                },
            });
        } else {
            blocks.push({ type: 'text', text: `Image URL: ${part.image_url.url}` });
        }
    }

    return blocks;
}

function mergeClaudeContent(a: string | ClaudeContentBlock[], b: string | ClaudeContentBlock[]): string | ClaudeContentBlock[] {
    if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
    return [...asBlocks(a), ...asBlocks(b)];
}

function asBlocks(content: string | ClaudeContentBlock[]): ClaudeContentBlock[] {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return content;
}

function parseDataUrlImage(url: string): { mediaType: string; data: string } | null {
    const match = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!match?.[1] || !match?.[2]) return null;
    return { mediaType: match[1], data: match[2] };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

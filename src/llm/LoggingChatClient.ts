import type { LLMChatClient, LLMChatResult, LLMMessage, LLMMessageContent } from './llm-types';

export type LoggingChatClientOptions = {
    logRequests?: boolean;
    logResponses?: boolean;
    maxContentChars?: number;
};

function summarizeContent(content: LLMMessageContent, maxChars: number): string {
    if (typeof content === 'string') {
        const s = content;
        return s.length > maxChars ? `${s.slice(0, maxChars)}…<truncated ${s.length - maxChars} chars>` : s;
    }

    // Array of parts (text + images)
    const parts = content
        .map((p) => {
            if (p.type === 'text') {
                const t = p.text ?? '';
                return t.length > maxChars ? `${t.slice(0, maxChars)}…<truncated>` : t;
            }
            if (p.type === 'image_url') {
                const url = p.image_url?.url ?? '';
                return url.startsWith('data:image') ? 'image:data-url(base64 omitted)' : `image:${url}`;
            }
            return 'unknown-part';
        })
        .join('\n');

    return parts.length > maxChars ? `${parts.slice(0, maxChars)}…<truncated>` : parts;
}

export class LoggingChatClient implements LLMChatClient {
    private callIndex = 0;
    private readonly opts: Required<LoggingChatClientOptions>;

    constructor(
        private readonly inner: LLMChatClient,
        options?: LoggingChatClientOptions
    ) {
        this.opts = {
            logRequests: options?.logRequests ?? false,
            logResponses: options?.logResponses ?? true,
            maxContentChars: options?.maxContentChars ?? 2000,
        };
    }

    async chat(messages: LLMMessage[]): Promise<LLMChatResult> {
        this.callIndex += 1;
        const id = this.callIndex;

        if (this.opts.logRequests) {
            process.stderr.write(`\n[LLM ${id}] REQUEST\n`);
            for (const m of messages) {
                const summary = summarizeContent(m.content, this.opts.maxContentChars);
                process.stderr.write(`${m.role.toUpperCase()}: ${summary}\n`);
            }
        }

        const result = await this.inner.chat(messages);

        if (this.opts.logResponses) {
            process.stderr.write(`\n[LLM ${id}] RESPONSE\n`);
            process.stderr.write(`${result.content}\n`);
        }

        return result;
    }
}

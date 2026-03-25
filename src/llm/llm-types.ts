export type LLMRole = 'system' | 'user' | 'assistant';

export type LLMContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export type LLMMessageContent = string | LLMContentPart[];

export type LLMMessage = {
    role: LLMRole;
    content: LLMMessageContent;
};

export type LLMChatResult = {
    content: string;
    model?: string;
    raw?: unknown;
};

export interface LLMChatClient {
    chat(messages: LLMMessage[]): Promise<LLMChatResult>;
}

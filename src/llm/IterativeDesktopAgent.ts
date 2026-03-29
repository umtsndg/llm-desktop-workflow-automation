import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction, ExecutionResult } from '../desktop/action-types';
import { getDesktopPerception, type DesktopPerception } from '../desktop/perception';

import type { LLMChatClient, LLMContentPart, LLMMessage } from './llm-types';
import { extractFirstJsonObject } from './json-extract';
import { buildLoopSystemPrompt, buildPlanPrompt } from './loop-prompts';
import { assertPlanOutput, type PlanOutput } from './validate-loop';

export type IterationLog = {
    iteration: number;
    plannedActions: DesktopAction[];
    results: ExecutionResult[];
};

export type RunOptions = {
    maxIterations?: number;
    maxPlanRetries?: number;
    /** Milliseconds to wait after executing any desktop action before the next LLM call. */
    postActionDelayMs?: number;
    maxHistoryMessages?: number;
};

export class IterativeDesktopAgent {
    constructor(private readonly llm: LLMChatClient) { }

    async run(
        task: string,
        operator: DesktopOperator,
        options?: RunOptions
    ): Promise<{ ok: boolean; message: string; iterations: IterationLog[] }> {
        const maxIterations = options?.maxIterations ?? 20;
        const maxPlanRetries = options?.maxPlanRetries ?? 2;
        const postActionDelayMs = options?.postActionDelayMs ?? 5000;
        const maxHistoryMessages = options?.maxHistoryMessages ?? 30;

        const conversation: LLMMessage[] = [
            { role: 'system', content: buildLoopSystemPrompt(task) },
            { role: 'user', content: `Goal: ${task}` },
        ];

        const iterations: IterationLog[] = [];
        let lastMessage = 'Not started';
        let memory = 'None yet.';
        let lastExecutedAction: DesktopAction | undefined;

        for (let i = 1; i <= maxIterations; i++) {
            const perceptionBefore = await getDesktopPerception().catch(() => null);

            // Always provide a screenshot before planning so the model has
            // full visual context for each planning step.
            let planningScreenshotBase64: string | undefined;
            let planningScreenshotWidth: number | undefined;
            let planningScreenshotHeight: number | undefined;

            const initialPlanningObs = await operator.screenshot().catch(() => null);
            if (initialPlanningObs) {
                planningScreenshotBase64 = initialPlanningObs.screenshotBase64;
                planningScreenshotWidth = initialPlanningObs.width;
                planningScreenshotHeight = initialPlanningObs.height;
            }

            const plan = await this.planOnce(conversation, {
                task,
                iteration: i,
                memory,
                perception: perceptionBefore,
                screenshotBase64: planningScreenshotBase64,
                screenshotWidth: planningScreenshotWidth,
                screenshotHeight: planningScreenshotHeight,
                retries: maxPlanRetries,
                maxHistoryMessages,
            });

            if (plan.thought) {
                try {
                    console.error(`[LLM] Thought (iteration ${i}): ${plan.thought}`);
                } catch {
                    // ignore logging issues
                }
            }

            // After seeing the plan for iteration i, log the last successfully
            // executed action from the previous iteration (if any).
            try {
                if (lastExecutedAction) {
                    console.error(`[AGENT] Last action before iteration ${i}: ${JSON.stringify(lastExecutedAction)}`);
                }
            } catch {
                // ignore logging issues
            }

            const planActions = plan.actions.slice(0, 1);
            if (planActions.length === 0) {
                lastMessage = 'No actions returned by planner.';
                break;
            }

            const actionsToExecute: DesktopAction[] = [];
            const primaryAction = planActions[0]!;

            if (primaryAction.type === 'typeText') {
                await focusExpectedWindowForEvidence(task, operator);
            }

            actionsToExecute.push(...planActions);

            const results = await operator.execute(actionsToExecute);

            // Update lastExecutedAction with the last successful action from this iteration, if any.
            try {
                for (let idx = results.length - 1; idx >= 0; idx--) {
                    const r = results[idx];
                    if (r && r.ok) {
                        lastExecutedAction = r.action;
                        break;
                    }
                }
            } catch {
                // ignore logging issues
            }

            if (postActionDelayMs > 0) {
                await delay(postActionDelayMs);
            }

            iterations.push({
                iteration: i,
                plannedActions: planActions,
                results,
            });

            lastMessage = `Last action: ${JSON.stringify(planActions[0] ?? {})}`;
            memory = buildMemoryUpdate(memory, i, results, lastMessage);
        }

        return { ok: false, message: `Stopped after ${maxIterations} iterations: ${lastMessage}`, iterations };
    }

    private async planOnce(
        conversation: LLMMessage[],
        input: {
            task: string;
            iteration: number;
            memory: string;
            perception: DesktopPerception | null;
            screenshotBase64?: string;
            screenshotWidth?: number;
            screenshotHeight?: number;
            retries: number;
            maxHistoryMessages: number;
        }
    ): Promise<PlanOutput> {
        let lastError: string | null = null;

        for (let attempt = 0; attempt <= input.retries; attempt++) {
            const perceptionText = input.perception ? formatPerception(input.perception) : 'Perception unavailable.';
            const resolutionLines =
                input.screenshotBase64 && input.screenshotWidth && input.screenshotHeight
                    ? ['', `Screen: width=${input.screenshotWidth}, height=${input.screenshotHeight} (pixels)`]
                    : [];

            // Also log the perception to CLI output so the user can
            // see the same summary that the LLM receives.
            try {
                console.error(`[PERCEPTION] Iteration ${input.iteration}:\n${perceptionText}`);
            } catch {
                // ignore logging issues
            }

            const promptForLlm = [
                buildPlanPrompt(input.task),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
                ...resolutionLines,
                ...(input.screenshotBase64 ? ['', 'Screenshot: (provided as image)'] : []),
            ].join('\n');

            const promptForHistory = [
                buildPlanPrompt(input.task),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
                ...resolutionLines,
                ...(input.screenshotBase64
                    ? ['', `Screenshot: <omitted base64 length=${input.screenshotBase64.length}>`]
                    : []),
            ].join('\n');

            const userContentParts: LLMContentPart[] = [{ type: 'text', text: promptForLlm }];
            if (input.screenshotBase64) {
                userContentParts.push({
                    type: 'image_url',
                    image_url: { url: `data:image/png;base64,${input.screenshotBase64}` },
                });
            }

            const messages: LLMMessage[] = [
                ...conversation,
                { role: 'user', content: userContentParts },
                ...(lastError
                    ? [{ role: 'user' as const, content: `Your previous output was invalid: ${lastError}. Output ONLY the correct JSON.` }]
                    : []),
            ];

            const result = await this.llm.chat(messages);
            try {
                const rawContent = result.content;
                let thought: string | undefined;
                if (typeof rawContent === 'string') {
                    const m = rawContent.match(/^[ \t]*Thought:(.*)$/im);
                    if (m) thought = m[1].trim();
                }

                const json = extractFirstJsonObject(result.content);
                const basePlan = assertPlanOutput(json);
                const plan: PlanOutput = { ...basePlan, ...(thought ? { thought } : {}) };

                conversation.push({ role: 'user', content: promptForHistory });
                conversation.push({ role: 'assistant', content: result.content });
                trimConversation(conversation, input.maxHistoryMessages);

                return plan;
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
            }
        }

        throw new Error(`Failed to get a valid plan from LLM: ${lastError ?? 'unknown error'}`);
    }
}

async function focusExpectedWindowForEvidence(task: string, operator: DesktopOperator): Promise<void> {
    const title = inferExpectedWindowTitleFromTask(task);
    if (!title) return;

    // Best-effort: bring the app to foreground before interacting.
    await operator
        .execute([
            { type: 'focusWindow', title, match: 'contains' },
            { type: 'wait', ms: 250 },
        ])
        .catch(() => undefined);
}

function inferExpectedWindowTitleFromTask(task: string): string | null {
    const t = task.toLowerCase();

    const xlsx = task.match(/([A-Za-z0-9 _-]+)\.xlsx\b/i);
    if (xlsx?.[1]) return xlsx[1];
    const docx = task.match(/([A-Za-z0-9 _-]+)\.docx\b/i);
    if (docx?.[1]) return docx[1];
    const pptx = task.match(/([A-Za-z0-9 _-]+)\.pptx\b/i);
    if (pptx?.[1]) return pptx[1];

    if (t.includes('notepad')) return 'Notepad';
    if (t.includes('excel') || t.includes('.xlsx')) return 'Excel';
    if (t.includes('chrome')) return 'Chrome';
    if (t.includes('edge')) return 'Edge';
    if (t.includes('spotify')) return 'Spotify';

    return null;
}

function trimConversation(conversation: LLMMessage[], maxMessages: number): void {
    if (conversation.length <= maxMessages) return;
    const system = conversation[0];
    const tail = conversation.slice(-Math.max(maxMessages - 1, 1));
    conversation.length = 0;
    conversation.push(system, ...tail);
}

function formatPerception(p: DesktopPerception): string {
    const maxTitleLen = 90;
    const active = p.activeWindowTitle
        ? p.activeWindowTitle.length > maxTitleLen
            ? `${p.activeWindowTitle.slice(0, maxTitleLen - 1)}…`
            : p.activeWindowTitle
        : null;

    // Only expose the active window to the LLM (and CLI logs),
    // not the full list of open windows.
    return [
        `Time: ${p.timestamp}`,
        `Active window: ${active ?? 'unknown'}`,
    ].join('\n');
}

function buildMemoryUpdate(prev: string, iteration: number, results: ExecutionResult[], note: string): string {
    const { okCount, failCount, firstError } = summarizeResults(results);
    const line = `Iter ${iteration}: ok=${okCount} fail=${failCount}${firstError ? ` firstError=${firstError}` : ''} msg=${note}`;
    const next = prev === 'None yet.' ? line : `${prev}\n${line}`;
    const lines = next.split(/\r?\n/).slice(-12);
    return lines.join('\n');
}

function summarizeResults(results: ExecutionResult[]): { okCount: number; failCount: number; firstError?: string } {
    let okCount = 0;
    let failCount = 0;
    let firstError: string | undefined;
    for (const r of results) {
        if (r.ok) okCount += 1;
        else {
            failCount += 1;
            if (!firstError && r.error) firstError = r.error;
        }
    }
    return { okCount, failCount, firstError };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

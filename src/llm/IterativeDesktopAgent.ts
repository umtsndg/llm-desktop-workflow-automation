import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction, ExecutionResult } from '../desktop/action-types';
import { getDesktopPerception, type DesktopPerception } from '../desktop/perception';

import type { LLMChatClient, LLMContentPart, LLMMessage } from './llm-types';
import { extractFirstJsonObject } from './json-extract';
import { buildLoopSystemPrompt, buildPlanPrompt, buildReflectPrompt, buildVerifyPrompt } from './loop-prompts';
import { assertPlanOutput, assertReflectionOutput, assertVerificationOutput, type PlanOutput, type ReflectionOutput, type ToolRequest, type VerificationOutput } from './validate-loop';

export type IterationLog = {
    iteration: number;
    plannedActions: DesktopAction[];
    results: ExecutionResult[];
    reflection: ReflectionOutput;
    verification?: VerificationOutput;
};

export type RunOptions = {
    maxIterations?: number;
    maxPlanRetries?: number;
    maxReflectRetries?: number;
    maxVerifyRetries?: number;
    maxToolRequestRounds?: number;
    includePerception?: boolean;
    includeScreenshotInReflection?: boolean;
    verifyOnDone?: boolean;
    maxHistoryMessages?: number;
};

export class IterativeDesktopAgent {
    constructor(private readonly llm: LLMChatClient) { }

    async run(task: string, operator: DesktopOperator, options?: RunOptions): Promise<{ ok: boolean; message: string; iterations: IterationLog[] }> {
        const maxIterations = options?.maxIterations ?? 6;
        const maxPlanRetries = options?.maxPlanRetries ?? 2;
        const maxReflectRetries = options?.maxReflectRetries ?? 2;
        const maxVerifyRetries = options?.maxVerifyRetries ?? 1;
        const maxToolRequestRounds = options?.maxToolRequestRounds ?? 2;
        const includePerception = options?.includePerception ?? true;
        const includeScreenshotInReflection = options?.includeScreenshotInReflection ?? false;
        const verifyOnDone = options?.verifyOnDone ?? true;
        const maxHistoryMessages = options?.maxHistoryMessages ?? 10;

        const conversation: LLMMessage[] = [
            { role: 'system', content: buildLoopSystemPrompt(task) },
            { role: 'user', content: `Goal: ${task}` },
        ];

        const iterations: IterationLog[] = [];
        let lastMessage = 'Not started';
        let memory = 'None yet.';

        for (let i = 1; i <= maxIterations; i++) {
            let perceptionBefore = includePerception ? await getDesktopPerception() : null;
            let planningScreenshotBase64: string | undefined;

            let plan = await this.planOnce(conversation, {
                task,
                iteration: i,
                memory,
                perception: perceptionBefore,
                screenshotBase64: planningScreenshotBase64,
                retries: maxPlanRetries,
                maxHistoryMessages,
            });

            for (let round = 0; round < maxToolRequestRounds && plan.toolRequests.length > 0; round++) {
                const toolData = await fulfillToolRequests(plan.toolRequests, operator);
                if (toolData.perception) perceptionBefore = toolData.perception;
                if (toolData.screenshotBase64) planningScreenshotBase64 = toolData.screenshotBase64;

                plan = await this.planOnce(conversation, {
                    task,
                    iteration: i,
                    memory,
                    perception: perceptionBefore,
                    screenshotBase64: planningScreenshotBase64,
                    retries: maxPlanRetries,
                    maxHistoryMessages,
                });
            }

            const planActions = plan.actions;
            const results = await operator.execute(planActions);

            let perceptionAfter = includePerception ? await getDesktopPerception() : null;
            let reflectionScreenshotBase64: string | undefined = undefined;
            if (includeScreenshotInReflection) {
                reflectionScreenshotBase64 = (await operator.screenshot().catch(() => null))?.screenshotBase64;
            }

            let reflection = await this.reflectOnce(conversation, {
                task,
                iteration: i,
                memory,
                plannedActions: planActions,
                results,
                perception: perceptionAfter,
                screenshotBase64: reflectionScreenshotBase64,
                retries: maxReflectRetries,
                maxHistoryMessages,
            });

            for (let round = 0; round < maxToolRequestRounds && reflection.toolRequests.length > 0; round++) {
                const toolData = await fulfillToolRequests(reflection.toolRequests, operator);
                if (toolData.perception) perceptionAfter = toolData.perception;
                if (toolData.screenshotBase64) reflectionScreenshotBase64 = toolData.screenshotBase64;

                reflection = await this.reflectOnce(conversation, {
                    task,
                    iteration: i,
                    memory,
                    plannedActions: planActions,
                    results,
                    perception: perceptionAfter,
                    screenshotBase64: reflectionScreenshotBase64,
                    retries: maxReflectRetries,
                    maxHistoryMessages,
                });
            }

            iterations.push({
                iteration: i,
                plannedActions: planActions,
                results,
                reflection,
            });

            lastMessage = reflection.message;
            memory = buildMemoryUpdate(memory, i, reflection, results);
            if (reflection.done) {
                if (!verifyOnDone) {
                    return { ok: reflection.success, message: reflection.message, iterations };
                }

                const verifyPerception = includePerception ? await getDesktopPerception().catch(() => null) : null;
                const verifyScreenshotBase64 = (await operator.screenshot().catch(() => null))?.screenshotBase64;

                const heuristic = heuristicVerifyFromPerception(task, verifyPerception);
                if (heuristic) {
                    iterations[iterations.length - 1].verification = heuristic;
                    memory = buildMemoryUpdate(memory, i, reflection, results, heuristic);
                    lastMessage = `Verification did not confirm completion: ${heuristic.message}`;
                    continue;
                }

                const verification = await this.verifyOnce(conversation, {
                    task,
                    iteration: i,
                    memory,
                    plannedActions: planActions,
                    results,
                    perception: verifyPerception,
                    screenshotBase64: verifyScreenshotBase64,
                    retries: maxVerifyRetries,
                    maxHistoryMessages,
                });

                iterations[iterations.length - 1].verification = verification;
                memory = buildMemoryUpdate(memory, i, reflection, results, verification);

                if (verification.done) {
                    return { ok: verification.success, message: verification.message, iterations };
                }

                lastMessage = `Verification did not confirm completion: ${verification.message}`;
                // Continue iterating; don't stop on an unverified "done".
            }

            if (reflection.nextActions.length > 0) {
                const moreResults = await operator.execute(reflection.nextActions);

                let perceptionAfterNext = includePerception ? await getDesktopPerception() : null;
                let followUpScreenshotBase64: string | undefined = undefined;

                let followUp = await this.reflectOnce(conversation, {
                    task,
                    iteration: i,
                    memory,
                    plannedActions: reflection.nextActions,
                    results: moreResults,
                    perception: perceptionAfterNext,
                    screenshotBase64: followUpScreenshotBase64,
                    retries: maxReflectRetries,
                    maxHistoryMessages,
                });

                for (let round = 0; round < maxToolRequestRounds && followUp.toolRequests.length > 0; round++) {
                    const toolData = await fulfillToolRequests(followUp.toolRequests, operator);
                    if (toolData.perception) perceptionAfterNext = toolData.perception;
                    if (toolData.screenshotBase64) followUpScreenshotBase64 = toolData.screenshotBase64;

                    followUp = await this.reflectOnce(conversation, {
                        task,
                        iteration: i,
                        memory,
                        plannedActions: reflection.nextActions,
                        results: moreResults,
                        perception: perceptionAfterNext,
                        screenshotBase64: followUpScreenshotBase64,
                        retries: maxReflectRetries,
                        maxHistoryMessages,
                    });
                }

                iterations.push({
                    iteration: i,
                    plannedActions: reflection.nextActions,
                    results: moreResults,
                    reflection: followUp,
                });

                lastMessage = followUp.message;
                memory = buildMemoryUpdate(memory, i, followUp, moreResults);
                if (followUp.done) {
                    if (!verifyOnDone) {
                        return { ok: followUp.success, message: followUp.message, iterations };
                    }

                    const verifyPerception = includePerception ? await getDesktopPerception().catch(() => null) : null;
                    const verifyScreenshotBase64 = (await operator.screenshot().catch(() => null))?.screenshotBase64;

                    const heuristic = heuristicVerifyFromPerception(task, verifyPerception);
                    if (heuristic) {
                        iterations[iterations.length - 1].verification = heuristic;
                        memory = buildMemoryUpdate(memory, i, followUp, moreResults, heuristic);
                        lastMessage = `Verification did not confirm completion: ${heuristic.message}`;
                        continue;
                    }

                    const verification = await this.verifyOnce(conversation, {
                        task,
                        iteration: i,
                        memory,
                        plannedActions: reflection.nextActions,
                        results: moreResults,
                        perception: verifyPerception,
                        screenshotBase64: verifyScreenshotBase64,
                        retries: maxVerifyRetries,
                        maxHistoryMessages,
                    });

                    iterations[iterations.length - 1].verification = verification;
                    memory = buildMemoryUpdate(memory, i, followUp, moreResults, verification);

                    if (verification.done) {
                        return { ok: verification.success, message: verification.message, iterations };
                    }

                    lastMessage = `Verification did not confirm completion: ${verification.message}`;
                }
            }
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
            retries: number;
            maxHistoryMessages: number;
        }
    ): Promise<PlanOutput> {
        let lastError: string | null = null;

        for (let attempt = 0; attempt <= input.retries; attempt++) {
            const perceptionText = input.perception ? formatPerception(input.perception) : 'Perception unavailable.';
            const promptForLlm = [
                buildPlanPrompt(input.task),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
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
                ...(input.screenshotBase64 ? ['', `Screenshot: <omitted base64 length=${input.screenshotBase64.length}>`] : []),
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
                const json = extractFirstJsonObject(result.content);
                const plan = assertPlanOutput(json);

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

    private async reflectOnce(
        conversation: LLMMessage[],
        input: {
            task: string;
            iteration: number;
            memory: string;
            plannedActions: DesktopAction[];
            results: ExecutionResult[];
            perception: DesktopPerception | null;
            screenshotBase64?: string;
            retries: number;
            maxHistoryMessages: number;
        }
    ): Promise<ReflectionOutput> {
        let lastError: string | null = null;

        const plannedActionsJson = JSON.stringify({ actions: input.plannedActions }, null, 2);
        const executionResultsJson = JSON.stringify(input.results, null, 2);
        const perceptionText = input.perception ? formatPerception(input.perception) : 'Perception unavailable.';

        for (let attempt = 0; attempt <= input.retries; attempt++) {
            const reflectPromptForLlm = [
                buildReflectPrompt({
                    task: input.task,
                    plannedActionsJson,
                    executionResultsJson,
                }),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
                ...(input.screenshotBase64 ? ['', 'Screenshot: (provided as image)'] : []),
            ].join('\n');

            const reflectPromptForHistory = [
                buildReflectPrompt({
                    task: input.task,
                    plannedActionsJson,
                    executionResultsJson,
                }),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
                ...(input.screenshotBase64 ? ['', `Screenshot: <omitted base64 length=${input.screenshotBase64.length}>`] : []),
            ].join('\n');

            const userContentParts: LLMContentPart[] = [{ type: 'text', text: reflectPromptForLlm }];
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
                const json = extractFirstJsonObject(result.content);
                const reflection = assertReflectionOutput(json);

                conversation.push({ role: 'user', content: reflectPromptForHistory });
                conversation.push({ role: 'assistant', content: result.content });
                trimConversation(conversation, input.maxHistoryMessages);

                return reflection;
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
            }
        }

        throw new Error(`Failed to get a valid reflection from LLM: ${lastError ?? 'unknown error'}`);
    }

    private async verifyOnce(
        conversation: LLMMessage[],
        input: {
            task: string;
            iteration: number;
            memory: string;
            plannedActions: DesktopAction[];
            results: ExecutionResult[];
            perception: DesktopPerception | null;
            screenshotBase64?: string;
            retries: number;
            maxHistoryMessages: number;
        }
    ): Promise<VerificationOutput> {
        let lastError: string | null = null;
        let screenshotBase64: string | undefined = input.screenshotBase64;

        const plannedActionsJson = JSON.stringify({ actions: input.plannedActions }, null, 2);
        const executionResultsJson = JSON.stringify(input.results, null, 2);
        const perceptionText = input.perception ? formatPerception(input.perception) : 'Perception unavailable.';

        for (let attempt = 0; attempt <= input.retries; attempt++) {
            const verifyPromptText = [
                buildVerifyPrompt({
                    task: input.task,
                    plannedActionsJson,
                    executionResultsJson,
                }),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
                ...(screenshotBase64 ? ['', 'Screenshot: (provided as image)'] : []),
            ].join('\n');

            const verifyPromptForHistory = [
                buildVerifyPrompt({
                    task: input.task,
                    plannedActionsJson,
                    executionResultsJson,
                }),
                '',
                `Iteration: ${input.iteration}`,
                'Short-term memory:',
                input.memory,
                '',
                'Perception:',
                perceptionText,
                ...(screenshotBase64 ? ['', `Screenshot: <omitted base64 length=${screenshotBase64.length}>`] : []),
            ].join('\n');

            const userContentParts: LLMContentPart[] = [{ type: 'text', text: verifyPromptText }];
            if (screenshotBase64) {
                userContentParts.push({
                    type: 'image_url',
                    image_url: { url: `data:image/png;base64,${screenshotBase64}` },
                });
            }

            const messages: LLMMessage[] = [
                ...conversation,
                { role: 'user', content: userContentParts },
                ...(lastError
                    ? [{ role: 'user' as const, content: `Your previous output was invalid: ${lastError}. Output ONLY the correct JSON.` }]
                    : []),
            ];

            let result: { content: string };
            try {
                result = await this.llm.chat(messages);
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                // If the model or endpoint rejects image inputs, retry without the screenshot.
                if (screenshotBase64) {
                    screenshotBase64 = undefined;
                    continue;
                }
                continue;
            }
            try {
                const json = extractFirstJsonObject(result.content);
                const verification = assertVerificationOutput(json);

                conversation.push({ role: 'user', content: verifyPromptForHistory });
                conversation.push({ role: 'assistant', content: result.content });
                trimConversation(conversation, input.maxHistoryMessages);

                return verification;
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
            }
        }

        throw new Error(`Failed to get a valid verification from LLM: ${lastError ?? 'unknown error'}`);
    }
}

async function fulfillToolRequests(
    requests: ToolRequest[],
    operator: DesktopOperator
): Promise<{ perception: DesktopPerception | null; screenshotBase64?: string }> {
    const needPerception = requests.some((r) => r.type === 'perception');
    const needScreenshotExplicit = requests.some((r) => r.type === 'screenshot');

    // Perception only contains window titles, not UI coordinates. If the model asks for perception
    // to locate a button/position, capture a screenshot too so it can infer click coordinates.
    const combinedReason = requests.map((r) => r.reason ?? '').join(' ').toLowerCase();
    const impliedNeedScreenshot =
        needPerception &&
        !needScreenshotExplicit &&
        /(coordinate|coordinates|coord|position|locate|location|where|button|click|play|pause)/i.test(combinedReason);

    const needScreenshot = needScreenshotExplicit || impliedNeedScreenshot;

    const perception = needPerception ? await getDesktopPerception().catch(() => null) : null;
    const screenshotBase64 = needScreenshot ? (await operator.screenshot().catch(() => null))?.screenshotBase64 : undefined;

    return { perception, screenshotBase64 };
}

function trimConversation(conversation: LLMMessage[], maxMessages: number): void {
    // Keep the first system message, drop older context beyond maxMessages.
    if (conversation.length <= maxMessages) return;
    const system = conversation[0];
    const tail = conversation.slice(-Math.max(maxMessages - 1, 1));
    conversation.length = 0;
    conversation.push(system, ...tail);
}

function formatPerception(p: DesktopPerception): string {
    const maxTitles = 12;
    const maxTitleLen = 90;
    const titles = p.windowTitles
        .slice(0, maxTitles)
        .map((t) => (t.length > maxTitleLen ? `${t.slice(0, maxTitleLen - 1)}…` : t));

    const active = p.activeWindowTitle
        ? p.activeWindowTitle.length > maxTitleLen
            ? `${p.activeWindowTitle.slice(0, maxTitleLen - 1)}…`
            : p.activeWindowTitle
        : null;

    return [
        `Time: ${p.timestamp}`,
        `Active window: ${active ?? 'unknown'}`,
        `Open windows (top ${titles.length}): ${titles.join(' | ') || 'none'}`,
    ].join('\n');
}

function buildMemoryUpdate(
    prev: string,
    iteration: number,
    reflection: ReflectionOutput,
    results: ExecutionResult[],
    verification?: VerificationOutput
): string {
    const { okCount, failCount, firstError } = summarizeResults(results);
    const verifyText = verification
        ? ` verifyDone=${verification.done} verifySuccess=${verification.success} verifyMsg=${verification.message}`
        : '';
    const line = `Iter ${iteration}: done=${reflection.done} success=${reflection.success} ok=${okCount} fail=${failCount}${firstError ? ` firstError=${firstError}` : ''}${verifyText} msg=${reflection.message}`;
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

function heuristicVerifyFromPerception(task: string, perception: DesktopPerception | null): VerificationOutput | null {
    if (!perception) return null;

    const expectedTokens = extractExpectedWindowTokens(task);
    if (expectedTokens.length === 0) return null;

    const haystack = [perception.activeWindowTitle ?? '', ...perception.windowTitles].join(' | ').toLowerCase();
    for (const token of expectedTokens) {
        if (!haystack.includes(token.toLowerCase())) {
            return {
                done: false,
                success: false,
                message: `Expected to see a window containing "${token}" but it was not present in the open window titles.`,
                evidence: `Active: ${perception.activeWindowTitle ?? 'unknown'}; Open: ${perception.windowTitles.slice(0, 12).join(' | ')}`,
                confidence: 0.8,
            };
        }
    }

    return null;
}

function extractExpectedWindowTokens(task: string): string[] {
    // Heuristic: if a task mentions a workbook or common app, we expect it to appear in window titles.
    const tokens: string[] = [];

    const xlsxMatches = task.match(/([A-Za-z]:\\[^\s"']+?\.xlsx|[^\s"']+?\.xlsx)/gi) ?? [];
    for (const m of xlsxMatches) {
        const base = m.split('\\').pop() ?? m;
        if (base && !tokens.includes(base)) tokens.push(base);
    }

    return tokens.slice(0, 3);
}

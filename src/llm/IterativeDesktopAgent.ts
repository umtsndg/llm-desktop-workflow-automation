import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction, ExecutionResult } from '../desktop/action-types';
import { getDesktopPerception, type DesktopPerception } from '../desktop/perception';
import { formatCandidatesForPrompt, isUiCandidateProvider, type UiCandidate } from '../desktop/ui-candidates';

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

    private lastCandidates: UiCandidate[] | null = null;
    private lastCandidatesWindowTitle: string | null = null;
    private candidatesTextOverrideOnce: string | null = null;

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

            let candidatesText: string | undefined;
            if (this.candidatesTextOverrideOnce) {
                candidatesText = this.candidatesTextOverrideOnce;
                this.candidatesTextOverrideOnce = null;
                try {
                    const lines = candidatesText ? candidatesText.split(/\r?\n/).length : 0;
                    console.error(`[CANDIDATES] using override for iteration ${i} lines=${lines}`);
                } catch {
                    // ignore logging issues
                }
            } else {
                candidatesText = await this.getCandidatesText(task, operator, perceptionBefore).catch(() => undefined);
            }

            const plan = await this.planOnce(conversation, {
                task,
                iteration: i,
                memory,
                perception: perceptionBefore,
                candidatesText,
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

            // If the planner returns no actions, it is explicitly signaling that
            // the goal appears complete (per prompt contract). Treat as success.
            const planActions = plan.actions.slice(0, 1);
            if (planActions.length === 0) {
                const msg = `Completed after ${i - 1} iteration(s): planner returned no further actions.`;
                return { ok: true, message: msg, iterations };
            }

            const primaryAction = planActions[0]!;

            // Special internal action: allow the LLM to request a filtered UI candidate list
            // by query, then continue planning in the next iteration with that filtered list.
            if (primaryAction.type === 'findCandidates') {
                const result = await this.handleFindCandidates(primaryAction, operator, task, perceptionBefore);

                // Treat as a successful iteration step (no desktop action executed).
                lastExecutedAction = primaryAction;
                iterations.push({
                    iteration: i,
                    plannedActions: [primaryAction],
                    results: [result],
                });

                lastMessage = `Last action: ${JSON.stringify(primaryAction ?? {})}`;
                memory = buildMemoryUpdate(memory, i, [result], lastMessage);
                continue;
            }

            const rewrittenAction = this.rewriteActionWithCandidates(primaryAction);
            const actionsToExecute: DesktopAction[] = [rewrittenAction];

            if (primaryAction.type === 'typeText') {
                await focusExpectedWindowForEvidence(task, operator);
            }

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
                plannedActions: actionsToExecute,
                results,
            });

            lastMessage = `Last action: ${JSON.stringify(rewrittenAction ?? {})}`;
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
            candidatesText?: string;
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
                ...(input.candidatesText ? ['', 'UI candidates (choose by id using clickCandidate):', input.candidatesText] : []),
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
                ...(input.candidatesText ? ['', 'UI candidates (choose by id using clickCandidate):', input.candidatesText] : []),
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

                // Hard policy: when UI candidates are provided, the LLM MUST NOT use uiClick or click.
                // It must select by id using clickCandidate for any click interactions.
                if (input.candidatesText) {
                    const bad = plan.actions.find((a) => a.type === 'uiClick' || a.type === 'click');
                    if (bad) {
                        throw new Error(
                            `When UI candidates are provided, do NOT use ${bad.type}. Use clickCandidate with a valid candidate id instead.`
                        );
                    }
                }

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

    private async getCandidatesText(task: string, operator: DesktopOperator, perception: DesktopPerception | null): Promise<string | undefined> {
        if (!isUiCandidateProvider(operator)) {
            try {
                console.error('[CANDIDATES] sent=false reason="operator does not support UI candidates"');
            } catch {
                // ignore logging issues
            }
            return undefined;
        }

        const activeTitle = perception?.activeWindowTitle?.trim();
        const expectedTitle = inferExpectedWindowTitleFromTask(task);

        const isBad = (t: string) => /powershell|windows terminal|cmd\.exe|command prompt|visual studio code/i.test(t);
        const isGarbled = (t: string) => /\uFFFD|�/.test(t) || /[\u0000-\u001f]/.test(t);

        const titlesToTry = [activeTitle, expectedTitle]
            .map((t) => (t ?? '').trim())
            .filter((t) => t.length >= 2 && !isBad(t) && !isGarbled(t))
            .filter((t, idx, arr) => arr.indexOf(t) === idx);

        if (titlesToTry.length === 0) {
            try {
                console.error('[CANDIDATES] sent=false reason="no suitable window title"');
            } catch {
                // ignore logging issues
            }
            this.lastCandidates = null;
            this.lastCandidatesWindowTitle = null;
            return undefined;
        }

        const promptLimit = 60;
        const fetchLimit = 200;

        for (const title of titlesToTry) {
            let candidatesError: string | undefined;
            const candidates = await operator
                .listUiCandidates({ windowTitle: title, match: 'contains', limit: fetchLimit })
                .catch((e) => {
                    candidatesError = e instanceof Error ? e.message : String(e);
                    return [];
                });

            const sent = candidates.length > 0;
            try {
                const base = `[CANDIDATES] sent=${sent} windowTitle=${JSON.stringify(title)} count=${candidates.length}`;
                if (sent) {
                    console.error(base);
                } else {
                    const reason = candidatesError
                        ? `error=${JSON.stringify(candidatesError)}`
                        : titlesToTry.length > 1
                            ? 'reason="no candidates found (will try fallback title)"'
                            : 'reason="no candidates found"';
                    console.error(`${base} ${reason}`);
                }
            } catch {
                // ignore logging issues
            }

            if (!sent) continue;

            this.lastCandidates = candidates;
            this.lastCandidatesWindowTitle = title;

            // Print ALL candidates to stderr for debugging (bounded by fetchLimit).
            try {
                console.error(`[CANDIDATES] list windowTitle=${JSON.stringify(title)} count=${candidates.length}`);
                console.error(formatCandidatesForPrompt(candidates, candidates.length));
            } catch {
                // ignore logging issues
            }

            // Only send a smaller, RE-RANKED slice to the LLM to avoid excessive prompt size.
            // Prioritize visible+enabled+typeable inputs (e.g. To/Subject/Body fields) so they
            // appear early even if the window has lots of header/ribbon buttons.
            const rankedForPrompt = rankCandidatesForPrompt(candidates);

            return formatCandidatesForPrompt(rankedForPrompt, promptLimit);
        }

        this.lastCandidates = null;
        this.lastCandidatesWindowTitle = null;
        return undefined;
    }

    private rewriteActionWithCandidates(action: DesktopAction): DesktopAction {
        const candidates = this.lastCandidates;
        if (!candidates || candidates.length === 0) return action;

        if (action.type === 'click') {
            const pt = this.extractClickPoint(action);
            if (!pt) return action;

            const mapped = mapPointToCandidateId(pt.x, pt.y, candidates);
            if (mapped == null) return action;

            try {
                console.error(
                    `[CANDIDATES] rewrite click->clickCandidate id=${mapped} ` +
                    `pt=[${pt.x},${pt.y}]` +
                    (this.lastCandidatesWindowTitle ? ` candidatesWindowTitle=${JSON.stringify(this.lastCandidatesWindowTitle)}` : '')
                );
            } catch {
                // ignore logging issues
            }

            return { type: 'clickCandidate', id: mapped, button: action.button ?? 'left', hint: action.hint };
        }

        if (action.type !== 'uiClick') return action;

        const targetName = (action.controlName ?? '').trim();
        if (!targetName) return action;

        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
        const t = norm(targetName);
        const wantText = Boolean(action.wantToText) || action.intent === 'Text';

        let best: { id: number; score: number } | null = null;

        for (const c of candidates) {
            const text = norm(c.text ?? '');
            const autoId = norm(c.automationId ?? '');
            const role = norm(c.role ?? '');

            let score = 0;

            if (action.automationId && autoId && autoId === norm(action.automationId)) score += 12;

            if (text) {
                if (text === t) score += 10;
                else if (text.includes(t)) score += 7;
                else if (t.includes(text)) score += 4;
            }

            if (wantText) {
                if (c.typeable) score += 6;
                if (role.includes('edit') || role.includes('document')) score += 2;
            } else if (action.intent === 'Button') {
                if (c.clickable) score += 3;
                if (role.includes('button') || role.includes('menuitem') || role.includes('splitbutton')) score += 2;
            }

            if (c.visible) score += 1;
            if (c.enabled) score += 1;

            if (!best || score > best.score) best = { id: c.id, score };
        }

        // Threshold tuned to avoid accidental clicks when text is very short/ambiguous.
        const minScore = wantText ? 10 : 9;
        if (best && best.score >= minScore) {
            try {
                console.error(
                    `[CANDIDATES] rewrite uiClick->clickCandidate id=${best.id} score=${best.score} ` +
                    `controlName=${JSON.stringify(action.controlName)} windowTitle=${JSON.stringify(action.windowTitle)} ` +
                    (this.lastCandidatesWindowTitle ? `candidatesWindowTitle=${JSON.stringify(this.lastCandidatesWindowTitle)}` : '')
                );
            } catch {
                // ignore logging issues
            }
            return { type: 'clickCandidate', id: best.id, button: 'left', hint: action.hint };
        }

        try {
            console.error(
                `[CANDIDATES] no match for uiClick controlName=${JSON.stringify(action.controlName)} ` +
                (this.lastCandidatesWindowTitle ? `candidatesWindowTitle=${JSON.stringify(this.lastCandidatesWindowTitle)}` : '')
            );
        } catch {
            // ignore logging issues
        }

        return action;
    }

    private extractClickPoint(action: Extract<DesktopAction, { type: 'click' }>): { x: number; y: number } | null {
        if (typeof action.x === 'number' && typeof action.y === 'number') {
            if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
                return { x: Math.round(action.x), y: Math.round(action.y) };
            }
        }

        // If the click is normalized, we can't reliably map without a screen size;
        // skip rewriting in that case.
        return null;
    }

    private async handleFindCandidates(
        action: Extract<DesktopAction, { type: 'findCandidates' }>,
        operator: DesktopOperator,
        task: string,
        perception: DesktopPerception | null
    ): Promise<ExecutionResult> {
        if (!isUiCandidateProvider(operator)) {
            this.candidatesTextOverrideOnce = null;
            return {
                ok: false,
                action,
                error: 'operator does not support UI candidates',
                executedAt: new Date().toISOString(),
            };
        }

        const query = (action.query ?? '').trim();
        if (!query) {
            this.candidatesTextOverrideOnce = null;
            return {
                ok: false,
                action,
                error: 'findCandidates.query was empty',
                executedAt: new Date().toISOString(),
            };
        }

        const activeTitle = perception?.activeWindowTitle?.trim();
        const expectedTitle = inferExpectedWindowTitleFromTask(task);
        const isBad = (t: string) => /powershell|windows terminal|cmd\.exe|command prompt|visual studio code/i.test(t);
        const isGarbled = (t: string) => /\uFFFD|�/.test(t) || /[\u0000-\u001f]/.test(t);

        const titlesToTry = [this.lastCandidatesWindowTitle, activeTitle, expectedTitle]
            .map((t) => (t ?? '').trim())
            .filter((t) => t.length >= 2 && !isBad(t) && !isGarbled(t))
            .filter((t, idx, arr) => arr.indexOf(t) === idx);

        if (titlesToTry.length === 0) {
            this.candidatesTextOverrideOnce = null;
            return {
                ok: false,
                action,
                error: 'No suitable window title for candidate search',
                executedAt: new Date().toISOString(),
            };
        }

        const hardFetchLimit = 400;
        // Always fetch a large pool so the query can find elements that aren't
        // in the top N by ranking. 'limit' controls how many matches we SEND.
        const fetchLimit = hardFetchLimit;

        const hardSendLimit = 250;
        const requestedSendLimit =
            typeof action.limit === 'number' && Number.isFinite(action.limit)
                ? Math.max(1, Math.min(hardSendLimit, Math.floor(action.limit)))
                : hardSendLimit;

        let lastErr: string | undefined;
        for (const title of titlesToTry) {
            const candidates = await operator
                .listUiCandidates({ windowTitle: title, match: 'contains', limit: fetchLimit })
                .catch((e) => {
                    lastErr = e instanceof Error ? e.message : String(e);
                    return [];
                });

            if (!candidates.length) continue;

            this.lastCandidates = candidates;
            this.lastCandidatesWindowTitle = title;

            const filtered = filterCandidatesByQuery(candidates, query);
            if (!filtered.length) {
                this.candidatesTextOverrideOnce = null;
                return {
                    ok: false,
                    action,
                    error: `No candidates matched query ${JSON.stringify(query)} (searched ${candidates.length} candidates).`,
                    executedAt: new Date().toISOString(),
                };
            }

            const sliceLimit = Math.min(filtered.length, requestedSendLimit);
            this.candidatesTextOverrideOnce = formatCandidatesForPrompt(filtered, sliceLimit);

            try {
                console.error(
                    `[CANDIDATES] find query=${JSON.stringify(query)} windowTitle=${JSON.stringify(title)} ` +
                    `fetched=${candidates.length} matched=${filtered.length} sent=${sliceLimit}`
                );
                console.error(`[CANDIDATES] filtered list query=${JSON.stringify(query)} count=${filtered.length} (showing ${sliceLimit})`);
                console.error(this.candidatesTextOverrideOnce);
            } catch {
                // ignore logging issues
            }

            return {
                ok: true,
                action,
                executedAt: new Date().toISOString(),
            };
        }

        this.candidatesTextOverrideOnce = null;
        return {
            ok: false,
            action,
            error: lastErr ? `No candidates fetched: ${lastErr}` : 'No candidates fetched',
            executedAt: new Date().toISOString(),
        };
    }
}

function filterCandidatesByQuery(candidates: UiCandidate[], query: string): UiCandidate[] {
    const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!q) return [];

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isShort = q.length <= 3;
    const wordRe = isShort ? new RegExp(`\\b${escapeRegExp(q)}\\b`, 'i') : null;

    const stop = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'add', 'enter', 'type', 'set', 'write', 'click', 'focus']);
    const tokens = q
        .split(/\s+/g)
        .map((t) => t.replace(/[^a-z0-9]+/gi, '').toLowerCase())
        .filter((t) => t.length >= 2 && !stop.has(t));

    const tokenRes = tokens.map((t) => ({ t, re: new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i') }));

    return candidates.filter((c) => {
        // Search through NAME/TEXT ONLY (what we show as candidate.text).
        // This avoids matches from automationId/class/role/etc.
        const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) return false;

        if (isShort) {
            // For very short queries like "To", require whole-word match.
            return wordRe!.test(text);
        }

        // For longer, natural-language queries (e.g. "Add a subject"), match on meaningful tokens
        // against candidate text. This keeps us names-only while being robust to UI placeholders.
        if (tokenRes.length > 0) {
            return tokenRes.some(({ re }) => re.test(text));
        }

        return text.toLowerCase().includes(q);
    });
}

function rankCandidatesForPrompt(candidates: UiCandidate[]): UiCandidate[] {
    const withIndex = candidates.map((c, idx) => ({ c, idx }));
    const score = (c: UiCandidate): number[] => {
        // Lower tuple sorts earlier.
        // 0: visible+enabled+typeable, 1: visible+enabled+clickable, 2: visible+enabled+focusable,
        // 3: visible, 4: everything else.
        const bucket =
            c.visible && c.enabled && c.typeable
                ? 0
                : c.visible && c.enabled && c.clickable
                    ? 1
                    : c.visible && c.enabled
                        ? 2
                        : c.visible
                            ? 3
                            : 4;

        const hasText = (c.text ?? '').trim().length > 0 ? 0 : 1;
        const [x, y] = c.bbox;
        return [bucket, hasText, y, x];
    };

    withIndex.sort((a, b) => {
        const sa = score(a.c);
        const sb = score(b.c);
        for (let i = 0; i < sa.length; i++) {
            const d = sa[i]! - sb[i]!;
            if (d !== 0) return d;
        }
        return a.idx - b.idx;
    });

    return withIndex.map((x) => x.c);
}

function mapPointToCandidateId(x: number, y: number, candidates: UiCandidate[]): number | null {
    let bestInside: { id: number; area: number } | null = null;
    let bestNear: { id: number; dist2: number } | null = null;

    for (const c of candidates) {
        const [bx, by, bw, bh] = c.bbox;
        const inside = x >= bx && y >= by && x <= bx + bw && y <= by + bh;
        if (inside) {
            const area = Math.max(1, bw) * Math.max(1, bh);
            if (!bestInside || area < bestInside.area) bestInside = { id: c.id, area };
            continue;
        }

        const cx = bx + bw / 2;
        const cy = by + bh / 2;
        const dx = x - cx;
        const dy = y - cy;
        const dist2 = dx * dx + dy * dy;
        if (!bestNear || dist2 < bestNear.dist2) bestNear = { id: c.id, dist2 };
    }

    if (bestInside) return bestInside.id;

    // Only rewrite to "nearest" when close enough to avoid random snaps.
    // (Roughly within 60 px.)
    if (bestNear && bestNear.dist2 <= 60 * 60) return bestNear.id;

    return null;
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
    if (t.includes('outlook') || t.includes('email') || t.includes('e-mail') || t.includes('mail')) return 'Outlook';

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

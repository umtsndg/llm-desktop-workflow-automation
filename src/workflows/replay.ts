import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction } from '../desktop/action-types';
import { isUiCandidateProvider, type UiCandidate } from '../desktop/ui-candidates';

import type { RecordedWorkflow, RecordedStep, RecordedUiTarget } from './recorded-workflow';
import { parameterizeWorkflowForTask, type ParameterizationChange } from './workflow-parameters';

export type ReplayOptions = {
    // If true, prefer normalized pointer coordinates when available.
    robust?: boolean;
    // New task text used to fill replay parameters such as typed text,
    // launched app, launch args, and expected window title.
    task?: string;
};

export async function replayRecordedWorkflow(
    operator: DesktopOperator,
    workflow: RecordedWorkflow,
    options?: ReplayOptions
): Promise<{ ok: boolean; results: { step: RecordedStep; resultOk: boolean; error?: string }[]; failedStepIndex?: number; parameterization?: { changes: ParameterizationChange[] } }> {
    const robust = options?.robust ?? true;
    const parameterization = options?.task
        ? parameterizeWorkflowForTask(workflow, options.task)
        : undefined;
    const replayWorkflow = parameterization?.workflow ?? workflow;

    // Establish current screen dimensions for normalized coordinate conversion.
    const obs = await operator.screenshot().catch(() => null);
    const screenWidth = obs?.width ?? null;
    const screenHeight = obs?.height ?? null;

    const results: { step: RecordedStep; resultOk: boolean; error?: string }[] = [];

    const steps = robust ? applyReplaySafety(replayWorkflow.steps, replayWorkflow.expectedWindowTitle) : replayWorkflow.steps;
    let currentWindowTitle = replayWorkflow.expectedWindowTitle;

    for (const step of steps) {
        const action = robust
            ? await adaptActionForReplay(operator, step.action, step, screenWidth, screenHeight, currentWindowTitle)
            : step.action;
        const [r] = await operator.execute([action]);
        results.push({ step, resultOk: Boolean(r?.ok), ...(r?.error ? { error: r.error } : {}) });
        if (!r?.ok) {
            return { ok: false, results, failedStepIndex: step.index, ...(parameterization ? { parameterization: { changes: parameterization.changes } } : {}) };
        }
        if (action.type === 'focusWindow') {
            currentWindowTitle = action.title;
        } else if (action.type === 'launchApp' && !currentWindowTitle) {
            currentWindowTitle = action.command;
        }
    }

    return { ok: true, results, ...(parameterization ? { parameterization: { changes: parameterization.changes } } : {}) };
}

async function adaptActionForReplay(
    operator: DesktopOperator,
    action: DesktopAction,
    step: RecordedStep,
    screenWidth: number | null,
    screenHeight: number | null,
    expectedWindowTitle?: string
): Promise<DesktopAction> {
    const semanticClick = await resolveSemanticClick(operator, action, step, expectedWindowTitle);
    if (semanticClick) return semanticClick;

    return adaptActionForCurrentScreen(action, step, screenWidth, screenHeight);
}

function applyReplaySafety(steps: RecordedStep[], expectedWindowTitle?: string): RecordedStep[] {
    const out: RecordedStep[] = [];

    // If we have a known target window, focus it once up-front.
    if (expectedWindowTitle) {
        const action: DesktopAction = {
            type: 'focusWindow',
            title: expectedWindowTitle,
            match: 'contains',
            hint: 'Replay safety: focus expected window',
        };
        out.push({
            index: -1,
            action,
            result: { ok: true, action, executedAt: new Date().toISOString() },
            semantic: 'Replay safety: focus expected window',
            source: 'replaySafety',
        });
    }

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        out.push(step);

        // Safety: after launching, wait and focus if the recording didn't already.
        if (step.action.type === 'launchApp') {
            const next = steps[i + 1];
            if (!next || next.action.type !== 'wait') {
                const action: DesktopAction = { type: 'wait', ms: 1200, hint: 'Replay safety: wait after launch' };
                out.push({
                    index: step.index + 0.1,
                    action,
                    result: { ok: true, action, executedAt: new Date().toISOString() },
                    semantic: 'Replay safety: wait after launch',
                    source: 'replaySafety',
                });
            }

            if (expectedWindowTitle) {
                const upcoming = steps.slice(i + 1, i + 5).some((s) => s.action.type === 'focusWindow');
                if (!upcoming) {
                    const action: DesktopAction = {
                        type: 'focusWindow',
                        title: expectedWindowTitle,
                        match: 'contains',
                        hint: 'Replay safety: focus after launch',
                    };
                    out.push({
                        index: step.index + 0.2,
                        action,
                        result: { ok: true, action, executedAt: new Date().toISOString() },
                        semantic: 'Replay safety: focus after launch',
                        source: 'replaySafety',
                    });
                }
            }
        }
    }

    // Re-number indexes for readability.
    return out.map((s, i) => ({ ...s, index: i }));
}

function adaptActionForCurrentScreen(
    action: DesktopAction,
    step: RecordedStep,
    screenWidth: number | null,
    screenHeight: number | null
): DesktopAction {
    // Only coordinate-based clicks need adaptation.
    if (action.type !== 'click') return action;

    // If we don't know the current screen size, we can't safely normalize.
    if (typeof screenWidth !== 'number' || typeof screenHeight !== 'number' || screenWidth <= 0 || screenHeight <= 0) {
        return action;
    }

    const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

    const normalized = step.pointer?.normalized;
    if (normalized && typeof normalized.x === 'number' && typeof normalized.y === 'number') {
        // Prefer recorded normalized coordinates (0..1). NutJsDesktopOperator
        // will resolve these to absolute pixels using the current screen size.
        return {
            ...action,
            x: undefined,
            y: undefined,
            nx: clamp01(normalized.x),
            ny: clamp01(normalized.y),
        };
    }

    const raw = step.pointer?.raw;
    const ref = step.pointer?.reference;
    if (
        raw &&
        typeof raw.x === 'number' &&
        typeof raw.y === 'number' &&
        ref &&
        typeof ref.screenWidth === 'number' &&
        typeof ref.screenHeight === 'number' &&
        ref.screenWidth > 0 &&
        ref.screenHeight > 0
    ) {
        // Fallback: compute normalized coords from record-time raw pixels and
        // record-time screen reference.
        return {
            ...action,
            x: undefined,
            y: undefined,
            nx: clamp01(raw.x / ref.screenWidth),
            ny: clamp01(raw.y / ref.screenHeight),
        };
    }

    return action;
}

async function resolveSemanticClick(
    operator: DesktopOperator,
    action: DesktopAction,
    step: RecordedStep,
    expectedWindowTitle?: string
): Promise<DesktopAction | null> {
    if (action.type !== 'click' && action.type !== 'clickCandidate') return null;
    if (!isUiCandidateProvider(operator)) return null;

    const target = step.uiTarget ?? inferUiTargetFromClick(action, step);
    if (!target) return null;

    const titlesToTry = [target.windowTitle, expectedWindowTitle]
        .map((t) => (t ?? '').trim())
        .filter((t) => t.length >= 2)
        .filter((t, idx, arr) => arr.indexOf(t) === idx);

    if (titlesToTry.length === 0) return null;

    for (const title of titlesToTry) {
        const candidates = await operator
            .listUiCandidates({ windowTitle: title, match: 'contains', limit: 400 })
            .catch(() => []);
        if (!candidates.length) continue;

        const best = bestCandidateForTarget(target, candidates);
        if (!best) continue;

        return {
            type: 'clickCandidate',
            id: best.id,
            button: action.button ?? 'left',
            hint: action.hint ?? step.semantic ?? target.query ?? target.text,
        };
    }

    return null;
}

function inferUiTargetFromClick(action: DesktopAction, step: RecordedStep): RecordedUiTarget | null {
    const hint = action.hint ?? step.semantic ?? '';
    const normalized = hint.toLowerCase();
    if (!normalized) return null;

    if (/\b(text|editor|edit|body|message|input|field|compose)\b/.test(normalized)) {
        return {
            query: normalized.includes('body') || normalized.includes('message') ? 'body' : 'text',
            typeable: true,
        };
    }

    const clickMatch = hint.match(/\b(?:click|press|select|open)\s+(.+)$/i);
    const query = clickMatch?.[1]?.replace(/\s+(?:button|field|input|control)$/i, '').trim();
    if (query && query.length >= 2 && query.length <= 80) {
        return { query, clickable: true };
    }

    return null;
}

function bestCandidateForTarget(target: RecordedUiTarget, candidates: UiCandidate[]): UiCandidate | null {
    let best: { candidate: UiCandidate; score: number } | null = null;

    for (const candidate of candidates) {
        const score = scoreCandidate(target, candidate);
        if (score <= 0) continue;
        if (!best || score > best.score) best = { candidate, score };
    }

    const minScore = target.typeable ? 5 : target.text || target.query || target.automationId ? 7 : 5;
    return best && best.score >= minScore ? best.candidate : null;
}

function scoreCandidate(target: RecordedUiTarget, candidate: UiCandidate): number {
    let score = 0;

    const text = normalize(candidate.text);
    const role = normalize(candidate.role);
    const automationId = normalize(candidate.automationId);
    const className = normalize(candidate.className);
    const controlType = normalize(candidate.controlType);

    if (candidate.visible) score += 1;
    if (candidate.enabled) score += 1;

    if (target.typeable) {
        if (candidate.typeable) score += 8;
        if (roleIncludesText(role) || roleIncludesText(controlType)) score += 3;
    }

    if (target.clickable) {
        if (candidate.clickable) score += 4;
    }

    if (target.automationId && automationId) {
        score += automationId === normalize(target.automationId) ? 16 : 0;
    }

    if (target.className && className) {
        score += className === normalize(target.className) ? 5 : 0;
    }

    if (target.controlType && controlType) {
        score += controlType === normalize(target.controlType) ? 5 : 0;
    }

    if (target.role && role) {
        const targetRole = normalize(target.role);
        if (role === targetRole) score += 6;
        else if (role.includes(targetRole) || targetRole.includes(role)) score += 3;
    }

    for (const query of targetQueries(target)) {
        const q = normalize(query);
        if (!q) continue;

        if (text) {
            if (text === q) score += 14;
            else if (isWholeWordMatch(text, q)) score += q.length <= 3 ? 12 : 9;
            else if (text.includes(q) || q.includes(text)) score += 6;
        }

        if (role && role.includes(q)) score += 3;
        if (controlType && controlType.includes(q)) score += 3;
    }

    return score;
}

function targetQueries(target: RecordedUiTarget): string[] {
    const base = [target.query, target.text].filter((q): q is string => Boolean(q && q.trim()));
    const out = [...base];
    const joined = base.join(' ').toLowerCase();

    if (target.typeable || /\b(text|editor|edit|body|message|compose|input|field)\b/.test(joined)) {
        out.push('text', 'edit', 'editor', 'body', 'message', 'document');
    }

    return out.filter((q, idx, arr) => arr.findIndex((x) => normalize(x) === normalize(q)) === idx);
}

function normalize(input?: string): string {
    return (input ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function roleIncludesText(input: string): boolean {
    return /\b(edit|text|document|textfield|textarea)\b/.test(input);
}

function isWholeWordMatch(text: string, query: string): boolean {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

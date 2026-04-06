import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction } from '../desktop/action-types';

import type { RecordedWorkflow, RecordedStep } from './recorded-workflow';

export type ReplayOptions = {
    // If true, prefer normalized pointer coordinates when available.
    robust?: boolean;
};

export async function replayRecordedWorkflow(
    operator: DesktopOperator,
    workflow: RecordedWorkflow,
    options?: ReplayOptions
): Promise<{ ok: boolean; results: { step: RecordedStep; resultOk: boolean }[] }> {
    const robust = options?.robust ?? true;

    // Establish current screen dimensions for normalized coordinate conversion.
    const obs = await operator.screenshot().catch(() => null);
    const screenWidth = obs?.width ?? null;
    const screenHeight = obs?.height ?? null;

    const results: { step: RecordedStep; resultOk: boolean }[] = [];

    const steps = robust ? applyReplaySafety(workflow.steps, workflow.expectedWindowTitle) : workflow.steps;

    for (const step of steps) {
        const action = robust ? adaptActionForCurrentScreen(step.action, step, screenWidth, screenHeight) : step.action;
        const [r] = await operator.execute([action]);
        results.push({ step, resultOk: Boolean(r?.ok) });
        if (!r?.ok) {
            return { ok: false, results };
        }
    }

    return { ok: true, results };
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

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
    return action;
}

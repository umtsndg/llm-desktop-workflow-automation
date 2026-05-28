import type { DesktopAction } from '../desktop/action-types';

import type { RecordedStep, RecordedWorkflow, RecordedWorkflowParameter, RecordedWorkflowPrecondition } from './recorded-workflow';
import {
    commandForApp,
    detectPrimaryApp,
    inferAppContext,
    inferExpectedWindowTitle,
    windowTitleForApp,
    type DesktopPlatform,
    type KnownApp,
} from './workflow-intent';

export function finalizeRecordedWorkflow(
    workflow: RecordedWorkflow,
    options?: { platform?: DesktopPlatform }
): RecordedWorkflow {
    const platform = options?.platform ?? process.platform;
    const app = detectPrimaryApp(workflow.task);
    const appContext = inferAppContext(workflow.task);
    const expectedWindowTitle = app ? inferExpectedWindowTitle(workflow.task, app, platform) ?? undefined : workflow.expectedWindowTitle;

    let steps: RecordedStep[] = workflow.steps.map((step) => ({
        ...step,
        source: step.source ?? ('recorded' as const),
        context: inferStepContext(step),
    }));

    const preconditions: RecordedWorkflowPrecondition[] = [];
    if (app && expectedWindowTitle && shouldInsertSetup(workflow.task, steps, app, platform)) {
        const setup = buildSetupSteps(app, platform, expectedWindowTitle, workflow.startedAt);
        steps = [...setup, ...steps];
        preconditions.push(
            { kind: 'app_open', app: commandForApp(app, platform), source: 'inferred' },
            { kind: 'window_focused', windowTitle: expectedWindowTitle, source: 'inferred' }
        );
    }

    steps = taskImpliesRepetition(workflow.task) ? steps : collapseAdjacentDuplicates(steps);
    steps = reindexSteps(steps);

    const parameters = extractParameters(steps, workflow.expectedWindowTitle ?? expectedWindowTitle);

    return {
        ...workflow,
        expectedWindowTitle: workflow.expectedWindowTitle ?? expectedWindowTitle,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(preconditions.length > 0 ? { preconditions } : {}),
        ...(appContext ? { appContext } : {}),
        steps,
    };
}

function shouldInsertSetup(task: string, steps: RecordedStep[], app: KnownApp, platform: DesktopPlatform): boolean {
    if (!/\b(open|launch|start)\b/i.test(task)) return false;
    const firstAppStepIndex = steps.findIndex((step) => stepTargetsApp(step, app, platform));
    if (firstAppStepIndex < 0) return false;
    return !steps.slice(0, firstAppStepIndex + 1).some((step) => step.action.type === 'launchApp' || step.action.type === 'focusWindow');
}

function buildSetupSteps(app: KnownApp, platform: DesktopPlatform, expectedWindowTitle: string, executedAt: string): RecordedStep[] {
    const launch: DesktopAction = {
        type: 'launchApp',
        command: commandForApp(app, platform),
        mode: 'search',
        hint: 'Finalizer: launch expected app',
    };
    const wait: DesktopAction = { type: 'wait', ms: 1200, hint: 'Finalizer: wait after launch' };
    const focus: DesktopAction = {
        type: 'focusWindow',
        title: expectedWindowTitle,
        match: 'contains',
        hint: 'Finalizer: focus expected window',
    };

    return [launch, wait, focus].map((action, index) => ({
        index,
        action,
        result: { ok: true, action, executedAt },
        semantic: semanticForAction(action),
        source: 'finalizer' as const,
    }));
}

function stepTargetsApp(step: RecordedStep, app: KnownApp, platform: DesktopPlatform): boolean {
    const candidates = [
        commandForApp(app, platform),
        windowTitleForApp(app, platform),
        commandForApp(app, 'win32'),
        commandForApp(app, 'darwin'),
        windowTitleForApp(app, 'win32'),
        windowTitleForApp(app, 'darwin'),
        app,
    ]
        .map((value) => normalize(String(value)))
        .filter(Boolean);

    const text = normalize([
        step.semantic,
        step.action.hint,
        step.uiTarget?.windowTitle,
        step.uiTarget?.text,
        step.uiTarget?.query,
        step.action.type === 'launchApp' ? step.action.command : undefined,
        step.action.type === 'focusWindow' ? step.action.title : undefined,
    ].filter(Boolean).join(' '));

    return candidates.some((candidate) => text.includes(candidate));
}

function collapseAdjacentDuplicates(steps: RecordedStep[]): RecordedStep[] {
    const out: RecordedStep[] = [];

    for (const step of steps) {
        const prev = out[out.length - 1];
        if (prev && areDuplicateSteps(prev, step)) continue;
        out.push(step);
    }

    return out;
}

function areDuplicateSteps(a: RecordedStep, b: RecordedStep): boolean {
    if (a.action.type !== b.action.type) return false;

    const semanticA = normalize(a.semantic ?? a.action.hint ?? '');
    const semanticB = normalize(b.semantic ?? b.action.hint ?? '');
    if (semanticA && semanticB && semanticA !== semanticB) return false;

    const targetA = stableTargetKey(a);
    const targetB = stableTargetKey(b);
    if (targetA || targetB) return targetA === targetB;

    return stableActionValue(a.action) === stableActionValue(b.action);
}

function stableTargetKey(step: RecordedStep): string | null {
    const target = step.uiTarget;
    if (!target) return null;
    return JSON.stringify({
        windowTitle: normalize(target.windowTitle),
        text: normalize(target.text),
        query: normalize(target.query),
        automationId: normalize(target.automationId),
        className: normalize(target.className),
        controlType: normalize(target.controlType),
        role: normalize(target.role),
    });
}

function stableActionValue(action: DesktopAction): string {
    switch (action.type) {
        case 'typeText':
            return action.text;
        case 'launchApp':
            return `${action.command}\u0000${(action.args ?? []).join('\u0000')}`;
        case 'focusWindow':
            return `${action.title}\u0000${action.match ?? ''}`;
        case 'click':
            return `${action.nx ?? ''}\u0000${action.ny ?? ''}\u0000${action.x ?? ''}\u0000${action.y ?? ''}\u0000${action.button ?? ''}`;
        case 'clickCandidate':
            return `${action.id}\u0000${action.button ?? ''}`;
        case 'wait':
            return String(action.ms);
        case 'pressKey':
        case 'releaseKey':
            return action.key;
        case 'hotkey':
            return action.keys.join('\u0000');
        case 'scroll':
            return `${action.direction ?? ''}\u0000${action.amount}`;
        case 'uiClick':
            return `${action.windowTitle}\u0000${action.controlName}\u0000${action.automationId ?? ''}`;
        case 'findCandidates':
            return `${action.query}\u0000${action.limit ?? ''}`;
    }
}

function taskImpliesRepetition(task: string): boolean {
    return /\b(twice|two|three|four|five|2|3|4|5|multiple|several)\b/i.test(task);
}

function reindexSteps(steps: RecordedStep[]): RecordedStep[] {
    return steps.map((step, index) => ({
        ...step,
        index,
        result: {
            ...step.result,
            action: step.action,
        },
    }));
}

function extractParameters(steps: RecordedStep[], expectedWindowTitle?: string): RecordedWorkflowParameter[] {
    const byKey = new Map<string, RecordedWorkflowParameter>();

    if (expectedWindowTitle) {
        addParameter(byKey, 'target_window', 'window', expectedWindowTitle, -1, 'expectedWindowTitle');
    }

    for (const step of steps) {
        const action = step.action;
        if (action.type === 'typeText') {
            addParameter(byKey, 'text_to_write', 'text', action.text, step.index, 'typeText.text');
        } else if (action.type === 'launchApp') {
            addParameter(byKey, 'target_app', 'app', action.command, step.index, 'launchApp.command');
            for (let i = 0; i < (action.args ?? []).length; i++) {
                addParameter(byKey, `launch_arg_${i + 1}`, 'value', action.args![i]!, step.index, `launchApp.args.${i}`);
            }
        } else if (action.type === 'focusWindow') {
            addParameter(byKey, 'target_window', 'window', action.title, step.index, 'focusWindow.title');
        }

        if (step.uiTarget?.windowTitle) {
            addParameter(byKey, 'target_window', 'window', step.uiTarget.windowTitle, step.index, 'uiTarget.windowTitle');
        }
        if (step.uiTarget?.query) {
            addParameter(byKey, parameterNameForUiTarget(step), 'value', step.uiTarget.query, step.index, 'uiTarget.query');
        }
        if (step.uiTarget?.text) {
            addParameter(byKey, parameterNameForUiTarget(step), 'value', step.uiTarget.text, step.index, 'uiTarget.text');
        }
    }

    return [...byKey.values()];
}

function addParameter(
    byKey: Map<string, RecordedWorkflowParameter>,
    name: string,
    kind: RecordedWorkflowParameter['kind'],
    value: string,
    stepIndex: number,
    field: string
): void {
    const originalValue = value.trim();
    if (!originalValue) return;

    const key = `${name}\u0000${originalValue}`;
    const existing = byKey.get(key);
    const usedBy = { stepIndex, field };
    if (existing) {
        if (!existing.usedBy.some((u) => u.stepIndex === stepIndex && u.field === field)) {
            existing.usedBy.push(usedBy);
        }
        return;
    }

    byKey.set(key, {
        name,
        kind,
        source: 'task',
        originalValue,
        usedBy: [usedBy],
    });
}

function parameterNameForUiTarget(step: RecordedStep): string {
    const targetText = normalize(`${step.uiTarget?.query ?? ''} ${step.uiTarget?.text ?? ''}`);
    if (/text|editor|edit|body|message|document/.test(targetText)) return 'text_field_target';
    if (/tab/.test(targetText)) return 'tab_target';
    return 'ui_target';
}

function inferStepContext(step: RecordedStep): RecordedStep['context'] | undefined {
    const target = normalize(`${step.semantic ?? ''} ${step.action.hint ?? ''} ${step.uiTarget?.text ?? ''} ${step.uiTarget?.query ?? ''}`);
    if (/\b(add|new|open)\b.*\btab\b|\btab\b.*\b(add|new|open)\b/.test(target)) {
        return { tabIntent: 'new_tab', target: 'newly_created' };
    }
    return step.context;
}

function semanticForAction(action: DesktopAction): string {
    switch (action.type) {
        case 'launchApp':
            return `Launch app: ${action.command}`;
        case 'focusWindow':
            return `Focus window: ${action.title}`;
        case 'wait':
            return `Wait ${action.ms}ms`;
        default:
            return action.hint ?? action.type;
    }
}

function normalize(input?: string): string {
    return (input ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

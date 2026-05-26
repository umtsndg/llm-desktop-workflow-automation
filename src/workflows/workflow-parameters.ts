import type { DesktopAction } from '../desktop/action-types';

import type { RecordedUiTarget, RecordedWorkflow } from './recorded-workflow';
import {
    commandForApp,
    detectAppFromLaunchCommand,
    detectPrimaryApp,
    inferExpectedWindowTitle,
    shouldReplaceLaunchCommand,
    shouldReplaceWindowTitle,
    type DesktopPlatform,
    type KnownApp,
} from './workflow-intent';

export type ParameterizationChange = {
    stepIndex: number;
    field:
        | 'typeText.text'
        | 'launchApp.command'
        | 'launchApp.args'
        | 'focusWindow.title'
        | 'expectedWindowTitle'
        | 'uiTarget.windowTitle'
        | 'uiTarget.query'
        | 'uiTarget.text';
    from: string;
    to: string;
};

export type ParameterizationResult = {
    workflow: RecordedWorkflow;
    changes: ParameterizationChange[];
};

export function parameterizeWorkflowForTask(
    workflow: RecordedWorkflow,
    task: string,
    options?: { platform?: DesktopPlatform }
): ParameterizationResult {
    const platform = options?.platform ?? process.platform;

    if (workflow.parameters && workflow.parameters.length > 0) {
        return parameterizeFromExplicitParameters(workflow, task, platform);
    }

    const originalTask = workflow.task;
    const changes: ParameterizationChange[] = [];

    const preferredApp = detectPrimaryApp(task);
    const launchCommand = preferredApp ? commandForApp(preferredApp, platform) : null;
    const windowTitle = inferExpectedWindowTitle(task, preferredApp, platform);

    let expectedWindowTitle = workflow.expectedWindowTitle;
    if (expectedWindowTitle && windowTitle && windowTitle !== expectedWindowTitle && shouldReplaceWindowTitle(expectedWindowTitle, task, preferredApp)) {
        changes.push({ stepIndex: -1, field: 'expectedWindowTitle', from: expectedWindowTitle, to: windowTitle });
        expectedWindowTitle = windowTitle;
    }

    const steps = workflow.steps.map((step) => {
        const context = {
            originalTask,
            task,
            preferredApp,
            launchCommand,
            windowTitle,
            platform,
            stepIndex: step.index,
            changes,
        };
        const action = parameterizeAction(step.action, context);
        const uiTarget = parameterizeUiTarget(step.uiTarget, context);

        if (action === step.action && uiTarget === step.uiTarget) return step;
        return {
            ...step,
            action,
            result: {
                ...step.result,
                action,
            },
            semantic: updateSemantic(step.semantic, action),
            ...(uiTarget ? { uiTarget } : {}),
        };
    });

    if (changes.length === 0) {
        return { workflow, changes };
    }

    return {
        workflow: {
            ...workflow,
            expectedWindowTitle,
            steps,
        },
        changes,
    };
}

function parameterizeFromExplicitParameters(workflow: RecordedWorkflow, task: string, platform: DesktopPlatform): ParameterizationResult {
    const changes: ParameterizationChange[] = [];
    let steps = workflow.steps;
    let expectedWindowTitle = workflow.expectedWindowTitle;

    for (const parameter of workflow.parameters ?? []) {
        const inferred = inferReplacementValue(workflow.task, parameter.originalValue, task);
        const nextValue = inferred ? normalizeExplicitParameterValue(parameter.kind, inferred, task, platform) : null;
        if (!nextValue || stringEqualsLoose(nextValue, parameter.originalValue)) continue;

        for (const ref of parameter.usedBy) {
            if (ref.stepIndex === -1 && ref.field === 'expectedWindowTitle') {
                if (expectedWindowTitle && expectedWindowTitle !== nextValue) {
                    changes.push({ stepIndex: -1, field: 'expectedWindowTitle', from: expectedWindowTitle, to: nextValue });
                    expectedWindowTitle = nextValue;
                }
                continue;
            }

            steps = steps.map((step) => {
                if (step.index !== ref.stepIndex) return step;
                const updated = setStepField(step, ref.field, nextValue);
                if (updated === step) return step;
                const from = valueAtStepField(step, ref.field);
                if (from && from !== nextValue && isParameterizationField(ref.field)) {
                    changes.push({
                        stepIndex: step.index,
                        field: ref.field.startsWith('launchApp.args.') ? 'launchApp.args' : ref.field,
                        from,
                        to: nextValue,
                    });
                }
                return updated;
            });
        }
    }

    return {
        workflow: changes.length > 0 ? { ...workflow, expectedWindowTitle, steps } : workflow,
        changes,
    };
}

function normalizeExplicitParameterValue(
    kind: NonNullable<RecordedWorkflow['parameters']>[number]['kind'],
    value: string,
    task: string,
    platform: DesktopPlatform
): string {
    if (kind === 'app') {
        const app = detectPrimaryApp(value) ?? detectPrimaryApp(task);
        return app ? commandForApp(app, platform) : value;
    }

    if (kind === 'window') {
        const app = detectPrimaryApp(value) ?? detectPrimaryApp(task);
        return app ? inferExpectedWindowTitle(task, app, platform) ?? value : value;
    }

    return value;
}

function setStepField(step: RecordedWorkflow['steps'][number], field: string, value: string): RecordedWorkflow['steps'][number] {
    if (field === 'typeText.text' && step.action.type === 'typeText') {
        const action = { ...step.action, text: value };
        return { ...step, action, result: { ...step.result, action }, semantic: updateSemantic(step.semantic, action) };
    }
    if (field === 'launchApp.command' && step.action.type === 'launchApp') {
        const action = { ...step.action, command: value };
        return { ...step, action, result: { ...step.result, action }, semantic: updateSemantic(step.semantic, action) };
    }
    if (field.startsWith('launchApp.args.') && step.action.type === 'launchApp') {
        const idx = Number(field.slice('launchApp.args.'.length));
        if (!Number.isInteger(idx) || idx < 0 || !step.action.args || idx >= step.action.args.length) return step;
        const args = [...step.action.args];
        args[idx] = value;
        const action = { ...step.action, args };
        return { ...step, action, result: { ...step.result, action }, semantic: updateSemantic(step.semantic, action) };
    }
    if (field === 'focusWindow.title' && step.action.type === 'focusWindow') {
        const action = { ...step.action, title: value };
        return { ...step, action, result: { ...step.result, action }, semantic: updateSemantic(step.semantic, action) };
    }
    if (field === 'uiTarget.windowTitle' && step.uiTarget) return { ...step, uiTarget: { ...step.uiTarget, windowTitle: value } };
    if (field === 'uiTarget.query' && step.uiTarget) return { ...step, uiTarget: { ...step.uiTarget, query: value } };
    if (field === 'uiTarget.text' && step.uiTarget) return { ...step, uiTarget: { ...step.uiTarget, text: value } };
    return step;
}

function valueAtStepField(step: RecordedWorkflow['steps'][number], field: string): string | undefined {
    if (field === 'typeText.text' && step.action.type === 'typeText') return step.action.text;
    if (field === 'launchApp.command' && step.action.type === 'launchApp') return step.action.command;
    if (field.startsWith('launchApp.args.') && step.action.type === 'launchApp') {
        const idx = Number(field.slice('launchApp.args.'.length));
        return Number.isInteger(idx) && idx >= 0 ? step.action.args?.[idx] : undefined;
    }
    if (field === 'focusWindow.title' && step.action.type === 'focusWindow') return step.action.title;
    if (field === 'uiTarget.windowTitle') return step.uiTarget?.windowTitle;
    if (field === 'uiTarget.query') return step.uiTarget?.query;
    if (field === 'uiTarget.text') return step.uiTarget?.text;
    return undefined;
}

function isParameterizationField(field: string): field is ParameterizationChange['field'] {
    return (
        field === 'typeText.text' ||
        field === 'launchApp.command' ||
        field === 'launchApp.args' ||
        field.startsWith('launchApp.args.') ||
        field === 'focusWindow.title' ||
        field === 'expectedWindowTitle' ||
        field === 'uiTarget.windowTitle' ||
        field === 'uiTarget.query' ||
        field === 'uiTarget.text'
    );
}

function parameterizeUiTarget(
    target: RecordedUiTarget | undefined,
    input: {
        originalTask: string;
        task: string;
        preferredApp: KnownApp | null;
        windowTitle: string | null;
        stepIndex: number;
        changes: ParameterizationChange[];
    }
): RecordedUiTarget | undefined {
    if (!target) return target;

    let next = target;

    if (target.windowTitle && input.windowTitle && input.windowTitle !== target.windowTitle && shouldReplaceWindowTitle(target.windowTitle, input.task, input.preferredApp)) {
        input.changes.push({
            stepIndex: input.stepIndex,
            field: 'uiTarget.windowTitle',
            from: target.windowTitle,
            to: input.windowTitle,
        });
        next = { ...next, windowTitle: input.windowTitle };
    }

    if (target.query) {
        const query = inferReplacementValue(input.originalTask, target.query, input.task);
        if (query && query !== target.query) {
            input.changes.push({ stepIndex: input.stepIndex, field: 'uiTarget.query', from: target.query, to: query });
            next = { ...next, query };
        }
    }

    if (target.text) {
        const text = inferReplacementValue(input.originalTask, target.text, input.task);
        if (text && text !== target.text) {
            input.changes.push({ stepIndex: input.stepIndex, field: 'uiTarget.text', from: target.text, to: text });
            next = { ...next, text };
        }
    }

    return next;
}

function parameterizeAction(
    action: DesktopAction,
    input: {
        originalTask: string;
        task: string;
        preferredApp: KnownApp | null;
        launchCommand: string | null;
        windowTitle: string | null;
        platform: DesktopPlatform;
        stepIndex: number;
        changes: ParameterizationChange[];
    }
): DesktopAction {
    if (action.type === 'typeText') {
        const nextText = inferReplacementValue(input.originalTask, action.text, input.task);
        if (nextText && nextText !== action.text) {
            input.changes.push({ stepIndex: input.stepIndex, field: 'typeText.text', from: action.text, to: nextText });
            return { ...action, text: nextText };
        }
        return action;
    }

    if (action.type === 'launchApp') {
        let next: DesktopAction = action;

        const recordedApp = detectAppFromLaunchCommand(action.command);
        if (input.launchCommand && shouldReplaceLaunchCommand(action.command, recordedApp, input.preferredApp, input.platform)) {
            input.changes.push({
                stepIndex: input.stepIndex,
                field: 'launchApp.command',
                from: action.command,
                to: input.launchCommand,
            });
            next = { ...next, command: input.launchCommand };
        } else if (!recordedApp) {
            const nextCommand = inferReplacementValue(input.originalTask, action.command, input.task);
            if (nextCommand && nextCommand !== action.command) {
                input.changes.push({
                    stepIndex: input.stepIndex,
                    field: 'launchApp.command',
                    from: action.command,
                    to: nextCommand,
                });
                next = { ...next, command: nextCommand };
            }
        }

        if (action.args && action.args.length > 0) {
            const nextArgs = action.args.map((arg) => inferReplacementValue(input.originalTask, arg, input.task) ?? arg);
            if (!sameStringArray(nextArgs, action.args)) {
                input.changes.push({
                    stepIndex: input.stepIndex,
                    field: 'launchApp.args',
                    from: action.args.join(' '),
                    to: nextArgs.join(' '),
                });
                next = { ...next, args: nextArgs };
            }
        }

        return next;
    }

    if (action.type === 'focusWindow') {
        if (input.windowTitle && input.windowTitle !== action.title && shouldReplaceWindowTitle(action.title, input.task, input.preferredApp)) {
            input.changes.push({
                stepIndex: input.stepIndex,
                field: 'focusWindow.title',
                from: action.title,
                to: input.windowTitle,
            });
            return { ...action, title: input.windowTitle };
        }

        if (!detectAppFromLaunchCommand(action.title)) {
            const nextTitle = inferReplacementValue(input.originalTask, action.title, input.task);
            if (nextTitle && nextTitle !== action.title) {
                input.changes.push({
                    stepIndex: input.stepIndex,
                    field: 'focusWindow.title',
                    from: action.title,
                    to: nextTitle,
                });
                return { ...action, title: nextTitle };
            }
        }
    }

    return action;
}

export function inferReplacementValue(originalTask: string, originalValue: string, newTask: string): string | null {
    const value = originalValue.trim();
    if (!value) return null;

    const quoted = inferFromQuotedOrdinal(originalTask, value, newTask);
    if (quoted) return quoted;

    const byContext = inferBySurroundingContext(originalTask, value, newTask);
    if (byContext) return byContext;

    const byCue = inferByCueBeforeValue(originalTask, value, newTask);
    if (byCue) return byCue;

    return null;
}

function inferFromQuotedOrdinal(originalTask: string, originalValue: string, newTask: string): string | null {
    const originalQuotes = extractQuotedSpans(originalTask);
    const newQuotes = extractQuotedSpans(newTask);
    if (newQuotes.length === 0) return null;

    const idx = originalQuotes.findIndex((q) => stringEqualsLoose(q, originalValue));
    if (idx >= 0 && newQuotes[idx]) return newQuotes[idx]!.trim();

    if (originalQuotes.length === 1 && stringEqualsLoose(originalQuotes[0]!, originalValue) && newQuotes.length === 1) {
        return newQuotes[0]!.trim();
    }

    return null;
}

function inferBySurroundingContext(originalTask: string, originalValue: string, newTask: string): string | null {
    const idx = indexOfLoose(originalTask, originalValue);
    if (idx < 0) return null;

    const prefix = normalizeWhitespace(originalTask.slice(0, idx));
    const suffix = normalizeWhitespace(originalTask.slice(idx + originalValue.length));
    const prefixAnchor = lastWords(prefix, 8);
    const suffixAnchor = firstWords(suffix, 8);
    const normalizedNew = normalizeWhitespace(newTask);

    const start = prefixAnchor ? indexAfterLoose(normalizedNew, prefixAnchor) : 0;
    if (start < 0) return null;

    const end = suffixAnchor ? indexOfLoose(normalizedNew.slice(start), suffixAnchor) : -1;
    const candidate = (end >= 0 ? normalizedNew.slice(start, start + end) : normalizedNew.slice(start)).trim();
    return cleanExtractedValue(candidate);
}

function inferByCueBeforeValue(originalTask: string, originalValue: string, newTask: string): string | null {
    const idx = indexOfLoose(originalTask, originalValue);
    if (idx < 0) return null;

    const before = originalTask.slice(0, idx).toLowerCase();
    const cues = [
        'write',
        'type',
        'enter',
        'search for',
        'search',
        'message',
        'subject',
        'filename',
        'file named',
        'named',
        'called',
        'command',
    ];

    let selected: string | null = null;
    let selectedIndex = -1;
    for (const cue of cues) {
        const cueIdx = before.lastIndexOf(cue);
        if (cueIdx > selectedIndex) {
            selected = cue;
            selectedIndex = cueIdx;
        }
    }

    if (!selected) return null;

    const pattern = new RegExp(`\\b${escapeRegExp(selected).replace(/\\ /g, '\\s+')}\\b`, 'i');
    const match = pattern.exec(newTask);
    if (!match || match.index === undefined) return null;

    const start = match.index + match[0].length;
    return cleanExtractedValue(newTask.slice(start));
}

function cleanExtractedValue(raw: string): string | null {
    let value = raw
        .trim()
        .replace(/^[\s:="'`]+/, '')
        .replace(/[\s"'`]+$/, '')
        .trim();

    value = value.replace(/\s+(?:in|into|on|using|with)\s+(?:notepad|textedit|text edit|chrome|edge|browser|outlook|excel|word|powerpoint|calculator)\.?$/i, '').trim();
    value = value.replace(/\s+(?:and then|then)\s+.+$/i, '').trim();

    return value.length > 0 ? value : null;
}

function extractQuotedSpans(input: string): string[] {
    const out: string[] = [];
    const re = /"([^"]+)"|'([^']+)'|`([^`]+)`|“([^”]+)”|‘([^’]+)’/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input))) {
        const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
        if (value && value.trim()) out.push(value.trim());
    }
    return out;
}

function updateSemantic(semantic: string | undefined, action: DesktopAction): string | undefined {
    if (!semantic) return semantic;
    if (action.type === 'typeText') return `Type text (${action.text.length} chars)`;
    if (action.type === 'launchApp') return `Launch app: ${action.command}`;
    if (action.type === 'focusWindow') return `Focus window: ${action.title}`;
    return semantic;
}

function indexOfLoose(input: string, needle: string): number {
    return normalizeWhitespace(input).toLowerCase().indexOf(normalizeWhitespace(needle).toLowerCase());
}

function indexAfterLoose(input: string, needle: string): number {
    const idx = indexOfLoose(input, needle);
    return idx < 0 ? -1 : idx + normalizeWhitespace(needle).length;
}

function stringEqualsLoose(a: string, b: string): boolean {
    return normalizeWhitespace(a).toLowerCase() === normalizeWhitespace(b).toLowerCase();
}

function normalizeWhitespace(input: string): string {
    return input.replace(/\s+/g, ' ').trim();
}

function firstWords(input: string, count: number): string {
    return input.split(' ').filter(Boolean).slice(0, count).join(' ');
}

function lastWords(input: string, count: number): string {
    const words = input.split(' ').filter(Boolean);
    return words.slice(Math.max(0, words.length - count)).join(' ');
}

function sameStringArray(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

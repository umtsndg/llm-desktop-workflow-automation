import type { DesktopAction } from '../desktop/action-types';
import { extractFirstJsonObject } from '../llm/json-extract';
import type { LLMChatClient } from '../llm/llm-types';

import type { RecordedStep, RecordedWorkflow } from './recorded-workflow';

export type RecordingVerificationResult = {
    workflow: RecordedWorkflow;
    summary: string;
};

export async function verifyRecordingWithLlm(
    llm: LLMChatClient,
    workflow: RecordedWorkflow,
    task: string
): Promise<RecordingVerificationResult> {
    const result = await llm.chat([
        {
            role: 'system',
            content: [
                'You adapt recorded desktop workflows for replay.',
                'Return ONLY valid JSON with this shape: {"summary":"...","workflow":{...}}.',
                'Keep the workflow version, ok status, timestamps, step order, and step count.',
                'Keep every step action type unchanged.',
                'Do not change click coordinates, clickCandidate ids, uiClick selectors, uiTarget selectors, or fixed UI labels such as To, Subject, Body, Message body, New mail, and Send.',
                'Only change values that must differ for the new task: task text, typed text, launch app command, focus window title, expected window title, and launch args.',
                'For email workflows, map recipient/subject/body changes only onto typeText actions. Never replace UI target labels.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: [
                'New task:',
                task,
                '',
                'Recorded workflow JSON:',
                JSON.stringify(workflow, null, 2),
                '',
                'Return the adapted workflow JSON now.',
            ].join('\n'),
        },
    ]);

    const parsed = extractFirstJsonObject(result.content) as { summary?: unknown; workflow?: unknown };
    const adapted = sanitizeAdaptedWorkflow(workflow, parsed.workflow, task);
    return {
        workflow: adapted,
        summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : 'Recording adapted by LLM.',
    };
}

function sanitizeAdaptedWorkflow(original: RecordedWorkflow, value: unknown, task: string): RecordedWorkflow {
    const candidate = value && typeof value === 'object' ? (value as Partial<RecordedWorkflow>) : {};
    const candidateSteps = Array.isArray(candidate.steps) ? candidate.steps : [];

    const steps = original.steps.map((originalStep, idx) => sanitizeStep(originalStep, candidateSteps[idx]));
    return {
        ...original,
        task,
        expectedWindowTitle:
            typeof candidate.expectedWindowTitle === 'string' && candidate.expectedWindowTitle.trim()
                ? candidate.expectedWindowTitle.trim()
                : original.expectedWindowTitle,
        steps,
    };
}

function sanitizeStep(original: RecordedStep, value: unknown): RecordedStep {
    const candidate = value && typeof value === 'object' ? (value as Partial<RecordedStep>) : {};
    const action = sanitizeAction(original.action, candidate.action);
    return {
        ...original,
        action,
        result: {
            ...original.result,
            action,
        },
        semantic: typeof candidate.semantic === 'string' && candidate.semantic.trim() ? candidate.semantic : original.semantic,
    };
}

function sanitizeAction(original: DesktopAction, value: unknown): DesktopAction {
    const candidate = value && typeof value === 'object' ? (value as Partial<DesktopAction>) : {};
    if (candidate.type !== original.type) return original;

    switch (original.type) {
        case 'typeText':
            return typeof (candidate as { text?: unknown }).text === 'string'
                ? { ...original, text: (candidate as { text: string }).text }
                : original;

        case 'launchApp': {
            const c = candidate as Partial<Extract<DesktopAction, { type: 'launchApp' }>>;
            return {
                ...original,
                ...(typeof c.command === 'string' && c.command.trim() ? { command: c.command.trim() } : {}),
                ...(Array.isArray(c.args) && c.args.every((arg) => typeof arg === 'string') ? { args: c.args } : {}),
                ...(c.mode === 'search' || c.mode === 'shell' ? { mode: c.mode } : {}),
            };
        }

        case 'focusWindow': {
            const c = candidate as Partial<Extract<DesktopAction, { type: 'focusWindow' }>>;
            return {
                ...original,
                ...(typeof c.title === 'string' && c.title.trim() ? { title: c.title.trim() } : {}),
                ...(c.match === 'contains' || c.match === 'exact' ? { match: c.match } : {}),
            };
        }

        default:
            return original;
    }
}

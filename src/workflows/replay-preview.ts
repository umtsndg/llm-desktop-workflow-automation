import type { WorkflowMatch } from './retrieval';
import { parameterizeWorkflowForTask, type ParameterizationChange } from './workflow-parameters';

export type ReplayPreview = {
    confidence: number;
    workflowTask: string;
    stepCount: number;
    substitutions: ParameterizationChange[];
    summary: string[];
};

export function buildReplayPreview(task: string, match: WorkflowMatch): ReplayPreview {
    const parameterized = parameterizeWorkflowForTask(match.workflow, task);
    const substitutions = parameterized.changes;
    const confidence = clamp01(match.score);

    return {
        confidence,
        workflowTask: match.workflow.task,
        stepCount: match.workflow.steps.length,
        substitutions,
        summary: [
            `${Math.round(confidence * 100)}% match`,
            substitutions.length > 0
                ? `${substitutions.length} substitution${substitutions.length === 1 ? '' : 's'}`
                : 'no substitutions',
            `${match.workflow.steps.length} recorded step${match.workflow.steps.length === 1 ? '' : 's'}`,
        ],
    };
}

export function formatReplayPreview(preview: ReplayPreview): string {
    const substitutions = preview.substitutions.slice(0, 4);
    if (substitutions.length === 0) {
        return `Found workflow "${preview.workflowTask}" (${Math.round(preview.confidence * 100)}% confident). No substitutions needed.`;
    }

    const rendered = substitutions
        .map((s) => `${s.from} -> ${s.to}`)
        .join(', ');
    const suffix = preview.substitutions.length > substitutions.length ? `, +${preview.substitutions.length - substitutions.length} more` : '';
    return `Found workflow "${preview.workflowTask}" (${Math.round(preview.confidence * 100)}% confident). Substitutions: ${rendered}${suffix}.`;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

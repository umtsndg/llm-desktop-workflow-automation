import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { RecordedWorkflow } from './recorded-workflow';
import { tfidfCosineSimilarity, tokenOverlapSimilarity } from './task-similarity';
import { detectPrimaryApp } from './workflow-intent';

export type LoadedWorkflow = {
    path: string;
    workflow: RecordedWorkflow;
};

export type WorkflowMatch = {
    path: string;
    workflow: RecordedWorkflow;
    score: number;
    details: {
        taskScore: number;
        canonicalTaskScore: number;
        semanticScore: number;
        overlapScore: number;
        parameterScore: number;
        appScore: number;
        actionScore: number;
        reliabilityScore: number;
    };
};

export type RetrievalOptions = {
    dir?: string;
    limit?: number;
};

export async function loadRecordedWorkflows(options?: RetrievalOptions): Promise<LoadedWorkflow[]> {
    const dir = options?.dir ?? resolve(process.cwd(), 'recordings');

    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return [];
    }

    const files = entries.filter((f) => f.toLowerCase().endsWith('.json'));
    const out: LoadedWorkflow[] = [];

    for (const f of files) {
        const full = resolve(dir, f);
        try {
            const raw = await readFile(full, 'utf8');
            const parsed = JSON.parse(raw) as RecordedWorkflow;
            if (!parsed || parsed.version !== 1) continue;
            if (!parsed.ok) continue;
            if (!Array.isArray(parsed.steps)) continue;
            out.push({ path: full, workflow: parsed });
        } catch {
            // Skip invalid recordings.
            continue;
        }
    }

    return out;
}

export function rankRecordedWorkflows(task: string, workflows: LoadedWorkflow[], options?: { limit?: number }): WorkflowMatch[] {
    const limit = options?.limit ?? 5;

    const taskTexts = workflows.map((w) => w.workflow.task);
    const canonicalTask = canonicalizeTaskText(task);
    const canonicalTaskTexts = workflows.map((w) => canonicalizeTaskText(w.workflow.task));
    const semanticTexts = workflows.map((w) => buildSemanticText(w.workflow));
    const actionTexts = workflows.map((w) => buildActionText(w.workflow));
    const queryActionText = canonicalizeTaskText(task);

    const matches: WorkflowMatch[] = workflows.map((w, idx) => {
        const taskScore = tfidfCosineSimilarity(task, w.workflow.task, taskTexts);
        const canonicalTaskScore = tfidfCosineSimilarity(canonicalTask, canonicalTaskTexts[idx] ?? '', canonicalTaskTexts);
        const semanticText = semanticTexts[idx] ?? '';
        const semanticScore = semanticText ? tfidfCosineSimilarity(task, semanticText, semanticTexts) : 0;
        const overlapScore = tokenOverlapSimilarity(task, w.workflow.task);
        const parameterScore = parameterCompatibilityScore(task, w.workflow);
        const appScore = appCompatibilityScore(task, w.workflow);
        const actionText = actionTexts[idx] ?? '';
        const actionScore = actionText ? tfidfCosineSimilarity(queryActionText, actionText, actionTexts) : 0;
        const reliabilityScore = workflowReliabilityScore(w.workflow);

        // Weighted mix: raw task text and a canonicalized variant are primary,
        // structured metadata improves reuse decisions when task wording differs.
        const weightedScore =
            0.28 * taskScore +
            0.2 * canonicalTaskScore +
            0.15 * semanticScore +
            0.08 * overlapScore +
            0.1 * parameterScore +
            0.09 * appScore +
            0.06 * actionScore +
            0.04 * reliabilityScore;

        const score = applyExactMatchBoost(task, w.workflow.task, canonicalTask, canonicalTaskTexts[idx] ?? '', weightedScore);

        return {
            path: w.path,
            workflow: w.workflow,
            score,
            details: { taskScore, canonicalTaskScore, semanticScore, overlapScore, parameterScore, appScore, actionScore, reliabilityScore },
        };
    });

    return matches
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit));
}

export function bestWorkflowMatch(task: string, workflows: LoadedWorkflow[], options?: { minScore?: number }): WorkflowMatch | null {
    const ranked = rankRecordedWorkflows(task, workflows, { limit: 1 });
    const best = ranked[0];
    if (!best) return null;

    const minScore = options?.minScore ?? 0.55;
    if (best.score < minScore) return null;

    return best;
}

function applyExactMatchBoost(
    task: string,
    workflowTask: string,
    canonicalTask: string,
    canonicalWorkflowTask: string,
    score: number
): number {
    if (normalizeForExactMatch(task) === normalizeForExactMatch(workflowTask)) {
        return Math.max(score, 0.99);
    }

    if (normalizeForExactMatch(canonicalTask) === normalizeForExactMatch(canonicalWorkflowTask)) {
        return Math.max(score, 0.95);
    }

    return score;
}

function normalizeForExactMatch(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^\p{L}\p{N}@._+-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSemanticText(workflow: RecordedWorkflow): string {
    const parts: string[] = [];
    for (const s of workflow.steps) {
        if (typeof s.semantic === 'string' && s.semantic.trim()) {
            parts.push(s.semantic.trim());
        }
    }

    // Cap size to keep ranking cheap.
    return parts.join(' | ').slice(0, 4000);
}

function buildActionText(workflow: RecordedWorkflow): string {
    const parts = workflow.steps.map((s) => {
        const action = s.action;
        if (action.type === 'launchApp') return `launch app ${action.command}`;
        if (action.type === 'focusWindow') return `focus window ${action.title}`;
        if (action.type === 'typeText') return 'type text';
        if (action.type === 'click') return `click ${s.uiTarget?.query ?? s.uiTarget?.text ?? action.hint ?? s.semantic ?? ''}`;
        if (action.type === 'clickCandidate') return `click ${s.uiTarget?.query ?? s.uiTarget?.text ?? action.hint ?? s.semantic ?? ''}`;
        if (action.type === 'wait') return 'wait';
        if (action.type === 'hotkey') return `hotkey ${action.keys.join(' ')}`;
        if (action.type === 'pressKey') return `press ${action.key}`;
        if (action.type === 'scroll') return `scroll ${action.direction ?? 'down'}`;
        return action.type;
    });
    return parts.join(' | ').slice(0, 4000);
}

function parameterCompatibilityScore(task: string, workflow: RecordedWorkflow): number {
    const params = workflow.parameters ?? [];
    if (params.length === 0) return 0.5;

    const taskLower = task.toLowerCase();
    let matched = 0;
    for (const p of params) {
        if (p.kind === 'text' && /\b(write|type|enter|message|subject|search)\b/i.test(taskLower)) matched++;
        else if (p.kind === 'app' && detectPrimaryApp(task)) matched++;
        else if (p.kind === 'window' && detectPrimaryApp(task)) matched++;
        else if (p.originalValue && !taskLower.includes(p.originalValue.toLowerCase())) matched += 0.5;
    }

    return clamp01(matched / Math.max(1, params.length));
}

function appCompatibilityScore(task: string, workflow: RecordedWorkflow): number {
    const taskApp = detectPrimaryApp(task);
    const workflowApp = workflow.appContext?.app ?? detectPrimaryApp(workflow.task);
    if (!taskApp && !workflowApp) return 0.5;
    if (!taskApp || !workflowApp) return 0.25;
    if (taskApp === workflowApp) return 1;
    if (isEquivalentApp(taskApp, workflowApp)) return 0.9;
    return 0;
}

function workflowReliabilityScore(workflow: RecordedWorkflow): number {
    const successes = workflow.replayStats?.successes ?? 0;
    const failures = workflow.replayStats?.failures ?? 0;
    if (successes + failures === 0) return 0.5;
    return (successes + 1) / (successes + failures + 2);
}

function isEquivalentApp(a: string, b: string): boolean {
    const plainText = new Set(['notepad', 'textedit']);
    const browser = new Set(['browser', 'chrome', 'edge']);
    return (plainText.has(a) && plainText.has(b)) || (browser.has(a) && browser.has(b));
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function canonicalizeTaskText(task: string): string {
    const lower = task
        .toLowerCase()
        .replace(/\bnotepad\b/g, 'plain-text-editor')
        .replace(/\btext\s*edit\b/g, 'plain-text-editor')
        .replace(/\btextedit\b/g, 'plain-text-editor');

    // Heuristic: for patterns like "open a plain text editor and write <anything>",
    // treat everything after "write" as a parameter so recordings are reusable.
    const writeMatch = lower.match(/^(.*\bwrite\b)/i);
    if (writeMatch && writeMatch[1]) {
        return writeMatch[1].trim();
    }

    // Fallback: just use the lowercased task.
    return lower.trim();
}

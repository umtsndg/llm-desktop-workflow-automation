import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { RecordedWorkflow } from './recorded-workflow';
import { tfidfCosineSimilarity, tokenOverlapSimilarity } from './task-similarity';

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

    const matches: WorkflowMatch[] = workflows.map((w, idx) => {
        const taskScore = tfidfCosineSimilarity(task, w.workflow.task, taskTexts);
        const canonicalTaskScore = tfidfCosineSimilarity(canonicalTask, canonicalTaskTexts[idx] ?? '', canonicalTaskTexts);
        const semanticText = semanticTexts[idx] ?? '';
        const semanticScore = semanticText ? tfidfCosineSimilarity(task, semanticText, semanticTexts) : 0;
        const overlapScore = tokenOverlapSimilarity(task, w.workflow.task);

        // Weighted mix: raw task text and a canonicalized variant are primary,
        // semantic is supportive, overlap guards against TF-IDF weirdness on short strings.
        // Canonicalization lets similar templates like "open notepad/textedit and write ..."
        // reuse recordings even when the exact text being written differs.
        const score = 0.45 * taskScore + 0.25 * canonicalTaskScore + 0.2 * semanticScore + 0.1 * overlapScore;

        return {
            path: w.path,
            workflow: w.workflow,
            score,
            details: { taskScore, canonicalTaskScore, semanticScore, overlapScore },
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

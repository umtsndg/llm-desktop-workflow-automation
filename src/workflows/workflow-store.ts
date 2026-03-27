import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { RecordedWorkflow } from './recorded-workflow';

export async function saveRecordedWorkflow(workflow: RecordedWorkflow, options?: { dir?: string }): Promise<string> {
    const dir = options?.dir ?? resolve(process.cwd(), 'recordings');
    await mkdir(dir, { recursive: true });

    const ts = workflow.endedAt.replace(/[:.]/g, '-');
    const slug = slugify(workflow.task).slice(0, 60) || 'task';
    const filename = `${ts}__${slug}.json`;
    const fullPath = resolve(dir, filename);

    await writeFile(fullPath, JSON.stringify(workflow, null, 2), 'utf8');
    return fullPath;
}

function slugify(input: string): string {
    return String(input)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

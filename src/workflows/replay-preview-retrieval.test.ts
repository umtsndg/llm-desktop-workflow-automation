import assert from 'node:assert/strict';

import type { LoadedWorkflow } from './retrieval';
import { rankRecordedWorkflows } from './retrieval';
import { buildReplayPreview } from './replay-preview';

const workflows: LoadedWorkflow[] = [
    {
        path: 'plain-text.json',
        workflow: {
            version: 1,
            task: 'open notepad and write hello',
            ok: true,
            startedAt: '2026-05-26T00:00:00.000Z',
            endedAt: '2026-05-26T00:00:01.000Z',
            appContext: {
                kind: 'plain_text_editor',
                app: 'notepad',
                windowsCommand: 'Notepad',
                macCommand: 'TextEdit',
                windowsWindowTitle: 'Notepad',
                macWindowTitle: 'TextEdit',
            },
            parameters: [
                {
                    name: 'text_to_write',
                    kind: 'text',
                    source: 'task',
                    originalValue: 'hello',
                    usedBy: [{ stepIndex: 2, field: 'typeText.text' }],
                },
            ],
            replayStats: { successes: 8, failures: 1 },
            steps: [
                {
                    index: 0,
                    action: { type: 'launchApp', command: 'Notepad', mode: 'search' },
                    result: { ok: true, action: { type: 'launchApp', command: 'Notepad', mode: 'search' }, executedAt: 'x' },
                    semantic: 'Launch app: Notepad',
                },
                {
                    index: 1,
                    action: { type: 'focusWindow', title: 'Notepad', match: 'contains' },
                    result: { ok: true, action: { type: 'focusWindow', title: 'Notepad', match: 'contains' }, executedAt: 'x' },
                    semantic: 'Focus window: Notepad',
                },
                {
                    index: 2,
                    action: { type: 'typeText', text: 'hello' },
                    result: { ok: true, action: { type: 'typeText', text: 'hello' }, executedAt: 'x' },
                    semantic: 'Type text (5 chars)',
                },
            ],
        },
    },
    {
        path: 'browser.json',
        workflow: {
            version: 1,
            task: 'open chrome and search weather',
            ok: true,
            startedAt: '2026-05-26T00:00:00.000Z',
            endedAt: '2026-05-26T00:00:01.000Z',
            appContext: {
                kind: 'browser',
                app: 'chrome',
                windowsCommand: 'Google Chrome',
                macCommand: 'Google Chrome',
                windowsWindowTitle: 'Google Chrome',
                macWindowTitle: 'Google Chrome',
            },
            replayStats: { successes: 1, failures: 5 },
            steps: [
                {
                    index: 0,
                    action: { type: 'launchApp', command: 'Google Chrome', mode: 'search' },
                    result: { ok: true, action: { type: 'launchApp', command: 'Google Chrome', mode: 'search' }, executedAt: 'x' },
                    semantic: 'Launch app: Google Chrome',
                },
            ],
        },
    },
];

const ranked = rankRecordedWorkflows('open notepad and write goodbye', workflows, { limit: 2 });
assert.equal(ranked[0]?.path, 'plain-text.json');
assert.ok((ranked[0]?.details.parameterScore ?? 0) > 0);
assert.ok((ranked[0]?.details.appScore ?? 0) > (ranked[1]?.details.appScore ?? 0));

const preview = buildReplayPreview('open notepad and write goodbye', ranked[0]!);
assert.equal(preview.substitutions.some((s) => s.field === 'typeText.text' && s.to === 'goodbye'), true);
assert.equal(preview.workflowTask, 'open notepad and write hello');

console.log('replay-preview-retrieval tests passed');

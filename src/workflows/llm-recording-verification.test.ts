import assert from 'node:assert/strict';

import type { LLMChatClient } from '../llm/llm-types';

import type { RecordedWorkflow } from './recorded-workflow';
import { verifyRecordingWithLlm } from './llm-recording-verification';

const workflow: RecordedWorkflow = {
    version: 1,
    task: 'Open outlook and send a mail to old@example.com with Subject: Intro and Body: Hello',
    ok: true,
    startedAt: '2026-06-10T00:00:00.000Z',
    endedAt: '2026-06-10T00:01:00.000Z',
    expectedWindowTitle: 'Outlook',
    steps: [
        {
            index: 0,
            action: { type: 'click', nx: 0.1, ny: 0.1, hint: 'Click Send' },
            result: { ok: true, action: { type: 'click', nx: 0.1, ny: 0.1, hint: 'Click Send' }, executedAt: 'x' },
            uiTarget: { windowTitle: 'Outlook', text: 'Send', query: 'Send' },
        },
        {
            index: 1,
            action: { type: 'typeText', text: 'old@example.com' },
            result: { ok: true, action: { type: 'typeText', text: 'old@example.com' }, executedAt: 'x' },
        },
    ],
};

const fakeLlm: LLMChatClient = {
    async chat() {
        const adapted: RecordedWorkflow = {
            ...workflow,
            task: 'Open outlook and send a mail to new@example.com',
            steps: [
                {
                    ...workflow.steps[0]!,
                    action: { type: 'click', nx: 0.9, ny: 0.9, hint: 'Wrongly changed Send click' },
                    uiTarget: { windowTitle: 'Outlook', text: 'Not Send', query: 'Not Send' },
                },
                {
                    ...workflow.steps[1]!,
                    action: { type: 'typeText', text: 'new@example.com' },
                },
            ],
        };
        return {
            content: JSON.stringify({ summary: 'Updated recipient', workflow: adapted }),
        };
    },
};

async function main(): Promise<void> {
    const result = await verifyRecordingWithLlm(fakeLlm, workflow, 'Open outlook and send a mail to new@example.com');

    assert.equal(result.workflow.steps[0]?.action.type, 'click');
    assert.deepEqual(result.workflow.steps[0]?.action, workflow.steps[0]?.action);
    assert.deepEqual(result.workflow.steps[0]?.uiTarget, workflow.steps[0]?.uiTarget);
    assert.equal(result.workflow.steps[1]?.action.type, 'typeText');
    assert.equal(result.workflow.steps[1]?.action.type === 'typeText' ? result.workflow.steps[1].action.text : '', 'new@example.com');

    console.log('llm-recording-verification tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

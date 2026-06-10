import assert from 'node:assert/strict';

import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction, DesktopObservation, ExecutionResult } from '../desktop/action-types';

import type { RecordedWorkflow } from './recorded-workflow';
import { replayRecordedWorkflow } from './replay';

const executed: DesktopAction[] = [];
let launched = false;

const operator: DesktopOperator = {
    async screenshot(): Promise<DesktopObservation> {
        return {
            screenshotBase64: '',
            timestamp: '2026-06-10T00:00:00.000Z',
            width: 1920,
            height: 1080,
        };
    },

    async execute(actions: DesktopAction[]): Promise<ExecutionResult[]> {
        return actions.map((action) => {
            executed.push(action);

            if (action.type === 'launchApp') {
                launched = true;
            }

            const ok = action.type !== 'focusWindow' || launched;
            return {
                ok,
                action,
                ...(ok ? {} : { error: 'Window is not open yet' }),
                executedAt: '2026-06-10T00:00:00.000Z',
            };
        });
    },
};

const workflow: RecordedWorkflow = {
    version: 1,
    task: 'Open outlook and send a mail',
    ok: true,
    startedAt: '2026-06-10T00:00:00.000Z',
    endedAt: '2026-06-10T00:01:00.000Z',
    expectedWindowTitle: 'Outlook',
    steps: [
        {
            index: 0,
            action: { type: 'launchApp', command: 'Outlook', mode: 'search' },
            result: {
                ok: true,
                action: { type: 'launchApp', command: 'Outlook', mode: 'search' },
                executedAt: '2026-06-10T00:00:00.000Z',
            },
        },
        {
            index: 1,
            action: { type: 'click', nx: 0.1, ny: 0.1, hint: 'New mail' },
            result: {
                ok: true,
                action: { type: 'click', nx: 0.1, ny: 0.1, hint: 'New mail' },
                executedAt: '2026-06-10T00:00:00.000Z',
            },
        },
    ],
};

async function main(): Promise<void> {
    const result = await replayRecordedWorkflow(operator, workflow, { robust: true });

    assert.equal(result.ok, true);
    assert.deepEqual(
        executed.map((action) => action.type),
        ['launchApp', 'wait', 'focusWindow', 'click']
    );
    assert.equal(result.results[0]?.step.action.type, 'launchApp');

    console.log('replay tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

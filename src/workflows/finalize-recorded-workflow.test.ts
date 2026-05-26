import assert from 'node:assert/strict';

import type { DesktopAction } from '../desktop/action-types';

import { finalizeRecordedWorkflow } from './finalize-recorded-workflow';
import type { RecordedStep, RecordedWorkflow } from './recorded-workflow';
import { parameterizeWorkflowForTask } from './workflow-parameters';

const baseTime = '2026-05-26T13:49:40.485Z';

function step(index: number, action: DesktopAction, semantic?: string, uiTarget?: RecordedStep['uiTarget']): RecordedStep {
    return {
        index,
        action,
        result: { ok: true, action, executedAt: baseTime },
        ...(semantic ? { semantic } : {}),
        ...(uiTarget ? { uiTarget } : {}),
    };
}

function workflow(task: string, steps: RecordedStep[]): RecordedWorkflow {
    return {
        version: 1,
        task,
        ok: true,
        startedAt: baseTime,
        endedAt: '2026-05-26T13:50:27.715Z',
        steps,
    };
}

function notepadTabSteps(): RecordedStep[] {
    const addTabTarget = {
        windowTitle: 'Notepad',
        text: 'Add New Tab',
        query: 'Add New Tab',
        role: 'ControlType.Button',
        automationId: 'AddButton',
        className: 'Button',
        controlType: 'ControlType.Button',
        typeable: false,
        clickable: false,
    };

    return [
        step(
            0,
            { type: 'click', button: 'left', nx: 0.790625, ny: 0.21319444444444444, hint: 'Open a new Notepad tab' },
            'Open a new Notepad tab',
            addTabTarget
        ),
        step(
            1,
            { type: 'click', button: 'left', nx: 0.790625, ny: 0.21319444444444444, hint: 'Open a new Notepad tab' },
            'Open a new Notepad tab',
            addTabTarget
        ),
        step(
            2,
            { type: 'click', button: 'left', nx: 0.667578125, ny: 0.44166666666666665, hint: 'Focus Notepad text editor in the new tab' },
            'Focus Notepad text editor in the new tab',
            {
                windowTitle: 'Notepad',
                text: 'Text editor',
                query: 'Text editor',
                role: 'ControlType.Document',
                className: 'RichEditD2DPT',
                controlType: 'ControlType.Document',
                typeable: false,
                clickable: false,
            }
        ),
        step(3, { type: 'typeText', text: 'hello', hint: 'Type hello into the focused Notepad tab' }, 'Type hello into the focused Notepad tab'),
    ];
}

{
    const finalized = finalizeRecordedWorkflow(
        workflow('open notepad, open a new tab and write hello in it', notepadTabSteps()),
        { platform: 'win32' }
    );

    assert.equal(finalized.steps[0]?.action.type, 'launchApp');
    assert.equal(finalized.steps[0]?.action.type === 'launchApp' ? finalized.steps[0].action.command : '', 'Notepad');
    assert.equal(finalized.steps[1]?.action.type, 'wait');
    assert.equal(finalized.steps[2]?.action.type, 'focusWindow');
    assert.equal(finalized.steps.filter((s) => s.uiTarget?.automationId === 'AddButton').length, 1);
    assert.equal(finalized.steps.some((s) => s.action.type === 'typeText' && s.action.text === 'hello'), true);
    assert.equal(finalized.steps.find((s) => s.uiTarget?.automationId === 'AddButton')?.context?.tabIntent, 'new_tab');
    assert.equal(finalized.preconditions?.length, 2);
    assert.equal(finalized.appContext?.kind, 'plain_text_editor');
}

{
    const finalized = finalizeRecordedWorkflow(workflow('open notepad and open two new tabs', notepadTabSteps()), { platform: 'win32' });
    assert.equal(finalized.steps.filter((s) => s.uiTarget?.automationId === 'AddButton').length, 2);
}

{
    const finalized = finalizeRecordedWorkflow(workflow('click Add New Tab twice in notepad', notepadTabSteps()), { platform: 'win32' });
    assert.equal(finalized.steps.filter((s) => s.uiTarget?.automationId === 'AddButton').length, 2);
}

{
    const finalized = finalizeRecordedWorkflow(workflow('open textedit and write hello', notepadTabSteps()), { platform: 'darwin' });
    assert.equal(finalized.steps[0]?.action.type, 'launchApp');
    assert.equal(finalized.steps[0]?.action.type === 'launchApp' ? finalized.steps[0].action.command : '', 'TextEdit');
    assert.equal(finalized.expectedWindowTitle, 'TextEdit');
}

{
    const finalized = finalizeRecordedWorkflow(
        workflow('open notepad and write hello', [
            step(0, { type: 'launchApp', command: 'Notepad', mode: 'search' }, 'Launch app: Notepad'),
            step(1, { type: 'focusWindow', title: 'Notepad', match: 'contains' }, 'Focus window: Notepad'),
            step(2, { type: 'typeText', text: 'hello' }, 'Type text (5 chars)'),
        ]),
        { platform: 'win32' }
    );

    const parameterized = parameterizeWorkflowForTask(finalized, 'open notepad and write goodbye', { platform: 'win32' });
    assert.equal(parameterized.workflow.steps.some((s) => s.action.type === 'typeText' && s.action.text === 'goodbye'), true);
    assert.equal(parameterized.changes.length > 0, true);
}

console.log('finalize-recorded-workflow tests passed');

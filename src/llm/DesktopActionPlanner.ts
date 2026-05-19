import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction } from '../desktop/action-types';
import { formatCandidatesForPrompt, isUiCandidateProvider } from '../desktop/ui-candidates';

import type { LLMChatClient, LLMContentPart, LLMMessage } from './llm-types';
import { buildLoopSystemPrompt, buildPlanPrompt } from './loop-prompts';
import { extractFirstJsonObject } from './json-extract';
import { assertDesktopActions } from './validate-actions';

type PlanOptions = {
    includeScreenshot?: boolean;
    expectedWindowTitle?: string;
};

export class DesktopActionPlanner {
    constructor(private readonly llm: LLMChatClient) { }

    async plan(task: string, operator?: DesktopOperator, options?: PlanOptions): Promise<DesktopAction[]> {
        const messages: LLMMessage[] = [{ role: 'system', content: buildLoopSystemPrompt(task) }];

        // When supported, gather actionable UI candidates so the model can
        // choose by id (clickCandidate) instead of raw coordinates.
        if (operator && isUiCandidateProvider(operator)) {
            const expectedTitle = options?.expectedWindowTitle ?? inferExpectedWindowTitle(task);
            if (expectedTitle) {
                const candidates = await operator
                    .listUiCandidates({ windowTitle: expectedTitle, match: 'contains', limit: 35 })
                    .catch(() => []);
                if (candidates.length > 0) {
                    messages.push({
                        role: 'user',
                        content: `UI candidates (choose by id using clickCandidate):\n${formatCandidatesForPrompt(candidates, 35)}`,
                    });
                }
            }
        }

        if (options?.includeScreenshot && operator) {
            const obs = await operator.screenshot();
            const parts: LLMContentPart[] = [
                { type: 'text', text: 'Current screenshot (provided as image):' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${obs.screenshotBase64}` } },
            ];
            messages.push({ role: 'user', content: parts });
        }

        messages.push({
            role: 'user',
            content: buildPlanPrompt(task),
        });

        const result = await this.llm.chat(messages);
        const json = extractFirstJsonObject(result.content);
        const actions = assertDesktopActions(json);

        return this.applySafetyPostprocessing(task, actions, options);
    }

    private applySafetyPostprocessing(task: string, actions: DesktopAction[], options?: PlanOptions): DesktopAction[] {
        // Guardrail: typing without focusing a target window often ends up in the terminal.
        // We infer an expected window title from the task and/or first launchApp.
        const out = [...actions];

        const firstLaunchIndex = out.findIndex((a) => a.type === 'launchApp');
        if (firstLaunchIndex === -1) return out;

        const launchCommand =
            firstLaunchIndex !== -1 && out[firstLaunchIndex].type === 'launchApp'
                ? out[firstLaunchIndex].command
                : undefined;

        const expectedTitle =
            options?.expectedWindowTitle ??
            inferExpectedWindowTitle(task, launchCommand);

        if (!expectedTitle) return out;

        // Ensure a realistic wait after launch so the window exists.
        const afterLaunch = out[firstLaunchIndex + 1];
        let focusInsertIndex = firstLaunchIndex + 1;
        if (afterLaunch?.type === 'wait') {
            if (afterLaunch.ms < 1200) {
                out[firstLaunchIndex + 1] = { type: 'wait', ms: 1200 };
            }
            focusInsertIndex = firstLaunchIndex + 2;
        } else {
            out.splice(firstLaunchIndex + 1, 0, { type: 'wait', ms: 1200 });
            focusInsertIndex = firstLaunchIndex + 2;
        }

        // Ensure focus happens before the first interactive action after launch.
        const isInteractive = (a: DesktopAction) =>
            a.type === 'pressKey' ||
            a.type === 'hotkey' ||
            a.type === 'typeText' ||
            a.type === 'clickCandidate' ||
            a.type === 'uiClick' ||
            a.type === 'scroll';

        const firstInteractiveAfterLaunch = out.findIndex(
            (a, idx) => idx > firstLaunchIndex && isInteractive(a)
        );

        const alreadyFocused = out
            .slice(firstLaunchIndex + 1, firstInteractiveAfterLaunch === -1 ? undefined : firstInteractiveAfterLaunch)
            .some((a) => a.type === 'focusWindow');

        if (!alreadyFocused) {
            const insertAt =
                firstInteractiveAfterLaunch !== -1
                    ? Math.min(focusInsertIndex, firstInteractiveAfterLaunch)
                    : focusInsertIndex;

            out.splice(insertAt, 0, {
                type: 'focusWindow',
                title: expectedTitle,
                match: 'contains',
            });
        }

        return out;
    }
}

function inferExpectedWindowTitle(task: string, launchCommand?: string): string | null {
    const t = task.toLowerCase();
    const cmd = launchCommand?.toLowerCase();

    // If a document path/name is present, prefer focusing by the document name (more precise than generic app title).
    const xlsx = task.match(/([A-Za-z0-9 _-]+)\.xlsx\b/i) ?? cmd?.match(/([A-Za-z0-9 _-]+)\.xlsx\b/i);
    if (xlsx?.[1]) return xlsx[1];
    const docx = task.match(/([A-Za-z0-9 _-]+)\.docx\b/i) ?? cmd?.match(/([A-Za-z0-9 _-]+)\.docx\b/i);
    if (docx?.[1]) return docx[1];
    const pptx = task.match(/([A-Za-z0-9 _-]+)\.pptx\b/i) ?? cmd?.match(/([A-Za-z0-9 _-]+)\.pptx\b/i);
    if (pptx?.[1]) return pptx[1];

    if (t.includes('textedit') || t.includes('text edit') || cmd?.includes('textedit')) return 'TextEdit';
    if (t.includes('notepad') || cmd?.includes('notepad')) return process.platform === 'darwin' ? 'TextEdit' : 'Notepad';
    if (t.includes('excel') || cmd?.includes('excel') || /\.xlsx\b/.test(t) || /\.xlsx\b/.test(cmd ?? '')) return 'Excel';
    if (t.includes('word') || cmd?.includes('winword')) return 'Word';
    if (t.includes('powerpoint') || cmd?.includes('powerpnt')) return 'PowerPoint';
    if (t.includes('chrome') || cmd?.includes('chrome')) return 'Chrome';
    if (t.includes('edge') || cmd?.includes('msedge')) return 'Edge';
    if (t.includes('outlook') || t.includes('email') || t.includes('e-mail') || t.includes('mail') || cmd?.includes('outlook')) return 'Outlook';
    if (t.includes('command prompt') || t.includes('cmd') || cmd === 'cmd') return 'Command Prompt';
    if (t.includes('visual studio code') || t.includes('vs code') || cmd?.includes('code')) return 'Visual Studio Code';
    if (t.includes('calculator') || cmd?.includes('calc')) return 'Calculator';

    // Lightweight fallback: "open <app>" -> use <app> as contains-title.
    const m = t.match(/\bopen\s+([a-z0-9 ._-]{2,40})\b/);
    if (m?.[1]) {
        const candidate = m[1].trim();
        if (candidate.length >= 2) return candidate;
    }

    return null;
}

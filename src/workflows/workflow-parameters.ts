import type { DesktopAction } from '../desktop/action-types';

import type { RecordedUiTarget, RecordedWorkflow } from './recorded-workflow';

type DesktopPlatform = NodeJS.Platform;

type KnownApp =
    | 'browser'
    | 'calculator'
    | 'chrome'
    | 'cmd'
    | 'edge'
    | 'excel'
    | 'notepad'
    | 'outlook'
    | 'powerpoint'
    | 'terminal'
    | 'textedit'
    | 'word'
    | 'vscode';

export type ParameterizationChange = {
    stepIndex: number;
    field:
        | 'typeText.text'
        | 'launchApp.command'
        | 'launchApp.args'
        | 'focusWindow.title'
        | 'expectedWindowTitle'
        | 'uiTarget.windowTitle'
        | 'uiTarget.query'
        | 'uiTarget.text';
    from: string;
    to: string;
};

export type ParameterizationResult = {
    workflow: RecordedWorkflow;
    changes: ParameterizationChange[];
};

export function parameterizeWorkflowForTask(
    workflow: RecordedWorkflow,
    task: string,
    options?: { platform?: DesktopPlatform }
): ParameterizationResult {
    const platform = options?.platform ?? process.platform;
    const originalTask = workflow.task;
    const changes: ParameterizationChange[] = [];

    const preferredApp = detectPrimaryApp(task);
    const launchCommand = preferredApp ? commandForApp(preferredApp, platform) : null;
    const windowTitle = inferExpectedWindowTitle(task, preferredApp, platform);

    let expectedWindowTitle = workflow.expectedWindowTitle;
    if (expectedWindowTitle && windowTitle && windowTitle !== expectedWindowTitle && shouldReplaceWindowTitle(expectedWindowTitle, task, preferredApp)) {
        changes.push({ stepIndex: -1, field: 'expectedWindowTitle', from: expectedWindowTitle, to: windowTitle });
        expectedWindowTitle = windowTitle;
    }

    const steps = workflow.steps.map((step) => {
        const context = {
            originalTask,
            task,
            preferredApp,
            launchCommand,
            windowTitle,
            platform,
            stepIndex: step.index,
            changes,
        };
        const action = parameterizeAction(step.action, context);
        const uiTarget = parameterizeUiTarget(step.uiTarget, context);

        if (action === step.action && uiTarget === step.uiTarget) return step;
        return {
            ...step,
            action,
            result: {
                ...step.result,
                action,
            },
            semantic: updateSemantic(step.semantic, action),
            ...(uiTarget ? { uiTarget } : {}),
        };
    });

    if (changes.length === 0) {
        return { workflow, changes };
    }

    return {
        workflow: {
            ...workflow,
            expectedWindowTitle,
            steps,
        },
        changes,
    };
}

function parameterizeUiTarget(
    target: RecordedUiTarget | undefined,
    input: {
        originalTask: string;
        task: string;
        preferredApp: KnownApp | null;
        windowTitle: string | null;
        stepIndex: number;
        changes: ParameterizationChange[];
    }
): RecordedUiTarget | undefined {
    if (!target) return target;

    let next = target;

    if (target.windowTitle && input.windowTitle && input.windowTitle !== target.windowTitle && shouldReplaceWindowTitle(target.windowTitle, input.task, input.preferredApp)) {
        input.changes.push({
            stepIndex: input.stepIndex,
            field: 'uiTarget.windowTitle',
            from: target.windowTitle,
            to: input.windowTitle,
        });
        next = { ...next, windowTitle: input.windowTitle };
    }

    if (target.query) {
        const query = inferReplacementValue(input.originalTask, target.query, input.task);
        if (query && query !== target.query) {
            input.changes.push({ stepIndex: input.stepIndex, field: 'uiTarget.query', from: target.query, to: query });
            next = { ...next, query };
        }
    }

    if (target.text) {
        const text = inferReplacementValue(input.originalTask, target.text, input.task);
        if (text && text !== target.text) {
            input.changes.push({ stepIndex: input.stepIndex, field: 'uiTarget.text', from: target.text, to: text });
            next = { ...next, text };
        }
    }

    return next;
}

function parameterizeAction(
    action: DesktopAction,
    input: {
        originalTask: string;
        task: string;
        preferredApp: KnownApp | null;
        launchCommand: string | null;
        windowTitle: string | null;
        platform: DesktopPlatform;
        stepIndex: number;
        changes: ParameterizationChange[];
    }
): DesktopAction {
    if (action.type === 'typeText') {
        const nextText = inferReplacementValue(input.originalTask, action.text, input.task);
        if (nextText && nextText !== action.text) {
            input.changes.push({ stepIndex: input.stepIndex, field: 'typeText.text', from: action.text, to: nextText });
            return { ...action, text: nextText };
        }
        return action;
    }

    if (action.type === 'launchApp') {
        let next: DesktopAction = action;

        const recordedApp = detectAppFromLaunchCommand(action.command);
        if (input.launchCommand && shouldReplaceLaunchCommand(action.command, recordedApp, input.preferredApp, input.platform)) {
            input.changes.push({
                stepIndex: input.stepIndex,
                field: 'launchApp.command',
                from: action.command,
                to: input.launchCommand,
            });
            next = { ...next, command: input.launchCommand };
        } else if (!recordedApp) {
            const nextCommand = inferReplacementValue(input.originalTask, action.command, input.task);
            if (nextCommand && nextCommand !== action.command) {
                input.changes.push({
                    stepIndex: input.stepIndex,
                    field: 'launchApp.command',
                    from: action.command,
                    to: nextCommand,
                });
                next = { ...next, command: nextCommand };
            }
        }

        if (action.args && action.args.length > 0) {
            const nextArgs = action.args.map((arg) => inferReplacementValue(input.originalTask, arg, input.task) ?? arg);
            if (!sameStringArray(nextArgs, action.args)) {
                input.changes.push({
                    stepIndex: input.stepIndex,
                    field: 'launchApp.args',
                    from: action.args.join(' '),
                    to: nextArgs.join(' '),
                });
                next = { ...next, args: nextArgs };
            }
        }

        return next;
    }

    if (action.type === 'focusWindow') {
        if (input.windowTitle && input.windowTitle !== action.title && shouldReplaceWindowTitle(action.title, input.task, input.preferredApp)) {
            input.changes.push({
                stepIndex: input.stepIndex,
                field: 'focusWindow.title',
                from: action.title,
                to: input.windowTitle,
            });
            return { ...action, title: input.windowTitle };
        }

        if (!isGenericAppTitle(action.title)) {
            const nextTitle = inferReplacementValue(input.originalTask, action.title, input.task);
            if (nextTitle && nextTitle !== action.title) {
                input.changes.push({
                    stepIndex: input.stepIndex,
                    field: 'focusWindow.title',
                    from: action.title,
                    to: nextTitle,
                });
                return { ...action, title: nextTitle };
            }
        }
    }

    return action;
}

function inferReplacementValue(originalTask: string, originalValue: string, newTask: string): string | null {
    const value = originalValue.trim();
    if (!value) return null;

    const quoted = inferFromQuotedOrdinal(originalTask, value, newTask);
    if (quoted) return quoted;

    const byContext = inferBySurroundingContext(originalTask, value, newTask);
    if (byContext) return byContext;

    const byCue = inferByCueBeforeValue(originalTask, value, newTask);
    if (byCue) return byCue;

    return null;
}

function inferFromQuotedOrdinal(originalTask: string, originalValue: string, newTask: string): string | null {
    const originalQuotes = extractQuotedSpans(originalTask);
    const newQuotes = extractQuotedSpans(newTask);
    if (newQuotes.length === 0) return null;

    const idx = originalQuotes.findIndex((q) => stringEqualsLoose(q, originalValue));
    if (idx >= 0 && newQuotes[idx]) return newQuotes[idx]!.trim();

    if (originalQuotes.length === 1 && stringEqualsLoose(originalQuotes[0]!, originalValue) && newQuotes.length === 1) {
        return newQuotes[0]!.trim();
    }

    return null;
}

function inferBySurroundingContext(originalTask: string, originalValue: string, newTask: string): string | null {
    const idx = indexOfLoose(originalTask, originalValue);
    if (idx < 0) return null;

    const prefix = normalizeWhitespace(originalTask.slice(0, idx));
    const suffix = normalizeWhitespace(originalTask.slice(idx + originalValue.length));
    const prefixAnchor = lastWords(prefix, 8);
    const suffixAnchor = firstWords(suffix, 8);
    const normalizedNew = normalizeWhitespace(newTask);

    const start = prefixAnchor ? indexAfterLoose(normalizedNew, prefixAnchor) : 0;
    if (start < 0) return null;

    const end = suffixAnchor ? indexOfLoose(normalizedNew.slice(start), suffixAnchor) : -1;
    const candidate = (end >= 0 ? normalizedNew.slice(start, start + end) : normalizedNew.slice(start)).trim();
    return cleanExtractedValue(candidate);
}

function inferByCueBeforeValue(originalTask: string, originalValue: string, newTask: string): string | null {
    const idx = indexOfLoose(originalTask, originalValue);
    if (idx < 0) return null;

    const before = originalTask.slice(0, idx).toLowerCase();
    const cues = [
        'write',
        'type',
        'enter',
        'search for',
        'search',
        'message',
        'subject',
        'filename',
        'file named',
        'named',
        'called',
        'command',
    ];

    let selected: string | null = null;
    let selectedIndex = -1;
    for (const cue of cues) {
        const cueIdx = before.lastIndexOf(cue);
        if (cueIdx > selectedIndex) {
            selected = cue;
            selectedIndex = cueIdx;
        }
    }

    if (!selected) return null;

    const pattern = new RegExp(`\\b${escapeRegExp(selected).replace(/\\ /g, '\\s+')}\\b`, 'i');
    const match = pattern.exec(newTask);
    if (!match || match.index === undefined) return null;

    const start = match.index + match[0].length;
    return cleanExtractedValue(newTask.slice(start));
}

function cleanExtractedValue(raw: string): string | null {
    let value = raw
        .trim()
        .replace(/^[\s:="'`]+/, '')
        .replace(/[\s"'`]+$/, '')
        .trim();

    value = value.replace(/\s+(?:in|into|on|using|with)\s+(?:notepad|textedit|text edit|chrome|edge|browser|outlook|excel|word|powerpoint|calculator)\.?$/i, '').trim();
    value = value.replace(/\s+(?:and then|then)\s+.+$/i, '').trim();

    return value.length > 0 ? value : null;
}

function extractQuotedSpans(input: string): string[] {
    const out: string[] = [];
    const re = /"([^"]+)"|'([^']+)'|`([^`]+)`|“([^”]+)”|‘([^’]+)’/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input))) {
        const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
        if (value && value.trim()) out.push(value.trim());
    }
    return out;
}

function detectPrimaryApp(task: string): KnownApp | null {
    const t = task.toLowerCase();

    const checks: Array<[KnownApp, RegExp]> = [
        ['textedit', /\btext\s*edit\b|\btextedit\b/],
        ['notepad', /\bnotepad\b|\bplain\s+text\s+editor\b/],
        ['chrome', /\bgoogle\s+chrome\b|\bchrome\b/],
        ['edge', /\bmicrosoft\s+edge\b|\bedge\b/],
        ['outlook', /\boutlook\b|\be-?mail\b|\bmail\b/],
        ['excel', /\bexcel\b|\.xlsx\b/],
        ['word', /\bword\b|\.docx\b/],
        ['powerpoint', /\bpower\s*point\b|\bpowerpoint\b|\.pptx\b/],
        ['vscode', /\bvisual\s+studio\s+code\b|\bvs\s*code\b|\bvscode\b/],
        ['calculator', /\bcalculator\b|\bcalc\b/],
        ['cmd', /\bcommand\s+prompt\b|\bcmd(?:\.exe)?\b/],
        ['terminal', /\bterminal\b|\biterm\b/],
        ['browser', /\bbrowser\b|\bwebsite\b|https?:\/\//],
    ];

    for (const [app, pattern] of checks) {
        if (pattern.test(t)) return app;
    }

    return null;
}

function detectAppFromLaunchCommand(command: string): KnownApp | null {
    const c = command.toLowerCase();
    if (/\btext\s*edit\b|\btextedit\b/.test(c)) return 'textedit';
    if (/\bnotepad(?:\.exe)?\b/.test(c)) return 'notepad';
    if (/\bgoogle\s+chrome\b|\bchrome(?:\.exe)?\b/.test(c)) return 'chrome';
    if (/\bmicrosoft\s+edge\b|\bmsedge(?:\.exe)?\b|\bedge\b/.test(c)) return 'edge';
    if (/\boutlook(?:\.exe)?\b|\bmicrosoft\s+outlook\b/.test(c)) return 'outlook';
    if (/\bexcel(?:\.exe)?\b|\bmicrosoft\s+excel\b/.test(c)) return 'excel';
    if (/\bwinword(?:\.exe)?\b|\bmicrosoft\s+word\b|\bword\b/.test(c)) return 'word';
    if (/\bpowerpnt(?:\.exe)?\b|\bmicrosoft\s+powerpoint\b|\bpowerpoint\b/.test(c)) return 'powerpoint';
    if (/\bcode(?:\.exe)?\b|\bvisual\s+studio\s+code\b/.test(c)) return 'vscode';
    if (/\bcalc(?:\.exe)?\b|\bcalculator\b/.test(c)) return 'calculator';
    if (/\bcmd(?:\.exe)?\b|\bcommand\s+prompt\b/.test(c)) return 'cmd';
    if (/\bterminal\b|\biterm\b/.test(c)) return 'terminal';
    if (/\bbrowser\b/.test(c)) return 'browser';
    return null;
}

function shouldReplaceLaunchCommand(
    command: string,
    recordedApp: KnownApp | null,
    preferredApp: KnownApp | null,
    platform: DesktopPlatform
): boolean {
    if (!preferredApp) return false;
    if (recordedApp) return recordedApp !== preferredApp || commandForApp(recordedApp, platform) !== command;
    return false;
}

function shouldReplaceWindowTitle(title: string, task: string, preferredApp: KnownApp | null): boolean {
    if (!preferredApp) return false;
    if (containsDocumentName(title)) return Boolean(extractDocumentTitle(task));
    return detectAppFromLaunchCommand(title) !== null || isGenericAppTitle(title);
}

function inferExpectedWindowTitle(task: string, app: KnownApp | null, platform: DesktopPlatform): string | null {
    const documentTitle = extractDocumentTitle(task);
    if (documentTitle) return documentTitle;
    if (!app) return null;
    return windowTitleForApp(app, platform);
}

function extractDocumentTitle(task: string): string | null {
    const m = task.match(/([A-Za-z0-9 _.-]+)\.(xlsx|docx|pptx|txt|pdf)\b/i);
    if (!m?.[1]) return null;
    return m[1].trim();
}

function commandForApp(app: KnownApp, platform: DesktopPlatform): string {
    const mac = platform === 'darwin';
    const map: Record<KnownApp, string> = {
        browser: mac ? 'Safari' : 'Microsoft Edge',
        calculator: 'Calculator',
        chrome: mac ? 'Google Chrome' : 'Google Chrome',
        cmd: mac ? 'Terminal' : 'Command Prompt',
        edge: 'Microsoft Edge',
        excel: mac ? 'Microsoft Excel' : 'Excel',
        notepad: mac ? 'TextEdit' : 'Notepad',
        outlook: mac ? 'Microsoft Outlook' : 'Outlook',
        powerpoint: mac ? 'Microsoft PowerPoint' : 'PowerPoint',
        terminal: mac ? 'Terminal' : 'Command Prompt',
        textedit: mac ? 'TextEdit' : 'Notepad',
        word: mac ? 'Microsoft Word' : 'Word',
        vscode: 'Visual Studio Code',
    };
    return map[app];
}

function windowTitleForApp(app: KnownApp, platform: DesktopPlatform): string {
    const command = commandForApp(app, platform);
    if (platform === 'darwin' && command.startsWith('Microsoft ')) {
        return command.replace(/^Microsoft\s+/, '');
    }
    if (app === 'cmd' && platform !== 'darwin') return 'Command Prompt';
    return command;
}

function updateSemantic(semantic: string | undefined, action: DesktopAction): string | undefined {
    if (!semantic) return semantic;
    if (action.type === 'typeText') return `Type text (${action.text.length} chars)`;
    if (action.type === 'launchApp') return `Launch app: ${action.command}`;
    if (action.type === 'focusWindow') return `Focus window: ${action.title}`;
    return semantic;
}

function containsDocumentName(title: string): boolean {
    return /\.(xlsx|docx|pptx|txt|pdf)\b/i.test(title);
}

function isGenericAppTitle(title: string): boolean {
    return detectAppFromLaunchCommand(title) !== null;
}

function indexOfLoose(input: string, needle: string): number {
    return normalizeWhitespace(input).toLowerCase().indexOf(normalizeWhitespace(needle).toLowerCase());
}

function indexAfterLoose(input: string, needle: string): number {
    const idx = indexOfLoose(input, needle);
    return idx < 0 ? -1 : idx + normalizeWhitespace(needle).length;
}

function stringEqualsLoose(a: string, b: string): boolean {
    return normalizeWhitespace(a).toLowerCase() === normalizeWhitespace(b).toLowerCase();
}

function normalizeWhitespace(input: string): string {
    return input.replace(/\s+/g, ' ').trim();
}

function firstWords(input: string, count: number): string {
    return input.split(' ').filter(Boolean).slice(0, count).join(' ');
}

function lastWords(input: string, count: number): string {
    const words = input.split(' ').filter(Boolean);
    return words.slice(Math.max(0, words.length - count)).join(' ');
}

function sameStringArray(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

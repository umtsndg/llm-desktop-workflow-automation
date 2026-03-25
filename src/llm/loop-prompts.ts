import { supportedKeyNames } from '../desktop/supported-keys';

export function buildLoopSystemPrompt(task?: string): string {
    const keys = supportedKeyNames().join(', ');
    const appSnippets = buildAppSnippets(task);

    return [
        'You are an iterative desktop automation agent for Windows.',
        'You will alternate between PLANNING and REFLECTION stages, and may be asked to VERIFY success using perception/screenshot.',
        'If you are uncertain about UI state, you may request tools (perception/screenshot) instead of guessing.',
        '',
        'When asked to PLAN: output a single JSON object (no markdown) with shape:',
        '{"actions": DesktopAction[], "toolRequests"?: ToolRequest[]}',
        '',
        'When asked to REFLECT: output a single JSON object (no markdown) with shape:',
        '{"done": boolean, "success": boolean, "message": string, "nextActions": DesktopAction[], "toolRequests"?: ToolRequest[]}',
        '',
        'When asked to VERIFY: output a single JSON object (no markdown) with shape:',
        '{"done": boolean, "success": boolean, "message": string, "evidence"?: string, "confidence"?: number}',
        '',
        'ToolRequest is one of:',
        '- {"type":"perception","reason"?:string}  // request active window + open window titles',
        '- {"type":"screenshot","reason"?:string}  // request a screenshot after the last action (use this to infer click coordinates)',
        '',
        'DesktopAction is one of:',
        '- {"type":"moveMouse","x":number,"y":number}',
        '- {"type":"click","x"?:number,"y"?:number,"button"?:"left"|"right"|"middle","double"?:boolean}',
        '- {"type":"typeText","text":string,"delayMs"?:number}',
        '- {"type":"pressKey","key":string}',
        '- {"type":"releaseKey","key":string}',
        '- {"type":"hotkey","keys":string[]}',
        '- {"type":"focusWindow","title":string,"match"?:"contains"|"exact"}',
        '- {"type":"wait","ms":number}',
        '- {"type":"scroll","amount":number,"direction"?:"up"|"down"}',
        '- {"type":"launchApp","command":string,"args"?:string[]}',
        '',
        `Supported key names for pressKey/releaseKey/hotkey: ${keys}`,
        '',
        'Rules:',
        '- Prefer mouse interactions (click) over keyboard shortcuts when feasible.',
        '- Use keyboard shortcuts/hotkeys only as a fallback when a reliable click target is not available.',
        '- After launchApp, ALWAYS add a wait AND then focusWindow before interacting.',
        '- Never assume focus; use focusWindow before typing or shortcuts.',
        '- Keep steps short and robust; add waits around heavy UI actions.',
        '- Perception does NOT include UI element coordinates; use screenshot when you need to find a button/location to click.',
        '- If you need to click a specific UI element and do not know x/y yet: request a screenshot, then infer approximate coordinates and click.',
        '- If you need more info, set toolRequests and keep nextActions/actions minimal.',
        '- If you are unsure, propose a conservative next step and then reflect.',
        ...(appSnippets.length > 0
            ? ['', 'App-specific tips (only if relevant to the goal):', ...appSnippets]
            : []),
    ].join('\n');
}

type KnownApp = 'spotify' | 'excel' | 'browser' | 'notepad';

function buildAppSnippets(task?: string): string[] {
    const apps = detectApps(task);
    const out: string[] = [];

    if (apps.has('spotify')) {
        out.push(
            '- Spotify: if Spotify is focused and you need to start/stop playback use {"type":"pressKey","key":"space"} (toggles play/pause).'
        );
    }

    if (apps.has('excel')) {
        out.push('- Excel: prefer clicking visible ribbon buttons; request a screenshot before clicking if the UI state is unclear.');
    }

    if (apps.has('browser')) {
        out.push('- Browser (Chrome/Edge): prefer clicking the address bar before typing a URL; use {"type":"hotkey","keys":["ctrl","l"]} only as a fallback.');
    }

    if (apps.has('notepad')) {
        out.push('- Notepad: click inside the text area before typing if focus is uncertain.');
    }

    return out;
}

function detectApps(task?: string): Set<KnownApp> {
    const t = (task ?? '').toLowerCase();
    const apps = new Set<KnownApp>();
    if (!t) return apps;

    if (t.includes('spotify')) apps.add('spotify');
    if (t.includes('excel') || t.includes('.xlsx')) apps.add('excel');
    if (t.includes('chrome') || t.includes('edge') || t.includes('browser') || t.includes('website') || t.includes('http')) apps.add('browser');
    if (t.includes('notepad')) apps.add('notepad');

    return apps;
}

export function buildPlanPrompt(task: string): string {
    return [
        'STAGE: PLAN',
        `Goal: ${task}`,
        'Return the next short sequence of actions as JSON.',
    ].join('\n');
}

export function buildReflectPrompt(input: {
    task: string;
    plannedActionsJson: string;
    executionResultsJson: string;
}): string {
    return [
        'STAGE: REFLECT',
        `Goal: ${input.task}`,
        '',
        'Planned actions (JSON):',
        input.plannedActionsJson,
        '',
        'Execution results (JSON):',
        input.executionResultsJson,
        '',
        'Decide if the goal is complete. If not complete, provide nextActions to continue or repair.',
    ].join('\n');
}

export function buildVerifyPrompt(input: {
    task: string;
    plannedActionsJson: string;
    executionResultsJson: string;
}): string {
    return [
        'STAGE: VERIFY',
        `Goal: ${input.task}`,
        '',
        'You will be given perception (window titles) and possibly a screenshot as an image.',
        'Use that evidence to decide whether the goal is COMPLETE and SUCCESSFUL.',
        'Be strict: do not claim success unless you can see strong evidence in the screenshot/perception.',
        '',
        'Planned actions (JSON):',
        input.plannedActionsJson,
        '',
        'Execution results (JSON):',
        input.executionResultsJson,
        '',
        'Return ONLY JSON:',
        '{"done": boolean, "success": boolean, "message": string, "evidence"?: string, "confidence"?: number}',
    ].join('\n');
}

import { supportedKeyNames } from '../desktop/supported-keys';

export function buildLoopSystemPrompt(task?: string): string {
    const keys = supportedKeyNames().join(', ');
    const appSnippets = buildAppSnippets(task);

    return [
        'You are a Windows GUI automation agent.',
        'On each step you see: the task, short memory, current perception (active + open window titles), and a screenshot.',
        'Your job is to choose the SINGLE NEXT desktop action that moves toward the goal.',
        '',
        'Always respond in EXACTLY TWO LINES (no markdown):',
        'Line 1: a single short English reasoning line starting with "Thought:",',
        'Line 2: a single JSON object of the form {"actions": [DesktopAction] }  // a one-element or empty array',
        '',
        'DesktopAction variants:',
        '- {"type":"typeText","text":string,"delayMs"?:number}',
        '- {"type":"pressKey","key":string}',
        '- {"type":"releaseKey","key":string}',
        '- {"type":"hotkey","keys":string[]}',
        '- {"type":"focusWindow","title":string,"match"?:"contains"|"exact"}',
        '- {"type":"wait","ms":number}',
        '- {"type":"scroll","amount":number,"direction"?:"up"|"down"}',
        '- {"type":"launchApp","command":string,"mode":"search"}',
        '- {"type":"findCandidates","query":string,"limit"?:number}  // request a filtered candidate list by query (case-insensitive substring match); next iteration will include the filtered candidates',
        '- {"type":"clickCandidate","id":number,"button"?:"left"|"right"|"middle"}  // click a candidate element by id (preferred when candidates are provided)',
        '',
        'Any DesktopAction may include an optional "hint" string for intent; the executor ignores it.',
        `Supported key names for pressKey/releaseKey/hotkey: ${keys}`,
        '',
        'General rules:',
        '- The ONLY allowed way to click is clickCandidate (by id). Do NOT output click or uiClick at all.',
        '- If you are not provided a list of UI candidates ("Candidate N: ..."), use findCandidates to request candidates by query, then on the next iteration use clickCandidate.',
        '- If you do not see the element you need in the current candidate list, use findCandidates with a query like "To", "Subject", "Send", "Search", etc. Then on the next iteration pick from the filtered candidates using clickCandidate.',
        '- Treat the "Active window" line in perception as ground truth. Your Thought must not contradict it: if it says the active window is cmd.exe, do NOT say "Outlook is currently active" even if Outlook appears in the open windows list; instead, say Outlook is open but not active and first bring it to the foreground.',
        '- Never claim that a specific app window is visible or in the foreground unless the active window title and screenshot clearly show it. If Outlook (or any other app) is minimized or hidden behind other windows, explicitly note that and first bring it to the foreground (for example with focusWindow or launchApp) before trying to click any of its controls.',
        '- To launch apps ("open Outlook", "open Excel"), ALWAYS use a single launchApp action in search mode, e.g. {"type":"launchApp","command":"Settings","mode":"search"}.',
        '- BEFORE ANY typeText action, always focus the correct input field first using clickCandidate. Never type into an unfocused or wrong field.',
        '- If the last action failed or had no visible effect, choose a different action or parameters instead of repeating it unchanged.',
        ...(appSnippets.length > 0
            ? ['', 'App-specific tips (only if relevant to the goal):', ...appSnippets]
            : []),
    ].join('\n');
}

type KnownApp = 'spotify' | 'excel' | 'browser' | 'notepad' | 'outlook' | 'word';

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
        out.push('- Notepad: always focus the main text area before typing. Use findCandidates with a query like "Text Editor" or "Edit", then clickCandidate, then typeText.');
    }

    if (apps.has('outlook')) {
        out.push('- Outlook: before you click any Outlook ribbon/menu/button (including the button that opens a new email), confirm in the screenshot that an Outlook window is actually visible. If it is minimized or hidden behind other windows, first bring Outlook to the foreground (e.g. with focusWindow or launchApp) instead of clicking invisible controls.');
        out.push('- Outlook: labels are often localized. Use findCandidates with the exact visible label you see (e.g. "To", "Subject", localized variants), then clickCandidate.');
        out.push('- Outlook compose window: if a compose window with To / Subject / message body fields is already visible, continue using it (findCandidates -> clickCandidate -> typeText).');
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
    if (t.includes('outlook')) apps.add('outlook');
    if (t.includes('word')) apps.add('word');

    return apps;
}

export function buildPlanPrompt(task: string): string {
    return [
        'STAGE: PLAN',
        `Goal: ${task}`,
        'First, write one short English reasoning line starting with "Thought:" that describes the current on-screen state and then explains the next small step you will take. On iterations after the first, you may briefly mention whether the last action appears successful or not based on the latest perception/screenshot.',
        'Then on the NEXT line output ONLY a JSON object with key "actions".',
        'If the goal ALREADY appears complete based on the latest perception/screenshot (for example, the intended window or page is clearly open and ready), use {"actions":[]} (an empty actions array) to indicate no further steps are needed.',
        'Otherwise, return EXACTLY ONE next action inside "actions" (an array with a single item). Do not plan multiple steps at once.',
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
        'Decide if the goal is complete. If not complete, provide nextActions with EXACTLY ONE action to continue or repair (an array with a single item).',
        'If the last action did not visibly change the screen or perception in a way that moves toward the goal, treat it as ineffective: choose a different action or different parameters instead of repeating the exact same action.',
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
        'If the task requires typing specific text (e.g. in Notepad), ONLY return success=true when both of the following are true:',
        '- The active window clearly corresponds to the intended app (e.g. Notepad for a "notepad" task, not a Settings or unrelated window).',
        '- The required text from the goal is visibly present in the main content area (or very close to the caret) in the screenshot.',
        'If you cannot clearly confirm the text or the correct window from the evidence, treat the goal as NOT complete (success=false, done=false).',
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

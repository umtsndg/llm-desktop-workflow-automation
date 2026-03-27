import { supportedKeyNames } from '../desktop/supported-keys';

export function buildLoopSystemPrompt(task?: string): string {
    const keys = supportedKeyNames().join(', ');
    const appSnippets = buildAppSnippets(task);

    return [
        'You are an iterative desktop automation agent for Windows.',
        'You will repeatedly be asked to PLAN the SINGLE NEXT desktop action.',
        'For every PLAN call you will ALWAYS receive the latest perception (active window + open window titles) and a screenshot image of the desktop; do not request additional tools.',
        '',
        'When asked to PLAN: output a single JSON object (no markdown) with shape:',
        '{"actions": DesktopAction[]}',
        '',
        'DesktopAction is one of:',
        '- {"type":"moveMouse","x":number,"y":number} OR {"type":"moveMouse","nx":number,"ny":number}  // nx,ny are normalized in [0,1] relative to the full screen (0,0=top-left, 1,1=bottom-right). Use this mainly for generic areas (e.g. scroll regions or canvas) when there is no well-named UI element to target. For UI controls with labels, prefer uiClick instead of guessing coordinates.',
        '- {"type":"click","x"?:number,"y"?:number,"nx"?:number,"ny"?:number,"button"?:"left"|"right"|"middle","double"?:boolean}  // use this when you truly must click at a raw coordinate (e.g. image canvas or unlabeled region). For normal buttons/menus/text fields, prefer uiClick so the executor can locate the control by its name.',
        '- {"type":"typeText","text":string,"delayMs"?:number}',
        '- {"type":"pressKey","key":string}',
        '- {"type":"releaseKey","key":string}',
        '- {"type":"hotkey","keys":string[]}',
        '- {"type":"focusWindow","title":string,"match"?:"contains"|"exact"}',
        '- {"type":"wait","ms":number}',
        '- {"type":"scroll","amount":number,"direction"?:"up"|"down"}',
        '- {"type":"launchApp","command":string,"args"?:string[]}',
        '- {"type":"uiClick","windowTitle":string,"controlName":string,"controlType"?:"Button"|"MenuItem"|"Edit"}  // use Windows UI Automation to locate a named control inside a window (e.g. Notepad, Outlook, Word) and click its center. This is the PREFERRED way to interact with buttons, menu items, ribbon controls, and text boxes when you know their visible labels.',
        '',
        'Optional: any DesktopAction may include a "hint" string to describe the intent/target (used for semantic recording; executor ignores it).',
        '',
        `Supported key names for pressKey/releaseKey/hotkey: ${keys}`,
        '',
        'Rules:',
        '- Prefer mouse interactions (click) over keyboard shortcuts when feasible; use pressKey/hotkey as a fallback when they are clearly appropriate (e.g. known shortcuts like Ctrl+L in a browser).',
        '- When you want to interact with a UI CONTROL that has a visible label (button text, menu item text, ribbon label, or text-box name), FIRST try to use uiClick with an appropriate windowTitle substring and the EXACT controlName text from the UI instead of guessing coordinates.',
        '- Use the screenshot you are given to visually understand which control to target and to read its label, but let uiClick resolve the actual screen location via UI Automation. Only fall back to raw moveMouse/click coordinates when no suitable named element exists (for example, on a drawing canvas or unlabeled region).',
        '- If you must use raw coordinates, prefer normalized nx,ny in [0,1] for targeting: 0,0 is the top-left of the full desktop, 1,1 is the bottom-right. For example, the exact center is nx=0.5, ny=0.5; the top menu bar is typically around ny≈0.05; the bottom taskbar is near ny≈0.95.',
        '- When you need absolute pixel coordinates x,y, use the explicit screen resolution (Screen: width=..., height=...) to convert from nx,ny into pixels (x≈nx*width, y≈ny*height).',
        '- For launching applications (e.g. "open Outlook", "open Excel"), ALWAYS use the Windows Start/search UI instead of launchApp: first press the Windows key (pressKey with key="meta"), then type the application name (typeText, e.g. "outlook"), then press enter (pressKey with key="enter").',
        '- Only use launchApp as a fallback when repeatedly opening via Windows search (meta -> type app name -> enter) has clearly failed.',
        '- To open Windows Start/search you do NOT need to click the taskbar; simply press the Windows key (meta). While the Start/search UI is open, AVOID using mouse clicks to open the app (clicking search results or the taskbar can close search). Instead, rely on typing the app name and pressing enter to launch it.',
        '- After launching or focusing an application, ALWAYS add a wait AND then focusWindow before interacting.',
        '- Before typing into an editor or text box (e.g. Notepad, Word, browser text fields), first CLICK inside the main text area to place the caret. Use the screenshot to visually locate this text region and choose coordinates (preferably nx,ny) that fall clearly inside it.',
        '- When an element is small or hard to see, click near the center of its visible region rather than at the extreme edge, and in subsequent iterations adjust nx,ny slightly if your previous click was off.',
        '- Never assume focus; use focusWindow before typing.',
        '- If any previous action failed (ok:false or has an error), you MUST treat the goal as not complete and adjust your nextActions to repair the failure instead of repeating the exact same sequence.',
        '- Keep steps short and robust; add waits around heavy UI actions.',
        '- Use provided screenshots to choose precise coordinates using the desktop resolution for clicks',
        '- If you are unsure, propose a conservative next step and then reflect.',
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
        out.push('- Notepad: always click inside the main text area before typing to ensure the caret is in the document, not in a menu or settings pane. Use {"type":"uiClick","windowTitle":"Notepad","controlName":"Text Editor","controlType":"Edit"} when the generic text editor control is available; otherwise click a visible empty area in the document region using normalized coordinates.');
    }

    if (apps.has('outlook')) {
        out.push('- Outlook: avoid guessing ribbon coordinates. Prefer using {"type":"uiClick"} with windowTitle set to a substring like "Outlook" and controlName set to the EXACT visible label of the control (in your current language). For example, to press the New Mail button in the Inbox, use something like {"type":"uiClick","windowTitle":"Outlook","controlName":"Yeni Posta"} on Turkish UIs or {"type":"uiClick","windowTitle":"Outlook","controlName":"New Mail"} on English UIs.');
        out.push('- Outlook compose window: before typing the RECIPIENT, click the "To" area. Before typing the SUBJECT, click the subject line (e.g. the area labeled "Add a subject"). Before typing the MESSAGE BODY, click clearly inside the large message body region (not in the To/Subject lines). NEVER type subject or body text into the recipient (To) field.');
        out.push('- Outlook Send button: to send a composed email, prefer {"type":"uiClick","windowTitle":"Outlook","controlName":"Send"} instead of approximate screen coordinates. Make sure the compose window is active and the message content is ready before clicking Send.');
    }

    if (apps.has('word')) {
        out.push('- Word: for ribbon or menu items (e.g. "File", "Home"), prefer {"type":"uiClick","windowTitle":"Word","controlName":"File","controlType":"MenuItem"} instead of approximate screen coordinates, using the exact visible label in your UI language.');
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
        'If the goal ALREADY appears complete based on the latest perception/screenshot (for example, the intended window or page is clearly open and ready), return {"actions":[]} (an empty actions array) to indicate no further steps are needed.',
        'Otherwise, return EXACTLY ONE next action as JSON ("actions" array with a single item). Do not plan multiple steps at once.',
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

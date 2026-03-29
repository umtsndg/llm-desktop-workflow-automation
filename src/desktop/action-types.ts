export type MouseButton = 'left' | 'right' | 'middle';

type ActionHint = {
    // Optional semantic hint from the planner/agent (helps semantic recording).
    // Executor ignores this field.
    hint?: string;
};

export type DesktopAction =
    | ({ type: 'typeText'; text: string; delayMs?: number } & ActionHint)
    | ({ type: 'pressKey'; key: string } & ActionHint)
    | ({ type: 'releaseKey'; key: string } & ActionHint)
    | ({ type: 'hotkey'; keys: string[] } & ActionHint)
    | ({ type: 'focusWindow'; title: string; match?: 'contains' | 'exact' } & ActionHint)
    | ({ type: 'wait'; ms: number } & ActionHint)
    | ({ type: 'scroll'; amount: number; direction?: 'up' | 'down' } & ActionHint)
    | ({ type: 'launchApp'; command: string; args?: string[]; mode?: 'shell' | 'search' } & ActionHint)
    | ({ type: 'click'; button?: MouseButton; x?: number; y?: number; nx?: number; ny?: number; } & ActionHint)
    | ({
        type: 'uiClick';
        /** Window title or substring used to identify the top-level window, e.g. "Notepad", "Outlook", "Word". */
        windowTitle: string;
        /** Exact control name as exposed by UI Automation (e.g. button or menu item name). */
        controlName: string;
        /** If true, this click is intended to focus a text-editable area; the target UI element must have IsTextEditPatternAvailable = true. */
        wantToText?: boolean;
    } & ActionHint);

export type DesktopObservation = {
    screenshotBase64: string;
    timestamp: string;
    width?: number;
    height?: number;
};

export type ExecutionResult = {
    ok: boolean;
    action: DesktopAction;
    error?: string;
    executedAt: string;
};
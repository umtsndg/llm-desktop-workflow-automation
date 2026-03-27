export type MouseButton = 'left' | 'right' | 'middle';

type ActionHint = {
    // Optional semantic hint from the planner/agent (helps semantic recording).
    // Executor ignores this field.
    hint?: string;
};

export type DesktopAction =
    | ({ type: 'moveMouse'; x?: number; y?: number; nx?: number; ny?: number } & ActionHint)
    | ({ type: 'click'; x?: number; y?: number; nx?: number; ny?: number; button?: MouseButton; double?: boolean } & ActionHint)
    | ({ type: 'typeText'; text: string; delayMs?: number } & ActionHint)
    | ({ type: 'pressKey'; key: string } & ActionHint)
    | ({ type: 'releaseKey'; key: string } & ActionHint)
    | ({ type: 'hotkey'; keys: string[] } & ActionHint)
    | ({ type: 'focusWindow'; title: string; match?: 'contains' | 'exact' } & ActionHint)
    | ({ type: 'wait'; ms: number } & ActionHint)
    | ({ type: 'scroll'; amount: number; direction?: 'up' | 'down' } & ActionHint)
    | ({ type: 'launchApp'; command: string; args?: string[] } & ActionHint)
    | ({
        type: 'uiClick';
        /** Window title or substring used to identify the top-level window, e.g. "Notepad", "Outlook", "Word". */
        windowTitle: string;
        /** Exact control name as exposed by UI Automation (e.g. button or menu item name). */
        controlName: string;
        /** Optional UIA control type hint to narrow search, e.g. "Button" | "MenuItem" | "Edit". */
        controlType?: 'Button' | 'MenuItem' | 'Edit';
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
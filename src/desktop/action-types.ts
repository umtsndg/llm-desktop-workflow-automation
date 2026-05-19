export type MouseButton = 'left' | 'right' | 'middle';

type ActionHint = {
    // Optional semantic hint from the planner/agent (helps semantic recording).
    // Executor ignores this field.
    hint?: string;
};

export type DesktopAction =
    | ({ type: 'typeText'; text: string } & ActionHint)
    | ({ type: 'pressKey'; key: string } & ActionHint)
    | ({ type: 'releaseKey'; key: string } & ActionHint)
    | ({ type: 'hotkey'; keys: string[] } & ActionHint)
    | ({ type: 'focusWindow'; title: string; match?: 'contains' | 'exact' } & ActionHint)
    | ({ type: 'wait'; ms: number } & ActionHint)
    | ({ type: 'scroll'; amount: number; direction?: 'up' | 'down' } & ActionHint)
    | ({ type: 'launchApp'; command: string; args?: string[]; mode?: 'shell' | 'search' } & ActionHint)
    | ({ type: 'findCandidates'; query: string; limit?: number } & ActionHint)
    | ({ type: 'click'; button?: MouseButton; x?: number; y?: number; nx?: number; ny?: number; } & ActionHint)
    | ({ type: 'clickCandidate'; id: number; button?: MouseButton } & ActionHint)
    | ({
        type: 'uiClick';
        /** Window title or substring used to identify the top-level window, e.g. "TextEdit", "Outlook", "Word". */
        windowTitle: string;
        /** Exact control name as exposed by UI Automation (e.g. button or menu item name). */
        controlName: string;
        /** Optional UI Automation AutomationId for the control, if known. */
        automationId?: string;
        /** Optional ClassName filter for the control, if known. */
        className?: string;
        /** Finder intent hint; controls scoring and pattern preferences. Defaults to "Text" when wantToText=true, otherwise "Any". */
        intent?: 'Any' | 'Text' | 'Button' | 'ListItem' | 'CheckBox' | 'ComboBox' | 'Tab' | 'Window';
        /** Allow partial name matches when ControlName is provided. Defaults to true. */
        allowPartialName?: boolean;
        /** If true, restrict to keyboard-focusable elements. Defaults to true when wantToText=true, otherwise false. */
        requireKeyboardFocusable?: boolean;
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

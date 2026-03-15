export type MouseButton = 'left' | 'right' | 'middle';

export type DesktopAction =
    | { type: 'moveMouse'; x: number; y: number }
    | { type: 'click'; x?: number; y?: number; button?: MouseButton; double?: boolean }
    | { type: 'typeText'; text: string; delayMs?: number }
    | { type: 'pressKey'; key: string }
    | { type: 'hotkey'; keys: string[] }
    | { type: 'wait'; ms: number }
    | { type: 'scroll'; amount: number; direction?: 'up' | 'down' }
    | { type: 'launchApp'; command: string; args?: string[] };

export type DesktopObservation = {
    screenshotBase64: string;
    timestamp: string;
};

export type ExecutionResult = {
    ok: boolean;
    action: DesktopAction;
    error?: string;
    executedAt: string;
};
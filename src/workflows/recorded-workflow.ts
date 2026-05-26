import type { DesktopAction, ExecutionResult } from '../desktop/action-types';

export type Point = { x: number; y: number };
export type NormalizedPoint = { x: number; y: number }; // 0..1

export type RecordedUiTarget = {
    windowTitle?: string;
    query?: string;
    text?: string;
    role?: string;
    automationId?: string;
    className?: string;
    controlType?: string;
    typeable?: boolean;
    clickable?: boolean;
};

export type RecordedStep = {
    index: number;
    action: DesktopAction;
    result: ExecutionResult;

    // Semantic hint (best-effort). Prefer storing this over raw coordinates.
    semantic?: string;

    // For pointer-based actions, store a robust-ish representation.
    // Primary: normalized coordinates relative to the *screen size at record time*.
    // Fallback: raw pixels for debugging and last-resort replay.
    pointer?: {
        raw?: Point;
        normalized?: NormalizedPoint;
        reference?: {
            screenWidth: number;
            screenHeight: number;
        };
    };

    // Semantic selector for click replay. Prefer re-resolving this target over
    // replaying coordinates, and use coordinates only as a fallback.
    uiTarget?: RecordedUiTarget;
};

export type RecordedWorkflow = {
    version: 1;
    task: string;
    ok: boolean;
    startedAt: string;
    endedAt: string;

    // Minimal context for robust replay.
    expectedWindowTitle?: string;
    steps: RecordedStep[];
};

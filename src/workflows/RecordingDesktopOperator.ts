import type { DesktopOperator } from '../desktop/DesktopOperator';
import type { DesktopAction, ExecutionResult } from '../desktop/action-types';
import { isUiCandidateProvider, type ListUiCandidatesOptions, type UiCandidate } from '../desktop/ui-candidates';

import type { RecordedStep, RecordedUiTarget, RecordedWorkflow } from './recorded-workflow';
import { finalizeRecordedWorkflow } from './finalize-recorded-workflow';

export type RecordingOptions = {
    task: string;
    expectedWindowTitle?: string;
};

export class RecordingDesktopOperator implements DesktopOperator {
    private readonly startedAt = new Date().toISOString();
    private endedAt: string | null = null;

    private screenWidth: number | null = null;
    private screenHeight: number | null = null;

    private readonly steps: RecordedStep[] = [];
    private lastCandidates: UiCandidate[] | null = null;
    private lastCandidatesWindowTitle: string | null = null;

    constructor(private readonly inner: DesktopOperator, private readonly options: RecordingOptions) { }

    async listUiCandidates(options: ListUiCandidatesOptions) {
        if (isUiCandidateProvider(this.inner)) {
            const candidates = await this.inner.listUiCandidates(options);
            this.lastCandidates = candidates;
            this.lastCandidatesWindowTitle = options.windowTitle;
            return candidates;
        }
        return [];
    }

    resolveUiCandidateClickPoint(id: number): { x: number; y: number } | null {
        if (isUiCandidateProvider(this.inner)) {
            return this.inner.resolveUiCandidateClickPoint(id);
        }
        return null;
    }

    async screenshot() {
        const obs = await this.inner.screenshot();
        if (typeof obs.width === 'number' && typeof obs.height === 'number') {
            this.screenWidth ??= obs.width;
            this.screenHeight ??= obs.height;
        }
        return obs;
    }

    async execute(actions: DesktopAction[]): Promise<ExecutionResult[]> {
        // Ensure we have screen dimensions for normalized coordinates.
        if (this.screenWidth === null || this.screenHeight === null) {
            await this.screenshot().catch(() => undefined);
        }

        const results: ExecutionResult[] = [];

        for (const action of actions) {
            // If a candidate click is requested, translate it into a stable, replayable
            // normalized click action using the locally-resolved click point.
            let actionToExecute: DesktopAction = action;
            let uiTarget: RecordedUiTarget | undefined;
            if (action.type === 'clickCandidate' && isUiCandidateProvider(this.inner)) {
                const pt = this.inner.resolveUiCandidateClickPoint(action.id);
                const w = this.screenWidth;
                const h = this.screenHeight;
                uiTarget = this.uiTargetInfo(action.id);
                try {
                    console.error('[Desktop] Candidate action:', JSON.stringify({
                        type: action.type,
                        id: action.id,
                        button: action.button ?? 'left',
                        hint: (action as any).hint,
                        target: uiTarget,
                        clickPoint: pt,
                    }));
                } catch {
                    console.error('[Desktop] Candidate action:', action);
                }
                if (pt && typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0) {
                    actionToExecute = {
                        type: 'click',
                        button: action.button,
                        nx: pt.x / w,
                        ny: pt.y / h,
                        hint: (action as any).hint ? String((action as any).hint) : `Click candidate ${action.id}`,
                    };
                }
            }

            const [result] = await this.inner.execute([actionToExecute]);
            if (!result) {
                const fallback: ExecutionResult = {
                    ok: false,
                    action: actionToExecute,
                    error: 'No execution result returned by operator',
                    executedAt: new Date().toISOString(),
                };
                results.push(fallback);
                this.steps.push(this.buildRecordedStep(actionToExecute, fallback, uiTarget));
                continue;
            }

            results.push(result);
            this.steps.push(this.buildRecordedStep(actionToExecute, result, uiTarget));
        }

        return results;
    }

    finish(ok: boolean): RecordedWorkflow {
        this.endedAt = new Date().toISOString();
        return finalizeRecordedWorkflow({
            version: 1,
            task: this.options.task,
            ok,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            expectedWindowTitle: this.options.expectedWindowTitle,
            steps: this.steps,
        });
    }

    private buildRecordedStep(action: DesktopAction, result: ExecutionResult, uiTarget?: RecordedUiTarget): RecordedStep {
        const semantic = (action as any).hint ? String((action as any).hint) : inferSemantic(action);

        const pointer = this.pointerInfo(action);

        return {
            index: this.steps.length,
            action,
            result,
            semantic,
            ...(pointer ? { pointer } : {}),
            ...(uiTarget ? { uiTarget } : {}),
        };
    }

    private uiTargetInfo(candidateId: number): RecordedUiTarget | undefined {
        const candidate = this.lastCandidates?.find((c) => c.id === candidateId);
        if (!candidate) return undefined;

        const text = (candidate.text ?? '').replace(/\s+/g, ' ').trim();
        const role = (candidate.role ?? '').replace(/\s+/g, ' ').trim();

        return {
            ...(this.lastCandidatesWindowTitle ? { windowTitle: this.lastCandidatesWindowTitle } : {}),
            ...(text ? { text, query: text } : {}),
            ...(role ? { role } : {}),
            ...(candidate.automationId ? { automationId: candidate.automationId } : {}),
            ...(candidate.className ? { className: candidate.className } : {}),
            ...(candidate.controlType ? { controlType: candidate.controlType } : {}),
            typeable: candidate.typeable,
            clickable: candidate.clickable,
        };
    }

    private pointerInfo(action: DesktopAction): RecordedStep['pointer'] | undefined {
        const w = this.screenWidth;
        const h = this.screenHeight;
        const canNormalize = typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0;

        const raw = extractPointer(action);
        if (!raw) return undefined;

        return {
            raw,
            normalized: canNormalize ? { x: clamp01(raw.x / w), y: clamp01(raw.y / h) } : undefined,
            reference: canNormalize ? { screenWidth: w, screenHeight: h } : undefined,
        };
    }
}

function inferSemantic(action: DesktopAction): string {
    switch (action.type) {
        case 'launchApp':
            return `Launch app: ${action.command}`;
        case 'focusWindow':
            return `Focus window: ${action.title}`;
        case 'wait':
            return `Wait ${action.ms}ms`;
        case 'typeText':
            return `Type text (${action.text.length} chars)`;
        case 'pressKey':
            return `Press key: ${action.key}`;
        case 'hotkey':
            return `Hotkey: ${action.keys.join('+')}`;
        case 'uiClick':
            return `UI click: ${action.controlName}`;
        case 'scroll':
            return `Scroll ${action.direction ?? 'down'} ${action.amount}`;
        case 'click':
            return 'Click at coordinates';
        case 'clickCandidate':
            return `Click candidate: ${action.id}`;
        default:
            return action.type;
    }
}

function extractPointer(action: DesktopAction): { x: number; y: number } | null {
    if (action.type === 'click' && typeof action.x === 'number' && typeof action.y === 'number') {
        return { x: action.x, y: action.y };
    }

    return null;
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

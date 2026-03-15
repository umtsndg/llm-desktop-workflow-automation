import type { DesktopAction, DesktopObservation, ExecutionResult } from './action-types';

export interface DesktopOperator {
    screenshot(): Promise<DesktopObservation>;
    execute(actions: DesktopAction[]): Promise<ExecutionResult[]>;
}
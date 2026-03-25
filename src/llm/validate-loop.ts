import type { DesktopAction } from '../desktop/action-types';
import { assertDesktopActions } from './validate-actions';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export type ToolRequest =
    | { type: 'perception'; reason?: string }
    | { type: 'screenshot'; reason?: string };

function assertToolRequests(value: unknown): ToolRequest[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('toolRequests must be an array');

    const requests: ToolRequest[] = [];
    for (const item of value) {
        if (!isObject(item)) throw new Error('toolRequests items must be objects');
        const type = (item as any).type;
        const reason = (item as any).reason;

        if (type !== 'perception' && type !== 'screenshot') {
            throw new Error("toolRequests[].type must be 'perception' or 'screenshot'");
        }
        if (reason !== undefined && !isString(reason)) throw new Error('toolRequests[].reason must be a string if provided');

        if (type === 'perception') requests.push({ type: 'perception', ...(reason ? { reason } : {}) });
        if (type === 'screenshot') requests.push({ type: 'screenshot', ...(reason ? { reason } : {}) });
    }
    return requests;
}

export type ReflectionOutput = {
    done: boolean;
    success: boolean;
    message: string;
    nextActions: DesktopAction[];
    toolRequests: ToolRequest[];
};

export type VerificationOutput = {
    done: boolean;
    success: boolean;
    message: string;
    evidence?: string;
    confidence?: number;
};

export type PlanOutput = {
    actions: DesktopAction[];
    toolRequests: ToolRequest[];
};

export function assertPlanOutput(value: unknown): PlanOutput {
    const actions = assertDesktopActions(value);
    const toolRequests = isObject(value) ? assertToolRequests((value as any).toolRequests) : [];
    return { actions, toolRequests };
}

export function assertReflectionOutput(value: unknown): ReflectionOutput {
    if (!isObject(value)) throw new Error('Expected JSON object');

    const done = (value as any).done;
    const success = (value as any).success;
    const message = (value as any).message;
    const nextActionsRaw = (value as any).nextActions;
    const toolRequestsRaw = (value as any).toolRequests;

    if (!isBoolean(done)) throw new Error('reflect.done must be boolean');
    if (!isBoolean(success)) throw new Error('reflect.success must be boolean');
    if (!isString(message)) throw new Error('reflect.message must be string');

    const nextActions = assertDesktopActions({ actions: Array.isArray(nextActionsRaw) ? nextActionsRaw : [] });
    const toolRequests = assertToolRequests(toolRequestsRaw);

    return {
        done,
        success,
        message,
        nextActions,
        toolRequests,
    };
}

export function assertVerificationOutput(value: unknown): VerificationOutput {
    if (!isObject(value)) throw new Error('Expected JSON object');

    const done = (value as any).done;
    const success = (value as any).success;
    const message = (value as any).message;
    const evidence = (value as any).evidence;
    const confidence = (value as any).confidence;

    if (!isBoolean(done)) throw new Error('verify.done must be boolean');
    if (!isBoolean(success)) throw new Error('verify.success must be boolean');
    if (!isString(message)) throw new Error('verify.message must be string');
    if (evidence !== undefined && !isString(evidence)) throw new Error('verify.evidence must be string if provided');
    if (confidence !== undefined && typeof confidence !== 'number') throw new Error('verify.confidence must be number if provided');

    return {
        done,
        success,
        message,
        ...(evidence ? { evidence } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
    };
}

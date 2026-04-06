import type { DesktopAction } from '../desktop/action-types';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
    return isNumber(value) && Number.isInteger(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isString);
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

export function assertDesktopActions(value: unknown): DesktopAction[] {
    if (!isObject(value)) throw new Error('Expected JSON object');
    const actions = (value as any).actions;
    if (!Array.isArray(actions)) throw new Error('Expected "actions" to be an array');

    for (const action of actions) {
        if (!isObject(action)) throw new Error('Each action must be an object');
        const type = action.type;
        if (!isString(type)) throw new Error('Action.type must be a string');

        switch (type) {
            case 'typeText':
                if (!isString(action.text)) throw new Error('typeText requires text string');
                if (action.delayMs !== undefined) throw new Error('typeText.delayMs is not supported; typing speed is controlled globally');
                break;

            case 'pressKey':
                if (!isString(action.key)) throw new Error('pressKey requires key string');
                break;

            case 'releaseKey':
                if (!isString(action.key)) throw new Error('releaseKey requires key string');
                break;

            case 'hotkey':
                if (!isStringArray(action.keys) || action.keys.length === 0) throw new Error('hotkey requires non-empty keys string[]');
                break;

            case 'focusWindow':
                if (!isString(action.title)) throw new Error('focusWindow requires title string');
                if (action.match !== undefined && !['contains', 'exact'].includes(String(action.match))) {
                    throw new Error('focusWindow.match must be contains|exact');
                }
                break;

            case 'wait':
                if (!isNumber(action.ms)) throw new Error('wait requires ms number');
                break;

            case 'scroll':
                if (!isNumber(action.amount)) throw new Error('scroll requires amount number');
                if (action.direction !== undefined && !['up', 'down'].includes(String(action.direction))) {
                    throw new Error('scroll.direction must be up|down');
                }
                break;

            case 'launchApp':
                if (!isString(action.command)) throw new Error('launchApp requires command string');
                if (action.args !== undefined && !Array.isArray(action.args)) throw new Error('launchApp.args must be string[]');
                if (Array.isArray(action.args) && !action.args.every(isString)) throw new Error('launchApp.args must be string[]');
                if (action.mode !== undefined) {
                    const allowedModes = ['shell', 'search'];
                    if (!allowedModes.includes(String(action.mode))) {
                        throw new Error('launchApp.mode must be shell|search when provided');
                    }
                }
                break;

            case 'findCandidates': {
                if (!isString(action.query) || !action.query.trim()) {
                    throw new Error('findCandidates requires non-empty query string');
                }
                if (action.limit !== undefined && !isNumber(action.limit)) {
                    throw new Error('findCandidates.limit must be number when provided');
                }
                break;
            }

            case 'click': {
                throw new Error('Unsupported action type: click. Use findCandidates + clickCandidate instead.');
            }

            case 'clickCandidate': {
                if (action.button !== undefined && !['left', 'right', 'middle'].includes(String(action.button))) {
                    throw new Error('clickCandidate.button must be left|right|middle when provided');
                }
                if (!isInteger(action.id) || action.id < 0) {
                    throw new Error('clickCandidate.id must be a non-negative integer');
                }
                break;
            }

            case 'uiClick': {
                throw new Error('Unsupported action type: uiClick. Use findCandidates + clickCandidate instead.');
            }

            default:
                if (type === 'screenshot' || type === 'perception') {
                    throw new Error(
                        `Unsupported action type: ${type}. Screenshots/perception must be requested via toolRequests (e.g. {"toolRequests":[{"type":"${type}"}]}), not emitted as DesktopAction.`
                    );
                }
                if (type === 'toolRequests') {
                    throw new Error(
                        'Unsupported action type: toolRequests. toolRequests must be a TOP-LEVEL field (e.g. {"actions":[],"toolRequests":[{"type":"screenshot"}]}), not an item inside actions.'
                    );
                }
                throw new Error(`Unsupported action type: ${type}`);
        }
    }

    return actions as DesktopAction[];
}

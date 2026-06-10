import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { createDesktopOperator } from '../desktop/createDesktopOperator';
import { DesktopActionPlanner } from '../llm/DesktopActionPlanner';
import { IterativeDesktopAgent } from '../llm/IterativeDesktopAgent';
import {
    buildLlmClient,
    normalizeLLMModel,
    normalizeLLMProvider,
    providerModel,
    providerModelOptions,
    type LLMProvider,
} from '../llm/llm-provider';
import { RecordingDesktopOperator } from '../workflows/RecordingDesktopOperator';
import { replayRecordedWorkflow } from '../workflows/replay';
import { buildReplayPreview, formatReplayPreview } from '../workflows/replay-preview';
import { bestWorkflowMatch, loadRecordedWorkflows, rankRecordedWorkflows } from '../workflows/retrieval';
import { saveRecordedWorkflow } from '../workflows/workflow-store';

const PORT = Number(process.env.WEB_PORT ?? 3000);
const webRoot = resolve(process.cwd(), 'web');
const DEFAULT_EXECUTE_MODE: ExecuteMode = 'auto';
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_THRESHOLD = 0.55;

type ExecuteMode = 'plan' | 'run' | 'loop' | 'match' | 'auto';

type ExecuteRequest = {
    task: string;
    mode: ExecuteMode;
    provider?: LLMProvider;
    model?: string;
    maxIterations?: number;
    threshold?: number;
    robust?: boolean;
    record?: boolean;
    screenshot?: boolean;
    showLlm?: boolean;
};

let activeRun: { id: string; task: string; mode: ExecuteMode; provider: LLMProvider; model: string; startedAt: string } | null = null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('Request body must be valid JSON.');
    }
}

function asExecuteRequest(body: unknown): ExecuteRequest {
    const obj = body as Partial<ExecuteRequest>;

    const task = typeof obj.task === 'string' ? obj.task.trim() : '';
    if (!task) {
        throw new Error('Field "task" is required.');
    }

    const mode = obj.mode ?? DEFAULT_EXECUTE_MODE;
    if (!['plan', 'run', 'loop', 'match', 'auto'].includes(String(mode))) {
        throw new Error('Field "mode" must be one of: plan, run, loop, match, auto.');
    }

    return {
        task,
        mode: mode as ExecuteMode,
        provider: normalizeLLMProvider(obj.provider),
        model: normalizeLLMModel((obj as { model?: unknown }).model),
        maxIterations: Number.isFinite(Number(obj.maxIterations)) ? Number(obj.maxIterations) : DEFAULT_MAX_ITERATIONS,
        threshold: Number.isFinite(Number(obj.threshold)) ? Number(obj.threshold) : DEFAULT_THRESHOLD,
        robust: typeof obj.robust === 'boolean' ? obj.robust : undefined,
        record: typeof obj.record === 'boolean' ? obj.record : true,
        screenshot: typeof obj.screenshot === 'boolean' ? obj.screenshot : true,
        showLlm: typeof obj.showLlm === 'boolean' ? obj.showLlm : undefined,
    };
}

function buildProviderLlm(showLlm: boolean, provider?: LLMProvider, model?: string) {
    return buildLlmClient({ provider, model, showLlm });
}

async function runAutomation(input: ExecuteRequest): Promise<unknown> {
    const threshold = Number.isFinite(input.threshold) ? (input.threshold as number) : DEFAULT_THRESHOLD;
    const showLlm = input.showLlm === true;
    const provider = input.provider ?? normalizeLLMProvider(undefined);
    const model = input.model ?? providerModel(provider);

    if (input.mode === 'match') {
        const workflows = await loadRecordedWorkflows();
        const ranked = rankRecordedWorkflows(input.task, workflows, { limit: 5 });
        const best = ranked[0] ?? null;
        const bestPreview = best ? buildReplayPreview(input.task, best) : null;
        return {
            ok: true,
            mode: input.mode,
            provider,
            model,
            task: input.task,
            recordingsFound: workflows.length,
            threshold,
            reusable: best ? best.score >= threshold : false,
            best: best
                ? {
                    path: best.path,
                    score: best.score,
                    details: best.details,
                    workflowTask: best.workflow.task,
                    endedAt: best.workflow.endedAt,
                    preview: bestPreview,
                }
                : null,
            top: ranked.map((m) => ({
                path: m.path,
                score: m.score,
                details: m.details,
                workflowTask: m.workflow.task,
                endedAt: m.workflow.endedAt,
                preview: buildReplayPreview(input.task, m),
            })),
        };
    }

    if (input.mode === 'plan') {
        const planner = new DesktopActionPlanner(buildProviderLlm(showLlm, provider, model));
        const operator = createDesktopOperator();
        const actions = await planner.plan(input.task, operator, { includeScreenshot: input.screenshot === true });
        return {
            ok: true,
            mode: input.mode,
            provider,
            model,
            task: input.task,
            actions,
        };
    }

    if (input.mode === 'run') {
        const planner = new DesktopActionPlanner(buildProviderLlm(showLlm, provider, model));
        const baseDesktop = createDesktopOperator();
        const record = input.record === true;
        const executor = record ? new RecordingDesktopOperator(baseDesktop, { task: input.task }) : baseDesktop;

        const actions = await planner.plan(input.task, baseDesktop, { includeScreenshot: input.screenshot === true });
        const results = await executor.execute(actions);
        const ok = results.every((r) => r.ok);

        let recordingPath: string | undefined;
        if (ok && executor instanceof RecordingDesktopOperator) {
            const workflow = executor.finish(true);
            recordingPath = await saveRecordedWorkflow(workflow);
        }

        return {
            ok,
            mode: input.mode,
            provider,
            model,
            task: input.task,
            actions,
            results,
            recordingPath,
        };
    }

    if (input.mode === 'loop') {
        const baseDesktop = createDesktopOperator();
        const record = input.record === true;
        const executor = record ? new RecordingDesktopOperator(baseDesktop, { task: input.task }) : baseDesktop;

        const agent = new IterativeDesktopAgent(buildProviderLlm(showLlm, provider, model));
        const out = await agent.run(input.task, executor, {
            maxIterations: Number.isFinite(input.maxIterations as number) ? (input.maxIterations as number) : undefined,
        });

        let recordingPath: string | undefined;
        if (out.ok && executor instanceof RecordingDesktopOperator) {
            const workflow = executor.finish(true);
            recordingPath = await saveRecordedWorkflow(workflow);
        }

        return {
            ...out,
            mode: input.mode,
            provider,
            model,
            task: input.task,
            recordingPath,
        };
    }

    const robust = input.robust === false ? false : true;
    const record = input.record === false ? false : true;
    const workflows = await loadRecordedWorkflows();
    const match = bestWorkflowMatch(input.task, workflows, { minScore: threshold });

    if (match) {
        const desktop = createDesktopOperator();
        const preview = buildReplayPreview(input.task, match);
        const replay = await replayRecordedWorkflow(desktop, match.workflow, { robust, task: input.task });
        if (replay.ok) {
            return {
                ok: true,
                mode: input.mode,
                provider,
                model,
                task: input.task,
                reused: true,
                match: {
                    path: match.path,
                    score: match.score,
                    details: match.details,
                    workflowTask: match.workflow.task,
                    endedAt: match.workflow.endedAt,
                    preview,
                },
                replay,
            };
        }

        const executor = record ? new RecordingDesktopOperator(desktop, { task: input.task }) : desktop;
        const agent = new IterativeDesktopAgent(buildProviderLlm(showLlm, provider, model));
        const lastReplayResult = replay.results[replay.results.length - 1];
        const repairTask = buildRepairTask(input.task, replay.failedStepIndex, lastReplayResult?.error);
        const repair = await agent.run(repairTask, executor, {
            maxIterations: Number.isFinite(input.maxIterations as number) ? (input.maxIterations as number) : undefined,
        });

        let recordingPath: string | undefined;
        if (repair.ok && executor instanceof RecordingDesktopOperator) {
            const workflow = executor.finish(true);
            recordingPath = await saveRecordedWorkflow(workflow);
        }

        return {
            ok: repair.ok,
            mode: input.mode,
            provider,
            model,
            task: input.task,
            reused: true,
            repaired: true,
            match: {
                path: match.path,
                score: match.score,
                details: match.details,
                workflowTask: match.workflow.task,
                endedAt: match.workflow.endedAt,
                preview,
            },
            replay,
            recordingPath,
            repair,
        };
    }

    const baseDesktop = createDesktopOperator();
    const executor = record ? new RecordingDesktopOperator(baseDesktop, { task: input.task }) : baseDesktop;
    const agent = new IterativeDesktopAgent(buildProviderLlm(showLlm, provider, model));

    const out = await agent.run(input.task, executor, {
        maxIterations: Number.isFinite(input.maxIterations as number) ? (input.maxIterations as number) : undefined,
    });

    let recordingPath: string | undefined;
    if (out.ok && executor instanceof RecordingDesktopOperator) {
        const workflow = executor.finish(true);
        recordingPath = await saveRecordedWorkflow(workflow);
    }

    return {
        ok: out.ok,
        mode: input.mode,
        provider,
        model,
        task: input.task,
        reused: false,
        fallback: true,
        match: null,
        recordingPath,
        result: out,
    };
}

function buildRepairTask(task: string, failedStepIndex?: number, error?: string): string {
    const where = typeof failedStepIndex === 'number' ? ` at recorded step ${failedStepIndex}` : '';
    const why = error ? ` Error: ${error}` : '';
    return `Continue and complete this task after a reusable workflow replay failed${where}.${why}\nOriginal task: ${task}`;
}

function contentTypeFor(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.js') return 'text/javascript; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.svg') return 'image/svg+xml';
    return 'application/octet-stream';
}

async function serveStatic(reqPath: string, res: ServerResponse): Promise<boolean> {
    const requested = reqPath === '/' ? '/index.html' : reqPath;
    const normalized = normalize(requested).replace(/^\\+|^\/+/, '');
    const fullPath = resolve(join(webRoot, normalized));

    if (!fullPath.startsWith(webRoot)) {
        sendText(res, 403, 'Forbidden');
        return true;
    }

    try {
        const data = await readFile(fullPath);
        res.writeHead(200, {
            'content-type': contentTypeFor(fullPath),
            'cache-control': 'no-store',
        });
        res.end(data);
        return true;
    } catch {
        return false;
    }
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url) return false;

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
        const provider = normalizeLLMProvider(undefined);
        sendJson(res, 200, {
            ok: true,
            busy: activeRun !== null,
            activeRun,
            provider,
            model: providerModel(provider),
            models: {
                openai: providerModelOptions('openai'),
                gemini: providerModelOptions('gemini'),
                claude: providerModelOptions('claude'),
            },
        });
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/recordings') {
        const workflows = await loadRecordedWorkflows();
        const items = workflows
            .sort((a, b) => String(b.workflow.endedAt).localeCompare(String(a.workflow.endedAt)))
            .slice(0, 20)
            .map((w) => ({
                path: w.path,
                task: w.workflow.task,
                endedAt: w.workflow.endedAt,
                stepCount: w.workflow.steps.length,
            }));

        sendJson(res, 200, { ok: true, count: items.length, items });
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/execute-stream') {
        if (activeRun) {
            sendJson(res, 409, {
                ok: false,
                error: 'Another task is currently running.',
                activeRun,
            });
            return true;
        }

        try {
            const body = await readJsonBody(req);
            const input = asExecuteRequest(body);

            const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
            activeRun = {
                id: runId,
                task: input.task,
                mode: input.mode,
                provider: input.provider ?? normalizeLLMProvider(undefined),
                model: input.model ?? providerModel(input.provider ?? normalizeLLMProvider(undefined)),
                startedAt: new Date().toISOString(),
            };

            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
            });

            async function* runAutomationWithStream(req: ExecuteRequest) {
                const threshold = Number.isFinite(req.threshold) ? (req.threshold as number) : DEFAULT_THRESHOLD;
                const showLlm = req.showLlm === true;
                const provider = req.provider ?? normalizeLLMProvider(undefined);
                const model = req.model ?? providerModel(provider);

                function humanizeAction(log: string): string | null {
                    // Parse "Last action before iteration N: {...}"
                    const match = log.match(/Last action before iteration \d+: (\{.*\})/);
                    if (!match) return null;

                    try {
                        const action = JSON.parse(match[1]);

                        if (action.type === 'launchApp') {
                            return `💻 Opening ${action.command}...`;
                        }
                        if (action.type === 'click') {
                            return `🖱️ Clicking: ${action.hint || 'element'}`;
                        }
                        if (action.type === 'typeText') {
                            return `⌨️ Typing: "${action.text}"`;
                        }
                        if (action.type === 'wait') {
                            return `⏳ Waiting ${action.ms}ms...`;
                        }
                        if (action.type === 'focusWindow') {
                            return `🪟 Focusing: ${action.title}`;
                        }
                        if (action.type === 'hotkey') {
                            return `⌨️ Pressing: ${action.keys.join(' + ')}`;
                        }
                        if (action.type === 'pressKey') {
                            return `⌨️ Pressing: ${action.key}`;
                        }
                        if (action.type === 'scroll') {
                            const dir = action.dy > 0 ? 'down' : 'up';
                            return `📜 Scrolling ${dir}...`;
                        }

                        return `⚙️ Action: ${action.type}`;
                    } catch {
                        return null;
                    }
                }

                if (req.mode === 'loop') {
                    yield {
                        type: 'result',
                        text: `🤔 I'll handle this step by step. Let me start working on: "${req.task}"`,
                    };

                    const baseDesktop = createDesktopOperator();
                    const record = req.record === true;
                    const executor = record ? new RecordingDesktopOperator(baseDesktop, { task: req.task }) : baseDesktop;

                    const agent = new IterativeDesktopAgent(buildProviderLlm(showLlm, provider, model));

                    // Override console.error to capture logs
                    const originalError = console.error;
                    const logs: string[] = [];
                    console.error = (...args: unknown[]) => {
                        logs.push(args.map(String).join(' '));
                        originalError.apply(console, args as any);
                    };

                    try {
                        const out = await agent.run(req.task, executor, {
                            maxIterations: Number.isFinite(req.maxIterations as number) ? (req.maxIterations as number) : undefined,
                        });

                        // Parse captured logs for thoughts and actions
                        for (const log of logs) {
                            if (log.includes('Thought:')) {
                                const thought = log.replace(/.*Thought:\s*/, '').trim();
                                if (thought && thought.length > 0) {
                                    yield { type: 'thought', text: `💭 ${thought}` };
                                }
                            } else if (log.includes('Last action before iteration')) {
                                const humanized = humanizeAction(log);
                                if (humanized) {
                                    yield { type: 'action', text: humanized };
                                }
                            }
                        }

                        let recordingPath: string | undefined;
                        if (out.ok && executor instanceof RecordingDesktopOperator) {
                            const workflow = executor.finish(true);
                            recordingPath = await saveRecordedWorkflow(workflow);
                        }

                        const successMsg = out.ok
                            ? `✅ Perfect! ${out.message.replace('Completed after', 'Task completed in').replace('iteration', 'step').replace('iterations', 'steps')}`
                            : `❌ ${out.message}`;

                        yield {
                            type: 'complete',
                            text: successMsg,
                            result: {
                                ...out,
                                mode: req.mode,
                                provider,
                                model,
                                task: req.task,
                                recordingPath,
                            },
                        };
                    } finally {
                        console.error = originalError;
                    }
                    return;
                }

                if (req.mode === 'plan') {
                    yield {
                        type: 'result',
                        text: '📋 Let me create an action plan for you...',
                    };

                    const planner = new DesktopActionPlanner(buildProviderLlm(showLlm, provider, model));
                    const operator = createDesktopOperator();
                    const actions = await planner.plan(req.task, operator, { includeScreenshot: req.screenshot === true });

                    yield {
                        type: 'complete',
                        text: `✅ Plan ready: I've outlined ${actions.length} action${actions.length === 1 ? '' : 's'} to complete this task.`,
                        result: {
                            ok: true,
                            mode: req.mode,
                            provider,
                            model,
                            task: req.task,
                            actions,
                        },
                    };
                    return;
                }

                // Default to auto mode with workflow matching
                yield {
                    type: 'result',
                    text: '🔍 Checking if I\'ve done something similar before...',
                };

                const workflows = await loadRecordedWorkflows();
                const match = bestWorkflowMatch(req.task, workflows, { minScore: threshold });

                if (match) {
                    const previewInfo = buildReplayPreview(req.task, match);
                    yield {
                        type: 'result',
                        text: formatReplayPreview(previewInfo),
                        result: { preview: previewInfo },
                    };

                    const repairDesktop = createDesktopOperator();
                    const replayAttempt = await replayRecordedWorkflow(repairDesktop, match.workflow, { robust: req.robust !== false, task: req.task });

                    if (!replayAttempt.ok) {
                        yield {
                            type: 'result',
                            text: `Replay failed${typeof replayAttempt.failedStepIndex === 'number' ? ` at step ${replayAttempt.failedStepIndex}` : ''}. I’ll repair from the current desktop state...`,
                        };

                        const shouldRecordRepair = req.record !== false;
                        const repairExecutor = shouldRecordRepair ? new RecordingDesktopOperator(repairDesktop, { task: req.task }) : repairDesktop;
                        const repairAgent = new IterativeDesktopAgent(buildProviderLlm(showLlm, provider, model));
                        const repairOut = await repairAgent.run(
                            buildRepairTask(req.task, replayAttempt.failedStepIndex, replayAttempt.results[replayAttempt.results.length - 1]?.error),
                            repairExecutor,
                            {
                                maxIterations: Number.isFinite(req.maxIterations as number) ? (req.maxIterations as number) : undefined,
                            }
                        );

                        let repairRecordingPath: string | undefined;
                        if (repairOut.ok && repairExecutor instanceof RecordingDesktopOperator) {
                            const workflow = repairExecutor.finish(true);
                            repairRecordingPath = await saveRecordedWorkflow(workflow);
                        }

                        yield {
                            type: 'complete',
                            text: repairOut.ok ? 'Done. I repaired the failed replay and completed the task.' : `Repair did not complete: ${repairOut.message}`,
                            result: {
                                ok: repairOut.ok,
                                mode: req.mode,
                                provider,
                                model,
                                task: req.task,
                                reused: true,
                                repaired: true,
                                match,
                                preview: previewInfo,
                                replay: replayAttempt,
                                repair: repairOut,
                                recordingPath: repairRecordingPath,
                            },
                        };
                        return;
                    }

                    yield {
                        type: 'complete',
                        text: 'Done. I replayed a previous workflow that matched your request.',
                        result: {
                            ok: true,
                            mode: req.mode,
                            provider,
                            model,
                            task: req.task,
                            reused: true,
                            match,
                            preview: previewInfo,
                            replay: replayAttempt,
                        },
                    };
                    return;

                }

                yield {
                    type: 'result',
                    text: '🆕 No matching workflow found. I\'ll handle this fresh using AI-powered automation...',
                };

                const baseDesktop = createDesktopOperator();
                const record = req.record !== false;
                const executor = record ? new RecordingDesktopOperator(baseDesktop, { task: req.task }) : baseDesktop;
                const agent = new IterativeDesktopAgent(buildProviderLlm(showLlm, provider, model));

                // Capture logs
                const originalError = console.error;
                const logs: string[] = [];
                console.error = (...args: unknown[]) => {
                    logs.push(args.map(String).join(' '));
                    originalError.apply(console, args as any);
                };

                try {
                    const out = await agent.run(req.task, executor, {
                        maxIterations: Number.isFinite(req.maxIterations as number) ? (req.maxIterations as number) : undefined,
                    });

                    // Parse captured logs with humanization
                    for (const log of logs) {
                        if (log.includes('Thought:')) {
                            const thought = log.replace(/.*Thought:\s*/, '').trim();
                            if (thought && thought.length > 0) {
                                yield { type: 'thought', text: `💭 ${thought}` };
                            }
                        } else if (log.includes('Last action before iteration')) {
                            const humanized = humanizeAction(log);
                            if (humanized) {
                                yield { type: 'action', text: humanized };
                            }
                        }
                    }

                    let recordingPath: string | undefined;
                    if (out.ok && executor instanceof RecordingDesktopOperator) {
                        const workflow = executor.finish(true);
                        recordingPath = await saveRecordedWorkflow(workflow);
                    }

                    const successMsg = out.ok
                        ? `✅ ${out.message.replace('Completed after', 'Finished in').replace('iteration', 'step').replace('iterations', 'steps')}${record ? ' I\'ve saved this workflow for next time.' : ''}`
                        : `❌ ${out.message}`;

                    yield {
                        type: 'complete',
                        text: successMsg,
                        result: {
                            ok: out.ok,
                            mode: req.mode,
                            provider,
                            model,
                            task: req.task,
                            reused: false,
                            recordingPath,
                            result: out,
                        },
                    };
                } finally {
                    console.error = originalError;
                }
            }

            try {
                for await (const msg of runAutomationWithStream(input)) {
                    const line = `data: ${JSON.stringify(msg)}\n\n`;
                    res.write(line);
                }
                res.end();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const line = `data: ${JSON.stringify({ type: 'error', text: message })}\n\n`;
                res.write(line);
                res.end();
            } finally {
                activeRun = null;
            }

            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|Missing environment variable/.test(message) ? 400 : 500;
            sendJson(res, status, { ok: false, error: message });
            return true;
        }
    }

    if (req.method === 'POST' && url.pathname === '/api/execute') {
        if (activeRun) {
            sendJson(res, 409, {
                ok: false,
                error: 'Another task is currently running.',
                activeRun,
            });
            return true;
        }

        try {
            const body = await readJsonBody(req);
            const input = asExecuteRequest(body);

            const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
            activeRun = {
                id: runId,
                task: input.task,
                mode: input.mode,
                provider: input.provider ?? normalizeLLMProvider(undefined),
                model: input.model ?? providerModel(input.provider ?? normalizeLLMProvider(undefined)),
                startedAt: new Date().toISOString(),
            };

            const startedAt = Date.now();
            const result = await runAutomation(input);
            const elapsedMs = Date.now() - startedAt;

            sendJson(res, 200, {
                ok: true,
                runId,
                elapsedMs,
                input,
                result,
            });
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|Missing environment variable/.test(message) ? 400 : 500;
            sendJson(res, status, { ok: false, error: message });
            return true;
        } finally {
            activeRun = null;
        }
    }

    return false;
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
        if (!req.url) {
            sendText(res, 400, 'Bad request');
            return;
        }

        const isApi = await handleApi(req, res);
        if (isApi) return;

        const parsed = new URL(req.url, 'http://localhost');
        const served = await serveStatic(parsed.pathname, res);
        if (!served) {
            sendText(res, 404, 'Not found');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: message });
    }
}

const server = createServer((req, res) => {
    void handler(req, res);
});

server.listen(PORT, () => {
    console.log(`Web UI ready at http://localhost:${PORT}`);
});

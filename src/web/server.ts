import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { createDesktopOperator } from '../desktop/createDesktopOperator';
import { DesktopActionPlanner } from '../llm/DesktopActionPlanner';
import { IterativeDesktopAgent } from '../llm/IterativeDesktopAgent';
import { LoggingChatClient } from '../llm/LoggingChatClient';
import { OpenAIChatClient } from '../llm/OpenAIChatClient';
import { RecordingDesktopOperator } from '../workflows/RecordingDesktopOperator';
import { replayRecordedWorkflow } from '../workflows/replay';
import { bestWorkflowMatch, loadRecordedWorkflows, rankRecordedWorkflows } from '../workflows/retrieval';
import { saveRecordedWorkflow } from '../workflows/workflow-store';

const PORT = Number(process.env.WEB_PORT ?? 3000);
const webRoot = resolve(process.cwd(), 'web');

type ExecuteMode = 'plan' | 'run' | 'loop' | 'match' | 'auto';

type ExecuteRequest = {
    task: string;
    mode: ExecuteMode;
    maxIterations?: number;
    threshold?: number;
    robust?: boolean;
    record?: boolean;
    screenshot?: boolean;
    showLlm?: boolean;
};

let activeRun: { id: string; task: string; mode: ExecuteMode; startedAt: string } | null = null;

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

    const mode = obj.mode ?? 'auto';
    if (!['plan', 'run', 'loop', 'match', 'auto'].includes(String(mode))) {
        throw new Error('Field "mode" must be one of: plan, run, loop, match, auto.');
    }

    return {
        task,
        mode: mode as ExecuteMode,
        maxIterations: Number.isFinite(Number(obj.maxIterations)) ? Number(obj.maxIterations) : undefined,
        threshold: Number.isFinite(Number(obj.threshold)) ? Number(obj.threshold) : undefined,
        robust: typeof obj.robust === 'boolean' ? obj.robust : undefined,
        record: typeof obj.record === 'boolean' ? obj.record : undefined,
        screenshot: typeof obj.screenshot === 'boolean' ? obj.screenshot : undefined,
        showLlm: typeof obj.showLlm === 'boolean' ? obj.showLlm : undefined,
    };
}

function buildLlm(showLlm: boolean) {
    const base = new OpenAIChatClient();
    if (!showLlm) return base;
    return new LoggingChatClient(base, { logRequests: false, logResponses: true });
}

async function runAutomation(input: ExecuteRequest): Promise<unknown> {
    const threshold = Number.isFinite(input.threshold) ? (input.threshold as number) : 0.55;
    const showLlm = input.showLlm === true;

    if (input.mode === 'match') {
        const workflows = await loadRecordedWorkflows();
        const ranked = rankRecordedWorkflows(input.task, workflows, { limit: 5 });
        const best = ranked[0] ?? null;
        return {
            ok: true,
            mode: input.mode,
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
                }
                : null,
            top: ranked.map((m) => ({
                path: m.path,
                score: m.score,
                details: m.details,
                workflowTask: m.workflow.task,
                endedAt: m.workflow.endedAt,
            })),
        };
    }

    if (input.mode === 'plan') {
        const planner = new DesktopActionPlanner(buildLlm(showLlm));
        const operator = createDesktopOperator();
        const actions = await planner.plan(input.task, operator, { includeScreenshot: input.screenshot === true });
        return {
            ok: true,
            mode: input.mode,
            task: input.task,
            actions,
        };
    }

    if (input.mode === 'run') {
        const planner = new DesktopActionPlanner(buildLlm(showLlm));
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

        const agent = new IterativeDesktopAgent(buildLlm(showLlm));
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
        const replay = await replayRecordedWorkflow(desktop, match.workflow, { robust });
        if (replay.ok) {
            return {
                ok: true,
                mode: input.mode,
                task: input.task,
                reused: true,
                match: {
                    path: match.path,
                    score: match.score,
                    details: match.details,
                    workflowTask: match.workflow.task,
                    endedAt: match.workflow.endedAt,
                },
                replay,
            };
        }
    }

    const baseDesktop = createDesktopOperator();
    const executor = record ? new RecordingDesktopOperator(baseDesktop, { task: input.task }) : baseDesktop;
    const agent = new IterativeDesktopAgent(buildLlm(showLlm));

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
        task: input.task,
        reused: false,
        fallback: true,
        match: match
            ? {
                path: match.path,
                score: match.score,
                details: match.details,
                workflowTask: match.workflow.task,
                endedAt: match.workflow.endedAt,
            }
            : null,
        recordingPath,
        result: out,
    };
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
        sendJson(res, 200, {
            ok: true,
            busy: activeRun !== null,
            activeRun,
            model: process.env.OPENAI_MODEL ?? 'gpt-5.1',
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
                startedAt: new Date().toISOString(),
            };

            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
            });

            async function* runAutomationWithStream(req: ExecuteRequest) {
                const threshold = Number.isFinite(req.threshold) ? (req.threshold as number) : 0.55;
                const showLlm = req.showLlm === true;

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

                    const agent = new IterativeDesktopAgent(buildLlm(showLlm));

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

                    const planner = new DesktopActionPlanner(buildLlm(showLlm));
                    const operator = createDesktopOperator();
                    const actions = await planner.plan(req.task, operator, { includeScreenshot: req.screenshot === true });

                    yield {
                        type: 'complete',
                        text: `✅ Plan ready: I've outlined ${actions.length} action${actions.length === 1 ? '' : 's'} to complete this task.`,
                        result: {
                            ok: true,
                            mode: req.mode,
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
                    yield {
                        type: 'result',
                        text: `🎯 Found a matching workflow (${(match.score * 100).toFixed(0)}% confident). Replaying it now...`,
                    };

                    const desktop = createDesktopOperator();
                    const replay = await replayRecordedWorkflow(desktop, match.workflow, { robust: req.robust !== false });

                    const completeMsg = replay.ok
                        ? '✅ Done! I replayed a previous workflow that matched your request.'
                        : '❌ The replay didn\'t work as expected. Would you like me to try a different approach?';

                    yield {
                        type: 'complete',
                        text: completeMsg,
                        result: {
                            ok: replay.ok,
                            mode: req.mode,
                            task: req.task,
                            reused: true,
                            match,
                            replay,
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
                const agent = new IterativeDesktopAgent(buildLlm(showLlm));

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
            const status = /OPENAI_API_KEY|Missing environment variable/.test(message) ? 400 : 500;
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
            const status = /OPENAI_API_KEY|Missing environment variable/.test(message) ? 400 : 500;
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

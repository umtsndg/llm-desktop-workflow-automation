import { promises as fs } from 'node:fs';

import { createDesktopOperator } from './desktop/createDesktopOperator';
import { DesktopActionPlanner } from './llm/DesktopActionPlanner';
import { IterativeDesktopAgent } from './llm/IterativeDesktopAgent';
import { LoggingChatClient } from './llm/LoggingChatClient';
import { OpenAIChatClient } from './llm/OpenAIChatClient';
import { RecordingDesktopOperator } from './workflows/RecordingDesktopOperator';
import type { RecordedWorkflow } from './workflows/recorded-workflow';
import { replayRecordedWorkflow } from './workflows/replay';
import { saveRecordedWorkflow } from './workflows/workflow-store';
import { bestWorkflowMatch, loadRecordedWorkflows, rankRecordedWorkflows } from './workflows/retrieval';

function usage(): string {
    return [
        'Usage:',
        '  npm run cli -- plan "<task>" [--screenshot] [--showLlm]',
        '  npm run cli -- run  "<task>" [--screenshot] [--showLlm] [--record]',
        '  npm run cli -- loop "<task>" [--maxIterations N] [--no-verify] [--no-perception] [--showLlm] [--record]',
        '  npm run cli -- replay "<recordingFile>" [--no-robust]',
        '  npm run cli -- match "<task>" [--limit N] [--threshold S]',
        '  npm run cli -- auto "<task>" [--threshold S] [--maxIterations N] [--no-verify] [--no-perception] [--showLlm] [--no-robust] [--no-record]',
        '',
        'Environment:',
        '  OPENAI_API_KEY (required for plan/run/loop)',
        '  OPENAI_MODEL (optional)',
        '  OPENAI_BASE_URL (optional)',
        '',
        'Notes:',
        '  - Outputs JSON to stdout (easy to pipe/log).',
        '  - --showLlm prints raw model responses to stderr.',
        '  - --record saves a successful run/loop to recordings/.',
        '  - match/auto look in ./recordings for reusable workflows.',
        '  - Use Ctrl+C to stop if automation goes wrong.',
    ].join('\n');
}

async function ensureApiKeyInEnv(): Promise<void> {
    const existing = process.env.OPENAI_API_KEY;
    if (existing && existing.trim()) return;

    // Keep stdout clean (CLI outputs JSON). Prompt on stderr.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            'Missing OPENAI_API_KEY environment variable and cannot prompt (non-interactive terminal). Set OPENAI_API_KEY and retry.'
        );
    }

    const key = (await promptHidden('Enter OPENAI_API_KEY: ')).trim();
    if (!key) {
        throw new Error('OPENAI_API_KEY was empty. Set OPENAI_API_KEY and retry.');
    }
    process.env.OPENAI_API_KEY = key;
}

function promptHidden(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stderr = process.stderr;

        let value = '';
        const wasRaw = (stdin as any).isRaw;

        const cleanup = () => {
            stdin.off('data', onData);
            stdin.pause();
            try {
                if (typeof stdin.setRawMode === 'function') stdin.setRawMode(Boolean(wasRaw));
            } catch {
                // ignore
            }
        };

        const onData = (chunk: Buffer | string) => {
            const s = chunk.toString('utf8');

            // Ctrl+C
            if (s === '\u0003') {
                cleanup();
                reject(new Error('Cancelled.'));
                return;
            }

            // Enter
            if (s === '\r' || s === '\n' || s === '\r\n') {
                stderr.write('\n');
                cleanup();
                resolve(value);
                return;
            }

            // Backspace (Windows + some terminals)
            if (s === '\u0008' || s === '\u007f') {
                value = value.slice(0, -1);
                return;
            }

            // Ignore other control sequences
            if (/^[\u0000-\u001f\u007f]$/.test(s)) return;

            value += s;
        };

        try {
            stderr.write(prompt);
            stdin.resume();
            stdin.setEncoding('utf8');
            if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
            stdin.on('data', onData);
        } catch (e) {
            cleanup();
            reject(e);
        }
    });
}

type Parsed = { cmd: string; arg: string; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Parsed {
    const args = argv.slice(2);
    const first = args[0];
    if (!first) {
        return { cmd: 'help', arg: '', flags: { help: true } };
    }

    const cmd = String(args.shift());
    if (cmd === 'help') {
        return { cmd: 'help', arg: '', flags: { help: true } };
    }

    const flags: Record<string, string | boolean> = {};
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a) continue;

        if (a === '--help' || a === '-h') {
            flags.help = true;
            continue;
        }

        if (a.startsWith('--no-')) {
            flags[a.slice('--no-'.length)] = false;
            continue;
        }

        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
            continue;
        }

        positionals.push(a);
    }

    const arg = positionals.join(' ').trim();
    if (!arg && !flags.help) {
        throw new Error('Missing argument. Wrap it in quotes.');
    }

    return { cmd, arg, flags };
}

async function main() {
    const { cmd, arg, flags } = parseArgs(process.argv);

    if (flags.help) {
        console.log(usage());
        return;
    }

    // Only prompt for credentials when we are actually going to call the LLM.
    if (cmd === 'plan' || cmd === 'run' || cmd === 'loop' || cmd === 'auto') {
        await ensureApiKeyInEnv();
    }

    if (cmd === 'match') {
        const task = arg;
        const limit = typeof flags.limit === 'string' ? Number(flags.limit) : 5;
        const threshold = typeof flags.threshold === 'string' ? Number(flags.threshold) : 0.55;

        const workflows = await loadRecordedWorkflows();
        const ranked = rankRecordedWorkflows(task, workflows, { limit: Number.isFinite(limit) ? limit : 5 });
        const best = ranked[0] ?? null;
        const reusable = best ? best.score >= threshold : false;

        console.log(
            JSON.stringify(
                {
                    ok: true,
                    recordingsFound: workflows.length,
                    threshold,
                    reusable,
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
                },
                null,
                2
            )
        );
        return;
    }

    if (cmd === 'plan') {
        const task = arg;
        const showLlm = Boolean(flags.showLlm || flags['show-llm']);
        const baseLlm = new OpenAIChatClient();
        const llm = showLlm ? new LoggingChatClient(baseLlm, { logRequests: false, logResponses: true }) : baseLlm;
        const operator = createDesktopOperator();

        const planner = new DesktopActionPlanner(llm);
        const actions = await planner.plan(task, operator, {
            includeScreenshot: Boolean(flags.screenshot),
        });
        console.log(JSON.stringify({ actions }, null, 2));
        return;
    }

    if (cmd === 'run') {
        const task = arg;
        const showLlm = Boolean(flags.showLlm || flags['show-llm']);
        const baseLlm = new OpenAIChatClient();
        const llm = showLlm ? new LoggingChatClient(baseLlm, { logRequests: false, logResponses: true }) : baseLlm;

        const baseDesktop = createDesktopOperator();
        const executor = flags.record ? new RecordingDesktopOperator(baseDesktop, { task }) : baseDesktop;

        const planner = new DesktopActionPlanner(llm);
        const actions = await planner.plan(task, baseDesktop, {
            includeScreenshot: Boolean(flags.screenshot),
        });

        const results = await executor.execute(actions);
        const ok = results.every((r) => r.ok);

        let recordingPath: string | undefined;
        if (ok && executor instanceof RecordingDesktopOperator) {
            const workflow = executor.finish(true);
            recordingPath = await saveRecordedWorkflow(workflow);
        }

        console.log(JSON.stringify({ ok, actions, results, recordingPath }, null, 2));
        return;
    }

    if (cmd === 'loop') {
        const task = arg;
        const showLlm = Boolean(flags.showLlm || flags['show-llm']);
        const baseLlm = new OpenAIChatClient();
        const llm = showLlm ? new LoggingChatClient(baseLlm, { logRequests: false, logResponses: true }) : baseLlm;

        const baseDesktop = createDesktopOperator();
        const executor = flags.record ? new RecordingDesktopOperator(baseDesktop, { task }) : baseDesktop;

        const agent = new IterativeDesktopAgent(llm);
        const maxIterations = typeof flags.maxIterations === 'string' ? Number(flags.maxIterations) : undefined;

        const out = await agent.run(task, executor, {
            maxIterations: Number.isFinite(maxIterations as number) ? (maxIterations as number) : undefined,
        });

        let recordingPath: string | undefined;
        if (out.ok && executor instanceof RecordingDesktopOperator) {
            const workflow = executor.finish(true);
            recordingPath = await saveRecordedWorkflow(workflow);
        }

        console.log(JSON.stringify({ ...out, recordingPath }, null, 2));
        return;
    }

    if (cmd === 'replay') {
        const recordingFile = arg;
        const robust = flags.robust === false ? false : true;

        const raw = await fs.readFile(recordingFile, 'utf8');
        const workflow = JSON.parse(raw) as RecordedWorkflow;

        const desktop = createDesktopOperator();
        const result = await replayRecordedWorkflow(desktop, workflow, { robust });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (cmd === 'auto') {
        const task = arg;
        const threshold = typeof flags.threshold === 'string' ? Number(flags.threshold) : 0.55;
        const robust = flags.robust === false ? false : true;
        const record = flags.record === false ? false : true;

        const workflows = await loadRecordedWorkflows();
        const match = bestWorkflowMatch(task, workflows, { minScore: Number.isFinite(threshold) ? threshold : 0.55 });

        if (match) {
            const desktop = createDesktopOperator();
            const replayResult = await replayRecordedWorkflow(desktop, match.workflow, { robust });
            if (replayResult.ok) {
                console.log(
                    JSON.stringify(
                        {
                            ok: true,
                            reused: true,
                            match: {
                                path: match.path,
                                score: match.score,
                                details: match.details,
                                workflowTask: match.workflow.task,
                                endedAt: match.workflow.endedAt,
                            },
                            replay: replayResult,
                        },
                        null,
                        2
                    )
                );
                return;
            }
        }

        // Fallback to LLM loop (repair/update), then optionally store the improved execution.
        const showLlm = Boolean(flags.showLlm || flags['show-llm']);
        const baseLlm = new OpenAIChatClient();
        const llm = showLlm ? new LoggingChatClient(baseLlm, { logRequests: false, logResponses: true }) : baseLlm;

        const baseDesktop = createDesktopOperator();
        const executor = record ? new RecordingDesktopOperator(baseDesktop, { task }) : baseDesktop;

        const agent = new IterativeDesktopAgent(llm);
        const maxIterations = typeof flags.maxIterations === 'string' ? Number(flags.maxIterations) : undefined;

        const out = await agent.run(task, executor, {
            maxIterations: Number.isFinite(maxIterations as number) ? (maxIterations as number) : undefined,
        });

        let recordingPath: string | undefined;
        if (out.ok && executor instanceof RecordingDesktopOperator) {
            const workflow = executor.finish(true);
            recordingPath = await saveRecordedWorkflow(workflow);
        }

        console.log(
            JSON.stringify(
                {
                    ok: out.ok,
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
                },
                null,
                2
            )
        );
        return;
    }

    throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Keep error output concise for CLI.
    console.error(msg);
    console.error('');
    console.error(usage());
    process.exitCode = 1;
});

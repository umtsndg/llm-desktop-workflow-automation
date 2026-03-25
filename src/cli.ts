import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';
import { DesktopActionPlanner } from './llm/DesktopActionPlanner';
import { IterativeDesktopAgent } from './llm/IterativeDesktopAgent';
import { LoggingChatClient } from './llm/LoggingChatClient';
import { OpenAIChatClient } from './llm/OpenAIChatClient';

function usage(): string {
    return [
        'Usage:',
        '  npm run cli -- plan "<task>" [--screenshot] [--showLlm]',
        '  npm run cli -- run  "<task>" [--screenshot] [--showLlm]',
        '  npm run cli -- loop "<task>" [--maxIterations N] [--no-verify] [--no-perception] [--showLlm]',
        '',
        'Environment:',
        '  OPENAI_API_KEY (required)',
        '  OPENAI_MODEL (optional)',
        '  OPENAI_BASE_URL (optional)',
        '',
        'Notes:',
        '  - Outputs JSON to stdout (easy to pipe/log).',
        '  - --showLlm prints raw model responses to stderr.',
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

function parseArgs(argv: string[]): { cmd: string; task: string; flags: Record<string, string | boolean> } {
    const args = argv.slice(2);
    const first = args[0];
    if (!first || first === '--help' || first === '-h') {
        return { cmd: 'help', task: '', flags: { help: true } };
    }

    const cmd = String(args.shift());
    if (cmd === 'help') {
        return { cmd: 'help', task: '', flags: { help: true } };
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

    const task = positionals.join(' ').trim();
    if (!task && !flags.help) {
        throw new Error('Missing task string. Wrap it in quotes.');
    }

    return { cmd, task, flags };
}

async function main() {
    const { cmd, task, flags } = parseArgs(process.argv);

    if (flags.help) {
        console.log(usage());
        return;
    }

    // Only prompt for credentials when we are actually going to call the LLM.
    if (cmd === 'plan' || cmd === 'run' || cmd === 'loop') {
        await ensureApiKeyInEnv();
    }

    const showLlm = Boolean(flags.showLlm || flags['show-llm']);
    const baseLlm = new OpenAIChatClient();
    const llm = showLlm ? new LoggingChatClient(baseLlm, { logRequests: false, logResponses: true }) : baseLlm;
    const operator = new NutJsDesktopOperator();

    if (cmd === 'plan') {
        const planner = new DesktopActionPlanner(llm);
        const actions = await planner.plan(task, operator, {
            includeScreenshot: Boolean(flags.screenshot),
        });
        console.log(JSON.stringify({ actions }, null, 2));
        return;
    }

    if (cmd === 'run') {
        const planner = new DesktopActionPlanner(llm);
        const actions = await planner.plan(task, operator, {
            includeScreenshot: Boolean(flags.screenshot),
        });
        const results = await operator.execute(actions);
        console.log(JSON.stringify({ actions, results }, null, 2));
        return;
    }

    if (cmd === 'loop') {
        const agent = new IterativeDesktopAgent(llm);
        const maxIterations = typeof flags.maxIterations === 'string' ? Number(flags.maxIterations) : undefined;
        const includePerception = flags.perception === false ? false : true;
        const verifyOnDone = flags.verify === false ? false : true;

        const out = await agent.run(task, operator, {
            maxIterations: Number.isFinite(maxIterations as number) ? (maxIterations as number) : undefined,
            includePerception,
            verifyOnDone,
        });

        console.log(JSON.stringify(out, null, 2));
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

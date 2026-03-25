import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';
import { OpenAIChatClient } from './llm/OpenAIChatClient';
import { IterativeDesktopAgent } from './llm/IterativeDesktopAgent';

async function main() {
    const operator = new NutJsDesktopOperator();
    const llm = new OpenAIChatClient();
    const agent = new IterativeDesktopAgent(llm);

    const marker = `AGENT_VERIFY_${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const task = [
        'Open Notepad.',
        'Type exactly this marker on a new line:',
        marker,
        'Do not type into the terminal; ensure Notepad is focused before typing.',
        'Finish only when you can visually confirm the marker is visible in Notepad.',
    ].join(' ');

    const run = await agent.run(task, operator, {
        maxIterations: 4,
        includePerception: true,
        includeScreenshotInReflection: false,
        verifyOnDone: true,
        maxVerifyRetries: 1,
        maxToolRequestRounds: 2,
    });

    console.log('Marker:', marker);
    console.log('Final:', { ok: run.ok, message: run.message });
    console.log('Iterations:', run.iterations);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

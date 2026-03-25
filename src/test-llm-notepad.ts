import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';
import { OpenAIChatClient } from './llm/OpenAIChatClient';
import { DesktopActionPlanner } from './llm/DesktopActionPlanner';

async function main() {
    const operator = new NutJsDesktopOperator();
    const llm = new OpenAIChatClient();
    const planner = new DesktopActionPlanner(llm);

    const task = 'Open Notepad and type: Hello from the LLM planner.';

    const actions = await planner.plan(task);
    console.log('Planned actions:', actions);

    const results = await operator.execute(actions);
    console.log('Execution results:', results);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

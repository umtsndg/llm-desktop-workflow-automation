import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';
import { OpenAIChatClient } from './llm/OpenAIChatClient';
import { DesktopActionPlanner } from './llm/DesktopActionPlanner';

async function main() {
    const operator = new NutJsDesktopOperator();
    const llm = new OpenAIChatClient();
    const planner = new DesktopActionPlanner(llm);

    const filePath = 'C:\\Users\\UMUTS\\Desktop\\mock_employee_data.xlsx';

    const task = [
        `Open the Excel file at: ${filePath}.`,

    ].join(' ');

    const actions = await planner.plan(task);
    console.log('Planned actions:', actions);

    const results = await operator.execute(actions);
    console.log('Execution results:', results);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

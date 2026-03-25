import { NutJsDesktopOperator } from './desktop/NutJsDesktopOperator';
import { OpenAIChatClient } from './llm/OpenAIChatClient';
import { IterativeDesktopAgent } from './llm/IterativeDesktopAgent';

async function main() {
    const operator = new NutJsDesktopOperator();
    const llm = new OpenAIChatClient();
    const agent = new IterativeDesktopAgent(llm);

    const filePath = 'C:\\Users\\UMUTS\\Desktop\\mock_employee_data.xlsx';

    const task = [
        `Open the Excel file at: ${filePath}.`,
        'Create a clustered column chart showing SUM of SalaryUSD by Department.',
        'Avoid guessing mouse coordinates; prefer keyboard shortcuts and ribbon keytips.',
    ].join(' ');

    const run = await agent.run(task, operator, { maxIterations: 6 });

    console.log('Final:', { ok: run.ok, message: run.message });
    console.log('Iterations:', run.iterations);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

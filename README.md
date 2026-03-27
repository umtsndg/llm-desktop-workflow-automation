# llm-desktop-workflow-automation
This project explores LLM-based desktop workflow automation on Windows. Users describe tasks in natural language, which are executed and recorded in a reusable form. Previously recorded workflows are replayed for similar requests, improving reliability and efficiency for repeated desktop tasks.

## Local Web UI/API + Host Runner (Windows)

The web UI/API runs locally (Node.js), and the actual desktop automation (NutJS controlling Notepad/Excel/etc.) runs on the same Windows host runner.

### Automated start

From the repo folder:

- `npm run web:start`

This will:
- generate `RUNNER_SECRET` (and write it to `.env`)
- start the local web UI/API in the background on `http://localhost:3000`
- open the browser
- start the host runner in the foreground

To stop the local web UI/API:

- `npm run web:stop`

### Manual start

PowerShell:

- `$env:OPENAI_API_KEY = "..."`
- `npm run web:server`
- In another terminal: `npm run web:runner`

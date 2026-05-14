# llm-desktop-workflow-automation
This project explores LLM-based desktop workflow automation. Users describe tasks in natural language, which are executed and recorded in a reusable form. Previously recorded workflows are replayed for similar requests, improving reliability and efficiency for repeated desktop tasks.

## Desktop backends

The default backend is selected by OS:

- Windows: `NutJsDesktopOperator` with Windows UI Automation.
- macOS: `PeekabooDesktopOperator` using the `peekaboo` CLI.

You can override the selection with `DESKTOP_OPERATOR`:

- PowerShell: `$env:DESKTOP_OPERATOR = "peekaboo"`
- macOS/Linux shell: `export DESKTOP_OPERATOR=peekaboo`

For macOS, install Peekaboo and grant Screen Recording + Accessibility permissions before running automation:

- `brew install steipete/tap/peekaboo`
- `peekaboo permissions status`

If the binary is not named `peekaboo`, set `PEEKABOO_BIN` to its path.

## Local Web UI

The web UI runs locally with Node.js and triggers the same desktop automation engine used by the CLI.

### Start

From the repo folder in PowerShell:

- `$env:OPENAI_API_KEY = "..."`
- `npm run web:server`

Then open `http://localhost:3000` in your browser.

### What the UI can do

- Submit a natural-language task.
- Choose execution mode: `auto`, `loop`, `run`, `plan`, or `match`.
- Tune options like threshold and max iterations.
- View JSON results and recent recordings.

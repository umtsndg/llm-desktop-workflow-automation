# llm-desktop-workflow-automation
This project explores LLM-based desktop workflow automation on Windows. Users describe tasks in natural language, which are executed and recorded in a reusable form. Previously recorded workflows are replayed for similar requests, improving reliability and efficiency for repeated desktop tasks.

## Local Web UI (Windows)

The web UI runs locally with Node.js and triggers the same desktop automation engine used by the CLI.

### Start

From the repo folder in PowerShell:

- `$env:OPENAI_API_KEY = "..."`
- `npm run web:server`

Then open `http://localhost:3000` in your browser.

To use Gemini instead, set:

- `$env:GEMINI_API_KEY = "..."`
- `$env:LLM_PROVIDER = "gemini"`

You can also choose OpenAI or Gemini from the web UI settings, or pass `--provider gemini` in the CLI.

### What the UI can do

- Submit a natural-language task.
- Choose execution mode: `auto`, `loop`, `run`, `plan`, or `match`.
- Tune options like threshold and max iterations.
- View JSON results and recent recordings.

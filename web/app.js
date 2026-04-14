const form = document.getElementById('chat-form');
const taskInput = document.getElementById('task-input');
const modeInput = document.getElementById('mode');
const maxIterationsInput = document.getElementById('max-iterations');
const thresholdInput = document.getElementById('threshold');
const recordInput = document.getElementById('record');
const screenshotInput = document.getElementById('screenshot');
const showLlmInput = document.getElementById('show-llm');
const sendBtn = document.getElementById('send-btn');
const messagesEl = document.getElementById('messages');
const statusPill = document.getElementById('status-pill');

let isRunning = false;

function setStatus(type, text) {
    statusPill.className = `pill ${type}`;
    statusPill.textContent = text;
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(type, text) {
    const msg = document.createElement('div');
    msg.className = `message ${type}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    msg.appendChild(bubble);
    messagesEl.appendChild(msg);
    scrollToBottom();

    return msg;
}

async function submitTask(evt) {
    evt.preventDefault();

    const task = taskInput.value.trim();
    if (!task) {
        addMessage('error', 'Please enter a task.');
        return;
    }

    if (isRunning) {
        return;
    }

    isRunning = true;
    sendBtn.disabled = true;
    setStatus('busy', 'Running');

    addMessage('user', task);

    const payload = {
        task,
        mode: modeInput.value,
        maxIterations: Number(maxIterationsInput.value),
        threshold: Number(thresholdInput.value),
        record: recordInput.checked,
        screenshot: screenshotInput.checked,
        showLlm: showLlmInput.checked,
    };

    try {
        const response = await fetch('/api/execute-stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json();
            addMessage('error', `Error: ${errorData.error || 'Unknown error'}`);
            setStatus('error', 'Failed');
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');

            for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                if (line.startsWith('data: ')) {
                    const jsonStr = line.slice(6);
                    try {
                        const msg = JSON.parse(jsonStr);
                        if (msg.type === 'thought' && msg.text) {
                            addMessage('thought', msg.text);
                        } else if (msg.type === 'action' && msg.text) {
                            addMessage('action', msg.text);
                        } else if (msg.type === 'result' && msg.text) {
                            addMessage('assistant', msg.text);
                        } else if (msg.type === 'error' && msg.text) {
                            addMessage('error', msg.text);
                        } else if (msg.type === 'complete') {
                            addMessage('complete', msg.text || 'Task completed successfully');
                        }
                    } catch (e) {
                        console.error('Failed to parse message:', jsonStr, e);
                    }
                }
            }

            buffer = lines[lines.length - 1];
        }

        setStatus('ok', 'Complete');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage('error', `Error: ${msg}`);
        setStatus('error', 'Failed');
    } finally {
        isRunning = false;
        sendBtn.disabled = false;
        taskInput.value = '';
    }
}

async function boot() {
    form.addEventListener('submit', submitTask);

    try {
        const res = await fetch('/api/health');
        const data = await res.json();

        if (data.ok) {
            setStatus('idle', 'Ready');
        } else {
            setStatus('error', 'Server unavailable');
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('error', 'Cannot reach server');
        addMessage('error', `Connection error: ${msg}`);
    }
}

boot();


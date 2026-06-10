const form = document.getElementById('chat-form');
const taskInput = document.getElementById('task-input');
const providerInput = document.getElementById('provider');
const modelInput = document.getElementById('model');
const customModelWrap = document.getElementById('custom-model-wrap');
const customModelInput = document.getElementById('custom-model');
const sendBtn = document.getElementById('send-btn');
const messagesEl = document.getElementById('messages');
const statusPill = document.getElementById('status-pill');

const EXECUTION_DEFAULTS = {
    mode: 'auto',
    maxIterations: 20,
    threshold: 0.55,
    record: true,
    screenshot: true,
    showLlm: false,
};

let isRunning = false;
let modelOptions = {
    openai: ['gpt-5.1'],
    gemini: ['gemini-2.5-flash'],
    claude: ['claude-sonnet-4-5-20250929'],
};

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

function refreshModelOptions(defaultModel) {
    const provider = providerInput.value;
    const options = modelOptions[provider] || [];
    const selectedModel = defaultModel || modelInput.value || options[0] || '';

    modelInput.replaceChildren();

    for (const model of options) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        modelInput.appendChild(option);
    }

    const customOption = document.createElement('option');
    customOption.value = '__custom__';
    customOption.textContent = 'Custom...';
    modelInput.appendChild(customOption);

    if (options.includes(selectedModel)) {
        modelInput.value = selectedModel;
        customModelWrap.hidden = true;
    } else if (selectedModel) {
        modelInput.value = '__custom__';
        customModelInput.value = selectedModel;
        customModelWrap.hidden = false;
    } else {
        modelInput.value = options[0] || '__custom__';
        customModelWrap.hidden = modelInput.value !== '__custom__';
    }
}

function selectedModel() {
    if (modelInput.value === '__custom__') {
        return customModelInput.value.trim();
    }
    return modelInput.value;
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
        provider: providerInput.value,
        model: selectedModel(),
        ...EXECUTION_DEFAULTS,
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
    providerInput.addEventListener('change', () => {
        const options = modelOptions[providerInput.value] || [];
        refreshModelOptions(options[0]);
    });
    modelInput.addEventListener('change', () => {
        customModelWrap.hidden = modelInput.value !== '__custom__';
        if (!customModelWrap.hidden) {
            customModelInput.focus();
        }
    });
    refreshModelOptions();

    try {
        const res = await fetch('/api/health');
        const data = await res.json();

        if (data.ok) {
            if (data.models) {
                modelOptions = data.models;
            }
            if (data.provider) {
                providerInput.value = data.provider;
            }
            refreshModelOptions(data.model);
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


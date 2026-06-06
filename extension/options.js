const PROVIDERS = {
  anthropic: {
    keyLabel: 'Anthropic API Key',
    keyPlaceholder: 'sk-ant-...',
    keyHint: 'Get your key at <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a>',
    storageKey: 'anthropicKey',
    models: [
      { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5 — fast, cheap (recommended)' },
      { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4-6 — more nuanced questions' },
    ],
    defaultModel: 'claude-haiku-4-5-20251001',
  },
  gemini: {
    keyLabel: 'Google AI Studio API Key',
    keyPlaceholder: 'AIza...',
    keyHint: 'Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>',
    storageKey: 'geminiKey',
    models: [
      { value: 'gemini-flash-latest', label: 'gemini-flash-latest (gemini-3.5-flash) — recommended, free' },
      { value: 'gemini-2.5-flash',    label: 'gemini-2.5-flash — free' },
      { value: 'gemini-2.5-pro',      label: 'gemini-2.5-pro — best quality, free tier' },
    ],
    defaultModel: 'gemini-flash-latest',
  },
  ollama: {
    keyLabel: null,
    keyPlaceholder: null,
    keyHint: null,
    storageKey: null,
    models: [
      { value: 'mistral:7b',          label: 'mistral:7b' },
      { value: 'deepseek-coder:6.7b', label: 'deepseek-coder:6.7b' },
    ],
    defaultModel: 'mistral:7b',
  },
};

const providerSelect  = document.getElementById('provider');
const keyInput        = document.getElementById('api-key');
const keyLabel        = document.getElementById('key-label');
const keyHint         = document.getElementById('key-hint');
const apiKeyField     = document.getElementById('api-key-field');
const ollamaUrlField  = document.getElementById('ollama-url-field');
const ollamaUrlInput  = document.getElementById('ollama-url');
const modelSelect     = document.getElementById('model');
const saveBtn         = document.getElementById('save-btn');
const savedMsg        = document.getElementById('saved-msg');
const debugToggle     = document.getElementById('debug-toggle');
const testBtn         = document.getElementById('test-btn');
const testResult      = document.getElementById('test-result');

// Per-provider key cache so switching providers doesn't clear a previously typed key
const keyCache = { anthropic: '', gemini: '' };

function applyProvider(providerKey, selectedModel) {
  const isOllama = providerKey === 'ollama';
  apiKeyField.style.display    = isOllama ? 'none' : '';
  ollamaUrlField.style.display = isOllama ? '' : 'none';

  if (!isOllama) {
    const cfg = PROVIDERS[providerKey];
    keyLabel.textContent = cfg.keyLabel;
    keyInput.placeholder = cfg.keyPlaceholder;
    keyHint.innerHTML    = cfg.keyHint;
    keyInput.value       = keyCache[providerKey] || '';
  }

  const cfg = PROVIDERS[providerKey];
  modelSelect.innerHTML = cfg.models
    .map(m => `<option value="${m.value}"${m.value === selectedModel ? ' selected' : ''}>${m.label}</option>`)
    .join('');

  if (!selectedModel || !cfg.models.find(m => m.value === selectedModel)) {
    modelSelect.value = cfg.defaultModel;
  }

  if (isOllama) {
    const base = (ollamaUrlInput.value || 'http://localhost:11434').replace(/\/$/, '');
    fetch(`${base}/api/tags`)
      .then(r => r.json())
      .then(data => {
        const names = (data.models || []).map(m => m.name);
        if (!names.length) return;
        modelSelect.innerHTML = names
          .map(n => `<option value="${n}"${n === selectedModel ? ' selected' : ''}>${n}</option>`)
          .join('');
        if (!names.includes(modelSelect.value)) modelSelect.value = names[0];
      })
      .catch(() => {});
  }
}

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.local.get(
  ['provider', 'anthropicKey', 'geminiKey', 'ollamaUrl', 'model', 'debugMode'],
  (stored) => {
    keyCache.anthropic = stored.anthropicKey || '';
    keyCache.gemini    = stored.geminiKey    || '';
    ollamaUrlInput.value = stored.ollamaUrl  || '';

    const activeProvider = stored.provider || 'anthropic';
    providerSelect.value = activeProvider;
    applyProvider(activeProvider, stored.model);

    setDebugToggle(!!stored.debugMode);
  }
);

function setDebugToggle(enabled) {
  debugToggle.setAttribute('aria-pressed', String(enabled));
  debugToggle.textContent = enabled ? 'On' : 'Off';
}

debugToggle.addEventListener('click', () => {
  const next = debugToggle.getAttribute('aria-pressed') !== 'true';
  setDebugToggle(next);
  chrome.storage.local.set({ debugMode: next });
});

// ── Provider switch ───────────────────────────────────────────────────────────

providerSelect.addEventListener('change', () => {
  if (providerSelect.value !== 'ollama') keyCache[providerSelect.value] = keyInput.value;
  applyProvider(providerSelect.value, null);
});

keyInput.addEventListener('input', () => {
  if (providerSelect.value !== 'ollama') keyCache[providerSelect.value] = keyInput.value;
});

ollamaUrlInput.addEventListener('change', () => {
  if (providerSelect.value === 'ollama') applyProvider('ollama', modelSelect.value);
});

// ── Test Connection ───────────────────────────────────────────────────────────

function showTestResult(state, message) {
  testResult.className = state;
  testResult.textContent = message;
}

testBtn.addEventListener('click', () => {
  const provider  = providerSelect.value;
  const key       = provider !== 'ollama' ? keyInput.value.trim() : '';
  const model     = modelSelect.value;
  const ollamaUrl = ollamaUrlInput.value.trim();

  if (provider !== 'ollama' && !key) {
    showTestResult('error', 'No API key entered.');
    return;
  }

  testBtn.disabled = true;
  showTestResult('loading', 'Testing connection…');

  chrome.runtime.sendMessage(
    { type: 'testConnection', provider, key, model, ollamaUrl },
    (response) => {
      testBtn.disabled = false;
      if (!response) {
        showTestResult('error', 'No response from background. Try reloading the extension.');
        return;
      }
      if (response.ok) {
        const suggestion = (response.text || '')
          .split('\n').map(l => l.trim()).find(l => l.startsWith('→'));
        const detail = suggestion ? `\n${suggestion}` : '';
        showTestResult('success', `Connected! Model responded successfully.${detail}`);
      } else if (provider === 'ollama') {
        const isUnreachable = /ECONNREFUSED|Failed to fetch|NetworkError|Load failed/i.test(response.error);
        const is403 = /403|Forbidden/i.test(response.error);
        const displayUrl = ollamaUrlInput.value.trim() || 'http://localhost:11434';
        let hint = '';
        if (isUnreachable) {
          hint = ` — make sure Ollama is running at ${displayUrl}`;
        } else if (is403) {
          hint = '\n\nOllama is blocking requests from this extension. Fix:\n' +
            '1. Open Environment Variables (Windows Key → search "Environment Variables" → click "Environment Variables…")\n' +
            '2. Under User variables, click New… and enter:\n' +
            '   Name:  OLLAMA_ORIGINS\n' +
            '   Value: chrome-extension://*\n' +
            '3. Click OK on all windows, then right-click the Ollama tray icon → Quit and relaunch.';
        }
        showTestResult('error', `${response.error}${hint}`);
      } else {
        const isAuthError = /403|401|Unauthorized|Forbidden|api.?key/i.test(response.error);
        const hint = isAuthError ? ' — check that your key is correct and active' : '';
        showTestResult('error', `${response.error}${hint}`);
      }
    }
  );
});

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const provider = providerSelect.value;
  if (provider !== 'ollama') keyCache[provider] = keyInput.value.trim();

  chrome.storage.local.set({
    provider,
    anthropicKey: keyCache.anthropic,
    geminiKey:    keyCache.gemini,
    ollamaUrl:    ollamaUrlInput.value.trim(),
    model:        modelSelect.value,
  }, () => {
    savedMsg.classList.add('visible');
    setTimeout(() => savedMsg.classList.remove('visible'), 2000);
  });
});

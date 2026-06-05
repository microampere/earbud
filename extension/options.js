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
  groq: {
    keyLabel: 'Groq API Key',
    keyPlaceholder: 'gsk_...',
    keyHint: 'Get a free key at <a href="https://console.groq.com" target="_blank">console.groq.com</a>',
    storageKey: 'groqKey',
    models: [
      { value: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b — best quality, free' },
      { value: 'llama-3.1-8b-instant',    label: 'llama-3.1-8b-instant — fastest, free' },
      { value: 'mixtral-8x7b-32768',      label: 'mixtral-8x7b — good quality, free' },
      { value: 'gemma2-9b-it',            label: 'gemma2-9b — Google model on Groq, free' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
};

const providerSelect = document.getElementById('provider');
const keyInput       = document.getElementById('api-key');
const keyLabel       = document.getElementById('key-label');
const keyHint        = document.getElementById('key-hint');
const modelSelect    = document.getElementById('model');
const saveBtn        = document.getElementById('save-btn');
const savedMsg       = document.getElementById('saved-msg');
const debugToggle    = document.getElementById('debug-toggle');

// Per-provider key cache so switching providers doesn't clear a previously typed key
const keyCache = { anthropic: '', gemini: '', groq: '' };

function applyProvider(providerKey, selectedModel) {
  const cfg = PROVIDERS[providerKey];

  keyLabel.textContent = cfg.keyLabel;
  keyInput.placeholder = cfg.keyPlaceholder;
  keyHint.innerHTML    = cfg.keyHint;
  keyInput.value       = keyCache[providerKey] || '';

  modelSelect.innerHTML = cfg.models
    .map(m => `<option value="${m.value}"${m.value === selectedModel ? ' selected' : ''}>${m.label}</option>`)
    .join('');

  // Default to provider's recommended model if none saved
  if (!selectedModel || !cfg.models.find(m => m.value === selectedModel)) {
    modelSelect.value = cfg.defaultModel;
  }
}

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.local.get(
  ['provider', 'anthropicKey', 'geminiKey', 'groqKey', 'model', 'debugMode'],
  (stored) => {
    keyCache.anthropic = stored.anthropicKey || '';
    keyCache.gemini    = stored.geminiKey    || '';
    keyCache.groq      = stored.groqKey      || '';

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
  // Save current key into cache before switching
  keyCache[providerSelect.value] = keyInput.value;
  applyProvider(providerSelect.value, null);
});

keyInput.addEventListener('input', () => {
  keyCache[providerSelect.value] = keyInput.value;
});

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const provider = providerSelect.value;
  keyCache[provider] = keyInput.value.trim();

  chrome.storage.local.set({
    provider,
    anthropicKey: keyCache.anthropic,
    geminiKey:    keyCache.gemini,
    groqKey:      keyCache.groq,
    model:        modelSelect.value,
  }, () => {
    savedMsg.classList.add('visible');
    setTimeout(() => savedMsg.classList.remove('visible'), 2000);
  });
});

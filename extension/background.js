// background.js — service worker
// Owns all state in chrome.storage.session so it survives SW termination.
// Sidebar reads state via chrome.storage.onChanged — no port needed.

const TRIGGER_WORDS = 50;
const TRIGGER_SECS = 30;
const WINDOW_SEGMENTS = 30;
const DEDUP_WINDOW_MS = 2000; // ignore near-duplicate captions arriving within this window

// Strip trailing punctuation so "How?" is treated as a prefix of "How do I?"
const normEnd = s => s.replace(/[?.!,;:]+$/, '');

// ── Setup ────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ── Storage helpers ──────────────────────────────────────────────────────────

async function getState() {
  return chrome.storage.session.get(null);
}

async function patchState(partial) {
  return chrome.storage.session.set(partial);
}

async function clearMeetingState() {
  return chrome.storage.session.set({
    isRunning: false,
    isPaused: false,
    transcript: [],
    suggestions: [],
    status: 'Ready',
    systemPrompt: '',
    wordsSinceLastCall: 0,
    lastCallTime: Date.now(),
    meetingContext: null,
    latestCaption: null,
    suggestionsEnabled: false,
  });
}

// ── Test connection data ──────────────────────────────────────────────────────

const TEST_SYSTEM_PROMPT = `You are a meeting intelligence assistant. Output follow-up questions the user should ask, one per line, prefixed with "→ ". Only output questions when genuinely useful. Silence is the default.`;

const TEST_USER_MSG = `Recent transcript:

[Alex]: We've been struggling with our current tooling — the team spends a lot of time on manual work.
[Jordan]: What's your timeline for making a change?
[Alex]: Probably sometime next quarter, maybe sooner if the right solution comes along.
[Jordan]: And do you have a budget in mind for this?
[Alex]: We haven't really locked that down yet.`;

async function handleTestConnection(msg) {
  const { provider, key, model, ollamaUrl } = msg;
  try {
    let text = '';
    if (provider === 'anthropic') text = await callAnthropic(key, model, TEST_SYSTEM_PROMPT, TEST_USER_MSG);
    if (provider === 'gemini')    text = await callGemini(key, model, TEST_SYSTEM_PROMPT, TEST_USER_MSG);
    if (provider === 'ollama')    text = await callOllama(model, TEST_SYSTEM_PROMPT, TEST_USER_MSG, ollamaUrl);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'testConnection') {
      sendResponse(await handleTestConnection(msg));
      return;
    }
    try {
      if (msg.type === 'caption')       await handleCaption(msg.speaker, msg.text);
      if (msg.type === 'start')         await handleStart(msg.context, msg.systemPrompt);
      if (msg.type === 'stop')          await handleStop();
      if (msg.type === 'pause')         await handlePause();
      if (msg.type === 'resume')        await handleResume();
      if (msg.type === 'captionStatus') await handleCaptionStatus(msg.active, msg.strategy);
      if (msg.type === 'debug')         await handleDebug(msg.message);
    } finally {
      sendResponse();
    }
  })();
  return true; // keep port open so service worker stays alive until async work finishes
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    chrome.storage.session.get('isRunning');
  }
});

async function handleDebug(message) {
  await writeLog(message);
}

async function bgLog(message) {
  await writeLog(`[AI agent] ${message}`);
}

async function writeLog(line) {
  const { debugLog = [] } = await chrome.storage.session.get('debugLog');
  const ts = new Date().toISOString().slice(11, 23);
  debugLog.push(`${ts}  ${line}`);
  if (debugLog.length > 150) debugLog.splice(0, debugLog.length - 150);
  await chrome.storage.session.set({ debugLog });
}

// ── Meeting lifecycle ────────────────────────────────────────────────────────

async function setExtensionIcon(active) {
  try {
    await chrome.action.setIcon({ path: active ? 'icon_active.png' : 'icon.png' });
  } catch (e) {
    console.error('[bg] setExtensionIcon failed:', e, e?.name, e?.message);
  }
}

async function handleStart(context, systemPrompt) {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  await chrome.storage.session.set({
    isRunning: true,
    isPaused: false,
    transcript: [],
    suggestions: [],
    status: 'Listening...',
    llmStatus: 'idle',
    systemPrompt,
    wordsSinceLastCall: 0,
    lastCallTime: Date.now(),
    meetingContext: context,
    latestCaption: null,
    suggestionsEnabled: false,
  });
  await setExtensionIcon(true);
}

async function handleStop() {
  chrome.alarms.clear('keepalive');
  await setExtensionIcon(false);
  await patchState({ isRunning: false, isPaused: false, status: 'Ready' });
}

async function handlePause() {
  await patchState({ isPaused: true, status: 'Paused' });
}

async function handleResume() {
  await patchState({ isPaused: false, status: 'Listening...' });
}

async function handleCaptionStatus(active, strategy) {
  await patchState({
    captionDetected: active,
    captionStrategy: strategy,
    status: active ? 'Listening...' : 'Searching for captions — enable CC in the meeting',
  });
}

// ── Caption handling ─────────────────────────────────────────────────────────

async function handleCaption(speaker, text) {
  const state = await getState();
  if (!state.isRunning || state.isPaused) return;

  const transcript = [...(state.transcript || [])];
  const now = Date.now();

  // Scan recent segments (within DEDUP_WINDOW_MS) newest-first for duplicates/extensions.
  // This handles Meet sending multiple near-identical captions from different DOM nodes.
  let isUpdate = false;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const seg = transcript[i];
    if (now - seg.ts > DEDUP_WINDOW_MS) break;

    // Exact duplicate within the window — discard
    if (seg.text === text) return;

    const sameOrNoSpeaker = !speaker || !seg.speaker || speaker === seg.speaker;
    const segNorm = normEnd(seg.text);
    const textNorm = normEnd(text);

    // New text extends a recent segment → update it in place
    if (sameOrNoSpeaker && segNorm.length > 3 && text.startsWith(segNorm)) {
      transcript[i] = { speaker: speaker || seg.speaker, text, ts: now };
      isUpdate = true;
      break;
    }

    // New text is a shorter version of something we already have → discard
    if (sameOrNoSpeaker && textNorm.length > 3 && seg.text.startsWith(textNorm)) {
      return;
    }
  }

  if (!isUpdate) {
    transcript.push({ speaker, text, ts: now });
  }

  // Only count new words toward the LLM trigger, not updates to the same sentence
  const wordsAdded = isUpdate ? 0 : text.split(/\s+/).filter(Boolean).length;
  const wordsSinceLastCall = (state.wordsSinceLastCall || 0) + wordsAdded;
  const lastCallTime = state.lastCallTime || now;

  await patchState({ transcript, wordsSinceLastCall, latestCaption: { speaker, text, isUpdate } });

  const elapsedSecs = (now - lastCallTime) / 1000;
  await bgLog(`trigger check: words=${wordsSinceLastCall}/${TRIGGER_WORDS} elapsed=${elapsedSecs.toFixed(1)}s/${TRIGGER_SECS}s`);
  if (wordsSinceLastCall >= TRIGGER_WORDS || elapsedSecs >= TRIGGER_SECS) {
    await bgLog(`LLM trigger: reason=${wordsSinceLastCall >= TRIGGER_WORDS ? 'words' : 'time'} suggestionsEnabled=${state.suggestionsEnabled}`);
    await patchState({ wordsSinceLastCall: 0, lastCallTime: now });
    if (state.suggestionsEnabled === true) {
      await callLLM(state.systemPrompt, transcript);
    }
  }
}

// ── LLM routing ──────────────────────────────────────────────────────────────

async function callLLM(systemPrompt, transcript) {
  const settings = await chrome.storage.local.get([
    'provider', 'anthropicKey', 'geminiKey', 'model', 'ollamaUrl',
  ]);
  const provider = settings.provider || 'anthropic';
  const keyMap = { anthropic: settings.anthropicKey, gemini: settings.geminiKey };
  const key = keyMap[provider];
  await bgLog(`callLLM: provider=${provider} model=${settings.model} segments=${Math.min(transcript.length, WINDOW_SEGMENTS)}`);

  if (provider !== 'ollama' && !key) {
    await patchState({ status: 'No API key — open Settings' });
    return;
  }

  const userMsg = 'Recent transcript:\n\n' + transcript
    .slice(-WINDOW_SEGMENTS)
    .map(s => (s.speaker ? `[${s.speaker}]: ${s.text}` : s.text))
    .join('\n');

  await bgLog(`request:\n${userMsg}`);
  await patchState({ status: 'Thinking...', llmStatus: 'thinking' });

  try {
    let text = '';
    if (provider === 'anthropic') text = await callAnthropic(key, settings.model, systemPrompt, userMsg);
    if (provider === 'gemini')    text = await callGemini(key, settings.model, systemPrompt, userMsg);
    if (provider === 'ollama')    text = await callOllama(settings.model, systemPrompt, userMsg, settings.ollamaUrl);

    await bgLog(`response:\n${text || '(empty)'}`);
    const newQuestions = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('→'));
    await bgLog(`questions parsed: ${newQuestions.length}${newQuestions.length ? ' ' + newQuestions.join(' | ') : ''}`);

    if (newQuestions.length > 0) {
      const state = await getState();
      await patchState({ suggestions: [...(state.suggestions || []), ...newQuestions] });
    } else {
      await patchState({ llmStatus: 'none' });
    }
  } catch (e) {
    await bgLog(`error: ${e.message}`);
    const status = /403|401|Unauthorized|Forbidden/.test(e.message)
      ? 'API key error — open Settings'
      : `AI error: ${e.message}`;
    await patchState({ status, llmStatus: 'none' });
    return;
  }

  await patchState({ status: 'Listening...' });
}

// ── Provider implementations ──────────────────────────────────────────────────

async function parseJsonResponse(res) {
  const raw = await res.text();
  if (!raw) throw new Error(`HTTP ${res.status}: empty response`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${res.status}: invalid JSON — ${raw.slice(0, 120)}`);
  }
}

async function callAnthropic(key, model, systemPrompt, userMsg) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.content?.[0]?.text || '';
}

async function callGemini(key, model, systemPrompt, userMsg) {
  const m = model || 'gemini-flash-latest';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMsg }] }],
        generationConfig: { maxOutputTokens: 512 },
      }),
    }
  );
  const data = await parseJsonResponse(res);
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOllama(model, systemPrompt, userMsg, baseUrl) {
  const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || 'mistral:7b',
      max_tokens: 512,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  const data = await parseJsonResponse(res);
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.choices?.[0]?.message?.content || '';
}

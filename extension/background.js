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
  });
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'caption')       { handleCaption(msg.speaker, msg.text); }
  if (msg.type === 'start')         { handleStart(msg.context, msg.systemPrompt); }
  if (msg.type === 'stop')          { handleStop(); }
  if (msg.type === 'pause')         { handlePause(); }
  if (msg.type === 'resume')        { handleResume(); }
  if (msg.type === 'captionStatus') { handleCaptionStatus(msg.active, msg.strategy); }
  if (msg.type === 'debug')         { handleDebug(msg.message); }
});

async function handleDebug(message) {
  console.log('[BG] debug:', message);
  const { debugLog = [] } = await chrome.storage.session.get('debugLog');
  const ts = new Date().toISOString().slice(11, 23);
  debugLog.push(`${ts}  ${message}`);
  if (debugLog.length > 150) debugLog.splice(0, debugLog.length - 150);
  await chrome.storage.session.set({ debugLog });
  console.log('[BG] debugLog saved, length:', debugLog.length);
}

// ── Meeting lifecycle ────────────────────────────────────────────────────────

async function handleStart(context, systemPrompt) {
  await chrome.storage.session.set({
    isRunning: true,
    isPaused: false,
    transcript: [],
    suggestions: [],
    status: 'Listening...',
    systemPrompt,
    wordsSinceLastCall: 0,
    lastCallTime: Date.now(),
    meetingContext: context,
    latestCaption: null,
  });
}

async function handleStop() {
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
  if (wordsSinceLastCall >= TRIGGER_WORDS || elapsedSecs >= TRIGGER_SECS) {
    await patchState({ wordsSinceLastCall: 0, lastCallTime: now });
    if (state.suggestionsEnabled !== false) {
      await callLLM(state.systemPrompt, transcript);
    }
  }
}

// ── LLM routing ──────────────────────────────────────────────────────────────

async function callLLM(systemPrompt, transcript) {
  const settings = await chrome.storage.local.get([
    'provider', 'anthropicKey', 'geminiKey', 'groqKey', 'model',
  ]);
  const provider = settings.provider || 'anthropic';
  const keyMap = { anthropic: settings.anthropicKey, gemini: settings.geminiKey, groq: settings.groqKey };
  const key = keyMap[provider];

  if (!key) {
    await patchState({ status: 'No API key — open Settings' });
    return;
  }

  const userMsg = 'Recent transcript:\n\n' + transcript
    .slice(-WINDOW_SEGMENTS)
    .map(s => (s.speaker ? `[${s.speaker}]: ${s.text}` : s.text))
    .join('\n');

  await patchState({ status: 'Thinking...' });

  try {
    let text = '';
    if (provider === 'anthropic') text = await callAnthropic(key, settings.model, systemPrompt, userMsg);
    if (provider === 'gemini')    text = await callGemini(key, settings.model, systemPrompt, userMsg);
    if (provider === 'groq')      text = await callGroq(key, settings.model, systemPrompt, userMsg);

    const newQuestions = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('→'));
    if (newQuestions.length > 0) {
      const state = await getState();
      await patchState({ suggestions: [...(state.suggestions || []), ...newQuestions] });
    }
  } catch (e) {
    await patchState({ status: `Error: ${e.message}` });
    return;
  }

  await patchState({ status: 'Listening...' });
}

// ── Provider implementations ──────────────────────────────────────────────────

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
  const data = await res.json();
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
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGroq(key, model, systemPrompt, userMsg) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      max_tokens: 512,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.choices?.[0]?.message?.content || '';
}

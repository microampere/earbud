// background.js — service worker
// Owns all state in chrome.storage.session so it survives SW termination.
// Sidebar reads state via chrome.storage.onChanged — no port needed.

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TRIGGER_WORDS = 50;
const TRIGGER_SECS = 30;
const WINDOW_SEGMENTS = 30;

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
  if (msg.type === 'caption')   { handleCaption(msg.speaker, msg.text); }
  if (msg.type === 'start')     { handleStart(msg.context, msg.systemPrompt); }
  if (msg.type === 'stop')      { handleStop(); }
  if (msg.type === 'pause')     { handlePause(); }
  if (msg.type === 'resume')    { handleResume(); }
});

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

// ── Caption handling ─────────────────────────────────────────────────────────

async function handleCaption(speaker, text) {
  const state = await getState();
  if (!state.isRunning || state.isPaused) return;

  const segment = { speaker, text, ts: Date.now() };
  const transcript = [...(state.transcript || []), segment];
  const wordsSinceLastCall = (state.wordsSinceLastCall || 0) + text.split(' ').length;
  const lastCallTime = state.lastCallTime || Date.now();

  await patchState({ transcript, wordsSinceLastCall, latestCaption: segment });

  const elapsedSecs = (Date.now() - lastCallTime) / 1000;
  if (wordsSinceLastCall >= TRIGGER_WORDS || elapsedSecs >= TRIGGER_SECS) {
    await patchState({ wordsSinceLastCall: 0, lastCallTime: Date.now() });
    await callClaude(state.systemPrompt, transcript);
  }
}

// ── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(systemPrompt, transcript) {
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  if (!apiKey) return;

  await patchState({ status: 'Thinking...' });

  const recent = transcript.slice(-WINDOW_SEGMENTS);
  const window = recent
    .map(s => (s.speaker ? `[${s.speaker}]: ${s.text}` : s.text))
    .join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Recent transcript:\n\n${window}` }],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      await patchState({ status: `API error: ${data.error?.message || res.status}` });
      return;
    }

    const text = data.content?.[0]?.text || '';
    const newQuestions = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('→'));

    if (newQuestions.length > 0) {
      const state = await getState();
      const suggestions = [...(state.suggestions || []), ...newQuestions];
      await patchState({ suggestions });
    }
  } catch (e) {
    await patchState({ status: `Error: ${e.message}` });
    return;
  }

  await patchState({ status: 'Listening...' });
}

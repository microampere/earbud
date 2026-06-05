// sidebar.js

const SYSTEM_PROMPT_TEMPLATE = `You are a silent meeting intelligence assistant. You are observing a live transcript of a conversation between the user and a client. Your ONLY job is to surface follow-up questions the user should ask.

## Meeting Context
- Meeting type: {meeting_type}
- Client background: {client_background}
- User's goals: {user_goals}
- Topics to cover: {topics}

## Output Rules (follow exactly)
1. SILENCE IS DEFAULT. Do not respond to every message. Most speech requires no follow-up from you.
2. Only respond when you identify a specific, high-value follow-up question — one the user has NOT already asked and the client has NOT already answered.
3. When you do respond, output ONLY the question prefixed with "→ ". No preamble, no explanation.
4. If multiple questions surface, output them as a short list of "→ " prefixed lines.
5. Do NOT summarize, confirm, or produce conversational filler.
6. NEVER ask generic questions like "Can you tell me more?". All questions must be specific to what was just said.

## Respond ONLY when you detect one of these
- An assumption stated as fact that could be wrong
- A number, date, or commitment without specifics
- A pain point mentioned but not explored
- A decision described without explaining the criteria
- A third party (person, team, vendor) with unstated influence
- A constraint that may affect the user's deliverable
- A contradiction between earlier and current statements

## Output format
→ [specific follow-up question]

If nothing warrants a follow-up, output nothing at all.`;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const screens = {
  nokey: document.getElementById('screen-nokey'),
  setup: document.getElementById('screen-setup'),
  live: document.getElementById('screen-live'),
};

const els = {
  setupForm: document.getElementById('setup-form'),
  inputType: document.getElementById('input-type'),
  inputBackground: document.getElementById('input-background'),
  inputGoals: document.getElementById('input-goals'),
  inputTopics: document.getElementById('input-topics'),

  openOptions: document.getElementById('btn-open-options'),
  suggestionsToggle: document.getElementById('btn-suggestions-toggle'),
  pause: document.getElementById('btn-pause'),
  export: document.getElementById('btn-export'),
  stop: document.getElementById('btn-stop'),
  toggleTranscript: document.getElementById('btn-toggle-transcript'),
  clearDebug: document.getElementById('btn-clear-debug'),
  debugSection: document.getElementById('debug-section'),

  liveIndicator: document.getElementById('live-indicator'),
  liveTimer: document.getElementById('live-timer'),
  liveStatus: document.getElementById('live-status'),
  suggestionsList: document.getElementById('suggestions-list'),
  transcriptList: document.getElementById('transcript-list'),
  debugLog: document.getElementById('debug-log'),
};

// ── State ─────────────────────────────────────────────────────────────────────

let meetingStartTime = null;
let timerInterval = null;
let transcriptCollapsed = false;
let isPaused = false;
const doneSet = new Set(); // tracks which suggestion texts are marked done (local session state)

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const { provider, anthropicKey, geminiKey, groqKey, debugMode } = await chrome.storage.local.get(
    ['provider', 'anthropicKey', 'geminiKey', 'groqKey', 'debugMode']
  );
  setDebugMode(!!debugMode);
  const keyMap = { anthropic: anthropicKey, gemini: geminiKey, groq: groqKey };
  if (!keyMap[provider || 'anthropic']) { showScreen('nokey'); return; }

  // Restore live session if one is in progress
  const state = await chrome.storage.session.get(null);
  if (state.isRunning) {
    startLiveUI(state.meetingContext);
    renderSuggestions(state.suggestions || []);
    renderTranscript(state.transcript || []);
    setStatus(state.status || 'Listening...');
    setPaused(state.isPaused || false);
    if (state.debugLog?.length) renderDebugLog(state.debugLog);
  } else {
    showScreen('setup');
  }
}

init();

// ── Setup form ────────────────────────────────────────────────────────────────

els.setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const context = {
    meeting_type: els.inputType.value,
    client_background: els.inputBackground.value.trim(),
    user_goals: els.inputGoals.value.trim(),
    topics: els.inputTopics.value.trim() || 'not specified',
  };
  const systemPrompt = buildSystemPrompt(context);
  chrome.runtime.sendMessage({ type: 'start', context, systemPrompt });
  startLiveUI(context);
});

function buildSystemPrompt(ctx) {
  return SYSTEM_PROMPT_TEMPLATE
    .replace('{meeting_type}', ctx.meeting_type || 'general')
    .replace('{client_background}', ctx.client_background || 'not specified')
    .replace('{user_goals}', ctx.user_goals || 'not specified')
    .replace('{topics}', ctx.topics || 'not specified');
}

// ── Live UI ───────────────────────────────────────────────────────────────────

function startLiveUI(context) {
  showScreen('live');
  meetingStartTime = meetingStartTime || Date.now();

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - meetingStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    els.liveTimer.textContent = `${m}:${s}`;
  }, 1000);

  chrome.storage.session.get(['debugLog', 'suggestionsEnabled'], (s) => {
    console.log('[Sidebar] startLiveUI: debugLog entries:', s.debugLog?.length ?? 0);
    renderDebugLog(s.debugLog || []);
    setSuggestionsEnabled(s.suggestionsEnabled !== false);
  });
  chrome.storage.local.get(['debugMode'], ({ debugMode }) => setDebugMode(!!debugMode));
}

function setStatus(text) {
  els.liveStatus.textContent = text;
}

function setSuggestionsEnabled(enabled) {
  els.suggestionsToggle.title = enabled ? 'AI suggestions ON — click to disable' : 'AI suggestions OFF — click to enable';
  els.suggestionsToggle.classList.toggle('btn-icon-off', !enabled);
  if (!enabled) {
    els.suggestionsList.innerHTML = '<p class="ai-off-hint">AI mode is off — enable it to see suggested questions.</p>';
  } else {
    chrome.storage.session.get(['suggestions'], ({ suggestions }) => renderSuggestions(suggestions || []));
  }
}

function setDebugMode(enabled) {
  els.debugSection.classList.toggle('hidden', !enabled);
}

function setPaused(paused) {
  isPaused = paused;
  els.pause.textContent = paused ? '▶' : '⏸';
  els.pause.title = paused ? 'Resume' : 'Pause';
  els.liveIndicator.textContent = paused ? '⏸ PAUSED' : '● LIVE';
  els.liveIndicator.className = 'indicator' + (paused ? ' paused' : '');
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderSuggestions(suggestions) {
  if (!suggestions.length) {
    els.suggestionsList.innerHTML = '<p class="empty-hint">Waiting for conversation...</p>';
    return;
  }
  // Undone questions first, done questions at the bottom (stable sort within each group)
  const sorted = [...suggestions].sort((a, b) => (doneSet.has(a) ? 1 : 0) - (doneSet.has(b) ? 1 : 0));
  els.suggestionsList.innerHTML = sorted.map(q => {
    const done = doneSet.has(q);
    return `<div class="suggestion-item${done ? ' done' : ''}" data-q="${escapeAttr(q)}">` +
      `<span class="suggestion-text">${escapeHtml(q)}</span>` +
      `<button class="check-btn${done ? ' done' : ''}" title="${done ? 'Unmark' : 'Mark done'}">✓</button>` +
      `</div>`;
  }).join('');
  // Only auto-scroll if no items are done yet (don't yank scroll position mid-meeting)
  if (!doneSet.size) els.suggestionsList.scrollTop = els.suggestionsList.scrollHeight;
}

els.suggestionsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.check-btn');
  if (!btn) return;
  const q = btn.closest('.suggestion-item')?.dataset?.q;
  if (!q) return;
  if (doneSet.has(q)) doneSet.delete(q); else doneSet.add(q);
  chrome.storage.session.get(['suggestions'], ({ suggestions }) => renderSuggestions(suggestions || []));
});

function transcriptItemInner(speaker, text) {
  const pill = speaker ? `<span class="speaker-pill">${escapeHtml(speaker)}</span>` : '';
  return `${pill}<span class="transcript-text">${escapeHtml(text)}</span>`;
}

function renderTranscript(segments) {
  els.transcriptList.innerHTML = segments
    .map(s => `<div class="transcript-item">${transcriptItemInner(s.speaker, s.text)}</div>`)
    .join('');
  els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
}

function appendTranscriptItem(speaker, text) {
  const empty = els.transcriptList.querySelector('.empty-hint');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'transcript-item';
  div.innerHTML = transcriptItemInner(speaker, text);
  els.transcriptList.appendChild(div);
  els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
}

function renderDebugLog(lines) {
  console.log('[Sidebar] renderDebugLog:', lines.length, 'lines');
  if (!els.debugLog) { console.error('[Sidebar] els.debugLog is null!'); return; }
  els.debugLog.innerHTML = lines.length
    ? lines.map(l => `<div class="debug-line">${escapeHtml(l)}</div>`).join('')
    : '<div class="debug-line" style="color:#475569">Waiting for logs...</div>';
  els.debugLog.scrollTop = els.debugLog.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ── Storage change listeners ──────────────────────────────────────────────────

// local storage — user preferences changed (e.g. debug mode toggled in options)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.debugMode !== undefined) {
    setDebugMode(!!changes.debugMode.newValue);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;

  if (changes.latestCaption?.newValue) {
    const { speaker, text, isUpdate } = changes.latestCaption.newValue;
    if (isUpdate) {
      // Replace the last transcript item in-place — caption was extended, not new
      const items = els.transcriptList.querySelectorAll('.transcript-item');
      const lastItem = items[items.length - 1];
      if (lastItem) {
        lastItem.innerHTML = transcriptItemInner(speaker, text);
      } else {
        appendTranscriptItem(speaker, text);
      }
    } else {
      appendTranscriptItem(speaker, text);
    }
  }

  if (changes.suggestions?.newValue) {
    renderSuggestions(changes.suggestions.newValue);
  }

  if (changes.status?.newValue) {
    setStatus(changes.status.newValue);
  }

  if (changes.captionDetected !== undefined || changes.captionStrategy !== undefined) {
    chrome.storage.session.get(['captionDetected', 'captionStrategy', 'status'], (s) => {
      const detected = s.captionDetected;
      els.liveIndicator.textContent = detected ? '● LIVE' : '○ SEARCHING';
      els.liveIndicator.className = 'indicator' + (detected ? '' : ' waiting');
      if (!changes.status) {
        const stratLabel = s.captionStrategy ? ` (${s.captionStrategy})` : '';
        setStatus(detected ? `Listening${stratLabel}` : 'Searching for captions — enable CC in the meeting');
      }
    });
  }

  if (changes.isPaused !== undefined) {
    setPaused(changes.isPaused.newValue);
  }

  if (changes.isRunning?.newValue === false) {
    endLiveUI();
  }

  if (changes.debugLog !== undefined) {
    console.log('[Sidebar] debugLog storage change, entries:', changes.debugLog.newValue?.length);
    renderDebugLog(changes.debugLog.newValue || []);
  }

  if (changes.suggestionsEnabled !== undefined) {
    setSuggestionsEnabled(changes.suggestionsEnabled.newValue !== false);
  }
});

// ── Controls ──────────────────────────────────────────────────────────────────

els.suggestionsToggle.addEventListener('click', async () => {
  const { suggestionsEnabled } = await chrome.storage.session.get('suggestionsEnabled');
  const next = suggestionsEnabled === false; // toggle
  await chrome.storage.session.set({ suggestionsEnabled: next });
  setSuggestionsEnabled(next);
});

els.pause.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: isPaused ? 'resume' : 'pause' });
});

els.stop.addEventListener('click', () => {
  if (!confirm('End meeting and return to setup?')) return;
  chrome.runtime.sendMessage({ type: 'stop' });
  endLiveUI();
});

els.export.addEventListener('click', exportSession);

els.toggleTranscript.addEventListener('click', () => {
  transcriptCollapsed = !transcriptCollapsed;
  els.transcriptList.style.display = transcriptCollapsed ? 'none' : '';
  els.toggleTranscript.textContent = transcriptCollapsed ? '▸' : '▾';
});

els.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

els.clearDebug.addEventListener('click', () => {
  chrome.storage.session.set({ debugLog: [] });
  els.debugLog.innerHTML = '';
});

function endLiveUI() {
  clearInterval(timerInterval);
  meetingStartTime = null;
  doneSet.clear();
  showScreen('setup');
}

// ── Export ────────────────────────────────────────────────────────────────────

async function exportSession() {
  const state = await chrome.storage.session.get(null);
  const ctx = state.meetingContext || {};
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');

  const lines = [
    'EARBUD SESSION EXPORT',
    '='.repeat(40),
    `Date:    ${dateStr}`,
    `Meeting: ${ctx.meeting_type || '—'}`,
    '',
    'CONTEXT',
    '-'.repeat(40),
    `Type:    ${ctx.meeting_type || '—'}`,
    `Client:  ${ctx.client_background || '—'}`,
    `Goals:   ${ctx.user_goals || '—'}`,
    `Topics:  ${ctx.topics || '—'}`,
    '',
    'TRANSCRIPT',
    '-'.repeat(40),
    ...(state.transcript || []).map(s => (s.speaker ? `[${s.speaker}]: ${s.text}` : s.text)),
    '',
    'SUGGESTED QUESTIONS',
    '-'.repeat(40),
    ...(state.suggestions || []),
    '',
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const slug = (ctx.meeting_type || 'meeting').toLowerCase().replace(/\s+/g, '-');
  const filename = `earbud_${now.toISOString().slice(0, 10)}_${slug}.txt`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

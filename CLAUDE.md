# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Installation & Loading

There is no build step. Load the extension directly into Chrome:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder

After editing any file, click the reload icon on the extension card in `chrome://extensions`. For `content.js` changes, also reload the Meet/Zoom tab.

## Architecture

This is a Manifest V3 Chrome extension with no bundler, no npm, and no dependencies — plain JS files loaded directly by the browser.

### Data flow

```
Google Meet / Zoom page
  └─ content.js (content script)
       │  MutationObserver watches caption DOM
       │  Sends: { type: 'caption', speaker, text }
       ▼
  background.js (service worker)
       │  Owns all mutable state in chrome.storage.session
       │  Triggers LLM call every 50 words or 30 seconds
       │  Writes: suggestions, status, transcript, latestCaption
       ▼
  sidebar.js (side panel)
       └─ Reacts to chrome.storage.onChanged — no direct message port
```

The sidebar **never polls** background.js and **never sends** data to it (except for user actions like start/stop/pause). All real-time updates flow through `chrome.storage.session` change events.

### State

All meeting state lives in `chrome.storage.session` (cleared when browser closes):
- `isRunning`, `isPaused` — lifecycle flags
- `transcript` — array of `{ speaker, text, ts }` segments
- `suggestions` — array of `"→ question"` strings
- `latestCaption` — last caption with `isUpdate` flag for in-place transcript edits
- `wordsSinceLastCall`, `lastCallTime` — LLM trigger counters

User settings (API keys, provider, model) live in `chrome.storage.local` (persisted).

### Caption detection (`content.js`)

The content script tries selector strategies in priority order, with an adaptive fallback:

1. **Known `jsname` attributes** (`YSxPC`, `tgaKEf`, etc.) — Google Meet DOM selectors, fragile and likely to break when Meet updates
2. **Transcript panel / aria-live / role=log** — more stable accessibility-based selectors
3. **Adaptive scan** — watches all `characterData` mutations on `document.body`; locks onto any text node that updates 3+ times with speech-like content

When Meet changes its DOM and captions stop working, run `earbud_debug()` in the DevTools console on the Meet tab to inspect `aria-live` elements and find the new selector to add to `GOOGLE_MEET_STRATEGIES`.

Caption text is debounced with a 900 ms commit timer (`COMMIT_MS`) because Meet builds words incrementally into the same text node.

### LLM routing (`background.js`)

Three providers are supported: **Anthropic**, **Gemini**, **Groq**. The active provider and model are read from `chrome.storage.local` on every LLM call. All providers receive the same system prompt and a sliding window of the last 30 transcript segments.

LLM responses are parsed line-by-line; only lines starting with `→ ` are treated as suggestions.

### System prompt (`sidebar.js`)

`SYSTEM_PROMPT_TEMPLATE` in `sidebar.js` is the master prompt. It is filled with meeting context at session start (`buildSystemPrompt`) and sent to background.js with the `start` message. The prompt instructs the model to output nothing unless a high-value follow-up question is identified.

### Screens (`sidebar.js`)

The sidebar has three screens managed by `showScreen()`:
- `nokey` — shown when no API key is configured
- `setup` — pre-meeting context form
- `live` — active session with suggestions, transcript, controls

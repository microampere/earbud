# earbud

Real-time meeting copilot — a Chrome extension that reads live captions from Google Meet or Zoom and surfaces AI-generated follow-up questions while your client is speaking.

```
┌─────────────────────────────────────┐
│ earbud              ● LIVE   00:08:23│
│ Listening...              ⏸  ⬇  ✕  │
├─────────────────────────────────────┤
│ SUGGESTED QUESTIONS                 │
│                                     │
│ → What changed ~6 months ago        │
│   that triggered this issue?        │
│                                     │
│ → Who owns the support team         │
│   budget — eng or CS?               │
│                                     │
│ → You mentioned Intercom — what     │
│   stopped you from switching?       │
├─────────────────────────────────────┤
│ TRANSCRIPT                        ▾ │
│ [Sarah]: We've been struggling      │
│ with our support queue for about    │
│ six months now...                   │
└─────────────────────────────────────┘
```

## How it works

1. You join a Google Meet or Zoom meeting in Chrome
2. The extension reads live captions from the meeting page DOM
3. Every ~50 words the transcript is sent to Claude
4. Claude generates specific follow-up questions based on what was said
5. Questions appear in the sidebar — only you can see them

The extension never processes audio. It uses the platform's own speech-to-text.

## Requirements

- Google Chrome
- An [Anthropic API key](https://console.anthropic.com/)
- Google Meet or Zoom (browser version at `zoom.us`)

## Setup

**1. Load the extension**

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked** → select the `extension/` folder

**2. Add your API key**

1. Click the Earbud extension icon → **Open Settings** (or right-click → Options)
2. Paste your Anthropic API key
3. Click **Save**

## Usage

1. Open the Earbud sidebar by clicking the extension icon in Chrome's toolbar
2. Fill in the meeting context (type, client background, goals, topics)
3. Join your meeting and **enable captions** in Google Meet or Zoom
4. Click **Start Meeting**

Suggested questions appear in the sidebar as the conversation progresses.

## Controls

| Button | Action |
|--------|--------|
| ⏸ | Pause / resume question generation |
| ⬇ | Download transcript + suggestions as a `.txt` file |
| ✕ | End session, return to setup |

## Troubleshooting captions not appearing

The extension watches the meeting page DOM for caption elements. If captions aren't flowing, open DevTools in the meeting tab (`F12`) → Console and look for `[Earbud]` messages:

- `Observing with strategy: ...` — working correctly
- `Caption container not found — retrying in 3s` — selectors need updating; make sure captions are enabled in the meeting

**To fix broken selectors** after a Meet/Zoom UI update: edit `extension/content.js` and update the selector in `GOOGLE_MEET_STRATEGIES` or `ZOOM_STRATEGIES`. The DevTools Elements panel on the live meeting page will show the current DOM structure.

## Privacy

Your API key is stored in `chrome.storage.local` — it stays in your browser and is never included in the source code. Transcript text is sent to Anthropic's API to generate follow-up questions; nothing is stored remotely.

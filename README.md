# earbud

Real-time meeting copilot — a Chrome extension that reads live captions from Google Meet or Zoom and surfaces AI-generated follow-up questions while your client is speaking.

```
┌─────────────────────────────────────┐
│ earbud              ● LIVE   00:08:23│
│ Listening...         AI  ⏸  ⬇  ✕  │
├─────────────────────────────────────┤
│ SUGGESTED QUESTIONS                 │
│                                     │
│ → What changed ~6 months ago        │
│   that triggered this issue?      ✓ │
│                                     │
│ → Who owns the support team         │
│   budget — eng or CS?             ✓ │
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
3. Every ~50 words (or 30 seconds) the transcript is sent to your AI provider
4. The model generates specific follow-up questions based on what was said
5. Questions appear in the sidebar — only you can see them

The extension never processes audio. It uses the platform's own speech-to-text.

## Requirements

- Google Chrome
- Google Meet or Zoom (browser version at `zoom.us`)
- One of the following AI providers:

| Provider | Key required | Notes |
|----------|-------------|-------|
| **Anthropic** | Yes — [console.anthropic.com](https://console.anthropic.com/) | Default; Claude Haiku recommended |
| **Google Gemini** | Yes — [aistudio.google.com](https://aistudio.google.com/) | Free tier available |
| **Ollama** | No | Runs locally; install [ollama.ai](https://ollama.ai) first |

## Setup

**1. Load the extension**

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked** → select the `extension/` folder

**2. Configure your AI provider**

1. Click the Earbud icon in the toolbar → **Open Settings** (or right-click → Options)
2. Choose your provider (Anthropic, Gemini, or Ollama)
3. Paste your API key — or for Ollama, enter the base URL (default `http://localhost:11434`)
4. Select a model and click **Test Connection** to verify
5. Click **Save**

## Usage

1. Click the Earbud icon to open the sidebar
2. Fill in the meeting context — type, client background, your goals, topics to cover
3. Join your meeting and **enable captions** in Google Meet or Zoom
4. Click **Start Meeting**

Suggested questions appear as the conversation progresses. Click **✓** to mark a question asked, or **✕** to dismiss it.

## Controls

| Button | Action |
|--------|--------|
| AI | Toggle AI suggestions on / off |
| ⏸ | Pause / resume listening |
| ⬇ | Export transcript + suggestions as a `.txt` file |
| ✕ | End session and return to setup |

The transcript and debug log panels are resizable — drag the divider between sections.

## Troubleshooting

**Captions not flowing**

Open DevTools in the meeting tab (`F12`) → Console and look for `[Earbud]` messages:

- `Observing with strategy: ...` — working correctly
- `Caption container not found` — selectors may need updating; make sure captions are enabled

Run `earbud_debug()` in the Console to inspect the caption DOM and identify the current selector. Then update `GOOGLE_MEET_STRATEGIES` or `ZOOM_STRATEGIES` in `extension/content.js`.

**No questions appearing**

Make sure **AI** is toggled on (green) in the live header. Questions only generate when AI mode is enabled.

## Privacy

Your API key is stored in `chrome.storage.local` — it never leaves your browser and is not included in the source code. Transcript text is sent only to your chosen AI provider to generate follow-up questions; nothing is stored remotely. If you use Ollama, all processing stays on your machine.

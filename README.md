# earbud

Real-time meeting copilot. Reads live captions from Google Meet or Zoom, and surfaces follow-up questions on your screen while the client is speaking.

```
┌──────────────────────────────────────────────────────────┐
│  EARBUD  │  Discovery — Acme Corp  │  ● LIVE            │
├──────────────────────────┬───────────────────────────────┤
│  TRANSCRIPT              │  SUGGESTED QUESTIONS          │
│                          │                               │
│  [Sarah]: We've been     │  → What changed ~6 months ago │
│  struggling with our     │    that triggered this?       │
│  support queue for       │                               │
│  about six months now.   │  → Who owns the support team  │
│                          │    budget — eng or CS?        │
│  [You]: What tools are   │                               │
│  you using today?        │                               │
│                          │                               │
│  [Sarah]: Zendesk,       │                               │
│  mostly. We looked at    │                               │
│  Intercom but...         │                               │
├──────────────────────────┴───────────────────────────────┤
│  [P] Pause  [E] Export  [Q] Quit  │  08:23  47 segments  │
└──────────────────────────────────────────────────────────┘
```

## How it works

1. A Chrome extension reads live captions from the meeting page DOM
2. Caption segments are forwarded to a local WebSocket server
3. Every ~50 words (or 30 seconds), the transcript is sent to Claude
4. Claude generates specific follow-up questions based on what was just said
5. Questions appear in the right panel — only you can see them

The app never processes audio. It relies entirely on the platform's built-in speech-to-text.

## Requirements

- Python 3.11+
- Google Chrome
- An [Anthropic API key](https://console.anthropic.com/)
- Google Meet or Zoom (browser version)

## Setup

**1. Install Python dependencies**

```
pip install -r requirements.txt
```

**2. Configure your API key**

```
cp .env.example .env
```

Edit `.env` and set your key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

**3. Install the Chrome extension**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder in this project

The extension icon will appear in your toolbar. It activates automatically on `meet.google.com` and `zoom.us` pages.

## Running

```
python main.py
```

You'll be prompted for meeting context before the session starts:

```
Meeting type (discovery/QBR/demo/status/other): discovery
Client background (1-2 sentences): Acme Corp, mid-market SaaS, ~200 employees
Your goals for this meeting: Qualify for Enterprise tier, understand pain points
Topics to cover (comma-separated, or Enter to skip): tooling, team size, budget
```

Then join your meeting in Chrome and **enable captions** in the meeting UI. The extension will detect the caption container and start streaming automatically.

## Controls

| Key | Action |
|-----|--------|
| `P` | Pause / resume question generation |
| `E` | Export transcript + suggestions to `exports/` |
| `Q` | Quit |
| `Ctrl+C` | Quit (fallback) |

## Configuration

All overrides go in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key |
| `EARBUD_MODEL` | `claude-haiku-4-5-20251001` | Claude model to use |
| `EARBUD_WS_PORT` | `8765` | WebSocket port |
| `EARBUD_TRIGGER_WORDS` | `50` | New words before triggering Claude |
| `EARBUD_TRIGGER_SECS` | `30` | Seconds before triggering Claude regardless |

Use `claude-sonnet-4-6` as the model for more nuanced questions at higher cost.

## Troubleshooting the Chrome extension

The extension reads captions by watching the meeting page DOM. Google and Zoom occasionally change their DOM structure, which can break caption detection.

**To diagnose:** Open DevTools in your meeting tab (`F12`) → Console. Look for `[Earbud]` messages:

- `Detected platform: google-meet` — extension loaded correctly
- `Caption container not found yet — retrying in 3s` — selectors need updating
- `Observing with strategy: ...` — captions are being captured
- `Caption — [Speaker]: text` — segment sent to the app

**To fix broken selectors:** Edit `extension/content.js` and update the `GOOGLE_MEET_STRATEGIES` or `ZOOM_STRATEGIES` arrays near the top of the file. Each strategy has a `findContainer()` function — inspect the live meeting DOM to find the current caption element and update the selector.

## Exported files

Pressing `E` saves a plain-text file to `exports/`:

```
exports/earbud_2026-06-04_1432_discovery.txt
```

The file contains the meeting context, full transcript, and all suggested questions.

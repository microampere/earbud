/**
 * Earbud Caption Bridge — content.js
 *
 * Reads live captions from Google Meet or Zoom Web DOM and forwards
 * each caption segment to the local Earbud WebSocket server.
 *
 * DOM selectors may break when Meet/Zoom update their UI.
 * Check the browser DevTools console for "[Earbud]" log messages to diagnose.
 */

const WS_URL = "ws://localhost:8765";
const RECONNECT_DELAY_MS = 5000;
const DEBOUNCE_MS = 300; // wait for caption to settle before sending

// ── Platform detection ────────────────────────────────────────────────────────

const isGoogleMeet = location.hostname === "meet.google.com";
const isZoom = location.hostname.includes("zoom.us");
const platform = isGoogleMeet ? "google-meet" : isZoom ? "zoom" : "unknown";

console.log(`[Earbud] Detected platform: ${platform}`);

// ── Selector strategies ───────────────────────────────────────────────────────
//
// Each strategy is { findContainer(), extractSegment(node) }.
// We try them in order until one works.
//
// HOW TO DEBUG BROKEN SELECTORS:
//   1. Open DevTools in the Meet/Zoom tab
//   2. Enable captions in the meeting
//   3. Run: document.querySelectorAll('[jsname]') to explore the DOM
//   4. Update GOOGLE_MEET_STRATEGIES below with the correct selector
//
const GOOGLE_MEET_STRATEGIES = [
  {
    name: "jsname=YSxPC (known 2024-2025)",
    findContainer: () => document.querySelector('[jsname="YSxPC"]'),
    extractSegment: (node) => {
      // Speaker is in a sibling/parent span; text is in the node itself
      const container = node.closest('[jsname="YSxPC"]') || node.parentElement;
      const speakerEl = container?.querySelector('[jsname="r4nke"]') ||
                        container?.querySelector('[data-sender-name]');
      return {
        speaker: speakerEl?.textContent?.trim() || "",
        text: node.textContent?.trim() || "",
      };
    },
  },
  {
    name: "jsname=tgaKEf (alternate)",
    findContainer: () => document.querySelector('[jsname="tgaKEf"]'),
    extractSegment: (node) => ({
      speaker: node.closest("[data-sender-name]")?.getAttribute("data-sender-name") || "",
      text: node.textContent?.trim() || "",
    }),
  },
  {
    name: "aria-live caption region (fallback)",
    findContainer: () =>
      document.querySelector('[aria-live="polite"][aria-atomic="false"]') ||
      document.querySelector('[aria-live="assertive"]'),
    extractSegment: (node) => ({
      speaker: "",
      text: node.textContent?.trim() || "",
    }),
  },
];

const ZOOM_STRATEGIES = [
  {
    name: "caption-line class",
    findContainer: () =>
      document.querySelector(".caption-line") ||
      document.querySelector(".live-transcription-subtitle"),
    extractSegment: (node) => {
      const speakerEl = node.closest("[class*=caption]")?.querySelector("[class*=speaker]");
      return {
        speaker: speakerEl?.textContent?.trim() || "",
        text: node.textContent?.trim() || "",
      };
    },
  },
  {
    name: "aria-live polite (zoom fallback)",
    findContainer: () => document.querySelector('[aria-live="polite"]'),
    extractSegment: (node) => ({
      speaker: "",
      text: node.textContent?.trim() || "",
    }),
  },
];

const STRATEGIES = isGoogleMeet ? GOOGLE_MEET_STRATEGIES : ZOOM_STRATEGIES;

// ── WebSocket connection ──────────────────────────────────────────────────────

let ws = null;
let pendingSegments = [];

function send(speaker, text) {
  const payload = JSON.stringify({ speaker, text, timestamp: new Date().toISOString() });
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  } else {
    pendingSegments.push(payload); // buffer while disconnected
  }
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[Earbud] Connected to local server");
    // flush buffered segments
    while (pendingSegments.length > 0) {
      ws.send(pendingSegments.shift());
    }
  };

  ws.onclose = () => {
    console.log(`[Earbud] Disconnected. Retrying in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    // onclose fires after onerror — no duplicate retry needed
  };
}

connect();

// ── Caption observation ───────────────────────────────────────────────────────

let activeStrategy = null;
let observer = null;
let debounceTimer = null;
let lastSentText = "";

function processNode(node, strategy) {
  const { speaker, text } = strategy.extractSegment(node);
  if (!text || text === lastSentText) return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    lastSentText = text;
    console.log(`[Earbud] Caption — ${speaker ? speaker + ": " : ""}${text}`);
    send(speaker, text);
  }, DEBOUNCE_MS);
}

function startObserving(container, strategy) {
  if (observer) observer.disconnect();
  console.log(`[Earbud] Observing with strategy: ${strategy.name}`);
  activeStrategy = strategy;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        processNode(mutation.target, strategy);
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          processNode(node, strategy);
        }
      }
    }
  });

  observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

// Try each strategy in turn; retry every 3s until one finds a container.
// This handles the case where the caption container is injected after page load.
function tryStrategies() {
  for (const strategy of STRATEGIES) {
    const container = strategy.findContainer();
    if (container) {
      startObserving(container, strategy);
      return;
    }
  }
  console.log("[Earbud] Caption container not found yet — retrying in 3s. Enable captions in the meeting.");
  setTimeout(tryStrategies, 3000);
}

// Wait a moment for the meeting UI to render, then start probing.
setTimeout(tryStrategies, 2000);

// Re-probe if the DOM is replaced (e.g., Meet navigating between screens).
const rootObserver = new MutationObserver(() => {
  if (activeStrategy && !activeStrategy.findContainer()) {
    console.log("[Earbud] Caption container lost — re-probing...");
    activeStrategy = null;
    tryStrategies();
  }
});
rootObserver.observe(document.body, { childList: true, subtree: false });

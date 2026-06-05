/**
 * content.js — reads live captions from Google Meet or Zoom Web DOM
 * and forwards each segment to background.js via chrome.runtime.sendMessage.
 *
 * DOM selectors may break when Meet/Zoom update their UI.
 * Check the DevTools console for "[Earbud]" messages to diagnose.
 *
 * HOW TO FIX BROKEN SELECTORS:
 *   1. Open DevTools in the meeting tab, enable captions
 *   2. Run: document.querySelectorAll('[jsname]') to explore the DOM
 *   3. Update GOOGLE_MEET_STRATEGIES below with the correct selector
 */

const isGoogleMeet = location.hostname === 'meet.google.com';
const isZoom = location.hostname.includes('zoom.us');
const platform = isGoogleMeet ? 'google-meet' : isZoom ? 'zoom' : 'unknown';

console.log(`[Earbud] Platform: ${platform}`);

// ── Selector strategies ───────────────────────────────────────────────────────

const GOOGLE_MEET_STRATEGIES = [
  {
    name: 'jsname=YSxPC',
    findContainer: () => document.querySelector('[jsname="YSxPC"]'),
    extractSegment(node) {
      const container = node.closest('[jsname="YSxPC"]') || node.parentElement;
      const speakerEl = container?.querySelector('[jsname="r4nke"]') ||
                        container?.querySelector('[data-sender-name]');
      return { speaker: speakerEl?.textContent?.trim() || '', text: node.textContent?.trim() || '' };
    },
  },
  {
    name: 'jsname=tgaKEf',
    findContainer: () => document.querySelector('[jsname="tgaKEf"]'),
    extractSegment: (node) => ({
      speaker: node.closest('[data-sender-name]')?.getAttribute('data-sender-name') || '',
      text: node.textContent?.trim() || '',
    }),
  },
  {
    name: 'aria-live polite (fallback)',
    findContainer: () =>
      document.querySelector('[aria-live="polite"][aria-atomic="false"]') ||
      document.querySelector('[aria-live="assertive"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },
];

const ZOOM_STRATEGIES = [
  {
    name: 'caption-line',
    findContainer: () =>
      document.querySelector('.caption-line') ||
      document.querySelector('.live-transcription-subtitle'),
    extractSegment(node) {
      const speakerEl = node.closest('[class*=caption]')?.querySelector('[class*=speaker]');
      return { speaker: speakerEl?.textContent?.trim() || '', text: node.textContent?.trim() || '' };
    },
  },
  {
    name: 'aria-live polite',
    findContainer: () => document.querySelector('[aria-live="polite"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },
];

const STRATEGIES = isGoogleMeet ? GOOGLE_MEET_STRATEGIES : ZOOM_STRATEGIES;

// ── Caption observation ───────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;
let activeStrategy = null;
let observer = null;
let debounceTimer = null;
let lastSentText = '';

function processNode(node, strategy) {
  const { speaker, text } = strategy.extractSegment(node);
  if (!text || text === lastSentText) return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    lastSentText = text;
    console.log(`[Earbud] ${speaker ? speaker + ': ' : ''}${text}`);
    chrome.runtime.sendMessage({ type: 'caption', speaker, text });
  }, DEBOUNCE_MS);
}

function startObserving(container, strategy) {
  if (observer) observer.disconnect();
  console.log(`[Earbud] Observing with strategy: ${strategy.name}`);
  activeStrategy = strategy;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') processNode(mutation.target, strategy);
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          processNode(node, strategy);
        }
      }
    }
  });

  observer.observe(container, { subtree: true, childList: true, characterData: true });
}

function tryStrategies() {
  for (const strategy of STRATEGIES) {
    const container = strategy.findContainer();
    if (container) { startObserving(container, strategy); return; }
  }
  console.log('[Earbud] Caption container not found — retrying in 3s. Enable captions in the meeting.');
  setTimeout(tryStrategies, 3000);
}

// Re-probe if the caption container disappears (Meet navigating between screens)
const rootObserver = new MutationObserver(() => {
  if (activeStrategy && !activeStrategy.findContainer()) {
    console.log('[Earbud] Caption container lost — re-probing...');
    activeStrategy = null;
    tryStrategies();
  }
});
rootObserver.observe(document.body, { childList: true, subtree: false });

setTimeout(tryStrategies, 2000);

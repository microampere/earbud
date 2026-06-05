/**
 * content.js — reads live captions from Google Meet or Zoom Web DOM
 *
 * DEBUGGING: Open DevTools → Console and look for [Earbud] messages.
 * If you see "No strategy found", run this in the console to help diagnose:
 *
 *   earbud_debug()
 *
 * It will print all aria-live elements and their text so you can find
 * the right selector and update GOOGLE_MEET_STRATEGIES below.
 */

const isGoogleMeet = location.hostname === 'meet.google.com';
const isZoom = location.hostname.includes('zoom.us');
const platform = isGoogleMeet ? 'google-meet' : isZoom ? 'zoom' : 'unknown';

console.log(`[Earbud] Loaded on ${platform}`);

// ── Selector strategies ───────────────────────────────────────────────────────
// Tried in order. The first one whose findContainer() returns a non-null element wins.

const GOOGLE_MEET_STRATEGIES = [
  // ── Known jsname attributes (update these when Meet changes their DOM) ──
  {
    name: 'jsname=YSxPC',
    findContainer: () => document.querySelector('[jsname="YSxPC"]'),
    extractSegment: (node) => {
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
    name: 'jsname=dsyhDe',
    findContainer: () => document.querySelector('[jsname="dsyhDe"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },
  {
    name: 'jsname=n8FYJd',
    findContainer: () => document.querySelector('[jsname="n8FYJd"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },

  // ── Transcript / side panel ──
  {
    name: 'transcript-panel',
    findContainer: () =>
      document.querySelector('[data-panel-id="transcript"]') ||
      document.querySelector('[aria-label*="Transcript"]') ||
      document.querySelector('[aria-label*="transcript"]'),
    extractSegment: (node) => {
      const item = node.closest('[data-speaker-id], [data-participant-id]');
      const speakerEl = item?.querySelector('[data-speaker-name], [class*="speaker"]');
      return { speaker: speakerEl?.textContent?.trim() || '', text: node.textContent?.trim() || '' };
    },
  },

  // ── aria-live regions (accessibility attributes — most stable fallback) ──
  {
    name: 'aria-live=polite',
    findContainer: () => {
      const candidates = [...document.querySelectorAll('[aria-live="polite"]')];
      // Prefer elements that already contain some text (captions are likely there)
      return candidates.find(el => el.textContent.trim().length > 5) || candidates[0] || null;
    },
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },
  {
    name: 'aria-live=assertive',
    findContainer: () => document.querySelector('[aria-live="assertive"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },
  {
    name: 'role=log',
    findContainer: () => document.querySelector('[role="log"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },

];

const ZOOM_STRATEGIES = [
  {
    name: 'caption-line',
    findContainer: () =>
      document.querySelector('.caption-line') ||
      document.querySelector('.live-transcription-subtitle'),
    extractSegment: (node) => {
      const speakerEl = node.closest('[class*=caption]')?.querySelector('[class*=speaker]');
      return { speaker: speakerEl?.textContent?.trim() || '', text: node.textContent?.trim() || '' };
    },
  },
  {
    name: 'aria-live=polite',
    findContainer: () => document.querySelector('[aria-live="polite"]'),
    extractSegment: (node) => ({ speaker: '', text: node.textContent?.trim() || '' }),
  },
];

const STRATEGIES = isGoogleMeet ? GOOGLE_MEET_STRATEGIES : ZOOM_STRATEGIES;

// ── Debug helper — run earbud_debug() in DevTools console ────────────────────

window.earbud_debug = function () {
  console.group('[Earbud] Debug report');
  console.log('Platform:', platform);
  console.log('Active strategy:', activeStrategy?.name || 'none');
  console.log('Adaptive scan active:', adaptiveScanActive);
  console.log('\nAll aria-live elements:');
  document.querySelectorAll('[aria-live]').forEach(el => {
    console.log(' ', el.tagName, el.getAttribute('aria-live'), '|', el.textContent.slice(0, 80));
  });
  console.log('\nAll role=log elements:');
  document.querySelectorAll('[role="log"]').forEach(el => {
    console.log(' ', el.tagName, '|', el.textContent.slice(0, 80));
  });
  console.log('\nKnown jsname elements present:');
  ['YSxPC', 'tgaKEf', 'dsyhDe', 'n8FYJd'].forEach(name => {
    const el = document.querySelector(`[jsname="${name}"]`);
    console.log(` jsname=${name}:`, el ? 'FOUND — ' + el.textContent.slice(0, 60) : 'not found');
  });
  console.groupEnd();
};

// ── Caption observation ───────────────────────────────────────────────────────

// How this works:
// Google Meet builds captions word-by-word, mutating the same text node.
// We accumulate updates into `pending` and only send after COMMIT_MS of silence,
// OR immediately when a brand-new sentence starts (doesn't extend pending).
// This prevents the "double" lines seen when the debounce fires mid-sentence.

const COMMIT_MS = 900; // ms of silence before we treat a caption as final

let activeStrategy = null;
let observer = null;
let commitTimer = null;
let pending = { speaker: '', text: '' }; // building caption
let lastSentText = ''; // last text we actually sent
let adaptiveScanActive = false;

// UI-text patterns to ignore (Meet shows keyboard shortcuts in the caption area)
const UI_TEXT_RE = /^(Turn (on|off)|ctrl\s*\+|shift\s*\+|alt\s*\+|\([a-z]\))/i;

function commitPending() {
  clearTimeout(commitTimer);
  const { speaker, text } = pending;
  pending = { speaker: '', text: '' };
  if (!text || text === lastSentText) return;
  lastSentText = text;
  console.log(`[Earbud] Caption — ${speaker ? speaker + ': ' : ''}${text}`);
  chrome.runtime.sendMessage({ type: 'caption', speaker, text }, () => void chrome.runtime.lastError);
}

// Strip trailing punctuation before prefix checks.
// Meet adds "?" or "." mid-stream then keeps building the same text node,
// so "How?" → "How do I?" would fail a plain startsWith without this.
const normEnd = s => s.replace(/[?.!,;:]+$/, '');

function processNode(node, strategy) {
  const { speaker, text } = strategy.extractSegment(node);
  if (!text) return;
  if (UI_TEXT_RE.test(text)) return;

  // Exact duplicate — skip
  if (text === lastSentText) return;

  // Extension of the last committed text (Meet revised the same node after we committed)
  if (lastSentText.length > 0 && text.startsWith(normEnd(lastSentText))) {
    pending = { speaker: speaker || pending.speaker, text };
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commitPending, COMMIT_MS);
    return;
  }

  // Extension of what we're already building → keep accumulating
  if (pending.text === '' || text.startsWith(normEnd(pending.text))) {
    pending = { speaker: speaker || pending.speaker, text };
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commitPending, COMMIT_MS);
    return;
  }

  // Completely new sentence → commit whatever we had, start fresh
  commitPending();
  pending = { speaker, text };
  commitTimer = setTimeout(commitPending, COMMIT_MS);
}

function startObserving(container, strategy) {
  if (observer) observer.disconnect();
  console.log(`[Earbud] Observing with strategy: ${strategy.name}`);
  activeStrategy = strategy;
  chrome.runtime.sendMessage({ type: 'captionStatus', active: true, strategy: strategy.name }, () => void chrome.runtime.lastError);

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        processNode(mutation.target, strategy);
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          processNode(node, strategy);
        }
      }
    }
  });

  const config = { subtree: true, childList: true, characterData: true };
  observer.observe(container, config);
}

// ── Adaptive scan ─────────────────────────────────────────────────────────────
// When no known selector matches, watch only characterData mutations on the whole
// page. Text nodes that update repeatedly (3+ times) and look like speech lock in
// as the caption container — no hardcoded selectors needed.

function startAdaptiveScan() {
  if (adaptiveScanActive) return;
  adaptiveScanActive = true;
  console.log('[Earbud] No known selector matched — starting adaptive scan (characterData only)');

  const hitCount = new Map();
  const LOCK_AFTER = 3;

  const adaptiveObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'characterData') continue;
      const node = mutation.target;
      const text = (node.data || '').trim();

      // Must look like speech: 3–50 words, 10–400 chars, not a UI phrase
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (text.length < 10 || text.length > 400) continue;
      if (wordCount < 3 || wordCount > 50) continue;
      if (UI_TEXT_RE.test(text)) continue;

      const count = (hitCount.get(node) || 0) + 1;
      hitCount.set(node, count);

      if (count >= LOCK_AFTER) {
        adaptiveObserver.disconnect();
        adaptiveScanActive = false;

        const container = node.parentElement || document.body;
        console.log('[Earbud] Adaptive scan locked on:', container.tagName, (container.className || '').slice(0, 60));

        const lockedStrategy = {
          name: 'adaptive (auto-detected)',
          findContainer: () => (document.contains(container) ? container : null),
          extractSegment: (n) => {
            const t = (n.textContent || n.data || '').trim();
            // Walk up from container's parent to find a speaker name element
            // (speaker is typically a sibling or cousin, not a descendant)
            let speaker = '';
            for (let el = container.parentElement; el && el !== document.body; el = el.parentElement) {
              const s = el.querySelector('[jsname="r4nke"]') || el.querySelector('[data-sender-name]');
              if (s && s.textContent?.trim()) { speaker = s.textContent.trim(); break; }
            }
            return { speaker, text: t };
          },
        };

        startObserving(container, lockedStrategy);
        return;
      }
    }
  });

  adaptiveObserver.observe(document.body, {
    subtree: true,
    childList: false,
    characterData: true,
  });
}

function tryStrategies() {
  if (activeStrategy) return; // already locked on — stop retrying
  for (const strategy of STRATEGIES) {
    const container = strategy.findContainer();
    if (container) {
      startObserving(container, strategy);
      return;
    }
  }
  // No specific strategy matched — fall back to adaptive scan
  startAdaptiveScan();
  console.log('[Earbud] No caption container found yet — make sure CC is enabled. Run earbud_debug() for diagnostics.');
  chrome.runtime.sendMessage({ type: 'captionStatus', active: false, strategy: null }, () => void chrome.runtime.lastError);
  setTimeout(tryStrategies, 5000);
}

// Re-probe if the active container disappears (Meet navigating between screens)
const rootObserver = new MutationObserver(() => {
  if (activeStrategy && !activeStrategy.findContainer()) {
    console.log('[Earbud] Caption container lost — re-probing...');
    activeStrategy = null;
    chrome.runtime.sendMessage({ type: 'captionStatus', active: false, strategy: null }, () => void chrome.runtime.lastError);
    tryStrategies();
  }
});
rootObserver.observe(document.body, { childList: true, subtree: false });

setTimeout(tryStrategies, 2000);

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

function dbg(msg) {
  console.log('[Earbud]', msg);
  chrome.runtime.sendMessage({ type: 'debug', message: msg }, () => void chrome.runtime.lastError);
}

dbg(`content script loaded on ${platform}`);

// ── Selector strategies ───────────────────────────────────────────────────────
// Tried in order. The first one whose findContainer() returns a non-null element wins.

const GOOGLE_MEET_STRATEGIES = [
  // ── Captions panel — each child element is one complete speaker turn ──
  // Emits the previous child when a new one appears (one-statement delay).
  {
    name: 'aria-label=Captions',
    findContainer: () => document.querySelector('[aria-label="Captions"]'),
    start(container) { startCaptionsPanelObserver(container, this); },
  },

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
    start(container) { startCaptionsPanelObserver(container, this); },
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

  // aria-live / role=log removed — they exist in Meet before captions are enabled and lock in
  // on the wrong element before the adaptive scan can find the real caption container.
  // The adaptive scan handles these cases more reliably by requiring speech-like mutations.

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
  // aria-live removed — adaptive scan handles unknown DOM more reliably
];

const STRATEGIES = isGoogleMeet ? GOOGLE_MEET_STRATEGIES : ZOOM_STRATEGIES;

// ── Debug helper — run earbud_debug() in DevTools console ────────────────────

window.earbud_debug = function () {
  console.group('[Earbud] Debug report');
  console.log('Platform:', platform);
  console.log('Active strategy:', activeStrategy?.name || 'none');
  console.log('Adaptive scan active:', adaptiveScanActive);
  console.log('Last caption time:', lastCaptionTime ? new Date(lastCaptionTime).toISOString() : 'never');

  console.log('\nKnown jsname elements present:');
  ['YSxPC', 'tgaKEf', 'dsyhDe', 'n8FYJd'].forEach(name => {
    const el = document.querySelector(`[jsname="${name}"]`);
    if (el) {
      console.log(` jsname=${name}: FOUND — childCount=${el.children.length} text="${el.textContent.slice(0, 80)}"`);
    } else {
      console.log(` jsname=${name}: not found`);
    }
  });

  console.log('\naria-label=Captions element:');
  const captionsEl = document.querySelector('[aria-label="Captions"]') || document.querySelector('[aria-label*="Caption"]');
  if (captionsEl) {
    console.log(' FOUND — childCount:', captionsEl.children.length, '| aria-label:', captionsEl.getAttribute('aria-label'));
    Array.from(captionsEl.children).slice(-3).forEach((child, i) => {
      const nameEl = child.querySelector('.NWpY1d');
      const innerDivs = child.querySelectorAll(':scope > div');
      const textDiv = innerDivs[innerDivs.length - 1];
      console.log(`  child[-${3 - i}]: speaker="${nameEl?.textContent?.trim()}" text="${textDiv?.textContent?.trim()?.slice(0, 60)}"`);
    });
  } else {
    console.log(' NOT FOUND — try: document.querySelector(\'[aria-label*="caption" i]\')');
    // Show all elements with aria-label containing "caption" (case-insensitive)
    document.querySelectorAll('[aria-label]').forEach(el => {
      if (el.getAttribute('aria-label').toLowerCase().includes('caption')) {
        console.log('  possible match:', el.tagName, `"${el.getAttribute('aria-label')}"`, 'childCount:', el.children.length);
      }
    });
  }

  console.log('\nAll aria-live elements:');
  document.querySelectorAll('[aria-live]').forEach(el => {
    console.log(' ', el.tagName, el.getAttribute('aria-live'), '|', el.textContent.slice(0, 80));
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
let lastCaptionTime = 0; // updated each time a caption is committed

const WATCHDOG_MS = 10_000; // re-probe if no caption received within this window
let watchdogInterval = null;

// UI-text patterns to ignore (Meet shows keyboard shortcuts in the caption area)
const UI_TEXT_RE = /^(Turn (on|off)|ctrl\s*\+|shift\s*\+|alt\s*\+|\([a-z]\))/i;

function commitPending() {
  clearTimeout(commitTimer);
  const { speaker, text } = pending;
  pending = { speaker: '', text: '' };
  if (!text || text === lastSentText) return;
  lastSentText = text;
  lastCaptionTime = Date.now();
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

// ── Captions panel observer ───────────────────────────────────────────────────
// Each direct child of [aria-label="Captions"] is a complete speaker turn.
// We emit the PREVIOUS child when a new one arrives — that signals the previous
// turn is finished and won't receive more words.

// Identify a caption item by structure: direct child of the captions container
// that has an <img> (speaker avatar) inside it.
function isCaptionItem(el) {
  return el.nodeType === Node.ELEMENT_NODE && !!el.querySelector('img');
}

// Extract speaker + text using structure only — no class names.
// Speaker: first <span> inside the div that contains the <img>.
// Text: the direct-child div that has no child elements (pure text node).
function extractCaptionItem(el) {
  const divs = Array.from(el.querySelectorAll(':scope > div'));
  const speakerDiv = divs.find(d => d.querySelector('img'));
  const textDiv = divs.find(d => d.children.length === 0);
  return {
    speaker: speakerDiv?.querySelector('span')?.textContent?.trim() || '',
    text: textDiv?.textContent?.trim() || '',
  };
}

function startCaptionsPanelObserver(container, strategy) {
  if (observer) observer.disconnect();
  clearTimeout(commitTimer);
  pending = { speaker: '', text: '' };
  activeStrategy = strategy;
  let flushTimer = null;
  chrome.runtime.sendMessage({ type: 'captionStatus', active: true, strategy: strategy.name }, () => void chrome.runtime.lastError);

  const existingItems = Array.from(container.children).filter(isCaptionItem);
  let prevChild = existingItems.length > 0 ? existingItems[existingItems.length - 1] : null;
  dbg(`[caption listener] container="${container.getAttribute('aria-label')}" children=${container.children.length} captionItems=${existingItems.length}`);

  function emitChild(el) {
    const { speaker, text } = extractCaptionItem(el);
    dbg(`[caption listener] emit: speaker="${speaker}" text="${text.slice(0, 60)}"`);
    if (!text || text === lastSentText) { dbg('[caption listener] skip: empty or duplicate'); return; }
    lastSentText = text;
    lastCaptionTime = Date.now();
    chrome.runtime.sendMessage({ type: 'caption', speaker, text }, () => void chrome.runtime.lastError);
  }

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      for (const node of mutation.addedNodes) {
        if (!isCaptionItem(node)) {
          if (node.nodeType === Node.ELEMENT_NODE) dbg(`[caption listener] skip non-caption child (no img)`);
          continue;
        }
        const { speaker, text } = extractCaptionItem(node);
        dbg(`[caption listener] caption added: speaker="${speaker}" text="${text.slice(0, 40)}" prevChild=${!!prevChild}`);
        clearTimeout(flushTimer);
        if (prevChild) emitChild(prevChild);
        prevChild = node;
        // Flush after 5 s of silence — handles the last caption when no new one arrives
        flushTimer = setTimeout(() => {
          if (prevChild) { emitChild(prevChild); prevChild = null; }
        }, 5000);
      }
    }
  });

  observer.observe(container, { childList: true });
}

function startObserving(containerOrList, strategy) {
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
  // Support observing multiple containers (e.g. all aria-live=polite elements)
  const containers = Array.isArray(containerOrList) ? containerOrList : [containerOrList];
  for (const c of containers) observer.observe(c, config);
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

  function scoreAdaptiveNode(text, container) {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (text.length < 10 || text.length > 400) return false;
    if (wordCount < 3 || wordCount > 50) return false;
    if (UI_TEXT_RE.test(text)) return false;
    return true;
  }

  const adaptiveObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      let text = '';
      let container = null;

      if (mutation.type === 'characterData') {
        text = (mutation.target.data || '').trim();
        container = mutation.target.parentElement || document.body;
      } else if (mutation.type === 'childList') {
        // Catch span-append pattern: Meet adds word spans one at a time.
        // Check the parent's accumulated text, not the individual added node.
        if (mutation.addedNodes.length > 0) {
          const c = mutation.target;
          const t = c.textContent.trim();
          if (scoreAdaptiveNode(t, c)) {
            text = t;
            container = c;
          }
        }
      }

      if (!text || !container) continue;
      if (!scoreAdaptiveNode(text, container)) continue;

      // Key by container element so word-by-word appends accumulate on the same node
      const count = (hitCount.get(container) || 0) + 1;
      hitCount.set(container, count);

      if (count >= LOCK_AFTER) {
        adaptiveObserver.disconnect();
        adaptiveScanActive = false;

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
        // Immediately flush whatever text has already accumulated in the container
        processNode(container, lockedStrategy);
        return;
      }
    }
  });

  adaptiveObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

function tryStrategies() {
  if (activeStrategy) return;
  dbg(`tryStrategies: checking ${STRATEGIES.length} strategies`);
  for (const strategy of STRATEGIES) {
    const container = strategy.findContainer();
    const found = Array.isArray(container) ? container.length > 0 : !!container;
    dbg(`  ${strategy.name}: ${found ? 'FOUND' : 'not found'}`);
    if (found) {
      if (strategy.start) {
        strategy.start(container);
      } else {
        startObserving(container, strategy);
      }
      return;
    }
  }
  startAdaptiveScan();
  dbg('No caption container found — make sure CC is enabled');
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

// ── Watchdog ──────────────────────────────────────────────────────────────────
// If we're locked onto a strategy but no caption arrives within WATCHDOG_MS,
// the container is probably wrong or stale. Reset and re-probe.
watchdogInterval = setInterval(() => {
  if (!activeStrategy) return;
  // Re-probe if: no caption ever received (locked on wrong element), OR captions stopped
  const stale = lastCaptionTime === 0 || Date.now() - lastCaptionTime > WATCHDOG_MS;
  if (stale) {
    console.log('[Earbud] Watchdog: no caption in', WATCHDOG_MS / 1000, 's — re-probing');
    if (observer) { observer.disconnect(); observer = null; }
    activeStrategy = null;
    chrome.runtime.sendMessage({ type: 'captionStatus', active: false, strategy: null }, () => void chrome.runtime.lastError);
    tryStrategies();
  }
}, WATCHDOG_MS);

/**
 * Adaptive Engine Selection
 * 
 * Tracks per-domain load performance and automatically learns which proxy
 * engine (Ultraviolet or Scramjet) works best for each site. Preferences
 * are persisted in localStorage with a 7-day TTL.
 */

const STORAGE_KEY = 'dogeub_engine_prefs';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TIMEOUT_MS = 12_000; // 12 seconds before a load is considered failed
const MAX_RETRIES = 1;

// In-memory map of active load timers: tabId -> { hostname, engine, startTime, timer }
const activeTimers = new Map();

// ─── localStorage helpers ──────────────────────────────────────────

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const prefs = JSON.parse(raw);
    const now = Date.now();
    // purge expired entries
    for (const host of Object.keys(prefs)) {
      if (now - prefs[host].updatedAt > TTL_MS) delete prefs[host];
    }
    return prefs;
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* quota errors are non-fatal */ }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Returns the learned preferred engine for a hostname, or null if
 * there is no stored preference (fall back to static whitelist).
 * @param {string} hostname  e.g. "google.com"
 * @returns {'uv'|'scr'|null}
 */
export function getPreferredEngine(hostname) {
  if (!hostname) return null;
  const prefs = loadPrefs();
  const entry = prefs[hostname];
  if (!entry) return null;
  return entry.engine; // 'uv' or 'scr'
}

/**
 * Determines which engine is currently being used from a proxied URL.
 * @param {string} url  The full proxied URL
 * @returns {'uv'|'scr'|null}
 */
export function detectEngine(url) {
  if (!url) return null;
  if (url.includes('/ham/')) return 'scr';
  if (url.includes('/portal/k12/')) return 'uv';
  return null;
}

/**
 * Returns the alternate engine.
 * @param {'uv'|'scr'} engine
 * @returns {'uv'|'scr'}
 */
export function getAlternateEngine(engine) {
  return engine === 'scr' ? 'uv' : 'scr';
}

/**
 * Begins tracking a tab's load. Called when the iframe starts loading
 * a proxied URL.
 * @param {string} tabId
 * @param {string} hostname  Domain being loaded
 * @param {'uv'|'scr'} engine  Engine used for this load
 * @param {function} onTimeout  Callback: (tabId, hostname, engine) => void
 */
export function startTracking(tabId, hostname, engine, onTimeout) {
  // clear any previous timer for this tab
  stopTracking(tabId);

  const startTime = Date.now();
  const timer = setTimeout(() => {
    console.log(`[AdaptiveEngine] Timeout for ${hostname} on ${engine} (${TIMEOUT_MS}ms)`);
    if (onTimeout) onTimeout(tabId, hostname, engine);
  }, TIMEOUT_MS);

  activeTimers.set(tabId, { hostname, engine, startTime, timer });
}

/**
 * Stops tracking without recording any result. Used on tab close, etc.
 * @param {string} tabId
 */
export function stopTracking(tabId) {
  const entry = activeTimers.get(tabId);
  if (entry) {
    clearTimeout(entry.timer);
    activeTimers.delete(tabId);
  }
}

/**
 * Records a successful load for the tab's domain. Saves the engine as
 * the preferred engine for this hostname.
 * @param {string} tabId
 */
export function recordSuccess(tabId) {
  const entry = activeTimers.get(tabId);
  if (!entry) return;

  const elapsed = Date.now() - entry.startTime;
  clearTimeout(entry.timer);
  activeTimers.delete(tabId);

  const prefs = loadPrefs();
  prefs[entry.hostname] = {
    engine: entry.engine,
    loadTime: elapsed,
    updatedAt: Date.now(),
  };
  savePrefs(prefs);

  console.log(
    `[AdaptiveEngine] ${entry.hostname} loaded in ${elapsed}ms via ${entry.engine} — saved preference`
  );
}

/**
 * Records a failed load (timeout or proxy error). Returns info about
 * whether a retry with the alternate engine should be attempted.
 * @param {string} tabId
 * @returns {{ shouldRetry: boolean, alternateEngine: 'uv'|'scr'|null, hostname: string|null }}
 */
export function recordFailure(tabId) {
  const entry = activeTimers.get(tabId);
  if (!entry) return { shouldRetry: false, alternateEngine: null, hostname: null };

  clearTimeout(entry.timer);
  activeTimers.delete(tabId);

  const alt = getAlternateEngine(entry.engine);

  console.log(
    `[AdaptiveEngine] ${entry.hostname} failed on ${entry.engine} — suggesting retry on ${alt}`
  );

  return {
    shouldRetry: true,
    alternateEngine: alt,
    hostname: entry.hostname,
  };
}

/**
 * Extracts the hostname from a URL string.
 * @param {string} url
 * @returns {string|null}
 */
export function extractHostname(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Returns the timeout threshold in ms. Exported so Viewer can reference it.
 */
export const LOAD_TIMEOUT = TIMEOUT_MS;

/**
 * Returns the max retries allowed.
 */
export const MAX_ENGINE_RETRIES = MAX_RETRIES;

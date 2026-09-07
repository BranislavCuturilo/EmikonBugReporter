// Orchestrator. Owns exactly three things the UI pages cannot own themselves:
//   - the chrome.debugger attachment (console + network, via CDP)
//   - tab screenshots
//   - which session is currently recording
//
// Everything else -- reading and writing sessions, evidence, chat, drafts --
// the panel and the review page do DIRECTLY against IndexedDB, because they
// share this extension's origin. Routing those through here would only add a
// message hop that dies with the worker.

import { parsePageComment, parseSessionComment } from "../lib/page-context.js";
import {
  emptySession, putSession, patchSession, appendConsole, appendNetwork,
  appendPage, addEvidence,
} from "../lib/session-store.js";
import { captureViewport, captureRegion, captureFullPage } from "./capture.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

const CDP_VERSION = "1.3";

// Event buffers. CDP fires far faster than IndexedDB should be written, so
// events accumulate here and flush on a debounce. The worker can die between
// flushes, which is exactly why FLUSH_MS is small and why nothing else is kept
// in memory.
const FLUSH_MS = 1000;
let bufConsole = [];
let bufNetwork = [];
let flushTimer = null;

// requestId -> partial row, until the response or the failure completes it.
const inflight = new Map();

// -- active session pointer ------------------------------------------------
// chrome.storage.session survives worker restarts within a browser session,
// which is the exact lifetime we need. A module-level variable would not.

async function getActive() {
  const { active } = await chrome.storage.session.get("active");
  return active || null; // {sessionId, tabId}
}
const setActive = (active) => chrome.storage.session.set({ active });
const clearActive = () => chrome.storage.session.remove("active");

// -- flushing --------------------------------------------------------------

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_MS);
}

async function flush() {
  const active = await getActive();
  if (!active) {
    bufConsole = [];
    bufNetwork = [];
    return;
  }
  const con = bufConsole;
  bufConsole = [];
  const net = bufNetwork;
  bufNetwork = [];
  if (con.length) await appendConsole(active.sessionId, con);
  if (net.length) await appendNetwork(active.sessionId, net);
}

// -- CDP -------------------------------------------------------------------

async function attach(tabId) {
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  // Log.enable catches what Runtime does not: failed subresources, CORS
  // refusals, mixed-content blocks -- the browser-level complaints that explain
  // half of "the page just doesn't load" reports.
  for (const domain of ["Network.enable", "Runtime.enable", "Log.enable", "Page.enable"]) {
    await chrome.debugger.sendCommand({ tabId }, domain).catch(() => {});
  }
}

async function detach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  handleCdp(source, method, params).catch(() => {});
});

async function handleCdp(source, method, params) {
  const active = await getActive();
  if (!active || source.tabId !== active.tabId) return;

  switch (method) {
    case "Network.requestWillBeSent":
      inflight.set(params.requestId, {
        method: params.request?.method || "GET",
        url: params.request?.url || "",
        ts: Date.now(),
        type: params.type || "",
      });
      break;

    case "Network.responseReceived": {
      const row = inflight.get(params.requestId);
      if (!row) break;
      row.status = params.response?.status ?? 0;
      // Only failures are kept. A bug report is not a HAR file, and a 200 has
      // never explained a defect.
      if (row.status >= 400) bufNetwork.push({ ...row });
      inflight.delete(params.requestId);
      scheduleFlush();
      break;
    }

    case "Network.loadingFailed": {
      const row = inflight.get(params.requestId);
      if (!row) break;
      // canceled requests are navigation noise, not evidence
      if (!params.canceled) {
        bufNetwork.push({ ...row, status: 0, errorText: params.errorText || "loading failed" });
        scheduleFlush();
      }
      inflight.delete(params.requestId);
      break;
    }

    case "Runtime.consoleAPICalled": {
      const level =
        params.type === "warning" ? "warning" : params.type === "error" ? "error" : "info";
      if (level === "info") break; // noise; see prompts.js
      const frame = params.stackTrace?.callFrames?.[0];
      bufConsole.push({
        level,
        text: (params.args || []).map(previewOf).join(" ").slice(0, 2000),
        url: frame?.url || "",
        line: frame?.lineNumber ?? null,
        ts: Date.now(),
      });
      scheduleFlush();
      break;
    }

    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      const desc = d.exception?.description || d.text || "uncaught exception";
      bufConsole.push({
        level: "error",
        text: String(desc).slice(0, 2000),
        url: d.url || "",
        line: d.lineNumber ?? null,
        ts: Date.now(),
      });
      scheduleFlush();
      break;
    }

    case "Log.entryAdded": {
      const e = params.entry || {};
      if (e.level !== "error" && e.level !== "warning") break;
      bufConsole.push({
        level: e.level,
        text: String(e.text || "").slice(0, 2000),
        url: e.url || "",
        line: e.lineNumber ?? null,
        ts: Date.now(),
      });
      scheduleFlush();
      break;
    }

    case "Page.frameNavigated": {
      if (params.frame?.parentId) break; // subframes are not steps
      await appendPage(active.sessionId, {
        url: params.frame?.url || "",
        title: "",
        ts: Date.now(),
      });
      break;
    }
  }
}

/** CDP RemoteObject -> short readable text. */
function previewOf(arg) {
  if (!arg) return "";
  if (arg.unserializableValue) return String(arg.unserializableValue);
  if (arg.value !== undefined) {
    return typeof arg.value === "object" ? JSON.stringify(arg.value) : String(arg.value);
  }
  if (arg.description) return arg.description;
  return arg.type || "";
}

// Opening DevTools on the recorded tab detaches us -- Chrome allows only one
// debugger client. Recording that silently continues to produce nothing is the
// worst outcome, so the reason is stored and the panel says it out loud.
chrome.debugger.onDetach.addListener(async (source, reason) => {
  const active = await getActive();
  if (!active || source.tabId !== active.tabId) return;
  await flush();
  await chrome.storage.session.set({ detached: { reason, at: Date.now() } });
});

// -- session lifecycle -----------------------------------------------------

async function startSession(tabId) {
  const existing = await getActive();
  if (existing) await stopSession();

  const tab = await chrome.tabs.get(tabId);
  const session = emptySession({
    pages: [{ url: tab.url || "", title: tab.title || "", ts: Date.now() }],
    env: { ua: navigator.userAgent, platform: navigator.platform },
  });
  await putSession(session);
  await setActive({ sessionId: session.id, tabId });
  await chrome.storage.session.remove("detached");

  const settings = await loadSettings();
  await chrome.storage.session.remove("surfaceNote");
  if (settings.surface === "overlay") await mountOverlay(tabId);
  else if (settings.surface === "popup") await openPanelWindow();

  try {
    await attach(tabId);
  } catch (e) {
    // Recording without CDP is still useful (screenshots, notes, identity), so
    // this is a warning, not a failure -- but it must be visible.
    await chrome.storage.session.set({
      detached: { reason: String(e?.message || e), at: Date.now() },
    });
  }
  return session;
}

async function stopSession() {
  const active = await getActive();
  if (!active) return null;
  await flush();
  await unmountOverlay(active.tabId);
  await detach(active.tabId);
  await clearActive();
  inflight.clear();
  return active.sessionId;
}

// -- screenshots -----------------------------------------------------------

const SHOT_LABEL = {
  viewport: "ekran",
  region: "isecak",
  full: "cela-stranica",
};

/**
 * One picture into the session. `mode` is viewport | region | full.
 *
 * A cancelled region select returns null and adds NOTHING -- pressing Escape
 * must not leave an empty row in the evidence list.
 */
async function shoot({ caption = "", mode = "viewport" } = {}) {
  const active = await getActive();
  if (!active) throw new Error("nema aktivne sesije");
  const tab = await chrome.tabs.get(active.tabId);

  let blob;
  let warning = "";

  if (mode === "region") {
    blob = await captureRegion(active.tabId);
    if (!blob) return null;                       // Escape, or a click with no drag
  } else if (mode === "full") {
    const r = await captureFullPage(active.tabId);
    blob = r.blob;
    if (r.method === "stitch") {
      // Worth saying out loud: a stitched picture repeats every fixed header,
      // and a user who does not know that reads it as the page being broken.
      warning = "slika je spojena iz vise delova (fiksirana zaglavlja se ponavljaju)";
    }
  } else {
    blob = await captureViewport(active.tabId);
  }

  const n = Date.now().toString(36).slice(-4);
  const item = await addEvidence(active.sessionId, {
    blob,
    name: `${SHOT_LABEL[mode] || "snimak"}-${n}.png`,
    caption,
    url: tab.url || "",
    kind: mode === "full" ? "fullpage" : "shot",
  });
  return { ...item, warning };
}


// -- surfaces --------------------------------------------------------------
// The side panel is the only one Chrome gives for free, and it is also the only
// one that resizes the page. So the other two exist: an overlay drawn inside
// the page, and a separate popup window. Both leave the viewport alone.

const OVERLAY_FILE = "src/content/overlay.js";
const PANEL_URL = "src/sidepanel/panel.html";

async function mountOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [OVERLAY_FILE] });
    return true;
  } catch (e) {
    // chrome:// pages, the Web Store and PDF viewers refuse injection. That is
    // not a failure of the session -- capture still works from the panel.
    await chrome.storage.session.set({
      surfaceNote: `Traka se ne moze prikazati na ovoj stranici (${e?.message || e}). Koristi panel.`,
    });
    return false;
  }
}

const unmountOverlay = (tabId) =>
  chrome.tabs.sendMessage(tabId, { type: "OVERLAY_REMOVE" }).catch(() => {});

/** Open the full panel as a separate window -- the popup surface, and also what
 *  the overlay's "Panel" button asks for. */
async function openPanelWindow() {
  const existing = await chrome.storage.session.get("panelWindowId");
  if (existing.panelWindowId) {
    try {
      await chrome.windows.update(existing.panelWindowId, { focused: true });
      return existing.panelWindowId;
    } catch {
      /* the user closed it; fall through and make a new one */
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL_URL),
    type: "popup",
    width: 420,
    height: 760,
  });
  await chrome.storage.session.set({ panelWindowId: win.id });
  return win.id;
}

/** Tell the overlay how many pieces of evidence the session holds, so the count
 *  on its header is not stale after a capture taken from somewhere else. */
async function pushOverlayCount() {
  const active = await getActive();
  if (!active) return;
  const { getSession } = await import("../lib/session-store.js");
  const s = await getSession(active.sessionId);
  chrome.tabs
    .sendMessage(active.tabId, { type: "OVERLAY_COUNT", count: (s?.evidence || []).length })
    .catch(() => {});
}

// -- message router --------------------------------------------------------

const HANDLERS = {
  GET_ACTIVE: async () => {
    const active = await getActive();
    const { detached } = await chrome.storage.session.get("detached");
    return { active, detached: detached || null };
  },
  START: ({ tabId }) => startSession(tabId),
  STOP: async () => {
    await flush();
    return stopSession();
  },
  SHOOT: async ({ caption, mode }) => {
    const item = await shoot({ caption, mode });
    pushOverlayCount();
    return item;
  },
  FLUSH: () => flush(),

  OPEN_SURFACE: () => openPanelWindow(),

  OPEN_REVIEW: async () => {
    const active = await getActive();
    if (!active) throw new Error("nema aktivne sesije");
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`src/review/review.html?session=${active.sessionId}`),
    });
    return active.sessionId;
  },

  SET_NOTE: async ({ text }) => {
    const active = await getActive();
    if (!active) return null;
    await patchSession(active.sessionId, { userNote: String(text || "") });
    return true;
  },

  SET_OVERLAY_OPACITY: ({ opacity }) => saveSettings({ overlayOpacity: Number(opacity) || 0.55 }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Identity and viewport arrive unsolicited from the content probe.
  if (msg?.type === "PROBE") {
    getActive().then(async (active) => {
      if (!active || sender.tab?.id !== active.tabId) return;
      // What the app declared about this screen and this session (page-context
      // and session-context comments). Parsed here, once, so the session holds
      // structure and the model input never re-reads raw comments.
      const ctx = msg.context || null;
      const pageCtx = ctx?.pageRaw ? parsePageComment(ctx.pageRaw) : null;
      const sessCtx = ctx?.sessionRaw ? parseSessionComment(ctx.sessionRaw) : null;
      await patchSession(active.sessionId, (s) => ({
        ...s,
        identity: {
          ...s.identity,
          ...(msg.identity || {}),
          // Role / permissions / flags come from the app itself and outrank
          // any navbar heuristic. Kept even when a later page lacks them.
          ...(sessCtx ? {
            role: sessCtx.role || s.identity?.role || "",
            permissions: sessCtx.permissions?.length ? sessCtx.permissions : (s.identity?.permissions || []),
            tenant: sessCtx.tenant || s.identity?.tenant || "",
            features_on: sessCtx.features_on?.length ? sessCtx.features_on : (s.identity?.features_on || []),
            features_off_required: [...new Set([...(s.identity?.features_off_required || []), ...(sessCtx.features_off_required || [])])],
          } : {}),
        },
        env: { ...s.env, ...(msg.env || {}) },
      }));
      await appendPage(active.sessionId, {
        url: msg.url || "",
        title: msg.title || "",
        ts: Date.now(),
        // pageId is the app's own name for the screen (data-page); context is
        // null when the screen has no docs/pages file -- and that null is
        // reported to the model and to the brain, not hidden.
        pageId: ctx?.pageId || "",
        kind: ctx?.kind || "",
        context: pageCtx,
      });
    });
    return false;
  }

  const fn = HANDLERS[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// If the recorded tab goes away, the session stops -- a session pointing at a
// dead tab would silently collect nothing.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActive();
  if (active?.tabId === tabId) await stopSession();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

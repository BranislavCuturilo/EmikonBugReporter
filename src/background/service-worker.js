// Orchestrator. Owns exactly three things the UI pages cannot own themselves:
//   - the chrome.debugger attachment (console + network, via CDP)
//   - tab screenshots
//   - which session is currently recording
//
// Everything else -- reading and writing sessions, evidence, chat, drafts --
// the panel and the review page do DIRECTLY against IndexedDB, because they
// share this extension's origin. Routing those through here would only add a
// message hop that dies with the worker.

import {
  emptySession, putSession, patchSession, appendConsole, appendNetwork,
  appendPage, addEvidence,
} from "../lib/session-store.js";

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
  await detach(active.tabId);
  await clearActive();
  inflight.clear();
  return active.sessionId;
}

// -- screenshots -----------------------------------------------------------

const dataUrlToBlob = (dataUrl) => fetch(dataUrl).then((r) => r.blob());

async function shoot(caption = "") {
  const active = await getActive();
  if (!active) throw new Error("nema aktivne sesije");
  const tab = await chrome.tabs.get(active.tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const blob = await dataUrlToBlob(dataUrl);
  const n = Date.now().toString(36).slice(-4);
  return addEvidence(active.sessionId, {
    blob,
    name: `snimak-${n}.png`,
    caption,
    url: tab.url || "",
    kind: "shot",
  });
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
  SHOOT: ({ caption }) => shoot(caption),
  FLUSH: () => flush(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Identity and viewport arrive unsolicited from the content probe.
  if (msg?.type === "PROBE") {
    getActive().then(async (active) => {
      if (!active || sender.tab?.id !== active.tabId) return;
      await patchSession(active.sessionId, (s) => ({
        ...s,
        identity: { ...s.identity, ...(msg.identity || {}) },
        env: { ...s.env, ...(msg.env || {}) },
      }));
      await appendPage(active.sessionId, {
        url: msg.url || "",
        title: msg.title || "",
        ts: Date.now(),
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

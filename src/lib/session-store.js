// IndexedDB session store.
//
// An MV3 service worker is terminated after ~30s idle, and this extension's
// whole point is that the user wanders through the app for minutes collecting
// evidence. So NOTHING lives in worker memory that we are not willing to lose:
// every screenshot, console line and request lands here first.
//
// Blobs are kept in their own store, keyed separately, so listing sessions for
// the panel never drags megabytes of PNG through structured clone.

const DB_NAME = "emikon-bug-reporter";
const DB_VERSION = 1;
const S_SESSIONS = "sessions";
const S_BLOBS = "blobs";

// Ring-buffer caps. A long session on a chatty SPA can emit tens of thousands
// of console lines; keeping them all would make the DB the bug.
const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;
const MAX_PAGES = 100;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_SESSIONS)) db.createObjectStore(S_SESSIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(S_BLOBS)) db.createObjectStore(S_BLOBS, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function emptySession(overrides = {}) {
  return {
    id: newId(),
    startedAt: Date.now(),
    endedAt: null,
    status: "recording",          // recording | composing | delivered
    userNote: "",
    evidence: [],                 // [{id, name, caption, url, ts, blobKey}]
    console: [],
    network: [],
    pages: [],
    identity: {},
    env: {},
    chat: [],                     // [{role: 'user'|'model', text}]
    draft: null,                  // composed ticket set, once the AI has run
    journals: {},                 // ticketIndex -> delivery journal
    ...overrides,
  };
}

export async function putSession(session) {
  await tx(S_SESSIONS, "readwrite", (os) => os.put(session));
  return session;
}

export async function getSession(id, { withBlobs = false } = {}) {
  const s = await tx(S_SESSIONS, "readonly", (os) => os.get(id));
  if (!s) return null;
  if (withBlobs) {
    for (const e of s.evidence || []) {
      if (e.blobKey) e.blob = await getBlob(e.blobKey);
    }
  }
  return s;
}

export async function listSessions() {
  const all = await tx(S_SESSIONS, "readonly", (os) => os.getAll());
  const rows = all || [];
  // Newest first -- the panel always wants the session in progress on top.
  return rows.sort((a, b) => b.startedAt - a.startedAt).map((s) => ({
    id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, status: s.status,
    userNote: s.userNote, shots: (s.evidence || []).length,
    errors: (s.console || []).filter((c) => c.level === "error").length,
    failedReqs: (s.network || []).filter((n) => !n.status || n.status >= 400).length,
  }));
}

/** Read-modify-write under one transaction-free lock. Callers are the worker
 *  and the panels; concurrent patches on the same session are rare and the
 *  last writer winning is acceptable for everything except evidence, which is
 *  appended through addEvidence() instead. */
export async function patchSession(id, patch) {
  const s = await tx(S_SESSIONS, "readonly", (os) => os.get(id));
  if (!s) return null;
  const next = typeof patch === "function" ? patch(s) : { ...s, ...patch };
  await putSession(next);
  return next;
}

export async function deleteSession(id) {
  const s = await getSession(id);
  for (const e of s?.evidence || []) if (e.blobKey) await deleteBlob(e.blobKey);
  await tx(S_SESSIONS, "readwrite", (os) => os.delete(id));
}

// -- blobs ----------------------------------------------------------------

export async function putBlob(blob) {
  const key = newId();
  await tx(S_BLOBS, "readwrite", (os) => os.put({ key, blob }));
  return key;
}

export async function getBlob(key) {
  const row = await tx(S_BLOBS, "readonly", (os) => os.get(key));
  return row?.blob || null;
}

export async function deleteBlob(key) {
  await tx(S_BLOBS, "readwrite", (os) => os.delete(key));
}

// -- appends ---------------------------------------------------------------

export async function addEvidence(sessionId, { blob, name, caption = "", url = "", kind = "shot" }) {
  const blobKey = blob ? await putBlob(blob) : null;
  const item = { id: `E${Date.now().toString(36).slice(-5)}`, name, caption, url, kind, ts: Date.now(), blobKey };
  await patchSession(sessionId, (s) => ({ ...s, evidence: [...(s.evidence || []), item] }));
  return item;
}

export async function removeEvidence(sessionId, evidenceId) {
  const s = await getSession(sessionId);
  const item = (s?.evidence || []).find((e) => e.id === evidenceId);
  if (item?.blobKey) await deleteBlob(item.blobKey);
  await patchSession(sessionId, (x) => ({ ...x, evidence: (x.evidence || []).filter((e) => e.id !== evidenceId) }));
}

const capped = (arr, extra, max) => [...arr, ...extra].slice(-max);

export async function appendConsole(sessionId, rows) {
  if (!rows?.length) return;
  await patchSession(sessionId, (s) => ({ ...s, console: capped(s.console || [], rows, MAX_CONSOLE) }));
}

export async function appendNetwork(sessionId, rows) {
  if (!rows?.length) return;
  await patchSession(sessionId, (s) => ({ ...s, network: capped(s.network || [], rows, MAX_NETWORK) }));
}

export async function appendPage(sessionId, page) {
  await patchSession(sessionId, (s) => {
    const pages = s.pages || [];
    // Same URL twice in a row is navigation noise, not a step in the story.
    if (pages.length && pages[pages.length - 1].url === page.url) return s;
    return { ...s, pages: capped(pages, [page], MAX_PAGES) };
  });
}

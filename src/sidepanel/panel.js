import {
  getSession, patchSession, listSessions, deleteSession, removeEvidence, addEvidence, getBlob,
} from "../lib/session-store.js";
import { loadSettings, missingSetup } from "../lib/settings.js";
import { openAnnotator } from "../lib/annotate.js";
import { startRecording, stopRecording } from "../lib/recorder.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
  if (!r?.ok) throw new Error(r?.error || "nepoznata greška");
  return r.data;
});

let activeId = null;      // recording session id, or null
let recording = false;    // video recording, separate from session recording
const objectUrls = new Set();

/** Blob URLs are revoked before every re-render. Without this a long session
 *  leaks a few MB per redraw, and the panel redraws every 1.5s. */
function freeUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls.clear();
}
function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.add(u);
  return u;
}

function show(el, text, kind) {
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  if (kind) {
    el.classList.remove("ok", "warn", "err");
    el.classList.add(kind);
  }
}

// -- rendering -------------------------------------------------------------

function renderCounters(s) {
  const nums = {
    cShots: (s?.evidence || []).length,
    cErrors: (s?.console || []).filter((c) => c.level === "error").length,
    cNet: (s?.network || []).length,
    cPages: (s?.pages || []).length,
  };
  for (const [id, n] of Object.entries(nums)) {
    const el = $(id);
    el.textContent = n;
    el.classList.toggle("zero", n === 0);
  }
}

function renderShots(s) {
  const wrap = $("shots");
  const items = s?.evidence || [];
  $("shotsEmpty").classList.toggle("hidden", items.length > 0);
  wrap.replaceChildren();

  items.forEach((e, i) => {
    const cell = document.createElement("div");
    cell.className = "shot";

    if (e.blob) {
      const img = document.createElement("img");
      img.src = urlFor(e.blob);
      img.alt = e.caption || e.name;
      img.addEventListener("click", () => {
        $("viewerImg").src = urlFor(e.blob);
        $("viewer").showModal();
      });
      cell.append(img);
    } else {
      // A missing blob keeps its numbered slot: dropping it would renumber
      // every later item while the filenames keep the original index.
      const ph = document.createElement("div");
      ph.className = "cap";
      ph.style.cssText = "height:82px;display:grid;place-items:center;text-align:center";
      ph.textContent = "slika nije sačuvana";
      cell.append(ph);
    }

    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = `${i + 1}. ${e.caption || e.name}`;
    cell.append(cap);

    const tools = document.createElement("div");
    tools.className = "tools";
    if (e.blob) {
      const ann = document.createElement("button");
      ann.className = "sm";
      ann.textContent = "✎";
      ann.title = "Anotiraj";
      ann.addEventListener("click", () => annotate(s.id, e));
      tools.append(ann);
    }
    const del = document.createElement("button");
    del.className = "sm";
    del.textContent = "✕";
    del.title = "Obriši";
    del.addEventListener("click", async () => {
      await removeEvidence(s.id, e.id);
      refresh();
    });
    tools.append(del);
    cell.append(tools);

    wrap.append(cell);
  });
}

function renderLogs(s) {
  const con = $("conLog");
  con.replaceChildren();
  for (const c of (s?.console || []).slice(-60).reverse()) {
    const d = document.createElement("div");
    d.className = c.level;
    d.textContent = `${c.text}${c.url ? `  @ ${c.url}:${c.line ?? "?"}` : ""}`;
    con.append(d);
  }
  const net = $("netLog");
  net.replaceChildren();
  for (const n of (s?.network || []).slice(-60).reverse()) {
    const d = document.createElement("div");
    d.className = "error";
    d.textContent = `${n.status || "GREŠKA"} ${n.method} ${n.url}${n.errorText ? ` — ${n.errorText}` : ""}`;
    net.append(d);
  }
}

async function renderPast() {
  const rows = (await listSessions()).filter((r) => r.id !== activeId).slice(0, 12);
  const wrap = $("past");
  wrap.replaceChildren();
  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Nema ranijih sesija.";
    wrap.append(e);
    return;
  }
  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "card row";
    const txt = document.createElement("div");
    txt.style.flex = "1";
    txt.innerHTML = "";
    const t1 = document.createElement("div");
    t1.textContent = r.userNote?.slice(0, 70) || "(bez opisa)";
    const t2 = document.createElement("div");
    t2.className = "small muted";
    t2.textContent = `${new Date(r.startedAt).toLocaleString("sr-RS")} · ${r.shots} sl. · ${r.errors} gr. · ${r.status}`;
    txt.append(t1, t2);

    const open = document.createElement("button");
    open.className = "sm";
    open.textContent = "Otvori";
    open.addEventListener("click", () => openReview(r.id));

    const del = document.createElement("button");
    del.className = "sm danger";
    del.textContent = "✕";
    del.addEventListener("click", async () => { await deleteSession(r.id); renderPast(); });

    card.append(txt, open, del);
    wrap.append(card);
  }
}

// -- state -----------------------------------------------------------------

async function refresh() {
  freeUrls();
  let detached = null;
  try {
    const st = await send({ type: "GET_ACTIVE" });
    activeId = st.active?.sessionId || null;
    detached = st.detached;
  } catch {
    activeId = null;
  }

  const stateEl = $("state");
  stateEl.classList.toggle("rec", Boolean(activeId));
  stateEl.textContent = activeId ? "snima" : "nema sesije";

  $("toggle").textContent = activeId ? "Završi sesiju" : "Počni sesiju";
  for (const id of [...Object.keys(SHOOT_BUTTONS), "record"]) $(id).disabled = !activeId;

  show($("detached"), detached
    ? `Konzola i mreža se više ne hvataju (${detached.reason}). Najčešći uzrok: otvoren DevTools na toj kartici — Chrome dozvoljava samo jednog debuggera. Slike i beleške i dalje rade.`
    : "");

  const s = activeId ? await getSession(activeId, { withBlobs: true }) : null;
  renderCounters(s);
  renderShots(s);
  renderLogs(s);
  if (s && document.activeElement !== $("note")) $("note").value = s.userNote || "";
  $("note").disabled = !activeId;
  $("compose").disabled = !s || (!s.evidence?.length && !s.userNote?.trim());

  await renderPast();
}

async function checkSetup() {
  const gaps = missingSetup(await loadSettings());
  show($("setupGap"), gaps.length
    ? `Nedostaje: ${gaps.join(", ")}. Otvori podešavanja (⚙) pre prve prijave.`
    : "");
}

// -- actions ---------------------------------------------------------------

async function annotate(sessionId, evidence) {
  const blob = evidence.blob || (evidence.blobKey ? await getBlob(evidence.blobKey) : null);
  if (!blob) return;
  const result = await openAnnotator(blob, evidence.caption || "");
  if (!result) return;
  // The annotated image REPLACES the original: two near-identical screenshots
  // on a ticket is noise, and the raw one has no evidentiary value once a
  // region has been marked.
  await removeEvidence(sessionId, evidence.id);
  await addEvidence(sessionId, {
    blob: result.blob,
    name: evidence.name,
    caption: result.caption,
    url: evidence.url,
    kind: evidence.kind,
  });
  refresh();
}

function openReview(sessionId) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/review/review.html?session=${sessionId}`) });
}

$("toggle").addEventListener("click", async () => {
  show($("error"), "");
  try {
    if (activeId) {
      if (recording) await toggleRecord();
      await send({ type: "STOP" });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("nema aktivne kartice");
      if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
        throw new Error("na internim stranicama browsera se ne može snimati — otvori aplikaciju");
      }
      await send({ type: "START", tabId: tab.id });
    }
  } catch (e) {
    show($("error"), String(e?.message || e));
  }
  refresh();
});

const SHOOT_BUTTONS = {
  shootRegion: "region",
  shootViewport: "viewport",
  shootFull: "full",
};

for (const [id, mode] of Object.entries(SHOOT_BUTTONS)) {
  $(id).addEventListener("click", async () => {
    show($("error"), "");
    const btn = $(id);
    const label = btn.textContent;
    btn.disabled = true;
    if (mode === "full") btn.textContent = "slikam…";
    try {
      const item = await send({ type: "SHOOT", caption: "", mode });
      // A cancelled region select returns null. That is not an error and must
      // not be reported as one -- Escape means the user changed their mind.
      if (item?.warning) show($("error"), item.warning, "warn");
    } catch (e) {
      show($("error"), String(e?.message || e));
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
    refresh();
  });
}

async function toggleRecord() {
  const btn = $("record");
  if (!recording) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await startRecording(tab.id);
    recording = true;
    btn.textContent = "⏹ Zaustavi";
    btn.classList.add("danger");
  } else {
    btn.disabled = true;
    btn.textContent = "obrađujem…";
    try {
      const frames = await stopRecording();
      for (const f of frames) {
        await addEvidence(activeId, { blob: f.blob, name: f.name, caption: f.caption, kind: "frame" });
      }
    } finally {
      recording = false;
      btn.disabled = false;
      btn.textContent = "⏺ Video";
      btn.classList.remove("danger");
    }
  }
}

$("record").addEventListener("click", async () => {
  show($("error"), "");
  try {
    await toggleRecord();
  } catch (e) {
    show($("error"), String(e?.message || e));
  }
  refresh();
});

$("compose").addEventListener("click", async () => {
  const id = activeId;
  if (!id) return;
  if (recording) await toggleRecord();
  await send({ type: "STOP" }).catch(() => {});
  openReview(id);
});

// The value is held in state on input, never read back out of the DOM at submit
// time -- the textarea lives in a panel that can be closed mid-session.
let noteTimer = null;
$("note").addEventListener("input", () => {
  const text = $("note").value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    if (activeId) patchSession(activeId, { userNote: text });
  }, 400);
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("viewer").addEventListener("click", () => $("viewer").close());

checkSetup();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 1500);

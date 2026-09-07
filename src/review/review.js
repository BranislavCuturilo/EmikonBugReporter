import { getSession, patchSession } from "../lib/session-store.js";
import { loadSettings, missingSetup, allSkills } from "../lib/settings.js";
import { Gemini, onLimiterWait } from "../lib/gemini.js";
import { buildTag, appendTag, editedFields, TAG_VERSION } from "../lib/tag.js";
import { coverage } from "../lib/page-context.js";
import { kindsOf } from "../lib/skill-files.js";
import { skillsFor, activeGroups } from "../lib/prompts.js";
import { PRIORITIES, PRIORITY_DEFAULT, PRIORITY_HELP, TITLE_MAX } from "../lib/constants.js";
import { Helpdesk } from "../lib/helpdesk.js";
import { deliverTicket, emptyJournal } from "../lib/deliver.js";
import { openAnnotator } from "../lib/annotate.js";

const $ = (id) => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get("session");

let session = null;
let settings = null;
let drafts = [];          // editable state; never read back out of the DOM
// What the model proposed, frozen at compose time. Diffed against `drafts`
// at send time: every field the user had to change is a field the model got
// wrong, and that list rides the ticket tag back to the brain.
let composed = [];
let checksSuggested = [];  // [{what, where, why}] -- what the user could still verify
let contextMissing = [];   // url_names visited with no docs/pages file
const KINDS = ["bug", "limitation", "question", "change_request"];
const KIND_LABEL = { bug: "greška", limitation: "ograničenje po dizajnu", question: "pitanje / pravo", change_request: "zahtev za izmenu" };
let rationale = "";
let modules = [];
let categories = [];
const objectUrls = new Set();

const urlFor = (blob) => {
  const u = URL.createObjectURL(blob);
  objectUrls.add(u);
  return u;
};

function banner(text, kind = "muted") {
  const el = $("banner");
  el.textContent = text;
  el.classList.remove("muted", "ok", "warn", "err");
  el.classList.add(kind);
  el.style.color = kind === "ok" ? "var(--ok)" : kind === "err" ? "var(--err)"
    : kind === "warn" ? "var(--warn)" : "";
}

// -- left column -----------------------------------------------------------

function renderEvidence() {
  const items = session.evidence || [];
  $("shotsEmpty").classList.toggle("hidden", items.length > 0);
  const wrap = $("shots");
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

      const tools = document.createElement("div");
      tools.className = "tools";
      const ann = document.createElement("button");
      ann.className = "sm";
      ann.textContent = "✎";
      ann.title = "Anotiraj";
      ann.addEventListener("click", async () => {
        const r = await openAnnotator(e.blob, e.caption || "");
        if (!r) return;
        e.blob = r.blob;
        e.caption = r.caption;
        await persistEvidenceEdit(e);
        renderEvidence();
      });
      tools.append(ann);
      cell.append(tools);
    } else {
      const ph = document.createElement("div");
      ph.className = "cap";
      ph.style.cssText = "height:82px;display:grid;place-items:center;text-align:center";
      ph.textContent = "slika nije sačuvana";
      cell.append(ph);
    }
    const cap = document.createElement("div");
    cap.className = "cap";
    // The id is printed because the AI cites it when it splits the report.
    cap.textContent = `${i + 1}. [${e.id}] ${e.caption || e.name}`;
    cell.append(cap);
    wrap.append(cell);
  });
}

async function persistEvidenceEdit(item) {
  const { putBlob, deleteBlob } = await import("../lib/session-store.js");
  const oldKey = item.blobKey;
  item.blobKey = await putBlob(item.blob);
  if (oldKey) await deleteBlob(oldKey);
  await patchSession(sessionId, (s) => ({
    ...s,
    evidence: (s.evidence || []).map((e) =>
      e.id === item.id ? { ...e, blobKey: item.blobKey, caption: item.caption } : e),
  }));
}

function renderFacts() {
  const dl = $("facts");
  dl.replaceChildren();
  const add = (k, v) => {
    if (!v) return;
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  };
  const id = session.identity || {};
  add("Korisnik", [id.user, id.email].filter(Boolean).join(" / "));
  add("Poslednja stranica", session.pages?.at(-1)?.url);
  add("Broj stranica", String(session.pages?.length || 0));
  add("Okruženje", session.env?.ua);
  add("Viewport", session.env?.viewport);
  add("Početo", new Date(session.startedAt).toLocaleString("sr-RS"));
}

function renderLogs() {
  const fill = (el, rows, fmt) => {
    el.replaceChildren();
    for (const r of rows.slice(-80).reverse()) {
      const d = document.createElement("div");
      d.className = r.level || "error";
      d.textContent = fmt(r);
      el.append(d);
    }
  };
  fill($("conLog"), session.console || [],
    (c) => `${c.text}${c.url ? `  @ ${c.url}:${c.line ?? "?"}` : ""}`);
  fill($("netLog"), session.network || [],
    (n) => `${n.status || "GREŠKA"} ${n.method} ${n.url}${n.errorText ? ` — ${n.errorText}` : ""}`);
}

// -- chat ------------------------------------------------------------------

function renderChat() {
  const box = $("chat");
  const msgs = session.chat || [];
  $("chatEmpty").classList.toggle("hidden", msgs.length > 0);
  box.replaceChildren();
  for (const m of msgs) {
    const d = document.createElement("div");
    d.className = `msg ${m.role === "model" ? "model" : "user"}`;
    d.textContent = m.text;
    box.append(d);
  }
  box.scrollTop = box.scrollHeight;
}

async function pushChat(role, text) {
  session.chat = [...(session.chat || []), { role, text }];
  await patchSession(sessionId, { chat: session.chat });
  renderChat();
}

async function runInterview() {
  banner("AI čita dokaze…");
  $("interview").disabled = true;
  try {
    // Re-read first: the user may have just edited a skill in the Options tab,
    // and a rule that needs a page reload to take effect is a rule nobody trusts.
    settings = await loadSettings();
    const g = new Gemini({
      apiKey: settings.geminiKey,
      model: settings.geminiModel,
      houseStyle: settings.houseStyle,
      skills: allSkills(settings),
      groups: settings.groups,
    });
    renderActiveSkills();
    const r = await g.interview(session, session.chat || []);
    let text = r.ready
      ? `${r.note || "Imam dovoljno."}\n\nMožeš da klikneš „Sklopi“.`
      : (r.questions || []).map((q, i) => `${i + 1}. ${q}`).join("\n") || "Nemam pitanja.";
    // What the user can check alone before the ticket goes -- drawn from the
    // screen context (a right the session lacks, a flag that is OFF, a
    // dependent screen). Shown with the questions, never instead of them.
    const sugg = (r.suggestions || []).filter((x) => x && x.what)
      .map((x) => `→ proveri: ${x.what}${x.where ? ` (${x.where})` : ""}${x.why ? ` — ${x.why}` : ""}`);
    if (sugg.length) text += `\n\n${sugg.join("\n")}`;
    await pushChat("model", text);
    banner(r.ready ? "spremno za sklapanje" : "odgovori pa nastavi", r.ready ? "ok" : "muted");
  } catch (e) {
    banner(String(e?.message || e), "err");
  } finally {
    $("interview").disabled = false;
  }
}

// -- drafts ----------------------------------------------------------------

function renderDrafts() {
  const wrap = $("drafts");
  wrap.replaceChildren();
  $("draftsEmpty").classList.toggle("hidden", drafts.length > 0);
  $("sendAll").disabled = drafts.length === 0;

  // Evidence nobody claimed. Not dropped and not silently ignored: if the AI
  // split the report and forgot a screenshot, that is exactly the mistake this
  // screen exists to catch.
  const claimed = new Set(drafts.flatMap((d) => d.evidence || []));
  const orphans = (session.evidence || []).filter((e) => !claimed.has(e.id));

  const note = $("rationale");
  const parts = [];
  if (drafts.length > 1) parts.push(`AI predlaže ${drafts.length} tiketa: ${rationale}`);
  else if (rationale) parts.push(rationale);
  if (orphans.length) {
    parts.push(`Nijedan tiket ne nosi: ${orphans.map((e) => e.id).join(", ")} — proveri da nešto nije propušteno.`);
  }
  // Screens with no declaration are named, not hidden: the user should know
  // the AI could not check "is this deliberate" for them, and the brain
  // learns which file to write next.
  if (contextMissing.length) {
    parts.push(`Bez konteksta ekrana (ograničenja nisu proverena): ${contextMissing.join(", ")}`);
  }
  if (checksSuggested.length) {
    parts.push("Pre slanja proveri: " + checksSuggested
      .map((c) => `${c.what}${c.where ? ` (${c.where})` : ""}${c.why ? ` — ${c.why}` : ""}`)
      .join("; "));
  }
  note.textContent = parts.join("  ·  ");
  note.classList.toggle("hidden", parts.length === 0);

  drafts.forEach((d, i) => wrap.append(draftCard(d, i)));
}

function draftCard(d, i) {
  const card = document.createElement("div");
  card.className = "card draft";

  const head = document.createElement("div");
  head.className = "row";
  const idx = document.createElement("span");
  idx.className = "idx";
  // Numbering follows the ORIGINAL index; a draft is never dropped from the
  // middle, so the position on screen matches what gets sent.
  idx.textContent = `${i + 1}.`;
  head.append(idx);
  // A limitation is not a bug. The model decides, the user can overrule --
  // and the overrule is itself a signal (it lands in `edited:` on the tag).
  const kind = document.createElement("select");
  kind.className = "sm";
  for (const k of KINDS) kind.append(new Option(KIND_LABEL[k], k));
  kind.value = KINDS.includes(d.kind) ? d.kind : "bug";
  d.kind = kind.value;
  kind.title = "Šta je ovo: greška, ograničenje po dizajnu, pitanje o pravima, ili zahtev za izmenu";
  kind.addEventListener("change", () => { d.kind = kind.value; });
  head.append(kind);
  const drop = document.createElement("button");
  drop.className = "sm ghost";
  drop.textContent = "ne šalji";
  drop.title = "Izbaci ovaj predlog";
  drop.addEventListener("click", () => {
    drafts.splice(i, 1);
    renderDrafts();
  });
  const gap = document.createElement("span");
  gap.className = "spacer";
  head.append(gap, drop);
  card.append(head);

  const field = (label, el) => {
    const l = document.createElement("label");
    l.className = "field";
    const s = document.createElement("span");
    s.className = "lbl";
    s.textContent = label;
    l.append(s, el);
    return l;
  };

  const title = document.createElement("input");
  title.type = "text";
  title.value = d.ticket_title || "";
  // No maxlength attribute: silently swallowing the tail of an AI-written title
  // is how a ticket ends up called "Izvestaj po lokacijama vraca 500 pri filtr".
  // Show the overflow and let the user cut it where it should be cut.
  const titleField = field("Naslov", title);
  const count = document.createElement("span");
  count.className = "hint";
  titleField.querySelector(".lbl").append(count);

  const syncCount = () => {
    const n = title.value.length;
    count.textContent = `  ${n}/${TITLE_MAX}`;
    const over = n > TITLE_MAX;
    count.style.color = over ? "var(--err)" : "var(--text-dim)";
    title.style.borderColor = over ? "var(--err)" : "";
    d._titleOver = over;
  };
  title.addEventListener("input", () => {
    d.ticket_title = title.value;
    syncCount();
  });
  syncCount();
  card.append(titleField);

  const desc = document.createElement("textarea");
  desc.value = d.ticket_description || "";
  desc.addEventListener("input", () => { d.ticket_description = desc.value; });
  card.append(field("Opis", desc));

  const row = document.createElement("div");
  row.className = "row wrap";
  row.style.width = "100%";

  const mod = document.createElement("select");
  mod.append(new Option("— bez modula —", ""));
  for (const m of modules) mod.append(new Option(m, m));
  if (d.module && !modules.includes(d.module)) mod.append(new Option(`${d.module} (nije u listi)`, d.module));
  mod.value = d.module || settings.defaultModule || "";
  d.module = mod.value;
  mod.addEventListener("change", () => { d.module = mod.value; });

  // A select, not free text: the helpdesk resolves a category by name and
  // refuses one it does not know, so a typed "Greska u radu" that does not
  // exist would be a 400 after the whole ticket was written.
  const cat = document.createElement("select");
  cat.append(new Option("— bez kategorije —", ""));
  for (const c of categories) cat.append(new Option(c, c));
  const wantedCat = d.category || settings.defaultCategory || "";
  if (wantedCat && !categories.includes(wantedCat)) {
    cat.append(new Option(`${wantedCat} (nije u listi)`, wantedCat));
  }
  cat.value = wantedCat;
  d.category = cat.value;
  cat.addEventListener("change", () => { d.category = cat.value; });

  const pri = document.createElement("select");
  for (const p of PRIORITIES) pri.append(new Option(`${p} — ${PRIORITY_HELP[p]}`, p));
  // A value the model invented ("high") would silently select nothing and then
  // post as empty, so an unknown priority falls back rather than disappearing.
  if (!PRIORITIES.includes(d.priority)) d.priority = "";
  pri.value = d.priority || settings.defaultPriority || PRIORITY_DEFAULT;
  d.priority = pri.value;
  pri.addEventListener("change", () => { d.priority = pri.value; });

  const dl = document.createElement("input");
  dl.type = "date";
  // The helpdesk takes YYYY-MM-DD and nothing else. Anything the model wrote in
  // another shape ("sledece nedelje") is dropped here rather than sent and
  // refused -- a native date input cannot hold it anyway.
  dl.value = /^\d{4}-\d{2}-\d{2}$/.test(d.deadline || "") ? d.deadline : "";
  d.deadline = dl.value;
  dl.addEventListener("change", () => { d.deadline = dl.value; });

  for (const [lbl, el] of [["Modul", mod], ["Kategorija", cat], ["Prioritet", pri], ["Rok", dl]]) {
    const f = field(lbl, el);
    f.style.flex = "1 1 150px";
    f.style.marginBottom = "0";
    row.append(f);
  }
  card.append(row);

  const chips = document.createElement("div");
  chips.className = "chips";
  chips.style.marginTop = "10px";
  const known = new Map((session.evidence || []).map((e) => [e.id, e]));
  for (const id of d.evidence || []) {
    const c = document.createElement("span");
    c.className = "chip";
    const e = known.get(id);
    if (!e) {
      // The model cited an id that does not exist. Say so rather than sending
      // a ticket whose attachment list quietly came up short.
      c.classList.add("orphan");
      c.textContent = `${id} — nepoznat dokaz`;
    } else {
      c.textContent = `${id} ${e.caption || e.name}`;
    }
    chips.append(c);
  }
  if (!(d.evidence || []).length) {
    const c = document.createElement("span");
    c.className = "chip orphan";
    c.textContent = "bez priloga";
    chips.append(c);
  }
  card.append(chips);

  const steps = document.createElement("div");
  steps.className = "steps";
  card.append(steps);
  d._steps = steps;

  const foot = document.createElement("div");
  foot.className = "row";
  foot.style.marginTop = "10px";
  const send = document.createElement("button");
  send.className = "primary sm";
  send.textContent = "Otvori tiket";
  send.addEventListener("click", () => sendDraft(i, send));
  foot.append(send);
  card.append(foot);
  d._btn = send;

  return card;
}

async function runCompose() {
  banner("AI sklapa tiket…");
  $("compose").disabled = true;
  try {
    // Re-read first: the user may have just edited a skill in the Options tab,
    // and a rule that needs a page reload to take effect is a rule nobody trusts.
    settings = await loadSettings();
    const g = new Gemini({
      apiKey: settings.geminiKey,
      model: settings.geminiModel,
      houseStyle: settings.houseStyle,
      skills: allSkills(settings),
      groups: settings.groups,
    });
    renderActiveSkills();
    const r = await g.compose(session, session.chat || [], modules, categories);
    drafts = (r.tickets || []).map((t) => ({ ...t, kind: KINDS.includes(t.kind) ? t.kind : "bug" }));
    composed = drafts.map((t) => ({ ...t }));
    rationale = r.rationale || "";
    checksSuggested = Array.isArray(r.checks_suggested) ? r.checks_suggested : [];
    contextMissing = Array.isArray(r.context_missing) ? r.context_missing : [];
    await patchSession(sessionId, {
      draft: { tickets: drafts, composed, rationale, checksSuggested, contextMissing },
      status: "composing",
    });
    renderDrafts();
    banner(`${drafts.length} predlog(a)`, "ok");
  } catch (e) {
    banner(String(e?.message || e), "err");
  } finally {
    $("compose").disabled = false;
  }
}

// -- delivery --------------------------------------------------------------

function step(d, text, kind = "muted") {
  const line = document.createElement("div");
  line.className = kind;
  line.textContent = text;
  d._steps.append(line);
}

async function sendDraft(i, btn) {
  const d = drafts[i];
  const gaps = missingSetup(settings);
  if (gaps.length) return step(d, `Nedostaje: ${gaps.join(", ")}`, "err");
  if (!d.ticket_title?.trim()) return step(d, "Naslov je prazan.", "err");
  // Refused here, not by the server: a 400 arriving after the ticket text was
  // accepted is far harder to act on than a sentence before anything is sent.
  if (d.ticket_title.length > TITLE_MAX) {
    return step(d, `Naslov ima ${d.ticket_title.length} znakova, baza prima najviše ${TITLE_MAX}. Skrati ga.`, "err");
  }

  btn.disabled = true;
  const hd = new Helpdesk({ url: settings.helpdeskUrl, token: settings.helpdeskToken });

  const known = new Map((session.evidence || []).map((e) => [e.id, e]));
  const files = (d.evidence || [])
    .map((id) => known.get(id))
    .filter((e) => e?.blob)
    .map((e) => ({ name: e.name, blob: e.blob, caption: e.caption }));

  const key = `t${i}`;
  const journal = session.journals?.[key] || emptyJournal();

  // The trace tag is the ONLY channel back to the brain: the helpdesk accepts
  // nothing but ticket_description. Which screens had context, which did not,
  // the session's role and flags, the skills in play, what kind of ticket this
  // is, and which fields the user had to correct -- every one of these is a
  // number the brain reads later (scripts/tickets/ebr_review.py).
  const cov = coverage(session);
  const activeSkills = skillsFor(allSkills(settings), "compose", { groups: settings.groups, urls: sessionUrls(), kinds: kindsOf(session) })
    .map((s) => s.name || "bez-naziva");
  const tag = buildTag({
    version: TAG_VERSION,
    withContext: cov.withContext,
    withoutContext: cov.withoutContext,
    role: session.identity?.role || "",
    flags: session.identity?.features_on || [],
    skills: activeSkills,
    kind: d.kind || "bug",
    splitIndex: i + 1,
    splitTotal: drafts.length,
    edited: editedFields(composed[i], { ...d, kind: d.kind }, ["ticket_title", "ticket_description", "module", "category", "priority", "deadline", "kind"]),
  });

  try {
    const res = await deliverTicket({
      hd,
      draft: {
        ticket_title: d.ticket_title.trim(),
        ticket_description: appendTag(d.ticket_description || "", tag),
        module: d.module || "",
        category: d.category || "",
        priority: PRIORITIES.includes(d.priority) ? d.priority : PRIORITY_DEFAULT,
        // Omitted entirely when empty: sending null would be an explicit
        // "clear the Rok", which is a different statement from "no Rok given".
        ...(d.deadline ? { deadline: d.deadline } : {}),
        assign_to_me: Boolean(settings.assignToMe),
      },
      files,
      journal,
      persist: async (j) => {
        session.journals = { ...(session.journals || {}), [key]: j };
        await patchSession(sessionId, { journals: session.journals });
      },
      onStep: (msg, kind) => step(d, msg, kind),
    });
    const a = document.createElement("a");
    a.href = res.url;
    a.target = "_blank";
    a.textContent = `Otvori tiket ${res.ticketId} na helpdesk-u →`;
    d._steps.append(a);
    d._sent = true;
    if (drafts.every((x) => x._sent)) {
      await patchSession(sessionId, { status: "delivered", endedAt: Date.now() });
      banner("svi tiketi otvoreni", "ok");
    }
  } catch (e) {
    step(d, String(e?.message || e), "err");
    // An ambiguous failure must NOT offer a one-click retry: the fix is to look
    // at the helpdesk first, and the button coming back enabled invites exactly
    // the double-post this whole path is built to avoid.
    if (!e?.ambiguous) btn.disabled = false;
    return;
  }
}

// -- wiring ----------------------------------------------------------------

/** Names the rules that will shape the NEXT compose, so a forgotten switch is
 *  visible before the ticket is written rather than after it is read. */
function renderActiveSkills() {
  // Scoped to the addresses THIS session actually visited, so the pill says
  // what will really be sent -- not what is switched on in Options.
  const urls = sessionUrls();
  const kinds = kindsOf(session);
  const active = skillsFor(allSkills(settings), "compose", { groups: settings.groups, urls, kinds });
  const groups = activeGroups(settings.groups, urls);
  const pill = $("activeSkills");
  pill.textContent = (active.length ? `${active.length} skill` : "bez skillova") + (kinds.length ? ` · ${kinds.join(", ")}` : "");
  pill.title = active.length
    ? `Grupe u igri: ${groups.map((g) => g.name || "bez naziva").join(", ") || "—"}
` +
      `Uključeno za sklapanje: ${active.map((s) => s.name || "bez naziva").join(", ")}`
    : "Nijedan skill ne važi za ove adrese — idu samo osnovna pravila.";
}

/** Every address the session touched. Same rule as the Gemini layer uses. */
function sessionUrls() {
  const pages = (session?.pages || []).map((p) => p?.url).filter(Boolean);
  const shots = (session?.evidence || []).map((e) => e?.url).filter(Boolean);
  return [...new Set([...pages, ...shots])];
}

$("interview").addEventListener("click", runInterview);
$("compose").addEventListener("click", runCompose);
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Coming back from the Options tab must not require a reload to see the change.
window.addEventListener("focus", async () => {
  settings = await loadSettings();
  renderActiveSkills();
});

$("sendAnswer").addEventListener("click", async () => {
  const text = $("answer").value.trim();
  if (!text) return;
  $("answer").value = "";
  await pushChat("user", text);
  runInterview();
});

$("answer").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) $("sendAnswer").click();
});

$("sendAll").addEventListener("click", () => {
  drafts.forEach((d, i) => { if (!d._sent) sendDraft(i, d._btn); });
});

$("viewer").addEventListener("click", () => $("viewer").close());

async function init() {
  settings = await loadSettings();
  session = await getSession(sessionId, { withBlobs: true });
  if (!session) return banner("sesija nije nađena", "err");

  $("sessionInfo").textContent =
    `${(session.evidence || []).length} slika · ` +
    `${(session.console || []).filter((c) => c.level === "error").length} grešaka · ` +
    `${(session.network || []).length} palih poziva`;

  const gaps = missingSetup(settings);
  if (gaps.length) banner(`Nedostaje: ${gaps.join(", ")} — otvori podešavanja.`, "warn");

  renderEvidence();
  renderFacts();
  renderLogs();
  renderChat();
  renderActiveSkills();

  // The saved note is the opening turn of the conversation, so the AI sees it
  // as something the user said rather than as ambient context.
  if (!(session.chat || []).length && session.userNote?.trim()) {
    await pushChat("user", session.userNote.trim());
  }

  if (session.draft?.tickets?.length) {
    drafts = session.draft.tickets.map((t) => ({ ...t }));
    composed = (session.draft.composed || session.draft.tickets).map((t) => ({ ...t }));
    rationale = session.draft.rationale || "";
    checksSuggested = session.draft.checksSuggested || [];
    contextMissing = session.draft.contextMissing || [];
  }
  // The limiter's "cekam N s" lands where every other status does.
  onLimiterWait((m) => banner(m, "ok"));

  if (settings.helpdeskUrl && settings.helpdeskToken) {
    try {
      const hd = new Helpdesk({ url: settings.helpdeskUrl, token: settings.helpdeskToken });
      const nameOf = (x) => (typeof x === "string" ? x : x?.name || x?.module || x?.code || "");
      // Both lists in parallel: two round trips one after the other is a second
      // of dead time on a screen the user is already waiting on.
      const [mods, cats] = await Promise.all([hd.listModules(), hd.listCategories()]);
      modules = mods.map(nameOf).filter(Boolean);
      categories = cats.map(nameOf).filter(Boolean);
    } catch {
      /* the draft still renders; the pickers just come up empty and the
         values the model chose stay as typed-in fallbacks */
    }
  }
  renderDrafts();
}

init();

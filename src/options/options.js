import { DEFAULTS, loadSettings, saveSettings } from "../lib/settings.js";
import {
  DEFAULT_HOUSE_STYLE, SKILL_SCOPES, buildSystem, newSkill, skillsFor,
} from "../lib/prompts.js";
import { Helpdesk } from "../lib/helpdesk.js";
import { Gemini } from "../lib/gemini.js";
import { checkForUpdate, currentVersion } from "../lib/updater.js";
import { downloadBackup, importSettings } from "../lib/backup.js";

// Where install.ps1 puts the extension. Shown as the update command because an
// extension cannot learn its own filesystem path -- chrome.runtime.getURL()
// returns a chrome-extension:// URL, never a folder.
const DEFAULT_INSTALL_DIR = "%LOCALAPPDATA%\\EmikonBugReporter";
const DAY_MS = 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const FIELDS = {
  helpdeskUrl: "value",
  helpdeskToken: "value",
  geminiKey: "value",
  geminiModel: "value",
  defaultModule: "value",
  defaultCategory: "value",
  defaultPriority: "value",
  assignToMe: "checked",
  identitySelector: "value",
  repo: "value",
  autoCheckUpdates: "checked",
};

// Held in state, not in the DOM. The skills list lives inside a section the
// user can collapse, and reading values back out of a collapsed section at save
// time is how typed text silently fails to be saved.
let skills = [];
let houseStyle = "";

/** Status text on a marker element. Uses classList, never `className =` --
 *  a wholesale assignment would drop the class the element is looked up by and
 *  the next write would silently find nothing. */
function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("muted", "ok", "warn", "err");
  el.classList.add(kind || "muted");
  el.style.color = kind === "ok" ? "var(--ok)" : kind === "err" ? "var(--err)" : "";
}

function readForm() {
  const out = {};
  for (const [id, prop] of Object.entries(FIELDS)) out[id] = $(id)[prop];
  out.helpdeskUrl = String(out.helpdeskUrl || "").trim().replace(/\/+$/, "");
  out.houseStyle = houseStyle;
  out.skills = skills;
  return out;
}

// -- skills ----------------------------------------------------------------

function renderCount() {
  // Counted over what is actually in force, not over how many rows exist.
  const on = skills.filter((s) => s.enabled && s.text?.trim()).length;
  const pill = $("skillCount");
  pill.textContent = skills.length
    ? `${on} od ${skills.length} uključeno`
    : "nema skillova";
}

function renderHouseState() {
  const custom = Boolean(houseStyle.trim());
  setStatus($("houseState"), custom ? "izmenjeno u odnosu na podrazumevano" : "podrazumevana pravila", custom ? "warn" : "muted");
  $("resetHouse").disabled = !custom;
}

function skillRow(s) {
  const row = document.createElement("div");
  row.className = "skill";
  row.classList.toggle("off", !s.enabled);

  const head = document.createElement("div");
  head.className = "head";

  const on = document.createElement("input");
  on.type = "checkbox";
  on.checked = Boolean(s.enabled);
  on.title = "Uključi ovaj skill";
  on.addEventListener("change", () => {
    s.enabled = on.checked;
    row.classList.toggle("off", !s.enabled);
    renderCount();
  });

  const name = document.createElement("input");
  name.type = "text";
  name.value = s.name || "";
  name.placeholder = "Naziv — npr. „VEZ — multi-tenant”";
  name.addEventListener("input", () => { s.name = name.value; });

  const scope = document.createElement("select");
  scope.className = "scope";
  for (const [v, label] of Object.entries(SKILL_SCOPES)) scope.append(new Option(label, v));
  scope.value = s.scope || "both";
  scope.addEventListener("change", () => { s.scope = scope.value; });

  // Two-step delete: a blocking confirm() in a settings page is heavier than
  // the action deserves, and a bare one-click delete loses typed text.
  const del = document.createElement("button");
  del.className = "sm danger";
  del.textContent = "Obriši";
  let armed = false;
  del.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      del.textContent = "Sigurno?";
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        del.textContent = "Obriši";
      }, 3000);
      return;
    }
    skills = skills.filter((x) => x.id !== s.id);
    renderSkills();
  });

  head.append(on, name, scope, del);
  row.append(head);

  const text = document.createElement("textarea");
  text.value = s.text || "";
  text.placeholder = "Pravilo, napisano kao instrukcija modelu. Npr. „Drži opis ispod 900 karaktera.”";
  text.addEventListener("input", () => {
    s.text = text.value;
    renderCount();   // an empty skill is not in force, however its switch looks
  });
  row.append(text);

  return row;
}

function renderSkills() {
  const wrap = $("skills");
  wrap.replaceChildren();
  $("skillsEmpty").classList.toggle("hidden", skills.length > 0);
  for (const s of skills) wrap.append(skillRow(s));
  renderCount();
}

$("addSkill").addEventListener("click", () => {
  skills = [...skills, newSkill()];
  renderSkills();
  const last = $("skills").lastElementChild?.querySelector('input[type="text"]');
  last?.focus();
});

$("houseStyle").addEventListener("input", () => {
  const v = $("houseStyle").value;
  // Text identical to the default is stored as "" so a future improvement to
  // the baseline still reaches this install.
  houseStyle = v.trim() === DEFAULT_HOUSE_STYLE.trim() ? "" : v;
  renderHouseState();
});

$("resetHouse").addEventListener("click", () => {
  houseStyle = "";
  $("houseStyle").value = DEFAULT_HOUSE_STYLE;
  renderHouseState();
});

// -- prompt preview --------------------------------------------------------

function renderPreview() {
  const role = $("previewRole").value;
  $("previewText").textContent = buildSystem(role, { houseStyle, skills });
  const active = skillsFor(skills, role);
  $("previewMeta").textContent = active.length
    ? `${active.length} skill(ova) u ovom koraku: ${active.map((s) => s.name || "bez naziva").join(", ")}`
    : "nijedan skill ne važi za ovaj korak";
}

$("previewPrompt").addEventListener("click", () => {
  renderPreview();
  $("preview").showModal();
});
$("previewRole").addEventListener("change", renderPreview);
$("previewClose").addEventListener("click", () => $("preview").close());

// -- connection tests ------------------------------------------------------

async function fillModules(hd, selected) {
  const sel = $("defaultModule");
  let modules;
  try {
    modules = await hd.listModules();
  } catch {
    return false; // the caller already reported why the connection failed
  }
  const names = modules
    .map((m) => (typeof m === "string" ? m : m?.name || m?.module || m?.code || ""))
    .filter(Boolean);

  sel.replaceChildren();
  sel.append(new Option("— bez podrazumevanog —", ""));
  for (const n of names) sel.append(new Option(n, n));
  // Keep a previously saved value even if the helpdesk no longer lists it,
  // otherwise saving the form would silently clear the setting.
  if (selected && !names.includes(selected)) sel.append(new Option(`${selected} (nije u listi)`, selected));
  sel.value = selected || "";
  return true;
}

$("testHelpdesk").addEventListener("click", async () => {
  const f = readForm();
  const el = $("helpdeskStatus");
  if (!f.helpdeskUrl || !f.helpdeskToken) return setStatus(el, "unesi URL i token", "err");
  setStatus(el, "proveravam…");
  const hd = new Helpdesk({ url: f.helpdeskUrl, token: f.helpdeskToken });
  try {
    const ok = await fillModules(hd, f.defaultModule);
    if (!ok) throw new Error("lista modula nije stigla");
    setStatus(el, `veza radi — ${$("defaultModule").options.length - 1} modula učitano`, "ok");
  } catch (e) {
    setStatus(el, String(e?.message || e), "err");
  }
});

$("testGemini").addEventListener("click", async () => {
  const f = readForm();
  const el = $("geminiStatus");
  if (!f.geminiKey) return setStatus(el, "unesi API ključ", "err");
  setStatus(el, "proveravam…");
  const g = new Gemini({ apiKey: f.geminiKey, model: f.geminiModel });
  try {
    // Cheapest possible round trip that still proves key + model + JSON mode.
    await g._generate({
      system: "Odgovaras iskljucivo JSON-om.",
      contents: [{ role: "user", parts: [{ text: 'Vrati {"ok": true}' }] }],
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
    setStatus(el, `veza radi — ${f.geminiModel}`, "ok");
  } catch (e) {
    setStatus(el, String(e?.message || e), "err");
  }
});

// -- version & update ------------------------------------------------------

function renderVersion(result) {
  const pill = $("verPill");
  const note = $("updateNote");
  const how = $("updateHow");

  pill.textContent = `v${currentVersion()}`;
  pill.classList.remove("rec");

  if (!result) {
    note.classList.add("hidden");
    how.classList.add("hidden");
    return;
  }
  if (result.error) {
    note.textContent = result.error;
    note.classList.remove("hidden", "ok", "warn");
    note.classList.add("err");
    how.classList.add("hidden");
    return;
  }

  const when = result.commit?.date
    ? new Date(result.commit.date).toLocaleString("sr-RS")
    : "";
  note.classList.remove("hidden", "ok", "warn", "err");

  if (result.hasUpdate) {
    pill.classList.add("rec");
    note.classList.add("warn");
    note.textContent =
      `Nova verzija: v${result.latest} (imaš v${result.current}).` +
      (result.commit ? `  Poslednja izmena: ${result.commit.message} — ${when}` : "");
    how.classList.remove("hidden");
  } else if (result.ahead) {
    // Louder than "up to date": this build is not what is published, so
    // anything tested here has not necessarily shipped.
    note.classList.add("warn");
    note.textContent =
      `Lokalna verzija v${result.current} je NOVIJA od objavljene v${result.latest} — ` +
      `ova instalacija nije ono što stoji u repozitorijumu.`;
    how.classList.add("hidden");
  } else {
    note.classList.add("ok");
    note.textContent = `Najnovija verzija (v${result.current}).` + (when ? `  Objavljeno: ${when}` : "");
    how.classList.add("hidden");
  }
}

async function runUpdateCheck({ quiet = false } = {}) {
  const repo = $("repo").value.trim();
  if (!repo) {
    // An empty repo is "checking is off", never "you are up to date".
    return renderVersion({ error: "Repozitorijum nije upisan — provera verzije je isključena." });
  }
  if (!quiet) renderVersion({ error: "proveravam…" });
  try {
    const branch = (await loadSettings()).repoBranch || "main";
    const result = await checkForUpdate(repo, branch);
    renderVersion(result);
    await saveSettings({ lastUpdateCheck: Date.now(), lastSeenVersion: result.latest });
  } catch (e) {
    renderVersion({ error: String(e?.message || e) });
  }
}

$("checkUpdate").addEventListener("click", () => runUpdateCheck());

$("copyCmd").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("updateCmd").textContent);
    $("copyCmd").textContent = "kopirano";
    setTimeout(() => { $("copyCmd").textContent = "Kopiraj"; }, 2000);
  } catch {
    // Clipboard can be refused; selecting the text is always available.
    const r = document.createRange();
    r.selectNodeContents($("updateCmd"));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
});

// -- backup ----------------------------------------------------------------

function backupStatus(text, kind) {
  setStatus($("backupStatus"), text, kind);
}

$("exportAll").addEventListener("click", async () => {
  try {
    const name = await downloadBackup({ includeSecrets: true });
    backupStatus(`sačuvano: ${name} — sadrži ključeve, čuvaj ga kao lozinku`, "warn");
  } catch (e) {
    backupStatus(String(e?.message || e), "err");
  }
});

$("exportSafe").addEventListener("click", async () => {
  try {
    const name = await downloadBackup({ includeSecrets: false });
    backupStatus(`sačuvano: ${name} — bez ključeva, može da se deli`, "ok");
  } catch (e) {
    backupStatus(String(e?.message || e), "err");
  }
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = "";            // so the same file can be picked twice
  if (!file) return;
  try {
    const text = await file.text();
    // merge, not replace: a redacted export must not wipe the credentials that
    // are already here.
    const r = await importSettings(text, { mode: "merge" });
    await init();
    const extra = r.skipped.length ? `  (preskočeno nepoznato: ${r.skipped.join(", ")})` : "";
    backupStatus(`učitano ${r.applied.length} podešavanja${extra}`, "ok");
  } catch (e) {
    backupStatus(String(e?.message || e), "err");
  }
});

// -- save ------------------------------------------------------------------

$("save").addEventListener("click", async () => {
  const unnamed = skills.filter((s) => s.enabled && s.text?.trim() && !s.name?.trim()).length;
  await saveSettings(readForm());
  setStatus($("saveStatus"),
    unnamed ? `sačuvano — ${unnamed} uključen(ih) skill(ova) bez naziva` : "sačuvano",
    unnamed ? "warn" : "ok");
  setTimeout(() => setStatus($("saveStatus"), ""), 3000);
});

// -- init ------------------------------------------------------------------

async function init() {
  const s = await loadSettings();
  for (const [id, prop] of Object.entries(FIELDS)) $(id)[prop] = s[id] ?? DEFAULTS[id];

  houseStyle = s.houseStyle || "";
  $("houseStyle").value = houseStyle || DEFAULT_HOUSE_STYLE;
  renderHouseState();

  skills = (s.skills || []).map((x) => ({ ...x }));
  renderSkills();

  // The saved module is not in the <select> until the list loads; hold it.
  $("defaultModule").replaceChildren(
    new Option(s.defaultModule || "— proveri vezu da se učita lista —", s.defaultModule || ""),
  );

  if (s.helpdeskUrl && s.helpdeskToken) {
    fillModules(new Helpdesk({ url: s.helpdeskUrl, token: s.helpdeskToken }), s.defaultModule);
  }

  $("updateCmd").textContent = `${DEFAULT_INSTALL_DIR}\\update.bat`;
  renderVersion(null);

  // Auto-check at most once a day, and never on a page the user opened to fix
  // something else -- a network error banner on top of the settings they came
  // to change is noise.
  if (s.autoCheckUpdates && s.repo && Date.now() - (s.lastUpdateCheck || 0) > DAY_MS) {
    runUpdateCheck({ quiet: true });
  }
}

init();

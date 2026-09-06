// Gemini layer: the interview turn and the compose turn. Knows nothing about
// the helpdesk and nothing about the DOM -- it takes a session, returns JSON.

import { buildSystem, INTERVIEW_SCHEMA, COMPOSE_SCHEMA } from "./prompts.js";
import { contextBlock } from "./page-context.js";
import { RateLimiter, estimateTokens, CHARS_PER_TOKEN, MAX_RETRIES_429 } from "./ratelimit.js";

// One limiter per worker/page process. chrome.storage.local carries the daily
// count across processes; the per-minute windows are per process, which is
// safe because only one page composes at a time.
let _limiter = null;
export function limiter() {
  if (!_limiter) {
    const storage = (typeof chrome !== "undefined" && chrome.storage?.local) ? chrome.storage.local : null;
    _limiter = new RateLimiter({ storage, onWait: (m) => _onWait(m) });
  }
  return _limiter;
}
let _onWait = () => {};
/** Where the UI hangs its "cekam N s" banner. */
export function onLimiterWait(fn) { _onWait = typeof fn === "function" ? fn : () => {}; }


const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Evidence sent to the model is CAPPED. A 40-screenshot session would cost more
// than it is worth and would bury the signal; the caps keep the newest and the
// most severe, which is what a bug report actually turns on.
const MAX_IMAGES = 8;
const MAX_CONSOLE = 40;
const MAX_NETWORK = 40;

export class GeminiError extends Error {
  constructor(message, status = 0) { super(message); this.name = "GeminiError"; this.status = status; }
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  // Chunked so a multi-MB screenshot does not blow the argument limit of apply().
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class Gemini {
  /** `houseStyle` and `skills` come straight from settings, so a rule the user
   *  edits in Options takes effect on the very next turn -- there is no copy of
   *  them anywhere else. Passing neither falls back to the shipped defaults. */
  constructor({ apiKey = "", model = "gemini-flash-lite-latest", houseStyle = "", skills = [], groups = null, onWait = null } = {}) {
    this.apiKey = String(apiKey || "");
    this.model = String(model || "gemini-flash-lite-latest");
    this.onWait = typeof onWait === "function" ? onWait : (m) => _onWait(m);
    this.houseStyle = houseStyle;
    this.skills = skills;
    this.groups = groups;
    // Filled per call from the session, because which groups apply depends on
    // where the user actually went -- it is not a property of the settings.
    this.urls = [];
  }

  get configured() { return Boolean(this.apiKey); }

  async _generate({ system, contents, schema, temperature = 0.2 }) {
    if (!this.configured) throw new GeminiError("Gemini nije podesen -- unesi API kljuc u Opcijama");
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
        ...(schema ? { responseSchema: schema } : {}),
      },
    };

    // The key is on the lite tier: 15 RPM, 250k TPM, 500 RPD. Estimate the
    // input, wait if a window is full, refuse if the day is spent -- and say
    // so, because a limiter that silently drops a call reads as "the AI does
    // nothing". Then retry a 429 with backoff, honouring Retry-After.
    const est = estimateTokens(contents) + Math.ceil(String(system || "").length / CHARS_PER_TOKEN);
    await limiter().acquire(est);

    let resp;
    for (let attempt = 1; ; attempt += 1) {
      try {
        resp = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new GeminiError(`poziv Gemini-ju nije uspeo: ${e.name}`);
      }
      if (resp.status === 429 && attempt <= MAX_RETRIES_429) {
        const ms = RateLimiter.backoffMs(attempt, resp.headers.get("retry-after"));
        this.onWait(`Gemini vratio 429 -- pokusaj ${attempt}/${MAX_RETRIES_429} za ${Math.ceil(ms / 1000)} s.`);
        await new Promise((r) => setTimeout(r, ms));
        continue;
      }
      break;
    }
    if (!resp.ok) {
      const hint = resp.status === 400 ? " (proveri API kljuc i naziv modela)"
        : resp.status === 429 ? " (kvota potrosena -- sacekaj ili promeni kljuc u Opcijama)" : "";
      throw new GeminiError(`Gemini -> HTTP ${resp.status}${hint}`, resp.status);
    }
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
    if (!text.trim()) {
      const reason = data?.candidates?.[0]?.finishReason || "prazan odgovor";
      throw new GeminiError(`Gemini nije vratio sadrzaj (${reason})`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new GeminiError("Gemini je vratio neispravan JSON");
    }
  }

  /** Every address the session touched -- what decides which groups apply. */
  static urlsOf(session) {
    const pages = (session?.pages || []).map((p) => p?.url).filter(Boolean);
    const shots = (session?.evidence || []).map((e) => e?.url).filter(Boolean);
    return [...new Set([...pages, ...shots])];
  }

  /** The system instruction for one turn, built from the CURRENT rules. */
  systemFor(role) {
    return buildSystem(role, {
      houseStyle: this.houseStyle,
      skills: this.skills,
      groups: this.groups,
      urls: this.urls,
    });
  }

  /** One interview turn: what still has to be asked. */
  async interview(session, history = []) {
    this.urls = Gemini.urlsOf(session);
    const contents = [
      { role: "user", parts: await evidenceParts(session) },
      ...history.map(toContent),
    ];
    return this._generate({
      system: this.systemFor("interview"),
      contents,
      schema: INTERVIEW_SCHEMA,
      temperature: 0.3,
    });
  }

  /** Compose one ticket, or propose a decomposition into several. */
  async compose(session, history = [], modules = [], categories = []) {
    this.urls = Gemini.urlsOf(session);
    const parts = await evidenceParts(session);
    if (modules.length) {
      parts.push({ text: `\nDOSTUPNI MODULI (izaberi tacno jedan naziv po tiketu):\n${modules.join(", ")}` });
    }
    // review.js always passed these; the signature dropped them, so the model
    // picked a category with no list and the UI then refused it.
    if (categories.length) {
      parts.push({ text: `\nDOSTUPNE KATEGORIJE (izaberi tacno jednu, ili prazno):\n${categories.join(", ")}` });
    }
    const contents = [{ role: "user", parts }, ...history.map(toContent)];
    return this._generate({
      system: this.systemFor("compose"),
      contents,
      schema: COMPOSE_SCHEMA,
      temperature: 0.2,
    });
  }
}

const toContent = (m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: String(m.text || "") }] });

/**
 * Turn a session into model input: one text block of context, then the images.
 * Each image is announced by its evidence id in the text FIRST, so the model can
 * cite it in `evidence` when it splits the report into several tickets.
 */
export async function evidenceParts(session) {
  const s = session || {};
  const lines = [];

  lines.push("=== OPIS KORISNIKA ===");
  lines.push(s.userNote?.trim() || "(korisnik jos nije napisao opis)");

  if (s.identity?.user || s.identity?.email) {
    lines.push("\n=== PRIJAVLJENI KORISNIK NA APLIKACIJI ===");
    lines.push([s.identity.user, s.identity.email].filter(Boolean).join(" / "));
  }

  const pages = (s.pages || []).slice(-10);
  if (pages.length) {
    lines.push("\n=== PUTANJA KROZ APLIKACIJU ===");
    for (const p of pages) lines.push(`- ${p.url}${p.title ? `  (${p.title})` : ""}`);
  }

  // Who the user is (role, declared permissions, enabled flags) and what each
  // visited screen declares about itself -- including "no declaration". This
  // is the block that lets the model say "ogranicenje po dizajnu" instead of
  // "bug", and "nema pravo" instead of "ne radi".
  const ctx = contextBlock(s);
  if (ctx) lines.push("\n" + ctx);

  // Errors and warnings only. An info-level console is noise in a bug report.
  const con = (s.console || []).filter((c) => c.level === "error" || c.level === "warning").slice(-MAX_CONSOLE);
  if (con.length) {
    lines.push("\n=== KONZOLA (greske i upozorenja) ===");
    for (const c of con) lines.push(`[${c.level}] ${c.text}${c.url ? `  @ ${c.url}:${c.line ?? "?"}` : ""}`);
  }

  // Failed requests only -- a 200 tells a bug report nothing.
  const net = (s.network || []).filter((n) => !n.status || n.status >= 400).slice(-MAX_NETWORK);
  if (net.length) {
    lines.push("\n=== NEUSPELI MREZNI POZIVI ===");
    for (const n of net) lines.push(`${n.status || "GRESKA"} ${n.method} ${n.url}${n.errorText ? `  -- ${n.errorText}` : ""}`);
  }

  if (s.env?.ua) {
    lines.push("\n=== OKRUZENJE ===");
    lines.push(`${s.env.ua}${s.env.viewport ? `  |  viewport ${s.env.viewport}` : ""}`);
  }

  const parts = [{ text: lines.join("\n") }];

  const shots = (s.evidence || []).filter((e) => e.blob).slice(-MAX_IMAGES);
  if (shots.length) {
    parts.push({ text: `\n=== SLIKE (${shots.length}) ===` });
    for (const e of shots) {
      parts.push({ text: `\n[${e.id}] ${e.caption || e.name}${e.url ? `  @ ${e.url}` : ""}` });
      parts.push({ inline_data: { mime_type: e.blob.type || "image/png", data: await blobToBase64(e.blob) } });
    }
  }
  return parts;
}

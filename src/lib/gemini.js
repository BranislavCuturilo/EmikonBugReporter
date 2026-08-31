// Gemini layer: the interview turn and the compose turn. Knows nothing about
// the helpdesk and nothing about the DOM -- it takes a session, returns JSON.

import { buildSystem, INTERVIEW_SCHEMA, COMPOSE_SCHEMA } from "./prompts.js";

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
  constructor({ apiKey = "", model = "gemini-flash-latest", houseStyle = "", skills = [] } = {}) {
    this.apiKey = String(apiKey || "");
    this.model = String(model || "gemini-flash-latest");
    this.houseStyle = houseStyle;
    this.skills = skills;
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
    let resp;
    try {
      resp = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new GeminiError(`poziv Gemini-ju nije uspeo: ${e.name}`);
    }
    if (!resp.ok) {
      const hint = resp.status === 400 ? " (proveri API kljuc i naziv modela)"
        : resp.status === 429 ? " (kvota potrosena -- probaj laksi model)" : "";
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

  /** The system instruction for one turn, built from the CURRENT rules. */
  systemFor(role) {
    return buildSystem(role, { houseStyle: this.houseStyle, skills: this.skills });
  }

  /** One interview turn: what still has to be asked. */
  async interview(session, history = []) {
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
  async compose(session, history = [], modules = []) {
    const parts = await evidenceParts(session);
    if (modules.length) {
      parts.push({ text: `\nDOSTUPNI MODULI (izaberi tacno jedan naziv po tiketu):\n${modules.join(", ")}` });
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

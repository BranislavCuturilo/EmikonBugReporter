// The single outbound door to tiket.emikon.rs. Every write to the helpdesk in
// this extension goes through here -- not past it. A second writer would have
// to re-learn the attachment caps, the chunking rule and the retry hazard, and
// would re-learn them the way they were first learned: on a live ticket.
//
// Port of brain/scripts/tickets/adapters/emikon_helpdesk.py. Same endpoints,
// same caps, same refusals. Where the two disagree, the Python side is right.

import {
  API_PREFIX, ATTACH_MAX_FILES, ATTACH_MAX_BYTES, ATTACH_MAX_REQUEST_BYTES,
  ATTACH_TYPES, TICKET_WEB_PATH, TIMEOUT_MS,
} from "./constants.js";

export class HelpdeskError extends Error {
  /** `ambiguous` means the request LEFT this machine and the helpdesk may have
   *  processed it. Such a call must never be retried blind -- a retry on a
   *  comment double-posts, because the API has no dedup key. */
  constructor(message, { ambiguous = false, status = 0 } = {}) {
    super(message);
    this.name = "HelpdeskError";
    this.ambiguous = ambiguous;
    this.status = status;
  }
}

const seg = (v) => encodeURIComponent(String(v ?? "").trim());

/** Extension of a filename, lowercased, no dot. "" when there is none. */
function extOf(name) {
  const i = String(name || "").lastIndexOf(".");
  return i < 0 ? "" : String(name).slice(i + 1).toLowerCase();
}

/**
 * `{size, reason}` for ONE attachment: `reason` is why the helpdesk would
 * refuse it, else "". Asked TWICE on purpose -- once by the chunker before the
 * first comment is posted, once by the sender before it builds a body. The
 * first call is the point: a file that can never land becomes an honest failure
 * up front, instead of a half-delivered set with a hole in it.
 */
export function attachmentCheck(file) {
  const name = String(file?.name || "prilog");
  const ext = extOf(name);
  if (!ATTACH_TYPES[ext]) {
    return { size: 0, reason: `tip priloga nije dozvoljen: .${ext || "(bez ekstenzije)"}` };
  }
  const size = Number(file?.blob?.size ?? 0);
  if (!size) return { size: 0, reason: `prilog je prazan ili necitljiv: ${name}` };
  if (size > ATTACH_MAX_BYTES) {
    return { size, reason: `prilog je prevelik: ${name} (${(size / 1048576).toFixed(1)} MB > 5 MB)` };
  }
  return { size, reason: "" };
}

/**
 * Split a set of attachments into bodies the server will actually accept.
 * Greedy: fill a chunk to ATTACH_MAX_FILES or ATTACH_MAX_REQUEST_BYTES,
 * whichever binds first, then start another.
 *
 * Returns `{chunks, rejected}`. `rejected` is never silently dropped -- the
 * caller must show it, because "we sent 9 of 13" that nobody noticed is the
 * exact failure this whole module exists to prevent.
 */
export function planChunks(files) {
  const chunks = [];
  const rejected = [];
  let cur = [];
  let curBytes = 0;

  for (const f of files || []) {
    const { size, reason } = attachmentCheck(f);
    if (reason) { rejected.push({ file: f, reason }); continue; }
    const wouldOverflow =
      cur.length >= ATTACH_MAX_FILES || curBytes + size > ATTACH_MAX_REQUEST_BYTES;
    if (cur.length && wouldOverflow) { chunks.push(cur); cur = []; curBytes = 0; }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length) chunks.push(cur);
  return { chunks, rejected };
}

export class Helpdesk {
  constructor({ url = "", token = "" } = {}) {
    this.base = String(url || "").replace(/\/+$/, "");
    this.token = String(token || "");
  }

  get configured() { return Boolean(this.base && this.token); }

  ticketUrl(id) {
    return id ? `${this.base}${TICKET_WEB_PATH.replace("{id}", seg(id))}` : "";
  }

  async _fetch(path, init, { ambiguousOnNetwork = false } = {}) {
    if (!this.configured) {
      throw new HelpdeskError("helpdesk nije podesen -- unesi URL i token u Opcijama");
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(`${this.base}${API_PREFIX}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { Authorization: `Token ${this.token}`, Accept: "application/json", ...(init.headers || {}) },
      });
    } catch (e) {
      // The request may or may not have reached the server. Say so, loudly.
      throw new HelpdeskError(
        `${init.method} ${path} nije uspeo: ${e.name}`,
        { ambiguous: ambiguousOnNetwork },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      // Status only, never the body: it can carry ticket content into a log.
      // 404 on a write = the token's engineer does not own this ticket.
      throw new HelpdeskError(`${init.method} ${path} -> HTTP ${resp.status}`, { status: resp.status });
    }
    const raw = await resp.text();
    return raw.trim() ? JSON.parse(raw) : {};
  }

  async _get(path, params) {
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    return this._fetch(`${path}${qs}`, { method: "GET" });
  }

  async _write(method, path, body) {
    return this._fetch(path, {
      method,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }, { ambiguousOnNetwork: true });
  }

  // -- reads ---------------------------------------------------------------

  async listModules() {
    const data = await this._get("/modules/");
    if (Array.isArray(data)) return data;
    return data?.modules || data?.results || [];
  }

  // -- writes: IRREVERSIBLE, one call each ---------------------------------

  /**
   * POST a new ticket. Verified live 2026-08-31 against tiket.emikon.rs.
   *
   * Accepted fields: ticket_title (max 50), ticket_description, module,
   * category, priority, deadline, assign_to_me. `module` and `category` take
   * an id OR a name -- the helpdesk resolves either, which is what lets the
   * model pick a module by the name a human would say.
   *
   * `customer` is NOT sendable: the helpdesk always files the ticket under the
   * token's own user and ignores any customer in the body.
   *
   * Returns the ticket DETAIL directly -- not wrapped in an envelope -- so
   * `ticket_id` is a top-level key of the response.
   *
   * Carries NO attachments: create is JSON only. Images reach the ticket
   * afterwards, as comments. That is why `deliver.js` exists.
   */
  async createTicket(payload) {
    return this._write("POST", "/engineer/tickets/", payload);
  }

  /**
   * PATCH any subset of ticket_title/ticket_description/module/category/
   * priority/deadline on an open ticket.
   *
   * Omitted and null mean different things: a field left out is not touched, an
   * explicit null clears it. So never send the whole draft here to "be safe" --
   * that would overwrite fields the user did not edit.
   */
  async editTicket(ticketId, fields) {
    return this._write("PATCH", `/engineer/tickets/${seg(ticketId)}/edit/`, fields);
  }

  /**
   * Reference data for the module and category pickers.
   *
   * Categories are GLOBAL, not per-module (ERP/models.py: Category has a name
   * and nothing else; the ticket FK does not scope them). So the category list
   * is fetched once and offered whole -- filtering it by the chosen module would
   * be inventing a relationship the data does not have.
   */
  async listCategories() {
    const data = await this._get("/categories/");
    if (Array.isArray(data)) return data;
    return data?.categories || data?.results || [];
  }

  /**
   * POST one comment, optionally with attachments. NOT idempotent -- the API
   * has no dedup key, so a retry double-posts. Reaching this method with a set
   * that exceeds the caps is a CALLER bug: it is refused here, never trimmed.
   */
  async addComment(ticketId, text, files = []) {
    const path = `/engineer/tickets/${seg(ticketId)}/comment/`;
    if (!files.length) return this._write("POST", path, { comment: text });

    if (files.length > ATTACH_MAX_FILES) {
      throw new HelpdeskError(
        `${files.length} priloga u jednom komentaru (max ${ATTACH_MAX_FILES}) -- pozivalac mora da pozove planChunks()`,
      );
    }
    let total = 0;
    for (const f of files) {
      const { size, reason } = attachmentCheck(f);
      if (reason) throw new HelpdeskError(reason);
      total += size;
    }
    if (total > ATTACH_MAX_REQUEST_BYTES) {
      throw new HelpdeskError(`telo komentara je ${(total / 1048576).toFixed(1)} MB (max 5 MB) -- pozovi planChunks()`);
    }

    const fd = new FormData();
    fd.append("comment", text);
    // The API accepts `files[]` too; we send one spelling. Those two disagreed
    // once already -- do not "helpfully" send both.
    for (const f of files) fd.append("files", f.blob, f.name);
    return this._fetch(path, { method: "POST", body: fd }, { ambiguousOnNetwork: true });
  }
}

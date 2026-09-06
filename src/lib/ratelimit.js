// Rate limiting for the Gemini key -- 15 RPM, 250k TPM, 500 RPD on the lite tier.
//
// The extension already makes exactly two calls per ticket (interview, compose)
// and none in the background, so this is not about volume. It is about the
// three ways a human at a keyboard trips the limits anyway: clicking "sastavi"
// four times in ten seconds (RPM), a session with eight full-page screenshots
// (TPM), and a long testing day (RPD). Each is handled so the user SEES the
// wait or the refusal -- a limiter that silently drops a call is worse than no
// limiter, because the user then reports "the AI does nothing".
//
// Pure where it can be: `now` and `storage` are injectable so the arithmetic
// is tested without a browser. `estimateTokens` is an ESTIMATE and says so --
// chars/4 for text, a flat per-image cost -- and errs high on purpose. Over-
// estimating costs one unnecessary wait; under-estimating costs a 429 the
// user did not expect.

export class RateLimitError extends Error {
  constructor(message, kind) { super(message); this.name = "RateLimitError"; this.kind = kind; }
}

/** Tokens a screenshot costs the model, roughly. Gemini bills a fixed amount
 *  per 768x768 tile; a 1440x900 viewport is ~4 tiles, a full-page capture
 *  more. 1,300 is a conservative figure for a typical viewport shot. */
export const TOKENS_PER_IMAGE = 1300;
export const CHARS_PER_TOKEN = 4;

/** Estimated input tokens for a Gemini `contents` array. */
export function estimateTokens(contents) {
  let chars = 0, images = 0;
  for (const c of contents || []) {
    for (const p of c?.parts || []) {
      if (typeof p?.text === "string") chars += p.text.length;
      if (p?.inline_data) images += 1;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}

const DAY = () => new Date().toISOString().slice(0, 10);

export class RateLimiter {
  /**
   * @param {object} o
   * @param {number} o.rpm      requests per minute (sliding window)
   * @param {number} o.tpm      input tokens per minute (sliding window)
   * @param {number} o.rpd      requests per calendar day (persisted)
   * @param {number} o.maxInput hard cap on ONE call's estimated input tokens
   * @param {number} o.warnAt   daily count at which onWarn fires
   * @param {()=>number} o.now  injectable clock
   * @param {object} o.storage  {get(key)->Promise<obj>, set(obj)->Promise} -- chrome.storage.local shape
   * @param {(msg:string)=>void} o.onWait  called with a human sentence whenever the user must wait or is refused
   * @param {(ms:number)=>Promise} o.sleep injectable
   */
  constructor({
    rpm = 15, tpm = 250_000, rpd = 500, maxInput = 60_000, warnAt = 450,
    now = Date.now, storage = null, onWait = () => {}, sleep = null,
  } = {}) {
    this.rpm = rpm; this.tpm = tpm; this.rpd = rpd; this.maxInput = maxInput; this.warnAt = warnAt;
    this.now = now;
    this.storage = storage;
    this.onWait = onWait;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // In-memory windows. A terminated worker forgets them, which is safe: a
    // dead worker was not making calls.
    this.calls = [];     // timestamps (ms)
    this.tokens = [];    // [ts, tokens]
  }

  _prune(t) {
    const cut = t - 60_000;
    this.calls = this.calls.filter((x) => x > cut);
    this.tokens = this.tokens.filter(([x]) => x > cut);
  }

  async _daily() {
    if (!this.storage) return { day: DAY(), n: 0 };
    const got = await this.storage.get("geminiDaily");
    const d = got?.geminiDaily;
    if (!d || d.day !== DAY()) return { day: DAY(), n: 0 };
    return d;
  }

  async _bumpDaily() {
    const d = await this._daily();
    d.n += 1;
    if (this.storage) await this.storage.set({ geminiDaily: d });
    return d;
  }

  /** What Options shows: today's count and the caps. */
  async status() {
    const d = await this._daily();
    this._prune(this.now());
    return {
      today: d.n, rpd: this.rpd, rpm: this.rpm, tpm: this.tpm,
      lastMinuteCalls: this.calls.length,
      lastMinuteTokens: this.tokens.reduce((a, [, n]) => a + n, 0),
    };
  }

  /**
   * Wait until a call of `tokens` input tokens may be made, then reserve it.
   * Throws RateLimitError when it must not be made at all (daily cap, or one
   * call too large for any window).
   */
  async acquire(tokens) {
    if (tokens > this.maxInput) {
      throw new RateLimitError(
        `Ulaz je ~${tokens.toLocaleString()} tokena, iznad plafona od ${this.maxInput.toLocaleString()} po pozivu -- ` +
        "ukloni nekoliko slika ili skrati sesiju", "input");
    }
    const d = await this._daily();
    if (d.n >= this.rpd) {
      throw new RateLimitError(
        `Dnevna kvota Gemini kljuca je potrosena (${d.n}/${this.rpd}). Nastavi sutra ili promeni kljuc u Opcijama.`, "rpd");
    }
    if (d.n >= this.warnAt) {
      this.onWait(`Upozorenje: ${d.n}/${this.rpd} poziva danas -- blizu dnevne kvote.`);
    }

    // Sliding windows: wait out the oldest entry rather than refusing.
    for (;;) {
      const t = this.now();
      this._prune(t);
      let waitMs = 0;
      if (this.calls.length >= this.rpm) {
        waitMs = Math.max(waitMs, this.calls[0] + 60_000 - t);
      }
      const used = this.tokens.reduce((a, [, n]) => a + n, 0);
      if (used + tokens > this.tpm && this.tokens.length) {
        waitMs = Math.max(waitMs, this.tokens[0][0] + 60_000 - t);
      }
      if (waitMs <= 0) break;
      this.onWait(`Cekam ${Math.ceil(waitMs / 1000)} s zbog ogranicenja Gemini kljuca (${this.rpm} poziva/min).`);
      await this.sleep(waitMs);
    }

    const t = this.now();
    this.calls.push(t);
    this.tokens.push([t, tokens]);
    await this._bumpDaily();
  }

  /** Delay before retry `attempt` (1-based) of a 429, honouring Retry-After. */
  static backoffMs(attempt, retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60_000);
    return Math.min(2_000 * 2 ** (attempt - 1), 30_000);   // 2s, 4s, 8s
  }
}

export const MAX_RETRIES_429 = 3;

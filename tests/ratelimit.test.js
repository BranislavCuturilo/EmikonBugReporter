// node --test. No browser, no network: the clock, the sleep and the storage
// are injected, so the arithmetic that keeps the key inside 15 RPM / 250k TPM
// / 500 RPD is proved without spending a single call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, RateLimitError, estimateTokens, TOKENS_PER_IMAGE } from "../src/lib/ratelimit.js";

function harness({ day = new Date(1_000_000).toISOString().slice(0, 10), n = 0, rpm = 15, tpm = 250_000, rpd = 500 } = {}) {
  let t = 1_000_000;
  const slept = [];
  const waits = [];
  const store = { geminiDaily: { day, n } };
  const storage = {
    get: async (k) => ({ [k]: store[k] }),
    set: async (obj) => Object.assign(store, obj),
  };
  const lim = new RateLimiter({
    rpm, tpm, rpd, storage,
    now: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    onWait: (m) => waits.push(m),
  });
  return { lim, slept, waits, store, tick: (ms) => { t += ms; } };
}

test("estimateTokens: chars/4 plus a flat cost per image, erring high", () => {
  const parts = [{ text: "a".repeat(400) }, { inline_data: { data: "x" } }, { text: "bb" }];
  assert.equal(estimateTokens([{ parts }]), 100 + TOKENS_PER_IMAGE + 1);
  assert.equal(estimateTokens([]), 0);
  assert.equal(estimateTokens(null), 0);
});

test("15 calls in a minute pass; the 16th waits for the oldest to expire", async () => {
  const { lim, slept, waits, tick } = harness();
  for (let i = 0; i < 15; i++) { await lim.acquire(100); tick(1000); }
  assert.equal(slept.length, 0);
  await lim.acquire(100);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 0 && slept[0] <= 60_000, `slept ${slept[0]}`);
  assert.match(waits[0], /Cekam \d+ s/);
});

test("token window: a call that would exceed TPM waits, a small one does not", async () => {
  const { lim, slept } = harness({ tpm: 1000 });
  await lim.acquire(700);
  await lim.acquire(200);
  assert.equal(slept.length, 0);
  await lim.acquire(200);          // 1100 > 1000 -> waits out the first entry
  assert.equal(slept.length, 1);
});

test("one call above the per-call input cap is refused, never queued", async () => {
  const { lim } = harness();
  await assert.rejects(() => lim.acquire(60_001), (e) => e instanceof RateLimitError && e.kind === "input");
});

test("daily cap: warns at 450, refuses at 500, resets on a new day", async () => {
  const a = harness({ n: 449 });
  await a.lim.acquire(10);
  assert.equal(a.store.geminiDaily.n, 450);
  await a.lim.acquire(10);          // 450 -> warn fires
  assert.ok(a.waits.some((m) => /Upozorenje: 45[01]\/500/.test(m)), a.waits.join(" | "));

  const b = harness({ n: 500 });
  await assert.rejects(() => b.lim.acquire(10), (e) => e instanceof RateLimitError && e.kind === "rpd");

  const c = harness({ day: "2000-01-01", n: 500 });   // stale day -> fresh count
  await c.lim.acquire(10);
  assert.equal(c.store.geminiDaily.n, 1);
});

test("no storage at all still limits per minute and never throws on the day", async () => {
  const lim = new RateLimiter({ storage: null, now: () => 0, sleep: async () => {} });
  await lim.acquire(1);
  const s = await lim.status();
  assert.equal(s.today, 0);
  assert.equal(s.lastMinuteCalls, 1);
});

test("429 backoff honours Retry-After and otherwise doubles from 2s, capped", () => {
  assert.equal(RateLimiter.backoffMs(1, null), 2000);
  assert.equal(RateLimiter.backoffMs(2, undefined), 4000);
  assert.equal(RateLimiter.backoffMs(3, ""), 8000);
  assert.equal(RateLimiter.backoffMs(9, null), 30_000);
  assert.equal(RateLimiter.backoffMs(1, "7"), 7000);
  assert.equal(RateLimiter.backoffMs(1, "999"), 60_000);
});

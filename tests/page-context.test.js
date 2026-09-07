// node --test. The comments here are byte-for-byte what
// kontrola_vezuv/tenants/context_processors.py renders -- if that format
// moves, this file is the first thing that goes red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageComment, parseSessionComment, contextBlock, coverage, screenKey } from "../src/lib/page-context.js";

const PAGE = `page-context audits:audit_detail
kind: detail | access: prijavljen, član tenanta | requires: audit.view_all, audit.execute | feature: escalations
NE DOZVOLJAVA: otvaranje revizije van sopstvenog domena — detalj primenjuje isto suženje kao lista (audit-2026-06-01)
NE DOZVOLJAVA: brisanje — nema razloga u zagradi
Prikaz: Jedna revizija: zaglavlje, status, tim.`;

const SESSION = `session-context
role: revizor | permissions: audit.execute, audit.* | tenant: mns
features ON: escalations, scoring
features OFF that this page requires: fault_reporting`;

test("page comment -> structure, limits with and without provenance", () => {
  const c = parsePageComment(PAGE);
  assert.equal(c.url_name, "audits:audit_detail");
  assert.equal(c.kind, "detail");
  assert.deepEqual(c.requires, ["audit.view_all", "audit.execute"]);
  assert.equal(c.feature, "escalations");
  assert.equal(c.limits.length, 2);
  assert.equal(c.limits[0].what, "otvaranje revizije van sopstvenog domena");
  assert.match(c.limits[0].why, /isto suženje kao lista/);
  assert.equal(c.limits[0].since, "audit-2026-06-01");
  assert.equal(c.limits[1].since, "");
  assert.equal(c.limits[1].why, "nema razloga u zagradi");
  assert.equal(c.summary, "Jedna revizija: zaglavlje, status, tim.");
});

test("a foreign or empty comment is null, not a half-object", () => {
  assert.equal(parsePageComment("some other comment"), null);
  assert.equal(parsePageComment(""), null);
  assert.equal(parsePageComment("page-context"), null);      // no url_name
});

test("session comment -> role, declared permissions, flags on and off", () => {
  const s = parseSessionComment(SESSION);
  assert.equal(s.role, "revizor");
  assert.deepEqual(s.permissions, ["audit.execute", "audit.*"]);
  assert.equal(s.tenant, "mns");
  assert.deepEqual(s.features_on, ["escalations", "scoring"]);
  assert.deepEqual(s.features_off_required, ["fault_reporting"]);
});

test("a dash means empty, not the string '-'", () => {
  const s = parseSessionComment("session-context\nrole: - | permissions: - | tenant: -\nfeatures ON: -");
  assert.equal(s.role, "");
  assert.deepEqual(s.permissions, []);
  assert.deepEqual(s.features_on, []);
});

test("contextBlock: one entry per screen, missing files named, session first", () => {
  const ctx = parsePageComment(PAGE);
  const session = {
    identity: parseSessionComment(SESSION),
    pages: [
      { url: "/a", pageId: "audits:audit_detail", context: ctx },
      { url: "/a?x", pageId: "audits:audit_detail", context: ctx },      // same screen twice
      { url: "/b", pageId: "locations:create", context: null },          // no file
      { url: "/c", pageId: "", context: null },                          // not an app page at all
    ],
  };
  const block = contextBlock(session);
  assert.match(block, /^=== SESIJA: KO, PRAVA, FLAGOVI ===/);
  assert.match(block, /uloga revizor · tenant mns · prava: audit\.execute, audit\.\*/);
  assert.match(block, /flagovi OFF koje poseceni ekrani traze: fault_reporting/);
  assert.equal((block.match(/\[audits:audit_detail/g) || []).length, 1, "deduped per screen");
  assert.match(block, /\[locations:create\] — NEMA KONTEKST FAJL/);
  assert.match(block, /\[\/c\] — EKRAN NIJE OZNACEN/, "a page the app did not mark is named by path");
  assert.doesNotMatch(block, /\[\]/);
  assert.match(block, /NE DOZVOLJAVA: otvaranje revizije van sopstvenog domena/);
  assert.match(block, /\(audit-2026-06-01\)/);
  assert.ok(block.indexOf("=== SESIJA") < block.indexOf("=== KONTEKST EKRANA"));
});

test("contextBlock is empty only for a session with no pages at all", () => {
  assert.equal(contextBlock({ pages: [] }), "");
  assert.equal(contextBlock(null), "");
});

test("an app that publishes nothing: the session says so, every screen is named unmarked, capped", () => {
  const pages = Array.from({ length: 9 }, (_, i) => ({ url: `https://popis.example/s/${i}?q=1` }));
  const block = contextBlock({ identity: { user: "pera" }, pages });
  assert.match(block, /^=== SESIJA: KO, PRAVA, FLAGOVI ===\nAplikacija NE objavljuje ulogu/);
  assert.match(block, /Prava korisnika NISU poznata/);
  assert.equal((block.match(/EKRAN NIJE OZNACEN/g) || []).length, 6, "six named");
  assert.match(block, /\(\+3 neoznacenih ekrana\)/);
  assert.match(block, /\[\/s\/0\]/, "path without the query string");
});

test("screenKey: url_name, else data-page, else ?path", () => {
  assert.equal(screenKey({ context: { url_name: "a:b" }, pageId: "x" }), "a:b");
  assert.equal(screenKey({ pageId: "a:b" }), "a:b");
  assert.equal(screenKey({ url: "https://h/p/q?z" }), "?/p/q");
  assert.equal(screenKey({ url: "/rel?z" }), "?/rel");
  assert.equal(screenKey({}), "");
});

test("coverage splits screens with a file from screens without one", () => {
  const cov = coverage({ pages: [
    { pageId: "a", context: { url_name: "a" } },
    { pageId: "b", context: null },
    { pageId: "a", context: null },      // seen once WITH context -> counts as covered
  ] });
  assert.deepEqual(cov.withContext, ["a"]);
  assert.deepEqual(cov.withoutContext, ["b"]);
  const un = coverage({ pages: [{ url: "https://h/x/y?z=1" }, { url: "https://h/x/y" }, { pageId: "b" }] });
  assert.deepEqual(un.withoutContext, ["?/x/y", "b"], "unmarked screens ride as ?path, deduped");
});

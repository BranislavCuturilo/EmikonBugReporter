// Tests for URL-scoped skill groups.
//
//   node test/groups.test.mjs
//
// Two ways this fails silently and neither throws: a group that should apply
// and does not (the rule the user wrote is simply absent from the ticket), and
// a group that applies when it should not (a pattern too loose, so helpdesk
// rules leak onto an unrelated site). Both look like the model misbehaving.

import {
  matchesPattern, activeGroups, skillsFor, buildSystem, ALWAYS_GROUP,
} from "../src/lib/prompts.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         ocekivano: ${e}\n         dobijeno:  ${a}`);
  }
}

const M = (url, pat) => matchesPattern(url, pat);

console.log("matchesPattern — host");
check("tacan host", M("https://tiket.emikon.rs/tickets/1", "tiket.emikon.rs"), true);
check("poddomen se hvata", M("https://a.tiket.emikon.rs/x", "tiket.emikon.rs"), true);
check("drugi host ne", M("https://google.com/", "tiket.emikon.rs"), false);
check("host koji se samo zavrsava slicno NE", M("https://eviltiket.emikon.rs.evil.com/", "tiket.emikon.rs"), false);
check("http i https svejedno", M("http://tiket.emikon.rs/", "tiket.emikon.rs"), true);
check("shema u patternu se ignorise", M("https://tiket.emikon.rs/", "https://tiket.emikon.rs"), true);
check("velika slova svejedno", M("https://TIKET.Emikon.RS/", "Tiket.Emikon.rs"), true);

console.log("\nmatchesPattern — wildcard");
check("*.emikon.rs hvata poddomen", M("https://tiket.emikon.rs/", "*.emikon.rs"), true);
check("*.emikon.rs ne hvata goli domen", M("https://emikon.rs/", "*.emikon.rs"), false);
check("wildcard ne prelazi tacku", M("https://a.b.emikon.rs/", "*.emikon.rs"), false);
check("wildcard se ne prosiruje van domena",
  M("https://emikon.rs.napadac.com/", "*.emikon.rs"), false);

console.log("\nmatchesPattern — putanja");
check("host + prefiks putanje", M("https://tiket.emikon.rs/tickets/9", "tiket.emikon.rs/tickets"), true);
check("pogresna putanja ne", M("https://tiket.emikon.rs/admin", "tiket.emikon.rs/tickets"), false);
check("samo putanja, bilo koji host", M("https://bilosta.rs/admin/x", "/admin"), true);
check("samo putanja, ne poklapa se", M("https://bilosta.rs/javno", "/admin"), false);

console.log("\nmatchesPattern — degenerisano");
check("prazan pattern ne hvata nista", M("https://tiket.emikon.rs/", ""), false);
check("pattern od razmaka ne hvata nista", M("https://tiket.emikon.rs/", "   "), false);
check("neispravan URL ne puca", M("ovo nije url", "tiket.emikon.rs"), false);
check("null URL ne puca", M(null, "tiket.emikon.rs"), false);
check("null pattern ne puca", M("https://tiket.emikon.rs/", null), false);

console.log("\nactiveGroups");
const GROUPS = [
  { id: ALWAYS_GROUP, name: "Svuda", patterns: [], enabled: true },
  { id: "g-hd", name: "Helpdesk", patterns: ["tiket.emikon.rs"], enabled: true },
  { id: "g-erp", name: "ERP", patterns: ["erp.emikon.rs", "/finansije"], enabled: true },
  { id: "g-off", name: "Ugasena", patterns: ["tiket.emikon.rs"], enabled: false },
];
const names = (urls) => activeGroups(GROUPS, urls).map((g) => g.name);

check("grupa bez patterna vazi uvek", names(["https://bilosta.rs/"]), ["Svuda"]);
check("helpdesk sesija", names(["https://tiket.emikon.rs/tickets/1"]), ["Svuda", "Helpdesk"]);
check("ugasena grupa nikad ne ulazi",
  activeGroups(GROUPS, ["https://tiket.emikon.rs/"]).some((g) => g.name === "Ugasena"), false);
check("erp preko putanje", names(["https://drugi.rs/finansije/kartica"]), ["Svuda", "ERP"]);
check("sesija kroz dva sajta nosi obe grupe",
  names(["https://tiket.emikon.rs/t/1", "https://erp.emikon.rs/x"]), ["Svuda", "Helpdesk", "ERP"]);
check("bez url-ova ostaje samo bezuslovna", names([]), ["Svuda"]);
check("null grupe ne pucaju", activeGroups(null, ["https://x.rs/"]).length, 0);

console.log("\nskillsFor — filtriranje po grupi");
const SKILLS = [
  { id: "a", name: "svuda", text: "A", scope: "both", enabled: true, groupId: ALWAYS_GROUP },
  { id: "b", name: "helpdesk", text: "B", scope: "both", enabled: true, groupId: "g-hd" },
  { id: "c", name: "erp", text: "C", scope: "both", enabled: true, groupId: "g-erp" },
  { id: "d", name: "bez grupe", text: "D", scope: "both", enabled: true },
];
const picked = (urls) =>
  skillsFor(SKILLS, "compose", { groups: GROUPS, urls }).map((s) => s.name);

check("na helpdesku: svuda + helpdesk + bez grupe",
  picked(["https://tiket.emikon.rs/t/1"]), ["svuda", "helpdesk", "bez grupe"]);
check("na nepoznatom sajtu: samo bezuslovni",
  picked(["https://nesto.rs/"]), ["svuda", "bez grupe"]);
check("skill bez groupId se ponasa kao 'svuda'",
  picked(["https://nesto.rs/"]).includes("bez grupe"), true);
check("stari oblik poziva (bez grupa) propusta sve",
  skillsFor(SKILLS, "compose").map((s) => s.name), ["svuda", "helpdesk", "erp", "bez grupe"]);

console.log("\nbuildSystem — grupa stvarno menja instrukciju");
{
  const onHelpdesk = buildSystem("compose", {
    skills: SKILLS, groups: GROUPS, urls: ["https://tiket.emikon.rs/t/1"],
  });
  const elsewhere = buildSystem("compose", {
    skills: SKILLS, groups: GROUPS, urls: ["https://nesto.rs/"],
  });
  check("helpdesk pravilo je u instrukciji na helpdesku", onHelpdesk.includes("## helpdesk"), true);
  check("helpdesk pravilo NIJE u instrukciji drugde", elsewhere.includes("## helpdesk"), false);
  check("bezuslovno pravilo je u obe", onHelpdesk.includes("## svuda") && elsewhere.includes("## svuda"), true);
  check("erp pravilo nije ni u jednoj od ove dve",
    onHelpdesk.includes("## erp") || elsewhere.includes("## erp"), false);
}

console.log(`\n${passed} proslo, ${failed} palo`);
process.exit(failed ? 1 : 0);

// Tests for how the system instruction is assembled from house style + skills.
//
//   node test/prompts.test.mjs
//
// This is where a skill fails SILENTLY: a switched-on rule that never reaches
// the model produces tickets that look fine and simply ignore the rule, which
// is indistinguishable from the model disobeying it.

import {
  buildSystem, skillsFor, newSkill, DEFAULT_HOUSE_STYLE, SKILL_SCOPES, STARTER_SKILLS,
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

const skill = (over = {}) => ({ ...newSkill(), name: "S", text: "PRAVILO", ...over });

console.log("skillsFor — opseg i ukljucenost");
{
  const list = [
    skill({ name: "oba", scope: "both" }),
    skill({ name: "samo-int", scope: "interview" }),
    skill({ name: "samo-com", scope: "compose" }),
    skill({ name: "iskljucen", scope: "both", enabled: false }),
    skill({ name: "prazan", scope: "both", text: "   " }),
  ];
  check("ispitivanje dobija both + interview",
    skillsFor(list, "interview").map((s) => s.name), ["oba", "samo-int"]);
  check("sklapanje dobija both + compose",
    skillsFor(list, "compose").map((s) => s.name), ["oba", "samo-com"]);
  check("iskljucen nikad ne prolazi",
    skillsFor(list, "compose").some((s) => s.name === "iskljucen"), false);
  check("ukljucen ali prazan ne prolazi",
    skillsFor(list, "compose").some((s) => s.name === "prazan"), false);
  check("null lista ne puca", skillsFor(null, "compose").length, 0);
}

console.log("\nbuildSystem — osnovna pravila");
{
  const out = buildSystem("compose", {});
  check("prazan houseStyle koristi podrazumevana",
    out.includes(DEFAULT_HOUSE_STYLE.slice(0, 60)), true);
  check("bez skillova nema sekcije DODATNA PRAVILA",
    out.includes("=== DODATNA PRAVILA ==="), false);
}
{
  const out = buildSystem("compose", { houseStyle: "MOJA PRAVILA" });
  check("custom houseStyle se koristi", out.includes("MOJA PRAVILA"), true);
  check("custom houseStyle zamenjuje podrazumevana",
    out.includes(DEFAULT_HOUSE_STYLE.slice(0, 60)), false);
}
{
  const out = buildSystem("compose", { houseStyle: "   " });
  check("houseStyle od samih razmaka pada na podrazumevana",
    out.includes(DEFAULT_HOUSE_STYLE.slice(0, 60)), true);
}

console.log("\nbuildSystem — skillovi stizu do modela");
{
  const list = [
    skill({ name: "VEZ", text: "Mora biti konfigurabilno po klijentu.", scope: "compose" }),
    skill({ name: "NE-OVDE", text: "Ovo vazi samo za ispitivanje.", scope: "interview" }),
  ];
  const out = buildSystem("compose", { skills: list });
  check("naziv skilla je u instrukciji", out.includes("## VEZ"), true);
  check("tekst skilla je u instrukciji",
    out.includes("Mora biti konfigurabilno po klijentu."), true);
  check("skill iz drugog koraka NIJE u instrukciji", out.includes("NE-OVDE"), false);
  check("sekcija DODATNA PRAVILA postoji", out.includes("=== DODATNA PRAVILA ==="), true);
}
{
  const out = buildSystem("compose", { skills: [skill({ name: "", text: "bez naziva" })] });
  check("skill bez naziva dobija oznaku", out.includes("## bez naziva"), true);
}

console.log("\nbuildSystem — redosled");
{
  // The role block ends with the JSON-only instruction. A skill appended after
  // it has been observed to talk the model out of returning JSON at all, so the
  // role must be last no matter how many skills there are.
  const out = buildSystem("compose", {
    skills: [skill({ name: "A", text: "prica prica prica" })],
  });
  const iSkill = out.indexOf("## A");
  const iRole = out.indexOf("TVOJA ULOGA SADA");
  const iJson = out.lastIndexOf("ISKLJUCIVO JSON-om");
  check("skill dolazi pre uloge", iSkill > -1 && iSkill < iRole, true);
  check("instrukcija se ZAVRSAVA zahtevom za JSON",
    out.trim().endsWith("Odgovaras ISKLJUCIVO JSON-om po datoj semi."), true);
  check("JSON instrukcija je posle skilla", iJson > iSkill, true);
}
{
  const int = buildSystem("interview", {});
  const com = buildSystem("compose", {});
  check("ispitivanje nosi ulogu ispitivaca", int.includes("ispitivac, ne pisac"), true);
  check("sklapanje nosi ulogu sklapanja", com.includes("sklopi tiket(e) iz sesije"), true);
  check("koraci se ne mesaju", int.includes("sklopi tiket(e) iz sesije"), false);
}

console.log("\nstarter skillovi");
check("svi su iskljuceni", STARTER_SKILLS.every((s) => s.enabled === false), true);
check("svi imaju naziv i tekst",
  STARTER_SKILLS.every((s) => s.name.trim() && s.text.trim()), true);
check("svi imaju validan opseg",
  STARTER_SKILLS.every((s) => Object.keys(SKILL_SCOPES).includes(s.scope)), true);
check("ne uticu na instrukciju dok su iskljuceni",
  buildSystem("compose", { skills: STARTER_SKILLS }).includes("=== DODATNA PRAVILA ==="), false);

console.log(`\n${passed} proslo, ${failed} palo`);
process.exit(failed ? 1 : 0);

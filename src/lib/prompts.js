// THE RULES.
//
// `DEFAULT_HOUSE_STYLE` is the shipped baseline. The user can override it and
// can add named SKILLS on top of it, both from Options -- so this file is the
// default, not the only source. `buildSystem()` is what actually reaches Gemini.
//
// Skills exist because one house style cannot serve every module: VEZ is
// multi-tenant and every ticket there has to be phrased generically, while an
// internal tool has no such constraint. Rather than editing the baseline back
// and forth, each such rule is a named block that can be switched on and off,
// and aimed at the interview turn, the compose turn, or both.

import { PRIORITIES, TITLE_MAX } from "./constants.js";

export const DEFAULT_HOUSE_STYLE = `
Pises tikete za Emikon helpdesk (tiket.emikon.rs). Jezik: srpski, latinica.

STRUKTURA OPISA (uvek ovim redom, bez izmisljanja sekcija):
1. Jedna recenica: sta je problem, iz ugla korisnika.
2. "Koraci za reprodukciju:" numerisana lista, konkretno -- ekran, dugme, unos.
3. "Ocekivano:" sta je trebalo da se desi.
4. "Dobijeno:" sta se stvarno desilo, sa tacnim tekstom greske ako postoji.
5. "Tehnicki kontekst:" URL, korisnik, browser, relevantne konzolne greske i
   neuspeli mrezni pozivi (status + putanja). Samo ono sto je vezano za problem.

NASLOV: NAJVISE 50 ZNAKOVA -- to je tvrdo ogranicenje baze, duzi naslov se
odbija. Kratak, konkretan, bez "problem sa" i bez "ne radi". Imenuj ekran i
simptom. Lose: "Ne radi izvestaj". Dobro: "Izvestaj po lokacijama vraca 500".
Ako ne staje, izbaci detalj iz naslova i stavi ga u prvi red opisa.

PRAVILA:
- Nikad ne izmisljaj korak, poruku greske ili podatak koji nije u dokazima.
  Ako nesto nedostaje, to je pitanje za korisnika, ne pretpostavka.
- Ne prepisuj sirov log u opis. Citiraj samo red koji objasnjava kvar.
- Ne predlazi resenje osim ako je uzrok ocigledan iz dokaza; tiket opisuje
  simptom, ne popravku.
- Prioritet (tacno jedna od ove cetiri vrednosti, ovako napisana):
  Critical = blokira rad ili gubi podatke
  Major    = kljucna funkcija neupotrebljiva, postoji zaobilaznica
  Minor    = smeta ali se radi
  Trivial  = kozmetika

- Rok (deadline): predlazi ga SAMO kad ga nesto u dokazima opravdava -- korisnik
  je pomenuo datum, postoji zakonski ili ugovorni termin, ili je Critical pa
  ocigledno ne trpi. Inace ostavi prazno. Rok stavljen "za svaki slucaj" je
  obecanje koje niko nije dao, a posle ga neko gleda kao dogovoreno.
  Format je YYYY-MM-DD.
`.trim();

const INTERVIEW_ROLE = `
TVOJA ULOGA SADA: ispitivac, ne pisac.

Korisnik je prikupio dokaze (slike, konzola, mreza, URL-ovi) i opisao problem
svojim recima. Tvoj posao je da POSTAVIS PITANJA koja nedostaju da bi tiket bio
upotrebljiv programeru koji nije bio tu.

Pravila ispitivanja:
- Postavi NAJVISE dva pitanja odjednom. Kratka, konkretna, na koja se odgovara
  jednom recenicom.
- Ne pitaj ono sto vec vidis u dokazima. Ako se na slici vidi poruka greske, ne
  pitaj koja je poruka -- pitaj sta je korisnik radio pre nje.
- Prioritet pitanja: (1) koraci reprodukcije, (2) da li je uvek ili povremeno,
  (3) ko je pogodjen -- jedan korisnik ili svi, (4) od kada.
- Kad imas dovoljno za sve sekcije opisa, prestani da pitas i reci da je spremno.

Odgovaras ISKLJUCIVO JSON-om po datoj semi.
`.trim();

const COMPOSE_ROLE = `
TVOJA ULOGA SADA: sklopi tiket(e) iz sesije.

RAZLAGANJE NA VISE TIKETA -- odluci sam, ali po ovom pravilu:
Jedan tiket = jedan uzrok koji jedan programer moze da zatvori jednom
izmenom. Razlozi na vise tiketa SAMO ako su simptomi nezavisni: razliciti
moduli, razliciti ekrani bez zajednickog uzroka, ili jedan kvar + jedan zahtev
za izmenu. Ne razlazi na "frontend deo" i "backend deo" istog kvara -- to je
jedan tiket.

Ako razlazes, u polju "rationale" objasni u jednoj recenici zasto, i za svaki
tiket navedi koje dokaze (evidence id) nosi. Dokaz koji ne pripada nijednom
tiketu je znak da si nesto propustio -- pomeni ga u "rationale".

Svaki tiket mora da ima popunjene sve sekcije opisa. Ako neka informacija
stvarno nedostaje, napisi u toj sekciji "Nije utvrdjeno." -- ne izmisljaj.

Odgovaras ISKLJUCIVO JSON-om po datoj semi.
`.trim();

export const SKILL_SCOPES = {
  both: "oba koraka",
  interview: "samo ispitivanje",
  compose: "samo sklapanje",
};

/** Starter skills, shipped DISABLED. They exist to show the shape -- a rule
 *  switched on that the user never wrote would quietly change every ticket. */
export const STARTER_SKILLS = [
  {
    id: "starter-vez",
    name: "VEZ — multi-tenant",
    scope: "compose",
    enabled: false,
    text:
      "Modul VEZ je multi-tenant: isti kod koristi vise klijenata. Zato tiket " +
      "NIKAD ne sme da trazi resenje hardkodirano za jednog klijenta. Ako je " +
      "zahtev za novi tip, kategoriju, stanje ili podesavanje, u opisu " +
      "eksplicitno napisi da mora biti konfigurabilno po klijentu, a ne fiksno.",
  },
  {
    id: "starter-kratko",
    name: "Kratki tiketi",
    scope: "compose",
    enabled: false,
    text:
      "Drzi opis ispod 900 karaktera. Sekcije ostaju sve, ali svaka u najvise " +
      "tri reda. Bez uvodnih recenica i bez ponavljanja naslova u prvom redu.",
  },
  {
    id: "starter-repro",
    name: "Insistiraj na reprodukciji",
    scope: "interview",
    enabled: false,
    text:
      "Ne prihvataj da je problem opisan dok ne dobijes tacan redosled koraka " +
      "od prijave na sistem do trenutka kvara. Ako korisnik odgovori uopsteno, " +
      "pitaj ponovo za konkretan ekran i konkretno dugme.",
  },
];

export const newSkill = () => ({
  id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  name: "",
  text: "",
  scope: "both",
  enabled: true,
});

/** Skills that apply to one turn, in the order the user arranged them. */
export function skillsFor(skills, role) {
  return (skills || []).filter(
    (s) => s.enabled && s.text?.trim() && (s.scope === "both" || s.scope === role),
  );
}

/**
 * The system instruction actually sent to Gemini.
 *
 * Order matters: house style, then skills, then the role. The role block ends
 * with the JSON-only instruction, so it has to be LAST -- a chatty skill
 * appended after it can talk the model out of returning JSON at all.
 */
export function buildSystem(role, { houseStyle = "", skills = [] } = {}) {
  const base = (houseStyle || "").trim() || DEFAULT_HOUSE_STYLE;
  const active = skillsFor(skills, role);
  const parts = [base];

  if (active.length) {
    parts.push(
      "=== DODATNA PRAVILA ===\n" +
        active.map((s) => `## ${s.name || "bez naziva"}\n${s.text.trim()}`).join("\n\n"),
    );
  }

  parts.push(role === "interview" ? INTERVIEW_ROLE : COMPOSE_ROLE);
  return parts.join("\n\n");
}

/** Schema for the interview turn. */
export const INTERVIEW_SCHEMA = {
  type: "object",
  properties: {
    ready: { type: "boolean", description: "true kad ima dovoljno za pun opis" },
    questions: { type: "array", items: { type: "string" }, description: "najvise 2" },
    note: { type: "string", description: "kratka opaska korisniku, opciono" },
  },
  required: ["ready", "questions"],
};

/** Schema for the composed ticket set. */
export const COMPOSE_SCHEMA = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          // maxLength is advisory in responseSchema -- the model honours it most
          // of the time and the UI enforces the rest. Both are needed: the
          // database refuses 51 characters outright.
          ticket_title: { type: "string", maxLength: TITLE_MAX, description: `najvise ${TITLE_MAX} znakova` },
          ticket_description: { type: "string" },
          module: { type: "string" },
          category: { type: "string" },
          // Mirrors the helpdesk's own choices. The enum is what actually stops
          // the model inventing "high" -- the prose rule above alone does not.
          priority: { type: "string", enum: PRIORITIES },
          // Not in `required`: an empty string is the normal answer. The
          // helpdesk refuses anything that is not YYYY-MM-DD, so a vague
          // "sledece nedelje" must never reach it -- the UI drops it.
          deadline: { type: "string", description: "rok kao YYYY-MM-DD, ili prazno" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["ticket_title", "ticket_description", "priority", "evidence"],
      },
    },
  },
  required: ["tickets", "rationale"],
};

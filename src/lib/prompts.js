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
- Uz pitanja, u "suggestions" predlozi 0 do 2 stvari koje korisnik moze SAM
  da proveri pre nego sto tiket ode (otvori X i probaj Y), izvedene iz bloka
  KONTEKST EKRANA: sifarnik od kog ekran zavisi, pravo koje sesija nema,
  flag koji je OFF. Ako blok kaze da je trazeno pod "NE DOZVOLJAVA", reci
  to odmah u "note" -- mozda tiket nije ni potreban.

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

STA JE OVO -- polje "kind" za svaki tiket, po ovom redu odlucivanja:
1. Ako korisnik trazi nesto sto blok KONTEKST EKRANA navodi pod
   "NE DOZVOLJAVA", to je "limitation": ekran to NAMERNO ne radi. Citiraj
   razlog i oznaku u zagradi (npr. audit-2026-06-01) u opisu. Ne planiraj
   popravku; predlozi zahtev za izmenu ako korisnik to zeli.
2. Ako ekran trazi pravo ("trazi ...") koje prava sesije ne pokrivaju, ili
   flag koji je OFF za tenant, to je "question": korisniku treba pravo ili
   ukljucen modul, ne programer. Napisi tacno koje pravo ili flag.
3. Ako je zahtev za novu mogucnost, "change_request".
4. Inace "bug".
Ekran oznacen "NEMA KONTEKST FAJL" nema deklaraciju -- ne zakljucuj da je
sve dozvoljeno; navedi ga u "context_missing" i u "rationale" reci da za
njega nisi mogao da proveris ogranicenja.

STA JOS DA SE PROVERI -- "checks_suggested": 0 do 3 stavke koje bi
programeru ustedele krug pitanja, izvedene iz konteksta (sifarnik od kog
ekran zavisi, drugi ekran istog toka, pravo koje fali). Kratke i konkretne.

Odgovaras ISKLJUCIVO JSON-om po datoj semi.
`.trim();

export const ALWAYS_GROUP = "always";

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
    groupId: ALWAYS_GROUP,
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
    groupId: ALWAYS_GROUP,
    scope: "compose",
    enabled: false,
    text:
      "Drzi opis ispod 900 karaktera. Sekcije ostaju sve, ali svaka u najvise " +
      "tri reda. Bez uvodnih recenica i bez ponavljanja naslova u prvom redu.",
  },
  {
    id: "starter-repro",
    name: "Insistiraj na reprodukciji",
    groupId: ALWAYS_GROUP,
    scope: "interview",
    enabled: false,
    text:
      "Ne prihvataj da je problem opisan dok ne dobijes tacan redosled koraka " +
      "od prijave na sistem do trenutka kvara. Ako korisnik odgovori uopsteno, " +
      "pitaj ponovo za konkretan ekran i konkretno dugme.",
  },
];

/** Shipped groups. "Svuda" has no pattern and therefore always applies; the
 *  helpdesk one is an example of the shape, with a real address in it. */
export const STARTER_GROUPS = [
  { id: ALWAYS_GROUP, name: "Svuda", patterns: [], enabled: true },
  { id: "g-helpdesk", name: "Helpdesk", patterns: ["tiket.emikon.rs"], enabled: true },
];

export const newSkill = () => ({
  id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  name: "",
  text: "",
  scope: "both",
  enabled: true,
  groupId: ALWAYS_GROUP,
});

// -- groups ----------------------------------------------------------------
//
// A group is a named set of skills plus the addresses it applies to. Rules for
// the helpdesk are not rules for an ERP screen, and switching them by hand on
// every session is the kind of chore that ends with them left switched on.
//
// A group with NO patterns applies everywhere. That is the default group, and
// it is also what every skill written before groups existed belongs to -- an
// old skill must not stop working because a new field appeared.

export const newGroup = () => ({
  id: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  name: "",
  patterns: [],
  enabled: true,
});

export const DEFAULT_GROUP = {
  id: ALWAYS_GROUP,
  name: "Svuda",
  patterns: [],
  enabled: true,
};

/** host + path of a URL, lowercased. `null` for anything unparseable. */
function partsOf(url) {
  try {
    const u = new URL(String(url));
    return { host: u.hostname.toLowerCase(), path: (u.pathname || "/").toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Does one address match one pattern?
 *
 * Deliberately forgiving, because the person typing the pattern is describing a
 * site, not writing a regex:
 *
 *   tiket.emikon.rs          host, and any subdomain of it
 *   *.emikon.rs              any subdomain
 *   tiket.emikon.rs/tickets  host plus a path prefix
 *   /admin/                  path only, on any host
 *
 * An empty pattern matches nothing -- a blank line in the list must not
 * silently turn a scoped group into a global one.
 */
export function matchesPattern(url, pattern) {
  const pat = String(pattern || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!pat) return false;

  const p = partsOf(url);
  if (!p) return false;

  // path-only pattern
  if (pat.startsWith("/")) return p.path.startsWith(pat);

  const slash = pat.indexOf("/");
  const hostPat = slash < 0 ? pat : pat.slice(0, slash);
  const pathPat = slash < 0 ? "" : pat.slice(slash);

  const hostOk = hostPat.includes("*")
    // one wildcard segment only: "*.emikon.rs" must not match "emikon.rs.evil.com"
    ? new RegExp(`^${hostPat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*")}$`).test(p.host)
    : p.host === hostPat || p.host.endsWith(`.${hostPat}`);

  if (!hostOk) return false;
  return !pathPat || p.path.startsWith(pathPat);
}

/**
 * The groups in force for a session, in the user's own order.
 *
 * `urls` is every page the session visited, not just the last one: a session
 * that started on the helpdesk and ended on an ERP screen was about both, and
 * dropping the earlier rules because of where the user happened to stop would
 * be arbitrary.
 */
export function activeGroups(groups, urls = []) {
  const list = (groups || []).filter((g) => g.enabled !== false);
  const seen = (urls || []).filter(Boolean);
  return list.filter((g) => {
    const pats = (g.patterns || []).filter((x) => String(x || "").trim());
    if (!pats.length) return true;                       // no pattern = everywhere
    return seen.some((u) => pats.some((pat) => matchesPattern(u, pat)));
  });
}

/**
 * Skills that apply to one turn, in the order the user arranged them.
 *
 * Called without `groups` (the old two-argument form) every skill passes the
 * group test, so nothing that existed before groups changes behaviour.
 */
export function skillsFor(skills, role, { groups = null, urls = [] } = {}) {
  let allowed = null;
  if (groups) {
    allowed = new Set(activeGroups(groups, urls).map((g) => g.id));
    allowed.add(ALWAYS_GROUP);        // the implicit home of ungrouped skills
  }
  return (skills || []).filter((s) => {
    if (!s.enabled || !s.text?.trim()) return false;
    if (s.scope !== "both" && s.scope !== role) return false;
    if (!allowed) return true;
    return allowed.has(s.groupId || ALWAYS_GROUP);
  });
}

/**
 * The system instruction actually sent to Gemini.
 *
 * Order matters: house style, then skills, then the role. The role block ends
 * with the JSON-only instruction, so it has to be LAST -- a chatty skill
 * appended after it can talk the model out of returning JSON at all.
 */
export function buildSystem(role, { houseStyle = "", skills = [], groups = null, urls = [] } = {}) {
  const base = (houseStyle || "").trim() || DEFAULT_HOUSE_STYLE;
  const active = skillsFor(skills, role, { groups, urls });
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
    suggestions: {
      type: "array",
      items: { type: "object", properties: { what: { type: "string" }, where: { type: "string" }, why: { type: "string" } }, required: ["what"] },
      description: "najvise 2: sta korisnik sam moze da proveri",
    },
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
          // What this is. The enum is what stops "maybe a bug" -- a
          // limitation is not a bug and is shown differently in the UI and
          // learned from differently in the brain.
          kind: { type: "string", enum: ["bug", "limitation", "question", "change_request"] },
          // Screens (url_name) whose declared context this verdict rests on.
          depends_on_context: { type: "array", items: { type: "string" } },
        },
        required: ["ticket_title", "ticket_description", "priority", "evidence", "kind"],
      },
    },
    checks_suggested: {
      type: "array",
      items: {
        type: "object",
        properties: {
          what: { type: "string" },
          where: { type: "string", description: "ekran ili url_name" },
          why: { type: "string" },
        },
        required: ["what", "why"],
      },
    },
    // Visited screens that carried no context file. Reported, never hidden:
    // this is what the brain uses to decide which file to write next.
    context_missing: { type: "array", items: { type: "string" } },
  },
  required: ["tickets", "rationale"],
};

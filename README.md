# Emikon Bug Reporter

Chrome ekstenzija za prijavu grešaka na `tiket.emikon.rs`. Ne šalje prijavu na
klik — vodi **sesiju**: lutaš kroz aplikaciju, skupljaš dokaze, pa AI kroz
razgovor sklopi tiket ili predloži razlaganje na više njih.

## Instalacija

1. `chrome://extensions` → uključi **Developer mode**
2. **Load unpacked** → izaberi ovaj folder
3. Klikni ikonicu ekstenzije → ⚙ → unesi:
   - **URL helpdesk-a** — `https://tiket.emikon.rs`
   - **API token** — inženjerski token (`ehd_…`)
   - **Gemini API ključ** — sa [aistudio.google.com](https://aistudio.google.com/apikey)
4. Klikni **Proveri vezu** na oba. Helpdesk mora da vrati listu modula.

Ništa ne napušta mašinu osim ka helpdesk-u i Gemini-ju. Ključevi stoje u
`chrome.storage.local` — **ne** u `chrome.storage.sync`, jer bi to poslalo token
na Google-ove servere.

## Kako se koristi

| Korak | Gde |
|---|---|
| **Počni sesiju** | side panel, na kartici sa aplikacijom |
| Lutaj, klikaj, izazovi grešku | konzola i mreža se hvataju same |
| **Slikaj** na svakom bitnom ekranu | ✎ na sličici = strelica / okvir / zamućivanje |
| **⏺ Video** za tok koji se teško opiše | kadrovi se vade automatski |
| Piši slobodno u „Šta se dešava” | AI to čita kao prvu repliku razgovora |
| **Sklopi tiket →** | otvara se veliki prozor |
| **Ispitaj me** | AI pita samo ono što nedostaje |
| **Sklopi** | predlog tiketa, ili više njih uz obrazloženje |
| **Otvori tiket** | tiket + prilozi odlaze na helpdesk |

## Šta treba znati

**Video ne ide na tiket.** Helpdesk prima samo `png/jpg/webp/gif/pdf` — nema
nijedan video tip. Snimak se čuva lokalno kao `.webm` (ide u Downloads), a na
tiket odlaze **izvučeni kadrovi kao PNG**.

**DevTools gasi hvatanje konzole i mreže.** Chrome dozvoljava samo jednog
debuggera po kartici. Ako otvoriš DevTools tokom sesije, panel to kaže naglas —
slike i beleške i dalje rade.

**Prilozi se cepaju u više komentara.** Server prima najviše 5 fajlova i 5 MB po
komentaru. 13 slika postaje 3 komentara, ne jedan odbijen zahtev. Ovo je naučeno
na živom tiketu VEZ#05513, gde je 13 odobrenih snimaka odbijeno u celini i
korisnik nije dobio ništa.

**Prekinuta isporuka se ne ponavlja slepo.** API nema dedup ključ — retry
duplira komentar. Ako odgovor ne stigne, dugme ostaje zaključano i traži da prvo
pogledaš tiket na helpdesk-u.

## Instrukcije za AI — iz podešavanja, bez diranja koda

⚙ → **Instrukcije za AI**. Dva sloja:

**Osnovna pravila** — kako se piše tiket: struktura opisa, pravila za naslov,
skala prioriteta. Menjaš ih u polju; **Vrati na podrazumevano** se pali čim
odstupiš. Ako ostaviš podrazumevana, čuva se prazno — pa buduće poboljšanje
osnovnih pravila i dalje stiže do tebe umesto da ti se zamrzne stara kopija.

**Skillovi** — imenovana dodatna pravila povrh osnovnih. Svaki ima prekidač i
opseg:

| Opseg | Kada važi |
|---|---|
| oba koraka | i dok AI ispituje i dok sklapa |
| samo ispitivanje | dok postavlja pitanja |
| samo sklapanje | dok piše tiket |

Isporučena su tri primera, **svi isključeni** — uključen skill koji nisi ti
napisao tiho bi menjao svaki tiket. Jedan od njih je `VEZ — multi-tenant`, koji
traži da tiket nikad ne zahteva rešenje hardkodirano za jednog klijenta.

**Pogledaj instrukciju** prikazuje tačan tekst koji odlazi Gemini-ju, po koraku,
sa spiskom skillova koji su u njemu. Bez pogađanja da li je pravilo stiglo.

Redosled je: osnovna pravila → skillovi → uloga. Uloga je poslednja jer se
završava zahtevom „odgovaraj isključivo JSON-om” — pričljiv skill zalepljen
posle toga ume da odgovori model od JSON-a.

U velikom prozoru, pored ⚙, stoji pločica sa brojem skillova uključenih za
sklapanje. Pređi mišem da vidiš koji su. Izmena u Opcijama važi odmah — bez
reload-a taba.

## Gde se šta menja

| Hoćeš da promeniš | Gde |
|---|---|
| **kako AI piše tikete** | ⚙ → Instrukcije za AI (bez koda) |
| pravilo samo za jedan modul | ⚙ → Skillovi → + Dodaj skill |
| podrazumevana osnovna pravila (za sve instalacije) | `DEFAULT_HOUSE_STYLE` u [`src/lib/prompts.js`](src/lib/prompts.js) |
| kada razlaže na više tiketa | `COMPOSE_ROLE` u istom fajlu |
| šta AI pita | `INTERVIEW_ROLE` u istom fajlu |
| limite priloga | [`src/lib/constants.js`](src/lib/constants.js) |
| prepoznavanje prijavljenog korisnika | [`src/content/probe.js`](src/content/probe.js) ili CSS selektor u Opcijama |
| izgled | [`src/ui/ui.css`](src/ui/ui.css) |

## Arhitektura

```
side panel  ──┐                          ┌── helpdesk.js ── tiket.emikon.rs
 (skupljanje) │                          │     jedina izlazna vrata
              ├── IndexedDB (sesija) ────┤
review tab  ──┘   slike, konzola,        └── gemini.js ──── Gemini API
 (razgovor)       mreza, chat, draft

service worker ── chrome.debugger (CDP) ── konzola + mreza
offscreen doc  ── MediaRecorder ────────── video
```

Service worker u MV3 umire posle ~30s neaktivnosti, pa **ništa** ne stoji u
njegovoj memoriji duže od jednog flush intervala. Sesija je u IndexedDB od prve
sekunde.

## Testovi

```bash
node test/chunks.test.mjs     # cepanje priloga u komentare
node test/prompts.test.mjs    # sklapanje instrukcije iz pravila + skillova
```

Pokrivaju dva mesta gde greška **ćuti** umesto da baci izuzetak: prilog koji se
ne isporuči, i skill koji ne stigne do modela. Drugo je podmuklije — tiket
izgleda ispravno i samo ignoriše pravilo, što se ne razlikuje od modela koji
pravilo ne poštuje.

Bez test runnera, namerno: mora da radi na mašini bez ijedne instalirane
zavisnosti — isti razlog zbog kog Python adapter odbija `requests`.

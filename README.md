# Emikon Bug Reporter

Chrome ekstenzija za prijavu grešaka na `tiket.emikon.rs`. Ne šalje prijavu na
klik — vodi **sesiju**: lutaš kroz aplikaciju, skupljaš dokaze, pa AI kroz
razgovor sklopi tiket ili predloži razlaganje na više njih.

## Instalacija

**Preuzmi `install.bat` i dvoklikni ga.** Skripta sama:

1. instalira Git ako ga nema (winget, pa zvanični instalater kao rezerva)
2. preuzme ekstenziju u `%LOCALAPPDATA%\EmikonBugReporter`
3. nađe Chrome i stavi putanju u clipboard
4. otvori `chrome://extensions`

Ne traži administratorska prava.

### Jedan korak koji mora čovek

Chrome **namerno** ne dozvoljava nijednom programu da sam ubaci raspakovanu
ekstenziju. Nema API, nema komandnu liniju, nema registry trik — bez enterprise
politike i potpisanog CRX-a to se ne može. Zato ostaje:

> Developer mode → **Load unpacked** → nalepi putanju (već je u clipboard-u)

Radi se **samo prvi put**. Kasnija ažuriranja ne traže ništa.

### Podešavanje

Ikonica ekstenzije → ⚙ → helpdesk URL, `ehd_` token, Gemini ključ.
Klikni **Proveri vezu** na oba.

Ključevi stoje u `chrome.storage.local` — **ne** u `chrome.storage.sync`, jer bi
to poslalo token na Google-ove servere.

## Ažuriranje

`update.bat` u folderu ekstenzije. Povuče novu verziju i kaže ti da klikneš
osveži na `chrome://extensions`.

**Podešavanja se ne diraju.** Token, skillovi i pravila žive u Chrome-ovom
skladištu vezanom za **ID ekstenzije**, a ne u fajlovima — `git pull` ih ne može
ni dotaći. ID je zakucan preko `key` polja u manifestu, pa ostaje isti čak i ako
premestiš folder.

Ekstenzija sama proverava ima li novije verzije jednom dnevno (⚙ → Verzija).
Ne može sama sebe da ažurira — Chrome to ne dozvoljava raspakovanoj ekstenziji.

Za svaki slučaj postoji i **rezervna kopija**: ⚙ → Rezervna kopija →
„Sačuvaj sve". Taj fajl sadrži ključeve u čitljivom obliku, pa ga čuvaj kao
lozinku. Varijanta „samo skillovi" je bez ključeva i može da se deli.

## Kako se koristi

| Korak | Gde |
|---|---|
| **Počni sesiju** | na kartici sa aplikacijom |
| **✂ Isečak** | prevučeš pravougaonik, kao Lightshot |
| **▭ Ekran** | sve što je trenutno vidljivo |
| **▤ Cela** | cela stranica, i deo ispod pregiba |
| **⏺ Video** | za tok koji se teško opiše |
| ✎ na sličici | strelica / okvir / zamućivanje osetljivog |
| „Šta se dešava" | AI to čita kao prvu repliku razgovora |
| **Sklopi tiket →** | otvara se veliki prozor |
| **Ispitaj me** | AI pita samo ono što nedostaje |
| **Sklopi** | predlog tiketa, ili više njih uz obrazloženje |
| **Otvori tiket** | tiket + prilozi odlaze na helpdesk |

### Gde stoje dugmad — i zašto to nije svejedno

⚙ → „Gde stoje dugmad". Tri izbora:

| Površina | Šta radi stranici |
|---|---|
| **Side panel** | **sužava viewport** — 1920 postane ~1520 i raspored se prelomi |
| **Traka u stranici** | ništa — `position: fixed` ne menja raspored. Providna, pomera se, sama se skloni pre svakog snimanja |
| **Zaseban prozor** | ništa — nema nikakvog dodira sa stranicom |

Side panel je Chrome-ov i jedini besplatan, ali suženje viewporta znači da ne
slikaš ono što korisnik zaista vidi. Zato postoje druge dve.

Traka se pre svakog snimanja skloni i **sačeka dva frejma** da Chrome to stvarno
iscrta — jedan frejm nije dovoljan i traka ostane na slici.

### Skill grupe

⚙ → Grupe. Grupa vezuje skillove za adrese:

```
Helpdesk   tiket.emikon.rs          → važi samo na helpdesk-u
ERP        erp.emikon.rs, /finansije → važi na ERP-u ili na putanji /finansije
Svuda      (bez adrese)              → važi uvek
```

Kad se poklopi više grupa, **sve se primenjuju**, redom kojim stoje. Odlučuje se
po **svim** adresama koje je sesija dodirnula, ne samo po poslednjoj — sesija
koja je počela na helpdesk-u a završila na ERP-u bila je o oboje.

Podržano: `tiket.emikon.rs` (i poddomeni), `*.emikon.rs`, `host/putanja`,
`/samo-putanja`. Prazan pattern ne hvata ništa — prazan red ne sme da tiho
pretvori usku grupu u globalnu.

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
node test/groups.test.mjs     # poklapanje URL-ova sa skill grupama
```

Pokrivaju dva mesta gde greška **ćuti** umesto da baci izuzetak: prilog koji se
ne isporuči, i skill koji ne stigne do modela. Drugo je podmuklije — tiket
izgleda ispravno i samo ignoriše pravilo, što se ne razlikuje od modela koji
pravilo ne poštuje.

Bez test runnera, namerno: mora da radi na mašini bez ijedne instalirane
zavisnosti — isti razlog zbog kog Python adapter odbija `requests`.

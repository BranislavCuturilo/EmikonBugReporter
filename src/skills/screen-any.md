---
id: screen-any
name: Svaki ekran — pre nego što je greška
scope: compose
kind: [any]
source: skills/ui-bootstrap/SKILL.md
generated: scripts/brain/extension_skills.py -- ne menjaj ovde; izmeni skills/ui-bootstrap/SKILL.md
---
Za svaki ekran, pre nego što nešto proglasiš greškom:
- Dugme ili akcija koja "ne postoji": prvo blok SESIJA — ako ekran traži pravo koje sesija nema, ili flag koji je OFF, to je "question" (pravo/modul), ne bug. Ako je pod NE DOZVOLJAVA u kontekstu ekrana, to je "limitation".
- Prazan prostor gde bi trebalo da bude sadržaj: prazno stanje mora da ima poruku i akciju ("Nema zapisa — dodaj prvi"). Tabela sa zaglavljem i ništa ispod, ili prazna kartica, jeste greška prikaza, ne "nema podataka".
- Padajući meni koji se "otvara prazan" ili se seče na ivici kartice: poznata klasa greške (kartica seče sadržaj). Opiši koji meni, u kojoj kartici, priloži sliku OTVORENOG menija.
- Sadržaj priljubljen uz ivicu kartice bez razmaka: poznata klasa (sadržaj van unutrašnjeg omotača) — bug prikaza.
- Boja ili veličina "drugačija nego drugde": bug samo ako isti element na drugom ekranu izgleda drugačije — navedi oba ekrana.
- Problem u rasporedu: traži širinu prozora (telefon / tablet / desktop) i sliku; isti ekran se ponaša različito po širini, i bez toga programer ne može da ponovi.
- Slika koja se ne prikazuje: traži da li se vidi zamena (placeholder) ili slomljena ikona — razlika odlučuje gde je greška.

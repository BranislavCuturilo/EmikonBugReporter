---
id: screen-form
name: Forma — šta svaka forma mora
scope: compose
kind: [create, update]
source: skills/ui-bootstrap/references/forma.md
generated: scripts/brain/extension_skills.py -- ne menjaj ovde; izmeni skills/ui-bootstrap/references/forma.md
---
Forma mora da: obeleži svako polje (ne samo sivim tekstom u polju), prikaže grešku UZ polje a ne samo na vrhu, sačuva unete vrednosti posle neuspelog čuvanja, onemogući dugme dok se šalje (dupli klik = dupli zapis), traži potvrdu za brisanje, obavezna polja označi dosledno.
Kako da klasifikuješ:
- Posle greške forma prazna, sve uneto nestalo → bug.
- Dupli zapis posle dva klika → bug, prioritet Major (podaci).
- "Ne mogu da sačuvam", a korisnik NIJE menjao polje koje se odbija → bug, poznata klasa (forma odbija sopstvenu tekuću vrednost); traži tačnu poruku i koje polje.
- Kvadratić (checkbox) izgleda kao prazno široko polje, "dugme ne radi" → bug prikaza, poznata klasa; slika je dovoljna.
- Padajuća lista se otvara prazna ili sečena unutar kartice → bug prikaza, poznata klasa; navedi koje polje. Ako je NATIVNI select sa opcijama "van sekcije", greška je u tabeli koja izlazi iz kartice, ne u select-u.
- Polje za datum ili vreme belo na tamnoj pozadini → bug prikaza.
- Uređivanje zaključanog ili zatvorenog zapisa nije moguće → "limitation" ako kontekst ekrana to kaže, inače "question".
- Autocomplete ubaci pogrešnu osobu/stavku iako je korisnik kucao pravu → bug, poznata klasa (stari rezultat stigne posle novog); traži tačan redosled kucanja.
- Novo polje, drugačiji raspored, dodatna validacija → "change_request".

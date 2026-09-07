---
id: screen-list
name: Lista — šta svaka lista mora
scope: compose
kind: [list]
source: skills/ui-bootstrap/references/lista.md
generated: scripts/brain/extension_skills.py -- ne menjaj ovde; izmeni skills/ui-bootstrap/references/lista.md
---
Lista (tabela) mora da ima: naizmenično obojene redove, zaglavlje kolona, filter ili pretragu čije stanje ostaje u URL-u (osvežavanje ne briše filter), paginaciju ili "učitaj još" sa ukupnim brojem, prazno stanje sa porukom, i DRUGU poruku kad filter ne nađe ništa (sa načinom da se filter ukloni). Brojevi poravnati desno, isti broj decimala u koloni.
Kako da klasifikuješ:
- Izvoz, uvoz, kolona ili filter koji nikad nije postojao → "change_request", ne bug.
- Filter sa neispravnim ili praznim upitom vraća SVE umesto ništa → bug (prikazuje što ne treba).
- Ukupan zbir ili broj se ne slaže sa prikazanim redovima → bug, prioritet iznad Minor.
- Tabela izlazi van kartice ili ekrana, ili se poslednji red (njegov meni/izbor) seče na dnu → bug prikaza; traži širinu prozora i broj kolona.
- "Učitaj još" ne radi, a lista je kraća od jedne strane → bug: dugme uopšte ne sme da se prikaže.
- Red na kome ne može ništa da se uradi, a prikazan je u listi čija je svrha ta akcija → bug.
- Sortiranje: prazne vrednosti idu na dno u OBA smera; ako u jednom smeru idu na vrh → bug.
- Filter-čipovi izlaze iz kartice u jednom redu → bug prikaza, poznata klasa.

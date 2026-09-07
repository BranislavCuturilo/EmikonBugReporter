---
id: screen-dashboard
name: Kontrolna tabla i izveštaj — šta moraju
scope: compose
kind: [dashboard, report]
source: skills/ui-bootstrap/references/dashboard.md
generated: scripts/brain/extension_skills.py -- ne menjaj ovde; izmeni skills/ui-bootstrap/references/dashboard.md
---
Kontrolna tabla ili izveštaj mora da: uz svaki broj kaže period i čije podatke ("142 otvorenih, ovaj mesec, tvoje lokacije"); razlikuje nulu od "nije mereno"; uz poređenje ("+12%") pokaže prema čemu; boju nikad ne koristi kao jedini signal; grafik ima obeležene ose i jedinicu i način da se vide brojevi iza njega (tabela ili izvoz); prazno stanje za novog klijenta.
Kako da klasifikuješ:
- Broj se ne slaže sa listom iz koje je izveden → bug, prioritet iznad Minor; traži oba ekrana i filter.
- Ukupan broj veći nego što korisnik sme da vidi (broji tuđe) → bug, Critical.
- Nula prikazana tamo gde nema merenja → bug (moraju da se razlikuju).
- Boje pragova "pogrešne" → pragovi i boje se podešavaju po klijentu: ako podešavanje postoji → "question" ili "change_request", ne bug.
- Spor izveštaj → bug; traži koji filter, koliki period, koliko sekundi.
- Novi grafik, nova kolona, drugi period → "change_request".

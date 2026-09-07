---
id: screen-detail
name: Detalj — šta svaki detalj zapisa mora
scope: compose
kind: [detail]
source: skills/ui-bootstrap/references/detalji.md
generated: scripts/brain/extension_skills.py -- ne menjaj ovde; izmeni skills/ui-bootstrap/references/detalji.md
---
Detalj zapisa mora da: prikaže naziv, ključne oznake i STATUS odmah u zaglavlju; prikaže samo akcije koje korisnik sme — sakriveno, ili sa razlogom, nikad sivo bez objašnjenja; povezane stavke (prilozi, istorija, deca) sa porukom kad ih nema; vreme apsolutno I relativno; URL koji se može podeliti (osvežavanje vraća isti tab).
Kako da klasifikuješ:
- Dugme ili akcija koja fali: prvo SESIJA (pravo, flag) i kontekst ekrana (NE DOZVOLJAVA) → "question" ili "limitation"; tek onda bug.
- Zapis u završnom stanju (zatvoren, zaključan, proknjižen) ne dozvoljava izmenu → "limitation", ne bug.
- Sivo dugme bez ikakvog objašnjenja → bug prikaza (mora ili da nestane ili da kaže zašto).
- Dugme koje se pojavi pa nestane pri otvaranju (ili obrnuto) → bug, poznata klasa (provera prava stiže posle prikaza).
- Povezana lista prikazuje stavke koje korisnik ne bi smeo da vidi (tuđe lokacije, tuđi tenant) → bug, prioritet Critical.
- Vidi se samo deo povezanih stavki, bez napomene "prikazano N od M" → bug.
- "[object Object]" ili slično u polju → bug prikaza.
- "Nema priloga", a ima — prilozi ispod dugog teksta van ekrana → bug rasporeda; traži sliku celog ekrana.

# Indkøb & Madplan

Familiens indkøbsliste og madplan som to noter direkte i Home Assistant – i stil med iOS Noter.

- **Sidepanel "Indkøb & Madplan"** – tjekliste med overskrifter (Enter = ny linje, Backspace på tom linje = slet, knappen *Overskrift* gør den markerede linje til overskrift, swipe mod venstre = slet med Fortryd) og madplan som fri tekst. Ændringer ses med det samme på alle enheder.
- **Basisliste** – de faste varer, som indkøbslisten nulstilles til efter hvert indkøb (egen note i panelet, redigeres som indkøbslisten: felt, ＋, træk, swipe – uden flueben). Når et indkøb afsluttes (automatisk efter tiden eller med "Færdig med at handle"), fjernes alle flueben, købte engangsvarer slettes, og faste varer der mangler sættes tilbage under deres kategori; ukøbte engangsvarer bliver stående. Nye varer (felt, kort, Assist, ugeplanlægger) er engangsvarer og mærkes *Engangs* på indkøbslisten – tryk på mærket (eller *Fast* i værktøjslinjen / i beskeden ved tilføjelse) for at gøre dem faste. Ved første start efter opdateringen oprettes basislisten ud fra den eksisterende indkøbsliste.
- **Færdig med at handle** – nederst i Handl eller under ⋯. Næste skridt er altid "Hvor handlede I, og hvad blev det?" (butik + beløb – kan springes over); derefter sættes listen tilbage til basislisten. Engangsvarer, der ikke blev købt, vises i arket – tryk på dem, der ikke skal med næste gang.
- **Hvad blev indkøbet?** – mangler det seneste indkøb et beløb (fx når listen er nulstillet automatisk efter tiden), står der et kort øverst på indkøbslisten. Tryk og skriv beløbet, eller × for "ingen pris". Genvej, der åbner det direkte: `homeassistant://navigate/indkob-madplan?note=indkob&pris`.
- **Indkøbstilstand** (🛒 Handl) – til butikken: ét tryk på varen krydser af, intet tastatur, og "7 af 24 i kurven" øverst.
- **Afslut indkøb i butik** – i indkøbstilstand sidder knappen nederst i listen. Vælg butikken (tidligere butikker vises som knapper) og skriv evt. beløbet. De afkrydsede varer gemmes som købt i den butik og forsvinder fra listen, så kun det, der mangler, står tilbage. Handler I videre i en anden butik, afslutter I bare igen – alle butikker samles på samme tur i indkøbshistorikken (pris og varer pr. butik). Kan rettes og fortrydes. Hændelse: `indkob_madplan_butik_afsluttet` (butik, beloeb, antal, varer, tidspunkt).
- **Ingen dubletter** – tilføjes en vare, der allerede står på listen (fra feltet, kortet, Assist eller en automation), fjernes fluebenet i stedet. Feltet foreslår kendte varer, mens man skriver.
- **Ugeplanlægger** (✨ Planlæg) – foreslår næste uge ud fra jeres egne uger. Hver ret får sin egen rytme (hvor mange aftener der plejer at gå imellem), nylige uger vægter mest, ugedagsvaner tæller (burger om fredagen), og travle aftener – nattevagt, fodbold, én voksen, aftaler i kalenderen – får nemme retter eller rester fra en dobbelt portion dagen før. Variation i kød og tilbehør, lidt tilfældighed, og valgfrit 1–2 nye retter, der ligner noget I allerede kan lide. Lås dagene I vil beholde, tryk "Andet bud" eller vælg selv, og "Gem i madplanen" skriver ugen øverst i jeres format. Bagefter kan ugens varer sættes på indkøbslisten. Retter I er færdige med, skjules med "Foreslå ikke igen". Kalenderen vælges under Indstillinger.
- **Inspiration i madplanen** – retter fra hele historikken (oftest, længe siden, sjældent, søgning). Tryk sætter retten ind på den dag, markøren står på. "Ny uge" fortsætter dagen efter sidste planlagte dag.
- **Dashboard-kort** `custom:indkob-madplan-card` – aftensmad i dag/i morgen, optøningspåmindelse, indkøbsliste til afkrydsning, forslag og statistik. Med `kun_i_dag: true` bliver kortet til én kompakt række: dagens ret (med noter og ❄-optøning) og en ＋-knap, der folder et felt ud til at tilføje varer til indkøbslisten.
- **Statistik** – hvert flueben logges som et køb: top-varer, interval, køb pr. uge, indkøbsture og forslag til varer I plejer at købe.
- **Handlet ind** – når mindst 50 % af varerne er krydset af, regnes det som en indkøbstur. 3 timer efter sidste flueben nulstilles listen automatisk til basislisten, og turen gemmes i statistikken (tærskel og timer ændres under Noter → Indstillinger i panelet).
- **Indkøbshistorik** – alle indkøbsture med dato og varer. Skriv butik og pris pr. tur (flere butikker pr. tur), eller tilføj et indkøb uden listen. Viser forbrug pr. måned og pr. butik.
- **Redigeringslog** – hvem har tilføjet, rettet, krydset af, flyttet eller slettet hvad (seneste 500 ændringer, indtastning i samme linje slås sammen).
- **Indstillinger i panelet** – andel/tid for "handlet ind", optøningsdag, ekstra kød-ord og nulstilling af statistik. Gælder hele familien og træder i kraft med det samme (ingen genindlæsning).
- **Sådan virker det** – en fold-ud-forklaring nederst på indkøbslisten.
- **Bliver på listen** – lukker iOS HA-appen i baggrunden, mens indkøbslisten er åben, vender man tilbage til listen (inden for 2 timer). Genvej direkte til listen: `homeassistant://navigate/indkob-madplan?note=indkob`.
- **Flyt varer** – træk i ≡-håndtaget for at flytte en vare, fx ind under en anden overskrift. Nye varer med samme navn lander fremover samme sted.
- **Faste kategorier som i butikken** – Frugt & grønt, Køl – kød, Køl – mejeri, Køl – pålæg / deli, Frost, Brød, Tørvarer, Drikkevarer, Slik & snacks, Husholdning, Baby / pleje og Ugevarer. Kategorier uden varer vises ikke; de dukker op, så snart der kommer en vare i dem.
- **Automatisk kategori** – nye varer (fra feltet, kortet, Assist eller en automation) lander under den overskrift, de plejer at stå under – ellers gætter integrationen ud fra navnet (dansk ordliste med sammensatte ord: "kyllingebryst" → Køl – kød, "frosne ærter" → Frost). Ukendte varer lander under Ugevarer. Beskeden "Mælk → Køl – mejeri · Skift" lader en flytte varen, og valget huskes. Ingen AI-kald.
- **＋ under hver kategori** – tilføj en vare lige præcis dér; Enter giver plads til den næste.
- **Madplan** – formatet `Uge NN` + `Onsdag: tit nat - kylling i karry (stor portion)`. Nyeste uge øverst; en uge kan løbe fra onsdag til torsdag.

## Entiteter
| Entitet | Indhold |
|---|---|
| `sensor.indkob_madplan_aftensmad_i_dag` / `_i_morgen` | Retten (attributter: noter, stor_portion, kraever_optoening, koed) |
| `binary_sensor.indkob_madplan_tag_kod_op_af_fryseren` | `on` når dagens (eller morgendagens) ret kræver optøning |
| `sensor.indkob_madplan_madplan` | Antal planlagte dage de næste 7 dage + ugens retter |
| `sensor.indkob_madplan_kobt_denne_uge` | Antal købte varer denne uge + top 10 |
| `sensor.indkob_madplan_plejer_at_kobe` | Forslag |
| `sensor.indkob_madplan_last_shopping_trip` | Tidspunkt for seneste indkøbstur (attributter: varer, antal, handler_nu, flueben_fjernes) |
| `todo.indkob_madplan_indkobsliste` | Indkøbslisten som to-do-liste (Assist: "tilføj mælk til indkøbslisten") |

## Handlinger
`indkob_madplan.tilfoej`, `tilfoej_forslag`, `handlet_ind`, `importer` (note: `indkob`, `basis` eller `madplan`), `eksporter` (indkøbsliste, basisliste, madplan), `hent_statistik`, `nulstil_statistik`.

Hændelsen `indkob_madplan_handlet_ind` (tidspunkt, antal, varer, automatisk) affyres, når en indkøbstur afsluttes.

## Kort
```yaml
type: custom:indkob-madplan-card
# vis_madplan: true
# vis_liste: true
# vis_statistik: true
# skjul_koebte: true
# kun_i_dag: false   # true = vis kun dagens ret (tryk åbner noterne)
# hurtig_tilfoej: true   # med kun_i_dag: ＋-knap der folder feltet "Tilføj til indkøbslisten" ud
# forslag: true          # med kun_i_dag: knapper med varer I plejer at købe (i det udfoldede felt)
# vis_i_morgen: false    # med kun_i_dag: også morgendagens ret
```

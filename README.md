# Indkøb & Madplan

Familiens indkøbsliste og madplan som to noter direkte i Home Assistant – i stil med iOS Noter.

- **Sidepanel "Indkøb & Madplan"** – tjekliste med overskrifter (Enter = ny linje, Backspace på tom linje = slet, "Aa" = overskrift, swipe mod venstre = slet med Fortryd) og madplan som fri tekst. Ændringer ses med det samme på alle enheder.
- **Indkøbstilstand** (🛒 Handl) – til butikken: ét tryk på varen krydser af, intet tastatur, og "7 af 24 i kurven" øverst.
- **Ingen dubletter** – tilføjes en vare, der allerede står på listen (fra feltet, kortet, Assist eller en automation), fjernes fluebenet i stedet. Feltet foreslår kendte varer, mens man skriver.
- **Inspiration i madplanen** – retter fra hele historikken (oftest, længe siden, sjældent, søgning). Tryk sætter retten ind på den dag, markøren står på. "Ny uge" fortsætter dagen efter sidste planlagte dag.
- **Dashboard-kort** `custom:indkob-madplan-card` – aftensmad i dag/i morgen, optøningspåmindelse, indkøbsliste til afkrydsning, forslag og statistik. Med `kun_i_dag: true` vises kun dagens ret plus et felt til at tilføje varer til indkøbslisten.
- **Statistik** – hvert flueben logges som et køb: top-varer, interval, køb pr. uge, indkøbsture og forslag til varer I plejer at købe.
- **Handlet ind** – når mindst 50 % af varerne er krydset af, regnes det som en indkøbstur. 3 timer efter sidste flueben fjernes alle flueben automatisk, og turen gemmes i statistikken (tærskel og timer ændres under Noter → Indstillinger i panelet).
- **Indkøbshistorik** – alle indkøbsture med dato og varer. Skriv butik og pris pr. tur (flere butikker pr. tur), eller tilføj et indkøb uden listen. Viser forbrug pr. måned og pr. butik.
- **Redigeringslog** – hvem har tilføjet, rettet, krydset af, flyttet eller slettet hvad (seneste 500 ændringer, indtastning i samme linje slås sammen).
- **Indstillinger i panelet** – andel/tid for "handlet ind", optøningsdag, ekstra kød-ord og nulstilling af statistik. Gælder hele familien og træder i kraft med det samme (ingen genindlæsning).
- **Sådan virker det** – en fold-ud-forklaring nederst på indkøbslisten.
- **Bliver på listen** – lukker iOS HA-appen i baggrunden, mens indkøbslisten er åben, vender man tilbage til listen (inden for 2 timer). Genvej direkte til listen: `homeassistant://navigate/indkob-madplan?note=indkob`.
- **Flyt varer** – træk i ≡-håndtaget for at flytte en vare, fx ind under en anden overskrift. Nye varer med samme navn lander fremover samme sted.
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
`indkob_madplan.tilfoej`, `tilfoej_forslag`, `handlet_ind`, `importer`, `eksporter`, `hent_statistik`, `nulstil_statistik`.

Hændelsen `indkob_madplan_handlet_ind` (tidspunkt, antal, varer, automatisk) affyres, når en indkøbstur afsluttes.

## Kort
```yaml
type: custom:indkob-madplan-card
# vis_madplan: true
# vis_liste: true
# vis_statistik: true
# skjul_koebte: true
# kun_i_dag: false   # true = vis kun dagens ret (tryk åbner noterne)
# hurtig_tilfoej: true   # med kun_i_dag: felt "Tilføj til indkøbslisten" under retten
# forslag: true          # med kun_i_dag: knapper med varer I plejer at købe
# vis_i_morgen: false    # med kun_i_dag: også morgendagens ret
```

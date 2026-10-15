# Indkøb & Madplan

Familiens indkøbsliste og madplan som to noter direkte i Home Assistant – i stil med iOS Noter.

- **Sidepanel "Indkøb & Madplan"** – tjekliste med overskrifter (Enter = ny linje, Backspace på tom linje = slet, "Aa" = overskrift) og madplan som fri tekst. Ændringer ses med det samme på alle enheder.
- **Dashboard-kort** `custom:indkob-madplan-card` – aftensmad i dag/i morgen, optøningspåmindelse, indkøbsliste til afkrydsning, forslag og statistik.
- **Statistik** – hvert flueben logges som et køb: top-varer, interval, køb pr. uge, indkøbsture og forslag til varer I plejer at købe.
- **Handlet ind** – når mindst 50 % af varerne er krydset af, regnes det som en indkøbstur. 3 timer efter sidste flueben fjernes alle flueben automatisk, og turen gemmes i statistikken (tærskel og timer kan ændres under integrationens indstillinger).
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
| `sensor.indkob_madplan_sidste_indkob` | Tidspunkt for seneste indkøbstur (attributter: varer, antal, handler_nu, flueben_fjernes) |
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
```

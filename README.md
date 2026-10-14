# Indkøb & Madplan

Familiens indkøbsliste og madplan som to noter direkte i Home Assistant – i stil med iOS Noter.

- **Sidepanel "Indkøb & Madplan"** – tjekliste med overskrifter (Enter = ny linje, Backspace på tom linje = slet, "Aa" = overskrift) og madplan som fri tekst. Ændringer ses med det samme på alle enheder.
- **Dashboard-kort** `custom:indkob-madplan-card` – aftensmad i dag/i morgen, optøningspåmindelse, indkøbsliste til afkrydsning, forslag og statistik.
- **Statistik** – hvert flueben logges som et køb: top-varer, interval, køb pr. uge og forslag til varer I plejer at købe.
- **Madplan** – formatet `Uge NN` + `Onsdag: tit nat - kylling i karry (stor portion)`. Nyeste uge øverst; en uge kan løbe fra onsdag til torsdag.

## Entiteter
| Entitet | Indhold |
|---|---|
| `sensor.indkob_madplan_aftensmad_i_dag` / `_i_morgen` | Retten (attributter: noter, stor_portion, kraever_optoening, koed) |
| `binary_sensor.indkob_madplan_tag_kod_op_af_fryseren` | `on` når dagens (eller morgendagens) ret kræver optøning |
| `sensor.indkob_madplan_madplan` | Antal planlagte dage de næste 7 dage + ugens retter |
| `sensor.indkob_madplan_kobt_denne_uge` | Antal købte varer denne uge + top 10 |
| `sensor.indkob_madplan_plejer_at_kobe` | Forslag |
| `todo.indkob_madplan_indkobsliste` | Indkøbslisten som to-do-liste (Assist: "tilføj mælk til indkøbslisten") |

## Handlinger
`indkob_madplan.tilfoej`, `tilfoej_forslag`, `importer`, `eksporter`, `hent_statistik`, `nulstil_statistik`.

## Kort
```yaml
type: custom:indkob-madplan-card
# vis_madplan: true
# vis_liste: true
# vis_statistik: true
# skjul_koebte: true
```

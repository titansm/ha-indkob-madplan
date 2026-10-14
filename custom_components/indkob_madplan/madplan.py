"""Parser for familiens madplan (fri tekst, nyeste uge øverst).

Format (eksempel):

    Uge 41
    Onsdag: cornflakes kyllingeburger
    Fredag: tit nat - fiskefrikadeller
    Søndag: tit nat - kylling i karry (stor portion)
    Mandag: fodbold - græsk farsbrød
    ...

Regler:
- "Uge NN" starter en blok. Første dag i blokken ligger i ISO-uge NN.
- Hver følgende dag er næste forekomst af den ugedag efter forrige linje,
  så en blok kan løbe fra onsdag til torsdag ugen efter.
- Tekst før " - " er noter (fx "tit nat", "fodbold"); sidste del er retten.
- Overlap mellem blokke: blokken der starter senest vinder (tomme dage
  overskriver ikke).

Ren Python uden Home Assistant-afhængigheder, så den kan testes isoleret.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta

UGEDAGE = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"]

_DAY_ALIASES: dict[str, int] = {
    "mandag": 0, "man": 0,
    "tirsdag": 1, "tir": 1, "tirs": 1,
    "onsdag": 2, "ons": 2,
    "torsdag": 3, "tor": 3, "tors": 3,
    "fredag": 4, "fre": 4,
    "lørdag": 5, "lør": 5, "lordag": 5, "lor": 5,
    "søndag": 6, "søn": 6, "sondag": 6, "son": 6,
}

_WEEK_RE = re.compile(r"^\s*uge\s*(\d{1,2})\b", re.IGNORECASE)
# Længste navne først, så "torsdag" ikke matches som "tor" + "sdag".
_DAY_RE = re.compile(
    r"^\s*(" + "|".join(sorted(_DAY_ALIASES, key=len, reverse=True)) + r")\b\.?\s*:?\s*(.*)$",
    re.IGNORECASE,
)
_CHECKBOX_RE = re.compile(r"^\s*[☐☑✓✔\-\*•]\s*")
_BIG_PORTION_RE = re.compile(
    r"\(?\s*(husk\s+)?(stor|dobbelt)\s+portion\s*\)?|\bx\s*2\b", re.IGNORECASE
)

# Ord der tyder på kød/fisk, som evt. skal op af fryseren.
DEFAULT_KOED_ORD = [
    "kylling", "kylle", "kalkun", "okse", "svin", "gris", "nakke",
    "hakke", "hakket", "fars", "kød", "frikadel", "deller", "burger",
    "bøf", "bøffer", "karbonade", "schnitzel", "wiener", "pølse", "bacon",
    "skinke", "lasagne", "bolognese", "bolo", "chili con carne", "mousakka",
    "moussaka", "mosoukka", "meatball", "laks", "fisk", "torsk", "rejer",
    "tun", "pulled pork", "satay", "kebab", "arayes", "nduja", "lam",
    "medister", "mørbrad", "culotte", "flæsk",
]
# Rester skal typisk ikke op af fryseren ...
DEFAULT_REST_ORD = ["rest", "rester", "tøm køleskabet"]
# ... medmindre det eksplicit står at det er fra fryseren.
_FRA_FRYSER_RE = re.compile(r"fra\s+fryse", re.IGNORECASE)


@dataclass
class Dag:
    """Én dag i madplanen."""

    dato: date
    raw: str
    ret: str
    noter: list[str] = field(default_factory=list)
    stor_portion: bool = False
    uge: int | None = None

    @property
    def ugedag(self) -> str:
        return UGEDAGE[self.dato.weekday()]

    def as_dict(self, koed_ord: list[str] | None = None, rest_ord: list[str] | None = None) -> dict:
        optoening, matches = kraever_optoening(self.raw, koed_ord, rest_ord)
        return {
            "dato": self.dato.isoformat(),
            "ugedag": self.ugedag,
            "ret": self.ret,
            "noter": self.noter,
            "stor_portion": self.stor_portion,
            "kraever_optoening": optoening,
            "koed": matches,
            "raw": self.raw,
            "uge": self.uge,
        }


def _clean_line(line: str) -> str:
    return _CHECKBOX_RE.sub("", line.replace(" ", " ")).strip()


def _split_entry(text: str) -> tuple[str, list[str], bool]:
    """Del "tit nat - kylling i karry (stor portion)" op i ret, noter, stor portion."""
    stor = bool(_BIG_PORTION_RE.search(text))
    parts = [p.strip(" .") for p in re.split(r"\s+[-–]\s+", text) if p.strip(" .")]
    if not parts:
        return "", [], stor
    ret = parts[-1]
    noter = parts[:-1]
    ret_clean = _BIG_PORTION_RE.sub("", ret)
    ret_clean = re.sub(r"\(\s*\)", "", ret_clean)
    ret_clean = re.sub(r"\s{2,}", " ", ret_clean).strip(" .,-")
    if ret_clean:
        ret = ret_clean
    if ret:
        ret = ret[0].upper() + ret[1:]
    return ret, noter, stor


def _first_date(week: int, weekday: int, today: date) -> date | None:
    """Find datoen for ugedag i ISO-uge `week` – nyeste år der ikke ligger langt ude i fremtiden."""
    for year in (today.year + 1, today.year, today.year - 1, today.year - 2):
        try:
            d = date.fromisocalendar(year, week, weekday + 1)
        except ValueError:
            continue
        if d <= today + timedelta(days=21):
            return d
    return None


def parse_madplan(text: str, today: date) -> dict[date, Dag]:
    """Parse hele madplan-teksten og returnér {dato: Dag}."""
    blocks: list[list[Dag]] = []
    current: list[Dag] | None = None
    week: int | None = None
    prev: date | None = None

    for raw_line in (text or "").splitlines():
        line = _clean_line(raw_line)
        if not line:
            continue
        m = _WEEK_RE.match(line)
        if m:
            week = int(m.group(1))
            prev = None
            current = []
            blocks.append(current)
            continue
        m = _DAY_RE.match(line)
        if not m or week is None or current is None:
            continue
        wd = _DAY_ALIASES[m.group(1).lower()]
        entry = m.group(2).strip()
        if prev is None:
            d = _first_date(week, wd, today)
            if d is None:
                continue
        else:
            delta = (wd - prev.weekday()) % 7 or 7
            d = prev + timedelta(days=delta)
        prev = d
        ret, noter, stor = _split_entry(entry)
        current.append(Dag(dato=d, raw=entry, ret=ret, noter=noter, stor_portion=stor, uge=week))

    # Ældste blok først; senere starter overskriver (men ikke med tomme dage).
    blocks = [b for b in blocks if b]
    blocks.sort(key=lambda b: b[0].dato)
    result: dict[date, Dag] = {}
    for block in blocks:
        for dag in block:
            if dag.ret or dag.dato not in result:
                result[dag.dato] = dag
    return result


def kraever_optoening(
    raw: str, koed_ord: list[str] | None = None, rest_ord: list[str] | None = None
) -> tuple[bool, list[str]]:
    """Gæt om retten kræver at noget tages op af fryseren."""
    if not raw:
        return False, []
    low = f" {raw.lower()} "
    ord_ = koed_ord if koed_ord is not None else DEFAULT_KOED_ORD
    rest = rest_ord if rest_ord is not None else DEFAULT_REST_ORD
    tokens = re.findall(r"[a-zæøåé]+", low)

    def _hit(word: str) -> bool:
        w = word.strip().lower()
        if not w:
            return False
        if " " in w:
            return w in low
        if len(w) <= 3:  # korte ord (lam, tun) kun som ordstart
            return any(t.startswith(w) for t in tokens)
        return any(w in t for t in tokens)  # sammensatte ord: kyllingeburger

    matches = sorted({o.strip() for o in ord_ if _hit(o)})
    if _FRA_FRYSER_RE.search(raw):
        return True, matches or ["fra fryseren"]
    if not matches:
        return False, []
    if any(re.search(rf"\b{re.escape(r.lower())}\b", low) for r in rest):
        return False, matches
    return True, matches

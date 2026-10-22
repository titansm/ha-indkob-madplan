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
# Kødsort valgt i ugeplanlæggeren (0.12.4): "burger (❄ kyllingebryst)"
_FRYSER_VALG_RE = re.compile(r"\(\s*❄\s*([^()]*?)\s*\)")
# Valg der betyder "intet skal op af fryseren"
INTET_FRA_FRYSER = "intet"


@dataclass
class Dag:
    """Én dag i madplanen."""

    dato: date
    raw: str
    ret: str
    noter: list[str] = field(default_factory=list)
    stor_portion: bool = False
    uge: int | None = None
    fryser_valg: str | None = None  # kødsort valgt i planlæggeren ("❄ …")

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
            "fryser_valg": self.fryser_valg,
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
        fv = _FRYSER_VALG_RE.search(entry)
        ret, noter, stor = _split_entry(_FRYSER_VALG_RE.sub(" ", entry) if fv else entry)
        current.append(Dag(dato=d, raw=entry, ret=ret, noter=noter, stor_portion=stor, uge=week,
                           fryser_valg=(fv.group(1).strip() or None) if fv else None))

    # Ældste blok først; senere starter overskriver (men ikke med tomme dage).
    blocks = [b for b in blocks if b]
    blocks.sort(key=lambda b: b[0].dato)
    result: dict[date, Dag] = {}
    for block in blocks:
        for dag in block:
            if dag.ret or dag.dato not in result:
                result[dag.dato] = dag
    return result


@dataclass
class Linje:
    """En dag-linje i madplan-teksten (0.13.0): hvor den står, og hvilken dato den gælder."""

    idx: int  # linjenummer i teksten (0-baseret, som text.splitlines())
    blok: int  # blokkens nummer i teksten (0 = øverst)
    overskrift: str  # blokkens "Uge NN"-linje
    dag: Dag


def scan_linjer(text: str, today: date) -> list[Linje]:
    """Alle dag-linjer med linjenummer og blok – samme regler som parse_madplan (0.13.0)."""
    ud: list[Linje] = []
    week: int | None = None
    prev: date | None = None
    blok = -1
    overskrift = ""
    for i, raw_line in enumerate((text or "").splitlines()):
        line = _clean_line(raw_line)
        if not line:
            continue
        m = _WEEK_RE.match(line)
        if m:
            week = int(m.group(1))
            prev = None
            blok += 1
            overskrift = line
            continue
        m = _DAY_RE.match(line)
        if not m or week is None or blok < 0:
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
        fv = _FRYSER_VALG_RE.search(entry)
        ret, noter, stor = _split_entry(_FRYSER_VALG_RE.sub(" ", entry) if fv else entry)
        ud.append(Linje(i, blok, overskrift, Dag(dato=d, raw=entry, ret=ret, noter=noter, stor_portion=stor, uge=week,
                                                fryser_valg=(fv.group(1).strip() or None) if fv else None)))
    return ud


def vindere(linjer: list[Linje]) -> dict[date, Linje]:
    """Den linje, parse_madplan bruger for hver dato (samme regel: senest startende blok vinder,
    tomme dage overskriver ikke; ved samme startdato vinder den nederste)."""
    blokke: dict[int, list[Linje]] = {}
    for ln in linjer:
        blokke.setdefault(ln.blok, []).append(ln)
    orden = sorted(blokke.values(), key=lambda b: b[0].dag.dato)
    res: dict[date, Linje] = {}
    for b in orden:
        for ln in b:
            if ln.dag.ret or ln.dag.dato not in res:
                res[ln.dag.dato] = ln
    return res


def overlap(text: str, today: date) -> list[dict]:
    """Datoer, der står forskelligt i to eller flere uger (0.13.0, kun til advarsel):
    kun den ene linje bruges – de andre tæller ingen steder. Teksten ændres ikke."""
    linjer = scan_linjer(text, today)
    vind = vindere(linjer)
    pr_dato: dict[date, list[Linje]] = {}
    for ln in linjer:
        if ln.dag.raw.strip():
            pr_dato.setdefault(ln.dag.dato, []).append(ln)
    ud = []
    for d in sorted(pr_dato, reverse=True):
        v = vind.get(d)
        skjulte = [ln for ln in pr_dato[d] if v is None or (ln.idx != v.idx and ln.dag.raw.strip() != v.dag.raw.strip())]
        if not skjulte or v is None:
            continue
        ud.append({
            "dato": d.isoformat(), "ugedag": UGEDAGE[d.weekday()],
            "vises": {"tekst": v.dag.raw.strip(), "uge": v.overskrift, "linje": v.idx},
            "skjult": [{"tekst": ln.dag.raw.strip(), "uge": ln.overskrift, "linje": ln.idx} for ln in skjulte],
        })
    return ud


def flet3(base: str, mine: str, deres: str) -> tuple[str | None, list[str]]:
    """Trevejsfletning linje for linje (0.13.0): ændringer på forskellige linjer flettes;
    er samme linjer ændret forskelligt begge steder, returneres (None, [konfliktlinjer])."""
    from difflib import SequenceMatcher

    b, m, t = base.split("\n"), mine.split("\n"), deres.split("\n")

    def hunks(ny: list[str]) -> list[tuple[int, int, list[str]]]:
        return [(i1, i2, ny[j1:j2]) for tag, i1, i2, j1, j2 in SequenceMatcher(None, b, ny, autojunk=False).get_opcodes()
                if tag != "equal"]

    alle = sorted([(h, 0) for h in hunks(m)] + [(h, 1) for h in hunks(t)], key=lambda x: (x[0][0], x[0][1]))

    def overlapper(a: tuple, c: tuple) -> bool:
        a1, a2, c1, c2 = a[0], a[1], c[0], c[1]
        if a1 == a2 and c1 == c2:
            return a1 == c1
        if a1 == a2:
            return c1 < a1 < c2
        if c1 == c2:
            return a1 < c1 < a2
        return a1 < c2 and c1 < a2

    grupper: list[list[tuple]] = []
    for h in alle:
        if grupper and any(overlapper(h[0], g[0]) for g in grupper[-1]):
            grupper[-1].append(h)
        else:
            grupper.append([h])
    ud: list[str] = []
    pos = 0
    konflikter: list[str] = []
    for g in grupper:
        lo = min(h[0][0] for h in g)
        hi = max(h[0][1] for h in g)
        ud.extend(b[pos:lo])
        sider = {h[1] for h in g}
        if len(sider) == 1:
            # kun den ene side har ændret her
            cur = lo
            for (i1, i2, ny), _s in sorted(g, key=lambda x: x[0][0]):
                ud.extend(b[cur:i1])
                ud.extend(ny)
                cur = i2
            ud.extend(b[cur:hi])
        else:
            def version(side: int) -> list[str]:
                res, cur = [], lo
                for (i1, i2, ny), s in sorted(g, key=lambda x: x[0][0]):
                    if s != side:
                        continue
                    res.extend(b[cur:i1])
                    res.extend(ny)
                    cur = i2
                res.extend(b[cur:hi])
                return res
            vm, vt = version(0), version(1)
            if vm == vt:
                ud.extend(vm)
            else:
                konflikter.extend([x for x in (vm + vt) if x.strip()][:6] or ["(tomme linjer)"])
        pos = hi
    ud.extend(b[pos:])
    if konflikter:
        return None, konflikter
    return "\n".join(ud), []


_DISH_STRIP_RE = re.compile(
    r"\(\s*❄[^()]*\)|\(?\s*(husk\s+)?(stor|dobbelt)\s+portion\s*\)?|\bx\s*2\b|\(\s*\)|\?+$", re.IGNORECASE
)


def dish_key(ret: str) -> str:
    """Nøgle til at genkende samme ret på tværs af uger: "Lasagne stor portion" -> "lasagne"."""
    s = _DISH_STRIP_RE.sub(" ", (ret or "").lower())
    s = re.sub(r"\s+", " ", s).strip(" .,-–")
    return s


def retter(madplan: dict[date, Dag], today: date, rest_ord: list[str] | None = None) -> list[dict]:
    """Retter fra hele madplanen med antal gange og hvornår de sidst var på planen.

    Rester ("... rest", "rester fra søndag") tæller ikke som en ret for sig, men
    lægges til den ret de er rester af, hvis den kan genkendes.
    """
    rest = rest_ord if rest_ord is not None else DEFAULT_REST_ORD
    rest_re = re.compile(r"\b(" + "|".join(re.escape(r.lower()) for r in rest) + r")\b", re.IGNORECASE)
    out: dict[str, dict] = {}
    for d in sorted(madplan):
        dag = madplan[d]
        if not dag.ret or d > today:
            continue
        key = dish_key(dag.ret)
        if not key:
            continue
        is_rest = bool(rest_re.search(dag.ret))
        if is_rest:
            # "kylling i karry rest" -> tæl som "kylling i karry", ellers spring over
            base = dish_key(rest_re.sub(" ", dag.ret))
            base = re.sub(r"\b(fra|af)\s*$", "", base).strip(" .,-–")
            if base in out:
                out[base]["rest_gange"] += 1
            continue
        it = out.setdefault(key, {"navn": dag.ret, "key": key, "antal": 0, "rest_gange": 0, "sidst": None, "datoer": []})
        it["antal"] += 1
        it["sidst"] = d.isoformat()
        it["navn"] = dag.ret  # nyeste stavemåde vinder
        it["datoer"].append(d.isoformat())
    result = []
    for it in out.values():
        last = date.fromisoformat(it["sidst"])
        it["dage_siden"] = (today - last).days
        it["datoer"] = it["datoer"][-6:]
        result.append(it)
    result.sort(key=lambda x: (-x["antal"], x["dage_siden"]))
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

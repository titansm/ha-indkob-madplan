"""ReciMe-opskrifter som retter i ugeplanlæggeren (0.14.0).

Planlæggeren kender jeres egne retter fra madplanen. Herfra får den også opskrifterne fra
ReciMe – men kun dem, der ligner noget, I allerede spiser:

1. Kun aftensmad (kogebøgerne Aftensmad, Pasta, Fisk, BBQ, Suppe, Tærter) med en indkøbsliste;
   ikke salater, tilbehør, babymad, bagning, dips og desserter.
2. Hver opskrift får type (familie), kød, tilbehør, sværhed og sæson ud fra titel og ingredienser.
3. Den skal minde om en af jeres egne retter (samme familie, ellers samme kød + tilbehør) – det er
   den, der står i "Minder om …".
4. Børnevenlig: ikke for stærk og ikke for meget grønt. Champignon trækker op.
5. Opskrifter, der i forvejen *er* en af jeres retter (fx "Kylling i karry", eller koblet til en egen
   ret under Retter), er ikke nye.

Ren Python uden Home Assistant – kan testes isoleret.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from . import opskrifter as op
from . import planner as pl
from . import saeson as sae
from .madplan import dish_key

# Kogebøger med aftensmad (resten er salater, tilbehør, babymad, bagning, dips …)
AFTENSMAD = {"Aftensmad", "Pasta", "Fisk", "BBQ", "Suppe", "Tærter"}
# Kogebøger, der aldrig er aftensmad – heller ikke i søgningen
IKKE_MAD = {"Babymad", "Bagning", "Desserter", "Morgenmad", "Dressing & Dips"}

# --------------------------------------------------------------------------- navn
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF‍️⬆-⬇←-⇿]+"
)
_PAREN_RE = re.compile(r"\s*\((?:[^)]*\b(?:recipe|opskrift|favorite|favourite)\b[^)]*)\)", re.IGNORECASE)
_ALLE_PAREN_RE = re.compile(r"\s*\([^)]*\)")
_HALE_RE = re.compile(r"\s+(?:recipe|opskrift|method)\s*$", re.IGNORECASE)
_GENERISK_FOER_KOLON = re.compile(r"weeknight|dinner|recipe|opskrift|aftensmad", re.IGNORECASE)
MAKS_NAVN = 56
_HALEORD = {"with", "and", "og", "med", "w", "a", "the", "i", "", "of", "in"}


def kort_titel(titel: str) -> str:
    """Opskriftens titel som en ret i madplanen: uden emojis, råb og hale.

    "DRUNKEN NOODLES 🥢🇹🇭 One of my most viewed recipes …" -> "Drunken noodles"
    "Weeknight Dinners: Gojuchang Beef Roast"            -> "Gojuchang Beef Roast"
    "Loco Moco (My Favorite Recipe)"                     -> "Loco Moco"
    """
    t = (titel or "").strip()
    # Et emoji midt i en lang titel skiller ofte navnet fra en reklametekst
    dele = [d.strip() for d in _EMOJI_RE.split(t) if d.strip()]
    if len(dele) > 1 and len(dele[0]) >= 4:
        t = dele[0]
    else:
        t = " ".join(dele)
    t = op.paen_titel(t)
    if ":" in t:
        foer, efter = (x.strip() for x in t.split(":", 1))
        if _GENERISK_FOER_KOLON.search(foer) and len(efter.split()) >= 2:
            t = efter
        else:
            t = foer
    t = re.split(r"…|\.\s|!|\?", t)[0]
    # " – med ekstra grøntsager": madplanen deler en linje ved " - " (noter foran retten), så det skal væk
    foerste = re.split(r"\s[-–—]\s", t)[0]
    t = foerste if len(foerste.split()) >= 2 else re.sub(r"\s[-–—]\s", " ", t)
    t = _PAREN_RE.sub("", t)
    t = re.sub(r"\s*\b(?:recipe|opskrift)\b", "", t, flags=re.IGNORECASE)
    if len(t) > 28:  # lange titler: "(Skewers or Patties)", "(with Grilled Chicken)" ud
        uden = _ALLE_PAREN_RE.sub("", t).strip()
        if len(uden.split()) >= 2:
            t = uden
    t = _HALE_RE.sub("", t)
    t = re.sub(r"\s+", " ", t).strip(" -–—,.;")
    if len(t) > MAKS_NAVN:
        venstre = t.split(", ")[0]
        t = venstre if len(venstre.split()) >= 3 and len(venstre) <= MAKS_NAVN else t[:MAKS_NAVN].rsplit(" ", 1)[0]
        ord_ = t.split()
        while len(ord_) > 2 and ord_[-1].lower().strip(",&/") in _HALEORD:
            ord_.pop()
        t = " ".join(ord_).rstrip(" ,-–&")
    t = op.paen_titel(t)
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    return t


def _ascii(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


# --------------------------------------------------------------------------- nøgleord
def _rx(*ord_: str) -> re.Pattern:
    return re.compile(r"(?<![a-zæøå])(?:" + "|".join(ord_) + r")", re.IGNORECASE)


PROTEIN_ORD: list[tuple[str, re.Pattern, float]] = [
    ("kylling", _rx("chicken", "kylling", "kyllinge", "kalkun", "turkey"), 1.0),
    ("fisk", _rx("salmon", "laks", "\\bcod\\b", "torsk", "fish(?! sauce)", "fisk(?!esauce)", "shrimp(?! paste)",
                 "prawn", "rejer", "tuna", "tun\\b", "sea bass", "bream", "orata", "havaborre", "dorade"), 1.0),
    ("okse", _rx("beef", "steak", "okse", "chuck", "lamb", "\\blam\\b", "tykkam", "bøf", "hakket oksekød"), 1.0),
    ("svin", _rx("pork", "svin", "gris", "flæsk", "nakke", "kotelet", "pølse", "sausage", "prosciutto", "skinke"), 1.0),
    ("svin", _rx("bacon", "pancetta", "guanciale"), 0.4),
]
# Titlen vægter mest (fx "Chicken …" med lidt bacon er kylling)
TITEL_VAEGT = 2.5

BASE_ORD: list[tuple[str, re.Pattern]] = [
    ("suppe", re.compile(r"soup|suppe|gomtang", re.IGNORECASE)),
    ("nudler", _rx("noodle", "nudler", "udon", "ramen", "soba", "chow mein", "pad thai", "pad see ew")),
    ("pasta", _rx("pasta", "spaghetti", "orzo", "lasagn", "tortell", "orecchiette", "ditalini", "penne",
                  "paccheri", "macaroni", "rigatoni", "tagliatelle", "fusilli")),
    ("brød", _rx("tortilla", "pita", "\\bbreads?\\b(?! ?crumb)", "brioche", "\\bbuns?\\b", "wrap", "flatbread", "fladbrød", "taco",
                 "sandwich", "burger", "fladbrød", "naan")),
    ("ris", _rx("\\brice\\b", "\\bris\\b", "jasmin", "basmati", "risotto", "fried rice")),
    ("kartofler", _rx("potato", "kartof", "mash", "gratin", "parmentier", "shepherd")),
]

# Familier (samme navne som planlæggerens egne retter, så variationen virker på tværs)
FAM_ORD: list[tuple[str, re.Pattern]] = [
    ("lasagne", _rx("lasagn")),
    ("kodboller", _rx("meatball", "kødbolle", "keftedes", "albóndigas", "albondigas")),
    ("mexi", _rx("taco", "tortilla", "burrito", "quesadilla", "chipotle", "nacho", "fajita", "crunch pocket")),
    ("schnitzel", _rx("schnitzel", "katsu", "tonkatsu", "chicken parmesan", "parmesan chicken", "fried chicken",
                      "nugget")),
    ("burger", _rx("burger", "sandwich", "loco moco", "loko moko")),
    ("pita", _rx("gyros", "souvlaki", "kofta", "kafta", "köfte", "kofte", "kebab", "kabob", "arayes", "shawarma",
                 "pita")),
    ("karry", _rx("curry", "karry", "\\bdal\\b", "dahl", "tikka", "masala", "butter chicken")),
    ("wok", _rx("stir.?fry", "noodle", "nudler", "pad thai", "pad see ew", "ramen", "udon", "chow mein", "drunken")),
    ("asiat", _rx("fried rice", "nasi", "rice bowl", "gochujang", "gojuchang", "satay", "teriyaki", "bibimbap",
                  "rice roll", "dumpling")),
    ("bowl", _rx("\\bbowls?\\b")),
    ("taerte", re.compile(r"\bpie\b|tærte|quiche|tatin", re.IGNORECASE)),
    ("suppe", re.compile(r"soup|suppe|gomtang", re.IGNORECASE)),
    ("kartoffelfad", _rx("shepherd", "parmentier", "gratin", "kartoffelfad", "moussaka")),
    ("kylling", _rx("roast chicken", "roasted chicken", "hel kylling", "whole chicken")),
    ("gryde", _rx("stew", "braised", "bourguignon", "gryde", "chuck roast", "beef roast", "i fad", "cabbage roll")),
    ("pasta", _rx("pasta", "spaghetti", "orzo", "carbonara", "tortell", "orecchiette", "alfredo")),
]

# Børnevenligt: meget grønt eller stærkt trækker ned (Carlo er kræsen med grønt, elsker champignon)
GROENT = _rx("spinach", "spinat", "\\bkale\\b", "grønkål", "cavolo", "broccoli", "zucchini", "courgette",
             "squash", "eggplant", "aubergine", "asparagus", "asparges", "\\bleeks?\\b", "porre", "cabbage",
             "spidskål", "\\bkål\\b", "green beans", "bok choy", "pak choi", "celery", "selleri", "fennel",
             "cauliflower", "blomkål", "artichoke", "arugula", "rucola", "kimchi", "chard", "brussels")
STAERK = _rx("jalape", "gochujang", "gojuchang", "sriracha", "chili oil", "chilli oil", "chili crisp",
             "hot sauce", "cayenne", "sambal", "curry paste", "birds? eye", "green chil", "harissa", "spicy",
             "chipotle", "\\bred chil", "chil+i powder", "\\bchil+i\\b(?! flakes)", "chil+ies")
STAERK_LET = _rx("chil+i flakes", "red pepper flakes", "aleppo", "pul biber")
GODT = _rx("champignon", "mushroom", "svampe", "cocktailpølse", "parmesan", "mozzarella", "cheddar")

LET_TITEL = _rx("one.?pot", "one.?pan", "easy", "quick", "minute", "nemme?", "weeknight", "15 min", "20 min",
                "30 min")
SVAER_TITEL = _rx("slow", "braised", "bourguignon", "lasagn", "\\bpie\\b", "roast", "pie", "parmentier",
                  "shepherd", "tærte")
SALAT = re.compile(r"salad|salat|slaw", re.IGNORECASE)
# Uden kød kun som suppe, pasta eller karry/dal (ikke kartoffeltilbehør, tærter med grønt …)
VEGETAR_FAM = {"suppe", "pasta", "karry"}
KIDS_MIN = 0.6
# Næsten samme navn som en af jeres retter (begge veje) = det er jeres ret, ikke en ny
SAMME_RET = 0.6


@dataclass
class OpskriftRet:
    """En opskrift set som en ret: egenskaber som planlæggerens egne retter + hvor den kommer fra."""

    rid: str  # "r:<id>"
    navn: str  # kort_titel
    titel: str  # opskriftens egen titel (pæn)
    kogeboger: list[str]
    fam: str
    protein: str
    base: str
    effort: int
    stor: bool
    kids: float  # 0–1: 1 = børnevenlig
    groent: float
    staerk: float
    aftensmad: bool  # i en aftensmads-kogebog, har varer og er ikke en salat/et tilbehør
    saeson: sae.Saeson | None = None
    grunde_ud: list[str] = field(default_factory=list)  # hvorfor den ikke kan være ny (til test/forklaring)

    def egenskaber(self) -> dict:
        """Som `planner.egenskaber()` – så variationen (kød, tilbehør, familie) virker."""
        return {"fam": self.fam, "protein": self.protein, "base": self.base, "effort": self.effort,
                "stor": self.stor, "varer": [], "kids": self.kids, "opskrift": self.rid}


def _tekst(r: dict) -> str:
    dele = []
    for ln in r.get("linjer") or []:
        dele += [ln.get("prod") or "", ln.get("rp") or "", ln.get("raw") or ""]
    return " ".join(d for d in dele if d).lower()


def _linjer_tekst(r: dict) -> list[str]:
    return [" ".join(x for x in (ln.get("prod"), ln.get("rp"), ln.get("raw")) if x).lower()
            for ln in r.get("linjer") or []]


_IKKE_KOED = re.compile(r"stock|broth|bouillon|fond|fish sauce|fiskesauce|oyster sauce|østerssauce|shrimp paste")


def _protein(titel: str, linjer: list[str]) -> str:
    score: dict[str, float] = {}
    for navn, rx, w in PROTEIN_ORD:
        if rx.search(titel):
            score[navn] = score.get(navn, 0) + TITEL_VAEGT * w
        n = sum(1 for ln in linjer if rx.search(ln) and not _IKKE_KOED.search(ln))
        if n:
            score[navn] = score.get(navn, 0) + min(n, 2) * w
    if not score:
        return "vegetar"
    # Lige stemmer: det kød, der står først i titlen (ellers rækkefølgen ovenfor)
    def foerst(navn: str) -> int:
        pos = [m.start() for n, rx, _ in PROTEIN_ORD if n == navn for m in [rx.search(titel)] if m]
        return min(pos) if pos else 999
    return max(score.items(), key=lambda kv: (kv[1], -foerst(kv[0])))[0]


def _base(titel: str, tekst: str) -> str:
    for navn, rx in BASE_ORD:
        if rx.search(titel):
            return navn
    for navn, rx in BASE_ORD:
        if navn != "suppe" and rx.search(tekst):
            return navn
    return "andet"


def _fam(titel: str, protein: str, base: str) -> str | None:
    for navn, rx in FAM_ORD:
        if rx.search(titel):
            return navn
    if protein == "fisk":
        return "fisk"
    if base in ("pasta",):
        return "pasta"
    return None


def _effort(r: dict, titel: str) -> int:
    total = (r.get("tid") or {}).get("total") or 0
    if total:
        return 1 if total <= 30 else (2 if total <= 75 else 3)
    if LET_TITEL.search(titel):
        return 1
    if SVAER_TITEL.search(titel):
        return 3
    return 2


def _saeson(titel: str, kogeboger: list[str]) -> sae.Saeson | None:
    """Sæson for opskriften: de faste regler på en dansk "oversættelse" af titlen."""
    low = titel.lower()
    ekstra = []
    if re.search(r"soup|gomtang", low):
        ekstra.append("suppe")
    if re.search(r"pumpkin|butternut|squash", low):
        ekstra.append("græskar")
    if re.search(r"asparagus", low):
        ekstra.append("asparges")
    if "BBQ" in kogeboger or re.search(r"\bbbq\b|barbecue|rotisserie", low):
        ekstra.append("grill")
    if re.search(r"\bstew\b|bourguignon|goulash", low):
        ekstra.append("stuvning")
    return sae.regel_saeson(" ".join([titel] + ekstra))


def klassificer(raa: list[dict], varer_antal: dict[str, int]) -> dict[str, OpskriftRet]:
    """Alle opskrifter som retter (nøgle = kort navn). `varer_antal`: opskrift-id -> antal varer."""
    ud: dict[str, OpskriftRet] = {}
    for r in raa:
        titel = op.paen_titel(r.get("titel") or "")
        navn = kort_titel(r.get("titel") or "")
        if not navn or len(navn) < 3:
            continue
        kb = list(r.get("kogeboger") or [])
        low_t = _ascii(titel.lower())
        linjer = [_ascii(x) for x in _linjer_tekst(r)]
        tekst = " ".join(linjer)
        protein = _protein(low_t, linjer)
        base = _base(low_t, tekst)
        fam = _fam(low_t, protein, base)
        groent = float(sum(1 for ln in linjer if GROENT.search(ln)))
        staerk = sum(1.0 for ln in linjer if STAERK.search(ln)) + 0.5 * sum(
            1 for ln in linjer if STAERK_LET.search(ln) and not STAERK.search(ln))
        if STAERK.search(low_t):
            staerk += 1
        kids = (0.85 ** groent) * (0.7 ** staerk) * (1.1 if GODT.search(tekst) else 1.0)
        kids = max(0.0, min(1.0, kids))
        effort = _effort(r, low_t)
        stor = fam in ("lasagne", "gryde", "suppe", "karry", "taerte", "kartoffelfad") or (r.get("portioner") or 0) >= 6
        n_varer = varer_antal.get(r["id"], 0)
        grunde_ud = []
        if not set(kb) & AFTENSMAD:
            grunde_ud.append("ikke en aftensmads-kogebog")
        if n_varer < 3:
            grunde_ud.append("ingen indkøbsliste")
        if SALAT.search(low_t):
            grunde_ud.append("salat")
        if protein == "vegetar" and fam not in VEGETAR_FAM:
            grunde_ud.append("tilbehør/uden kød")
        if "Frokost & sandwiches" in kb:
            grunde_ud.append("frokost")
        if kids < KIDS_MIN:
            grunde_ud.append("ikke børnevenlig nok")
        if groent >= 3:
            grunde_ud.append("meget grønt")
        if staerk >= 2:
            grunde_ud.append("stærk")
        ret = OpskriftRet(
            rid="r:" + r["id"], navn=navn, titel=titel, kogeboger=kb,
            fam=fam or (dish_key(navn) or navn.lower()), protein=protein, base=base, effort=effort, stor=stor,
            kids=round(kids, 3), groent=groent, staerk=staerk, aftensmad=not grunde_ud,
            saeson=_saeson(titel, kb), grunde_ud=grunde_ud,
        )
        # Samme korte navn to gange (fx to udgaver af samme opskrift): den med flest varer
        if navn in ud and varer_antal.get(ud[navn].rid[2:], 0) >= n_varer:
            continue
        ud[navn] = ret
    return ud


def ligner_egen(o: OpskriftRet, profiler: dict) -> str | None:
    """Den af jeres egne retter, opskriften minder mest om (samme familie, ellers samme kød og tilbehør)."""
    bedst, bedst_v = None, 0.0
    for navn, p in profiler.items():
        eg = pl.egenskaber(navn)
        if eg.get("fyld"):
            continue
        if eg["fam"] == o.fam:
            v = 100.0 + p.vaegt  # samme familie vinder altid
        elif eg["protein"] == o.protein and eg["base"] == o.base and o.protein != "vegetar":
            v = 1.0 + p.vaegt
        else:
            continue
        if v > bedst_v:
            bedst, bedst_v = navn, v
    return bedst


def nye_retter(alle: dict[str, OpskriftRet], profiler: dict, *, koblede: set[str] | None = None,
               skjulte: set[str] | None = None) -> list[dict]:
    """Opskrifter, der kan foreslås som nye retter – i samme form som planlæggerens `NYE`.

    Udelades: ikke aftensmad/børnevenlig (se `klassificer`), allerede en af jeres retter (samme navn,
    genkendt som en af jeres retter med næsten samme navn, eller koblet til en egen ret under Retter),
    skjult ("Foreslå ikke igen"), eller ligner ingen af jeres retter.
    """
    koblede = koblede or set()
    skjulte = {s.lower() for s in (skjulte or set())}
    egne_noegler = {dish_key(n) for n in profiler}
    ud = []
    for navn, o in alle.items():
        if not o.aftensmad or o.rid in koblede or navn.lower() in skjulte:
            continue
        if dish_key(navn) in egne_noegler:
            continue
        kanon = pl.kanonisk(navn)
        if kanon and (dish_key(kanon) == dish_key(navn) or op.ligner(navn, kanon) >= SAMME_RET
                      or op.ligner(kanon, navn) >= SAMME_RET):
            continue  # "Kylling i karry", "Classic Beef Lasagne" … er jeres egne retter
        lig = kanon if kanon in profiler else ligner_egen(o, profiler)
        if not lig:
            continue
        ud.append({"navn": navn, "ligner": lig, **o.egenskaber()})
    return ud

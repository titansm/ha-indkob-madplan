"""Opskriftsbank: importerede opskrifter -> danske indkøbslister i metriske enheder.

Opskrifterne gemmes rå (som de kom fra ReciMe) i HA's eget lager og omregnes her efter
indstillingerne under Indstillinger → Omregning. Ændres en indstilling, omregnes alle
opskrifter igen; jeres egne rettelser af en rets varer bevares.

Ingen AI og ingen netværkskald – regler + ordbog (navne.py). Ren Python uden HA-afhængigheder.

Importformat (tekst, én linje pr. opskrift/ingrediens):
    R|id|titel|kogebøger(;)|portioner|forb|tilb|total|køkken|billed-id|kilde|antal_trin
    -mængde|enhed|vare(en)|rå_vare|rå_tekst
"""
from __future__ import annotations

import math
import re
from collections import OrderedDict
from functools import lru_cache
from typing import Any

from . import kategorier
from . import saeson as sae
from .navne import (
    ALTID, DK_TEKST, FAMILIE_KOED_G, FAMILIE_PORTIONER, IKKE_VARE, IKKE_VARE2, KOED, KOED_STK_G, NAVNE,
    SPRING_OVER, TOERRET, VAESKER,
)

# --------------------------------------------------------------------------- indstillinger
STANDARD: dict[str, Any] = {
    "skaler": True,          # skalér opskrifterne til familiens portion
    "koed_g": FAMILIE_KOED_G,  # kød pr. aftensmad
    "portioner": FAMILIE_PORTIONER,  # portioner, når kød ikke er hovedingrediensen
    "koed_taerskel": 75,     # g kød pr. portion, før kødet styrer skaleringen
    "faktor_min": 0.5,
    "faktor_max": 3.0,
    "cup_dl": 2.37,          # 1 cup
    "pint_dl": 4.73,         # 1 pint
    "lb_g": 454,             # 1 pound
    "oz_g": 28.35,           # 1 ounce (fast)
    "floz_ml": 29.57,        # 1 fl oz (væske)
    "inch_cm": 2.54,
    "stick_g": 113,          # amerikansk smørstang
    "skeer": "tsk_spsk",     # "tsk_spsk" = behold, "ml" = omregn (tsk 5 ml, spsk 15 ml)
    "afrund": True,          # rund mængderne af til noget man kan købe/måle
    "har_vi_altid": sorted(ALTID, key=str.lower),
    "stk_vaegt": dict(KOED_STK_G),  # kød i stk -> gram pr. stk (til skalering)
    "navne": {},             # egne varenavne: {"Fra": "Til"}
}

_TAL = {
    "koed_g": (50, 3000), "portioner": (1, 20), "koed_taerskel": (10, 500), "faktor_min": (0.1, 1),
    "faktor_max": (1, 10), "cup_dl": (1, 5), "pint_dl": (2, 10), "lb_g": (300, 600), "oz_g": (20, 40),
    "floz_ml": (20, 40), "inch_cm": (1, 5), "stick_g": (50, 250),
}

LABELS = {
    "skaler": "Skalér opskrifterne", "koed_g": "Kød pr. aftensmad", "portioner": "Portioner uden kød",
    "koed_taerskel": "Kød styrer fra", "faktor_min": "Skalér mindst", "faktor_max": "Skalér højst",
    "cup_dl": "1 cup", "pint_dl": "1 pint", "lb_g": "1 pound", "oz_g": "1 ounce", "floz_ml": "1 fl oz",
    "inch_cm": "1 inch", "stick_g": "1 stick smør", "skeer": "Tsk og spsk", "afrund": "Afrund mængder",
    "har_vi_altid": "Har vi altid", "stk_vaegt": "Vægt pr. stk", "navne": "Egne varenavne",
}


def rens_omregning(changes: dict[str, Any]) -> dict[str, Any]:
    """Validér ændringer fra panelet. ValueError ved ugyldige værdier."""
    out: dict[str, Any] = {}
    for k, v in changes.items():
        if k not in STANDARD:
            raise ValueError(f"Ukendt indstilling: {k}")
        if k in _TAL:
            try:
                v = float(str(v).replace(",", "."))
            except ValueError as err:
                raise ValueError(f"{LABELS[k]}: ikke et tal") from err
            lo, hi = _TAL[k]
            if not lo <= v <= hi:
                raise ValueError(f"{LABELS[k]} skal være mellem {lo:g} og {hi:g}")
            if k in ("koed_g", "portioner", "koed_taerskel", "lb_g", "stick_g"):
                v = int(round(v))
        elif k in ("skaler", "afrund"):
            v = bool(v)
        elif k == "skeer":
            if v not in ("tsk_spsk", "ml"):
                raise ValueError("Tsk og spsk: ugyldigt valg")
        elif k == "har_vi_altid":
            if isinstance(v, str):
                v = re.split(r"[,\n]", v)
            seen: dict[str, str] = {}
            for x in v:
                x = str(x).strip()
                if x:
                    seen.setdefault(x.lower(), x[:1].upper() + x[1:])
            v = sorted(seen.values(), key=str.lower)
        elif k in ("stk_vaegt", "navne"):
            v = _par(v, tal=k == "stk_vaegt")
        out[k] = v
    if out.get("faktor_min", 0) > out.get("faktor_max", 99):
        raise ValueError("Skalér mindst skal være mindre end højst")
    return out


def _par(v: Any, *, tal: bool) -> dict[str, Any]:
    """"Kyllingebryst = 150" pr. linje (eller en dict) -> {"Kyllingebryst": 150}."""
    if isinstance(v, dict):
        items = list(v.items())
    else:
        items = []
        for line in str(v or "").splitlines():
            if not line.strip():
                continue
            m = re.match(r"^\s*(.+?)\s*(?:=|→|->|:)\s*(.+?)\s*$", line)
            if not m:
                raise ValueError(f'Forstår ikke "{line.strip()}" – skriv "navn = {"gram" if tal else "nyt navn"}"')
            items.append((m.group(1), m.group(2)))
    out: dict[str, Any] = {}
    for a, b in items:
        a = str(a).strip()
        a = a[:1].upper() + a[1:]
        if not a:
            continue
        if tal:
            try:
                n = float(re.sub(r"\s*g$", "", str(b).strip()).replace(",", "."))
            except ValueError as err:
                raise ValueError(f'"{a}": vægten skal være et tal i gram') from err
            if not 1 <= n <= 5000:
                raise ValueError(f'"{a}": vægten skal være mellem 1 og 5000 g')
            out[a] = int(round(n))
        else:
            b = str(b).strip()
            if b:
                out[a] = b[:1].upper() + b[1:]
    return out


# --------------------------------------------------------------------------- import
def tal(s: str) -> float | None:
    s = (s or "").strip().replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def laes_raa(tekst: str) -> list[dict]:
    """Importtekst -> rå opskrifter."""
    opsk: list[dict] = []
    cur: dict | None = None
    for line in (tekst or "").splitlines():
        if line.startswith("R|"):
            f = line.split("|")
            f += [""] * (12 - len(f))
            if not f[1].strip() or not f[2].strip():
                cur = None
                continue
            cur = {
                "id": f[1].strip(), "titel": f[2].strip(), "kogeboger": [s for s in f[3].split(";") if s],
                "portioner": int(tal(f[4]) or 0) or None,
                "tid": {"forb": int(tal(f[5]) or 0), "tilb": int(tal(f[6]) or 0), "total": int(tal(f[7]) or 0)},
                "kokken": f[8] or None, "billede": f[9] or None, "kilde": f[10] or None,
                "trin": int(tal(f[11]) or 0), "linjer": [],
            }
            opsk.append(cur)
        elif line.startswith("-") and cur is not None:
            f = line[1:].split("|")
            f += [""] * (5 - len(f))
            cur["linjer"].append({"qty": tal(f[0]), "unit": f[1], "prod": f[2], "rp": f[3], "raw": "|".join(f[4:]).strip()})
    # samme opskrift i flere kogebøger -> én
    unik: "OrderedDict[str, dict]" = OrderedDict()
    for o in opsk:
        if o["id"] in unik:
            for kb in o["kogeboger"]:
                if kb not in unik[o["id"]]["kogeboger"]:
                    unik[o["id"]]["kogeboger"].append(kb)
        else:
            unik[o["id"]] = o
    return list(unik.values())


# --------------------------------------------------------------------------- omregning
DK_ENHED = {  # fritekst
    "g": "g", "gr": "g", "gram": "g", "kg": "kg", "dl": "dl", "l": "l", "liter": "l", "ml": "ml",
    "spsk": "spsk", "tsk": "tsk", "fed": "fed", "stk": "stk", "stk.": "stk", "bdt": "bundt",
    "bundt": "bundt", "dåse": "dåse", "dåser": "dåse", "knivspids": "knivspids",
    "håndfuld": "håndfuld", "skiver": "skive", "skive": "skive", "flaske": "flaske",
    "pakke": "pakke", "ps": "pakke", "glas": "glas", "kvist": "kvist", "kviste": "kvist",
    "stilk": "stilk", "stilke": "stilk", "blade": "blad", "blad": "blad", "ds": "dåse",
    "brev": "pakke", "håndfulde": "håndfuld",
    "cup": "cup", "cups": "cup", "tablesp.": "spsk", "tablespoon": "spsk", "tablespoons": "spsk",
    "tbsp": "spsk", "teasp.": "tsk", "teaspoon": "tsk", "teaspoons": "tsk", "tsp": "tsk",
    "can": "dåse", "cans": "dåse", "el": "spsk", "tl": "tsk", "pieces": "stk", "piece": "stk",
    "x": "stk", "grams": "g", "teskefuld": "tsk", "teskefulde": "tsk", "spiseskefuld": "spsk",
    "spiseskefulde": "spsk", "deciliter": "dl", "stængler": "stilk", "tsk.": "tsk",
    "spsk.": "spsk", "lille": "stk", "små": "stk",
}
HEL_ENHED = {"bundt", "håndfuld", "flaske", "dåse", "pakke", "glas", "blok"}
# Enheder der står på indkøbslisten (resten – tsk, fed … – er kun til madlavningen)
LISTE_ENHED = {"g", "kg", "ml", "dl", "l", "stk", "dåse", "glas", "pakke", "flaske", "bundt", "blok"}


def _enheder(o: dict) -> dict[str, tuple[str, float]]:
    return {
        "g": ("g", 1), "kg": ("kg", 1), "ml": ("ml", 1), "dl": ("dl", 1), "litre": ("l", 1), "cm": ("cm", 1),
        "tbsp": ("spsk", 1), "tsp": ("tsk", 1),
        "cup": ("dl", o["cup_dl"]), "pint": ("dl", o["pint_dl"]),
        "pound": ("g", o["lb_g"]), "inch": ("cm", o["inch_cm"]), "thumb": ("cm", 3),
        "clove": ("fed", 1), "can": ("dåse", 1), "tin": ("dåse", 1), "jar": ("glas", 1),
        "bunch": ("bundt", 1), "handful": ("håndfuld", 1), "pinch": ("knivspids", 1),
        "head": ("stk", 1), "stalk": ("stilk", 1), "sprig": ("kvist", 1), "slice": ("skive", 1),
        "sheet": ("stk", 1), "piece": ("stk", 1), "pack": ("pakke", 1), "packet": ("pakke", 1),
        "bottle": ("flaske", 1), "leaf": ("blad", 1), "block": ("blok", 1),
        "dash": ("skvæt", 1), "splash": ("skvæt", 1), "drizzle": ("skvæt", 1), "knob": ("g", 15),
        "stick": ("g", o["stick_g"]),
    }


def _omregn(qty: float | None, unit: str, vare_en: str, o: dict, enh: dict) -> tuple[float | None, str]:
    if not unit:
        return qty, "stk" if qty is not None else ""
    if unit == "ounce":
        if vare_en in VAESKER:
            return (qty * o["floz_ml"] if qty is not None else None), "ml"
        return (qty * o["oz_g"] if qty is not None else None), "g"
    dk, f = enh.get(unit, (unit, 1))
    return (qty * f if qty is not None else None), dk


def paen(qty: float | None, enhed: str, afrund: bool = True) -> float | None:
    """Afrund til noget man kan købe/måle."""
    if qty is None:
        return None
    if not afrund:
        return round(qty, 2) if qty > 0 else None
    if enhed == "g":
        if qty >= 1000:
            return round(qty / 50) * 50
        if qty >= 100:
            return round(qty / 25) * 25
        if qty >= 20:
            return round(qty / 5) * 5
        return max(1, round(qty))
    if enhed == "ml":
        return round(qty / 25) * 25 if qty >= 100 else max(5, round(qty / 5) * 5)
    if enhed in ("dl", "spsk", "tsk", "l", "kg"):
        return max(0.25, round(qty * 4) / 4) if qty < 2 else round(qty * 2) / 2
    if enhed == "cm":
        return max(1, round(qty))
    if qty <= 0:
        return None
    if qty < 1:
        return 0.5 if qty <= 0.5 else 1
    return math.ceil(qty - 0.01)


_BROEK = {"½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3}
_DK_RE = re.compile(
    r"^\s*(?:ca\.?\s*)?(?P<q>\d+\s+\d+/\d+|\d+/\d+|\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?|[½¼¾⅓⅔])?\s*"
    r"(?P<u>[A-Za-zæøåÆØÅ.]+)?\s+(?P<rest>.+)$"
)


def _dk_linje(raw: str, o: dict) -> tuple[float | None, str, str] | None:
    """Dansk/engelsk fritekst ("200 g champignon, skåret i kvarte") -> (mængde, enhed, navn)."""
    raw = re.sub(r"@\S+", "", raw).strip().lstrip("*-•").strip()
    raw = re.sub(r"\((?:not sponsored|optional)[^)]*\)", "", raw, flags=re.I).strip()
    raw = re.sub(r"^(\d+)\s*(g|ml|kg|dl)\b", r"\1 \2", raw)
    raw = re.sub(r"\bof\s+(a\s+)?", "", raw)
    raw = re.sub(r"^(saften|skal(?:len)?|juice) (fra|af) ", "", raw, flags=re.I)
    m = _DK_RE.match(raw)
    if not m:
        navn = re.split(r",|\(", raw)[0].strip()
        return (None, "", navn) if navn and not re.search(r"\d", navn) else None
    q, u, rest = m.group("q"), (m.group("u") or "").lower(), m.group("rest")
    qty = None
    if q:
        q = q.replace(",", ".")
        if q in _BROEK:
            qty = _BROEK[q]
        elif "/" in q:
            qty = 0.0
            for pt in q.split():
                if "/" in pt:
                    a, b = pt.split("/")
                    qty += float(a) / float(b)
                else:
                    qty += float(pt)
        elif re.search(r"[-–]", q):
            a, b = re.split(r"\s*[-–]\s*", q)
            qty = (float(a) + float(b)) / 2
        else:
            qty = float(q)
    if u and u not in DK_ENHED:
        rest = m.group("u") + " " + rest
        u = ""
    enhed = DK_ENHED.get(u, "stk" if qty is not None else "")
    if enhed == "cup":
        enhed, qty = "dl", (qty * o["cup_dl"] if qty is not None else None)
    navn = re.split(r",|\(| - | – |\s/\s| i (?:små |tynde |grove |mindre )?(?:tern|skiver|stykker|strimler)\b", rest)[0].strip()
    navn = re.sub(r"^(frisk[e]?|finthakket|grofthakket|flydende|tørret|tørrede|økologisk|danske)\s+", "", navn, flags=re.I).strip()
    navn = re.sub(r"\b(fra|evt\.?|gerne|valgfrit)\b.*$", "", navn).strip()
    return qty, enhed, navn


# Længste nøgle først; regex kompileres én gang (Pythons re-cache er for lille til ~700 mønstre)
_NAVNE_RE = [(re.compile(r"(^|\s)" + re.escape(k) + r"s?($|\s)"), NAVNE[k]) for k in sorted(NAVNE, key=len, reverse=True)]
_NAVNE_RE2 = [(re.compile(r"(^|\s)" + re.escape(k) + r"s?($|\s|,)"), NAVNE[k]) for k in sorted(NAVNE, key=len, reverse=True)]
_DK_RE2 = [(re.compile(r"(^|\s)" + re.escape(k) + r"($|\s)"), DK_TEKST[k]) for k in sorted(DK_TEKST, key=len, reverse=True)]


@lru_cache(maxsize=4096)
def _dansk_navn(prod: str, rp: str, enhed: str) -> str | None:
    p = (prod or "").lower().strip()
    r = (rp or "").lower().strip()
    navn = NAVNE.get(r) if r else None
    if not navn and p:
        navn = NAVNE.get(p)
    if not navn:
        for txt in (r, p):
            if not txt:
                continue
            navn = next((v for rx, v in _NAVNE_RE if rx.search(txt)), None)
            if navn:
                break
    if navn in TOERRET and enhed in ("tsk", "knivspids"):
        navn = TOERRET[navn]
    return navn


@lru_cache(maxsize=4096)
def _dk_navn_fritekst(navn: str) -> str | None:
    n = navn.lower().strip(" *.")
    if n in DK_TEKST:
        return DK_TEKST[n]
    for rx, v in _DK_RE2:
        if rx.search(n):
            return v
    for rx, v in _NAVNE_RE2:
        if rx.search(n):
            return v
    if kategorier.gaet(n) and len(n) <= 40 and not re.search(r"\d", n):
        return n[:1].upper() + n[1:]
    return None


def konverter(r: dict, o: dict) -> dict:
    """Rå opskrift -> varer til familiens portion efter indstillingerne `o`."""
    enh = _enheder(o)
    altid = {a.lower() for a in o["har_vi_altid"]}
    egne_navne = {k.lower(): v for k, v in (o.get("navne") or {}).items()}
    stk_vaegt = {k.lower(): v for k, v in (o.get("stk_vaegt") or {}).items()}
    # Danske kødnavne (ordbogens engelske nøgler matcher aldrig et dansk navn)
    koed = {k.lower() for k in KOED if k[:1].isupper()} | set(stk_vaegt)
    varer: "OrderedDict[tuple, dict]" = OrderedDict()
    har_altid: list[str] = []
    ukendt: list[str] = []
    for ln in r["linjer"]:
        raw = ln.get("raw") or ""
        if not ln.get("prod"):
            if not raw or raw.lower().startswith(SPRING_OVER) or IKKE_VARE.search(raw.strip(" -•*")) \
                    or IKKE_VARE2.search(raw.strip(" -•*")):
                continue
            tolket = _dk_linje(raw, o)
            navn = None
            qty, enhed = None, ""
            if tolket:
                qty, enhed, rest = tolket
                navn = _dk_navn_fritekst(rest)
            if not navn:
                ukendt.append(raw)
                continue
        else:
            if IKKE_VARE2.search(ln["prod"]) or IKKE_VARE2.search(ln.get("rp") or ""):
                continue
            qty, enhed = _omregn(ln.get("qty"), ln.get("unit") or "", ln["prod"].lower(), o, enh)
            navn = _dansk_navn(ln["prod"], ln.get("rp") or "", enhed)
            if not navn:
                ukendt.append(" ".join(x for x in (ln["prod"], ln.get("rp")) if x))
                continue
        navn = egne_navne.get(navn.lower(), navn)
        if navn.lower() in altid:
            if navn not in har_altid:
                har_altid.append(navn)
            continue
        key = (navn, enhed)
        if key in varer:
            v = varer[key]
            v["mængde"] = (v["mængde"] or 0) + (qty or 0) if (v["mængde"] is not None or qty is not None) else None
        else:
            varer[key] = {"navn": navn, "mængde": qty, "enhed": enhed}
    koed_g = 0.0
    for v in varer.values():
        nl = v["navn"].lower()
        if nl in koed and v["mængde"]:
            if v["enhed"] in ("g", "kg"):
                koed_g += v["mængde"] * (1000 if v["enhed"] == "kg" else 1)
            elif v["enhed"] == "stk" and nl in stk_vaegt:
                koed_g += v["mængde"] * stk_vaegt[nl]
    pers = r.get("portioner") or 0
    if not o["skaler"]:
        faktor, grundlag = 1.0, "opskriftens mængde"
    elif koed_g and (not pers or koed_g / pers >= o["koed_taerskel"]):
        faktor, grundlag = o["koed_g"] / koed_g, f"{o['koed_g']} g kød"
    elif pers:
        faktor, grundlag = o["portioner"] / pers, f"{o['portioner']} portioner"
    else:
        faktor, grundlag = 1.0, "opskriftens mængde"
    if o["skaler"]:
        faktor = min(o["faktor_max"], max(o["faktor_min"], faktor))
    ud = []
    for v in varer.values():
        if v["mængde"] is not None:
            v["mængde"] *= faktor
            if v["enhed"] == "kg" and v["mængde"] < 2:
                v["mængde"], v["enhed"] = v["mængde"] * 1000, "g"
            elif v["enhed"] == "l" and v["mængde"] < 1:
                v["mængde"], v["enhed"] = v["mængde"] * 10, "dl"
            elif v["enhed"] in HEL_ENHED and v["mængde"] < 1:
                v["mængde"] = 1
            if o["skeer"] == "ml" and v["enhed"] in ("tsk", "spsk"):
                v["mængde"], v["enhed"] = v["mængde"] * (5 if v["enhed"] == "tsk" else 15), "ml"
        v["mængde"] = paen(v["mængde"], v["enhed"], o["afrund"])
        if v["mængde"] is None:
            v["enhed"] = ""
        ud.append(v)
    return {
        "koed_g": round(koed_g) or None, "faktor": round(faktor, 3), "grundlag": grundlag,
        "varer": ud, "har_vi_altid": har_altid, "ikke_tolket": ukendt,
    }


# --------------------------------------------------------------------------- visning
def fmt_tal(v: float | None, broek: bool = True) -> str:
    if v is None:
        return ""
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    brk = {0.25: "¼", 0.5: "½", 0.75: "¾"}
    hel, rest = int(v), round(v - int(v), 2)
    if broek and rest in brk:
        return (str(hel) if hel else "") + brk[rest]
    return f"{v:.2f}".rstrip("0").rstrip(".").replace(".", ",")


FLERTAL = {"dåse": "dåser", "pakke": "pakker", "flaske": "flasker", "bundt": "bundter", "blok": "blokke",
           "håndfuld": "håndfulde", "skive": "skiver", "kvist": "kviste", "stilk": "stilke", "blad": "blade"}


def maengde_tekst(v: dict, broek: bool = True) -> str:
    """{"mængde": 400, "enhed": "g"} -> "400 g"."""
    q = fmt_tal(v.get("mængde"), broek)
    e = v.get("enhed") or ""
    if not q:
        return ""
    if (v.get("mængde") or 0) > 1 and e in FLERTAL:
        e = FLERTAL[e]
    if e == "stk":
        return f"{q} stk"
    return f"{q} {e}".strip()


def liste_tekst(v: dict, gange: float = 1) -> str:
    """Varen som linje på indkøbslisten: "Hakket oksekød 400 g" (tsk, fed … udelades)."""
    navn = v["navn"].strip()
    q = v.get("mængde")
    e = v.get("enhed") or ""
    if q is None or e not in LISTE_ENHED:
        return navn
    q = paen(q * gange, e) if gange != 1 else q
    if e == "kg" and q is not None and q < 2:
        q, e = q * 1000, "g"
    if q is not None and (e == "stk" or e in HEL_ENHED):
        q = math.ceil(q - 0.01)  # man køber hele (½ citron -> 1)
    # decimaltal med komma (ikke ½), så listens dublet-tjek og statistik genkender mængden
    return f"{navn} {maengde_tekst({'mængde': q, 'enhed': e}, broek=False)}".strip()


def paen_titel(t: str) -> str:
    """"GREEK-STYLE POTATO SALAD 🥔" -> "Greek-style potato salad 🥔" (kun når hele titlen råber)."""
    t = re.sub(r"\s+", " ", (t or "")).strip()
    bogst = [c for c in t if c.isalpha()]
    if len(bogst) >= 6 and sum(c.isupper() for c in bogst) / len(bogst) > 0.8:
        low = t.lower()
        i = next((i for i, c in enumerate(low) if c.isalpha()), 0)
        return low[:i] + low[i:i + 1].upper() + low[i + 1:]
    return t


def kilde_url(k: str | None) -> str | None:
    if not k:
        return None
    if k.startswith("ig:"):
        return "https://www.instagram.com/reel/" + k[3:]
    if k.startswith("igp:"):
        return "https://www.instagram.com/p/" + k[4:]
    if k.startswith("http"):
        return k
    return "https://" + k


def billede_url(b: str | None) -> str | None:
    return f"https://cdn.prod.recime.app/images/original/{b}.jpg" if b else None


def original_tekst(ln: dict) -> str:
    """Opskriftens egen ingredienslinje (til at tjekke omregningen)."""
    if ln.get("raw"):
        return ln["raw"]
    q = fmt_tal(ln.get("qty"))
    return " ".join(x for x in (q, ln.get("unit") or "", ln.get("rp") or ln.get("prod") or "") if x)


_ORD_RE = re.compile(r"[a-zæøåéü]+")
_FYLD = {"med", "og", "i", "a", "la", "al", "the", "with", "and", "de", "di", "en", "et", "til", "på", "style"}


def ord_i(t: str) -> set[str]:
    return {w for w in _ORD_RE.findall((t or "").lower()) if len(w) > 2 and w not in _FYLD}


def ligner(a: str, b: str) -> float:
    """Hvor meget to retnavne ligner hinanden (0–1) – til forslag om kobling til en opskrift."""
    wa, wb = ord_i(a), ord_i(b)
    if not wa or not wb:
        return 0.0
    faelles = 0.0
    for w in wa:
        if w in wb:
            faelles += 1
        elif any((len(w) >= 5 and (w in x or x in w)) for x in wb if len(x) >= 4):
            faelles += 0.7
    return faelles / max(len(wa), 1) * (0.6 + 0.4 * min(len(wa), len(wb)) / max(len(wa), len(wb)))


# --------------------------------------------------------------------------- banken
def rens_fryser(alts: list[str]) -> list[str]:
    """Kød-muligheder: små bogstaver, uden dubletter, højst 6 à 40 tegn ("intet" = intet fra fryseren)."""
    out: list[str] = []
    for a in alts or []:
        a = " ".join(str(a).split()).strip(" .,").lower()[:40]
        if a in ("intet fra fryseren", "ingen", "intet"):
            a = "intet"
        if a and a not in out:
            out.append(a)
    return out[:6]


def _rens_varer(varer: list[dict]) -> list[dict]:
    out = []
    for v in varer or []:
        navn = re.sub(r"\s+", " ", str(v.get("navn") or "")).strip()
        if not navn:
            continue
        q = v.get("mængde", v.get("maengde"))
        if q in ("", None):
            q = None
        else:
            try:
                q = float(str(q).replace(",", "."))
            except ValueError as err:
                raise ValueError(f'"{navn}": mængden skal være et tal') from err
            if q <= 0:
                q = None
            elif abs(q - round(q)) < 1e-9:
                q = int(round(q))
        enhed = str(v.get("enhed") or "").strip()[:12] if q is not None else ""
        out.append({"navn": navn[:1].upper() + navn[1:80], "mængde": q, "enhed": enhed})
    return out


class Opskriftsbank:
    """Importerede opskrifter (rå) + jeres rettelser + omregningsindstillinger."""

    def __init__(self, data: dict | None = None) -> None:
        data = data or {}
        self.raa: list[dict] = data.get("raa") or []
        self.importeret: str | None = data.get("importeret")
        self.kilde: str | None = data.get("kilde")
        self.omr_aendret: dict[str, Any] = data.get("omregning") or {}
        # id -> {"navn"?, "varer"?: [...], "opskrift"?: "r:<id>", "t", "af"}
        self.egne: dict[str, dict] = data.get("egne") or {}
        self.version = 0
        self._konv: dict[str, dict] | None = None
        self._idx = {r["id"]: r for r in self.raa}

    def as_dict(self) -> dict:
        return {"raa": self.raa, "importeret": self.importeret, "kilde": self.kilde,
                "omregning": self.omr_aendret, "egne": self.egne}

    def _changed(self, omregn: bool = True) -> None:
        self.version += 1
        if omregn:
            self._konv = None

    # ---------------------------------------------------------------- omregning
    @property
    def omregning(self) -> dict[str, Any]:
        return {**STANDARD, **self.omr_aendret}

    def set_omregning(self, changes: dict[str, Any]) -> list[str]:
        """Gem ændrede indstillinger. Returnerer navnene på dem, der faktisk ændrede sig."""
        rens = rens_omregning(changes)
        cur = self.omregning
        new = {**cur, **rens}
        if new["faktor_min"] > new["faktor_max"]:
            raise ValueError("Skalér mindst skal være mindre end højst")
        aendret = [LABELS[k] for k, v in rens.items() if cur.get(k) != v]
        if not aendret:
            return []
        for k, v in rens.items():
            if v == STANDARD[k]:
                self.omr_aendret.pop(k, None)
            else:
                self.omr_aendret[k] = v
        self._changed()
        return aendret

    def nulstil_omregning(self) -> bool:
        if not self.omr_aendret:
            return False
        self.omr_aendret = {}
        self._changed()
        return True

    # ---------------------------------------------------------------- import
    def importer(self, tekst: str, *, erstat: bool = True, kilde: str = "ReciMe", t: str | None = None) -> dict:
        nye = laes_raa(tekst)
        # tomme kladder ("My Recipe" uden ingredienser, billede og kilde) springes over
        nye = [r for r in nye if r["linjer"] or r["billede"] or r["kilde"]]
        if not nye:
            raise ValueError("Fandt ingen opskrifter i filen")
        gamle = self._idx
        n_nye = sum(1 for r in nye if r["id"] not in gamle)
        n_opd = sum(1 for r in nye if r["id"] in gamle and gamle[r["id"]] != r)
        if erstat:
            ids = {r["id"] for r in nye}
            fjernet = [i for i in gamle if i not in ids]
            self.raa = nye
        else:
            fjernet = []
            idx = dict(gamle)
            for r in nye:
                idx[r["id"]] = r
            self.raa = list(idx.values())
        self.raa.sort(key=lambda r: paen_titel(r["titel"]).lower())
        self._idx = {r["id"]: r for r in self.raa}
        self.importeret = t
        self.kilde = kilde
        self._changed()
        return {"antal": len(self.raa), "nye": n_nye, "opdaterede": n_opd, "fjernede": len(fjernet)}

    # ---------------------------------------------------------------- opslag
    def konverteret(self) -> dict[str, dict]:
        if self._konv is None:
            o = self.omregning
            self._konv = {r["id"]: konverter(r, o) for r in self.raa}
        return self._konv

    def opskrift(self, rid: str) -> dict | None:
        return self._idx.get(rid)

    def varer(self, ret_id: str) -> list[dict] | None:
        """Rettens indkøbsliste (familiens portion) – None hvis den ikke har nogen."""
        e = self.egne.get(ret_id) or {}
        if e.get("varer") is not None:
            return e["varer"]
        if ret_id.startswith("r:"):
            k = self.konverteret().get(ret_id[2:])
            return k["varer"] if k else None
        if e.get("opskrift") and e["opskrift"] != ret_id:
            return self.varer(e["opskrift"])
        return None

    def fryser(self, ret_id: str) -> list[str] | None:
        """Kød fra fryseren til retten (0.12.4): liste med muligheder, [] = intet, None = ikke angivet."""
        f = (self.egne.get(ret_id) or {}).get("fryser")
        return list(f) if isinstance(f, list) else None

    def saeson(self, ret_id: str) -> list[str] | None:
        """Jeres sæson for retten (0.12.6): liste af sæsoner, [] = hele året, None = ikke angivet (regler)."""
        s = (self.egne.get(ret_id) or {}).get("saeson")
        return list(s) if isinstance(s, list) else None

    def gem(self, ret_id: str, *, navn: str | None = None, varer: list[dict] | None | bool = False,
            opskrift: str | None | bool = False, fryser: list[str] | None | bool = False,
            saeson: list[str] | None | bool = False,
            t: str | None = None, af: str | None = None) -> None:
        """varer: liste = gem · None = slet rettelsen (tilbage til opskriftens/ingen) · False = uændret.
        opskrift: "r:<id>" = brug den opskrifts varer · None = fjern koblingen · False = uændret.
        fryser: liste = kød fra fryseren ([] = intet) · None = ikke angivet · False = uændret.
        saeson: liste af sæsoner ([] = hele året) · None = ikke angivet (faste regler) · False = uændret."""
        if ret_id.startswith("r:") and not self.opskrift(ret_id[2:]):
            raise KeyError(ret_id)
        e = dict(self.egne.get(ret_id) or {})
        if navn is not None and ret_id.startswith("e:"):
            e["navn"] = navn.strip()
        if varer is not False:
            if varer is None:
                e.pop("varer", None)
            else:
                e["varer"] = _rens_varer(varer)
        if opskrift is not False:
            if opskrift is None:
                e.pop("opskrift", None)
            else:
                if not opskrift.startswith("r:") or not self.opskrift(opskrift[2:]):
                    raise KeyError(opskrift)
                e["opskrift"] = opskrift
        if fryser is not False:
            if fryser is None:
                e.pop("fryser", None)
            else:
                e["fryser"] = rens_fryser(fryser)
        if saeson is not False:
            if saeson is None:
                e.pop("saeson", None)
            else:
                e["saeson"] = sae.rens(saeson)
        e["t"], e["af"] = t, af
        if set(e) <= {"t", "af"} or (ret_id.startswith("r:") and set(e) <= {"t", "af", "navn"}):
            self.egne.pop(ret_id, None)
        else:
            self.egne[ret_id] = e
        self._changed(omregn=False)

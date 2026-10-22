"""Køleskabet (0.12.5): madvarer I har tilbage.

Ugeplanlæggeren bruger dem først (retter med resterne lægges først på ugen), og en rest mærket
"Nok" fjernes fra indkøbslisten og fravælges i "Varer til ugen". "Lidt" = bruges stadig først,
men købes som normalt (fx lidt skyr, der ikke rækker en hel uge).

Her ligger kun sammenligningen af navne (ren Python, testbar uden Home Assistant):
hører resten "fløde" til varen "Madlavningsfløde 2,5 dl"? Reglerne er bevidst forsigtige –
hellere en rest for lidt fundet end en forkert vare fjernet fra listen.
"""

from __future__ import annotations

import re

from . import kategorier as kat
from .stats import normalize

# Ord der ikke siger noget om varen ("lidt fløde", "½ pakke champignon", "rester af ris")
STOP = {
    "m", "med", "og", "i", "en", "et", "lidt", "lille", "halv", "halvt", "halve", "rest", "rester", "resten", "af",
    "fra", "til", "pakke", "pakker", "pk", "stk", "bakke", "bakker", "pose", "poser", "dåse", "dåser", "glas",
    "ca", "cirka", "nok", "tilbage", "åben", "åbnet", "frisk", "friske",
}
# Kød, hvor den korte form dækker den lange: "kylling" ~ "kyllingebryst", "kyllingelår"
KOED_FORSTAVELSER = ("kylling", "kalkun", "okse", "svine", "svin", "kalve", "kalv", "lamme", "laks", "torsk")

_TOKEN_RE = re.compile(r"[a-zæøåéü]+")
_ELLER_RE = re.compile(r"\s+eller\s+|\s*/\s*", re.IGNORECASE)


def _stam(t: str) -> str:
    """Grov stamme: "champignoner" → "champignon", "tortillas" → "tortilla"."""
    s = kat.stamme(t)
    if len(s) > 4 and s.endswith("s"):
        s = s[:-1]
    return s


def ord_i(tekst: str) -> list[str]:
    """Varens betydende ord (små bogstaver, uden mængder og fyldord)."""
    return [t for t in _TOKEN_RE.findall(normalize(tekst or "")) if t not in STOP and len(t) >= 2]


def navn(tekst: str) -> str:
    """Pænt navn til listen: "  lidt fløde " → "Fløde", "½ pakke Champignon" → "Champignon"."""
    o = ord_i(tekst)
    s = " ".join(o) if o else (tekst or "").strip()
    return s[:1].upper() + s[1:]


def _ord_passer(r: str, v: str, samme_kategori: bool) -> bool:
    if r == v or _stam(r) == _stam(v):
        return True
    kort, lang = (r, v) if len(r) <= len(v) else (v, r)
    # Sammensat ord med samme hovedord: "fløde" ~ "madlavningsfløde", "oksekød" ~ "kød"
    if samme_kategori and (len(kort) >= 4 or kort == "kød") and (lang.endswith(kort) or lang.endswith(_stam(kort))):
        return True
    # Kød, hvor den korte form er første led: "kylling" ~ "kyllingebryst"
    if any(kort.startswith(f) for f in KOED_FORSTAVELSER) and lang.startswith(kort) and len(kort) >= 4:
        return True
    return False


def passer(rest: str, vare: str) -> bool:
    """Er varen (fx en linje på indkøbslisten eller en ingrediens) det, resten er?

    Alle restens betydende ord skal findes i varen. Sammensatte ord tæller kun, når begge
    varer ville stå i samme kategori i butikken ("mælk" ≠ "kokosmælk").
    """
    r_ord = ord_i(rest)
    if not r_ord:
        return False
    for del_ in _ELLER_RE.split(vare or ""):
        v_ord = ord_i(del_)
        if not v_ord:
            continue
        kr, kv = kat.gaet(rest), kat.gaet(del_)
        samme = not (kr and kv and kr != kv)
        if all(any(_ord_passer(r, v, samme) for v in v_ord) for r in r_ord):
            return True
    return False


def i_tekst(rest: str, tekst: str) -> bool:
    """Står resten i en madplan-linje? ("stroganoff m champignon" bruger "champignon")."""
    r_ord = ord_i(rest)
    t_ord = _TOKEN_RE.findall((tekst or "").lower())
    if not r_ord or not t_ord:
        return False
    return all(any(r == t or _stam(r) == _stam(t) for t in t_ord) for r in r_ord)


def bruger(rest: str, varer: list[str], tekst: str = "") -> bool:
    """Bruger retten resten? (en af rettens varer passer, eller resten står i linjen)."""
    return any(passer(rest, v) for v in varer) or (bool(tekst) and i_tekst(rest, tekst))

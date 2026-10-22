"""Sæson (0.12.6): hvornår på året ugeplanlæggeren må foreslå en ret.

- Faste regler ud fra rettens navn (hokkaido om efteråret, supper og gryder i vinterhalvåret,
  grill om sommeren …). Retter uden en regel er "hele året" og påvirkes ikke.
- Jeres egne retter kan få en sæson under Retter (forår/sommer/efterår/vinter, eller hele året),
  som går forud for reglerne.
- Uden for sæson foreslås retten aldrig (I kan stadig vælge den selv); i en kantmåned halvt så
  ofte; i sæson lidt oftere.

Ren Python uden Home Assistant-afhængigheder, så den kan testes isoleret.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

# Lidt oftere i sæson, halvt så ofte i en kantmåned, aldrig uden for sæson
BONUS = 1.3
KANT = 0.5

SAESONER: dict[str, tuple[str, tuple[int, ...]]] = {
    "foraar": ("Forår", (3, 4, 5)),
    "sommer": ("Sommer", (6, 7, 8)),
    "efteraar": ("Efterår", (9, 10, 11)),
    "vinter": ("Vinter", (12, 1, 2)),
}
_KORT = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]


@dataclass(frozen=True)
class Saeson:
    maaneder: frozenset[int]  # i sæson (bonus)
    kant: frozenset[int] = frozenset()  # kantmåneder (halvt så ofte)
    kilde: str = "regel"  # "regel" | "egen"
    regel: str = ""  # hvilken regel ("græskar", "suppe" …)

    def tekst(self) -> str:
        """Fx "okt–dec (også sep og jan)" eller "efterår og vinter"."""
        if self.kilde == "egen":
            navne = [SAESONER[k][0].lower() for k in SAESONER if set(SAESONER[k][1]) <= self.maaneder]
            if navne:
                return navne[0] if len(navne) == 1 else ", ".join(navne[:-1]) + " og " + navne[-1]
        s = _spaend(self.maaneder)
        if self.kant:
            start = _cirkel(self.maaneder)[0]
            # måneden før sæsonen først ("okt–mar (også sep og apr)")
            k = [_KORT[m - 1] for m in sorted(self.kant, key=lambda m: (m - start + 1) % 12)]
            s += f" (også {k[0]}" + (f" og {k[1]}" if len(k) > 1 else "") + ")"
        return s


# Første regel, der matcher rettens navn, vinder (rækkefølgen betyder noget: "hokkaidosuppe" er græskar)
_VINTERHALVAAR = (10, 11, 12, 1, 2, 3)
REGLER: list[tuple[str, str, tuple[int, ...], tuple[int, ...]]] = [
    # (regel, mønster, i sæson, kantmåneder)
    ("græskar", r"hokkaido|græskar|butternut", (10, 11, 12), (9, 1)),
    ("grill", r"grill|\bbbq\b|barbecue", (5, 6, 7, 8, 9), ()),
    ("asparges", r"asparges", (5, 6), ()),
    ("sommer", r"jordbær|koldskål|nye kartofler|gazpacho", (6, 7, 8), ()),
    ("suppe", r"suppe", _VINTERHALVAAR, (9, 4)),
    ("gryde", r"paprikagryde|gul+asc?h|goulash|stuvning|stuvet|grønkål|grønlangkål|flæskesteg|"
              r"\band(e)?(steg|bryst|lår)\b|\band med\b|oksetern", _VINTERHALVAAR, (9, 4)),
]
_REGLER = [(navn, re.compile(p, re.IGNORECASE), frozenset(m), frozenset(k)) for navn, p, m, k in REGLER]


def regel_saeson(navn: str) -> Saeson | None:
    """Sæson ud fra rettens navn – None = hele året."""
    low = (navn or "").lower()
    for regel, rx, m, k in _REGLER:
        if rx.search(low):
            return Saeson(m, k, "regel", regel)
    return None


def rens(saesoner: list[str] | None) -> list[str]:
    """Kendte sæsoner i fast rækkefølge, uden dubletter; alle fire = hele året ([])."""
    valgt = {s for s in (saesoner or []) if s in SAESONER}
    out = [k for k in SAESONER if k in valgt]
    return [] if len(out) == len(SAESONER) else out


def egen_saeson(saesoner: list[str]) -> Saeson | None:
    """Jeres egen sæson for en ret ([] = hele året → None)."""
    ren = rens(saesoner)
    if not ren:
        return None
    m: set[int] = set()
    for k in ren:
        m |= set(SAESONER[k][1])
    return Saeson(frozenset(m), frozenset(), "egen", "egen")


def faktor(s: Saeson | None, d: date) -> float:
    """1 = ingen sæson · BONUS i sæson · KANT i en kantmåned · 0 = uden for sæson (foreslås ikke)."""
    if s is None:
        return 1.0
    if d.month in s.maaneder:
        return BONUS
    if d.month in s.kant:
        return KANT
    return 0.0


def _cirkel(maaneder) -> list[int]:
    """Måneder i rækkefølge rundt om årsskiftet (fx okt, nov, dec, jan)."""
    ms = sorted(set(maaneder))
    if not ms or len(ms) == 12:
        return ms
    # start efter det største hul
    huller = [((ms[(i + 1) % len(ms)] - m) % 12 or 12, i) for i, m in enumerate(ms)]
    _, i = max(huller)
    return ms[i + 1:] + ms[:i + 1]


def _spaend(maaneder) -> str:
    """"okt–mar" for sammenhængende måneder, ellers "maj, jun og sep"."""
    ms = _cirkel(maaneder)
    if not ms:
        return ""
    if len(ms) == 12:
        return "hele året"
    sammen = all((ms[i + 1] - ms[i]) % 12 == 1 for i in range(len(ms) - 1))
    if sammen:
        return _KORT[ms[0] - 1] if len(ms) == 1 else f"{_KORT[ms[0] - 1]}–{_KORT[ms[-1] - 1]}"
    k = [_KORT[m - 1] for m in ms]
    return ", ".join(k[:-1]) + " og " + k[-1]

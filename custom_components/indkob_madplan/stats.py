"""Indkøbsstatistik: normalisering af varenavne, hændelseslog og beregninger.

Ren Python uden Home Assistant-afhængigheder.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import median

_PAREN_RE = re.compile(r"\([^)]*\)")
_UNIT = r"(?:x|stk\.?|kg|g|gr|l|dl|cl|ml|pk\.?|pakk?er?|pakke|bakk?er?|bakke|pos(?:er)?|ds\.?|dåser?|dåse|bdt\.?|bundter?|net|glas|rl\.?|ruller?)"
_QTY_RE = re.compile(rf"\b\d+(?:[.,]\d+)?\s*{_UNIT}(?=\s|$)", re.IGNORECASE)
_X_QTY_RE = re.compile(r"\bx\s*\d+\b|\b\d+\s*x\b", re.IGNORECASE)
_LEAD_NUM_RE = re.compile(r"^\s*\d+(?:[.,]\d+)?\s+")
_JUNK_RE = re.compile(r"[^\w\s\-/&+æøåÆØÅéÉ]", re.UNICODE)


def is_header(summary: str) -> bool:
    """Afsnitsoverskrift, fx "🍎 FRUGT & GRØNT" eller "Kød & fisk:"."""
    s = (summary or "").strip()
    if not s:
        return True
    if s.endswith(":"):
        return True
    letters = [c for c in s if c.isalpha()]
    if len(letters) < 2:
        return not any(c.isalnum() for c in s)
    return not any(c.islower() for c in letters) and len(letters) >= 3


def normalize(summary: str) -> str:
    """Nøgle til statistik: "Blåbær x2" -> "blåbær", "800g Svinenakkefilet (tern)" -> "svinenakkefilet"."""
    s = (summary or "").strip().lower()
    s = _PAREN_RE.sub(" ", s)
    s = _QTY_RE.sub(" ", s)
    s = _X_QTY_RE.sub(" ", s)
    s = _LEAD_NUM_RE.sub(" ", s)
    s = _JUNK_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" -/&+")
    return s


def display_name(key: str) -> str:
    return key[:1].upper() + key[1:] if key else key


def iso_week(dt: datetime) -> str:
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


class History:
    """Hændelseslog over hvad der kommer på listen og hvad der købes."""

    UNDO_WINDOW = timedelta(hours=12)

    def __init__(self, data: dict | None = None) -> None:
        data = data or {}
        self.events: list[dict] = data.get("events", [])
        self.snapshot: dict[str, dict] | None = data.get("snapshot")
        self.names: dict[str, str] = data.get("names", {})
        self.madplan_text: str = data.get("madplan_text", "")
        # Indkøbsture: {"id", "t": iso, "varer": [navne], "auto": bool,
        #               "betalinger": [{"butik": str, "beloeb": float}], "manuel": bool}
        self.trips: list[dict] = data.get("trips", [])
        for tr in self.trips:  # ældre ture (≤ 0.3.2) havde intet id
            tr.setdefault("id", hashlib.sha1(tr["t"].encode()).hexdigest()[:10])
            tr.setdefault("betalinger", [])

    MAX_TRIPS = 300

    def as_dict(self) -> dict:
        return {
            "events": self.events,
            "snapshot": self.snapshot,
            "names": self.names,
            "madplan_text": self.madplan_text,
            "trips": self.trips,
        }

    # ------------------------------------------------------------ ture
    def set_baseline(self, items: list[dict]) -> None:
        """Ny grundlinje uden hændelser (bruges når fluebenene nulstilles efter en tur).

        Køb er allerede logget ved afkrydsning; at fjerne fluebenene må hverken
        fortryde køb eller tælle som nye tilføjelser.
        """
        self.snapshot = None
        self.apply_items(items, datetime.now())

    def add_trip(self, t: datetime, summaries: list[str], auto: bool) -> dict:
        varer = clean_names(summaries)
        trip = {"id": uuid.uuid4().hex[:10], "t": t.isoformat(timespec="seconds"), "varer": varer,
                "auto": auto, "betalinger": []}
        self.trips.append(trip)
        self.trips.sort(key=lambda x: x["t"])
        del self.trips[: max(0, len(self.trips) - self.MAX_TRIPS)]
        return trip

    def get_trip(self, trip_id: str) -> dict:
        for tr in self.trips:
            if tr["id"] == trip_id:
                return tr
        raise KeyError(trip_id)

    def delete_trip(self, trip_id: str) -> dict:
        tr = self.get_trip(trip_id)
        self.trips.remove(tr)
        return tr

    def trip_overview(self, now: datetime, limit: int = 100) -> dict:
        """Indkøbshistorik med priser: seneste ture, måneds- og butikstotaler."""
        trips = sorted(self.trips, key=lambda x: x["t"])
        months: dict[str, dict] = {}
        shops: dict[str, dict] = {}
        for tr in trips:
            total = round(sum(b["beloeb"] for b in tr.get("betalinger", [])), 2)
            m = months.setdefault(tr["t"][:7], {"maaned": tr["t"][:7], "beloeb": 0.0, "ture": 0, "med_pris": 0})
            m["ture"] += 1
            if total:
                m["med_pris"] += 1
                m["beloeb"] = round(m["beloeb"] + total, 2)
            for b in tr.get("betalinger", []):
                navn = (b.get("butik") or "").strip()
                if not navn:
                    continue
                sh = shops.setdefault(navn.lower(), {"navn": navn, "beloeb": 0.0, "gange": 0, "sidst": tr["t"]})
                sh["beloeb"] = round(sh["beloeb"] + b["beloeb"], 2)
                sh["gange"] += 1
                sh["sidst"] = max(sh["sidst"], tr["t"])
        ture = [
            {**tr, "total": round(sum(b["beloeb"] for b in tr.get("betalinger", [])), 2)}
            for tr in reversed(trips[-limit:])
        ]
        return {
            "ture": ture,
            "antal_ture": len(trips),
            "maaneder": [months[k] for k in sorted(months, reverse=True)][:13],
            "butikker": sorted(shops.values(), key=lambda x: (-x["gange"], x["navn"])),
        }

    # ------------------------------------------------------------------ diff
    def apply_items(self, items: list[dict], now: datetime) -> list[dict]:
        """Sammenlign med forrige snapshot og log køb/tilføjelser. Returnér nye hændelser."""
        new_snap: dict[str, dict] = {}
        for it in items:
            uid = it.get("uid") or it.get("summary")
            if not uid:
                continue
            new_snap[uid] = {"s": it.get("summary", ""), "st": it.get("status", "needs_action")}

        new_events: list[dict] = []
        if self.snapshot is None:  # første kørsel: kun baseline
            self.snapshot = new_snap
            return new_events

        for uid, cur in new_snap.items():
            summary = cur["s"]
            if is_header(summary):
                continue
            key = normalize(summary)
            if not key:
                continue
            prev = self.snapshot.get(uid)
            if prev is None:
                if cur["st"] == "completed":
                    new_events.append(self._event("buy", key, summary, now))
                else:
                    new_events.append(self._event("add", key, summary, now))
            elif prev["st"] != "completed" and cur["st"] == "completed":
                new_events.append(self._event("buy", key, summary, now))
            elif prev["st"] == "completed" and cur["st"] != "completed":
                # Fortrudt afkrydsning (inden for 12 t) – ellers genbrug af varen i Keep
                if not self._undo_buy(key, now):
                    new_events.append(self._event("add", key, summary, now))
            elif prev["s"] != summary and cur["st"] != "completed":
                # omdøbt vare: behandl som ny tilføjelse hvis nøglen ændrer sig
                if normalize(prev["s"]) != key:
                    new_events.append(self._event("add", key, summary, now))

        self.snapshot = new_snap
        self.events.extend(new_events)
        return new_events

    def _event(self, typ: str, key: str, summary: str, now: datetime) -> dict:
        self.names[key] = _clean_display(summary) or display_name(key)
        return {"t": now.isoformat(timespec="seconds"), "k": key, "type": typ}

    def _undo_buy(self, key: str, now: datetime) -> bool:
        for i in range(len(self.events) - 1, -1, -1):
            ev = self.events[i]
            if ev["k"] == key and ev["type"] == "buy":
                if now - datetime.fromisoformat(ev["t"]) <= self.UNDO_WINDOW:
                    del self.events[i]
                    return True
                return False
        return False

    def open_keys(self) -> set[str]:
        if not self.snapshot:
            return set()
        return {
            normalize(v["s"])
            for v in self.snapshot.values()
            if v["st"] != "completed" and not is_header(v["s"])
        }

    # ----------------------------------------------------------- statistik
    def buys(self) -> list[tuple[datetime, str]]:
        return [
            (datetime.fromisoformat(e["t"]), e["k"]) for e in self.events if e["type"] == "buy"
        ]

    def compute(self, now: datetime, weeks: int = 12) -> dict:
        buys = self.buys()
        by_key: dict[str, list[datetime]] = defaultdict(list)
        for t, k in buys:
            by_key[k].append(t)

        items = []
        for key, times in by_key.items():
            times.sort()
            days = sorted({t.date() for t in times})
            gaps = [(b - a).days for a, b in zip(days, days[1:]) if (b - a).days > 0]
            interval = median(gaps) if gaps else None
            last = times[-1]
            items.append(
                {
                    "key": key,
                    "navn": self.names.get(key, display_name(key)),
                    "antal": len(times),
                    "antal_12u": sum(1 for t in times if now - t <= timedelta(weeks=12)),
                    "foerste": times[0].isoformat(timespec="minutes"),
                    "sidst": last.isoformat(timespec="minutes"),
                    "dage_siden": (now.date() - last.date()).days,
                    "interval_dage": round(interval, 1) if interval is not None else None,
                }
            )
        items.sort(key=lambda x: (-x["antal_12u"], -x["antal"], x["navn"]))

        # Ugetotaler (seneste `weeks` uger, også tomme)
        week_counter: Counter[str] = Counter(iso_week(t) for t, _ in buys)
        week_items: dict[str, list[str]] = defaultdict(list)
        for t, k in buys:
            week_items[iso_week(t)].append(self.names.get(k, display_name(k)))
        uger = []
        for i in range(weeks - 1, -1, -1):
            wk = iso_week(now - timedelta(weeks=i))
            uger.append({"uge": wk, "antal": week_counter.get(wk, 0)})

        this_week = iso_week(now)
        last_week = iso_week(now - timedelta(weeks=1))

        return {
            "varer": items,
            "top": items[:15],
            "uger": uger,
            "koebt_denne_uge": sorted(set(week_items.get(this_week, []))),
            "koebt_sidste_uge": sorted(set(week_items.get(last_week, []))),
            "antal_koeb_i_alt": len(buys),
            "antal_varer": len(items),
            "sporet_siden": min((t for t, _ in buys), default=None).isoformat(timespec="minutes")
            if buys
            else None,
            "forslag": self.suggestions(items, now),
            **self._trip_stats(now),
        }

    def _trip_stats(self, now: datetime) -> dict:
        trips = sorted(self.trips, key=lambda x: x["t"])
        recent = [x for x in trips if now - datetime.fromisoformat(x["t"]) <= timedelta(weeks=12)]
        days = sorted({datetime.fromisoformat(x["t"]).date() for x in trips})
        gaps = [(b - a).days for a, b in zip(days, days[1:])]
        return {
            "ture": [{"t": x["t"], "antal": len(x["varer"]), "varer": x["varer"], "auto": x.get("auto", False)} for x in reversed(trips[-10:])],
            "antal_ture": len(trips),
            "ture_12u": len(recent),
            "varer_pr_tur": round(sum(len(x["varer"]) for x in recent) / len(recent), 1) if recent else None,
            "dage_mellem_ture": round(median(gaps), 1) if gaps else None,
            "seneste_tur": trips[-1]["t"] if trips else None,
        }

    def suggestions(self, items: list[dict], now: datetime, limit: int = 8) -> list[dict]:
        """Varer I plejer at købe, som snart/allerede er 'forfaldne' og ikke står på listen."""
        open_keys = self.open_keys()
        out = []
        for it in items:
            if it["key"] in open_keys or it["antal"] < 3 or not it["interval_dage"]:
                continue
            interval = max(it["interval_dage"], 2)
            ratio = it["dage_siden"] / interval
            if ratio >= 0.85 and it["dage_siden"] <= max(interval * 4, 28):
                out.append({**it, "forfald": round(ratio, 2)})
        out.sort(key=lambda x: (-x["forfald"], -x["antal"]))
        return out[:limit]


def clean_names(summaries: list[str]) -> list[str]:
    """Visningsnavne for varer (uden overskrifter)."""
    return [_clean_display(s) or s for s in summaries if not is_header(s)]


def _clean_display(summary: str) -> str:
    """Pænt navn uden mængde: "Blåbær x2" -> "Blåbær"."""
    s = _PAREN_RE.sub(" ", summary or "")
    s = _QTY_RE.sub(" ", s)
    s = _X_QTY_RE.sub(" ", s)
    s = _LEAD_NUM_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" -/&+")
    return display_name(s)

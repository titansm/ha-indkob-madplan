"""Kernen: ejer de to noter, logger køb og leverer madplanen."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_EXTRA_KOED,
    CONF_FROST_DAY,
    CONF_IGNORE_KOED,
    CONF_TRIP_DELAY,
    CONF_TRIP_THRESHOLD,
    DEFAULT_TRIP_DELAY,
    DEFAULT_TRIP_THRESHOLD,
    EVENT_HANDLET_IND,
    FROST_TODAY,
    FROST_TOMORROW,
    NOTE_INDKOB,
    NOTE_MADPLAN,
    SIGNAL_UPDATE,
    STORAGE_KEY,
    STORAGE_VERSION,
    VERSION,
)
from .madplan import DEFAULT_KOED_ORD, DEFAULT_REST_ORD, UGEDAGE, Dag, parse_madplan
from .notes import TYPE_ITEM, ShoppingNote, TextNote
from .stats import History

_LOGGER = logging.getLogger(__name__)


class ConflictError(Exception):
    """Madplanen er ændret af en anden siden klienten hentede den."""


def _split_words(value: str | None) -> list[str]:
    return [w.strip().lower() for w in (value or "").split(",") if w.strip()]


class IndkobMadplanManager:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.indkob = ShoppingNote()
        self.madplan_note = TextNote()
        self.history = History()
        self.madplan: dict[date, Dag] = {}
        self.stats: dict[str, Any] = {}
        self._unsubs: list[CALLBACK_TYPE] = []
        self._listeners: set[Callable[[], None]] = set()
        # Indkøbstur: sat når min. X % af varerne er krydset af.
        # {"start": iso, "sidste_flueben": iso}
        self.trip: dict[str, str] | None = None
        self._checked_count = 0
        # Redigeringslog: [{"t", "bruger", "note", "tekst", "k"?}] – nyeste sidst
        self.log: list[dict] = []

    # ------------------------------------------------------------ options
    @property
    def opts(self) -> dict[str, Any]:
        return {**self.entry.data, **self.entry.options}

    @property
    def frost_tomorrow(self) -> bool:
        return self.opts.get(CONF_FROST_DAY) == FROST_TOMORROW

    @property
    def trip_threshold(self) -> float:
        return float(self.opts.get(CONF_TRIP_THRESHOLD, DEFAULT_TRIP_THRESHOLD)) / 100

    @property
    def trip_delay(self) -> timedelta:
        return timedelta(hours=float(self.opts.get(CONF_TRIP_DELAY, DEFAULT_TRIP_DELAY)))

    @property
    def koed_ord(self) -> list[str]:
        ignore = set(_split_words(self.opts.get(CONF_IGNORE_KOED)))
        words = DEFAULT_KOED_ORD + _split_words(self.opts.get(CONF_EXTRA_KOED))
        return [w for w in words if w.strip().lower() not in ignore]

    def settings(self) -> dict[str, Any]:
        """Indstillinger til panelets Indstillinger-side."""
        o = self.opts
        return {
            CONF_FROST_DAY: o.get(CONF_FROST_DAY, FROST_TODAY),
            CONF_EXTRA_KOED: o.get(CONF_EXTRA_KOED, "") or "",
            CONF_IGNORE_KOED: o.get(CONF_IGNORE_KOED, "") or "",
            CONF_TRIP_THRESHOLD: round(float(o.get(CONF_TRIP_THRESHOLD, DEFAULT_TRIP_THRESHOLD))),
            CONF_TRIP_DELAY: float(o.get(CONF_TRIP_DELAY, DEFAULT_TRIP_DELAY)),
            "standard_koed_ord": DEFAULT_KOED_ORD,
            "rest_ord": DEFAULT_REST_ORD,
            "version": VERSION,
        }

    @callback
    def set_settings(self, changes: dict[str, Any], user: str | None = None) -> dict[str, Any]:
        """Gem ændrede indstillinger i integrationens options (uden genindlæsning)."""
        keys = (CONF_FROST_DAY, CONF_EXTRA_KOED, CONF_IGNORE_KOED, CONF_TRIP_THRESHOLD, CONF_TRIP_DELAY)
        before = self.settings()
        new = {k: self.opts.get(k) for k in keys if self.opts.get(k) is not None}
        new.update({k: v for k, v in changes.items() if k in keys})
        for k, v in changes.items():
            if k in SETTING_LABELS and before.get(k) != v:
                vis = {FROST_TODAY: "retten i dag", FROST_TOMORROW: "retten i morgen"}.get(v, v)
                if k == CONF_TRIP_THRESHOLD:
                    vis = f"{v} %"
                elif k == CONF_TRIP_DELAY:
                    vis = f"{str(v).rstrip('0').rstrip('.').replace('.', ',')} t"
                self._log(user, "indstillinger", f'satte "{SETTING_LABELS[k]}" til {vis or "(tom)"}', key=f"set:{k}")
        self.hass.config_entries.async_update_entry(self.entry, options=new)
        return self.settings()

    @callback
    def options_changed(self) -> None:
        """Kaldes når options ændres – alt læses live, så der genberegnes blot."""
        self._parse_madplan()
        self._track_trip()
        self._on_tick(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ lifecycle
    async def async_start(self) -> None:
        data = await self.store.async_load() or {}
        self.indkob = ShoppingNote(data.get(NOTE_INDKOB))
        self.madplan_note = TextNote(data.get(NOTE_MADPLAN))
        self.history = History(data.get("history"))
        self.trip = data.get("trip")
        self.log = data.get("log", [])
        self._checked_count = self._count()[1]
        self._unsubs.append(
            async_track_time_change(self.hass, self._on_midnight, hour=0, minute=0, second=5)
        )
        self._unsubs.append(
            async_track_time_interval(self.hass, self._on_tick, timedelta(minutes=5))
        )
        self._parse_madplan()
        self._feed_history()
        self.stats = self.history.compute(dt_util.now())
        self._on_tick(dt_util.now())

    async def async_stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        await self.store.async_save(self._data())

    def _data(self) -> dict:
        return {
            NOTE_INDKOB: self.indkob.as_dict(),
            NOTE_MADPLAN: self.madplan_note.as_dict(),
            "history": self.history.as_dict(),
            "trip": self.trip,
            "log": self.log,
        }

    def _save(self) -> None:
        self.store.async_delay_save(self._data, 2)

    @callback
    def _on_midnight(self, _now: datetime) -> None:
        self._parse_madplan()
        self.stats = self.history.compute(dt_util.now())
        self._notify()

    # ------------------------------------------------------------ redigeringslog
    LOG_MAX = 500

    def _last_log(self, key: str, user: str, window: float) -> dict | None:
        """Seneste logpost, hvis den kan slås sammen med en ny (samme nøgle, person, kort tid)."""
        if not self.log:
            return None
        last = self.log[-1]
        if last.get("k") != key or last["bruger"] != user:
            return None
        if (dt_util.now() - dt_util.parse_datetime(last["t"])).total_seconds() > window:
            return None
        return last

    def _log(self, user: str | None, note: str, tekst: str, key: str | None = None,
             window: float = 180, **extra: Any) -> None:
        user = user or "Ukendt"
        now = dt_util.now().isoformat(timespec="seconds")
        last = self._last_log(key, user, window) if key else None
        if last is not None:
            last.update(t=now, tekst=tekst, **extra)
            return
        entry = {"t": now, "bruger": user, "note": note, "tekst": tekst, **extra}
        if key:
            entry["k"] = key
        self.log.append(entry)
        del self.log[: max(0, len(self.log) - self.LOG_MAX)]

    # ------------------------------------------------------------ listeners
    @callback
    def add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        self._listeners.add(listener)

        @callback
        def _remove() -> None:
            self._listeners.discard(listener)

        return _remove

    @callback
    def _notify(self) -> None:
        async_dispatcher_send(self.hass, f"{SIGNAL_UPDATE}_{self.entry.entry_id}")
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Fejl i lytter")

    # ------------------------------------------------------------ indkøbsliste
    def _history_items(self) -> list[dict]:
        return [
            {"uid": ln["id"], "summary": ln["text"], "status": "completed" if ln["checked"] else "needs_action"}
            for ln in self.indkob.items()
        ]

    def _feed_history(self) -> None:
        new = self.history.apply_items(self._history_items(), dt_util.now())
        if new:
            _LOGGER.debug("Indkøbshændelser: %s", new)

    @callback
    def indkob_changed(self, user: str | None = None) -> None:
        """Kaldes efter hver ændring af indkøbslisten."""
        n = self.indkob
        n.version += 1
        n.updated = dt_util.now().isoformat(timespec="seconds")
        n.updated_by = user
        n.learn_categories()
        self._feed_history()
        self._track_trip()
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ indkøbstur
    def _count(self) -> tuple[int, int]:
        items = self.indkob.items()
        return len(items), sum(1 for ln in items if ln["checked"])

    def _track_trip(self) -> None:
        """Registrér at der handles ind, når min. tærsklen af varerne er krydset af."""
        total, checked = self._count()
        now = dt_util.now().isoformat(timespec="seconds")
        more = checked > self._checked_count
        self._checked_count = checked
        if total and checked and checked / total >= self.trip_threshold:
            if self.trip is None:
                self.trip = {"start": now, "sidste_flueben": now}
                _LOGGER.debug("Indkøbstur registreret (%s/%s afkrydset)", checked, total)
            elif more:
                self.trip["sidste_flueben"] = now
        elif self.trip is not None:
            _LOGGER.debug("Indkøbstur annulleret (%s/%s afkrydset)", checked, total)
            self.trip = None

    def trip_due(self) -> datetime | None:
        if not self.trip:
            return None
        return dt_util.parse_datetime(self.trip["sidste_flueben"]) + self.trip_delay

    @callback
    def _on_tick(self, _now: datetime) -> None:
        due = self.trip_due()
        if due and dt_util.now() >= due:
            self.finish_trip("Automatisk", auto=True)

    @callback
    def finish_trip(self, user: str | None = None, *, auto: bool = False, delete: bool = False) -> int:
        """Afslut indkøbet: log turen og fjern fluebenene (eller de afkrydsede varer).

        Købene er allerede registreret ved afkrydsning – her sættes kun en ny
        grundlinje, så nulstillingen hverken fortryder køb eller tæller som tilføjelser.
        """
        checked = [ln for ln in self.indkob.items() if ln["checked"]]
        if checked:
            when = dt_util.parse_datetime(self.trip["sidste_flueben"]) if self.trip else dt_util.now()
            trip = self.history.add_trip(when, [ln["text"] for ln in checked], auto)
            self.hass.bus.async_fire(
                EVENT_HANDLET_IND,
                {"tidspunkt": trip["t"], "antal": len(trip["varer"]), "varer": trip["varer"], "automatisk": auto},
            )
        if delete:
            n = self.indkob.clear_checked()
        else:
            n = len(checked)
            for ln in self.indkob.lines:
                ln["checked"] = False
        if checked:
            if auto:
                self._log("Automatisk", "indkob", f"handlet ind – fluebenene ved {len(checked)} varer blev fjernet automatisk")
            elif delete:
                self._log(user, "indkob", f"slettede {len(checked)} afkrydsede varer: " + _names([ln['text'] for ln in checked], 6))
            else:
                self._log(user, "indkob", f"fjernede alle flueben ({len(checked)} varer)")
        self.trip = None
        self._checked_count = 0
        n_ = self.indkob
        n_.version += 1
        n_.updated = dt_util.now().isoformat(timespec="seconds")
        n_.updated_by = user
        n_.learn_categories()
        self.history.set_baseline(self._history_items())
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()
        return n

    @callback
    def add_item(self, text: str, user: str | None = None, **kwargs: Any) -> dict:
        line = self.indkob.add(text, **kwargs)
        if text.strip():
            self._log(user, "indkob", f'tilføjede "{text.strip()}"')
        self.indkob_changed(user)
        return line

    @callback
    def add_items_auto(self, texts: list[str], user: str | None = None) -> list[dict]:
        lines = [self.indkob.add(t, line_type=TYPE_ITEM, auto_place=True) for t in texts if t.strip()]
        if lines:
            self._log(user, "indkob", "tilføjede " + _names([ln["text"] for ln in lines]))
            self.indkob_changed(user)
        return lines

    @callback
    def update_line(self, line_id: str, user: str | None = None, *, text: str | None = None,
                    checked: bool | None = None, line_type: str | None = None) -> dict:
        old = dict(self.indkob.get(line_id))
        ln = self.indkob.update(line_id, text=text, checked=checked, line_type=line_type)
        u = user or "Ukendt"
        name = (ln["text"].strip() or old["text"].strip())
        if ln["type"] == TYPE_ITEM and ln["checked"] != old["checked"] and name:
            self._log(user, "indkob", f'krydsede "{name}" af' if ln["checked"] else f'fjernede fluebenet ved "{name}"',
                      key=f"chk:{line_id}")
        if text is not None and text.strip() != old["text"].strip():
            key = f"txt:{line_id}"
            last = self._last_log(key, u, 300)
            fra = last["fra"] if last else old["text"].strip()
            ny = text.strip()
            if not fra and not ny:
                pass
            elif not fra:
                self._log(user, "indkob", f'tilføjede "{ny}"', key=key, window=300, fra="")
            elif not ny:
                if last and not last["fra"]:
                    self.log.remove(last)  # tilføjet og tømt igen – intet at logge
                else:
                    self._log(user, "indkob", f'slettede "{fra}"', key=key, window=300, fra=fra)
            elif fra != ny:
                self._log(user, "indkob", f'rettede "{fra}" til "{ny}"', key=key, window=300, fra=fra)
            elif last:
                self.log.remove(last)  # rettet tilbage til det oprindelige
        if line_type is not None and line_type != old["type"] and name and ln["text"].strip():
            if line_type == "header":
                self._log(user, "indkob", f'gjorde "{name}" til overskrift')
            elif old["type"] == "header":
                self._log(user, "indkob", f'gjorde "{name}" til vare')
        self.indkob_changed(user)
        return ln

    @callback
    def delete_lines(self, line_ids: list[str], user: str | None = None) -> None:
        names = []
        for lid in line_ids:
            try:
                if t := self.indkob.get(lid)["text"].strip():
                    names.append(t)
            except KeyError:
                pass
        self.indkob.delete(line_ids)
        if names:
            self._log(user, "indkob", "slettede " + _names(names))
        self.indkob_changed(user)

    @callback
    def move_line(self, line_id: str, after_id: str | None, user: str | None = None) -> None:
        name = self.indkob.get(line_id)["text"].strip()
        self.indkob.move(line_id, after_id)
        if name:
            self._log(user, "indkob", f'flyttede "{name}"', key=f"mv:{line_id}")
        self.indkob_changed(user)

    # ------------------------------------------------------------ madplan
    def _parse_madplan(self) -> None:
        try:
            self.madplan = parse_madplan(self.madplan_note.text, dt_util.now().date())
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Fejl ved læsning af madplanen")
            self.madplan = {}

    @callback
    def set_madplan(self, text: str, base_version: int | None = None, user: str | None = None) -> None:
        n = self.madplan_note
        if base_version is not None and base_version != n.version and text != n.text:
            raise ConflictError
        if text == n.text:
            return
        n.text = text
        n.version += 1
        n.updated = dt_util.now().isoformat(timespec="seconds")
        n.updated_by = user
        self._log(user, "madplan", "importerede madplanen" if user == "Import" else "ændrede madplanen",
                  key="madplan", window=900)
        self._parse_madplan()
        self._save()
        self._notify()

    def dag(self, offset: int) -> dict | None:
        d = dt_util.now().date() + timedelta(days=offset)
        dag = self.madplan.get(d)
        return dag.as_dict(self.koed_ord, DEFAULT_REST_ORD) if dag else None

    def uge(self, start: int = -1, days: int = 8) -> list[dict]:
        today = dt_util.now().date()
        out = []
        for i in range(start, start + days):
            d = today + timedelta(days=i)
            dag = self.madplan.get(d)
            if dag:
                item = dag.as_dict(self.koed_ord, DEFAULT_REST_ORD)
            else:
                item = {
                    "dato": d.isoformat(), "ugedag": UGEDAGE[d.weekday()], "ret": "", "noter": [],
                    "stor_portion": False, "kraever_optoening": False, "koed": [], "raw": "",
                }
            item["offset"] = i
            out.append(item)
        return out

    def frost_dag(self) -> dict | None:
        return self.dag(1 if self.frost_tomorrow else 0)

    # ------------------------------------------------------------ statistik
    async def async_clear_history(self) -> None:
        self.clear_history("Home Assistant")

    @callback
    def clear_history(self, user: str | None = None) -> None:
        self._log(user, "statistik", "nulstillede statistikken og indkøbshistorikken")
        self.history.events = []
        self.history.names = {}
        self.history.trips = []
        self.history.set_baseline(self._history_items())
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ indkøbshistorik
    @callback
    def update_trip(self, trip_id: str, betalinger: list[dict], user: str | None = None) -> dict:
        tr = self.history.get_trip(trip_id)
        tr["betalinger"] = _clean_payments(betalinger)
        self._log(user, "historik", f"angav pris for indkøbet {_dato(tr['t'])}: {_payments_text(tr['betalinger'])}",
                  key=f"trip:{trip_id}", window=600)
        self._trips_changed()
        return tr

    @callback
    def add_manual_trip(self, dato: date, betalinger: list[dict], user: str | None = None) -> dict:
        now = dt_util.now()
        when = now if dato == now.date() else datetime.combine(dato, now.time().replace(second=0, microsecond=0), now.tzinfo)
        tr = self.history.add_trip(when, [], False)
        tr["manuel"] = True
        tr["betalinger"] = _clean_payments(betalinger)
        self._log(user, "historik", f"tilføjede et indkøb {_dato(tr['t'])}: {_payments_text(tr['betalinger'])}",
                  key=f"trip:{tr['id']}", window=600)
        self._trips_changed()
        return tr

    @callback
    def delete_trip(self, trip_id: str, user: str | None = None) -> None:
        tr = self.history.delete_trip(trip_id)
        self._log(user, "historik", f"slettede indkøbet {_dato(tr['t'])}")
        self._trips_changed()

    def _trips_changed(self) -> None:
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ views
    def state(self) -> dict:
        """Alt hvad panel og kort skal bruge."""
        return {
            "indkob": {
                **{k: v for k, v in self.indkob.as_dict().items() if k != "categories"},
                "tur": {
                    "aktiv": self.trip is not None,
                    "start": self.trip["start"] if self.trip else None,
                    "nulstilles": due.isoformat(timespec="minutes") if (due := self.trip_due()) else None,
                    "taerskel": round(self.trip_threshold * 100),
                    "timer": self.trip_delay.total_seconds() / 3600,
                },
            },
            "madplan": {
                **self.madplan_note.as_dict(),
                "dage": self.uge(-1, 9),
                "frost_dag": "i morgen" if self.frost_tomorrow else "i dag",
            },
            "stats": {k: v for k, v in self.stats.items() if k != "varer"},
            "indstillinger": self.settings(),
            "historik": self.history.trip_overview(dt_util.now()),
            "log": [{k: v for k, v in e.items() if k not in ("k", "fra")} for e in reversed(self.log[-150:])],
        }


SETTING_LABELS = {
    CONF_TRIP_THRESHOLD: "Handlet ind ved",
    CONF_TRIP_DELAY: "Fjern flueben efter",
    CONF_FROST_DAY: "Optøning gælder",
    CONF_EXTRA_KOED: "Ekstra kød-ord",
    CONF_IGNORE_KOED: "Ord uden optøning",
}


def _names(names: list[str], limit: int = 4) -> str:
    q = [f'"{n.strip()}"' for n in names if n.strip()]
    if len(q) <= limit:
        return ", ".join(q[:-1]) + (" og " if len(q) > 1 else "") + q[-1] if q else ""
    return ", ".join(q[:limit]) + f" og {len(q) - limit} andre"


def _dato(iso: str) -> str:
    d = dt_util.parse_datetime(iso)
    return f"{d.day}/{d.month}" if d else iso[:10]


def _kr(v: float) -> str:
    s = f"{v:,.2f}".replace(",", " ").replace(".", ",").replace(" ", ".")
    return (s[:-3] if s.endswith(",00") else s) + " kr"


def _clean_payments(betalinger: list[dict]) -> list[dict]:
    out = []
    for b in betalinger:
        butik = str(b.get("butik") or "").strip()[:60]
        try:
            beloeb = round(float(b.get("beloeb") or 0), 2)
        except (TypeError, ValueError):
            beloeb = 0.0
        if butik or beloeb:
            out.append({"butik": butik, "beloeb": beloeb})
    return out


def _payments_text(betalinger: list[dict]) -> str:
    if not betalinger:
        return "ingen pris"
    return ", ".join(f"{b['butik'] or 'ukendt butik'} {_kr(b['beloeb'])}" for b in betalinger)

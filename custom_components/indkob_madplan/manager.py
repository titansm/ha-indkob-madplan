"""Kernen: ejer de to noter, logger køb og leverer madplanen."""

from __future__ import annotations

import logging
import re
import uuid
from collections import Counter
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
    CONF_PLAN_KALENDER,
    CONF_TRIP_DELAY,
    CONF_TRIP_THRESHOLD,
    DEFAULT_TRIP_DELAY,
    DEFAULT_TRIP_THRESHOLD,
    EVENT_BUTIK_AFSLUTTET,
    EVENT_HANDLET_IND,
    FROST_TODAY,
    FROST_SKIFT_TIME,
    FROST_TOMORROW,
    NOTE_BASIS,
    NOTE_INDKOB,
    NOTE_MADPLAN,
    SIGNAL_UPDATE,
    STORAGE_KEY,
    STORAGE_KEY_OPSKRIFTER,
    STORAGE_VERSION,
    VERSION,
)
from .madplan import DEFAULT_KOED_ORD, DEFAULT_REST_ORD, UGEDAGE, Dag, dish_key, parse_madplan, retter
from .notes import TYPE_ITEM, ShoppingNote, TextNote
from . import kategorier as kat
from . import opskrifter as op
from . import planner as pl
from .stats import History, clean_names, normalize

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
        # Basislisten: de faste varer, som indkøbslisten nulstilles til efter hvert indkøb
        self.basis = ShoppingNote()
        self.last_finished_trip: str | None = None  # id på turen, "Færdig med at handle" sidst gemte
        self.madplan_note = TextNote()
        self.history = History()
        self.madplan: dict[date, Dag] = {}
        self.stats: dict[str, Any] = {}
        self._unsubs: list[CALLBACK_TYPE] = []
        self._listeners: set[Callable[[], None]] = set()
        # Indkøbstur: sat når min. X % af varerne er krydset af.
        # {"start": iso, "sidste_flueben": iso, "stops": [...], "hist_id": str}
        # stops = butikker afsluttet i Handl: {"id", "butik", "beloeb", "t", "line_ids"}
        self.trip: dict[str, str] | None = None
        self._checked_count = 0
        # Redigeringslog: [{"t", "bruger", "note", "tekst", "k"?}] – nyeste sidst
        self.log: list[dict] = []
        # Ugeplanlæggeren: retter I ikke vil have foreslået igen
        self.planner_data: dict[str, Any] = {"skjulte": []}
        # Opskriftsbanken: importerede opskrifter, omregning og jeres egne indkøbslister til retter
        self.bank_store: Store = Store(hass, 1, STORAGE_KEY_OPSKRIFTER)
        self.bank = op.Opskriftsbank()
        self._egne_cache: tuple | None = None
        self._katalog_cache: tuple | None = None
        self._bank_dirty = False

    # ------------------------------------------------------------ options
    @property
    def opts(self) -> dict[str, Any]:
        return {**self.entry.data, **self.entry.options}

    @property
    def frost_tomorrow(self) -> bool:
        """Gælder optøningen morgendagens ret?

        Altid, når indstillingen er "retten i morgen". Ellers fra kl. 18 (FROST_SKIFT_TIME),
        hvor dagens aftensmad er spist – så viser kort/sensor, hvad der skal op til i morgen.
        """
        if self.opts.get(CONF_FROST_DAY) == FROST_TOMORROW:
            return True
        return dt_util.now().hour >= FROST_SKIFT_TIME

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
            CONF_PLAN_KALENDER: self.plan_kalender or "",
            "kalendere": self._kalendere(),
            "skjulte_retter": list(self.planner_data.get("skjulte", [])),
            "standard_koed_ord": DEFAULT_KOED_ORD,
            "rest_ord": DEFAULT_REST_ORD,
            "version": VERSION,
        }

    @callback
    def set_settings(self, changes: dict[str, Any], user: str | None = None) -> dict[str, Any]:
        """Gem ændrede indstillinger i integrationens options (uden genindlæsning)."""
        keys = (CONF_FROST_DAY, CONF_EXTRA_KOED, CONF_IGNORE_KOED, CONF_TRIP_THRESHOLD, CONF_TRIP_DELAY, CONF_PLAN_KALENDER)
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
                elif k == CONF_PLAN_KALENDER:
                    st = self.hass.states.get(v) if v else None
                    vis = (st.name if st else v) or "ingen"
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
        self.planner_data = {"skjulte": [], **(data.get("planner") or {})}
        try:
            self.bank = op.Opskriftsbank(await self.bank_store.async_load())
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Kunne ikke læse opskriftsbanken – starter tom")
            self.bank = op.Opskriftsbank()
        if self.indkob.sanitize():
            _LOGGER.info("Indkøbslisten ryddet op (tomme linjer med flueben)")
        if data.get(NOTE_BASIS) is None:
            # Første start med basisliste (≤ 0.7.0): listen var en fast "master-liste",
            # så den bliver udgangspunktet for basislisten.
            self.basis = self.indkob.copy_structure()
            self.basis.updated = dt_util.now().isoformat(timespec="seconds")
            self.basis.updated_by = "Automatisk"
            _LOGGER.info("Basislisten oprettet ud fra indkøbslisten (%s varer)", len(self.basis.items()))
            self._log("Automatisk", "basis", f"oprettede basislisten ud fra indkøbslisten ({len(self.basis.items())} varer)")
        else:
            self.basis = ShoppingNote(data.get(NOTE_BASIS))
            self.basis.sanitize()
            self.basis.uncheck_all()
        self._checked_count = self._count()[1]
        self._unsubs.append(
            async_track_time_change(self.hass, self._on_midnight, hour=0, minute=0, second=5)
        )
        self._unsubs.append(
            async_track_time_change(self.hass, self._on_frost_skift, hour=FROST_SKIFT_TIME, minute=0, second=5)
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
        if self._bank_dirty:  # kun hvis noget er ændret (en fejlet indlæsning må aldrig overskrive filen)
            await self.bank_store.async_save(self.bank.as_dict())

    def _data(self) -> dict:
        return {
            NOTE_INDKOB: self.indkob.as_dict(),
            NOTE_BASIS: self.basis.as_dict(),
            NOTE_MADPLAN: self.madplan_note.as_dict(),
            "history": self.history.as_dict(),
            "trip": self.trip,
            "log": self.log,
            "planner": self.planner_data,
        }

    def _save(self) -> None:
        self.store.async_delay_save(self._data, 2)

    def _save_bank(self) -> None:
        self._bank_dirty = True
        self.bank_store.async_delay_save(self.bank.as_dict, 2)

    @callback
    def _on_frost_skift(self, _now: datetime) -> None:
        """Kl. 18: optøningen skifter fra dagens til morgendagens ret."""
        self._notify()

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

    def _note(self, note: str | None) -> ShoppingNote:
        """Den tjekliste en kommando gælder: indkøbslisten (standard) eller basislisten."""
        if note == NOTE_BASIS:
            return self.basis
        if note in (None, NOTE_INDKOB):
            return self.indkob
        raise ValueError(f"Ukendt note: {note}")

    @callback
    def indkob_changed(self, user: str | None = None, note: str | None = None) -> None:
        """Kaldes efter hver ændring af indkøbslisten (eller basislisten)."""
        n = self._note(note)
        n.version += 1
        n.updated = dt_util.now().isoformat(timespec="seconds")
        n.updated_by = user
        n.learn_categories()
        if n is self.basis:
            n.uncheck_all()  # basislisten har ingen flueben
            self._save()
            self._notify()
            return
        self._feed_history()
        self._track_trip()
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ basisliste
    def is_fast(self, text: str) -> bool:
        """Står varen i basislisten (er den en fast vare)?"""
        return self.basis.find_item(text) is not None

    @callback
    def set_fast(self, line_id: str, fast: bool, user: str | None = None) -> bool:
        """Gør en vare på indkøbslisten fast (sæt den i basislisten) eller engangs (fjern den)."""
        ln = self.indkob.get(line_id)
        name = ln["text"].strip()
        if ln["type"] != TYPE_ITEM or not name:
            raise ValueError("Kun varer kan være faste")
        ex = self.basis.find_item(name)
        if fast and ex is None:
            self.basis.add_under(name, self.indkob.category_of(line_id))
            self._log(user, "basis", f'gjorde "{name}" til en fast vare')
        elif not fast and ex is not None:
            self.basis.delete([x["id"] for x in self.basis.items() if normalize(x["text"]) == normalize(ex["text"])])
            self._log(user, "basis", f'fjernede "{name}" fra basislisten')
        else:
            return fast
        self.indkob_changed(user, NOTE_BASIS)
        return fast

    def _reset_to_basis(self, user: str | None) -> tuple[int, int]:
        """Nulstil listen til basislisten efter et indkøb.

        Købte engangsvarer (afkrydsede, ikke i basislisten) slettes, alle flueben
        fjernes, og faste varer der mangler sættes tilbage under deres kategori.
        Ukøbte engangsvarer bliver stående. Returnerer (slettet, sat tilbage).
        """
        if not self.basis.items():
            self.indkob.uncheck_all()
            return 0, 0
        slet = [ln for ln in self.indkob.items() if ln["checked"] and not self.is_fast(ln["text"])]
        if slet:
            self.indkob.delete([ln["id"] for ln in slet])
        for ln in self.indkob.items():
            if ln["checked"]:
                ln.pop("ret", None)  # købt til ugens retter – den faste vare starter forfra
        self.indkob.uncheck_all()
        tilbage = []
        for b in self.basis.items():
            if self.indkob.find_item(b["text"]) is None:
                header = self.indkob.learned_header(b["text"]) or self.basis.category_of(b["id"])
                tilbage.append(self.indkob.add_under(b["text"], header))
        if slet:
            self._log(user, "indkob", f"fjernede {len(slet)} købte engangsvarer: " + _names([ln["text"] for ln in slet], 6))
        if tilbage:
            self._log(user, "indkob", f"satte {len(tilbage)} faste varer tilbage på listen: " + _names([ln["text"] for ln in tilbage], 6))
        return len(slet), len(tilbage)

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
        if self._stops():
            # Mindst én butik er afsluttet med knappen: turen annulleres ikke.
            # Varer, der får fjernet fluebenet, hører ikke længere til butikken.
            checked_lines = {ln["id"]: ln["text"] for ln in self.indkob.items() if ln["checked"]}
            for st in list(self._stops()):
                keep = [i for i in st["line_ids"] if i in checked_lines]
                if len(keep) == len(st["line_ids"]):
                    continue
                if not keep:
                    # Alle varer fra butikken fik fluebenet fjernet igen: butikken (og dens pris) udgår
                    _LOGGER.debug("Butikken %s har ingen varer tilbage – fjernes fra turen", st["butik"])
                    self.undo_store(st["id"], "Automatisk", _notify=False)
                    continue
                st["line_ids"] = keep
                if b := self._stop_payment(st["id"]):
                    b["varer"] = clean_names([checked_lines[i] for i in keep])
                    tr = self._hist_trip()
                    tr["varer"] = [n for x in tr["betalinger"] for n in x.get("varer", [])]
            if not self._stops():
                return self._track_trip()  # ingen butikker tilbage: tærsklen gælder igen
            if more:
                self.trip["sidste_flueben"] = now
            return
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
    def finish_trip(self, user: str | None = None, *, auto: bool = False, delete: bool = False,
                    butik: str | None = None, beloeb: float | None = None, fjern: list[str] | None = None) -> int:
        """Afslut indkøbet: log turen og fjern fluebenene (eller de afkrydsede varer).

        Købene er allerede registreret ved afkrydsning – her sættes kun en ny
        grundlinje, så nulstillingen hverken fortryder køb eller tæller som tilføjelser.

        "Færdig med at handle" kan samtidig gemme butik + beløb for varerne i kurven
        (`butik`/`beloeb`) og fjerne ukøbte engangsvarer, der ikke skal med næste gang (`fjern`).
        """
        self.last_finished_trip = None
        butik = (butik or "").strip()
        if butik:
            bought = self.bought()
            if any(ln["checked"] and ln["id"] not in bought and ln["text"].strip() for ln in self.indkob.items()):
                self.finish_store(butik, beloeb, user)
        elif beloeb:
            raise ValueError("Skriv hvilken butik I har handlet i")
        if fjern:
            ids = set(fjern)
            ukoebt = [ln for ln in self.indkob.items()
                      if ln["id"] in ids and not ln["checked"] and not self.is_fast(ln["text"])]
            if ukoebt:
                self.indkob.delete([ln["id"] for ln in ukoebt])
                self._log(user, "indkob", f"fjernede {len(ukoebt)} engangsvarer, der ikke blev købt: "
                          + _names([ln["text"] for ln in ukoebt], 6))
        checked = [ln for ln in self.indkob.items() if ln["checked"]]
        trip = self._hist_trip()
        if checked or trip:
            when = dt_util.parse_datetime(self.trip["sidste_flueben"]) if self.trip else dt_util.now()
            if trip:  # turen blev oprettet, da den første butik blev afsluttet
                names = [n for b in trip["betalinger"] for n in b.get("varer", [])]
                names += [n for n in clean_names([ln["text"] for ln in checked]) if n not in names]
                trip.update(t=when.isoformat(timespec="seconds"), varer=names, auto=auto)
                self.history.trips.sort(key=lambda x: x["t"])
            else:
                trip = self.history.add_trip(when, [ln["text"] for ln in checked], auto)
            self.last_finished_trip = trip["id"]
            self.hass.bus.async_fire(
                EVENT_HANDLET_IND,
                {"tidspunkt": trip["t"], "antal": len(trip["varer"]), "varer": trip["varer"], "automatisk": auto,
                 "trip_id": trip["id"], "beloeb": round(sum(b.get("beloeb", 0) for b in trip.get("betalinger", [])), 2),
                 "mangler_pris": _mangler_pris(trip)},
            )
        if delete:
            n = self.indkob.clear_checked()
            if checked:
                self._log(user, "indkob", f"slettede {len(checked)} afkrydsede varer: " + _names([ln['text'] for ln in checked], 6))
            self._reset_to_basis(user)  # faste varer kommer altid tilbage
        else:
            n = len(checked)
            if checked:
                if auto:
                    self._log("Automatisk", "indkob", f"handlet ind – listen nulstilles automatisk ({len(checked)} varer var krydset af)")
                else:
                    self._log(user, "indkob", f"afsluttede indkøbet og nulstillede listen ({len(checked)} varer var krydset af)")
            self._reset_to_basis("Automatisk" if auto else user)
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

    # ------------------------------------------------------------ butik afsluttet (Handl)
    def _stops(self) -> list[dict]:
        return self.trip.setdefault("stops", []) if self.trip else []

    def bought(self) -> dict[str, str]:
        """Linje-id -> butik for varer købt i en butik, der er afsluttet på denne tur."""
        return {i: st["butik"] for st in self._stops() for i in st["line_ids"]}

    def _hist_trip(self) -> dict | None:
        """Turens post i indkøbshistorikken (findes, når mindst én butik er afsluttet)."""
        hid = self.trip.get("hist_id") if self.trip else None
        if not hid:
            return None
        try:
            return self.history.get_trip(hid)
        except KeyError:  # slettet i historikken imens
            self.trip.pop("hist_id", None)
            return None

    def _stop(self, stop_id: str) -> dict:
        for st in self._stops():
            if st["id"] == stop_id:
                return st
        raise KeyError(stop_id)

    def _stop_payment(self, stop_id: str) -> dict | None:
        tr = self._hist_trip()
        return next((b for b in tr["betalinger"] if b.get("stop") == stop_id), None) if tr else None

    @callback
    def finish_store(self, butik: str, beloeb: float | None, user: str | None = None) -> dict:
        """Afslut indkøbet i én butik: de nye afkrydsede varer + (valgfri) pris gemmes."""
        butik = (butik or "").strip()[:60]
        if not butik:
            raise ValueError("Skriv hvilken butik I har handlet i")
        bought = self.bought()
        lines = [ln for ln in self.indkob.items() if ln["checked"] and ln["id"] not in bought and ln["text"].strip()]
        if not lines:
            raise ValueError("Der er ingen nye afkrydsede varer")
        now = dt_util.now()
        iso = now.isoformat(timespec="seconds")
        if self.trip is None:
            self.trip = {"start": iso, "sidste_flueben": iso}
        self.trip["sidste_flueben"] = iso  # fluebenene fjernes først X timer efter sidste butik
        tr = self._hist_trip()
        if tr is None:
            tr = self.history.add_trip(now, [], False)
            self.trip["hist_id"] = tr["id"]
        beloeb = round(float(beloeb or 0), 2)
        stop = {"id": uuid.uuid4().hex[:8], "butik": butik, "beloeb": beloeb, "t": iso,
                "line_ids": [ln["id"] for ln in lines]}
        self._stops().append(stop)
        varer = clean_names([ln["text"] for ln in lines])
        tr["betalinger"].append({"butik": butik, "beloeb": beloeb, "varer": varer, "t": iso, "stop": stop["id"]})
        tr["varer"] = [n for b in tr["betalinger"] for n in b.get("varer", [])]
        tr["t"] = iso
        self.history.trips.sort(key=lambda x: x["t"])
        self._log(user, "indkob", f"afsluttede indkøbet i {butik}: {len(varer)} varer"
                  + (f", {_kr(beloeb)}" if beloeb else ""), key=f"stop:{stop['id']}", window=600)
        self.hass.bus.async_fire(EVENT_BUTIK_AFSLUTTET, {
            "butik": butik, "beloeb": beloeb, "antal": len(varer), "varer": varer, "tidspunkt": iso,
        })
        self._trips_changed()
        return {"stop_id": stop["id"], "butik": butik, "beloeb": beloeb, "antal": len(varer), "trip_id": tr["id"]}

    @callback
    def edit_store(self, stop_id: str, butik: str, beloeb: float | None, user: str | None = None) -> dict:
        """Ret butik/pris for en afsluttet butik på den aktive tur."""
        st = self._stop(stop_id)
        butik = (butik or "").strip()[:60] or st["butik"]
        st.update(butik=butik, beloeb=round(float(beloeb or 0), 2))
        if b := self._stop_payment(stop_id):
            b.update(butik=st["butik"], beloeb=st["beloeb"])
        self._log(user, "indkob", f"rettede indkøbet i {butik}: " + (_kr(st["beloeb"]) if st["beloeb"] else "ingen pris"),
                  key=f"stop:{stop_id}", window=600)
        self._trips_changed()
        return {"stop_id": stop_id, "butik": st["butik"], "beloeb": st["beloeb"]}

    @callback
    def undo_store(self, stop_id: str, user: str | None = None, *, _notify: bool = True) -> None:
        """Fortryd "Afslut indkøb i butik" – varerne forbliver afkrydsede."""
        st = self._stop(stop_id)
        self._stops().remove(st)
        if tr := self._hist_trip():
            tr["betalinger"] = [b for b in tr["betalinger"] if b.get("stop") != stop_id]
            tr["varer"] = [n for b in tr["betalinger"] for n in b.get("varer", [])]
            if not tr["betalinger"]:
                self.history.delete_trip(tr["id"])
                self.trip.pop("hist_id", None)
        if user == "Automatisk":
            self._log(user, "indkob", f"indkøbet i {st['butik']} udgik – alle varerne fik fluebenet fjernet")
        else:
            self._log(user, "indkob", f"fortrød afslutningen af indkøbet i {st['butik']}")
        if not _notify:
            return  # kaldt fra _track_trip, som selv gør resten
        self._track_trip()  # uden butikker gælder tærsklen igen
        self._trips_changed()

    def _existing(self, text: str, note: str | None = None) -> dict | None:
        """Samme vare på listen i forvejen (listen er en fast liste – ingen dubletter)."""
        return self._note(note).find_item(text)

    @callback
    def add_item(self, text: str, user: str | None = None, *, restore: bool = False, dedupe: bool = False,
                 note: str | None = None, **kwargs: Any) -> dict:
        n = self._note(note)
        if (kwargs.get("auto_place") or dedupe) and not restore and (ex := n.find_item(text)):
            # Varen står der allerede: fjern evt. fluebenet i stedet for at lave en dublet
            if ex["checked"]:
                self.update_line(ex["id"], user, checked=False, note=note)
            return ex
        if n is self.basis:
            kwargs["checked"] = False
        line = n.add(text, **kwargs)
        if restore and line["checked"] and self.history.snapshot is not None:
            # Gendannet med flueben: købet er allerede talt – må ikke tælle igen.
            self.history.snapshot[line["id"]] = {"s": line["text"], "st": "completed"}
        if text.strip():
            self._log(user, note or NOTE_INDKOB, f'{"gendannede" if restore else "tilføjede"} "{text.strip()}"')
        self.indkob_changed(user, note)
        return line

    def known_names(self) -> list[str]:
        """Varenavne til autofuldførelse: alt der står på listen nu + alt der er købt før."""
        seen: dict[str, str] = {}
        for ln in self.indkob.items() + self.basis.items():
            seen.setdefault(ln["text"].strip().lower(), ln["text"].strip())
        for name in self.history.names.values():
            if name.strip():
                seen.setdefault(name.strip().lower(), name.strip())
        return sorted(seen.values(), key=str.lower)[:400]

    @callback
    def add_items_auto(self, texts: list[str], user: str | None = None) -> list[dict]:
        lines, new = [], []
        for t in texts:
            if not t.strip():
                continue
            if ex := self._existing(t):
                if ex["checked"]:
                    self.indkob.update(ex["id"], checked=False)
                    self._log(user, "indkob", f'satte "{ex["text"].strip()}" på listen igen')
                lines.append(ex)
                continue
            ln = self.indkob.add(t, line_type=TYPE_ITEM, auto_place=True)
            lines.append(ln)
            new.append(ln)
        if new:
            self._log(user, "indkob", "tilføjede " + _names([ln["text"] for ln in new]))
        if lines:
            self.indkob_changed(user)
        return lines

    @callback
    def update_line(self, line_id: str, user: str | None = None, *, text: str | None = None,
                    checked: bool | None = None, line_type: str | None = None, note: str | None = None) -> dict:
        n = self._note(note)
        nn = note or NOTE_INDKOB
        old = dict(n.get(line_id))
        ln = n.update(line_id, text=text, checked=checked if n is self.indkob else False, line_type=line_type)
        u = user or "Ukendt"
        name = (ln["text"].strip() or old["text"].strip())
        if ln["type"] == TYPE_ITEM and ln["checked"] != old["checked"] and name:
            self._log(user, nn, f'krydsede "{name}" af' if ln["checked"] else f'fjernede fluebenet ved "{name}"',
                      key=f"chk:{line_id}")
        if text is not None and text.strip() != old["text"].strip():
            key = f"txt:{line_id}"
            last = self._last_log(key, u, 300)
            fra = last["fra"] if last else old["text"].strip()
            ny = text.strip()
            if not fra and not ny:
                pass
            elif not fra:
                self._log(user, nn, f'tilføjede "{ny}"', key=key, window=300, fra="")
            elif not ny:
                if last and not last["fra"]:
                    self.log.remove(last)  # tilføjet og tømt igen – intet at logge
                else:
                    self._log(user, nn, f'slettede "{fra}"', key=key, window=300, fra=fra)
            elif fra != ny:
                self._log(user, nn, f'rettede "{fra}" til "{ny}"', key=key, window=300, fra=fra)
            elif last:
                self.log.remove(last)  # rettet tilbage til det oprindelige
        if line_type is not None and line_type != old["type"] and name and ln["text"].strip():
            if line_type == "header":
                self._log(user, nn, f'gjorde "{name}" til overskrift')
            elif old["type"] == "header":
                self._log(user, nn, f'gjorde "{name}" til vare')
        self.indkob_changed(user, note)
        return ln

    @callback
    def delete_lines(self, line_ids: list[str], user: str | None = None, note: str | None = None) -> None:
        n = self._note(note)
        names = []
        for lid in line_ids:
            try:
                if t := n.get(lid)["text"].strip():
                    names.append(t)
            except KeyError:
                pass
        n.delete(line_ids)
        if names:
            self._log(user, note or NOTE_INDKOB, "slettede " + _names(names))
        self.indkob_changed(user, note)

    @callback
    def set_category(self, line_id: str, user: str | None = None, *, header_id: str | None = None,
                     noegle: str | None = None, note: str | None = None) -> str | None:
        """Flyt en vare til en anden kategori (læres til næste gang). Returnerer den nye overskrift."""
        n = self._note(note)
        name = n.get(line_id)["text"].strip()
        n.move_to_category(line_id, header_id=header_id, noegle=noegle)
        header = n.category_of(line_id)
        if name and header:
            self._log(user, note or NOTE_INDKOB, f'flyttede "{name}" til {header}', key=f"mv:{line_id}")
        self.indkob_changed(user, note)
        return header

    def category_of(self, line_id: str, note: str | None = None) -> str | None:
        try:
            return self._note(note).category_of(line_id)
        except KeyError:
            return None

    @callback
    def move_line(self, line_id: str, after_id: str | None, user: str | None = None, note: str | None = None) -> None:
        n = self._note(note)
        name = n.get(line_id)["text"].strip()
        n.move(line_id, after_id)
        if name:
            self._log(user, note or NOTE_INDKOB, f'flyttede "{name}"', key=f"mv:{line_id}")
        self.indkob_changed(user, note)

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

    def sidste_dato(self) -> str | None:
        """Sidste dato der er planlagt (bruges af "Ny uge", så den fortsætter hvor planen slap)."""
        return max(self.madplan).isoformat() if self.madplan else None

    def retter(self) -> dict:
        """Alle retter fra historikken med antal og hvornår de sidst var på planen (til inspiration)."""
        today = dt_util.now().date()
        alle = [
            {"dato": d.isoformat(), "ugedag": UGEDAGE[d.weekday()], "ret": dag.ret, "noter": dag.noter, "uge": dag.uge}
            for d, dag in sorted(self.madplan.items(), reverse=True)
            if dag.ret
        ]
        return {"version": self.madplan_note.version, "retter": retter(self.madplan, today, DEFAULT_REST_ORD), "dage": alle}

    # ------------------------------------------------------------ retter (opskrifter + jeres egne retter)
    def _egne_hist(self) -> dict[str, dict]:
        """Jeres egne retter fra madplanen (kendte navne samlet) – nøgle -> navn, antal, sidst."""
        today = dt_util.now().date()
        nøgle = (self.madplan_note.version, today)
        if self._egne_cache and self._egne_cache[0] == nøgle:
            return self._egne_cache[1]
        out: dict[str, dict] = {}
        try:
            aftener = pl.laes_historik(self.madplan)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Kunne ikke læse retter fra madplanen")
            aftener = []
        for a in aftener:
            if a.slags != "ret" or a.dato > today:
                continue
            key = dish_key(a.navn)
            if not key:
                continue
            it = out.setdefault(key, {"navn": a.navn, "antal": 0, "sidst": None})
            it["antal"] += 1
            it["sidst"] = a.dato.isoformat()
            it["navn"] = a.navn
        for navn in pl.RETTER:
            out.setdefault(dish_key(navn), {"navn": navn, "antal": 0, "sidst": None})
        self._egne_cache = (nøgle, out)
        return out

    def _egen_navn(self, eid: str) -> str:
        e = self.bank.egne.get(eid) or {}
        h = self._egne_hist().get(eid[2:])
        return e.get("navn") or (h or {}).get("navn") or eid[2:]

    def retter_katalog(self) -> dict:
        """Alle retter til noten "Retter": opskrifter + jeres egne retter med/uden indkøbsliste."""
        today = dt_util.now().date()
        nøgle = (self.bank.version, self.madplan_note.version, today)
        if self._katalog_cache and self._katalog_cache[0] == nøgle:
            return self._katalog_cache[1]
        b = self.bank
        items: list[dict] = []
        kogeb: Counter = Counter()
        for r in b.raa:
            rid = "r:" + r["id"]
            varer = b.varer(rid)
            for kb in r["kogeboger"]:
                kogeb[kb] += 1
            items.append({
                "id": rid, "type": "opskrift", "navn": op.paen_titel(r["titel"]), "kogeboger": r["kogeboger"],
                "billede": op.billede_url(r["billede"]), "tid": r["tid"]["total"] or None,
                "antal_varer": len(varer or []), "har_varer": bool(varer), "rettet": "varer" in b.egne.get(rid, {}),
                "gange": 0, "sidst": None, "soeg": " ".join(v["navn"].lower() for v in varer or []),
            })
        hist = self._egne_hist()
        ids = ["e:" + k for k in hist] + [i for i in b.egne if i.startswith("e:") and i[2:] not in hist]
        for eid in ids:
            h = hist.get(eid[2:]) or {}
            e = b.egne.get(eid) or {}
            varer = b.varer(eid)
            link = b.opskrift(e["opskrift"][2:]) if e.get("opskrift") else None
            items.append({
                "id": eid, "type": "egen", "navn": e.get("navn") or h.get("navn") or eid[2:], "kogeboger": [],
                "billede": op.billede_url(link["billede"]) if link else None, "tid": None,
                "antal_varer": len(varer or []), "har_varer": bool(varer), "rettet": "varer" in e,
                "opskrift": e.get("opskrift"), "gange": h.get("antal", 0), "sidst": h.get("sidst"),
                "soeg": " ".join(v["navn"].lower() for v in varer or []),
            })
        n_egne = len(ids)
        res = {
            "retter": items,
            "kogeboger": [{"navn": k, "antal": n} for k, n in sorted(kogeb.items(), key=lambda x: (-x[1], x[0]))],
            "antal": {"alle": len(items), "med_varer": sum(1 for i in items if i["har_varer"]),
                      "opskrifter": len(b.raa), "egne": n_egne,
                      "egne_med_varer": sum(1 for i in items if i["type"] == "egen" and i["har_varer"])},
            "importeret": b.importeret, "kilde": b.kilde,
            "version": f"{b.version}.{self.madplan_note.version}",
        }
        self._katalog_cache = (nøgle, res)
        return res

    def _vare_ud(self, v: dict) -> dict:
        return {"navn": v["navn"], "maengde": v.get("mængde"), "enhed": v.get("enhed") or "",
                "tekst": op.maengde_tekst(v), "liste": op.liste_tekst(v)}

    def ret_detalje(self, ret_id: str) -> dict:
        b = self.bank
        if ret_id.startswith("r:"):
            r = b.opskrift(ret_id[2:])
            if not r:
                raise ValueError("Opskriften findes ikke længere")
            k = b.konverteret()[r["id"]]
            e = b.egne.get(ret_id) or {}
            varer = b.varer(ret_id) or []
            return {
                "id": ret_id, "type": "opskrift", "navn": op.paen_titel(r["titel"]), "kogeboger": r["kogeboger"],
                "billede": op.billede_url(r["billede"]), "tid": r["tid"], "portioner": r["portioner"],
                "kokken": r["kokken"], "trin": r["trin"],
                "recime": f"https://www.recime.app/dashboard/recipes/{r['id']}", "kilde": op.kilde_url(r["kilde"]),
                "faktor": k["faktor"], "grundlag": k["grundlag"], "koed_g": k["koed_g"],
                "varer": [self._vare_ud(v) for v in varer], "har_varer": bool(varer),
                "rettet": "varer" in e, "standard_varer": [self._vare_ud(v) for v in k["varer"]],
                "har_vi_altid": k["har_vi_altid"], "ikke_tolket": k["ikke_tolket"],
                "original": [op.original_tekst(ln) for ln in r["linjer"]],
                "rettet_t": e.get("t"), "rettet_af": e.get("af"),
            }
        if not ret_id.startswith("e:"):
            raise ValueError("Ukendt ret")
        h = self._egne_hist().get(ret_id[2:]) or {}
        e = b.egne.get(ret_id) or {}
        if not h and not e:
            raise ValueError("Retten findes ikke længere")
        navn = e.get("navn") or h.get("navn") or ret_id[2:]
        varer = b.varer(ret_id) or []
        link = None
        if e.get("opskrift") and (lr := b.opskrift(e["opskrift"][2:])):
            link = {"id": e["opskrift"], "navn": op.paen_titel(lr["titel"]), "billede": op.billede_url(lr["billede"])}
        forslag = sorted(
            ((op.ligner(navn, op.paen_titel(r["titel"])), r) for r in b.raa), key=lambda x: -x[0])
        kanon = pl.kanonisk(navn) or navn
        return {
            "id": ret_id, "type": "egen", "navn": navn, "gange": h.get("antal", 0), "sidst": h.get("sidst"),
            "varer": [self._vare_ud(v) for v in varer], "har_varer": bool(varer), "egne_varer": "varer" in e,
            "opskrift": link,
            "forslag_opskrifter": [
                {"id": "r:" + r["id"], "navn": op.paen_titel(r["titel"]), "billede": op.billede_url(r["billede"])}
                for s, r in forslag[:4] if s >= 0.5
            ],
            "forslag_varer": list(pl.RETTER.get(kanon, {}).get("varer", [])),
            "rettet_t": e.get("t"), "rettet_af": e.get("af"),
        }

    @callback
    def gem_ret(self, ret_id: str | None, user: str | None = None, *, navn: str | None = None,
                varer: list[dict] | None | bool = False, opskrift: str | None | bool = False) -> dict:
        """Gem jeres indkøbsliste til en ret (eller koblingen til en opskrift). ret_id None = ny egen ret."""
        if ret_id is None:
            navn = (navn or "").strip()
            if not navn:
                raise ValueError("Skriv et navn til retten")
            key = dish_key(navn)
            if not key:
                raise ValueError("Ugyldigt navn")
            ret_id = "e:" + key
            if ret_id in self.bank.egne or key in self._egne_hist():
                navn = None  # findes allerede – gem bare varerne på den
        try:
            self.bank.gem(ret_id, navn=navn, varer=varer, opskrift=opskrift,
                          t=dt_util.now().isoformat(timespec="seconds"), af=user)
        except KeyError as err:
            raise ValueError("Retten eller opskriften findes ikke længere") from err
        rnavn = (op.paen_titel(self.bank.opskrift(ret_id[2:])["titel"]) if ret_id.startswith("r:")
                 else self._egen_navn(ret_id))
        if varer is None and opskrift is False:
            tekst = f'gendannede indkøbslisten til "{rnavn}"'
        elif opskrift not in (False, None):
            tekst = f'koblede "{rnavn}" til opskriften "{op.paen_titel(self.bank.opskrift(opskrift[2:])["titel"])}"'
        elif opskrift is None and varer is False:
            tekst = f'fjernede opskriften fra "{rnavn}"'
        else:
            n = len(self.bank.varer(ret_id) or [])
            tekst = f'gemte indkøbslisten til "{rnavn}" ({n} {"vare" if n == 1 else "varer"})'
        self._log(user, "retter", tekst, key=f"ret:{ret_id}", window=300)
        self._save_bank()
        self._save()
        self._notify()
        return self.ret_detalje(ret_id)

    @callback
    def ret_paa_listen(self, ret_id: str, gange: float = 1, user: str | None = None) -> dict:
        """Læg rettens varer på indkøbslisten (som engangsvarer med auto-kategori)."""
        varer = self.bank.varer(ret_id)
        if not varer:
            raise ValueError("Retten har ingen indkøbsliste endnu")
        rnavn = (op.paen_titel(self.bank.opskrift(ret_id[2:])["titel"]) if ret_id.startswith("r:")
                 else self._egen_navn(ret_id))
        nye, fandtes = [], []
        for v in varer:
            t = op.liste_tekst(v, gange)
            if ex := self._existing(t):
                if ex["checked"]:
                    self.indkob.update(ex["id"], checked=False)
                _tag_ret(ex, [rnavn])
                fandtes.append(ex["text"])
                continue
            ln = self.indkob.add(t, line_type=TYPE_ITEM, auto_place=True)
            _tag_ret(ln, [rnavn])
            nye.append(ln)
        self._log(user, "indkob", f'lagde {len(nye)} {"vare" if len(nye) == 1 else "varer"} fra "{rnavn}" på listen'
                  + (f" ({len(fandtes)} stod der i forvejen)" if fandtes else ""))
        self.indkob_changed(user)
        return {"ret": rnavn, "tilfoejet": [ln["text"] for ln in nye], "ids": [ln["id"] for ln in nye],
                "fandtes": fandtes}

    # ------------------------------------------------------------ varer til ugen (0.12)
    def _perioder(self, today: date) -> list[dict]:
        """Resten af indkøbsugen (fre → tor) og næste uge. Fredag er "denne uge" hele ugen."""
        wd = today.weekday()
        naeste_fre = today + timedelta(days=(4 - wd) % 7 or 7)
        nu_dage = (naeste_fre - today).days
        return [
            {"id": "nu", "start": today.isoformat(), "dage": nu_dage,
             "titel": "Denne uge" if wd == 4 else "Resten af ugen"},
            {"id": "naeste", "start": naeste_fre.isoformat(), "dage": 7, "titel": "Næste uge"},
        ]

    def _har_vi_altid(self) -> set[str]:
        try:
            return {a.lower() for a in self.bank.omregning["har_vi_altid"]}
        except Exception:  # noqa: BLE001
            return set()

    def _ret_for_dag(self, a: pl.Aften) -> tuple[str | None, str, str | None]:
        """(ret-id, navn, kilde) for en aften: jeres egen ret, ellers en opskrift med samme navn."""
        eid = "e:" + dish_key(a.navn)
        if eid != "e:" and self.bank.varer(eid):
            return eid, self._egen_navn(eid), "egen"
        bedst, score = None, 0.0
        for r in self.bank.raa:
            s = op.ligner(a.navn, op.paen_titel(r["titel"]))
            if s > score:
                bedst, score = r, s
        if bedst and score >= 0.85 and self.bank.varer("r:" + bedst["id"]):
            return "r:" + bedst["id"], op.paen_titel(bedst["titel"]), "opskrift"
        return (eid if eid != "e:" else None), a.navn, None

    def _senest_koebt(self, navn: str, siden: date) -> str | None:
        """Hvornår varen sidst blev krydset af (dato), hvis det er sket fra og med `siden`."""
        key = normalize(navn)
        if not key:
            return None
        st = kat.stamme(key)
        for ev in reversed(self.history.events):
            if ev["type"] != "buy" or (ev["k"] != key and kat.stamme(ev["k"]) != st):
                continue
            d = datetime.fromisoformat(ev["t"]).date()
            return d.isoformat() if d >= siden else None
        return None

    def ugens_varer(self, start: date | None = None, dage: int | None = None) -> dict:
        """Varer til ugens retter: samlet fra madplanen, kød fra fryseren og det, I har, fravalgt."""
        today = dt_util.now().date()
        perioder = self._perioder(today)
        if start is None:
            nu, naeste = perioder
            # Fredag: denne uge. Ellers næste uge, så snart den er begyndt at blive planlagt.
            n_start = date.fromisoformat(naeste["start"])
            planlagt = any(self.madplan.get(n_start + timedelta(days=i)) and self.madplan[n_start + timedelta(days=i)].ret
                           for i in range(7))
            valgt = nu if (today.weekday() == 4 or not planlagt) else naeste
            start, dage = date.fromisoformat(valgt["start"]), valgt["dage"]
        dage = max(1, min(dage or 7, 14))
        slut = start + timedelta(days=dage - 1)
        # Købt siden fredag tæller for resten af denne uge; for næste uge kun det, der er købt i dag
        sidste_fre = today - timedelta(days=(today.weekday() - 4) % 7)
        koebt_siden = sidste_fre if start < date.fromisoformat(perioder[1]["start"]) else today
        try:
            aftener = {a.dato: a for a in pl.laes_historik(self.madplan)}
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Kunne ikke læse madplanen")
            aftener = {}
        altid = self._har_vi_altid()
        varer: dict[str, dict] = {}
        skjult: list[str] = []
        ud_dage: list[dict] = []
        for i in range(dage):
            d = start + timedelta(days=i)
            dag = self.madplan.get(d)
            a = aftener.get(d)
            item = {"dato": d.isoformat(), "ugedag": UGEDAGE[d.weekday()], "tekst": (dag.raw if dag else "") or "",
                    "slags": a.slags if a else "tom", "navn": a.navn if a else "", "ret": None, "kilde": None,
                    "gange": 1, "antal": 0}
            if a is None or a.slags != "ret":
                ud_dage.append(item)
                continue
            ret_id, navn, kilde = self._ret_for_dag(a)
            gange = 2 if a.stor else 1
            item.update(ret=ret_id, navn=navn, kilde=kilde, gange=gange)
            liste = self.bank.varer(ret_id) if (ret_id and kilde) else None
            if liste and ret_id.startswith("r:") and (k := self.bank.konverteret().get(ret_id[2:])):
                for n in k["har_vi_altid"]:  # opskriftens "Har vi altid" er allerede sorteret fra
                    if n not in skjult:
                        skjult.append(n)
            if not liste:
                kanon = pl.kanonisk(a.navn) or a.navn
                item["forslag_varer"] = list(pl.RETTER.get(kanon, {}).get("varer", []))
                item["forslag_opskrifter"] = [
                    {"id": "r:" + r["id"], "navn": op.paen_titel(r["titel"])}
                    for s, r in sorted(((op.ligner(a.navn, op.paen_titel(r["titel"])), r) for r in self.bank.raa),
                                       key=lambda x: -x[0])[:2] if s >= 0.5
                ]
                ud_dage.append(item)
                continue
            for v in liste:
                navn_v = v["navn"].strip()
                if not navn_v:
                    continue
                if navn_v.lower() in altid:
                    if navn_v not in skjult:
                        skjult.append(navn_v)
                    continue
                k = kat.stamme(normalize(navn_v) or navn_v.lower())
                it = varer.setdefault(k, {"navn": navn_v, "maengder": {}, "uden_maengde": False, "retter": [], "dage": []})
                q = v.get("mængde")
                e = v.get("enhed") or ""
                if q is None or e not in op.LISTE_ENHED:
                    it["uden_maengde"] = True
                else:
                    it["maengder"][e] = (it["maengder"].get(e) or 0) + q * gange
                if navn not in it["retter"]:
                    it["retter"].append(navn)
                if d.isoformat() not in it["dage"]:
                    it["dage"].append(d.isoformat())
                item["antal"] += 1
            ud_dage.append(item)
        ud = []
        for it in varer.values():
            dele = [op.liste_tekst({"navn": "", "mængde": round(q, 2), "enhed": e}).strip()
                    for e, q in it["maengder"].items()]
            tekst = (it["navn"] + " " + " + ".join(x for x in dele if x)).strip()
            ex = self._existing(it["navn"])
            koebt = None if ex else self._senest_koebt(it["navn"], koebt_siden)
            koed = er_fryserkoed(it["navn"])
            grund = ("i kurven" if ex["checked"] else "står på listen") if ex else (
                "kød fra fryseren" if koed else (f"købt {UGEDAGE[date.fromisoformat(koebt).weekday()].lower()}" if koebt else None))
            noegle = kat.gaet(it["navn"]) or kat.FALLBACK
            ud.append({
                "navn": it["navn"], "tekst": tekst, "retter": it["retter"], "dage": it["dage"],
                "kategori": kat.NAVN.get(noegle, ""), "orden": kat.ORDEN.get(noegle, 99),
                "koed": koed, "paa_listen": bool(ex), "linje_id": ex["id"] if ex else None, "koebt": koebt,
                "valgt": not (ex or koed or koebt), "grund": grund,
            })
        ud.sort(key=lambda x: (x["orden"], x["navn"].lower()))
        for x in ud:
            del x["orden"]
        return {
            "start": start.isoformat(), "slut": slut.isoformat(), "dage": dage,
            "uge": start.isocalendar()[1], "perioder": perioder,
            "dage_liste": ud_dage, "varer": ud, "har_vi_altid": skjult,
            "mangler": [x for x in ud_dage if x["slags"] == "ret" and not x["antal"]],
            "madplan_version": self.madplan_note.version,
        }

    @callback
    def tilfoej_til_retter(self, varer: list[dict], user: str | None = None) -> dict:
        """Læg ugens varer på listen med retmærke (står varen der, får den bare mærket)."""
        nye, fandtes = [], []
        for v in varer:
            tekst = (v.get("tekst") or "").strip()
            if not tekst:
                continue
            retter_ = [r for r in (v.get("retter") or []) if r][:4]
            if ex := self._existing(tekst):
                _tag_ret(ex, retter_)
                fandtes.append(ex["text"])
                continue
            ln = self.indkob.add(tekst, line_type=TYPE_ITEM, auto_place=True)
            _tag_ret(ln, retter_)
            nye.append(ln)
        if nye or fandtes:
            self._log(user, "indkob", f'lagde {len(nye)} {"vare" if len(nye) == 1 else "varer"} til ugens retter på listen'
                      + (f" ({len(fandtes)} stod der i forvejen)" if fandtes else ""))
            self.indkob_changed(user)
        return {"tilfoejet": [ln["text"] for ln in nye], "ids": [ln["id"] for ln in nye], "fandtes": fandtes}

    @callback
    def slet_statistik_vare(self, navn: str, user: str | None = None) -> int:
        """Fjern en vare fra statistikken (fx testvarer) – listen og indkøbsturene røres ikke."""
        n = self.history.remove_key(normalize(navn) or navn.strip().lower())
        if n:
            self._log(user, "statistik", f'fjernede "{navn.strip()}" fra statistikken ({n} {"hændelse" if n == 1 else "hændelser"})')
            self.stats = self.history.compute(dt_util.now())
            self._save()
            self._notify()
        return n

    def omregning(self) -> dict:
        o = self.bank.omregning
        k = self.bank.konverteret()
        grundlag = Counter(
            "koed" if v["grundlag"].endswith("kød") else "portioner" if v["grundlag"].endswith("portioner") else "uaendret"
            for v in k.values()
        )
        return {
            "omregning": o, "standard": op.STANDARD, "aendret": sorted(self.bank.omr_aendret),
            "opsummering": {"opskrifter": len(k), **grundlag,
                            "ikke_tolket": sum(len(v["ikke_tolket"]) for v in k.values()),
                            "varer": sum(len(v["varer"]) for v in k.values())},
        }

    @callback
    def set_omregning(self, changes: dict | None, user: str | None = None, *, nulstil: bool = False) -> dict:
        if nulstil:
            if self.bank.nulstil_omregning():
                self._log(user, "indstillinger", "gendannede standard-omregningen af opskrifter")
        else:
            for label in self.bank.set_omregning(changes or {}):
                self._log(user, "indstillinger", f'ændrede omregning: "{label}"', key=f"omr:{label}", window=300)
        self._save_bank()
        self._save()
        self._notify()
        return self.omregning()

    @callback
    def importer_opskrifter(self, tekst: str, user: str | None = None, *, erstat: bool = True) -> dict:
        res = self.bank.importer(tekst, erstat=erstat, t=dt_util.now().isoformat(timespec="seconds"))
        self.bank.konverteret()
        self._log(user, "retter", f'importerede {res["antal"]} opskrifter ({res["nye"]} nye, {res["opdaterede"]} opdaterede'
                  + (f', {res["fjernede"]} fjernet' if res["fjernede"] else "") + ")")
        self._save_bank()
        self._save()
        self._notify()
        return res

    # ------------------------------------------------------------ ugeplanlægger
    def _kalendere(self) -> list[dict]:
        return sorted(
            ({"entity_id": st.entity_id, "navn": st.name} for st in self.hass.states.async_all("calendar")),
            key=lambda x: x["navn"].lower(),
        )

    @property
    def plan_kalender(self) -> str | None:
        """Kalenderen som ugeplanlæggeren kigger i (vagter, fodbold …).

        Ikke valgt endnu -> en kalender der hedder noget med "fælles"/"famil", hvis den findes.
        Valgt "ingen" -> tom streng.
        """
        v = self.opts.get(CONF_PLAN_KALENDER)
        if v is not None:
            return v or None
        for k in self._kalendere():
            if any(w in k["navn"].lower() for w in ("fælles", "faelles", "famil")):
                return k["entity_id"]
        return None

    def _plan_start(self) -> date:
        today = dt_util.now().date()
        planlagt = [d for d, dag in self.madplan.items() if dag.ret]
        if planlagt:
            nxt = max(planlagt) + timedelta(days=1)
            if nxt > today:
                return nxt
        return today

    async def _kalender_events(self, start: date, slut: date) -> list[dict]:
        entity = self.plan_kalender
        if not entity or self.hass.states.get(entity) is None:
            return []
        tz = dt_util.get_default_time_zone()
        try:
            resp = await self.hass.services.async_call(
                "calendar", "get_events",
                {
                    "entity_id": entity,
                    "start_date_time": datetime.combine(start, datetime.min.time(), tz).isoformat(),
                    "end_date_time": datetime.combine(slut + timedelta(days=1), datetime.min.time(), tz).isoformat(),
                },
                blocking=True, return_response=True,
            )
        except Exception:  # noqa: BLE001 – kalenderen er en bonus, ikke et krav
            _LOGGER.debug("Kunne ikke hente kalenderen %s", entity, exc_info=True)
            return []
        events = (resp or {}).get(entity, {}).get("events", []) if isinstance(resp, dict) else []
        out = []
        for ev in events:
            s, e = ev.get("start"), ev.get("end")
            # Tidspunkter til lokal tid, så "aften" vurderes rigtigt
            if isinstance(s, str) and "T" in s:
                s = dt_util.as_local(dt_util.parse_datetime(s)).isoformat()
            if isinstance(e, str) and "T" in e:
                e = dt_util.as_local(dt_util.parse_datetime(e)).isoformat()
            out.append({"start": s, "end": e, "summary": ev.get("summary", "")})
        return out

    async def async_planlaeg(
        self, *, start: date | None = None, dage: int | None = None, tags: dict[str, list[str]] | None = None,
        laaste: dict[str, str] | None = None, seed: int | None = None, nye: int = 1, rester: bool = True,
    ) -> dict:
        """Forslag til næste uges madplan (se planner.py)."""
        today = dt_util.now().date()
        start = start or self._plan_start()
        model = pl.byg_model(self.madplan, today, foer=start)
        dage = max(3, min(14, dage or model.blok_laengde))
        slut = start + timedelta(days=dage - 1)
        events = await self._kalender_events(start, slut)
        tags = tags or {}
        laaste = laaste or {}
        plan: list[pl.DagPlan] = []
        for i in range(dage):
            d = start + timedelta(days=i)
            kal_tags, vis = pl.kalender_tags(events, d)
            auto = kal_tags | set(model.vane_tags.get(d.weekday(), []))
            eks = self.madplan.get(d)
            if eks and eks.ret:
                auto |= pl.tags_fra_noter(eks.noter, eks.raw)
            iso = d.isoformat()
            dp = pl.DagPlan(d, set(tags[iso]) if iso in tags else set(auto), kalender=vis, auto_tags=auto)
            if iso in laaste:
                dp.laast, dp.tekst = True, laaste[iso]
            elif eks and eks.ret and iso not in tags:
                dp.laast, dp.tekst, dp.eksisterende = True, eks.ret, True
            plan.append(dp)
        seed = seed if seed is not None else int(dt_util.now().timestamp())
        pl.Planlaegger(model, skjulte=set(self.planner_data.get("skjulte", [])), seed=seed).planlaeg(
            plan, antal_nye=max(0, min(2, nye)), rester=rester
        )
        return self._plan_svar(model, plan, start, dage, seed)

    def _valg_dict(self, model: pl.Model, v: pl.Valg | None) -> dict | None:
        if v is None:
            return None
        navn = v.rest_af or v.navn
        egen = pl.egenskaber(navn)
        prof = model.profiler.get(v.ligner or navn)
        varianter = []
        if prof and not v.nyt and not v.rest_af:
            # Kun varianter med fyld/tilbehør ("pita m hakkebøffer"), ikke stavemåder
            varianter = [k for k, _ in sorted(prof.varianter.items(), key=lambda kv: -kv[1])
                         if k.lower() != navn.lower() and len(k) <= 34
                         and re.search(r"\b(m|med)\b\.?", k, re.IGNORECASE)][:3]
        return {
            "navn": v.navn, "rest_af": v.rest_af, "nyt": v.nyt, "ligner": v.ligner, "stor": v.stor,
            "grunde": v.grunde, "score": round(v.score, 3),
            "protein": egen["protein"], "base": egen["base"], "effort": egen["effort"],
            "varer": [] if v.rest_af else egen.get("varer", []),
            "antal": prof.antal if prof and not v.nyt else 0,
            "varianter": varianter,
            "tekst": pl.ret_til_madplan(v.navn),
        }

    def _plan_svar(self, model: pl.Model, plan: list[pl.DagPlan], start: date, dage: int, seed: int) -> dict:
        top = sorted(model.profiler.values(), key=lambda p: -p.vaegt)[:5]
        uger = sorted({a.dato.isocalendar()[:2] for a in model.aftener})
        return {
            "start": start.isoformat(), "dage": dage, "seed": seed, "uge": start.isocalendar()[1],
            "kalender": self.plan_kalender,
            "standard_dage": model.blok_laengde,
            "grundlag": {
                "aftener": model.middage, "uger": len(uger),
                "top": [{"navn": p.navn, "antal": p.antal} for p in top],
            },
            "tags": {k: {"label": v[0], "travl": v[1], "note": model.note_tekst.get(k, v[2])} for k, v in pl.TAGS.items()},
            "retter": [p.navn for p in sorted(model.profiler.values(), key=lambda p: (-p.antal, p.navn))],
            "plan": [
                {
                    "dato": d.dato.isoformat(), "ugedag": UGEDAGE[d.dato.weekday()],
                    "tags": sorted(d.tags), "auto_tags": sorted(d.auto_tags), "kalender": d.kalender,
                    "laast": d.laast, "eksisterende": d.eksisterende, "tekst": d.tekst,
                    "valg": self._valg_dict(model, d.valg),
                    "alternativer": [self._valg_dict(model, a) for a in d.alternativer],
                }
                for d in plan
            ],
        }

    @callback
    def indsaet_uge(self, linjer: list[dict], base_version: int | None = None, user: str | None = None) -> dict:
        """Skriv den færdige uge øverst i madplanen ("Uge NN" + én linje pr. dag)."""
        dage = sorted(
            ((date.fromisoformat(x["dato"]), (x.get("linje") or "").strip()) for x in linjer),
            key=lambda t: t[0],
        )
        if not dage:
            return {"version": self.madplan_note.version}
        tekst = []
        for d, ln in dage:
            # Linjen kommer fra panelet; sikr at den starter med den rigtige ugedag
            body = ln.split(":", 1)[1].strip() if ":" in ln[:10] else ln
            tekst.append(f"{UGEDAGE[d.weekday()]}: {body}".rstrip())
        blok = f"Uge {dage[0][0].isocalendar()[1]}\n" + "\n".join(tekst)
        gammel = self.madplan_note.text.strip()
        self.set_madplan(blok + ("\n\n" + gammel if gammel else "") + "\n", base_version, user)
        self._log(user, "madplan", f"planlagde uge {dage[0][0].isocalendar()[1]} med ugeplanlæggeren", key="madplan:plan")
        return {"version": self.madplan_note.version}

    @callback
    def skjul_ret(self, navn: str, skjul: bool = True, user: str | None = None) -> list[str]:
        sk = [s for s in self.planner_data.get("skjulte", []) if s.lower() != navn.lower()]
        if skjul:
            sk.append(navn)
        self.planner_data["skjulte"] = sk
        self._log(user, "madplan", f'{"skjulte" if skjul else "viste igen"} "{navn}" i ugeplanlæggeren')
        self._save()
        self._notify()
        return sk

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
        old = tr.get("betalinger", [])
        new = _clean_payments(betalinger)
        # varer/butiks-id fra "Afslut indkøb i butik" bevares: efter position når antallet er
        # uændret, ellers efter butiksnavn (en fjernet række må ikke forskyde de andre)
        rest = list(old)
        for i, b in enumerate(new):
            src = None
            if len(new) == len(old):
                src = old[i]
            else:
                src = next((o for o in rest if o.get("butik", "").lower() == b["butik"].lower() and b["butik"]), None)
            if src is not None:
                if src in rest:
                    rest.remove(src)
                b.update({k: src[k] for k in ("varer", "t", "stop") if k in src and k not in b})
        tr["betalinger"] = new
        if self.trip and self.trip.get("hist_id") == trip_id:
            keep = {b["stop"]: b for b in new if b.get("stop")}
            self.trip["stops"] = [st for st in self._stops() if st["id"] in keep]
            for st in self._stops():
                st.update(butik=keep[st["id"]]["butik"] or st["butik"], beloeb=keep[st["id"]]["beloeb"])
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
        if self.trip and self.trip.get("hist_id") == trip_id:
            self.trip.pop("hist_id", None)
            self.trip["stops"] = []
        self._log(user, "historik", f"slettede indkøbet {_dato(tr['t'])}")
        self._trips_changed()

    @callback
    def skip_price(self, trip_id: str, user: str | None = None) -> None:
        """Indkøbet får ingen pris – spørg ikke efter beløbet igen."""
        tr = self.history.get_trip(trip_id)
        tr["pris_sprunget"] = True
        self._log(user, "historik", f"sprang prisen over for indkøbet {_dato(tr['t'])}", key=f"trip:{trip_id}", window=600)
        self._trips_changed()

    MANGLER_PRIS_DAGE = 7

    def missing_price(self) -> dict | None:
        """Seneste afsluttede indkøb uden beløb (til kortet "Hvad blev indkøbet?").

        Kun det nyeste indkøb fra listen inden for en uge – ikke mens der handles,
        ikke manuelt tilføjede, og ikke når prisen er sprunget over.
        """
        if self.trip is not None:
            return None
        ture = [t for t in self.history.trips if not t.get("manuel") and t.get("varer")]
        if not ture:
            return None
        tr = ture[-1]  # turene holdes sorteret efter tid (stabilt, så det nyeste står sidst)
        bet = tr.get("betalinger", [])
        if not _mangler_pris(tr):
            return None  # sprunget over, eller alle butikker har et beløb
        t = dt_util.parse_datetime(tr["t"])
        if t is None or dt_util.now() - t > timedelta(days=self.MANGLER_PRIS_DAGE):
            return None
        return {
            "id": tr["id"], "t": tr["t"], "antal": len(tr["varer"]), "auto": tr.get("auto", False),
            "butikker": [b.get("butik", "") for b in bet],
            "mangler": [b.get("butik", "") for b in bet if not b.get("beloeb")],
        }

    def _trips_changed(self) -> None:
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ views
    def _retter_resume(self) -> dict:
        try:
            k = self.retter_katalog()
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Retkataloget fejlede")
            return {"version": None}
        return {"version": k["version"], **k["antal"], "importeret": k["importeret"]}

    def state(self) -> dict:
        """Alt hvad panel og kort skal bruge."""
        basis_keys = {normalize(b["text"]) for b in self.basis.items()}
        basis_stammer = {kat.stamme(k) for k in basis_keys}

        def _fast(ln: dict) -> bool:
            if ln["type"] != TYPE_ITEM:
                return False
            k = normalize(ln["text"])
            return bool(k) and (k in basis_keys or kat.stamme(k) in basis_stammer)

        return {
            "indkob": {
                **{k: v for k, v in self.indkob.as_dict().items() if k not in ("categories", "lines")},
                "lines": [{**ln, "fast": _fast(ln)} for ln in self.indkob.lines],
                "kendte": self.known_names(),
                "kategorier": self.indkob.category_overview(),
                "tur": {
                    "aktiv": self.trip is not None,
                    "start": self.trip["start"] if self.trip else None,
                    "nulstilles": due.isoformat(timespec="minutes") if (due := self.trip_due()) else None,
                    "taerskel": round(self.trip_threshold * 100),
                    "timer": self.trip_delay.total_seconds() / 3600,
                    "butikker": [
                        {"id": st["id"], "butik": st["butik"], "beloeb": st["beloeb"], "t": st["t"],
                         "antal": len(st["line_ids"])}
                        for st in self._stops()
                    ],
                    "koebt": self.bought(),
                },
            },
            "basis": {
                **{k: v for k, v in self.basis.as_dict().items() if k != "categories"},
                "kategorier": self.basis.category_overview(),
                "antal": len(self.basis.items()),
            },
            "madplan": {
                **self.madplan_note.as_dict(),
                "dage": self.uge(-1, 9),
                "sidste_dato": self.sidste_dato(),
                "frost_dag": "i morgen" if self.frost_tomorrow else "i dag",
            },
            "stats": {k: v for k, v in self.stats.items() if k != "varer"},
            "indstillinger": self.settings(),
            "retter": self._retter_resume(),
            "historik": {**self.history.trip_overview(dt_util.now()), "mangler_pris": self.missing_price()},
            "log": [{k: v for k, v in e.items() if k not in ("k", "fra")} for e in reversed(self.log[-150:])],
        }


SETTING_LABELS = {
    CONF_PLAN_KALENDER: "Kalender til madplanen",
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


def _mangler_pris(tr: dict) -> bool:
    """Mangler indkøbet et beløb? (ingen betalinger, eller en butik uden beløb – og ikke sprunget over)"""
    bet = tr.get("betalinger", [])
    return not tr.get("pris_sprunget") and (not bet or not all(b.get("beloeb") for b in bet))


def _clean_payments(betalinger: list[dict]) -> list[dict]:
    out = []
    for b in betalinger:
        butik = str(b.get("butik") or "").strip()[:60]
        try:
            beloeb = round(float(b.get("beloeb") or 0), 2)
        except (TypeError, ValueError):
            beloeb = 0.0
        if butik or beloeb:
            x = {"butik": butik, "beloeb": beloeb}
            if isinstance(b.get("varer"), list):
                x["varer"] = [str(v)[:80] for v in b["varer"]][:200]
            for k in ("t", "stop"):
                if b.get(k):
                    x[k] = str(b[k])[:40]
            out.append(x)
    return out


def _payments_text(betalinger: list[dict]) -> str:
    if not betalinger:
        return "ingen pris"
    return ", ".join(f"{b['butik'] or 'ukendt butik'} {_kr(b['beloeb'])}" for b in betalinger)


# Kød der købes friskt (ikke fra fryseren), selv om det står under Køl – kød
_FRISK_KOED = ("bacon", "pølse", "skinke", "pancetta", "guanciale", "nduja", "chorizo", "salami", "pålæg",
               "leverpostej", "røget", "rullepølse", "spegepølse")


def er_fryserkoed(navn: str) -> bool:
    """Kød/fisk til aftensmaden, som familien tager op af fryseren i stedet for at købe."""
    low = (navn or "").lower()
    return kat.gaet(navn) == "kod" and not any(w in low for w in _FRISK_KOED)


def _tag_ret(line: dict, navne: list[str]) -> None:
    """Retmærke på en vare: hvilke retter den skal bruges til (vises under varen)."""
    if not navne:
        return
    cur = [r for r in line.get("ret") or [] if r]
    for n in navne:
        if n and n not in cur:
            cur.append(n)
    line["ret"] = cur[-4:]

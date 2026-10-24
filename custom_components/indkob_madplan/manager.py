"""Kernen: ejer de to noter, logger køb og leverer madplanen."""

from __future__ import annotations

import json

import logging
import re
import uuid
from collections import Counter
from collections.abc import Callable
from datetime import date, datetime, timedelta
from statistics import median
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
from .madplan import (
    _FRA_FRYSER_RE, DEFAULT_KOED_ORD, DEFAULT_REST_ORD, INTET_FRA_FRYSER, UGEDAGE, Dag, dish_key, flet3, overlap,
    parse_madplan, retter, scan_linjer, vindere,
)
from .notes import TYPE_ITEM, ShoppingNote, TextNote, new_id
from . import kategorier as kat
from . import koleskab as kol
from . import opskrift_retter as orr
from . import opskrifter as op
from . import planner as pl
from . import saeson as sae
from .stats import History, clean_names, normalize

_LOGGER = logging.getLogger(__name__)


# Største kladde fra ugeplanlæggeren (JSON-tegn) – en uge fylder typisk 20–60 KB
KLADDE_MAX = 400_000
# Køleskabet (0.12.5): højst så mange rester ad gangen
KOLESKAB_MAX = 40
# Rækkefølge pr. butik (0.15.0): flueben inden for så lang tid før "Afslut indkøb i butik" tæller
BUTIK_VINDUE = timedelta(hours=3)
# … og så mange flueben skal der være (i mindst 2 kategorier), før rækkefølgen læres
BUTIK_MIN_VARER = 4


class ConflictError(Exception):
    """Madplanen er ændret af en anden siden klienten hentede den."""


class FletKonflikt(ConflictError):
    """0.13.0: madplanen kunne ikke flettes – samme linjer er ændret begge steder."""

    def __init__(self, linjer: list[str]) -> None:
        super().__init__("Samme linjer er ændret begge steder: " + " · ".join(linjer[:4]))
        self.linjer = linjer


# 0.13.0: så mange tidligere versioner af madplanen gemmes (til fletning og "Tidligere versioner")
MADPLAN_REVISIONER = 30
# Tegn der får str.splitlines() til at dele anderledes end "\n" – så indsættes ugen som ny blok
_ANDRE_LINJESKIFT = "\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029"


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
        self._ophist_cache: tuple | None = None
        self._bank_dirty = False
        # Køleskabet (0.12.5): [{"id", "navn", "nok", "t", "af"}] – nok = købes ikke, ellers "lidt" (købes stadig)
        self.koleskab: list[dict] = []
        self._varenavne_cache: tuple | None = None
        self._kol_brug_cache: tuple | None = None
        # Rækkefølge pr. butik (0.15.0): navn (små bogstaver) -> {"navn", "orden": [kategori-nøgler],
        # "kilde": "laert" | "manuel", "ture", "t", "sidst"}
        self.butik_orden: dict[str, dict] = {}

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
        self.koleskab = [x for x in (data.get("koleskab") or []) if isinstance(x, dict) and x.get("id") and x.get("navn")]
        self.madplan_revisioner = [x for x in (data.get("madplan_revisioner") or [])
                                   if isinstance(x, dict) and isinstance(x.get("version"), int)][-MADPLAN_REVISIONER:]
        self._bank_laast = None
        self.butik_orden = {k: v for k, v in (data.get("butik_orden") or {}).items()
                            if isinstance(v, dict) and isinstance(v.get("orden"), list)}
        laer_butikker = "butik_orden" not in data  # første start med 0.15.0: lær af de seneste indkøb
        try:
            raa = await self.bank_store.async_load()
            self.bank = op.Opskriftsbank(raa)
            if raa is None and (data.get("bank_antal") or 0) > 0:
                # Banken fandtes, men kunne ikke læses (HA flytter selv en ødelagt fil til *.corrupt.*)
                self._bank_laast = (f"Opskriftsbanken kunne ikke læses ({data['bank_antal']} retter forventet)")
                _LOGGER.error("%s – der gemmes intet i den, før den er gendannet", self._bank_laast)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Kunne ikke læse opskriftsbanken – starter tom og gemmer intet i den")
            self.bank = op.Opskriftsbank()
            self._bank_laast = "Opskriftsbanken kunne ikke læses"
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
        self._koleskab_opbrug(notify=False)  # var HA slukket ved midnat
        if laer_butikker:
            try:
                n = self._laer_fra_historik()
                if n:
                    _LOGGER.info("Rækkefølge lært for %s butik(ker) ud fra indkøbshistorikken", n)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Kunne ikke lære butikkernes rækkefølge af historikken")
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
            "koleskab": self.koleskab,
            "butik_orden": self.butik_orden,
            # 0.13.0: tidligere versioner af madplanen + hvor mange retter banken havde (læsefejl-vagt)
            "madplan_revisioner": self._revisioner(),
            "bank_antal": self._bank_antal(),
        }

    def _save(self) -> None:
        self.store.async_delay_save(self._data, 2)

    def _bank_antal(self) -> int:
        if getattr(self, "_bank_laast", None):
            return getattr(self, "_bank_antal_sidst", 0)
        n = len(self.bank.raa) + len(self.bank.egne)
        self._bank_antal_sidst = n
        return n

    def _tjek_bank(self) -> None:
        """0.13.0: en opskriftsbank, der ikke kunne læses, må aldrig overskrives."""
        if laast := getattr(self, "_bank_laast", None):
            raise ValueError(f"{laast} – intet gemmes, før den er gendannet fra en backup")

    def _save_bank(self) -> None:
        self._tjek_bank()
        self._bank_dirty = True
        self.bank_store.async_delay_save(self.bank.as_dict, 2)

    @callback
    def _on_frost_skift(self, _now: datetime) -> None:
        """Kl. 18: optøningen skifter fra dagens til morgendagens ret."""
        self._notify()

    @callback
    def _on_midnight(self, _now: datetime) -> None:
        self._parse_madplan()
        self._koleskab_opbrug(notify=False)
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
        holdt = []
        nok = [r for r in self.koleskab if r.get("nok")]
        for b in self.basis.items():
            if self.indkob.find_item(b["text"]) is None:
                # 0.15.0: står den faste vare som "Nok" i køleskabet, bliver den væk fra listen
                # (den kommer igen, når resten sættes til "Lidt" eller tages ud af køleskabet)
                if any(kol.passer(r["navn"], b["text"]) for r in nok):
                    holdt.append(b["text"])
                    continue
                header = self.indkob.learned_header(b["text"]) or self.basis.category_of(b["id"])
                tilbage.append(self.indkob.add_under(b["text"], header))
        if holdt:
            self._log(user, "indkob", f"lod {len(holdt)} {'fast vare' if len(holdt) == 1 else 'faste varer'} blive væk"
                      " – nok i køleskabet: " + _names(holdt, 6))
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
            # 0.13.0: butikken og dens beløb bliver altid stående (fjernes kun med "Fortryd" i butikkens
            # ark). Varer, der får fjernet fluebenet, hører ikke længere til butikken; varer, der er
            # SLETTET fra listen (fx "Slet afkrydsede"), er stadig købt og bliver i butikkens varer.
            alle = {ln["id"]: ln for ln in self.indkob.lines}
            checked_lines = {ln["id"]: ln["text"] for ln in self.indkob.items() if ln["checked"]}
            for st in self._stops():
                keep = [i for i in st["line_ids"] if i in checked_lines]
                if len(keep) == len(st["line_ids"]):
                    continue
                ikke_koebt = [alle[i]["text"] for i in st["line_ids"] if i in alle and i not in checked_lines]
                st["slettet"] = st.get("slettet", 0) + sum(1 for i in st["line_ids"] if i not in alle)
                st["line_ids"] = keep
                if ikke_koebt and (b := self._stop_payment(st["id"])):
                    varer = list(b.get("varer") or [])
                    for navn in clean_names(ikke_koebt):
                        if navn in varer:
                            varer.remove(navn)
                    b["varer"] = varer
                    tr = self._hist_trip()
                    tr["varer"] = [n for x in tr["betalinger"] for n in x.get("varer", [])]
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
        try:  # 0.15.0: lær butikkens rækkefølge af, hvornår varerne blev krydset af
            self._laer_butik(butik, [(ln["text"], self._kat_noegle(self.indkob.category_of(ln["id"]))) for ln in lines],
                             now)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Kunne ikke lære rækkefølgen i %s", butik)
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

    # ------------------------------------------------------------ rækkefølge pr. butik (0.15.0)
    @staticmethod
    def _kat_noegle(header: str | None) -> str | None:
        """Kategoriens nøgle: fast kategori ("mejeri") eller jeres egen overskrift ("h:<tekst>")."""
        if not header or not header.strip():
            return None
        return kat.header_noegle(header) or ("h:" + header.strip())

    def _koebstider(self, navne: list[str], slut: datetime) -> dict[str, datetime]:
        """Varenøgle -> seneste flueben inden for BUTIK_VINDUE før `slut` (fra købsloggen)."""
        fra = slut - BUTIK_VINDUE
        til = slut + timedelta(minutes=1)
        keys = {normalize(n) for n in navne if normalize(n)}
        ud: dict[str, datetime] = {}
        for ev in reversed(self.history.events):
            if ev.get("type") != "buy" or ev.get("k") not in keys or ev["k"] in ud:
                continue
            try:
                t = datetime.fromisoformat(ev["t"])
            except (TypeError, ValueError):
                continue
            if t.tzinfo is None:
                t = t.replace(tzinfo=slut.tzinfo)
            if fra <= t <= til:
                ud[ev["k"]] = t
        return ud

    @staticmethod
    def _orden_af(poster: list[tuple[str, datetime]]) -> list[str] | None:
        """Kategorierne i den rækkefølge, de blev handlet (median-tidspunkt pr. kategori)."""
        pr: dict[str, list[float]] = {}
        for k, t in poster:
            pr.setdefault(k, []).append(t.timestamp())
        if len(poster) < BUTIK_MIN_VARER or len(pr) < 2:
            return None
        return sorted(pr, key=lambda k: (median(pr[k]), k))

    @staticmethod
    def _bland_orden(gammel: list[str], ny: list[str]) -> list[str]:
        """Ny tur vægter det halve: kategorier fra begge ture får gennemsnittet af deres pladser."""
        def pos(lst: list[str]) -> dict[str, float]:
            n = max(1, len(lst) - 1)
            return {k: i / n for i, k in enumerate(lst)}
        pg, pn = pos(gammel), pos(ny)
        alle = list(dict.fromkeys(gammel + ny))
        score = {k: (pg[k] + pn[k]) / 2 if k in pg and k in pn else pn.get(k, pg.get(k, 1.0)) for k in alle}
        return sorted(alle, key=lambda k: (score[k], pn.get(k, 2.0), pg.get(k, 2.0)))

    def _laer_butik(self, butik: str, varer: list[tuple[str, str | None]], slut: datetime) -> list[str] | None:
        """Lær (eller juster) butikkens rækkefølge ud fra én tur. `varer` = (navn, kategori-nøgle)."""
        butik = (butik or "").strip()[:60]
        if not butik:
            return None
        tider = self._koebstider([n for n, _k in varer], slut)
        poster = [(k, tider[normalize(n)]) for n, k in varer if k and normalize(n) in tider]
        orden = self._orden_af(poster)
        if orden is None:
            return None
        key = butik.lower()
        iso = slut.isoformat(timespec="seconds")
        bo = self.butik_orden.get(key)
        if bo and bo.get("kilde") == "manuel":
            bo.update(ture=bo.get("ture", 0) + 1, sidst=iso)  # sat i hånden: jeres rækkefølge bliver stående
            return bo["orden"]
        if bo:
            orden = self._bland_orden(bo["orden"], orden)
        self.butik_orden[key] = {"navn": butik, "orden": orden, "kilde": "laert",
                                 "ture": (bo or {}).get("ture", 0) + 1, "t": iso, "sidst": iso}
        return orden

    def _laer_fra_historik(self, butik: str | None = None) -> int:
        """Lær rækkefølgen af de seneste 180 dages indkøb (butikker med tidspunkt og varer)."""
        graense = dt_util.now() - timedelta(days=180)
        laert = set()
        for tr in sorted(self.history.trips, key=lambda x: x["t"]):
            for b in tr.get("betalinger") or []:
                navn_b = (b.get("butik") or "").strip()
                if not navn_b or not b.get("varer") or not b.get("t"):
                    continue
                if butik and navn_b.lower() != butik.strip().lower():
                    continue
                try:
                    slut = datetime.fromisoformat(b["t"])
                except (TypeError, ValueError):
                    continue
                if slut.tzinfo is None:
                    slut = dt_util.as_local(slut)
                if slut < graense:
                    continue
                varer = []
                for n in b["varer"]:
                    header = self.indkob.learned_header(n)
                    k = self._kat_noegle(header) if header else kat.gaet(n)
                    varer.append((n, k))
                if self._laer_butik(navn_b, varer, slut) is not None:
                    laert.add(navn_b.lower())
        return len(laert)

    def _butik_orden_ud(self) -> list[dict]:
        return [{"navn": v["navn"], "orden": v["orden"], "kilde": v.get("kilde", "laert"), "ture": v.get("ture", 0),
                 "sidst": v.get("sidst")}
                for v in sorted(self.butik_orden.values(), key=lambda x: x.get("sidst") or "", reverse=True)]

    @callback
    def saet_butik_orden(self, butik: str, orden: list[str], user: str | None = None) -> dict:
        """Jeres egen rækkefølge for butikken (læres ikke om af nye indkøb)."""
        butik = (butik or "").strip()[:60]
        orden = [k for k in dict.fromkeys((x or "").strip() for x in orden) if k][:40]
        if not butik or len(orden) < 2:
            raise ValueError("Vælg en butik og mindst to kategorier")
        key = butik.lower()
        bo = self.butik_orden.get(key) or {}
        iso = dt_util.now().isoformat(timespec="seconds")
        self.butik_orden[key] = {"navn": bo.get("navn") or butik, "orden": orden, "kilde": "manuel",
                                 "ture": bo.get("ture", 0), "t": iso, "sidst": bo.get("sidst") or iso}
        self._log(user, "indkob", f"satte rækkefølgen i {self.butik_orden[key]['navn']}", key=f"orden:{key}", window=300)
        self._save()
        self._notify()
        return self.butik_orden[key]

    @callback
    def nulstil_butik_orden(self, butik: str, user: str | None = None) -> dict | None:
        """Glem jeres rækkefølge for butikken og lær den igen af indkøbshistorikken."""
        key = (butik or "").strip().lower()
        navn_b = (self.butik_orden.pop(key, None) or {}).get("navn") or butik.strip()
        self._laer_fra_historik(butik)
        self._log(user, "indkob", f"nulstillede rækkefølgen i {navn_b}", key=f"orden:{key}", window=300)
        self._save()
        self._notify()
        return self.butik_orden.get(key)

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
                    checked: bool | None = None, line_type: str | None = None, note: str | None = None,
                    dedupe: bool = False) -> dict:
        """Ret en linje. `dedupe` (0.15.0): panelet er færdigt med at skrive i linjen – står varen
        der allerede (ukrydset), slås de to linjer sammen (den nye forsvinder)."""
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
        if dedupe and (fl := self._flet_dublet(n, ln, user, nn)) is not None:
            self.indkob_changed(user, note)
            return fl
        self.indkob_changed(user, note)
        return ln

    def _flet_dublet(self, n: ShoppingNote, ln: dict, user: str | None, nn: str) -> dict | None:
        """0.15.0: samme vare (normaliseret navn, også ental/flertal) en anden ukrydset linje → fjern den
        nye linje. Er den eksisterende krydset af (i kurven/købt), flettes der ikke – så røres købet ikke."""
        if ln["type"] != TYPE_ITEM or ln["checked"] or not ln["text"].strip():
            return None
        key = normalize(ln["text"])
        if not key:
            return None
        andre = [x for x in n.items() if x["id"] != ln["id"] and not x["checked"]]
        ex = next((x for x in andre if normalize(x["text"]) == key), None) or next(
            (x for x in andre if kat.stamme(normalize(x["text"])) == kat.stamme(key)), None)
        if ex is None:
            return None
        idx = n.index(ln["id"])
        prev = n.lines[idx - 1]["id"] if idx > 0 else None
        n.delete([ln["id"]])
        u = user or "Ukendt"
        last = self._last_log(f"txt:{ln['id']}", u, 300)
        if last is not None and not last.get("fra"):
            self.log.remove(last)  # "tilføjede …" – linjen findes ikke længere
        self._log(user, nn, f'skrev "{ln["text"].strip()}", som stod der i forvejen – slået sammen med "{ex["text"].strip()}"')
        return {**ex, "flettet": True, "flettet_fra": {"id": ln["id"], "text": ln["text"], "prev": prev}}

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
        try:
            self._overlap = overlap(self.madplan_note.text, dt_util.now().date())
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Fejl ved tjek af overlappende uger")
            self._overlap = []

    # ------------------------------------------------------------ madplanens versioner (0.13.0)
    def _revisioner(self) -> list[dict]:
        if not hasattr(self, "madplan_revisioner"):
            self.madplan_revisioner = []
        return self.madplan_revisioner

    def _madplan_tekst(self, version: int | None) -> str | None:
        """Madplanens tekst, som den var i en bestemt version (None = ukendt/for gammel)."""
        n = self.madplan_note
        if version == n.version:
            return n.text
        return next((r["text"] for r in reversed(self._revisioner()) if r.get("version") == version), None)

    def madplan_versioner(self) -> dict:
        """Tidligere versioner af madplanen (nyeste først) – til sammenligning og gendannelse."""
        n = self.madplan_note
        return {
            "version": n.version,
            "versioner": [{"version": r["version"], "t": r.get("t"), "af": r.get("af"), "tekst": r.get("text", "")}
                          for r in reversed(self._revisioner())],
        }

    @callback
    def set_madplan(self, text: str, base_version: int | None = None, user: str | None = None, *,
                    kraev_version: bool = False, flet: bool = False) -> dict:
        """Gem madplanens tekst.

        0.13.0: `kraev_version` (websocket) afviser skrivning uden version; en forældet version
        afvises – eller flettes linje for linje med `flet` (FletKonflikt, hvis samme linjer er ændret
        begge steder). Den forrige tekst gemmes altid som version (MADPLAN_REVISIONER).
        """
        n = self.madplan_note
        flettet = False
        if text == n.text:
            return {"version": n.version, "flettet": False}
        if base_version is None:
            if kraev_version:
                raise ConflictError
        elif base_version != n.version:
            if not flet:
                raise ConflictError
            base = self._madplan_tekst(base_version)
            if base is None:
                raise FletKonflikt(["(versionen er for gammel til at flette)"])
            merged, konflikter = flet3(base, text, n.text)
            if merged is None:
                raise FletKonflikt(konflikter)
            if merged == n.text:
                return {"version": n.version, "flettet": True, "text": n.text}
            text, flettet = merged, True
        rev = self._revisioner()
        rev.append({"version": n.version, "text": n.text, "t": n.updated, "af": n.updated_by})
        del rev[:-MADPLAN_REVISIONER]
        n.text = text
        n.version += 1
        n.updated = dt_util.now().isoformat(timespec="seconds")
        n.updated_by = user
        self._log(user, "madplan", "importerede madplanen" if user == "Import" else (
            "flettede sine ændringer ind i madplanen" if flettet else "ændrede madplanen"),
                  key="madplan", window=900)
        self._parse_madplan()
        self._save()
        self._notify()
        return {"version": n.version, "flettet": flettet, **({"text": n.text} if flettet else {})}

    def ny_uge(self) -> dict:
        """0.13.0 "Ny uge": dagen efter den sidste dag med tekst (ikke tomme skabelon-dage), aldrig før i dag.
        Står der allerede (tomme) linjer for den dag, peger `linje` på dem i stedet for en ny blok."""
        today = dt_util.now().date()
        udfyldt = [d for d, dag in self.madplan.items() if (dag.raw or "").strip()]
        start = max(today, max(udfyldt) + timedelta(days=1)) if udfyldt else today
        linje = None
        try:
            v = vindere(scan_linjer(self.madplan_note.text, today)).get(start)
            linje = v.idx if v and not v.dag.raw.strip() else None
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Ny uge: kunne ikke læse madplanen")
        return {"start": start.isoformat(), "uge": start.isocalendar()[1], "linje": linje}

    def dag(self, offset: int) -> dict | None:
        d = dt_util.now().date() + timedelta(days=offset)
        dag = self.madplan.get(d)
        return self._dag_ud(dag) if dag else None

    def uge(self, start: int = -1, days: int = 8) -> list[dict]:
        today = dt_util.now().date()
        out = []
        for i in range(start, start + days):
            d = today + timedelta(days=i)
            dag = self.madplan.get(d)
            if dag:
                item = self._dag_ud(dag)
            else:
                item = {
                    "dato": d.isoformat(), "ugedag": UGEDAGE[d.weekday()], "ret": "", "noter": [],
                    "stor_portion": False, "kraever_optoening": False, "koed": [], "raw": "",
                }
            item["offset"] = i
            out.append(item)
        return out

    # ------------------------------------------------------------ kød fra fryseren (0.12.4)
    def fryser_for_navn(self, navn: str) -> list[str] | None:
        """Kød fra fryseren til en ret (jeres egen ret) – None hvis det ikke er angivet."""
        if not navn:
            return None
        kanon = pl.kanonisk(navn) or (navn[0].upper() + navn[1:])
        key = dish_key(kanon)
        return self.bank.fryser("e:" + key) if key else None

    # ------------------------------------------------------------ sæson (0.12.6)
    def saeson_for_navn(self, navn: str) -> sae.Saeson | None:
        """Rettens sæson: jeres egen (Retter) går forud for de faste regler. None = hele året."""
        if not navn:
            return None
        kanon = pl.kanonisk(navn) or (navn[0].upper() + navn[1:])
        key = dish_key(kanon)
        egen = self.bank.saeson("e:" + key) if key else None
        if egen is not None:
            return sae.egen_saeson(egen)
        return sae.regel_saeson(kanon)

    def _dag_ud(self, dag: Dag) -> dict:
        """Dagen til sensorer/kort: optøning ud fra rettens "Fra fryseren", ellers ud fra kød-ordene."""
        d = dag.as_dict(self.koed_ord, DEFAULT_REST_ORD)
        valg = (dag.fryser_valg or "").strip().lower()
        if valg:
            if valg == INTET_FRA_FRYSER:
                d.update(kraever_optoening=False, koed=[])
            else:
                d.update(kraever_optoening=True, koed=[valg])
            return d
        if _FRA_FRYSER_RE.search(dag.raw or ""):
            return d  # "bolo fra fryseren": retten selv skal op – som hidtil
        rest = re.compile(r"\b(" + "|".join(re.escape(r) for r in DEFAULT_REST_ORD) + r")\b", re.IGNORECASE)
        if rest.search(dag.raw or ""):
            return d  # rester: som hidtil
        alts = self.fryser_for_navn(dag.ret)
        if alts is None:
            # 0.15.0: en ReciMe-ret – jeres valg under Retter, ellers opskriftens kød fra fryseren
            alts = self._fryser_opskrift(dag)
        if alts is None:
            return d
        d["fryser"] = alts
        koed = [a for a in alts if a != INTET_FRA_FRYSER]
        if not koed:
            d.update(kraever_optoening=False, koed=[])
            return d
        d.update(kraever_optoening=True, koed=[" eller ".join(koed_i_tekst(koed, dag.raw or ""))])
        return d

    def fryser_auto(self, ret_id: str) -> list[str]:
        """0.15.0: opskriftens kød fra fryseren (det, Varer til ugen fravælger som "kød fra fryseren")."""
        ud: list[str] = []
        for v in self.bank.varer(ret_id) or []:
            navn_v = (v.get("navn") or "").strip().lower()
            if navn_v and er_fryserkoed(navn_v) and navn_v not in ud:
                ud.append(navn_v)
        return ud[:6]

    def _fryser_opskrift(self, dag: Dag) -> list[str] | None:
        """0.15.0: kød fra fryseren, når dagens ret er en ReciMe-opskrift (None = ikke en opskrift).

        Jeres eget valg på opskriften (Retter → ❄ Fra fryseren) går forud; ellers opskriftens kød.
        Svaret gemmes pr. madplan-/bank-version og dato (kaldes ved hver opdatering af sensorerne)."""
        key = (self.madplan_note.version, self.bank.version, id(self.bank))
        cache = getattr(self, "_fryser_op_cache", None)
        if not cache or cache[0] != key:
            cache = (key, {})
            self._fryser_op_cache = cache
        if dag.dato in cache[1]:
            return cache[1][dag.dato]
        res: list[str] | None = None
        try:
            a = next((x for x in pl.laes_historik({dag.dato: dag}) if x.slags == "ret"), None)
            if a is not None:
                ret_id, _navn, kilde = self._ret_for_dag(a)
                if kilde == "opskrift" and ret_id and ret_id.startswith("r:"):
                    egen = self.bank.fryser(ret_id)
                    res = egen if egen is not None else self.fryser_auto(ret_id)
        except Exception:  # noqa: BLE001 – påmindelsen må aldrig vælte sensorerne
            _LOGGER.exception("Kunne ikke finde kød fra fryseren til %s", dag.dato)
            res = None
        cache[1][dag.dato] = res
        return res

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

    def _opskrift_hist(self) -> tuple[dict[str, dict], dict[str, dict]]:
        """0.14.0: hvor ofte I spiser hvad – hver aften tæller én gang.

        En aften tæller på ReciMe-opskriften, når den peger på opskriften (samme regel som Varer til
        ugen), ellers på jeres egen ret. Første dict: opskrift-id -> antal, sidst. Andet: egen ret-nøgle
        -> antal, sidst for de aftener, der ikke tæller på en opskrift (nøgler uden sådanne aftener mangler).
        """
        today = dt_util.now().date()
        nøgle = (self.bank.version, self.madplan_note.version, today)
        cache = getattr(self, "_ophist_cache", None)
        if cache and cache[0] == nøgle:
            return cache[1]
        out: dict[str, dict] = {}
        egne: dict[str, dict] = {}
        try:
            aftener = pl.laes_historik(self.madplan)
        except Exception:  # noqa: BLE001
            aftener = []
        for a in aftener:
            if a.slags != "ret" or a.dato > today:
                continue
            key = dish_key(a.navn)
            try:
                rid, _navn, kilde = self._ret_for_dag(a)
            except Exception:  # noqa: BLE001
                rid, kilde = None, None
            if kilde == "opskrift" and rid:
                it = out.setdefault(rid, {"antal": 0, "sidst": None})
            elif key:
                it = egne.setdefault(key, {"antal": 0, "sidst": None})
            else:
                continue
            it["antal"] += 1
            it["sidst"] = a.dato.isoformat()
        res = (out, egne)
        self._ophist_cache = (nøgle, res)
        return res

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
        ophist, egne_rest = self._opskrift_hist()
        for r in b.raa:
            rid = "r:" + r["id"]
            varer = b.varer(rid)
            oh = ophist.get(rid) or {}
            for kb in r["kogeboger"]:
                kogeb[kb] += 1
            items.append({
                "id": rid, "type": "opskrift", "navn": op.paen_titel(r["titel"]), "kogeboger": r["kogeboger"],
                "billede": op.billede_url(r["billede"]), "tid": r["tid"]["total"] or None,
                "antal_varer": len(varer or []), "har_varer": bool(varer), "rettet": "varer" in b.egne.get(rid, {}),
                "gange": oh.get("antal", 0), "sidst": oh.get("sidst"),
                "soeg": " ".join(v["navn"].lower() for v in varer or []),
            })
        hist = self._egne_hist()
        # ReciMe-retter, I har spist, står under opskriften – ikke også som en tom egen ret
        ids = ["e:" + k for k in hist
               if k in egne_rest or ("e:" + k) in b.egne or not hist[k].get("antal")]
        ids += [i for i in b.egne if i.startswith("e:") and i[2:] not in hist]
        for eid in ids:
            h = hist.get(eid[2:]) or {}
            h = {**h, **(egne_rest.get(eid[2:]) or {"antal": 0, "sidst": None})}
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
                "rettet_t": e.get("t"), "rettet_af": e.get("af"), "fryser": b.fryser(ret_id),
                "fryser_auto": self.fryser_auto(ret_id),  # 0.15.0: opskriftens kød fra fryseren
                "gange": (self._opskrift_hist()[0].get(ret_id) or {}).get("antal", 0),
                "sidst": (self._opskrift_hist()[0].get(ret_id) or {}).get("sidst"),
            }
        if not ret_id.startswith("e:"):
            raise ValueError("Ukendt ret")
        h = self._egne_hist().get(ret_id[2:]) or {}
        e = b.egne.get(ret_id) or {}
        if not h and not e:
            raise ValueError("Retten findes ikke længere")
        navn = e.get("navn") or h.get("navn") or ret_id[2:]
        h = {**h, **(self._opskrift_hist()[1].get(ret_id[2:]) or {"antal": 0, "sidst": None})}
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
            "rettet_t": e.get("t"), "rettet_af": e.get("af"), "fryser": b.fryser(ret_id),
            **self._saeson_ud(ret_id, kanon),
        }

    def _saeson_ud(self, ret_id: str, kanon: str) -> dict:
        """Sæson til Retter (0.12.6): jeres valg + det, reglerne ville give."""
        std = sae.regel_saeson(kanon)
        egen = self.bank.saeson(ret_id)
        nu = sae.egen_saeson(egen) if egen is not None else std
        return {
            "saeson": egen,
            "saeson_standard": std.tekst() if std else None,
            "saeson_tekst": nu.tekst() if nu else None,
            "saeson_nu": round(sae.faktor(nu, dt_util.now().date()), 2),
        }

    @callback
    def gem_ret(self, ret_id: str | None, user: str | None = None, *, navn: str | None = None,
                varer: list[dict] | None | bool = False, opskrift: str | None | bool = False,
                fryser: list[str] | None | bool = False, saeson: list[str] | None | bool = False) -> dict:
        """Gem jeres indkøbsliste til en ret (eller koblingen til en opskrift). ret_id None = ny egen ret."""
        self._tjek_bank()
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
        if saeson is not False and not ret_id.startswith("e:"):
            raise ValueError("Sæson kan kun sættes på jeres egne retter")
        try:
            self.bank.gem(ret_id, navn=navn, varer=varer, opskrift=opskrift, fryser=fryser, saeson=saeson,
                          t=dt_util.now().isoformat(timespec="seconds"), af=user)
        except KeyError as err:
            raise ValueError("Retten eller opskriften findes ikke længere") from err
        rnavn = (op.paen_titel(self.bank.opskrift(ret_id[2:])["titel"]) if ret_id.startswith("r:")
                 else self._egen_navn(ret_id))
        if saeson is not False and varer is False and opskrift is False and fryser is False:
            s = self.bank.saeson(ret_id)
            tekst = (f'fjernede sæsonen fra "{rnavn}"' if s is None
                     else f'satte "{rnavn}" til hele året' if not s
                     else f'satte sæson på "{rnavn}": ' + ", ".join(sae.SAESONER[k][0].lower() for k in s))
        elif fryser is not False and varer is False and opskrift is False:
            f = self.bank.fryser(ret_id)
            tekst = (f'fjernede "Fra fryseren" fra "{rnavn}"' if f is None
                     else f'satte "Fra fryseren" på "{rnavn}": ' + (" / ".join(f) if f else "intet"))
        elif varer is None and opskrift is False:
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
        # 0.14.0: står opskriftens navn præcis som i planlæggeren ("greek chicken meatballs"), er det
        # opskriften – også når navnet ligner en af jeres egne retter (her kødboller i tomatsauce).
        # Hedder jeres egen ret det samme som opskriften og har sin egen liste (fx "Frikadeller"), vinder den.
        o = self._opskrift_for_tekst(a.original or "")
        egen_liste = eid != "e:" and bool(self.bank.varer(eid))
        if o is not None and self.bank.varer(o.rid) and not (egen_liste and dish_key(o.navn) == dish_key(a.navn)):
            return o.rid, o.navn, "opskrift"
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
        # Køleskabet (0.12.5): "nok" fravælges, "lidt" købes stadig (kun vist)
        kol_nok = [r for r in self.koleskab if r.get("nok")]
        kol_lidt = [r for r in self.koleskab if not r.get("nok")]
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
            # 0.13.0: kødet valgt i madplanen ("burger (❄ kyllingebryst)" / "(❄ intet)") bruges her:
            # intet = opskriftens kød købes; et navngivet kød erstatter opskriftens fryserkød (fra fryseren)
            fv = ((dag.fryser_valg if dag else None) or "").strip().lower()
            erstattet = False
            for v in liste:
                navn_v = v["navn"].strip()
                if not navn_v:
                    continue
                if navn_v.lower() in altid:
                    if navn_v not in skjult:
                        skjult.append(navn_v)
                    continue
                koeb, erstatter = False, None
                if fv and er_fryserkoed(navn_v):
                    if fv == INTET_FRA_FRYSER:
                        koeb = True
                    elif not erstattet:
                        erstattet = True
                        if normalize(fv) != normalize(navn_v):
                            erstatter, navn_v = navn_v, fv[0].upper() + fv[1:]
                k = kat.stamme(normalize(navn_v) or navn_v.lower()) + ("|koeb" if koeb else "")
                it = varer.setdefault(k, {"navn": navn_v, "maengder": {}, "uden_maengde": False, "retter": [], "dage": [],
                                          "koeb": koeb, "erstatter": []})
                if erstatter and erstatter not in it["erstatter"]:
                    it["erstatter"].append(erstatter)
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
            koed = er_fryserkoed(it["navn"]) and not it["koeb"]
            i_kol = "nok" if any(kol.passer(r["navn"], it["navn"]) for r in kol_nok) else (
                "lidt" if any(kol.passer(r["navn"], it["navn"]) for r in kol_lidt) else None)
            grund = ("i kurven" if ex["checked"] else "står på listen") if ex else (
                "i køleskabet" if i_kol == "nok" else (
                    "kød fra fryseren" if koed else (
                        f"købt {UGEDAGE[date.fromisoformat(koebt).weekday()].lower()}" if koebt else (
                            "lidt i køleskabet" if i_kol == "lidt" else None))))
            noegle = kat.gaet(it["navn"]) or kat.FALLBACK
            ud.append({
                "navn": it["navn"], "tekst": tekst, "retter": it["retter"], "dage": it["dage"],
                "kategori": kat.NAVN.get(noegle, ""), "orden": kat.ORDEN.get(noegle, 99),
                "koed": koed, "paa_listen": bool(ex), "linje_id": ex["id"] if ex else None, "koebt": koebt,
                "valgt": not (ex or koed or koebt or i_kol == "nok"), "grund": grund, "koleskab": i_kol,
                **({"erstatter": it["erstatter"]} if it["erstatter"] else {}),  # 0.13.0: ❄-kødet erstatter dette
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
    def tilfoej_til_retter(self, varer: list[dict], user: str | None = None, *,
                           madplan_version: int | None = None) -> dict:
        """Læg ugens varer på listen med retmærke (står varen der, får den bare mærket).

        0.13.0: `madplan_version` = den version, arket "Varer til ugen" blev regnet ud fra. Er madplanen
        ændret siden, afvises tilføjelsen (ConflictError), så arket kan regnes ud igen.
        """
        if madplan_version is not None and madplan_version != self.madplan_note.version:
            raise ConflictError
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
        self._tjek_bank()
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
        self._tjek_bank()
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
        # 0.14.0: ReciMe-opskrifterne som retter (egenskaber, sæson, nye retter)
        alle = self._opskrift_retter()
        kendte = {navn: o.egenskaber() for navn, o in alle.items()}
        model = pl.byg_model(self.madplan, today, foer=start, kendte=kendte)
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
        rester_kol = self._koleskab_til_plan(start)
        skjulte = set(self.planner_data.get("skjulte", []))
        koblede = {e["opskrift"] for e in self.bank.egne.values() if e.get("opskrift")}
        nye_retter = orr.nye_retter(alle, model.profiler, koblede=koblede, skjulte=skjulte) if alle else None
        pl.Planlaegger(model, skjulte=skjulte, seed=seed,
                       koleskab=rester_kol, rester_for=self._rester_for(rester_kol) if rester_kol else None,
                       saeson_for=self._saeson_for_plan(alle), nye=nye_retter, kendte=kendte).planlaeg(
            plan, antal_nye=max(0, min(2, nye)), rester=rester
        )
        return self._plan_svar(model, plan, start, dage, seed, kendte=kendte, alle=alle)

    # ------------------------------------------------------------ ReciMe i planlæggeren (0.14.0)
    def _opskrift_retter(self) -> dict[str, orr.OpskriftRet]:
        """Opskrifterne som retter (kort navn -> egenskaber), regnet om når banken ændres."""
        cache = getattr(self, "_opskr_cache", None)
        if cache and cache[0] == self.bank.version and cache[1] is self.bank:
            return cache[2]
        try:
            konv = self.bank.konverteret()
            antal = {rid: len(k.get("varer") or []) for rid, k in konv.items()}
            for eid, e in self.bank.egne.items():  # jeres rettede indkøbslister tæller med
                if eid.startswith("r:") and e.get("varer") is not None:
                    antal[eid[2:]] = len(e["varer"])
            alle = orr.klassificer(self.bank.raa, antal)
        except Exception:  # noqa: BLE001 – planlæggeren skal virke, selv om en opskrift driller
            _LOGGER.exception("Kunne ikke læse opskrifterne til planlæggeren")
            alle = {}
        self._opskr_cache = (self.bank.version, self.bank, alle)
        return alle

    def _opskrift_for_tekst(self, tekst: str) -> orr.OpskriftRet | None:
        """Opskriften, hvis teksten er præcis dens navn i planlæggeren (store/små bogstaver er lige meget)."""
        t = " ".join((tekst or "").split()).casefold()
        if not t:
            return None
        alle = self._opskrift_retter()
        cache = getattr(self, "_opskr_idx", None)
        if not cache or cache[0] is not alle:
            cache = (alle, {n.casefold(): o for n, o in alle.items()})
            self._opskr_idx = cache
        return cache[1].get(t)

    def _saeson_for_plan(self, alle: dict[str, orr.OpskriftRet]) -> Callable[[str], sae.Saeson | None]:
        """Sæson til planlæggeren: jeres egen (Retter) → opskriftens → de faste regler."""
        def f(navn: str) -> sae.Saeson | None:
            o = alle.get(navn)
            if o is None:
                return self.saeson_for_navn(navn)
            kanon = pl.kanonisk(navn) or (navn[0].upper() + navn[1:])
            key = dish_key(kanon)
            egen = self.bank.saeson("e:" + key) if key else None
            if egen is None:
                egen = self.bank.saeson(o.rid)
            return sae.egen_saeson(egen) if egen is not None else o.saeson
        return f

    def _valg_dict(self, model: pl.Model, v: pl.Valg | None, kendte: dict | None = None,
                   alt: bool = False) -> dict | None:
        if v is None:
            return None
        navn = v.rest_af or v.navn
        egen = pl.egenskaber(navn, kendte)
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
            "varer": [] if (v.rest_af or alt) else egen.get("varer", []),  # 0.14.0: ikke på buddene (kladden)
            "antal": prof.antal if prof and not v.nyt else 0,
            "varianter": varianter,
            "tekst": pl.ret_til_madplan(v.navn),
            "fryser": None if v.rest_af else self.fryser_for_navn(v.navn),
            "koleskab": list(v.koleskab),
            "opskrift": v.opskrift,
        }

    def _stor_portion(self, d: pl.DagPlan) -> bool:
        """Står dagen allerede i madplanen med "(stor portion)"? Så viser planlæggeren den som dobbelt."""
        if not d.eksisterende:
            return False
        eks = self.madplan.get(d.dato)
        return bool(eks and eks.stor_portion)

    def _fryser_valg(self, d: pl.DagPlan) -> str | None:
        """Kød valgt i en tidligere planlægning ("❄ …") for en dag, der allerede står i madplanen."""
        if not d.eksisterende:
            return None
        eks = self.madplan.get(d.dato)
        return eks.fryser_valg.lower() if eks and eks.fryser_valg else None

    def _plan_svar(self, model: pl.Model, plan: list[pl.DagPlan], start: date, dage: int, seed: int, *,
                   kendte: dict | None = None, alle: dict | None = None) -> dict:
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
            "fryser": {p.navn: f for p in model.profiler.values() if (f := self.fryser_for_navn(p.navn))},
            # 0.14.0: ReciMe-opskrifter til søgningen i planlæggeren (ikke babymad, bagning, dips …)
            "opskrifter": [
                {"navn": o.navn, "id": o.rid, "protein": o.protein, "base": o.base, "effort": o.effort}
                for o in sorted((alle or {}).values(), key=lambda x: x.navn.lower())
                if not set(o.kogeboger) & orr.IKKE_MAD
            ],
            "plan": [
                {
                    "dato": d.dato.isoformat(), "ugedag": UGEDAGE[d.dato.weekday()],
                    "tags": sorted(d.tags), "auto_tags": sorted(d.auto_tags), "kalender": d.kalender,
                    "laast": d.laast, "eksisterende": d.eksisterende, "tekst": d.tekst,
                    "stor_portion": self._stor_portion(d),
                    "fryser_valg": self._fryser_valg(d),
                    "valg": self._valg_dict(model, d.valg, kendte),
                    "alternativer": [self._valg_dict(model, a, kendte, alt=True) for a in d.alternativer],
                }
                for d in plan
            ],
        }

    @callback
    def indsaet_uge(self, linjer: list[dict], base_version: int | None = None, user: str | None = None, *,
                    kraev_version: bool = False) -> dict:
        """Skriv den planlagte uge i madplanen.

        0.13.0: dage, der allerede har en linje (fx Mettes tomme skabelon "Uge 43"), skrives på
        den linje; manglende dage sættes ind i den uge, de hører til; kun dage uden nogen uge får en
        ny "Uge NN"-blok øverst (som før). Er madplanen ændret siden `base_version`, gemmes kun, hvis
        de dage, der skrives, er uændrede (ellers ConflictError).
        """
        n = self.madplan_note
        dage = sorted(
            ((date.fromisoformat(x["dato"]), (x.get("linje") or "").strip()) for x in linjer),
            key=lambda t: t[0],
        )
        if not dage:
            return {"version": n.version}
        if base_version is None and kraev_version:
            raise ConflictError
        today = dt_util.now().date()
        if base_version is not None and base_version != n.version:
            base = self._madplan_tekst(base_version)
            if base is None:
                raise ConflictError
            vb, vn = vindere(scan_linjer(base, today)), vindere(scan_linjer(n.text, today))
            for d, _ln in dage:
                rb = vb[d].dag.raw.strip() if d in vb else ""
                rn = vn[d].dag.raw.strip() if d in vn else ""
                if rb != rn:
                    raise ConflictError
        ud = []
        for d, ln in dage:
            # Linjen kommer fra panelet; sikr at den starter med den rigtige ugedag
            body = ln.split(":", 1)[1].strip() if ":" in ln[:10] else ln
            ud.append((d, f"{UGEDAGE[d.weekday()]}: {body}".rstrip()))
        ny_tekst, info = self._indsaet_i_tekst(n.text, ud, today)
        self.set_madplan(ny_tekst, n.version, user)
        self._log(user, "madplan", f"planlagde uge {dage[0][0].isocalendar()[1]} med ugeplanlæggeren", key="madplan:plan")
        return {"version": self.madplan_note.version, **info}

    @staticmethod
    def _indsaet_i_tekst(tekst: str, dage: list[tuple[date, str]], today: date) -> tuple[str, dict]:
        """Sæt dag-linjer ind i madplan-teksten uden at røre andre linjer (0.13.0)."""
        def ny_blok(rest: list[tuple[date, str]], gammel: str) -> str:
            blok = f"Uge {rest[0][0].isocalendar()[1]}\n" + "\n".join(x for _d, x in rest)
            gammel = gammel.strip()
            return blok + ("\n\n" + gammel if gammel else "") + "\n"

        if not tekst.strip() or any(ch in tekst for ch in _ANDRE_LINJESKIFT):
            return ny_blok(dage, tekst), {"erstattet": 0, "indsat": 0, "ny_blok": True}
        linjer = scan_linjer(tekst, today)
        vind = vindere(linjer)
        blokke: dict[int, list] = {}
        for ln in linjer:
            blokke.setdefault(ln.blok, []).append(ln)
        # nyeste uge først (samme regel som parseren: senest startende blok vinder)
        orden = sorted(blokke.values(), key=lambda b: b[0].dag.dato, reverse=True)
        erstat: dict[int, str] = {}
        efter: dict[int, list[tuple[date, str]]] = {}
        rest: list[tuple[date, str]] = []
        for d, ny in dage:
            if (v := vind.get(d)) is not None:
                erstat[v.idx] = ny
                continue
            placeret = False
            for b in orden:
                # kun ind i en uge, dagen hører til: højst 6 dage efter ugens første dag
                foer = [ln for ln in b if ln.dag.dato < d]
                if not foer or (d - b[0].dag.dato).days > 6:
                    continue
                efter.setdefault(foer[-1].idx, []).append((d, ny))
                placeret = True
                break
            if not placeret:
                rest.append((d, ny))
        rader = tekst.splitlines()
        ud: list[str] = []
        for i, r in enumerate(rader):
            ud.append(erstat.get(i, r))
            ud.extend(x for _d, x in sorted(efter.get(i, [])))
        res = "\n".join(ud) + ("\n" if tekst.endswith("\n") else "")
        info = {"erstattet": len(erstat), "indsat": sum(len(v) for v in efter.values()), "ny_blok": bool(rest)}
        if rest:
            res = ny_blok(rest, res)
        return res, info

    # ------------------------------------------------------------ kladde (0.12.3)
    def kladde_hent(self) -> dict | None:
        """Ugeplanlæggerens kladde: den uge der er ved at blive planlagt (fælles for alle)."""
        return self.planner_data.get("kladde")

    @callback
    def kladde_gem(self, kladde: dict, user: str | None = None) -> dict:
        """Gem kladden løbende, så et fejlklik/luk ikke mister ugen. Ingen log og ingen push."""
        if len(json.dumps(kladde, ensure_ascii=False)) > KLADDE_MAX:
            raise ValueError("Kladden er for stor")
        meta = {"tid": dt_util.now().isoformat(timespec="seconds"), "af": user}
        self.planner_data["kladde"] = {**meta, "kladde": kladde}
        self._save()
        return meta

    @callback
    def kladde_slet(self) -> None:
        if self.planner_data.pop("kladde", None) is not None:
            self._save()

    # ------------------------------------------------------------ køleskabet (0.12.5)
    def _ret_varenavne(self, navn: str) -> list[str]:
        """Varenavnene til en ret: jeres egen liste (eller opskriften med samme navn) + planlæggerens nøglevarer."""
        if not navn:
            return []
        if not self._varenavne_cache or self._varenavne_cache[0] != self.bank.version:
            self._varenavne_cache = (self.bank.version, {})
        cache = self._varenavne_cache[1]
        if navn not in cache:
            kendt = navn in pl.RETTER or any(n["navn"] == navn for n in pl.NYE)
            kanon = navn if kendt else (pl.kanonisk(navn) or (navn[:1].upper() + navn[1:]))
            ud: list[str] = []
            try:
                ret_id, _, kilde = self._ret_for_dag(pl.Aften(dt_util.now().date(), "ret", kanon, navn))
                if ret_id and kilde:
                    ud += [v["navn"] for v in self.bank.varer(ret_id) or [] if v.get("navn")]
            except Exception:  # noqa: BLE001 – varerne er en hjælp, ikke et krav
                _LOGGER.debug("Kunne ikke finde varer til %s", navn, exc_info=True)
            ud += list(pl.egenskaber(kanon).get("varer", []))
            cache[navn] = ud
        return cache[navn]

    def _rester_for(self, rester: list[str]) -> Callable[[str, str], list[str]]:
        """Til planlæggeren: hvilke af resterne bruger en ret (navn + evt. madplan-linje)?"""
        memo: dict[tuple[str, str], list[str]] = {}

        def f(navn: str, tekst: str = "") -> list[str]:
            key = (navn, tekst)
            if key not in memo:
                varer = self._ret_varenavne(navn)
                memo[key] = [r for r in rester if kol.bruger(r, varer, tekst)]
            return memo[key]

        return f

    def _kol_start(self, it: dict) -> date:
        """Første dag en rest kan bruges: dagen den kom i køleskabet – efter aftensmaden (kl. 18) dagen efter."""
        t = dt_util.parse_datetime(it.get("t") or "")
        if t is None:
            return dt_util.now().date()
        t = dt_util.as_local(t)
        return t.date() + timedelta(days=1 if t.hour >= FROST_SKIFT_TIME else 0)

    def _koleskab_brug(self) -> dict[str, dict]:
        """Rest-id → den første dag i madplanen (fra resten kom i køleskabet), hvis ret bruger resten."""
        if not self.koleskab:
            return {}
        key = (self.madplan_note.version, self.bank.version, dt_util.now().date(),
               tuple((it["id"], it["navn"], it.get("t")) for it in self.koleskab))
        if self._kol_brug_cache and self._kol_brug_cache[0] == key:
            return self._kol_brug_cache[1]
        try:
            aftener = [a for a in pl.laes_historik(self.madplan) if a.slags == "ret"]
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Kunne ikke læse madplanen")
            aftener = []
        tidligst = min(self._kol_start(it) for it in self.koleskab)
        aftener = [a for a in aftener if a.dato >= tidligst]
        ud: dict[str, dict] = {}
        for it in self.koleskab:
            start = self._kol_start(it)
            for a in aftener:
                if a.dato < start:
                    continue
                dag = self.madplan.get(a.dato)
                if kol.bruger(it["navn"], self._ret_varenavne(a.navn), dag.raw if dag else ""):
                    ud[it["id"]] = {"dato": a.dato.isoformat(), "ugedag": UGEDAGE[a.dato.weekday()],
                                    "ret": a.original}
                    break
        self._kol_brug_cache = (key, ud)
        return ud

    def koleskab_liste(self) -> list[dict]:
        """Køleskabet til panel og planlægger: resterne + hvilken dag i madplanen der bruger dem."""
        if not self.koleskab:
            return []
        brug = self._koleskab_brug()
        return [{**it, "fast": self.is_fast(it["navn"]), "bruges": brug.get(it["id"])} for it in self.koleskab]

    def _koleskab_til_plan(self, start: date) -> list[str]:
        """Rester planlæggeren skal bruge: dem ingen dag før planens første dag allerede bruger."""
        brug = self._koleskab_brug()
        return [it["navn"] for it in self.koleskab
                if not (b := brug.get(it["id"])) or date.fromisoformat(b["dato"]) >= start]

    @callback
    def _koleskab_opbrug(self, notify: bool = True) -> list[dict]:
        """Dagen efter retten: rester, en ret i madplanen har brugt, fjernes fra køleskabet."""
        if not self.koleskab:
            return []
        today = dt_util.now().date()
        brug = self._koleskab_brug()
        brugt = [(it, b) for it in self.koleskab if (b := brug.get(it["id"])) and date.fromisoformat(b["dato"]) < today]
        if not brugt:
            return []
        ids = {it["id"] for it, _ in brugt}
        self.koleskab = [it for it in self.koleskab if it["id"] not in ids]
        for it, b in brugt:
            self._log("Automatisk", "koleskab", f'fjernede "{it["navn"]}" fra køleskabet – brugt {b["ugedag"].lower()} ({b["ret"]})')
        self._save()
        if notify:
            self._notify()
        return [it for it, _ in brugt]

    def _fjern_fra_listen(self, rester: list[dict], user: str | None) -> list[dict]:
        """Fjern ukøbte varer fra indkøbslisten, der er det samme som rester mærket "Nok".

        Returnerer de fjernede linjer med `prev` (linjen før, som ikke selv blev fjernet) til Fortryd.
        """
        if not rester:
            return []
        lines = self.indkob.lines
        fjern_ids: set[str] = set()
        ud: list[dict] = []
        for ln in lines:
            if ln["type"] != TYPE_ITEM or ln["checked"] or not ln["text"].strip():
                continue
            if any(kol.passer(r["navn"], ln["text"]) for r in rester):
                fjern_ids.add(ln["id"])
        if not fjern_ids:
            return []
        prev = None
        for ln in lines:
            if ln["id"] in fjern_ids:
                ud.append({"text": ln["text"], "type": ln["type"], "checked": False, "prev": prev,
                           "ret": list(ln.get("ret") or [])})
            else:
                prev = ln["id"]
        self.indkob.delete(list(fjern_ids))
        self._log(user, "indkob", "fjernede " + _names([x["text"] for x in ud]) + " fra listen – står i køleskabet")
        self.indkob_changed(user)
        return ud

    def _fast_tilbage(self, rester: list[dict], user: str | None) -> list[dict]:
        """0.15.0: faste varer, som "Nok" i køleskabet holdt væk, kommer på listen igen, når resten
        sættes til "Lidt" eller tages ud af køleskabet. Står varen der allerede – eller siger en
        anden rest stadig "Nok" – sker intet. Returnerer de linjer, der kom på listen."""
        if not rester:
            return []
        ids = {r["id"] for r in rester}
        andre_nok = [r for r in self.koleskab if r.get("nok") and r["id"] not in ids]
        ud: list[dict] = []
        for b in self.basis.items():
            if self.indkob.find_item(b["text"]) is not None:
                continue
            if not any(kol.passer(r["navn"], b["text"]) for r in rester):
                continue
            if any(kol.passer(r["navn"], b["text"]) for r in andre_nok):
                continue
            header = self.indkob.learned_header(b["text"]) or self.basis.category_of(b["id"])
            ud.append(self.indkob.add_under(b["text"], header))
        if ud:
            self._log(user, "indkob", "satte " + _names([x["text"] for x in ud])
                      + " på listen igen – ikke længere nok i køleskabet")
            self.indkob_changed(user)
        return ud

    @callback
    def koleskab_tilfoej(self, navne: list[str], user: str | None = None, *, nok: bool | None = None,
                         liste: bool = True) -> dict:
        """Læg rester i køleskabet ("fløde, champignon" giver to). Nok = fjernes fra indkøbslisten."""
        now = dt_util.now().isoformat(timespec="seconds")
        nye, fandtes = [], []
        for raw in navne:
            for del_ in re.split(r"[,;\n]", raw or ""):
                tekst = " ".join(del_.split()).strip(" .-")[:60]
                if not kol.ord_i(tekst):
                    continue
                tekst = tekst[:1].upper() + tekst[1:]
                key = " ".join(kol.ord_i(tekst))
                ex = next((x for x in self.koleskab + nye if " ".join(kol.ord_i(x["navn"])) == key
                           or kat.stamme(" ".join(kol.ord_i(x["navn"]))) == kat.stamme(key)), None)
                if ex:
                    if ex not in fandtes and ex not in nye:
                        fandtes.append(ex)
                    continue
                if len(self.koleskab) + len(nye) >= KOLESKAB_MAX:
                    raise ValueError(f"Der kan højst stå {KOLESKAB_MAX} rester i køleskabet")
                nye.append({"id": new_id(), "navn": tekst, "nok": (not self.is_fast(tekst)) if nok is None else bool(nok),
                            "t": now, "af": user})
        if not nye:
            return {"tilfoejet": [], "fandtes": fandtes, "fjernet": []}
        self.koleskab.extend(nye)
        self._log(user, "koleskab", "lagde " + _names([f'{x["navn"]}' + ("" if x["nok"] else " (lidt)") for x in nye])
                  + " i køleskabet")
        fjernet = self._fjern_fra_listen([x for x in nye if x["nok"]], user) if liste else []
        self._save()
        self._notify()
        return {"tilfoejet": nye, "fandtes": fandtes, "fjernet": fjernet}

    def _kol_item(self, rest_id: str) -> dict:
        it = next((x for x in self.koleskab if x["id"] == rest_id), None)
        if it is None:
            raise ValueError("Resten findes ikke længere i køleskabet")
        return it

    @callback
    def koleskab_saet(self, rest_id: str, nok: bool, user: str | None = None) -> dict:
        """Skift mellem "Nok" (købes ikke – fjernes fra listen) og "Lidt" (købes stadig)."""
        it = self._kol_item(rest_id)
        if bool(it.get("nok")) == bool(nok):
            return {"rest": it, "fjernet": []}
        it["nok"] = bool(nok)
        self._log(user, "koleskab", f'satte "{it["navn"]}" i køleskabet til {"nok" if nok else "lidt (købes stadig)"}',
                  key=f"kol:{rest_id}", window=120)
        fjernet = self._fjern_fra_listen([it], user) if nok else []
        tilbage = [] if nok else self._fast_tilbage([it], user)  # 0.15.0
        self._save()
        self._notify()
        return {"rest": it, "fjernet": fjernet, "tilbage": tilbage}

    @callback
    def koleskab_fjern(self, rest_ids: list[str], user: str | None = None) -> dict:
        """Tag rester ud af køleskabet (brugt, smidt ud …).

        0.15.0: en fast vare, som resten ("Nok") holdt væk fra indkøbslisten, kommer på listen igen.
        Andre varer på listen røres ikke."""
        ids = set(rest_ids)
        ud = [x for x in self.koleskab if x["id"] in ids]
        tilbage: list[dict] = []
        if ud:
            self.koleskab = [x for x in self.koleskab if x["id"] not in ids]
            self._log(user, "koleskab", "tog " + _names([x["navn"] for x in ud]) + " ud af køleskabet")
            tilbage = self._fast_tilbage([x for x in ud if x.get("nok")], user)
            self._save()
            self._notify()
        return {"fjernet": ud, "tilbage": tilbage}

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
        return {"version": k["version"], **k["antal"], "importeret": k["importeret"],
                "laast": getattr(self, "_bank_laast", None)}

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
                         "antal": len(st["line_ids"]) + st.get("slettet", 0)}
                        for st in self._stops()
                    ],
                    "koebt": self.bought(),
                },
                "butik_orden": self._butik_orden_ud(),  # 0.15.0
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
                # 0.13.0: dage der står forskelligt i to uger (kun advarsel) + hvor "Ny uge" skal starte
                "overlap": getattr(self, "_overlap", []),
                "ny_uge": self.ny_uge(),
            },
            "stats": {k: v for k, v in self.stats.items() if k != "varer"},
            "indstillinger": self.settings(),
            "retter": self._retter_resume(),
            "koleskab": self.koleskab_liste(),
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


# Korte ord i madplanen, der peger på en slags kød (0.12.4): "burger kylling", "pita m oksekød", "hakkekød"
_KOED_BEGREBER: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("kylling", ("kylling", "kylle", "kalkun")),
    ("okse", ("okse",)),
    ("hakket", ("hakke", "hakket", "fars", "deller")),
    ("svin", ("svin", "gris", "flæsk", "nakke")),
    ("kalv", ("kalv",)),
    ("lam", ("lam",)),
    ("laks", ("laks",)),
    ("torsk", ("torsk",)),
    ("fisk", ("fisk",)),
    ("rejer", ("reje",)),
    ("pølse", ("pølse",)),
    ("bryst", ("bryst",)),
    ("lår", ("lår",)),
    ("hel", ("hel",)),
)


def _koed_begreber(tekst: str) -> set[str]:
    """Hvilke slags kød nævner teksten? ("kyllingebryst" → kylling + bryst, "hakkekød" → hakket)."""
    ord_ = re.findall(r"[a-zæøåé]+", (tekst or "").lower())
    ud = set()
    for begreb, stammer in _KOED_BEGREBER:
        for w in ord_:
            if any((w.startswith(st) if len(st) <= 3 else st in w) for st in stammer):
                ud.add(begreb)
                break
    return ud


def koed_i_tekst(muligheder: list[str], tekst: str) -> list[str]:
    """De muligheder, madplanens tekst peger på: præcist navn → flest fælles kød-ord → alle."""
    low = (tekst or "").lower()
    praecis = [a for a in muligheder if a in low]
    if len(praecis) == 1:
        return praecis
    nævnt = _koed_begreber(low)
    if not nævnt:
        return list(muligheder)
    score = {a: len(_koed_begreber(a) & nævnt) for a in muligheder}
    bedst = max(score.values())
    return [a for a in muligheder if score[a] == bedst] if bedst else list(muligheder)


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

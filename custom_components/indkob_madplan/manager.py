"""Kernen: ejer de to noter, logger køb og leverer madplanen."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_EXTRA_KOED,
    CONF_FROST_DAY,
    CONF_IGNORE_KOED,
    FROST_TOMORROW,
    NOTE_INDKOB,
    NOTE_MADPLAN,
    SIGNAL_UPDATE,
    STORAGE_KEY,
    STORAGE_VERSION,
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

    # ------------------------------------------------------------ options
    @property
    def opts(self) -> dict[str, Any]:
        return {**self.entry.data, **self.entry.options}

    @property
    def frost_tomorrow(self) -> bool:
        return self.opts.get(CONF_FROST_DAY) == FROST_TOMORROW

    @property
    def koed_ord(self) -> list[str]:
        ignore = set(_split_words(self.opts.get(CONF_IGNORE_KOED)))
        words = DEFAULT_KOED_ORD + _split_words(self.opts.get(CONF_EXTRA_KOED))
        return [w for w in words if w.strip().lower() not in ignore]

    # ------------------------------------------------------------ lifecycle
    async def async_start(self) -> None:
        data = await self.store.async_load() or {}
        self.indkob = ShoppingNote(data.get(NOTE_INDKOB))
        self.madplan_note = TextNote(data.get(NOTE_MADPLAN))
        self.history = History(data.get("history"))
        self._unsubs.append(
            async_track_time_change(self.hass, self._on_midnight, hour=0, minute=0, second=5)
        )
        self._parse_madplan()
        self._feed_history()
        self.stats = self.history.compute(dt_util.now())

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
        }

    def _save(self) -> None:
        self.store.async_delay_save(self._data, 2)

    @callback
    def _on_midnight(self, _now: datetime) -> None:
        self._parse_madplan()
        self.stats = self.history.compute(dt_util.now())
        self._notify()

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
    def _feed_history(self) -> None:
        items = [
            {"uid": ln["id"], "summary": ln["text"], "status": "completed" if ln["checked"] else "needs_action"}
            for ln in self.indkob.items()
        ]
        new = self.history.apply_items(items, dt_util.now())
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
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    @callback
    def add_item(self, text: str, user: str | None = None, **kwargs: Any) -> dict:
        line = self.indkob.add(text, **kwargs)
        self.indkob_changed(user)
        return line

    @callback
    def add_items_auto(self, texts: list[str], user: str | None = None) -> list[dict]:
        lines = [self.indkob.add(t, line_type=TYPE_ITEM, auto_place=True) for t in texts if t.strip()]
        if lines:
            self.indkob_changed(user)
        return lines

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
        self.history.events = []
        self.history.names = {}
        self.stats = self.history.compute(dt_util.now())
        self._save()
        self._notify()

    # ------------------------------------------------------------ views
    def state(self) -> dict:
        """Alt hvad panel og kort skal bruge."""
        return {
            "indkob": {k: v for k, v in self.indkob.as_dict().items() if k != "categories"},
            "madplan": {
                **self.madplan_note.as_dict(),
                "dage": self.uge(-1, 9),
                "frost_dag": "i morgen" if self.frost_tomorrow else "i dag",
            },
            "stats": {k: v for k, v in self.stats.items() if k != "varer"},
        }

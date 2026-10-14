"""Indkøb & Madplan – familiens indkøbsliste og madplan som noter i Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import panel_custom, websocket_api
from homeassistant.components.frontend import add_extra_js_url, async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_FILE,
    DOMAIN,
    NOTE_INDKOB,
    NOTE_MADPLAN,
    PANEL_ELEMENT,
    PANEL_FILE,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    URL_BASE,
    VERSION,
)
from .manager import ConflictError, IndkobMadplanManager
from .notes import LINE_TYPES, TYPE_ITEM

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.TODO]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type IndkobConfigEntry = ConfigEntry[IndkobMadplanManager]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    frontend_dir = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(frontend_dir), cache_headers=False)]
    )
    add_extra_js_url(hass, f"{URL_BASE}/{CARD_FILE}?v={VERSION}")
    for cmd in (
        ws_subscribe, ws_state, ws_add, ws_update, ws_delete, ws_move,
        ws_clear_checked, ws_uncheck_all, ws_madplan_set,
    ):
        websocket_api.async_register_command(hass, cmd)
    _register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: IndkobConfigEntry) -> bool:
    manager = IndkobMadplanManager(hass, entry)
    entry.runtime_data = manager
    await manager.async_start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        module_url=f"{URL_BASE}/{PANEL_FILE}?v={VERSION}",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=False,
        config={},
    )
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: IndkobConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        async_remove_panel(hass, PANEL_URL_PATH)
        await entry.runtime_data.async_stop()
    return ok


async def _async_reload(hass: HomeAssistant, entry: IndkobConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


def _manager(hass: HomeAssistant) -> IndkobMadplanManager:
    for e in hass.config_entries.async_loaded_entries(DOMAIN):
        if getattr(e, "runtime_data", None) is not None:
            return e.runtime_data
    raise ServiceValidationError("Indkøb & Madplan er ikke sat op")


def _user(connection: websocket_api.ActiveConnection) -> str | None:
    return connection.user.name if connection.user else None


# ---------------------------------------------------------------- websocket
def _ws(schema: dict):
    """Fælles indpakning: find manager, fang fejl, send resultat."""

    def deco(func):
        @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/{func.__name__[3:].replace('__', '/')}", **schema})
        @callback
        def handler(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
            try:
                m = _manager(hass)
            except ServiceValidationError as err:
                connection.send_error(msg["id"], "not_configured", str(err))
                return
            try:
                result = func(m, msg, _user(connection))
            except KeyError:
                connection.send_error(msg["id"], "not_found", "Linjen findes ikke længere")
                return
            except ConflictError:
                connection.send_error(msg["id"], "conflict", "Madplanen er ændret af en anden")
                return
            connection.send_result(msg["id"], result)

        return handler

    return deco


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    try:
        m = _manager(hass)
    except ServiceValidationError as err:
        connection.send_error(msg["id"], "not_configured", str(err))
        return

    @callback
    def _send() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], m.state()))

    connection.subscriptions[msg["id"]] = m.add_listener(_send)
    connection.send_result(msg["id"])
    _send()


@_ws({})
def ws_state(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.state()


@_ws({
    vol.Required("text"): str,
    vol.Optional("after_id"): vol.Any(str, None),
    vol.Optional("line_type"): vol.In(LINE_TYPES),
    vol.Optional("auto_place", default=False): bool,
})
def ws_indkob__add(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.add_item(
        msg["text"], user,
        after_id=msg.get("after_id"),
        line_type=msg.get("line_type"),
        auto_place=msg["auto_place"],
    )


@_ws({
    vol.Required("line_id"): str,
    vol.Optional("text"): str,
    vol.Optional("checked"): bool,
    vol.Optional("line_type"): vol.In(LINE_TYPES),
})
def ws_indkob__update(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    line = m.indkob.update(msg["line_id"], text=msg.get("text"), checked=msg.get("checked"), line_type=msg.get("line_type"))
    m.indkob_changed(user)
    return line


@_ws({vol.Required("line_ids"): [str]})
def ws_indkob__delete(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.indkob.delete(msg["line_ids"])
    m.indkob_changed(user)


@_ws({vol.Required("line_id"): str, vol.Optional("after_id"): vol.Any(str, None)})
def ws_indkob__move(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.indkob.move(msg["line_id"], msg.get("after_id"))
    m.indkob_changed(user)


@_ws({})
def ws_indkob__clear_checked(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    n = m.indkob.clear_checked()
    m.indkob_changed(user)
    return {"fjernet": n}


@_ws({})
def ws_indkob__uncheck_all(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.indkob.uncheck_all()
    m.indkob_changed(user)


@_ws({vol.Required("text"): str, vol.Optional("base_version"): vol.Any(int, None)})
def ws_madplan__set(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    m.set_madplan(msg["text"], msg.get("base_version"), user)
    return {"version": m.madplan_note.version}


# Navnene på handlerne bestemmer websocket-typen: ws_indkob__add -> indkob_madplan/indkob/add
ws_add, ws_update, ws_delete, ws_move = ws_indkob__add, ws_indkob__update, ws_indkob__delete, ws_indkob__move
ws_clear_checked, ws_uncheck_all, ws_madplan_set = ws_indkob__clear_checked, ws_indkob__uncheck_all, ws_madplan__set


# ---------------------------------------------------------------- services
def _register_services(hass: HomeAssistant) -> None:
    async def _import(call: ServiceCall) -> None:
        m = _manager(hass)
        if call.data["note"] == NOTE_INDKOB:
            m.indkob.import_text(call.data["tekst"])
            m.history.snapshot = None  # import er ny grundlinje, ikke køb
            m.indkob_changed("Import")
        else:
            m.set_madplan(call.data["tekst"], user="Import")

    async def _export(call: ServiceCall) -> dict[str, Any]:
        m = _manager(hass)
        return {"indkobsliste": m.indkob.as_text(), "madplan": m.madplan_note.text}

    async def _add(call: ServiceCall) -> dict[str, Any]:
        lines = _manager(hass).add_items_auto(call.data["varer"], "Home Assistant")
        return {"tilfoejet": [ln["text"] for ln in lines]}

    async def _add_suggestions(call: ServiceCall) -> dict[str, Any]:
        m = _manager(hass)
        names = [s["navn"] for s in m.stats.get("forslag", [])]
        wanted = {w.lower() for w in call.data.get("varer") or []}
        if wanted:
            names = [n for n in names if n.lower() in wanted]
        m.add_items_auto(names, "Home Assistant")
        return {"tilfoejet": names}

    async def _stats(call: ServiceCall) -> dict[str, Any]:
        m = _manager(hass)
        return {"stats": m.stats, "madplan": m.uge(-7, 21)}

    async def _clear(call: ServiceCall) -> None:
        await _manager(hass).async_clear_history()

    hass.services.async_register(
        DOMAIN, "importer", _import,
        schema=vol.Schema({vol.Required("note"): vol.In([NOTE_INDKOB, NOTE_MADPLAN]), vol.Required("tekst"): cv.string}),
    )
    hass.services.async_register(DOMAIN, "eksporter", _export, supports_response=SupportsResponse.ONLY)
    hass.services.async_register(
        DOMAIN, "tilfoej", _add,
        schema=vol.Schema({vol.Required("varer"): vol.All(cv.ensure_list, [cv.string])}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, "tilfoej_forslag", _add_suggestions,
        schema=vol.Schema({vol.Optional("varer"): vol.All(cv.ensure_list, [cv.string])}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(DOMAIN, "hent_statistik", _stats, supports_response=SupportsResponse.ONLY)
    hass.services.async_register(
        DOMAIN, "nulstil_statistik", _clear,
        schema=vol.Schema({vol.Required("bekraeft"): vol.All(cv.boolean, vol.In([True]))}),
    )

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
    CONF_EXTRA_KOED,
    CONF_FROST_DAY,
    CONF_IGNORE_KOED,
    CONF_PLAN_KALENDER,
    CONF_TRIP_DELAY,
    CONF_TRIP_THRESHOLD,
    DOMAIN,
    FROST_TODAY,
    FROST_TOMORROW,
    NOTE_BASIS,
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
from .manager import ConflictError, FletKonflikt, IndkobMadplanManager
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
        ws_clear_checked, ws_uncheck_all, ws_madplan_set, ws_madplan_retter, ws_settings_set, ws_stats_clear,
        ws_trip_update, ws_trip_add, ws_trip_delete, ws_trip__spring_pris,
        ws_madplan_planlaeg, ws_madplan_indsaet, ws_madplan_skjul, ws_indkob_tilfoej, ws_indkob_kategori,
        ws_indkob__butik_afslut, ws_indkob__butik_ret, ws_indkob__butik_fortryd, ws_indkob__fast,
        ws_retter__liste, ws_retter__hent, ws_retter__gem, ws_retter__paa_listen,
        ws_omregning__hent, ws_omregning__saet, ws_opskrifter__importer,
        ws_madplan__varer, ws_indkob__tilfoej_retter, ws_stats__slet_vare,
        ws_madplan__kladde__hent, ws_madplan__kladde__gem, ws_madplan__kladde__slet,
        ws_koleskab__tilfoej, ws_koleskab__saet, ws_koleskab__fjern, ws_koleskab__ny_planlaegning,
        ws_madplan__versioner, ws_butik__orden__saet, ws_butik__orden__nulstil,
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
        # Panelet tegner selv under statuslinjen (iOS); ellers lægger HA en tom bjælke ovenover.
        handle_safe_area=True,
    )
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: IndkobConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        async_remove_panel(hass, PANEL_URL_PATH)
        await entry.runtime_data.async_stop()
    return ok


async def _async_options_updated(hass: HomeAssistant, entry: IndkobConfigEntry) -> None:
    # Alle indstillinger læses live – ingen genindlæsning (så panelet ikke forsvinder imens).
    entry.runtime_data.options_changed()


def _manager(hass: HomeAssistant) -> IndkobMadplanManager:
    for e in hass.config_entries.async_loaded_entries(DOMAIN):
        if getattr(e, "runtime_data", None) is not None:
            return e.runtime_data
    raise ServiceValidationError("Indkøb & Madplan er ikke sat op")


def _user(connection: websocket_api.ActiveConnection) -> str | None:
    return connection.user.name if connection.user else None


# Hvilken tjekliste en kommando gælder: indkøbslisten (standard) eller basislisten
NOTE_FIELD = {vol.Optional("note", default=NOTE_INDKOB): vol.In([NOTE_INDKOB, NOTE_BASIS])}
TEXT = vol.All(str, vol.Length(max=200))


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
            except ValueError as err:
                connection.send_error(msg["id"], "invalid", str(err))
                return
            except FletKonflikt as err:  # 0.13.0: samme linjer ændret begge steder
                connection.send_error(msg["id"], "flet_konflikt", str(err))
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
    vol.Required("text"): TEXT,
    vol.Optional("after_id"): vol.Any(str, None),
    vol.Optional("line_type"): vol.In(LINE_TYPES),
    vol.Optional("auto_place", default=False): bool,
    vol.Optional("checked", default=False): bool,
    vol.Optional("restore", default=False): bool,  # gendan en slettet linje (fortryd)
    vol.Optional("dedupe", default=False): bool,  # står varen der allerede, bruges den i stedet
    **NOTE_FIELD,
})
def ws_indkob__add(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    note = msg["note"]
    ex = m._existing(msg["text"], note) if (msg["auto_place"] or msg["dedupe"]) and not msg["restore"] else None
    ln = m.add_item(
        msg["text"], user,
        restore=msg["restore"],
        dedupe=msg["dedupe"],
        note=note,
        after_id=msg.get("after_id"),
        line_type=msg.get("line_type"),
        auto_place=msg["auto_place"],
        checked=msg["checked"],
    )
    # "fandtes": varen stod der allerede (intet nyt blev tilføjet); "fast": står den i basislisten
    return {**ln, "kategori": m.category_of(ln["id"], note), "fandtes": ex is not None,
            "fast": note == NOTE_BASIS or m.is_fast(ln["text"])}


@_ws({
    vol.Required("line_id"): str,
    vol.Optional("header_id"): vol.Any(str, None),
    vol.Optional("noegle"): vol.Any(str, None),
    **NOTE_FIELD,
})
def ws_indkob__kategori(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return {"kategori": m.set_category(msg["line_id"], user, header_id=msg.get("header_id"), noegle=msg.get("noegle"),
                                       note=msg["note"])}


@_ws({
    vol.Required("line_id"): str,
    vol.Optional("text"): TEXT,
    vol.Optional("checked"): bool,
    vol.Optional("line_type"): vol.In(LINE_TYPES),
    vol.Optional("dedupe", default=False): bool,  # 0.15.0: færdig med at skrive – flet med samme vare
    **NOTE_FIELD,
})
def ws_indkob__update(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.update_line(msg["line_id"], user, text=msg.get("text"), checked=msg.get("checked"),
                         line_type=msg.get("line_type"), note=msg["note"], dedupe=msg["dedupe"])


@_ws({vol.Required("line_ids"): [str], **NOTE_FIELD})
def ws_indkob__delete(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.delete_lines(msg["line_ids"], user, msg["note"])


@_ws({vol.Required("line_id"): str, vol.Optional("after_id"): vol.Any(str, None), **NOTE_FIELD})
def ws_indkob__move(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.move_line(msg["line_id"], msg.get("after_id"), user, msg["note"])


@_ws({vol.Required("line_id"): str, vol.Required("fast"): bool})
def ws_indkob__fast(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    """Gør en vare på indkøbslisten fast (i basislisten) eller engangs."""
    return {"fast": m.set_fast(msg["line_id"], msg["fast"], user)}


@_ws({})
def ws_indkob__clear_checked(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return {"fjernet": m.finish_trip(user, delete=True)}


@_ws({
    vol.Optional("butik"): vol.Any(None, vol.All(str, vol.Length(max=60))),
    vol.Optional("beloeb"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=100000))),
    vol.Optional("fjern"): [str],
})
def ws_indkob__uncheck_all(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    """Færdig med at handle: (butik + beløb) → nulstil listen til basislisten."""
    m.finish_trip(user, butik=msg.get("butik"), beloeb=msg.get("beloeb"), fjern=msg.get("fjern"))
    return {"trip_id": m.last_finished_trip}


@_ws({
    vol.Required("text"): vol.All(str, vol.Length(max=200000)),
    vol.Optional("base_version"): vol.Any(int, None),
    vol.Optional("flet", default=False): bool,  # 0.13.0: flet med ændringer gjort imens (linje for linje)
})
def ws_madplan__set(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    # 0.13.0: uden version afvises skrivningen (så hele madplanen aldrig overskrives i blinde);
    # tjenesten indkob_madplan.importer er stadig en bevidst import uden version.
    return m.set_madplan(msg["text"], msg.get("base_version"), user, kraev_version=True, flet=msg["flet"])


@_ws({})
def ws_madplan__versioner(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    """0.13.0: tidligere versioner af madplanen (til "Tidligere versioner" og gendannelse)."""
    return m.madplan_versioner()


@_ws({})
def ws_madplan__retter(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.retter()


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/madplan/planlaeg",
    vol.Optional("start"): vol.Any(cv.date, None),
    vol.Optional("dage"): vol.Any(vol.All(vol.Coerce(int), vol.Range(min=3, max=14)), None),
    vol.Optional("tags"): {cv.string: [cv.string]},
    vol.Optional("laaste"): {cv.string: cv.string},
    vol.Optional("seed"): vol.Any(int, None),
    vol.Optional("nye", default=1): vol.All(vol.Coerce(int), vol.Range(min=0, max=2)),
    vol.Optional("rester", default=True): bool,
})
@websocket_api.async_response
async def ws_madplan_planlaeg(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Forslag til næste uges madplan (ugeplanlæggeren)."""
    try:
        m = _manager(hass)
    except ServiceValidationError as err:
        connection.send_error(msg["id"], "not_configured", str(err))
        return
    try:
        result = await m.async_planlaeg(
            start=msg.get("start"), dage=msg.get("dage"), tags=msg.get("tags"), laaste=msg.get("laaste"),
            seed=msg.get("seed"), nye=msg["nye"], rester=msg["rester"],
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Ugeplanlæggeren fejlede")
        connection.send_error(msg["id"], "planner_error", str(err))
        return
    connection.send_result(msg["id"], result)


@_ws({
    vol.Required("linjer"): [{vol.Required("dato"): cv.string, vol.Required("linje"): vol.All(str, vol.Length(max=300))}],
    vol.Optional("base_version"): vol.Any(int, None),
})
def ws_madplan__indsaet(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.indsaet_uge(msg["linjer"], msg.get("base_version"), user, kraev_version=True)


@_ws({})
def ws_madplan__kladde__hent(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict | None:
    return m.kladde_hent()


@_ws({vol.Required("kladde"): dict})
def ws_madplan__kladde__gem(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.kladde_gem(msg["kladde"], user)


@_ws({})
def ws_madplan__kladde__slet(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.kladde_slet()


@_ws({vol.Required("navn"): vol.All(str, vol.Length(min=1, max=120)), vol.Optional("skjul", default=True): bool})
def ws_madplan__skjul(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return {"skjulte": m.skjul_ret(msg["navn"], msg["skjul"], user)}


@_ws({vol.Required("varer"): [vol.All(str, vol.Length(max=120))]})
def ws_indkob__tilfoej(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    lines = m.add_items_auto(msg["varer"], user)
    return {"tilfoejet": [ln["text"] for ln in lines]}


@_ws({
    vol.Optional(CONF_PLAN_KALENDER): vol.All(str, vol.Length(max=255)),
    vol.Optional(CONF_FROST_DAY): vol.In([FROST_TODAY, FROST_TOMORROW]),
    vol.Optional(CONF_EXTRA_KOED): vol.All(str, vol.Length(max=1000)),
    vol.Optional(CONF_IGNORE_KOED): vol.All(str, vol.Length(max=1000)),
    vol.Optional(CONF_TRIP_THRESHOLD): vol.All(vol.Coerce(int), vol.Range(min=10, max=100)),
    vol.Optional(CONF_TRIP_DELAY): vol.All(vol.Coerce(float), vol.Range(min=0.5, max=24)),
})
def ws_settings__set(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.set_settings({k: v for k, v in msg.items() if k not in ("id", "type")}, user)


# ---------------------------------------------------------------- retter og opskrifter (0.11)
RET_ID = vol.All(str, vol.Length(min=3, max=200))
VARE = {
    vol.Required("navn"): vol.All(str, vol.Length(max=120)),
    vol.Optional("maengde"): vol.Any(None, vol.Coerce(float), vol.All(str, vol.Length(max=20))),
    vol.Optional("enhed"): vol.Any(None, vol.All(str, vol.Length(max=12))),
}


@_ws({})
def ws_retter__liste(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.retter_katalog()


@_ws({vol.Required("ret"): RET_ID})
def ws_retter__hent(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.ret_detalje(msg["ret"])


@_ws({
    vol.Optional("ret"): vol.Any(None, RET_ID),
    vol.Optional("navn"): vol.Any(None, vol.All(str, vol.Length(max=120))),
    vol.Optional("varer"): vol.Any(None, vol.All([VARE], vol.Length(max=80))),
    vol.Optional("opskrift"): vol.Any(None, RET_ID),
    vol.Optional("fryser"): vol.Any(None, vol.All([vol.All(str, vol.Length(max=60))], vol.Length(max=10))),
    vol.Optional("saeson"): vol.Any(None, vol.All([vol.In(["foraar", "sommer", "efteraar", "vinter"])], vol.Length(max=4))),
})
def ws_retter__gem(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    varer = msg["varer"] if "varer" in msg else False
    if varer:
        varer = [{"navn": v["navn"], "mængde": v.get("maengde"), "enhed": v.get("enhed")} for v in varer]
    return m.gem_ret(msg.get("ret"), user, navn=msg.get("navn"), varer=varer,
                     opskrift=msg["opskrift"] if "opskrift" in msg else False,
                     fryser=msg["fryser"] if "fryser" in msg else False,
                     saeson=msg["saeson"] if "saeson" in msg else False)


@_ws({vol.Required("ret"): RET_ID, vol.Optional("gange", default=1): vol.All(vol.Coerce(float), vol.Range(min=0.25, max=4))})
def ws_retter__paa_listen(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.ret_paa_listen(msg["ret"], msg["gange"], user)


@_ws({})
def ws_omregning__hent(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.omregning()


@_ws({vol.Optional("aendringer"): dict, vol.Optional("nulstil", default=False): bool})
def ws_omregning__saet(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.set_omregning(msg.get("aendringer"), user, nulstil=msg["nulstil"])


@_ws({vol.Required("tekst"): vol.All(str, vol.Length(min=10, max=5_000_000)), vol.Optional("erstat", default=True): bool})
def ws_opskrifter__importer(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.importer_opskrifter(msg["tekst"], user, erstat=msg["erstat"])


@_ws({
    vol.Optional("start"): vol.Any(cv.date, None),
    vol.Optional("dage"): vol.Any(vol.All(vol.Coerce(int), vol.Range(min=1, max=14)), None),
})
def ws_madplan__varer(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    """Varer til ugens retter (arket "Varer til ugen")."""
    return m.ugens_varer(msg.get("start"), msg.get("dage"))


@_ws({vol.Required("varer"): vol.All([{
    vol.Required("tekst"): vol.All(str, vol.Length(min=1, max=200)),
    vol.Optional("retter", default=list): [vol.All(str, vol.Length(max=120))],
}], vol.Length(max=120)),
    vol.Optional("madplan_version"): vol.Any(int, None),  # 0.13.0: arkets version – forældet = afvist
})
def ws_indkob__tilfoej_retter(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.tilfoej_til_retter(msg["varer"], user, madplan_version=msg.get("madplan_version"))


@_ws({vol.Required("navn"): vol.All(str, vol.Length(min=1, max=200))})
def ws_stats__slet_vare(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return {"slettet": m.slet_statistik_vare(msg["navn"], user)}


@_ws({vol.Required("bekraeft"): True})
def ws_stats__clear(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.clear_history(user)


# ---------------------------------------------------------------- køleskabet (0.12.5)
@_ws({
    vol.Required("navne"): vol.All([vol.All(str, vol.Length(min=1, max=200))], vol.Length(min=1, max=20)),
    vol.Optional("nok"): vol.Any(None, bool),  # None = Nok, medmindre varen står i basislisten
    vol.Optional("liste", default=True): bool,  # False = rør ikke indkøbslisten (fx Fortryd)
})
def ws_koleskab__tilfoej(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.koleskab_tilfoej(msg["navne"], user, nok=msg.get("nok"), liste=msg["liste"])


@_ws({vol.Required("rest_id"): str, vol.Required("nok"): bool})
def ws_koleskab__saet(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.koleskab_saet(msg["rest_id"], msg["nok"], user)


@_ws({vol.Required("rest_ids"): vol.All([str], vol.Length(min=1, max=50))})
def ws_koleskab__fjern(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.koleskab_fjern(msg["rest_ids"], user)


# 0.15.1: ugeplanlæggeren åbnes – rester fra forrige madplan tages ud af køleskabet
@_ws({})
def ws_koleskab__ny_planlaegning(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.koleskab_ny_planlaegning(user)


PAYMENTS = vol.All([{
    vol.Optional("butik", default=""): vol.All(str, vol.Length(max=60)),
    vol.Optional("beloeb", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=100000)),
}], vol.Length(max=10))


@_ws({vol.Required("butik"): vol.All(str, vol.Length(max=60)), vol.Optional("beloeb"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=100000)))})
def ws_indkob__butik_afslut(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.finish_store(msg["butik"], msg.get("beloeb"), user)


@_ws({vol.Required("stop_id"): str, vol.Required("butik"): vol.All(str, vol.Length(max=60)), vol.Optional("beloeb"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=100000)))})
def ws_indkob__butik_ret(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.edit_store(msg["stop_id"], msg["butik"], msg.get("beloeb"), user)


@_ws({vol.Required("stop_id"): str})
def ws_indkob__butik_fortryd(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.undo_store(msg["stop_id"], user)


@_ws({vol.Required("trip_id"): str, vol.Required("betalinger"): PAYMENTS})
def ws_trip__update(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.update_trip(msg["trip_id"], msg["betalinger"], user)


@_ws({vol.Required("dato"): cv.date, vol.Optional("betalinger", default=list): PAYMENTS})
def ws_trip__add(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.add_manual_trip(msg["dato"], msg["betalinger"], user)


@_ws({vol.Required("trip_id"): str})
def ws_trip__spring_pris(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.skip_price(msg["trip_id"], user)


@_ws({vol.Required("trip_id"): str})
def ws_trip__delete(m: IndkobMadplanManager, msg: dict, user: str | None) -> None:
    m.delete_trip(msg["trip_id"], user)


# 0.15.0: rækkefølge pr. butik
@_ws({
    vol.Required("butik"): vol.All(str, vol.Length(min=1, max=60)),
    vol.Required("orden"): vol.All([vol.All(str, vol.Length(min=1, max=80))], vol.Length(min=2, max=40)),
})
def ws_butik__orden__saet(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict:
    return m.saet_butik_orden(msg["butik"], msg["orden"], user)


@_ws({vol.Required("butik"): vol.All(str, vol.Length(min=1, max=60))})
def ws_butik__orden__nulstil(m: IndkobMadplanManager, msg: dict, user: str | None) -> dict | None:
    return m.nulstil_butik_orden(msg["butik"], user)


# Navnene på handlerne bestemmer websocket-typen: ws_indkob__add -> indkob_madplan/indkob/add
ws_add, ws_update, ws_delete, ws_move = ws_indkob__add, ws_indkob__update, ws_indkob__delete, ws_indkob__move
ws_clear_checked, ws_uncheck_all, ws_madplan_set = ws_indkob__clear_checked, ws_indkob__uncheck_all, ws_madplan__set
ws_madplan_retter, ws_indkob_kategori = ws_madplan__retter, ws_indkob__kategori
ws_madplan_indsaet, ws_madplan_skjul, ws_indkob_tilfoej = ws_madplan__indsaet, ws_madplan__skjul, ws_indkob__tilfoej
ws_settings_set, ws_stats_clear = ws_settings__set, ws_stats__clear
ws_trip_update, ws_trip_add, ws_trip_delete = ws_trip__update, ws_trip__add, ws_trip__delete


# ---------------------------------------------------------------- services
def _register_services(hass: HomeAssistant) -> None:
    async def _import(call: ServiceCall) -> None:
        m = _manager(hass)
        if call.data["note"] == NOTE_INDKOB:
            m.indkob.import_text(call.data["tekst"])
            m.history.snapshot = None  # import er ny grundlinje, ikke køb
            m.indkob_changed("Import")
        elif call.data["note"] == NOTE_BASIS:
            m.basis.import_text(call.data["tekst"])
            m.indkob_changed("Import", NOTE_BASIS)
        else:
            m.set_madplan(call.data["tekst"], user="Import")

    async def _export(call: ServiceCall) -> dict[str, Any]:
        m = _manager(hass)
        return {"indkobsliste": m.indkob.as_text(), "basisliste": m.basis.as_text(), "madplan": m.madplan_note.text}

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

    async def _finish(call: ServiceCall) -> dict[str, Any]:
        return {"fjernet": _manager(hass).finish_trip("Home Assistant")}

    async def _clear(call: ServiceCall) -> None:
        await _manager(hass).async_clear_history()

    hass.services.async_register(
        DOMAIN, "importer", _import,
        schema=vol.Schema({vol.Required("note"): vol.In([NOTE_INDKOB, NOTE_BASIS, NOTE_MADPLAN]), vol.Required("tekst"): cv.string}),
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
    hass.services.async_register(DOMAIN, "handlet_ind", _finish, supports_response=SupportsResponse.OPTIONAL)
    hass.services.async_register(
        DOMAIN, "nulstil_statistik", _clear,
        schema=vol.Schema({vol.Required("bekraeft"): vol.All(cv.boolean, vol.In([True]))}),
    )

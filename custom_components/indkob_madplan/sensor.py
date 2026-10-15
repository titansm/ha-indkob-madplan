"""Sensorer: aftensmad i dag/i morgen, madplan, indkøbsstatistik."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.util import dt as dt_util
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import IndkobConfigEntry
from .entity import IndkobEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IndkobConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    m = entry.runtime_data
    async_add_entities(
        [
            AftensmadSensor(m, "aftensmad_i_dag", 0),
            AftensmadSensor(m, "aftensmad_i_morgen", 1),
            MadplanSensor(m, "madplan"),
            KoebtDenneUgeSensor(m, "koebt_denne_uge"),
            ForslagSensor(m, "forslag"),
            SidsteIndkobSensor(m, "sidste_indkob"),
        ]
    )


def _trunc(value: str) -> str:
    return value if len(value) <= 250 else value[:247] + "…"


class AftensmadSensor(IndkobEntity, SensorEntity):
    _attr_icon = "mdi:silverware-fork-knife"

    def __init__(self, manager, key: str, offset: int) -> None:
        super().__init__(manager, key)
        self._offset = offset

    @property
    def native_value(self) -> str | None:
        dag = self.manager.dag(self._offset)
        if not dag:
            return "Ikke planlagt"
        return _trunc(dag["ret"] or dag["raw"] or "Ikke planlagt")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        dag = self.manager.dag(self._offset) or {}
        return {
            "dato": dag.get("dato"),
            "ugedag": dag.get("ugedag"),
            "noter": dag.get("noter", []),
            "stor_portion": dag.get("stor_portion", False),
            "kraever_optoening": dag.get("kraever_optoening", False),
            "koed": dag.get("koed", []),
            "raw": dag.get("raw"),
        }


class MadplanSensor(IndkobEntity, SensorEntity):
    _attr_icon = "mdi:calendar-week"
    _attr_native_unit_of_measurement = "dage"

    @property
    def native_value(self) -> int:
        return sum(1 for d in self.manager.uge(0, 7) if d["ret"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "opdateret": self.manager.madplan_note.updated,
            "opdateret_af": self.manager.madplan_note.updated_by,
            "dage": [
                {k: d[k] for k in ("dato", "ugedag", "ret", "noter", "kraever_optoening")}
                for d in self.manager.uge(0, 7)
            ],
        }


class KoebtDenneUgeSensor(IndkobEntity, SensorEntity):
    _attr_icon = "mdi:cart-check"
    _attr_native_unit_of_measurement = "varer"
    _attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> int:
        return len(self.manager.stats.get("koebt_denne_uge", []))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        s = self.manager.stats
        return {
            "varer": s.get("koebt_denne_uge", []),
            "sidste_uge": s.get("koebt_sidste_uge", []),
            "top_10": [
                {"navn": t["navn"], "antal": t["antal"], "interval_dage": t["interval_dage"]}
                for t in s.get("top", [])[:10]
            ],
            "koeb_i_alt": s.get("antal_koeb_i_alt", 0),
            "sporet_siden": s.get("sporet_siden"),
        }


class ForslagSensor(IndkobEntity, SensorEntity):
    _attr_icon = "mdi:lightbulb-on-outline"
    _attr_native_unit_of_measurement = "varer"

    @property
    def native_value(self) -> int:
        return len(self.manager.stats.get("forslag", []))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "varer": [
                {"navn": f["navn"], "dage_siden": f["dage_siden"], "interval_dage": f["interval_dage"]}
                for f in self.manager.stats.get("forslag", [])
            ]
        }


class SidsteIndkobSensor(IndkobEntity, SensorEntity):
    _attr_icon = "mdi:cart-arrow-right"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    @property
    def native_value(self):
        t = self.manager.stats.get("seneste_tur")
        return dt_util.parse_datetime(t) if t else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        s = self.manager.stats
        ture = s.get("ture", [])
        tur = self.manager.trip
        return {
            "varer": ture[0]["varer"] if ture else [],
            "antal": ture[0]["antal"] if ture else 0,
            "ture_i_alt": s.get("antal_ture", 0),
            "varer_pr_tur": s.get("varer_pr_tur"),
            "dage_mellem_ture": s.get("dage_mellem_ture"),
            "handler_nu": tur is not None,
            "flueben_fjernes": due.isoformat() if (due := self.manager.trip_due()) else None,
        }

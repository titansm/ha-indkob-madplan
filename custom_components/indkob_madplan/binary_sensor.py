"""Binær sensor: skal der kød op af fryseren?"""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import IndkobConfigEntry
from .entity import IndkobEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IndkobConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([OptoeningSensor(entry.runtime_data, "tag_koed_op")])


class OptoeningSensor(IndkobEntity, BinarySensorEntity):
    _attr_icon = "mdi:snowflake-melt"

    @property
    def is_on(self) -> bool:
        dag = self.manager.frost_dag()
        return bool(dag and dag.get("kraever_optoening"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        dag = self.manager.frost_dag() or {}
        return {
            "gaelder": "i morgen" if self.manager.frost_tomorrow else "i dag",
            "dato": dag.get("dato"),
            "ret": dag.get("ret"),
            "koed": dag.get("koed", []),
        }

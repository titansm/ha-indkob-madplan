"""Opsætning via UI."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_EXTRA_KOED,
    CONF_FROST_DAY,
    CONF_IGNORE_KOED,
    CONF_TRIP_DELAY,
    CONF_TRIP_THRESHOLD,
    DEFAULT_TRIP_DELAY,
    DEFAULT_TRIP_THRESHOLD,
    DOMAIN,
    FROST_TODAY,
    FROST_TOMORROW,
)


def _schema(defaults: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_FROST_DAY, default=defaults.get(CONF_FROST_DAY, FROST_TODAY)
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=[FROST_TODAY, FROST_TOMORROW],
                    translation_key="frost_day",
                    mode=selector.SelectSelectorMode.LIST,
                )
            ),
            vol.Optional(
                CONF_EXTRA_KOED, default=defaults.get(CONF_EXTRA_KOED, "")
            ): selector.TextSelector(),
            vol.Optional(
                CONF_IGNORE_KOED, default=defaults.get(CONF_IGNORE_KOED, "")
            ): selector.TextSelector(),
            vol.Required(
                CONF_TRIP_THRESHOLD, default=defaults.get(CONF_TRIP_THRESHOLD, DEFAULT_TRIP_THRESHOLD)
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=10, max=100, step=5, unit_of_measurement="%", mode=selector.NumberSelectorMode.SLIDER)
            ),
            vol.Required(
                CONF_TRIP_DELAY, default=defaults.get(CONF_TRIP_DELAY, DEFAULT_TRIP_DELAY)
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0.5, max=24, step=0.5, unit_of_measurement="timer", mode=selector.NumberSelectorMode.BOX)
            ),
        }
    )


class IndkobMadplanConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="Indkøb & Madplan", data=user_input)
        return self.async_show_form(step_id="user", data_schema=_schema({}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return IndkobMadplanOptionsFlow()


class IndkobMadplanOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(step_id="init", data_schema=_schema(current))

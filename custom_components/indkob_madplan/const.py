"""Konstanter for Indkøb & Madplan."""

DOMAIN = "indkob_madplan"
VERSION = "0.2.0"

CONF_FROST_DAY = "frost_day"
CONF_EXTRA_KOED = "extra_koed_ord"
CONF_IGNORE_KOED = "ignorer_ord"

FROST_TODAY = "i_dag"
FROST_TOMORROW = "i_morgen"

NOTE_INDKOB = "indkob"
NOTE_MADPLAN = "madplan"

SIGNAL_UPDATE = f"{DOMAIN}_update"
STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

URL_BASE = f"/{DOMAIN}_static"
CARD_FILE = "indkob-madplan-card.js"
PANEL_FILE = "indkob-madplan-panel.js"
PANEL_URL_PATH = "indkob-madplan"
PANEL_ELEMENT = "indkob-madplan-panel"
PANEL_TITLE = "Indkøb & Madplan"
PANEL_ICON = "mdi:notebook-outline"

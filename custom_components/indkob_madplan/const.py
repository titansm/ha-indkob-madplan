"""Konstanter for Indkøb & Madplan."""

DOMAIN = "indkob_madplan"
VERSION = "0.9.1"

CONF_FROST_DAY = "frost_day"
CONF_EXTRA_KOED = "extra_koed_ord"
CONF_IGNORE_KOED = "ignorer_ord"
CONF_TRIP_THRESHOLD = "handlet_taerskel"  # % afkrydset før det regnes som handlet ind
CONF_PLAN_KALENDER = "madplan_kalender"  # kalender til ugeplanlæggeren
CONF_TRIP_DELAY = "handlet_timer"  # timer efter sidste flueben før fluebenene fjernes
DEFAULT_TRIP_THRESHOLD = 50
DEFAULT_TRIP_DELAY = 3.0

FROST_TODAY = "i_dag"
FROST_TOMORROW = "i_morgen"

NOTE_INDKOB = "indkob"
NOTE_MADPLAN = "madplan"
NOTE_BASIS = "basis"  # basislisten: faste varer, som indkøbslisten nulstilles til

SIGNAL_UPDATE = f"{DOMAIN}_update"
EVENT_HANDLET_IND = f"{DOMAIN}_handlet_ind"
EVENT_BUTIK_AFSLUTTET = f"{DOMAIN}_butik_afsluttet"
STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

URL_BASE = f"/{DOMAIN}_static"
CARD_FILE = "indkob-madplan-card.js"
PANEL_FILE = "indkob-madplan-panel.js"
PANEL_URL_PATH = "indkob-madplan"
PANEL_ELEMENT = "indkob-madplan-panel"
PANEL_TITLE = "Indkøb & Madplan"
PANEL_ICON = "mdi:notebook-outline"

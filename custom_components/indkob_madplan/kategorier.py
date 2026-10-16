"""Faste kategorier på indkøbslisten og gæt af kategori for nye varer.

Kategorierne følger butikken (gangene i et dansk supermarked) i den rækkefølge,
listen står i. Overskrifterne på listen er almindelige linjer – her findes kun
"hvilken fast kategori er denne overskrift" og "hvor hører varen hjemme".

Ren Python uden Home Assistant-afhængigheder.
"""

from __future__ import annotations

import difflib
import re

from .stats import normalize

# (nøgle, overskrift) i butikkens rækkefølge – de 9 første er listens oprindelige
FASTE: list[tuple[str, str]] = [
    ("frugt", "🍎 FRUGT & GRØNT"),
    ("kod", "🥩 KØL – KØD"),
    ("mejeri", "🥛 KØL – MEJERI"),
    ("paalaeg", "🥓 KØL – PÅLÆG / DELI"),
    ("frost", "🧊 FROST"),
    ("brod", "🍞 BRØD"),
    ("torvarer", "🥫 TØRVARER"),
    ("drikke", "🥤 DRIKKEVARER"),
    ("slik", "🍫 SLIK & SNACKS"),
    ("husholdning", "🧽 HUSHOLDNING"),
    ("baby", "👶 BABY / PLEJE"),
    ("ugevarer", "🛒 UGEVARER"),
]
ORDEN = {k: i for i, (k, _) in enumerate(FASTE)}
NAVN = dict(FASTE)
FALLBACK = "ugevarer"  # ukendte varer lander her (som før)

# Overskrift -> nøgle ud fra ord i overskriften (rækkefølgen betyder noget)
_HEADER_ORD: list[tuple[str, tuple[str, ...]]] = [
    ("paalaeg", ("pålæg", "deli")),
    ("mejeri", ("mejeri", "ost & æg", "æg")),
    ("frost", ("frost", "frys")),
    ("frugt", ("frugt", "grønt")),
    ("brod", ("brød", "bager")),
    ("torvarer", ("tørvar", "kolonial")),
    ("drikke", ("drikke",)),
    ("slik", ("slik", "snack")),
    ("husholdning", ("husholdning", "rengøring", "non-food", "non food")),
    ("baby", ("baby", "pleje")),
    ("ugevarer", ("ugevar",)),
    ("kod", ("kød", "fisk")),
]


def _sig(text: str) -> str:
    return "".join(c for c in (text or "").lower() if c.isalpha())


_SIG = {_sig(navn): k for k, navn in FASTE}


def header_noegle(text: str) -> str | None:
    """Hvilken fast kategori en overskrift er (eller None for egne overskrifter)."""
    sig = _sig(text)
    if not sig:
        return None
    if sig in _SIG:
        return _SIG[sig]
    low = (text or "").lower()
    for noegle, ord_ in _HEADER_ORD:
        if any(o in low for o in ord_):
            return noegle
    return None


# ------------------------------------------------------------------ ordliste
_ORD: dict[str, tuple[str, ...]] = {
    "frugt": (
        "frugt", "grønt", "grøntsag", "grøntsager", "æble", "æbler", "pære", "pærer", "banan", "bananer",
        "appelsin", "clementin", "mandarin", "citron", "lime", "grape", "grapefrugt", "kiwi", "melon",
        "vandmelon", "nektarin", "fersken", "blomme", "abrikos", "drue", "druer", "jordbær", "hindbær",
        "blåbær", "brombær", "solbær", "kirsebær", "stikkelsbær", "ananas", "mango", "avocado", "avokado",
        "granatæble", "passionsfrugt", "figen", "agurk", "tomat", "cherrytomat", "snacktomat", "salat",
        "icebergsalat", "hjertesalat", "romaine", "salatmix", "rucola", "spinat", "babyspinat", "gulerod",
        "gulerødder", "kartoffel", "kartofler", "sødkartoffel", "søde kartofler", "nye kartofler", "løg",
        "rødløg", "forårsløg", "skalotteløg", "perleløg", "porre", "porrer", "hvidløg", "ingefær", "chili",
        "chilier", "peberfrugt", "spidspeber", "squash", "courgette", "aubergine", "broccoli", "broccolini",
        "blomkål", "kål", "hvidkål", "rødkål", "spidskål", "grønkål", "rosenkål", "kålrabi", "selleri",
        "bladselleri", "knoldselleri", "pastinak", "persillerod", "rødbede", "radise", "radiser",
        "majskolbe", "champignon", "champignoner", "svampe", "svamp", "østershat", "kantarel", "asparges",
        "artiskok", "fennikel", "græskar", "hokkaido", "butternut", "sukkerært", "sukkerærter",
        "sugarsnaps", "bønnespirer", "grønne bønner", "haricots verts", "edamame", "basilikum", "persille",
        "dild", "purløg", "koriander", "mynte", "timian", "rosmarin", "estragon", "salvie", "citrongræs",
        "krydderurt", "krydderurter", "karse", "babyleaf", "spinatsalat", "pak choi", "bok choy",
    ),
    "kod": (
        "kød", "hakkekød", "oksekød", "svinekød", "kalvekød", "lammekød", "kyllingekød", "hakket oksekød",
        "hakket svinekød", "hakket kylling", "hakket kalv", "kylling", "kyllinger", "hel kylling",
        "kyllingebryst", "kyllingelår", "kyllingeinderfilet", "inderfilet", "kyllingefilet", "bryst",
        "lår", "overlår", "underlår", "vinger", "kyllingevinger", "kalkun", "and", "andebryst", "mørbrad",
        "nakkefilet", "nakke", "kotelet", "koteletter", "schnitzel", "wienerschnitzel", "karbonade",
        "karbonader", "frikadelle", "frikadeller", "kylledeller", "kyllingedeller", "fars", "farsbrød",
        "flæsk", "flæskesteg", "ribbensteg", "ribben", "bacon", "baconstrimler", "baconterninger", "pølse",
        "pølser", "cocktailpølser", "grillpølser", "hotdogpølser", "wienerpølser", "chorizo", "medister",
        "bøf", "bøffer", "hakkebøf", "hakkebøffer", "entrecote", "culotte", "steak", "tyksteg", "oksefilet",
        "oksetern", "oksestrimler", "tern", "strimler", "bov", "gullasch", "spareribs", "lammekølle",
        "kølle", "kødboller", "kyllingeboller", "kødsovs", "fisk", "fiskefilet", "laks", "laksefilet",
        "torsk", "rødspætte", "sej", "kuller", "rejer", "fiskefrikadeller", "fiskefrikadelle", "muslinger",
        "kammuslinger", "scampi", "tigerrejer", "millionbøf", "pulled pork", "svinemørbrad",
    ),
    "mejeri": (
        "mælk", "letmælk", "sødmælk", "minimælk", "skummetmælk", "kærnemælk", "kakaomælk", "havremælk",
        "sojamælk", "mandelmælk", "fløde", "piskefløde", "madlavningsfløde", "kaffefløde", "creme fraiche",
        "cremefraiche", "crème fraîche", "smør", "smørbar", "kærgården", "lurpak", "margarine", "yoghurt",
        "græsk yoghurt", "skyr", "ymer", "a38", "kvark", "hytteost", "ost", "skiveost", "revet ost",
        "mozzarella", "parmesan", "parmigiano", "pecorino", "cheddar", "feta", "brie", "camembert", "flødeost",
        "philadelphia", "mascarpone", "ricotta", "halloumi", "pikantost", "smøreost", "æg", "gær", "pizzadej",
        "butterdej", "dej", "tærtedej", "tzatziki", "rygeost", "danbo", "havarti", "gouda", "blåskimmelost",
    ),
    "paalaeg": (
        "pålæg", "skinke", "kogt skinke", "hamburgerryg", "spegepølse", "salami", "rullepølse", "leverpostej",
        "postej", "kyllingepålæg", "kalkunpålæg", "roastbeef", "pepperoni", "serrano", "serranoskinke",
        "parmaskinke", "prosciutto", "hummus", "rejesalat", "hønsesalat", "italiensk salat", "æggesalat",
        "sild", "marinerede sild", "karrysild", "pålægssalat", "frikadellepålæg", "oliven", "tapenade",
        "røget laks", "rullepølse", "sylte", "pateen", "paté",
    ),
    "frost": (
        "frost", "frostvarer", "is", "flødeis", "ispinde", "ispind", "isvafler", "sandwichis", "isterninger",
        "pommes frites", "pommes", "fritter", "kartoffelbåde", "ærter", "frosne ærter", "fiskepinde",
        "frossen pizza", "nuggets", "kyllingenuggets", "frostbær", "frosne bær", "frugtmix", "smoothiemix",
        "grøntsagsblanding", "wokgrønt", "spinat frost", "boller frost",
    ),
    "brod": (
        "brød", "rugbrød", "toastbrød", "franskbrød", "boller", "bolle", "burgerboller", "burgerbrød",
        "pølsebrød", "pitabrød", "pita", "pitaer", "wraps", "wrap", "tortilla", "tortillas", "tortillabrød",
        "knækbrød", "rundstykker", "rundstykke", "baguette", "flute", "croissant", "croissanter", "kage",
        "wienerbrød", "kanelsnegl", "kanelsnegle", "kanelstang", "kringle", "tebirkes", "naan", "naanbrød",
        "ciabatta", "sandwichbrød", "bagels", "bagel", "fuldkornsbrød", "speltbrød", "surdejsbrød",
        "grovboller", "flutes",
    ),
    "torvarer": (
        "pasta", "spaghetti", "penne", "fusilli", "makaroni", "lasagneplader", "tagliatelle", "orzo",
        "tortellini", "gnocchi", "ris", "jasminris", "basmatiris", "risottoris", "grødris", "nudler",
        "ægnudler", "risnudler", "couscous", "bulgur", "quinoa", "mel", "hvedemel", "rugmel", "sukker",
        "rørsukker", "flormelis", "havregryn", "müsli", "musli", "granola", "cornflakes", "morgenmad",
        "morgenmadsprodukt", "hakkede tomater", "flåede tomater", "tomatpuré", "passata", "ketchup",
        "sennep", "mayonnaise", "mayo", "remoulade", "dressing", "burgerdressing", "olie", "olivenolie",
        "rapsolie", "solsikkeolie", "eddike", "balsamico", "soja", "sojasauce", "fiskesauce", "østerssauce",
        "bouillon", "bouillonterninger", "fond", "krydderi", "krydderier", "salt", "peber", "paprika",
        "røget paprika", "karry", "karrypasta", "spidskommen", "kanel", "oregano", "laurbærblade",
        "muskatnød", "kardemomme", "chiliflager", "honning", "syltetøj", "marmelade", "nutella",
        "peanutbutter", "jordnøddesmør", "mandler", "rosiner", "dåse", "kidneybønner", "hvide bønner",
        "sorte bønner", "kikærter", "linser", "røde linser", "kokosmælk", "tun", "makrel", "majs", "pesto",
        "tacoskaller", "tacokrydderi", "salsa", "bagepulver", "natron", "vaniljesukker", "tørgær",
        "kakao", "rasp", "panko", "chili crisp", "sriracha", "sweet chili", "chilisauce", "sauce",
        "tomatsauce", "pastasauce", "suppe", "konserves", "pålægschokolade", "risengrød", "grød",
        "chokoladeknapper", "bagechokolade", "kokosmel", "sesamfrø", "frø", "kerner",
    ),
    "drikke": (
        "vand", "danskvand", "kildevand", "sodavand", "cola", "juice", "appelsinjuice", "æblejuice",
        "saft", "øl", "vin", "rødvin", "hvidvin", "rosé", "bobler", "cava", "prosecco", "kaffe",
        "kaffebønner", "te", "energidrik", "smoothie", "iste", "lemonade", "cider", "sportsdrik",
    ),
    "slik": (
        "slik", "chips", "popcorn", "nødder", "peanuts", "cashewnødder", "chokolade", "vingummi", "lakrids",
        "kiks", "småkager", "snacks", "saltstænger", "marabou", "haribo", "karameller", "riskiks",
        "majschips", "tortillachips", "flæskesvær", "skumfiduser", "slikkepinde", "tyggegummi",
        "chokoladebar", "müslibar", "proteinbar", "dip", "dipmix",
    ),
    "husholdning": (
        "køkkenrulle", "køkkenruller", "toiletpapir", "opvasketabs", "opvaskemiddel", "opvaskebørste",
        "vaskemiddel", "vaskepulver", "skyllemiddel", "rengøringsmiddel", "rengøring", "karklud", "karklude",
        "grydesvamp", "skuresvamp", "skraldeposer", "affaldsposer", "fryseposer", "poser", "plastfilm",
        "husholdningsfilm", "alufolie", "sølvpapir", "bagepapir", "stearinlys", "fyrfadslys", "batterier",
        "servietter", "kaffefiltre", "wc-rens", "toiletrens", "klor", "afkalker", "tændstikker", "pærer",
        "elpærer", "affaldssække", "madpapir", "muffinforme", "klude", "gulvvask", "glasrens",
    ),
    "baby": (
        "bleer", "ble", "natbleer", "vådservietter", "wipes", "babymad", "babygrød", "modermælkserstatning",
        "sutter", "sut", "tandpasta", "tandbørste", "tandbørster", "shampoo", "balsam", "sæbe", "håndsæbe",
        "flydende sæbe", "deodorant", "deo", "bind", "tamponer", "plaster", "creme", "solcreme", "bodylotion",
        "barberblade", "vatpinde", "vatrondeller", "hudcreme", "zinksalve", "panodil", "pamol", "ibuprofen",
        "babyolie", "klapvogn", "smækker", "babysæbe", "badeskum", "læbepomade", "hårelastikker",
    ),
}

# Ord der flytter varen til frost, uanset resten ("frosne ærter", "frossen spinat")
_FROST_MOD = {"frost", "frosne", "frossen", "frossent", "frosset", "frostvarer", "dybfrost", "dybfrossen"}
# Ord der er kolonial-modifikatorer ("tørret timian", "dåse majs")
_TOR_MOD = {"tørret", "tørrede", "dåse", "dåser", "glas"}

ORD: dict[str, str] = {}
for _k, _ws in _ORD.items():
    for _w in _ws:
        ORD.setdefault(_w, _k)
_FRASER = sorted((w for w in ORD if " " in w), key=len, reverse=True)
_ENKELT = {w: k for w, k in ORD.items() if " " not in w}
_SUFFIKS = sorted((w for w in _ENKELT if len(w) >= 3), key=len, reverse=True)
_FUZZY = [w for w in _ENKELT if len(w) >= 5]
_ENDELSER = ("erne", "ene", "er", "e", "r", "en", "et", "n")
_FORHOLD = {"i", "med", "m", "til", "fra", "uden", "på", "af"}
_TOKEN_RE = re.compile(r"[a-zæøåéèàüö]+")


def stamme(key: str) -> str:
    """Grov stamme pr. ord, så "bananer" og "banan" matcher."""
    out = []
    for t in key.split():
        for e in ("erne", "ene", "er", "e", "r"):
            if len(t) - len(e) >= 3 and t.endswith(e):
                t = t[: -len(e)]
                break
        out.append(t)
    return " ".join(out)


def _opslag(tok: str) -> str | None:
    if tok in _ENKELT:
        return _ENKELT[tok]
    for e in _ENDELSER:
        if len(tok) - len(e) >= 2 and tok.endswith(e):
            base = tok[: -len(e)]
            if base in _ENKELT:
                return _ENKELT[base]
            if base + "e" in _ENKELT:
                return _ENKELT[base + "e"]
    return None


def _sammensat(tok: str) -> str | None:
    """Sammensatte ord: hovedordet står sidst ("toastbrød", "kyllingebryst")."""
    for w in _SUFFIKS:
        if len(w) >= 4 and len(tok) - len(w) >= 2 and tok.endswith(w):
            return _ENKELT[w]
    if tok.endswith("is") and not tok.endswith(("ris", "pris", "kris")):
        return "frost"  # vaniljeis, chokoladeis
    for w in _SUFFIKS:
        if len(w) >= 4 and len(tok) - len(w) >= 3 and tok.startswith(w):
            return _ENKELT[w]
    return None


def gaet(text: str) -> str | None:
    """Gæt fast kategori (nøgle) for en ny vare – None hvis intet passer."""
    key = normalize(text)
    if not key:
        return None
    tokens = _TOKEN_RE.findall(key)
    if not tokens:
        return None
    if any(t in _FROST_MOD for t in tokens):
        return "frost"
    if key in ORD:
        return ORD[key]
    for fr in _FRASER:
        if re.search(rf"(?<![a-zæøå]){re.escape(fr)}(?![a-zæøå])", key):
            return ORD[fr]
    if any(t in _TOR_MOD for t in tokens):
        return "torvarer"
    # "tun i vand", "kylling med skind": hovedordet står før forholdsordet
    for i, t in enumerate(tokens):
        if i and t in _FORHOLD:
            tokens = tokens[:i]
            break
    # Hovedordet står typisk sidst – mærkenavne til sidst springes over
    for t in reversed(tokens):
        if (k := _opslag(t)):
            return k
    for t in reversed(tokens):
        if len(t) >= 6 and (k := _sammensat(t)):
            return k
    for t in reversed(tokens):
        if len(t) >= 5:
            m = difflib.get_close_matches(t, _FUZZY, n=1, cutoff=0.86)
            if m:
                return _ENKELT[m[0]]
    return None

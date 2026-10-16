"""Ugeplanlæggeren: foreslår næste uges madplan ud fra familiens egne uger.

Idéen i korte træk
------------------
1. Historikken læses (alle tidligere uger i madplan-noten). Hver dag genkendes som
   en kendt ret ("bolo", "bolognese fra fryser" og "kødsovs" er samme ret),
   som rester, eller som en begivenhed ("Tivoli", "fødselsdag") der ikke er mad.
2. For hver ret beregnes
   - *smag*: hvor ofte I spiser den, vægtet så nylige uger tæller mest,
   - *rytme*: hvor mange aftener der normalt går mellem gangene, og hvor længe
     det er siden sidst. En ret I fik i forgårs er "ikke igen endnu"; en ret I
     plejer at få hver 12. aften og ikke har haft i 20 aftener er "moden".
   - *ugedagsvaner*: retter/familier der klumper sig på bestemte dage (burger om
     fredagen, lasagne om søndagen),
   - *travle aftener*: hvilke retter I faktisk laver, når "tit nat", "alene" eller
     "fodbold" står i noterne – kombineret med en indbygget vurdering af, hvor
     nemme retterne er.
3. Ugen bygges dag for dag med variation (ikke samme kød/tilbehør to dage i træk,
   højst to pastaretter, ingen dubletter), rester planlægges efter en stor
   portion når en travl aften følger, og der vælges lidt tilfældigt blandt de
   bedste bud – så forslaget ikke bliver "de samme fem retter" hver uge.
4. Valgfrit: én ny ret, der ligner noget I allerede elsker.

Ren Python uden Home Assistant-afhængigheder, så den kan testes isoleret.
"""

from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from statistics import median

from .madplan import DEFAULT_REST_ORD, UGEDAGE, Dag, dish_key

# --------------------------------------------------------------------------- viden om retter
# effort: 1 = nem/hurtig hverdag, 2 = almindelig, 3 = lang tid (weekend)
# stor: egner sig til dobbelt portion og rester dagen efter
# base: tilbehør/type – bruges til variation (ikke pasta tre dage i træk)


def _r(fam, protein, base, effort, stor=False, varer=(), kids=1):
    return {"fam": fam, "protein": protein, "base": base, "effort": effort, "stor": stor,
            "varer": list(varer), "kids": kids}


RETTER: dict[str, dict] = {
    "Cornflakes kyllingeburger": _r("burger", "kylling", "brød", 2, False,
                                    ["Burgerboller", "Kyllingebryst", "Cornflakes", "Æg", "Salat", "Agurk"], 2),
    "Burger": _r("burger", "okse", "brød", 1, False, ["Burgerboller", "Hakket oksekød", "Salat", "Tomater", "Ost"], 2),
    "Sunde burgere": _r("burger", "okse", "brød", 2, False, ["Grove burgerboller", "Hakket oksekød", "Salat", "Avocado", "Rødløg"]),
    "Pulled pork burger": _r("burger", "svin", "brød", 3, True, ["Svinenakke", "BBQ-sauce", "Burgerboller", "Spidskål"], 2),
    "Pita": _r("pita", "kylling", "brød", 1, False, ["Pitabrød", "Kyllingekød eller hakket kød", "Agurk", "Tomater", "Salat", "Dressing"], 2),
    "Wraps": _r("mexi", "kylling", "brød", 1, False, ["Tortillas", "Kylling", "Salat", "Majs", "Creme fraiche", "Revet ost"], 2),
    "Mexi bowl": _r("mexi", "okse", "ris", 2, False, ["Ris", "Hakket oksekød", "Tacokrydderi", "Majs", "Bønner", "Avocado"]),
    "Tortillacups med kylling": _r("mexi", "kylling", "brød", 2, False, ["Små tortillas", "Kylling", "Revet ost", "Majs"], 2),
    "Tacotærte": _r("mexi", "okse", "andet", 2, True, ["Tærtedej", "Hakket oksekød", "Tacokrydderi", "Revet ost"]),
    "Kylling i karry": _r("karry", "kylling", "ris", 2, True, ["Kyllingebryst", "Karry", "Kokosmælk", "Løg", "Ris"], 2),
    "Kyllingeboller i karrysauce": _r("karry", "kylling", "ris", 2, True, ["Hakket kylling", "Karry", "Fløde", "Ris"], 2),
    "Nasi goreng": _r("asiat", "kylling", "ris", 2, False, ["Ris", "Kylling", "Æg", "Ærter", "Soja"], 2),
    "Kylling satay med ris": _r("asiat", "kylling", "ris", 2, False, ["Kyllingebryst", "Peanutbutter", "Kokosmælk", "Ris"]),
    "Kylling med nudler": _r("wok", "kylling", "nudler", 1, False, ["Nudler", "Kyllingebryst", "Wokgrøntsager", "Soja"], 2),
    "Wok med oksestrimler": _r("wok", "okse", "nudler", 1, False, ["Oksestrimler", "Nudler", "Wokgrøntsager", "Soja"]),
    "Thai svin stir fry": _r("wok", "svin", "ris", 1, False, ["Svinekød i strimler", "Ris", "Wokgrøntsager"]),
    "Miso nudler med gris": _r("wok", "svin", "nudler", 2, False, ["Nudler", "Misopasta", "Hakket svinekød"]),
    "Poke bowl": _r("bowl", "kylling", "ris", 2, False, ["Sushiris", "Kylling", "Agurk", "Edamame", "Sesam"]),
    "Spaghetti bolognese": _r("bolo", "okse", "pasta", 2, True,
                              ["Spaghetti", "Hakket oksekød", "Hakkede tomater", "Løg", "Gulerødder", "Parmesan"], 2),
    "Lasagne": _r("lasagne", "okse", "pasta", 3, True,
                  ["Lasagneplader", "Hakket oksekød", "Hakkede tomater", "Mælk", "Mel", "Revet ost"], 2),
    "Kyllingelasagne": _r("lasagne", "kylling", "pasta", 3, True, ["Lasagneplader", "Hakket kylling", "Hakkede tomater", "Revet ost"], 2),
    "Åben lasagne": _r("lasagne", "okse", "pasta", 2, False, ["Lasagneplader", "Hakket oksekød", "Hakkede tomater"], 2),
    "Kødboller i tomatsauce": _r("kodboller", "okse", "pasta", 2, True, ["Hakket kød", "Spaghetti", "Hakkede tomater", "Parmesan"], 2),
    "Marry me pasta med kødboller": _r("kodboller", "okse", "pasta", 2, False, ["Hakket kød", "Pasta", "Fløde", "Soltørrede tomater", "Parmesan"], 2),
    "Nduja pasta": _r("pasta", "svin", "pasta", 1, False, ["Pasta", "Nduja", "Hakkede tomater", "Parmesan"]),
    "Gratineret tortellini med kylling": _r("pasta", "kylling", "pasta", 2, False, ["Tortellini", "Hakket kylling", "Revet ost"], 2),
    "Frikadeller": _r("frikadeller", "svin", "kartofler", 2, True, ["Hakket svinekød", "Æg", "Løg", "Kartofler"], 2),
    "Kyllingefrikadeller": _r("frikadeller", "kylling", "andet", 2, True, ["Hakket kylling", "Æg", "Løg"], 2),
    "Fiskefrikadeller": _r("fisk", "fisk", "kartofler", 1, False, ["Fiskefrikadeller", "Kartofler", "Remoulade", "Rugbrød"]),
    "Karbonader med sovs og kartofler": _r("karbonader", "svin", "kartofler", 2, False, ["Karbonader", "Kartofler", "Ærter", "Sovs"], 2),
    "Millionbøf med kartoffelmos": _r("millionbof", "okse", "kartofler", 2, True, ["Hakket oksekød", "Kartofler", "Mælk", "Smør"], 2),
    "Græsk farsbrød med kartofler": _r("farsbrod", "okse", "kartofler", 2, True, ["Hakket oksekød", "Feta", "Kartofler", "Tzatziki"]),
    "Hakkebøf med bløde løg": _r("hakkebof", "okse", "kartofler", 2, False, ["Hakket oksekød", "Løg", "Kartofler", "Æg"]),
    "Wienerschnitzel": _r("schnitzel", "svin", "kartofler", 2, False, ["Schnitzler", "Rasp", "Æg", "Kartofler", "Citron"], 2),
    "Kyllingeschnitzel med ovnkartofler": _r("schnitzel", "kylling", "kartofler", 2, False, ["Kyllingebryst", "Rasp", "Kartofler", "Salat"], 2),
    "Bøffer på grill": _r("bof", "okse", "pasta", 1, False, ["Bøffer", "Pasta til børnene", "Salat"]),
    "Fyldt kyllingebryst med pikantost": _r("fyldtkylling", "kylling", "ris", 2, False, ["Kyllingebryst", "Pikantost", "Ris eller pasta", "Tomatsauce"]),
    "Kartoffelfad med oksekød og feta": _r("kartoffelfad", "okse", "kartofler", 2, True, ["Kartofler", "Hakket oksekød", "Feta", "Fløde"]),
    "Chili con carne": _r("chili", "okse", "ris", 2, True, ["Hakket oksekød", "Kidneybønner", "Hakkede tomater", "Ris", "Creme fraiche"]),
    "Moussaka": _r("moussaka", "okse", "andet", 3, True, ["Hakket kød", "Aubergine", "Kartofler", "Hakkede tomater", "Mælk"]),
    "Fyldte peberfrugter med ris": _r("peberfrugt", "okse", "ris", 2, True, ["Peberfrugter", "Hakket kød", "Ris", "Revet ost"]),
    "Hokkaidosuppe": _r("suppe", "vegetar", "suppe", 2, True, ["Hokkaido", "Løg", "Bouillon", "Brød"]),
    "Kyllingesuppe": _r("suppe", "kylling", "suppe", 2, True, ["Kylling", "Gulerødder", "Pasta", "Bouillon"], 2),
    "Suppe": _r("suppe", "vegetar", "suppe", 2, True, ["Grøntsager", "Bouillon", "Brød"]),
    "Tærte med skinke og ost": _r("taerte", "svin", "andet", 2, True, ["Tærtedej", "Skinke", "Ost", "Æg", "Mælk"], 2),
    "Tærte med oksekød": _r("taerte", "okse", "andet", 2, True, ["Tærtedej", "Hakket oksekød", "Æg", "Ost"]),
    "Laks": _r("fisk", "fisk", "kartofler", 1, False, ["Laks", "Kartofler eller ris", "Grønt"]),
    "Fisk": _r("fisk", "fisk", "kartofler", 1, False, ["Fisk", "Kartofler", "Remoulade"]),
    "Svensk pølseret": _r("polser", "svin", "ris", 1, False, ["Pølser", "Ris", "Fløde", "Tomatpuré"], 2),
    "Æggekage": _r("aeg", "vegetar", "andet", 1, False, ["Æg", "Bacon", "Purløg", "Rugbrød"]),
    "Frittata": _r("aeg", "vegetar", "andet", 1, False, ["Æg", "Kartofler", "Ost"]),
    "Dahl": _r("dahl", "vegetar", "ris", 2, True, ["Røde linser", "Kokosmælk", "Karry", "Ris"]),
    "Rugbrød": {**_r("rugbrod", "blandet", "brød", 1, False, ["Rugbrød", "Pålæg"]), "fyld": True},
    "Kylling i cajun sauce": _r("kyllingsauce", "kylling", "ris", 2, False, ["Kyllingebryst", "Cajun-krydderi", "Fløde", "Ris"]),
    "Braiseret nakkefilet": _r("steg", "svin", "kartofler", 3, True, ["Svinenakke", "Kartofler", "Grøntsager"]),
    "Paprikagryde med oksetern": _r("gryde", "okse", "ris", 3, True, ["Oksetern", "Paprika", "Løg", "Ris"]),
    "Kylling": _r("kylling", "kylling", "andet", 2, False, ["Kylling"]),
}

# Genkendelse: første regel der matcher vinder (rækkefølgen betyder noget).
REGLER: list[tuple[str, str]] = [
    (r"puke ?ball|poke", "Poke bowl"),
    (r"pita|arayes", "Pita"),
    (r"cornflakes|kyllinge ?burger", "Cornflakes kyllingeburger"),
    (r"pulled pork", "Pulled pork burger"),
    (r"sunde? burger", "Sunde burgere"),
    (r"burger", "Burger"),
    (r"tacot[æa]rte", "Tacotærte"),
    (r"wraps?\b", "Wraps"),
    (r"tortilla", "Tortillacups med kylling"),
    (r"mexi", "Mexi bowl"),
    (r"kyllinge ?lasagne|lasagne.*kylling", "Kyllingelasagne"),
    (r"åben lasagne", "Åben lasagne"),
    (r"lasagne", "Lasagne"),
    (r"marry me", "Marry me pasta med kødboller"),
    (r"kylle ?boller|kyllinge ?boller", "Kyllingeboller i karrysauce"),
    (r"kødbolle|meatball", "Kødboller i tomatsauce"),
    (r"\bbolo|bolognese|kødsovs", "Spaghetti bolognese"),
    (r"karry", "Kylling i karry"),
    (r"nasi", "Nasi goreng"),
    (r"satay", "Kylling satay med ris"),
    (r"miso", "Miso nudler med gris"),
    (r"stir ?fry", "Thai svin stir fry"),
    (r"oksestrimler|\bwok\b", "Wok med oksestrimler"),
    (r"nudler", "Kylling med nudler"),
    (r"nduja", "Nduja pasta"),
    (r"tortellini", "Gratineret tortellini med kylling"),
    (r"fiskefrikadel", "Fiskefrikadeller"),
    (r"kylle ?deller|kyllinge ?deller|kyll?(inge|e) ?frikar?d", "Kyllingefrikadeller"),
    (r"frikad|frikard|deller", "Frikadeller"),
    (r"karbonade", "Karbonader med sovs og kartofler"),
    (r"millionbøf", "Millionbøf med kartoffelmos"),
    (r"farsbrød", "Græsk farsbrød med kartofler"),
    (r"hakkebøf", "Hakkebøf med bløde løg"),
    (r"kyllinge ?schnitzel", "Kyllingeschnitzel med ovnkartofler"),
    (r"schnitzel", "Wienerschnitzel"),
    (r"fyldt[e]? kyll|kyllebryst|kyllingebryst", "Fyldt kyllingebryst med pikantost"),
    (r"peberfrugt", "Fyldte peberfrugter med ris"),
    (r"bøf", "Bøffer på grill"),
    (r"kartoffelfad", "Kartoffelfad med oksekød og feta"),
    (r"chili con carne|chili sin", "Chili con carne"),
    (r"mou?s+[ao]u?k+a|mosoukka", "Moussaka"),
    (r"hokkaido", "Hokkaidosuppe"),
    (r"kyllinge ?suppe", "Kyllingesuppe"),
    (r"suppe", "Suppe"),
    (r"tærte.*skinke", "Tærte med skinke og ost"),
    (r"tærte", "Tærte med oksekød"),
    (r"laks", "Laks"),
    (r"\bfisk|torsk|rødspætte", "Fisk"),
    (r"pølse", "Svensk pølseret"),
    (r"æggekage", "Æggekage"),
    (r"fri[t]+at+a", "Frittata"),
    (r"\bdahl|\bdal\b", "Dahl"),
    (r"rugbrød", "Rugbrød"),
    (r"cajun", "Kylling i cajun sauce"),
    (r"nakke", "Braiseret nakkefilet"),
    (r"gryde", "Paprikagryde med oksetern"),
    (r"^kylling$", "Kylling"),
]
_REGLER = [(re.compile(p, re.IGNORECASE), navn) for p, navn in REGLER]

# Dage hvor der står noget, men ikke en ret (besøg, fester, "tit alene hjemme" …)
_BEGIVENHED_RE = re.compile(
    r"besøg|fødselsdag|bryllup|tivoli|\b\d{2}\s*år\b|\bfest\b|\bude\b|\bmiddag hos|alene hjemme|"
    r"^(tit|titan|mette)\s+(alene|arbejde|nat|dag)$|^impro$|^mor og\b|^\w+ og \w+\.?$|ferie|restaurant|takeaway",
    re.IGNORECASE,
)
_REST_RE = re.compile(r"\b(" + "|".join(re.escape(r) for r in DEFAULT_REST_ORD) + r")\b", re.IGNORECASE)

# --------------------------------------------------------------------------- dags-mærker
# id: (label, travl, standard-note). Noten skrives i madplanen foran retten ("tit nat - …").
TAGS: dict[str, tuple[str, bool, str]] = {
    "nat": ("Nattevagt", True, "nat"),
    "dag": ("Sent hjem", True, "dag"),
    "alene": ("Én voksen", True, "alene"),
    "fodbold": ("Fodbold", True, "fodbold"),
    "travl": ("Travl aften", True, ""),
    "tid": ("God tid", False, ""),
    "gaester": ("Gæster", False, "gæster"),
    "ude": ("Ingen madlavning", False, ""),
}
# Hvordan mærkerne genkendes i jeres egne noter ("tit nat", "Mette/Anton alene", "fodboldtræning")
_TAG_NOTE_RE = {
    "nat": re.compile(r"\bnat\b", re.IGNORECASE),
    "dag": re.compile(r"\b(arbejde|dag)\b", re.IGNORECASE),
    "alene": re.compile(r"alene", re.IGNORECASE),
    "fodbold": re.compile(r"fodbold", re.IGNORECASE),
    "gaester": re.compile(r"gæster|besøg", re.IGNORECASE),
}
TRAVLE = {k for k, v in TAGS.items() if v[1]}
# Hvor meget et mærke trækker mod nemme retter (1 = fuldt)
TRAVLHED = {"nat": 1.0, "alene": 1.0, "fodbold": 0.8, "travl": 0.8, "dag": 0.6}

# --------------------------------------------------------------------------- nyt at prøve
# Nye retter der ligner noget, familien allerede spiser (børnevenligt; champignon og
# cocktailpølser er populære, meget grønt er ikke).
NYE: list[dict] = [
    {"navn": "Butter chicken med ris og naan", "ligner": "Kylling i karry", **_r("karry", "kylling", "ris", 2, True, ["Kyllingebryst", "Garam masala", "Hakkede tomater", "Fløde", "Ris", "Naan"], 2)},
    {"navn": "Kyllingegryde med champignon og pasta", "ligner": "Kylling i cajun sauce", **_r("kyllingsauce", "kylling", "pasta", 2, True, ["Kyllingebryst", "Champignon", "Fløde", "Pasta"], 2)},
    {"navn": "Stroganoff med champignon og ris", "ligner": "Millionbøf med kartoffelmos", **_r("millionbof", "okse", "ris", 2, True, ["Oksestrimler", "Champignon", "Creme fraiche", "Ris"], 2)},
    {"navn": "Ovnbagt pasta med kødsovs og mozzarella", "ligner": "Spaghetti bolognese", **_r("bolo", "okse", "pasta", 2, True, ["Pasta", "Hakket oksekød", "Hakkede tomater", "Mozzarella"], 2)},
    {"navn": "Cannelloni med kødfyld", "ligner": "Lasagne", **_r("lasagne", "okse", "pasta", 3, True, ["Cannelloni", "Hakket oksekød", "Hakkede tomater", "Revet ost"], 2)},
    {"navn": "Spaghetti med kyllingekødboller", "ligner": "Kødboller i tomatsauce", **_r("kodboller", "kylling", "pasta", 2, True, ["Hakket kylling", "Spaghetti", "Hakkede tomater", "Parmesan"], 2)},
    {"navn": "Quesadillas med kylling og ost", "ligner": "Wraps", **_r("mexi", "kylling", "brød", 1, False, ["Tortillas", "Kylling", "Revet ost", "Majs", "Creme fraiche"], 2)},
    {"navn": "Burrito bowl med kylling", "ligner": "Mexi bowl", **_r("mexi", "kylling", "ris", 2, False, ["Ris", "Kylling", "Majs", "Bønner", "Avocado"])},
    {"navn": "Smashburgere", "ligner": "Burger", **_r("burger", "okse", "brød", 1, False, ["Burgerboller", "Hakket oksekød", "Cheddar", "Salat"], 2)},
    {"navn": "Cheeseburger-pasta i én gryde", "ligner": "Burger", **_r("pasta", "okse", "pasta", 1, False, ["Pasta", "Hakket oksekød", "Cheddar", "Mælk"], 2)},
    {"navn": "Souvlaki-spyd med pita og tzatziki", "ligner": "Pita", **_r("pita", "svin", "brød", 2, False, ["Svinekød i tern", "Pitabrød", "Tzatziki", "Agurk"], 2)},
    {"navn": "Pizza på pitabrød", "ligner": "Pita", **_r("pizza", "svin", "brød", 1, False, ["Pitabrød", "Tomatsauce", "Mozzarella", "Skinke", "Champignon"], 2)},
    {"navn": "Hjemmelavet pizza", "ligner": "Burger", **_r("pizza", "svin", "brød", 2, False, ["Pizzadej", "Tomatsauce", "Mozzarella", "Skinke", "Champignon"], 2)},
    {"navn": "Teriyaki-kylling med ris", "ligner": "Nasi goreng", **_r("asiat", "kylling", "ris", 1, False, ["Kyllingelår", "Teriyakisauce", "Ris", "Broccoli"], 2)},
    {"navn": "Kylling chow mein", "ligner": "Kylling med nudler", **_r("wok", "kylling", "nudler", 1, False, ["Ægnudler", "Kylling", "Wokgrøntsager", "Soja"], 2)},
    {"navn": "Pølsegryde med cocktailpølser og ris", "ligner": "Svensk pølseret", **_r("polser", "svin", "ris", 1, False, ["Cocktailpølser", "Hakkede tomater", "Fløde", "Ris"], 2)},
    {"navn": "Shepherd's pie", "ligner": "Kartoffelfad med oksekød og feta", **_r("kartoffelfad", "okse", "kartofler", 2, True, ["Hakket oksekød", "Kartofler", "Gulerødder", "Ærter"], 2)},
    {"navn": "Gullasch med kartoffelmos", "ligner": "Paprikagryde med oksetern", **_r("gryde", "okse", "kartofler", 3, True, ["Oksetern", "Paprika", "Løg", "Kartofler"])},
    {"navn": "Kyllingenuggets med ovnkartofler", "ligner": "Cornflakes kyllingeburger", **_r("schnitzel", "kylling", "kartofler", 2, False, ["Kyllingebryst", "Cornflakes", "Æg", "Kartofler"], 2)},
    {"navn": "Laks i ovn med pasta og flødesauce", "ligner": "Laks", **_r("fisk", "fisk", "pasta", 1, False, ["Laks", "Pasta", "Fløde", "Citron"], 2)},
    {"navn": "Fiskefileter i rasp med kartoffelbåde", "ligner": "Fiskefrikadeller", **_r("fisk", "fisk", "kartofler", 1, False, ["Panerede fiskefileter", "Kartofler", "Remoulade"], 2)},
    {"navn": "Risotto med kylling og champignon", "ligner": "Fyldt kyllingebryst med pikantost", **_r("risotto", "kylling", "ris", 2, False, ["Risottoris", "Kylling", "Champignon", "Parmesan"], 2)},
    {"navn": "Kartoffelsuppe med bacon", "ligner": "Hokkaidosuppe", **_r("suppe", "svin", "suppe", 2, True, ["Kartofler", "Porrer", "Bacon", "Brød"])},
    {"navn": "Pasta carbonara", "ligner": "Nduja pasta", **_r("pasta", "svin", "pasta", 1, False, ["Spaghetti", "Bacon", "Æg", "Parmesan"], 2)},
    {"navn": "Kyllingespyd med ris og satay-dip", "ligner": "Kylling satay med ris", **_r("asiat", "kylling", "ris", 2, False, ["Kyllingebryst", "Peanutbutter", "Ris", "Agurk"], 2)},
    {"navn": "Græske kødboller (keftedes) med kartofler", "ligner": "Græsk farsbrød med kartofler", **_r("farsbrod", "okse", "kartofler", 2, True, ["Hakket oksekød", "Feta", "Kartofler", "Tzatziki"])},
]

HALVERING = 120  # dage – efter 4 måneder tæller en aften halvt så meget
MIN_DAGE_IGEN = 5  # samme ret tidligst efter 5 dage


# --------------------------------------------------------------------------- genkendelse
def kanonisk(ret: str) -> str | None:
    """Kendt navn for en ret ("bolo dobbelt portion" -> "Spaghetti bolognese")."""
    low = (ret or "").lower()
    for rx, navn in _REGLER:
        if rx.search(low):
            return navn
    return None


def egenskaber(navn: str, kendte: dict[str, dict] | None = None) -> dict:
    """Egenskaber for en ret – kendte retter fra tabellen, ellers et kvalificeret gæt."""
    if navn in RETTER:
        return RETTER[navn]
    for ny in NYE:
        if ny["navn"] == navn:
            return ny
    if kendte and navn in kendte:
        return kendte[navn]
    low = navn.lower()
    protein = "andet"
    for p, words in (("kylling", ("kylling", "kylle", "kalkun")), ("fisk", ("laks", "fisk", "torsk", "rejer", "tun")),
                     ("okse", ("okse", "hakket", "bøf", "fars")), ("svin", ("svin", "gris", "nakke", "skinke", "pølse", "bacon")),
                     ("vegetar", ("vegetar", "linse", "bønne", "grønt"))):
        if any(w in low for w in words):
            protein = p
            break
    base = "pasta" if any(w in low for w in ("pasta", "spaghetti", "penne", "orzo")) else (
        "ris" if "ris" in low.split() or " ris" in low else ("kartofler" if "kartof" in low else "andet"))
    return _r(dish_key(navn) or low, protein, base, 2)


@dataclass
class Aften:
    dato: date
    slags: str  # "ret" | "rest" | "begivenhed"
    navn: str  # kanonisk navn (eller teksten for begivenheder)
    original: str
    tags: set[str] = field(default_factory=set)
    noter: list[str] = field(default_factory=list)
    stor: bool = False
    rest_af: str | None = None


def tags_fra_noter(noter: list[str], raw: str = "") -> set[str]:
    tekst = " ".join(noter) + " " + (raw or "")
    tags = {t for t, rx in _TAG_NOTE_RE.items() if rx.search(" ".join(noter))}
    # "Tit alene rester" / "Mette/Anton alene" uden bindestreg
    if re.search(r"\balene\b", tekst, re.IGNORECASE):
        tags.add("alene")
    if re.search(r"\btit nat\b", tekst, re.IGNORECASE):
        tags.add("nat")
    return tags


def laes_historik(madplan: dict[date, Dag]) -> list[Aften]:
    """Alle dage i madplanen som Aften-objekter, ældste først (tomme dage udeladt)."""
    out: list[Aften] = []
    seneste_stor: list[tuple[date, str]] = []
    for d in sorted(madplan):
        dag = madplan[d]
        if not dag.ret:
            continue
        tags = tags_fra_noter(dag.noter, dag.raw)
        low = dag.ret.lower()
        if _REST_RE.search(low):
            base_txt = _REST_RE.sub(" ", dag.ret)
            base = kanonisk(base_txt)
            if base is None:  # "rester fra søndag" -> seneste ret inden for 3 dage
                for sd, sn in reversed(seneste_stor):
                    if (d - sd).days <= 3:
                        base = sn
                        break
            out.append(Aften(d, "rest", base or "Rester", dag.ret, tags, dag.noter, False, base))
            continue
        navn = kanonisk(dag.ret)
        if navn is None:
            stripped = re.sub(r"\b(tit|titan|mette|anton|carlo|carlos)\b", "", low).strip(" .,-/")
            if _BEGIVENHED_RE.search(low) or _BEGIVENHED_RE.search(stripped) or not stripped or low.endswith("?"):
                if low.endswith("?") and len(stripped) > 2:
                    pass  # "fisk?" fanges af reglerne; andre spørgsmål er usikre planer
                out.append(Aften(d, "begivenhed", dag.ret, dag.ret, tags, dag.noter))
                continue
            navn = dag.ret[0].upper() + dag.ret[1:]
        out.append(Aften(d, "ret", navn, dag.ret, tags, dag.noter, dag.stor_portion))
        seneste_stor.append((d, navn))
    # Retter der blev spist som rester dagen efter, var "store portioner"
    by_name_date = {(a.navn, a.dato): a for a in out if a.slags == "ret"}
    for a in out:
        if a.slags == "rest" and a.rest_af:
            for back in range(1, 4):
                src = by_name_date.get((a.rest_af, a.dato - timedelta(days=back)))
                if src:
                    src.stor = True
                    break
    return out


# --------------------------------------------------------------------------- profil
@dataclass
class Profil:
    navn: str
    egen: dict
    antal: int = 0
    vaegt: float = 0.0  # tidsvægtet antal
    sidst: date | None = None
    sidst_idx: int = -1
    travl_antal: int = 0
    stor_antal: int = 0
    rest_antal: int = 0
    ugedage: list[int] = field(default_factory=lambda: [0] * 7)
    varianter: dict[str, int] = field(default_factory=dict)
    noter_brugt: dict[str, int] = field(default_factory=dict)


@dataclass
class Model:
    i_dag: date
    aftener: list[Aften]
    profiler: dict[str, Profil]
    d_eff: float
    fam_ugedag: dict[str, list[float]]
    fam_total: dict[str, float]
    ugedag_total: list[float]
    protein_andel: dict[str, float]
    note_tekst: dict[str, str]  # tag -> jeres egen formulering, fx "nat" -> "tit nat"
    vane_tags: dict[int, list[str]]  # ugedag -> mærker der plejer at gå igen
    blok_laengde: int
    middage: int


def byg_model(madplan: dict[date, Dag], i_dag: date, foer: date | None = None) -> Model:
    """Byg profilen ud fra alle dage før `foer` (standard: i dag + alt planlagt)."""
    alle = laes_historik(madplan)
    aftener = [a for a in alle if foer is None or a.dato < foer]
    middage = [a for a in aftener if a.slags in ("ret", "rest")]
    ref = foer or i_dag

    def w(d: date) -> float:
        return 0.5 ** (max(0, (ref - d).days) / HALVERING)

    d_eff = sum(w(a.dato) for a in middage) or 1.0
    profiler: dict[str, Profil] = {}
    fam_ugedag: dict[str, list[float]] = {}
    fam_total: dict[str, float] = {}
    ugedag_total = [0.0] * 7
    protein: dict[str, float] = {}
    note_count: dict[str, dict[str, int]] = {}

    for idx, a in enumerate(middage):
        for note in a.noter:
            for t, rx in _TAG_NOTE_RE.items():
                if rx.search(note):
                    k = note.strip().lower()
                    note_count.setdefault(t, {})
                    note_count[t][k] = note_count[t].get(k, 0) + 1
        if a.slags == "rest":
            if a.rest_af and a.rest_af in profiler:
                profiler[a.rest_af].rest_antal += 1
            continue
        egen = egenskaber(a.navn)
        p = profiler.setdefault(a.navn, Profil(a.navn, egen))
        p.antal += 1
        p.vaegt += w(a.dato)
        p.sidst = a.dato
        p.sidst_idx = idx
        p.ugedage[a.dato.weekday()] += 1
        p.varianter[a.original] = p.varianter.get(a.original, 0) + 1
        if a.tags & TRAVLE:
            p.travl_antal += 1
        if a.stor:
            p.stor_antal += 1
        fam = egen["fam"]
        # Ugedagsvaner vægtes også efter alder – en gammel "rugbrødstirsdag" fader ud
        fam_ugedag.setdefault(fam, [0.0] * 7)[a.dato.weekday()] += w(a.dato)
        fam_total[fam] = fam_total.get(fam, 0.0) + w(a.dato)
        ugedag_total[a.dato.weekday()] += w(a.dato)
        protein[egen["protein"]] = protein.get(egen["protein"], 0) + w(a.dato)

    tot_p = sum(protein.values()) or 1.0
    note_tekst = {}
    for t, cnt in note_count.items():
        # kortest af de hyppigste ("tit nat" frem for "tit nat - fodbold")
        note_tekst[t] = sorted(cnt.items(), key=lambda kv: (-kv[1], len(kv[0])))[0][0]

    # Mærker der går igen på samme ugedag i de seneste 10 uger (fx fodbold om mandagen)
    vane_tags: dict[int, list[str]] = {}
    seneste = [a for a in aftener if (ref - a.dato).days <= 70]
    for wd in range(7):
        cnt: dict[str, int] = {}
        for a in seneste:
            if a.dato.weekday() == wd:
                for t in a.tags & {"fodbold"}:
                    cnt[t] = cnt.get(t, 0) + 1
        vane_tags[wd] = [t for t, c in cnt.items() if c >= 3]

    return Model(
        i_dag=i_dag, aftener=aftener, profiler=profiler, d_eff=d_eff, fam_ugedag=fam_ugedag,
        fam_total=fam_total, ugedag_total=ugedag_total,
        protein_andel={k: v / tot_p for k, v in protein.items()}, note_tekst=note_tekst,
        vane_tags=vane_tags, blok_laengde=_blok_laengde(madplan), middage=len(middage),
    )


def _blok_laengde(madplan: dict[date, Dag]) -> int:
    """Hvor mange dage I plejer at planlægge ad gangen (median af de seneste uger)."""
    # En blok = dagene under samme "Uge NN" (kan løbe ons->tor ugen efter)
    grupper: dict[tuple[int, int], list[date]] = {}
    for d in sorted(madplan):
        dag = madplan[d]
        if dag.uge is not None:
            grupper.setdefault((d.isocalendar()[0], dag.uge), []).append(d)
    blokke = sorted((min(ds), (max(ds) - min(ds)).days + 1) for ds in grupper.values() if len(ds) >= 4)
    laengder = [n for _, n in blokke[-4:]]
    if not laengder:
        return 7
    return int(max(5, min(10, round(median(laengder)))))


# --------------------------------------------------------------------------- scoring
def _rytme(r: float) -> float:
    """Hvor "moden" en ret er: r = aftener siden sidst / normalt antal aftener imellem."""
    if r < 0.3:
        return 0.03
    if r < 1:
        return 0.03 + 0.97 * ((r - 0.3) / 0.7) ** 1.6
    if r < 2.5:
        return 1 + 0.3 * min(1.0, (r - 1) / 1.5)
    return max(0.9, 1.3 - (r - 2.5) * 0.04)


@dataclass
class Valg:
    navn: str
    score: float
    grunde: list[str]
    nyt: bool = False
    ligner: str | None = None
    rest_af: str | None = None
    stor: bool = False


@dataclass
class DagPlan:
    dato: date
    tags: set[str]
    laast: bool = False
    tekst: str | None = None  # låst/forud planlagt tekst (fri tekst)
    valg: Valg | None = None
    alternativer: list[Valg] = field(default_factory=list)
    kalender: list[str] = field(default_factory=list)
    auto_tags: set[str] = field(default_factory=set)
    eksisterende: bool = False


class Planlaegger:
    def __init__(self, model: Model, *, skjulte: set[str] | None = None, seed: int | None = None) -> None:
        self.m = model
        self.skjulte = {s.lower() for s in (skjulte or set())}
        self.rnd = random.Random(seed)

    # -------------------------------------------------------------- hjælpere
    def _dage_siden(self, p: Profil, dato: date) -> int:
        return (dato - p.sidst).days if p.sidst else 999

    def _gap(self, p: Profil) -> float:
        """Normalt antal aftener mellem gangene (mindst 4)."""
        return max(4.0, self.m.d_eff / max(p.vaegt, 0.05))

    def _ugedag_faktor(self, fam: str, wd: int) -> float:
        c_fw = self.m.fam_ugedag.get(fam, [0.0] * 7)[wd]
        c_f = self.m.fam_total.get(fam, 0.0)
        c_w = self.m.ugedag_total[wd] or 1
        n = sum(self.m.ugedag_total) or 1
        if c_f == 0:
            return 1.0
        p_f = c_f / n
        p_fw = (c_fw + 2 * p_f) / (c_w + 2)
        ratio = p_fw / p_f
        if c_fw < 1.4:  # mindst ~2 nylige gange før det tæller som en vane
            ratio = min(ratio, 1.0)
        return max(0.75, min(1.7, ratio))

    def _travl(self, tags: set[str]) -> bool:
        return bool(tags & TRAVLE)

    def _travlhed(self, tags: set[str]) -> float:
        """0..1 – flere travle mærker samme dag gør aftenen travlere."""
        vals = sorted((TRAVLHED.get(t, 0) for t in tags), reverse=True)
        if not vals or vals[0] == 0:
            return 0.0
        return min(1.0, vals[0] + 0.3 * sum(vals[1:]))

    # -------------------------------------------------------------- én kandidat
    def _vurder(self, navn: str, dag: DagPlan, plan: list[DagPlan], i: int, nyt: dict | None = None) -> Valg | None:
        if navn.lower() in self.skjulte:
            return None
        egen = nyt or egenskaber(navn, None)
        p = self.m.profiler.get(nyt["ligner"] if nyt else navn)
        if p is None:
            return None
        wd = dag.dato.weekday()
        grunde: list[str] = []

        # 1) smag
        if nyt:
            smag = (p.vaegt + 0.1 * p.antal) ** 0.7 * 0.55
        else:
            smag = (p.vaegt + 0.1 * p.antal) ** 0.7

        # 2) rytme – aftener siden sidst (historik + de dage, der allerede er planlagt før denne)
        siden_dage = self._dage_siden(p, dag.dato)
        if nyt:
            rytme = 1.0
        else:
            if siden_dage < MIN_DAGE_IGEN:
                return None
            siden = sum(1 for a in self.m.aftener if a.slags in ("ret", "rest") and p.sidst and a.dato > p.sidst)
            siden += sum(1 for d in plan[:i] if d.valg or d.tekst)
            r = siden / self._gap(p)
            rytme = _rytme(r)

        # 3) ugedag
        uf = self._ugedag_faktor(egen["fam"], wd)

        # 4) travlhed / god tid
        travl = self._travl(dag.tags)
        e = egen["effort"]
        if travl:
            th = self._travlhed(dag.tags)
            kf = 1 + th * ({1: 1.6, 2: 0.95, 3: 0.3}[e] - 1)
            if p.antal >= 2 and not nyt:
                kf *= 1 + 0.7 * th * (p.travl_antal / p.antal)
        elif "tid" in dag.tags or (wd >= 5 and not travl):
            kf = {1: 0.85, 2: 1.0, 3: 1.35}[e]
        else:
            kf = {1: 1.0, 2: 1.0, 3: 0.75}[e]
        if egen.get("fyld") and not travl:
            kf *= 0.35  # "ingen madlavning"-retter hører til de travle aftener
        if "gaester" in dag.tags:
            kf *= 1.3 if egen.get("stor") else 0.85

        # 5) variation i forhold til resten af planen og de sidste dage før
        vf = 1.0
        brugt = [x for x in plan if x.valg and x is not dag]
        foer = [x for x in plan[:i] if x.valg]
        navne = {x.valg.navn for x in brugt} | {x.valg.rest_af for x in brugt if x.valg.rest_af}
        if navn in navne:
            return None
        fam_brugt = [egenskaber(x.valg.navn)["fam"] for x in brugt if not x.valg.rest_af]
        if egen["fam"] in fam_brugt:
            vf *= 0.15
        prot_brugt = [egenskaber(x.valg.navn)["protein"] for x in brugt if not x.valg.rest_af]
        n_dage = len(plan)
        maks = math.ceil(self.m.protein_andel.get(egen["protein"], 0.1) * n_dage + 0.8)
        over = prot_brugt.count(egen["protein"]) + 1 - maks
        if over > 0:
            vf *= 0.45 ** over
        # nabodage (inkl. sidste dage af den forrige plan)
        naboer = self._naboer(dag.dato, plan)
        for nb in naboer:
            ne = egenskaber(nb)
            if ne["protein"] == egen["protein"] and egen["protein"] not in ("blandet", "andet"):
                vf *= 0.6
            if ne["base"] == egen["base"]:
                vf *= 0.65
            if ne["fam"] == egen["fam"]:
                vf *= 0.3
        baser = [egenskaber(x.valg.navn)["base"] for x in brugt if not x.valg.rest_af]
        if egen["base"] == "pasta" and baser.count("pasta") >= 2:
            vf *= 0.35
        if egen["base"] == "brød" and baser.count("brød") >= 2:
            vf *= 0.5

        # 6) dobbelt portion, når en travl aften følger
        stor = False
        if egen.get("stor") and not travl and not nyt:
            for j in (i + 1, i + 2):
                if j < len(plan) and self._travl(plan[j].tags) and not plan[j].laast:
                    kf *= 1.35
                    stor = True
                    break

        score = smag * rytme * uf * kf * vf
        if score <= 0:
            return None

        # Grunde (vises under retten)
        if nyt:
            grunde.append(f"Minder om {nyt['ligner'][0].lower() + nyt['ligner'][1:]}, som I har fået {p.antal} gange")
        if travl and e == 1:
            grunde.append("Nem aften")
        elif travl and p.antal >= 2 and p.travl_antal / p.antal >= 0.4:
            grunde.append("Plejer at gå på travle dage")
        if uf >= 1.3 and not nyt:
            grunde.append(f"Tit på en {UGEDAGE[wd].lower()}")
        if stor:
            grunde.append("Lav dobbelt – rester til en travl aften")
        if not nyt:
            if siden_dage >= 60 and p.antal >= 2:
                grunde.append(f"Genfundet · ikke siden {_maaned(p.sidst)}")
            elif p.antal >= 3:
                grunde.append(f"{p.antal}× · sidst for {_siden(siden_dage)}")
            elif p.antal >= 1:
                grunde.append(f"{'Én gang' if p.antal == 1 else f'{p.antal}×'} · sidst for {_siden(siden_dage)}")
        return Valg(navn, score, grunde[:2], bool(nyt), nyt["ligner"] if nyt else None, None, stor)

    def _naboer(self, dato: date, plan: list[DagPlan]) -> list[str]:
        """Retter dagen før og dagen efter (fra planen eller historikken)."""
        out = []
        for delta in (-1, 1):
            d = dato + timedelta(days=delta)
            hit = next((x for x in plan if x.dato == d), None)
            if hit and hit.valg:
                navn = hit.valg.rest_af or hit.valg.navn
                if navn in self.m.profiler or navn in RETTER or any(n["navn"] == navn for n in NYE):
                    out.append(navn)
            elif hit is None and delta == -1:
                h = next((a for a in reversed(self.m.aftener) if a.dato == d and a.slags == "ret"), None)
                if h:
                    out.append(h.navn)
        return out

    # -------------------------------------------------------------- hele ugen
    def kandidater(self, dag: DagPlan, plan: list[DagPlan], i: int, med_nye: bool = False) -> list[Valg]:
        out = []
        for navn in self.m.profiler:
            v = self._vurder(navn, dag, plan, i)
            if v:
                out.append(v)
        if med_nye:
            out.extend(self._nye_kandidater(dag, plan, i))
        out.sort(key=lambda v: -v.score)
        return out

    def _nye_kandidater(self, dag: DagPlan, plan: list[DagPlan], i: int) -> list[Valg]:
        kendte = {dish_key(n) for n in self.m.profiler}
        out = []
        for ny in NYE:
            if dish_key(ny["navn"]) in kendte or ny["ligner"] not in self.m.profiler:
                continue
            if kanonisk(ny["navn"]) and kanonisk(ny["navn"]) in self.m.profiler and kanonisk(ny["navn"]) != ny["ligner"]:
                continue
            v = self._vurder(ny["navn"], dag, plan, i, nyt=ny)
            if v:
                out.append(v)
        return out

    def _rest_kilde(self, plan: list[DagPlan], i: int) -> Valg | None:
        for j in (i - 1, i - 2):
            if j >= 0 and plan[j].valg and plan[j].valg.stor and not plan[j].valg.rest_af and not plan[j].valg.nyt:
                navn = plan[j].valg.navn
                if not any(x.valg and x.valg.rest_af == navn for x in plan):
                    return plan[j].valg
        return None

    def _rest_valg(self, kilde: Valg, plan: list[DagPlan], i: int) -> Valg:
        j = next(k for k in range(len(plan)) if plan[k].valg is kilde)
        dag = UGEDAGE[plan[j].dato.weekday()].lower()
        return Valg(f"{kilde.navn} rest", 100.0, [f"Rester fra {dag}", "Ingen madlavning"], rest_af=kilde.navn)

    def planlaeg(self, plan: list[DagPlan], antal_nye: int = 1, rester: bool = True) -> list[DagPlan]:
        """Udfyld alle ulåste dage i planen."""
        for d in plan:
            if not d.laast:
                d.valg = None
        # Låste/forud planlagte dage tæller med i variationen
        for d in plan:
            if d.laast and d.tekst and d.valg is None:
                d.valg = self.laast_valg(d.tekst)

        # Nye retter placeres helst på en rolig dag – vælg hvilke(n) først
        nye_dage: set[int] = set()
        if antal_nye > 0:
            rolige = [i for i, d in enumerate(plan) if not d.laast and "ude" not in d.tags and not self._travl(d.tags)]
            rolige.sort(key=lambda i: (0 if plan[i].dato.weekday() >= 5 or "tid" in plan[i].tags else 1, self.rnd.random()))
            nye_dage = set(rolige[:antal_nye])

        for i, d in enumerate(plan):
            if d.laast or "ude" in d.tags:
                continue
            # Rester efter en stor portion på en travl dag
            if rester and self._travl(d.tags):
                kilde = self._rest_kilde(plan, i)
                if kilde:
                    d.valg = self._rest_valg(kilde, plan, i)
                    continue
            kand = self.kandidater(d, plan, i, med_nye=i in nye_dage)
            if i in nye_dage:
                nye = [k for k in kand if k.nyt]
                if nye:
                    d.valg = self._traek(nye[:4])
                    continue
            kand = [k for k in kand if not k.nyt]
            if kand:
                d.valg = self._traek(kand[:7])
        # Stor portion kun hvor resterne faktisk blev brugt
        brugte_rester = {d.valg.rest_af for d in plan if d.valg and d.valg.rest_af}
        for d in plan:
            if d.valg and not d.valg.rest_af and d.valg.stor and d.valg.navn not in brugte_rester:
                d.valg.stor = False
                d.valg.grunde = [g for g in d.valg.grunde if not g.startswith("Lav dobbelt")]
        for i, d in enumerate(plan):
            d.alternativer = self.alternativer(plan, i)
        return plan

    def _kendt_navn(self, tekst: str) -> str | None:
        t = tekst.strip().lower()
        for navn in list(self.m.profiler) + list(RETTER) + [n["navn"] for n in NYE]:
            if navn.lower() == t:
                return navn
        return kanonisk(tekst)

    def laast_valg(self, tekst: str) -> Valg:
        """En dag I selv har bestemt (eller som allerede står i madplanen)."""
        if _REST_RE.search(tekst):
            kilde = self._kendt_navn(_REST_RE.sub(" ", tekst).strip(" -"))
            return Valg(tekst.strip(), 0, ["Rester"], rest_af=kilde or "Rester")
        navn = self._kendt_navn(tekst)
        if navn:
            ny = next((n for n in NYE if n["navn"] == navn), None)
            return Valg(navn, 0, [], nyt=bool(ny), ligner=ny["ligner"] if ny else None,
                        stor=bool(egenskaber(navn).get("stor")))
        return Valg(tekst.strip(), 0, [])

    def alternativer(self, plan: list[DagPlan], i: int, n: int = 8) -> list[Valg]:
        d = plan[i]
        gemt = d.valg
        d.valg = None
        try:
            kand = self.kandidater(d, plan, i, med_nye=True)
        finally:
            d.valg = gemt
        out: list[Valg] = []
        if gemt and gemt.nyt and gemt.ligner:  # det velkendte alternativ først
            kend = next((k for k in kand if k.navn == gemt.ligner), None)
            if kend:
                out.append(kend)
        if self._travl(d.tags):
            kilde = self._rest_kilde(plan, i)
            if kilde and not (gemt and gemt.rest_af):
                out.append(self._rest_valg(kilde, plan, i))
        nye_med = 0
        for k in kand:
            if gemt and k.navn == gemt.navn:
                continue
            if any(o.navn == k.navn for o in out):
                continue
            if k.nyt:
                if nye_med >= 2:
                    continue
                nye_med += 1
            out.append(k)
            if len(out) >= n:
                break
        return out

    def _traek(self, kand: list[Valg]) -> Valg:
        """Vælg blandt de bedste – vægtet, så topforslaget oftest vinder, men ikke altid."""
        weights = [max(k.score, 1e-6) ** 1.6 for k in kand]
        return self.rnd.choices(kand, weights=weights, k=1)[0]


# --------------------------------------------------------------------------- kalender
_KAL_NAT = re.compile(r"\bnat\b|nattevagt", re.IGNORECASE)
_KAL_ARB = re.compile(r"arbejde|dagvagt|\bvagt\b", re.IGNORECASE)
_KAL_FODBOLD = re.compile(r"fodbold", re.IGNORECASE)
_KAL_HELDAG_VIS = re.compile(r"fødselsdag|besøg|ferie|fest|middag|aftensmad|\bude\b|rejse|bryllup|gæster", re.IGNORECASE)


def _parse_dt(v) -> datetime | date | None:
    if isinstance(v, (datetime, date)):
        return v
    if isinstance(v, dict):
        v = v.get("dateTime") or v.get("date")
    if not v:
        return None
    try:
        if "T" in v:
            return datetime.fromisoformat(v)
        return date.fromisoformat(v)
    except ValueError:
        return None


def kalender_tags(events: list[dict], dag: date) -> tuple[set[str], list[str]]:
    """Mærker og korte tekster for en dag ud fra kalenderens begivenheder."""
    tags: set[str] = set()
    vis: list[str] = []
    for ev in events:
        start = _parse_dt(ev.get("start"))
        end = _parse_dt(ev.get("end"))
        summary = (ev.get("summary") or "").strip()
        if not start or not summary:
            continue
        if isinstance(start, datetime):
            s_local = start.replace(tzinfo=None)
            e_local = end.replace(tzinfo=None) if isinstance(end, datetime) else s_local + timedelta(hours=1)
            aften_start = datetime.combine(dag, datetime.min.time()) + timedelta(hours=16, minutes=30)
            aften_slut = datetime.combine(dag, datetime.min.time()) + timedelta(hours=19)
            if s_local.date() == dag and s_local.hour >= 12 and _KAL_NAT.search(summary):
                tags.add("nat")
                vis.append(summary)
            elif _KAL_ARB.search(summary) and s_local.date() == dag and e_local > aften_start - timedelta(minutes=30):
                tags.add("dag")
                vis.append(f"{summary} til {e_local:%H:%M}")
            elif s_local < aften_slut and e_local > aften_start:
                if _KAL_FODBOLD.search(summary):
                    tags.add("fodbold")
                else:
                    tags.add("travl")
                vis.append(f"{s_local:%H:%M} {summary}")
        else:
            e_date = end if isinstance(end, date) else start + timedelta(days=1)
            if start <= dag < e_date and _KAL_HELDAG_VIS.search(summary):
                vis.append(summary)
    return tags, vis


# --------------------------------------------------------------------------- tekst
def _siden(dage: int) -> str:
    if dage < 14:
        return f"{dage} dage siden"
    if dage < 60:
        return f"{round(dage / 7)} uger siden"
    return f"{round(dage / 30)} måneder siden"


_MAANEDER = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august",
             "september", "oktober", "november", "december"]


def _maaned(d: date | None) -> str:
    return _MAANEDER[d.month - 1] if d else "længe"


def linje(dato: date, tekst: str, noter: list[str], stor: bool) -> str:
    """Én linje i madplanen i jeres format: "Tirsdag: tit nat - chili con carne (stor portion)"."""
    parts = [n for n in noter if n] + [tekst]
    s = " - ".join(p for p in parts if p)
    if stor:
        s += " (stor portion)"
    return f"{UGEDAGE[dato.weekday()]}: {s}".rstrip()


def uge_tekst(dage: list[tuple[date, str]]) -> str:
    """Hele blokken: "Uge 43" + én linje pr. dag."""
    if not dage:
        return ""
    uge = dage[0][0].isocalendar()[1]
    return "\n".join([f"Uge {uge}"] + [t for _, t in dage])


def ret_til_madplan(navn: str) -> str:
    """Kanonisk navn -> sådan som I selv skriver det (lille begyndelsesbogstav)."""
    return navn[0].lower() + navn[1:] if navn and not navn[:2].isupper() else navn

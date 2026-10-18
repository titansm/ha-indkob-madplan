"""Ordbog til opskriftsbanken: engelske ingrediensnavne -> danske indkøbsnavne.

Ren ordbog (ingen opskrifter). Bruges af opskrifter.py ved omregning af importerede opskrifter.

NAVNE: produkt (lowercase, som ReciMe normaliserer det) -> dansk navn på indkøbslisten.
       Nøglen kan også være ReciMes "rawProduct", hvis den er mere præcis (slås op først).
"""
import re as _re

NAVNE = {
    # --- grønt & frugt ---
    "apple": "Æbler", "avocado": "Avocado", "banana": "Bananer", "blueberry": "Blåbær",
    "berries": "Bær", "cherry": "Kirsebær", "cranberry": "Tranebær", "date": "Dadler",
    "fig": "Figner", "grape": "Vindruer", "kiwi": "Kiwi", "lemon": "Citron", "lime": "Lime",
    "mango": "Mango", "peach": "Fersken", "pear": "Pærer", "pomegranate": "Granatæble",
    "raisins": "Rosiner", "lemon zest": "Citron", "lemon juice": "Citron", "lime juice": "Lime",
    "artichoke": "Artiskokhjerter", "arugula": "Rucola", "asparagus": "Asparges",
    "bean sprout": "Bønnespirer", "bok choy": "Pak choi", "broccoli": "Broccoli",
    "butternut": "Butternut squash", "cabbage": "Hvidkål", "carrot": "Gulerødder",
    "celery": "Bladselleri", "cherry tomato": "Cherrytomater", "chinese broccoli": "Kinesisk broccoli",
    "chives": "Purløg", "corn": "Majs", "cucumber": "Agurk", "lebanese cucumber": "Agurk",
    "daikon": "Ræddike", "edamame": "Edamamebønner", "eggplant": "Aubergine", "fennel": "Fennikel",
    "fingerling potato": "Små kartofler", "garlic": "Hvidløg", "ginger": "Ingefær",
    "green beans": "Grønne bønner", "green capsicum": "Grøn peberfrugt",
    "iceberg lettuce": "Icebergsalat", "jalapeno": "Jalapeño", "kale": "Grønkål", "leek": "Porre",
    "mushroom": "Champignon", "cremini mushroom": "Brune champignoner", "onion": "Løg",
    "white onion": "Løg", "red onion": "Rødløg", "potato": "Kartofler", "russet potato": "Bagekartofler",
    "sweet potato": "Søde kartofler", "pumpkin": "Græskar", "radish": "Radiser",
    "red cabbage": "Rødkål", "red pepper": "Rød peberfrugt", "yellow pepper": "Gul peberfrugt",
    "shallot": "Skalotteløg", "snow pea": "Sukkerærter", "spinach": "Spinat",
    "spring onion": "Forårsløg", "tomato": "Tomater", "turmeric root": "Frisk gurkemeje",
    "vegetable": "Grøntsager", "water chestnut": "Vandkastanjer", "zucchini": "Squash",
    "red chili": "Rød chili", "chili": "Rød chili", "birds eye chili": "Thai chili",
    # friske krydderurter
    "basil": "Basilikum", "thai basil": "Thaibasilikum", "coriander": "Koriander", "dill": "Dild",
    "mint": "Mynte", "parsley": "Persille", "rosemary": "Rosmarin", "sage": "Salvie",
    "tarragon": "Estragon", "thyme": "Timian", "oregano": "Oregano",
    # --- kød & fisk ---
    "bacon": "Bacon", "beef": "Oksekød", "beef mince": "Hakket oksekød", "steak": "Oksebøf",
    "chicken": "Kylling", "chicken breast": "Kyllingebryst", "chicken leg": "Kyllingelår",
    "chicken thigh": "Kyllingeoverlår", "pork": "Hakket svinekød", "pork mince": "Hakket svinekød",
    "prosciutto": "Parmaskinke", "salmon": "Laks", "shrimp": "Rejer",
    # --- mejeri & æg ---
    "butter": "Smør", "unsalted butter": "Smør", "buttermilk": "Kærnemælk",
    "burrata": "Burrata", "cheddar": "Cheddar", "cheese": "Revet ost", "sliced cheese": "Skiveost",
    "cottage cheese": "Hytteost", "cream": "Piskefløde", "creme fraiche": "Crème fraîche",
    "egg": "Æg", "egg yolk": "Æg", "boiled egg": "Æg", "feta": "Feta", "goats cheese": "Gedeost",
    "greek yoghurt": "Græsk yoghurt", "yoghurt": "Yoghurt naturel", "mascarpone": "Mascarpone",
    "milk": "Mælk", "mozzarella": "Mozzarella", "parmesan": "Parmesan", "pecorino": "Pecorino",
    "ricotta": "Ricotta",
    # --- brød, pasta, ris, korn ---
    "baguette": "Baguette", "bread": "Brød", "brioche": "Briochebrød", "flatbread": "Fladbrød",
    "pita": "Pitabrød", "tortilla": "Tortillas", "breadcrumb": "Rasp",
    "panko bread crumbs": "Panko", "croutons": "Croutoner", "puff pastry": "Butterdej",
    "pasta": "Pasta", "spaghetti": "Spaghetti", "orzo": "Orzo", "udon": "Udonnudler",
    "rice noodles": "Risnudler", "rice paper roll": "Rispapir", "rice": "Ris",
    "quinoa": "Quinoa", "white quinoa": "Quinoa", "barley": "Perlebyg", "burghul": "Bulgur",
    "oats": "Havregryn", "red lentils": "Røde linser",
    # --- dåser, glas, tørvarer ---
    "black bean": "Sorte bønner", "butter beans": "Butterbeans", "chickpea": "Kikærter",
    "coconut milk": "Kokosmælk", "passata": "Passata", "tomato paste": "Tomatpuré",
    "sundried tomato": "Soltørrede tomater", "olive": "Oliven", "capers": "Kapers",
    "pickles": "Syltede agurker", "kimchi": "Kimchi", "pesto": "Pesto", "salsa": "Salsa",
    "guacamole": "Guacamole", "hommus": "Hummus", "tahini": "Tahin",
    "peanut butter": "Peanutbutter", "almond butter": "Mandelsmør",
    "almond": "Mandler", "peanut": "Peanuts", "pecan": "Pekannødder", "pine nuts": "Pinjekerner",
    "pistachio": "Pistacienødder", "walnut": "Valnødder", "pepita": "Græskarkerner",
    "sunflower seed": "Solsikkekerner", "sesame": "Sesamfrø", "black sesame": "Sorte sesamfrø",
    "chia seeds": "Chiafrø", "coconut": "Kokosmel", "chocolate": "Chokolade",
    "chocolate chip": "Chokoladestykker", "cocoa powder": "Kakao", "protein powder": "Proteinpulver",
    "fried shallots": "Ristede løg", "dry yeast": "Tørgær", "nutritional yeast": "Gærflager",
    "almond milk": "Mandeldrik", "soy milk": "Sojadrik", "silken tofu": "Silketofu",
    "vanilla bean paste": "Vaniljepasta", "vanilla essence": "Vaniljeekstrakt",
    # --- saucer, olie, eddike, krydderier ---
    "soy sauce": "Sojasauce", "light soy sauce": "Sojasauce", "dark soy sauce": "Mørk sojasauce",
    "tamari": "Tamari", "fish sauce": "Fiskesauce", "oyster sauce": "Østerssauce",
    "hot sauce": "Chilisauce", "sweet and sour sauce": "Sursød sauce", "gochujang": "Gochujang",
    "miso": "Miso", "chili oil": "Chiliolie", "sesame oil": "Sesamolie", "mayonnaise": "Mayonnaise",
    "kewpie mayonnaise": "Kewpie mayo", "dijon mustard": "Dijonsennep",
    "wholegrain mustard": "Grov sennep", "mustard": "Sennep", "honey": "Honning",
    "maple syrup": "Ahornsirup", "balsamic glaze": "Balsamico creme", "salad dressing": "Dressing",
    "red wine": "Rødvin", "white wine": "Hvidvin", "chicken stock": "Hønsebouillon",
    "beef stock": "Oksebouillon", "vegetable stock": "Grøntsagsbouillon", "broth": "Bouillon",
    "gigante beans": "Gigantebønner",
    # husholdning – står på "Har vi altid" (se ALTID), men skal have dansk navn
    "salt": "Salt", "sea salt": "Salt", "salt and pepper": "Salt og peber",
    "black pepper": "Peber", "black peppercorn": "Peber", "white pepper": "Hvid peber",
    "olive oil": "Olivenolie", "extra virgin olive oil": "Olivenolie", "oil": "Olie",
    "vegetable oil": "Rapsolie", "avocado oil": "Avocadoolie", "flour": "Hvedemel",
    "bakers flour": "Hvedemel", "sugar": "Sukker", "brown sugar": "Brun farin",
    "baking powder": "Bagepulver", "bicarb soda": "Natron", "corn starch": "Majsstivelse",
    "vinegar": "Eddike", "apple cider vinegar": "Æblecidereddike", "balsamic": "Balsamicoeddike",
    "red wine vinegar": "Rødvinseddike", "white wine vinegar": "Hvidvinseddike",
    "rice wine vinegar": "Riseddike", "water": "Vand", "msg": "MSG",
    "paprika": "Paprika", "cumin": "Spidskommen", "garlic powder": "Hvidløgspulver",
    "granulated garlic": "Hvidløgspulver", "onion powder": "Løgpulver", "chilli flakes": "Chiliflager",
    "cayenne pepper": "Cayennepeber", "nutmeg": "Muskatnød", "cinnamon": "Kanel",
    "curry powder": "Karry", "turmeric": "Gurkemeje", "ground coriander": "Stødt koriander",
    "garam masala": "Garam masala", "allspice": "Allehånde", "italian herb seasoning": "Italienske krydderurter",
    "zaatar": "Za'atar", "sumac": "Sumak", "aleppo pepper": "Aleppo-peber",
}

# Væsker: "ounce" betyder fl oz -> ml
VAESKER = {
    "milk", "cream", "buttermilk", "water", "chicken stock", "beef stock", "vegetable stock",
    "broth", "red wine", "white wine", "soy sauce", "olive oil", "extra virgin olive oil", "oil",
    "vegetable oil", "coconut milk", "almond milk", "soy milk", "passata", "lemon juice",
    "lime juice", "vinegar", "maple syrup", "honey",
}

# Kød/fisk: bruges til at skalere opskriften til familiens portion (standard 400 g kød)
KOED = {
    "beef", "beef mince", "steak", "chicken", "chicken breast", "chicken leg", "chicken thigh",
    "pork", "pork mince", "salmon", "shrimp", "bacon", "Hakket oksekød", "Hakket svinekød",
    "Kylling", "Kyllingebryst", "Kyllingeoverlår", "Kyllingelår", "Oksekød", "Oksebøf", "Laks",
    "Rejer", "Torsk", "Hakket kylling", "Nakkekoteletter", "Svinemørbrad", "Tykkam",
}

# "Har vi altid" – standardliste; kommer ikke på indkøbslisten (rettes under Indstillinger → Omregning)
ALTID = {
    "Salt", "Peber", "Hvid peber", "Salt og peber", "Olivenolie", "Rapsolie", "Olie", "Smør",
    "Hvedemel", "Sukker", "Bouillon", "Eddike", "Vand",
    # tørrede krydderier
    "Paprika", "Spidskommen", "Hvidløgspulver", "Løgpulver", "Chiliflager", "Cayennepeber",
    "Muskatnød", "Kanel", "Karry", "Gurkemeje", "Stødt koriander", "Garam masala", "Allehånde",
    "Italienske krydderurter", "Tørret timian", "Tørret oregano", "Tørret rosmarin",
    "Laurbærblade",
}
# Krydderurter: med tsk/knivspids = tørret (Har vi altid), ellers frisk
TOERRET = {"Timian": "Tørret timian", "Oregano": "Tørret oregano", "Rosmarin": "Tørret rosmarin"}

# Linjer der ikke er varer (overskrifter, noter, værktøj)
SPRING_OVER = ("knife:", "fresh, zesty", "tænd ovnen", "raita")

# Dansk fritekst: første ord/fraser -> indkøbsnavn
DK_TEKST = {
    "tykkam": "Tykkam", "skalotteløg": "Skalotteløg", "champignon": "Champignon",
    "brune champignoner": "Brune champignoner", "gulerødder": "Gulerødder", "gulerod": "Gulerødder",
    "hvidløg": "Hvidløg", "solohvidløg": "Solohvidløg", "persille": "Persille",
    "bredbladet persille": "Persille", "frisk persille": "Persille", "rødvin": "Rødvin",
    "oksebouillon": "Oksebouillon", "tomatkoncentrat": "Tomatpuré", "laurbærblade": "Laurbærblade",
    "timian": "Timian", "frisk timian": "Timian", "hvedemel": "Hvedemel", "smør": "Smør",
    "vand": "Vand", "koldt vand": "Vand", "mariagertobamel": "Hvedemel", "øko gær": "Gær",
    "gær": "Gær", "tørt surdej": "Tørsurdej", "sukker": "Sukker", "sesam": "Sesamfrø",
    "cherrytomater": "Cherrytomater", "olivenolie": "Olivenolie", "kikærter": "Kikærter",
    "flagesalt": "Salt", "nakkekoteletter": "Nakkekoteletter", "løg": "Løg",
    "knoldselleri": "Knoldselleri", "porrer": "Porre", "porre": "Porre",
    "tørret timian": "Tørret timian", "hakkede tomater": "Hakkede tomater",
    "piskefløde": "Piskefløde", "æblecidereddikke": "Æblecidereddike", "hjertesalat": "Hjertesalat",
    "hasselnødder": "Hasselnødder", "græskarkerner": "Græskarkerner", "dijonsennep": "Dijonsennep",
    "hvidvinseddike": "Hvidvinseddike", "kapers": "Kapers", "kapersvand": None,
    "varmrøget laks": "Varmrøget laks", "groft brød": "Rugbrød", "hel kylling": "Hel kylling",
    "hakket oksekød": "Hakket oksekød", "kartofler": "Kartofler", "mellemstore kartofler": "Kartofler",
    "egg": "Æg", "æg": "Æg",
}

# --- flere varenavne ---
NAVNE.update({
    "tonkatsu sauce": "Tonkatsu sauce", "chicken mince": "Hakket kylling", "sriracha": "Sriracha",
    "napa cabbage": "Kinakål", "chinese cabbage": "Kinakål", "canola spray": "Olie",
    "red thai curry paste": "Rød karrypasta", "red curry paste": "Rød karrypasta",
    "salted butter": "Smør", "taco seasoning": "Tacokrydderi", "bay leaf": "Laurbærblade",
    "chili powder": "Chilipulver", "sour cream": "Cremefraiche 18 %", "lima bean": "Hvide bønner",
    "cannellini beans": "Hvide bønner", "cannellini": "Hvide bønner", "white bean": "Hvide bønner",
    "noodles": "Ægnudler", "egg noodles": "Ægnudler", "roma tomato": "Hakkede tomater",
    "plum tomatoes": "Hakkede tomater", "kidney beans": "Kidneybønner", "beef chuck": "Oksetykkam",
    "orange juice": "Appelsinjuice", "pancetta": "Pancetta", "parmigiano reggiano": "Parmesan",
    "caster sugar": "Sukker", "cauliflower": "Blomkål", "peas": "Ærter (frost)",
    "frozen peas": "Ærter (frost)", "cream cheese": "Flødeost", "agave syrup": "Agavesirup",
    "pistachios": "Pistacienødder", "honey": "Honning", "pesto": "Pesto", "gochugaru": "Gochugaru",
    "seasoned rice vinegar": "Riseddike", "gyoza": "Gyoza (frost)", "sticky rice": "Ris",
    "shredded cheese": "Revet ost", "radishes": "Radiser", "greek yogurt": "Græsk yoghurt",
    "yogurt": "Yoghurt naturel", "gigante beans": "Gigantebønner", "calabrian chili": "Calabrisk chili",
    "parsley": "Persille", "parlsey": "Persille", "olive oil": "Olivenolie", "rice": "Ris",
})
ALTID.update({"Chilipulver", "Tacokrydderi"})
DK_TEKST.update({
    "ris": "Ris", "citron": "Citron", "saften fra ½ citron": "Citron", "frisk koriander": "Koriander",
    "koriander": "Koriander", "majs fra frost": "Majs (frost)", "majs": "Majs", "sorte bønner": "Sorte bønner",
    "smagsneutral olie": "Rapsolie", "hakket grisekød": "Hakket svinekød", "hakket svinekød": "Hakket svinekød",
    "fajita spice mix": "Fajita-krydderi", "avocadoer": "Avocado", "avocado": "Avocado",
    "tomater": "Tomater", "knoldselleri": "Knoldselleri",
    # tysk
    "spitzkohl": "Spidskål", "griechischer joghurt": "Græsk yoghurt", "petersilie": "Persille",
    "senf": "Sennep", "knoblauchzehen": "Hvidløg", "agavensirup": "Agavesirup", "chiliflocken": "Chiliflager",
})

NAVNE.update({
    "cashews": "Cashewnødder", "cashew": "Cashewnødder", "hazelnut": "Hasselnødder", "hazelnuts": "Hasselnødder",
    "farro": "Farro (perlespelt)", "green string beans": "Grønne bønner", "string beans": "Grønne bønner",
    "cos lettuce": "Romainesalat", "romaine": "Romainesalat", "yukon gold": "Kartofler", "poatoes": "Kartofler",
    "tzatziki": "Tzatziki", "straciatella": "Stracciatella", "stracciatella": "Stracciatella",
    "white fish": "Hvid fisk (torsk)", "green thai curry paste": "Grøn karrypasta", "green curry paste": "Grøn karrypasta",
    "baharat": "Baharat", "tofu": "Tofu", "smoked tofu": "Røget tofu", "broccolini": "Broccolini",
    "pak choi": "Pak choi", "comte": "Comté", "mangetouts": "Sukkerærter", "sea bass": "Havbars",
    "lamb mince": "Hakket lam", "worcestershire": "Worcestershiresauce", "worcestershire sauce": "Worcestershiresauce",
    "guanciale": "Guanciale", "pearl couscous": "Perlecouscous", "cous cous": "Couscous", "couscous": "Couscous",
    "saffron": "Safran", "nigella seed": "Sortkommen", "canned tuna": "Tun på dåse", "tuna": "Tun på dåse",
    "watermelon": "Vandmelon", "gojuchang": "Gochujang", "salad": "Salat", "lettuce": "Salat",
})
ALTID.update({"Baharat", "Safran", "Sortkommen"})
DK_TEKST.update({
    "aktiv surdej": "Surdej", "fuldkornsmel": "Fuldkornsmel", "kalv og flæsk": "Hakket kalv og flæsk",
    "mælk": "Mælk", "letmælk": "Mælk", "rasp": "Rasp", "havregryn": "Havregryn", "røde peberfrugter": "Rød peberfrugt",
    "rød peberfrugt": "Rød peberfrugt", "gul peberfrugt": "Gul peberfrugt", "rød peber": "Rød peberfrugt",
    "timianblade": "Timian", "gederulle": "Gedeost", "salat": "Salat", "agavesirup": "Agavesirup",
    "æblecidereddike": "Æblecidereddike", "havsalt": "Salt", "bladselleri": "Bladselleri",
    "stødt spidskommen": "Spidskommen", "stødt kanel": "Kanel", "fløde": "Piskefløde", "olie": "Olie",
    "grøn salat": "Salat", "kyllingebryster": "Kyllingebryst", "kyllingebryst": "Kyllingebryst",
    "sort peber": "Peber", "æbler": "Æbler", "jomfruolivenolie": "Olivenolie", "ekstra jomfruolivenolie": "Olivenolie",
    "karry": "Karry", "gurkemeje": "Gurkemeje", "hønsefond": "Hønsebouillon", "soya": "Sojasauce",
    "kyllingefars": "Hakket kylling", "rød karrypaste": "Rød karrypasta", "peanutbutter": "Peanutbutter",
    "kokosmælk": "Kokosmælk", "pak choi": "Pak choi", "broccolini": "Broccolini", "tilberedt kylling": "Kylling (stegt)",
    "forårsløg": "Forårsløg", "spinat": "Spinat", "frisk spinat": "Spinat", "kylling bouillon": "Hønsebouillon",
    "whitewine": "Hvidvin", "vegetable stock": "Grøntsagsbouillon", "pølsehornspølser": "Pølsehornspølser",
    "balsamicoeddike": "Balsamicoeddike", "koteletter": "Koteletter", "honning": "Honning", "pizzadej": "Pizzadej",
    "peber": "Peber", "mel": "Hvedemel", "pankorasp": "Panko", "neutral olie": "Rapsolie",
    "worchestersauce": "Worcestershiresauce", "østerssauce": "Østerssauce", "spidskål": "Spidskål",
    "kogte ris": "Ris", "rødbeder": "Rødbeder", "linser": "Linser", "rødløg": "Rødløg", "dild": "Dild",
    "grønkål": "Grønkål", "sesamolie": "Sesamolie", "grov sennep": "Grov sennep", "flydende honning": "Honning",
    "ingefær": "Ingefær", "frisk ingefær": "Ingefær", "comte": "Comté", "mangetouts": "Sukkerærter",
})

# Linjer der aldrig er varer (noter, ovn, værktøj, trin)
IKKE_VARE = _re.compile(
    r"^(\d+\.\s|oven:|air fryer:|recipe serves|click |have a nice|taste |leave in|bowl size|carbs:|apron:|grater:|knife:|"
    r"small food processor|\d+ inch skewers|evt\.|\(optional|\(a teeny|fordel |tag dejen|rul dejen|tænd ovnen|"
    r"fresh, zesty|tonkatsu - |pølsehorn\s)", _re.I)

NAVNE.update({"parmesan rind": "Parmesan", "drizzle olive oil": "Olivenolie", "olive oil": "Olivenolie"})
DK_TEKST.update({"flagesalt": "Salt", "olivenolie": "Olivenolie", "pankorasp": "Panko", "mangetouts": "Sukkerærter",
                 "citron": "Citron", "balsamicoeddike": "Balsamicoeddike"})

KOED.update({"Hakket kalv og flæsk", "Kylling (stegt)", "Hel kylling", "Koteletter", "Hakket lam", "Havbars",
             "Hvid fisk (torsk)", "Oksetykkam", "Pancetta", "Guanciale", "Varmrøget laks", "Kyllingebryst"})
# kød angivet i stk -> ca. gram pr. stk (til skalering)
KOED_STK_G = {"Kyllingebryst": 150, "Kyllingeoverlår": 100, "Kyllingelår": 200, "Koteletter": 150,
              "Nakkekoteletter": 150, "Hel kylling": 1300, "Laks": 125}
FAMILIE_KOED_G = 400      # standard: 400 g kød til familien
FAMILIE_PORTIONER = 4     # 2 voksne + 2 børn, der spiser godt

# --- flere varenavne ---
NAVNE.update({
    "basmati rice": "Basmatiris", "jasmine rice": "Jasminris", "sushi rice": "Sushiris",
    "boiling water": "Vand", "pasta water": "Vand", "cassia bark": "Kanelstang", "cinnamon quill": "Kanelstang",
    "chicken stock cube": "Hønsebouillon", "chicken stock powder": "Hønsebouillon",
    "chicken bouillon powder": "Hønsebouillon", "chicken bouillon": "Hønsebouillon",
    "corn flour": "Majsstivelse", "cornflour": "Majsstivelse", "rice flour": "Rismel",
    "corn tortilla": "Majstortillas", "corn tortillas": "Majstortillas", "curry leaf": "Karryblade",
    "curry leaves": "Karryblade", "ditalini": "Ditalini (pasta)", "fennel seed": "Fennikelfrø",
    "garlic flakes": "Hvidløgsflager", "gochugaru flakes": "Gochugaru", "sambal oelek sauce": "Sambal oelek",
    "worcester sauce": "Worcestershiresauce", "spsk worchestersauce / engelsk sauce": "Worcestershiresauce",
    "green chili": "Grøn chili", "green chilies": "Grøn chili", "kecap manis": "Kecap manis",
    "lamb": "Hakket lam", "lasagne sheets": "Lasagneplader", "lasagna pasta sheets": "Lasagneplader",
    "lemongrass": "Citrongræs", "mirin": "Mirin", "fenugreek seeds": "Bukkehornsfrø",
    "toasted nuts / seeds": "Nødder/kerner", "mustard powder": "Sennepspulver", "orecchiette": "Orecchiette",
    "porcini mushroom": "Champignon", "chestnut mushrooms": "Brune champignoner", "ramen": "Ramennudler",
    "roast chicken": "Grillkylling", "salt flakes": "Salt", "shiitake": "Shiitakesvampe",
    "shrimp paste": "Rejepasta", "soba": "Sobanudler", "sourdough": "Surdej", "active sourdough": "Surdej",
    "tamarind paste": "Tamarindpasta", "tamarind puree": "Tamarindpasta", "ketchup": "Ketchup",
    "spsk ketchup": "Ketchup", "tuscan kale": "Sortkål", "cavolo nero": "Sortkål",
    "cavolo nero leaves": "Sortkål", "lemon wedges": "Citron", "pepper jack cheese more": "Pepper Jack-ost",
    "garlic & herb soft cheese": "Flødeost m. hvidløg & urter", "flax seeds powder": "Hørfrø",
    "cod loin": "Torsk", "skinless cod loin": "Torsk", "sea bream": "Dorade", "orata": "Dorade",
    "teriyaki": "Teriyakisauce", "red chile": "Rød chili", "thickened (heavy) cream": "Piskefløde",
    "purple wheat": "Fuldkornsmel", "tomato sauce": "Ketchup", "lamb or beef stock": "Oksebouillon",
    "salmon": "Laks", "trout": "Laks",
})
ALTID.update({"Sennepspulver", "Kanelstang", "Karryblade", "Bukkehornsfrø", "Fennikelfrø", "Hvidløgsflager"})
KOED.update({"Torsk", "Dorade", "Grillkylling", "Hakket lam"})
IKKE_VARE2 = _re.compile(r"^(\*\*instructions|ice cubes?$|fruit$|oyster$)", _re.I)

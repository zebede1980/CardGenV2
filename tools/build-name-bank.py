#!/usr/bin/env python3
"""Regenerates src/scripts/name-bank-data.js from public name datasets.

Run:  python3 tools/build-name-bank.py
Sources and licences: see tools/name_sources.py.

Why a generated bank at all: asking an LLM for "a name" collapses onto the same
handful of picks (mode collapse) and invents plausible-but-fake names for
traditions it knows thinly. Drawing from a real, frequency-ranked list and
handing the result to the model removes both failure modes.

The pools below are *data* + explicitly listed curation. Nothing is invented
here: every name reaches the output from one of the datasets, and the only
hand-written lists are (a) exclusions, and (b) the Scottish/Welsh/continental
sets that the datasets do not cover, which are marked CURATED.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import name_sources as src  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "scripts", "name-bank-data.js")

# ── Curation: names excluded from the Western pools ────────────────────────
# The app's Western/Anglo modes exist because the user wants Western-set
# characters by default. Names of non-European origin are excluded from those
# pools only — the "Any culture" mode does not use this bank at all, it uses
# the model's full cultural tradition list, so nothing is lost overall.
NON_WESTERN = set("""
Muhammad Mohammed Mohammad Muhammed Mohamed Yusuf Musa Ibrahim Ali Yahya Zakariya
Syed Abdullah Abdul Hamza Mustafa Omar Eesa Ahmed Ahmad Rayan Zain Amir Ayan Zayd
Zayan Rayyan Ayman Umar Arham Isa Hassan Khalil Ismail Azlan Aryan Khalid Ilyas
Yunus Zayaan Zorawar Zaviyar Laith Ayaan Kairo Malik Sami Idris Zayn Rohan Amari
Maryam Fatima Aisha Anaya Zahra Zainab Amira Safa Khadija Inaya Ayah Yusra Noor
Amina Syeda Khadijah Amal Zoya Ayesha Hafsa Aya Aleena Amirah Aiza Hiba Minha
Haniya Anabia Iqra Zaynab Ayra Raya Nyla Mariam Ayda Aliyah Aaliyah Hana Alara
Liyana Dua Mirha Ayzal Ayat Alaya Alora Inayah Alaia Aqsa Aizal Isra Nusaybah
Asees Amara Zara Talia Arya Kiara Myla Ayla Nola Mya
Jose Juan Carlos Luis Miguel Jesus Angel Santiago Mateo Rafael Milan Kobe Koa
Kylo Reign Lando Zion Atlas Bodhi Nevaeh Destiny
""".split())

# CURATED — real, currently fashionable baby names that read oddly on an adult
# character. The "current" pools come from the 2024 birth register, so they carry
# names that are genuinely popular for babies but that almost no adult has: a
# card is usually an adult, and "Ocean Lakin" is exactly the kind of name that
# made the old generator feel like it was making things up.
BABY_FASHION_ONLY = set("""
Ocean Rio Rome Phoenix Vienna Honey Meadow Harlow Paisley Everly Miley Indie
Reign Maeva Alora Nevaeh Destiny Ozzy Kairo Lando Kylo Bodhi Atlas Zion Koa
Amari Marley Rex Cruz Blaze River Storm Sunny Bear Wolf
""".split())

# CURATED — surnames excluded outright. The census file is a record of what
# people are actually called, so it contains surnames that are also slurs, and
# surnames that would land as a joke on a generated character. Real people carry
# these names; a randomly generated one should not.
EXCLUDED_SURNAMES = set("""
Coon Coons Mick Dick Nutt Putt Topp Bare Corn Snook Money Gross Boss Line Duck
Beer Gum Rude Butt Grim Slaughter Death Hooker Swank Wang Dong Fuchs Gay Pigg
Pratt Prick Bugger Bumgarner Crapo Dickerman Hoare Sexton
""".split())

# CURATED — the surnames and given names the prompts ban by name as LLM tics
# (BANNED_SURNAMES / BANNED_FEMALE / BANNED_MALE in src/scripts/name-bank.js).
# Several are real surnames and would otherwise be drawable, which would put the
# prompt in the position of offering a name it also forbids. Keep this in step
# with name-bank.js — tools/check-name-bank.js fails if the two drift apart.
BANNED_BY_PROMPTS = set("""
Voss Mercer Drake Kane Vale Crane Storm Dusk Mace Thorne Blackwood Ravenscroft
Nightshade Ashdown Wraith
Elara Seraphine Seraphina Celeste Isolde Nyx Lilith Eldra Sylvara Thalia
Kaelith Vespera
Cael Rael Zael Theron Oryn Kael Draven Zephyr Alaric Caden Brayden Aiden
""".split())

# Present in the US series but not part of the British naming canon — kept out
# of the "en" pools, still available under "us".
US_ONLY = set("""
Willie Mattie Hattie Beulah Lula Sallie Lizzie Nettie Addie Fannie Mamie Effie
Etta Della Leona Lottie Myrtle Georgia Virginia Dolores Delores Joann Debbie
Tammy Tiffany Crystal Brandy Kayla Alexis Madison Savannah Sydney Brittany
Courtney Shelby Kelsey Kaitlyn Katelyn Haley Jamie Stacy Stacey Tracy Dawn
Cassandra Erica Erika Jenna Kristin Kristen Kristina Lindsey Lindsay Destiny
Johnnie Grover Elmer Homer Luther Ira Leroy Clyde Floyd Wilbur Cletus Jessie
Billy Bobby Jimmy Ronnie Randy Dale Wayne Dustin Travis Chad Cody Shawn Corey
Cory Derrick Devin Trevor Todd Curtis Marvin Melvin Vernon Willard Charley
Jeffery Randall Gene Jay Don Steve Mike Tom Jim Joe Sam Ed Will Bill Ben
""".split())

# CURATED — the datasets in use do not cover Scotland or Wales (ONS is England
# and Wales combined, and Welsh names appear only thinly in it). These are the
# standard, widely attested Scottish and Welsh given names.
CURATED_GIVEN = {
    "sc": {
        "female": ["Eilidh", "Isla", "Kirsty", "Morag", "Mhairi", "Catriona", "Shona", "Fiona",
                   "Rhona", "Elspeth", "Ailsa", "Iona", "Maisie", "Bonnie",
                   "Lorna", "Marsaili", "Skye", "Islay", "Davina", "Jessie", "Effie",
                   "Innes", "Ishbel", "Mairi", "Nessa", "Brodie", "Greer"],
        "male": ["Callum", "Hamish", "Fraser", "Struan", "Lachlan", "Alasdair", "Ewan", "Angus",
                 "Dougal", "Duncan", "Murray", "Rory", "Gregor", "Malcolm", "Kenneth", "Ruaridh",
                 "Torquil", "Finlay", "Innes", "Blair", "Crawford", "Douglas", "Graeme", "Iain",
                 "Lorne", "Magnus", "Munro", "Niall", "Stuart", "Wallace"],
    },
    "wa": {
        "female": ["Ffion", "Seren", "Carys", "Bethan", "Eleri", "Nerys", "Angharad", "Cerys",
                   "Megan", "Gwen", "Rhiannon", "Olwen", "Myfanwy", "Sian", "Eira", "Delyth",
                   "Heulwen", "Mair", "Bronwen", "Gwenllian", "Tegan", "Lowri", "Nia", "Anwen",
                   "Elen", "Rhian", "Catrin", "Meinir", "Alys", "Glenys"],
        "male": ["Rhys", "Dylan", "Owain", "Ieuan", "Gethin", "Emrys", "Gareth", "Bryn", "Aled",
                 "Iestyn", "Geraint", "Huw", "Idris", "Meirion", "Trystan", "Dafydd",
                 "Llewelyn", "Morgan", "Osian", "Padrig", "Rhodri", "Sion", "Tomos", "Wyn",
                 "Elis", "Glyn"],
    },
}

# CURATED — continental Western European given names. The per-country datasets
# above cover the British Isles and the US only; these are the standard given
# names of each tradition, split into names that read as older ("classic") and
# names in current use, because a French character born in 1950 is a Jean-Pierre
# and one born in 2005 is a Gabriel.
CONTINENTAL_GIVEN = {
    "fr": {
        "female": {"classic": ["Brigitte", "Chantal", "Colette", "Danielle", "Françoise", "Ghislaine",
                               "Jacqueline", "Josette", "Madeleine", "Marguerite", "Martine", "Micheline",
                               "Monique", "Nathalie", "Odile", "Sylvie", "Véronique", "Yvette", "Simone", "Hélène"],
                   "current": ["Alice", "Ambre", "Camille", "Chloé", "Clémence", "Élodie", "Emma", "Inès",
                               "Jade", "Juliette", "Léa", "Louise", "Manon", "Margaux", "Mathilde", "Océane",
                               "Romy", "Sixtine", "Solène", "Zoé"]},
        "male": {"classic": ["Alain", "André", "Bernard", "Claude", "Didier", "Gérard", "Guy", "Henri",
                             "Jacques", "Jean-Pierre", "Marcel", "Michel", "Patrice", "Philippe", "Pierre",
                             "Raymond", "René", "Serge", "Thierry", "Yves"],
                 "current": ["Adrien", "Antoine", "Arthur", "Baptiste", "Clément", "Enzo", "Gabriel",
                             "Hugo", "Jules", "Léo", "Louis", "Lucas", "Maël", "Mathis", "Nolan",
                             "Quentin", "Raphaël", "Théo", "Timothée", "Valentin"]},
    },
    "de": {
        "female": {"classic": ["Angelika", "Bärbel", "Brigitte", "Christa", "Elke", "Gisela", "Gudrun",
                               "Hannelore", "Heike", "Helga", "Ilse", "Ingrid", "Karin", "Monika",
                               "Petra", "Renate", "Sabine", "Susanne", "Ursula", "Ute"],
                   "current": ["Amelie", "Clara", "Emilia", "Frieda", "Greta", "Hannah", "Johanna",
                               "Lena", "Leni", "Lina", "Marie", "Mathilda", "Mia", "Mila", "Nele",
                               "Paula", "Pia", "Romy", "Sophia", "Theresa"]},
        "male": {"classic": ["Bernd", "Dieter", "Detlef", "Eberhard", "Günter", "Hartmut", "Heinz",
                             "Helmut", "Horst", "Jürgen", "Klaus", "Manfred", "Norbert", "Otto",
                             "Rainer", "Reinhard", "Rolf", "Uwe", "Werner", "Wolfgang"],
                 "current": ["Anton", "Elias", "Emil", "Felix", "Finn", "Jonas", "Julian", "Leon",
                             "Lukas", "Matteo", "Maximilian", "Moritz", "Niklas", "Noah", "Oskar",
                             "Paul", "Theo", "Tobias", "Valentin", "Vincent"]},
    },
    "it": {
        "female": {"classic": ["Angela", "Antonella", "Carla", "Carmela", "Concetta", "Daniela",
                               "Franca", "Gabriella", "Gianna", "Giuseppina", "Loredana", "Lucia",
                               "Maria", "Marisa", "Patrizia", "Paola", "Rosaria", "Sandra", "Silvana", "Teresa"],
                   "current": ["Alessia", "Aurora", "Beatrice", "Bianca", "Chiara", "Emma", "Francesca",
                               "Ginevra", "Giorgia", "Giulia", "Ludovica", "Martina", "Matilde", "Noemi",
                               "Rebecca", "Sara", "Sofia", "Valentina", "Vittoria", "Elena"]},
        "male": {"classic": ["Alfredo", "Angelo", "Antonio", "Bruno", "Carmine", "Domenico", "Enzo",
                             "Franco", "Gennaro", "Gianni", "Giuseppe", "Luigi", "Mario", "Massimo",
                             "Paolo", "Pasquale", "Roberto", "Salvatore", "Sergio", "Vincenzo"],
                 "current": ["Alessandro", "Andrea", "Christian", "Davide", "Diego", "Edoardo",
                             "Federico", "Francesco", "Gabriele", "Giacomo", "Leonardo", "Lorenzo",
                             "Luca", "Marco", "Matteo", "Mattia", "Nicolò", "Riccardo", "Simone", "Tommaso"]},
    },
    "es": {
        "female": {"classic": ["Ana", "Antonia", "Carmen", "Concepción", "Dolores", "Encarnación",
                               "Francisca", "Isabel", "Josefa", "Juana", "Manuela", "Mercedes",
                               "Montserrat", "Pilar", "Purificación", "Remedios", "Rosario", "Soledad",
                               "Teresa", "Trinidad"],
                   "current": ["Alba", "Candela", "Carla", "Carlota", "Daniela", "Elena", "Emma",
                               "Inés", "Julia", "Lucía", "Marta", "Martina", "Noa", "Nuria", "Paula",
                               "Sara", "Sofía", "Valeria", "Vega", "Ximena"]},
        "male": {"classic": ["Alfonso", "Antonio", "Enrique", "Federico", "Fernando", "Francisco",
                             "Ignacio", "Jesús", "Joaquín", "Jorge", "José", "Juan", "Manuel",
                             "Miguel", "Pedro", "Rafael", "Ramón", "Ricardo", "Santiago", "Vicente"],
                 "current": ["Adrián", "Álvaro", "Daniel", "David", "Diego", "Gonzalo", "Héctor",
                             "Hugo", "Iker", "Javier", "Leo", "Lucas", "Marco", "Mario", "Martín",
                             "Mateo", "Pablo", "Pau", "Sergio", "Thiago"]},
    },
    "nl": {
        "female": {"classic": ["Annelies", "Antje", "Cornelia", "Dieuwertje", "Femke", "Geertje",
                               "Gerda", "Hendrika", "Ingrid", "Johanna", "Marieke", "Marijke",
                               "Nelleke", "Petra", "Riet", "Saskia", "Truus", "Willemien", "Wilma", "Yvonne"],
                   "current": ["Anouk", "Eva", "Fenna", "Julia", "Lieke", "Lotte", "Maud", "Mila",
                               "Milou", "Nienke", "Noor", "Nora", "Roos", "Sanne", "Sara", "Sofie",
                               "Tess", "Veerle", "Yara", "Zoë"]},
        "male": {"classic": ["Adriaan", "Arend", "Bram", "Cornelis", "Dirk", "Gerrit", "Hendrik",
                             "Jan", "Joop", "Kees", "Klaas", "Maarten", "Piet", "Pieter", "Rein",
                             "Rutger", "Teun", "Willem", "Wouter", "Joost"],
                 "current": ["Bram", "Daan", "Finn", "Gijs", "Jesse", "Lars", "Levi", "Luuk",
                             "Mees", "Milan", "Noah", "Ruben", "Sem", "Sten", "Thijs", "Thomas",
                             "Tijn", "Tim", "Sam", "Jayden"]},
    },
    "nordic": {
        "female": {"classic": ["Agnetha", "Astrid", "Birgitta", "Bodil", "Britt", "Dagny", "Gudrun",
                               "Gunhild", "Hildur", "Inger", "Ingrid", "Karin", "Kirsten", "Liv",
                               "Margit", "Ragnhild", "Sigrid", "Solveig", "Torild", "Ulla"],
                   "current": ["Alma", "Ebba", "Elin", "Ella", "Emma", "Frida", "Hedda", "Ida",
                               "Ingrid", "Linnea", "Maja", "Nora", "Saga", "Selma", "Sigrid",
                               "Signe", "Sofie", "Thea", "Tuva", "Vilde"]},
        "male": {"classic": ["Anders", "Bjørn", "Einar", "Erik", "Gunnar", "Halvor", "Håkon",
                             "Knut", "Lars", "Leif", "Magnus", "Nils", "Odd", "Ove", "Ragnar",
                             "Rune", "Sven", "Thorvald", "Torbjørn", "Ulf"],
                 "current": ["Aksel", "Alfred", "Elias", "Emil", "Filip", "Hugo", "Isak", "Jakob",
                             "Kasper", "Liam", "Lucas", "Magnus", "Mathias", "Noah", "Oliver",
                             "Oscar", "Sander", "Theodor", "Viktor", "William"]},
    },
}


# CURATED — Welsh and Scottish surnames that the US-frequency filters rank too
# low to reach, plus the distinctly Welsh patronymics.
CURATED_SURNAMES = {
    "wa": ["Llewellyn", "Meredith", "Probert", "Bowen", "Maddox", "Gwynne", "Vaughan", "Powell",
           "Pugh", "Prichard", "Bevan", "Havard", "Lloyd", "Trevithick", "Wynne", "Cadwallader"],
    "sc": ["Ogilvie", "Munro", "Buchanan", "Drummond", "Kerr", "Lamont", "Menzies", "Napier",
           "Rennie", "Sinclair", "Strachan", "Urquhart", "Blyth", "Galbraith", "Cargill", "Dalziel"],
}

ERA_YEARS = {
    # bucket        -> (birth-decade from, to) used against the SSA/CSO series
    "vintage": (1880, 1920),
    "midcentury": (1930, 1970),
    "modern": (1970, 2000),
}

# CURATED — the Irish series is the only dataset reaching British-Isles names of
# the 1970s-1990s, so it also feeds the "en" pools. These Irish-Gaelic names are
# held back from "en" so that England reads as England: they stay available
# through the "ie" region, which is always in the Anglo mix.
GAELIC_GIVEN = set("""
Aoife Niamh Ciara Sinead Siobhan Aisling Roisin Caoimhe Saoirse Grainne Aine
Clodagh Eimear Orla Orlaith Sorcha Sadhbh Eabha Ailbhe Cliona Fiadh Emer Mairead
Nuala Maeve Meabh Blathnaid Dearbhla Aoibhinn Alannah Deirdre Catriona Caitriona
Una Edel Majella Aideen Ashling Michaela Fionnuala Eithne Maire Noirin Treasa
Conor Cian Ciaran Oisin Cillian Killian Darragh Eoin Eoghan Niall Ronan Cathal
Cormac Padraig Padraic Diarmuid Dermot Tadhg Fionn Rian Ruairi Senan Odhran Oran
Lorcan Fintan Finbarr Donal Colm Declan Enda Daire Dara Fergal Gearoid Micheal
Seamus Turlough Donnacha Eamonn Eamon Emmet Shay Aodhan Caolan Ultan Brendan
""".split())

# CURATED — the Wikipedia surname tables interleave each name with an English
# gloss of its meaning or etymology; these are the glosses, not surnames.
WIKI_GLOSSES = set("""
England Scotland Wales Ireland Blacksmith Wainwright Miller Baker Fisher Fox
Bush Thatcher Brewer Mayor Smith Johnson Henderson French Greek Roman Count
Jordan Lombard Dutch Vintner John Latin Arabic Jesus Masurians Germanic Son
Cooper Forrester Hare Heilig Holy Barnard Baron Basil Condottieri Celtiberian
Celtic Blind Curly-hair Shepherd Weaver Taylor Carpenter Priest Bishop King
Young New Great Little Black White Brown Red Green Wolf Bear Hawk Stone Wood
Field Hill Church Mill Bridge Cross Rich Free Bold Wise Good Strong
Ploughman Shoemaking Fang Farmer Gardener Hunter Knight Woods Rivers
""".split())

# Surnames that appear in the Belgian and French tables because of recent
# migration. Real surnames, but not what "continental Western European" means
# for this bank's purpose.
NON_EUROPEAN_SURNAMES = set("""
Barry Benali Diallo Sow Nguyen Khan Ali Hassan Yilmaz Demir Kaya Ozturk Traore
""".split())


def top_by_era(series, sex, lo, hi, limit, exclude=()):
    """The `limit` most popular names in a decade-keyed series for one sex."""
    scored = []
    for (s, name), decades in series.items():
        if s != sex or name in exclude:
            continue
        total = sum(v for dec, v in decades.items() if lo <= int(dec) < hi)
        if total > 0:
            scored.append((total, name))
    scored.sort(reverse=True)
    return [n for _, n in scored[:limit]]


def build():
    ons = src.ons_2024()
    ssa = src.ssa_by_decade()
    irish = src.irish_by_decade()
    census = src.census_surnames()
    uk_attested = src.uk_surname_set()
    wiki = src.wiki_country_surnames()

    drop = NON_WESTERN | BABY_FASHION_ONLY | BANNED_BY_PROMPTS

    given = {}

    # ── en: England & Wales ────────────────────────────────────────────────
    # current  = ONS 2024, names given to 140+ children (~310 per sex)
    # modern   = Irish series 1970-1999, minus Gaelic-only names (below)
    # midcentury/vintage = US series for those decades, minus US-only forms
    en = {}
    for sex in ("female", "male"):
        def british(names):
            return [n for n in names if n not in US_ONLY and n not in GAELIC_GIVEN]

        # The Irish series is the only source covering British-Isles names of
        # these decades; the ONS series starts in 1996.
        irish_mid = top_by_era(irish, sex, 1960, 1980, 200, exclude=drop)
        irish_modern = top_by_era(irish, sex, 1970, 2000, 240, exclude=drop)
        us_mid = top_by_era(ssa, sex, 1930, 1970, 150, exclude=drop)
        en[sex] = {
            "vintage": british(top_by_era(ssa, sex, 1880, 1920, 150, exclude=drop)),
            "midcentury": sorted(set(british(us_mid) + british(irish_mid))),
            "modern": british(irish_modern),
            "current": [n for n, c in ons[sex] if c >= 140 and n not in drop],
        }
    given["en"] = en

    # ── ie: Ireland ────────────────────────────────────────────────────────
    ie = {}
    for sex in ("female", "male"):
        # The CSO series begins in 1964, so there is no vintage bucket here —
        # NameBank falls back to midcentury (and to the shared British pools,
        # which do reach the 1880s) for older characters.
        ie[sex] = {
            "midcentury": top_by_era(irish, sex, 1960, 1980, 100, exclude=drop),
            "modern": top_by_era(irish, sex, 1980, 2000, 120, exclude=drop),
            "current": top_by_era(irish, sex, 2000, 2020, 120, exclude=drop),
        }
    given["ie"] = ie

    # ── us: United States ──────────────────────────────────────────────────
    us = {}
    for sex in ("female", "male"):
        us[sex] = {
            "vintage": top_by_era(ssa, sex, 1880, 1920, 150, exclude=drop),
            "midcentury": top_by_era(ssa, sex, 1930, 1970, 150, exclude=drop),
            "modern": top_by_era(ssa, sex, 1970, 2000, 150, exclude=drop),
            "current": top_by_era(ssa, sex, 1990, 2010, 150, exclude=drop),
        }
    given["us"] = us

    # ── sc / wa: curated, era-agnostic ─────────────────────────────────────
    for region in ("sc", "wa"):
        given[region] = {
            sex: {"any": CURATED_GIVEN[region][sex]} for sex in ("female", "male")
        }

    # ── continental: curated, classic/current split ────────────────────────
    for region, data in CONTINENTAL_GIVEN.items():
        given[region] = {sex: dict(buckets) for sex, buckets in data.items()}

    # ── surnames ───────────────────────────────────────────────────────────
    def european(row, white_min, hisp_max, api_max):
        def num(v):
            try:
                return float(v)
            except ValueError:
                return None
        w, h, a = num(row["pctwhite"]), num(row["pcthispanic"]), num(row["pctapi"])
        return w is not None and w >= white_min and (h is None or h <= hisp_max) and (a is None or a <= api_max)

    # British: attested in the UK list AND with a European profile in the US
    # census. Two independent filters, so neither list's noise survives.
    british = []
    for row in census[:12000]:
        if row["name"] in uk_attested and european(row, 80, 6, 3):
            british.append(src.titlecase_surname(row["name"]))
    # Most common surnames of each home nation, which the US filters rank too
    # low or drop entirely (Smith and Jones are shared across ethnicities).
    wiki_clean = {}
    for country in ("England", "Scotland", "Wales", "Northern Ireland", "Ireland", "France",
                    "Germany", "Italy", "Spain", "Netherlands", "Denmark", "Norway", "Sweden",
                    "Belgium", "Austria", "Portugal", "Finland", "Poland"):
        # The tables interleave each surname with an English gloss of its
        # meaning ("Smith", "Son of a smith"); drop multi-word glosses and the
        # country names used as row labels.
        names = [n for n in wiki.get(country, [])
                 if " " not in n or n.startswith(("De ", "Van ", "Le ", "La "))]
        wiki_clean[country] = [n for n in names if n not in WIKI_GLOSSES]

    def prefixed(names, prefixes):
        return [n for n in names if n.startswith(prefixes)]

    scots_irish = prefixed(british, ("Mc", "Mac", "O'"))

    def dedupe_mac(names):
        """MacDonald and Macdonald are one surname; keep the Mac+capital form."""
        out = {}
        for n in names:
            key = n.lower()
            if key not in out or re.match(r"^Ma[c][A-Z]", n):
                out[key] = n
        return [n for n in out.values() if not re.fullmatch(r"Ma?c[A-Z]?", n)]

    surnames = {
        "en": sorted(set([n for n in british if n not in scots_irish] +
                         wiki_clean["England"] + ["Smith", "Jones", "Taylor", "Davies", "Clarke"])),
        "sc": sorted(dedupe_mac(set(wiki_clean["Scotland"] + CURATED_SURNAMES["sc"] +
                                    [n for n in scots_irish if n.startswith("Mac")]))),
        "wa": sorted(set(wiki_clean["Wales"] + CURATED_SURNAMES["wa"])),
        "ie": sorted(dedupe_mac(set(wiki_clean["Ireland"] + wiki_clean["Northern Ireland"] +
                                    [n for n in scots_irish if n.startswith(("Mc", "O'"))]))),
        "us": sorted({src.titlecase_surname(r["name"]) for r in census[:6000] if european(r, 75, 8, 4)}),
        "fr": sorted(set(wiki_clean["France"]) - NON_EUROPEAN_SURNAMES),
        "de": sorted(set(wiki_clean["Germany"] + wiki_clean["Austria"]) - NON_EUROPEAN_SURNAMES),
        "it": sorted(set(wiki_clean["Italy"]) - NON_EUROPEAN_SURNAMES),
        # Iberian: Spain and Portugal together.
        "es": sorted(set(wiki_clean["Spain"] + wiki_clean["Portugal"]) - NON_EUROPEAN_SURNAMES),
        # Belgium's most common surnames are predominantly Flemish.
        "nl": sorted(set(wiki_clean["Netherlands"] + wiki_clean["Belgium"]) - NON_EUROPEAN_SURNAMES),
        "nordic": sorted(set(wiki_clean["Denmark"] + wiki_clean["Norway"] + wiki_clean["Sweden"] +
                             wiki_clean["Finland"])),
    }
    # "us" is the broad pool; keep the British-flavoured names out of it so the
    # two regions stay distinguishable when both are in play.
    surnames["us"] = [n for n in surnames["us"] if n not in set(surnames["en"])]
    for region in surnames:
        surnames[region] = [n for n in surnames[region]
                            if n not in EXCLUDED_SURNAMES and n not in BANNED_BY_PROMPTS]

    return {"given": given, "surnames": surnames}


HEADER = """// GENERATED FILE — do not edit by hand. Run tools/build-name-bank.py.
//
// Real, attested Western names for the character generator's name pools. The
// app draws a name from here and hands it to the model, instead of asking the
// model to invent one: an LLM asked for "a name" returns the same few picks
// over and over, and invents fake-but-plausible names for traditions it knows
// thinly. See tools/name_sources.py for every dataset and its licence.
//
// given[region][sex][era] -> [names]   era: vintage | midcentury | modern |
//                                            current | classic | any
// surnames[region] -> [names]
//
// Sources: ONS baby names England & Wales 2024 (OGL v3); US SSA national given
// names 1880-2008 (public domain); CSO Ireland baby names 1964-2018; US Census
// 2010 surname file (public domain); Wikipedia per-country surname tables
// (CC BY-SA). Scottish, Welsh and continental European sets are curated —
// the datasets above do not cover them.
"""


def main():
    bank = build()
    counts = {}
    for region, sexes in bank["given"].items():
        counts[region] = sum(len(v) for sex in sexes.values() for v in sex.values())
    body = json.dumps(bank, ensure_ascii=False, indent=1, sort_keys=True)
    with open(OUT, "w", encoding="utf8") as fh:
        fh.write(HEADER)
        fh.write("\nconst NAME_BANK_DATA = ")
        fh.write(body)
        fh.write(";\n")
    sys.stderr.write("given names per region: %s\n" % counts)
    sys.stderr.write("surnames per region: %s\n" % {k: len(v) for k, v in bank["surnames"].items()})
    sys.stderr.write("wrote %s (%.0f KB)\n" % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()

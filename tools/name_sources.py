"""Shared download + parse helpers for the name-bank build.

Every name that ships in src/scripts/name-bank-data.js comes from one of these
public datasets. Nothing here runs in the app — this is a build-time tool. Run
tools/build-name-bank.py to regenerate the data file.

Sources
-------
ONS   Office for National Statistics, "Baby names in England and Wales", 2024
      release. Full ranked tables (Table 6) for boys and girls, ~6.6k/7.6k
      names with counts. Official statistics, OGL v3.
SSA   US Social Security Administration national given names 1880-2008, with
      per-year popularity percentages. Public domain; mirrored by
      hadley/data-baby-names because ssa.gov blocks scripted downloads.
CSO   Central Statistics Office Ireland, Irish baby names 1964-2018 with
      counts. Mirrored by 1danjordan/irishbabynames. Used for British-Isles
      names of the 1960s-1990s, which the ONS series (1996+) does not reach.
CEN   US Census Bureau 2010 surname file: 151,671 surnames with occurrence
      counts and a self-reported ethnicity breakdown per surname. Public
      domain; mirrored by fivethirtyeight/data. The ethnicity columns are what
      let us pick out surnames of European origin by data rather than by guess.
UKS   smashew/NameDatabases UK surname list. Used ONLY as a membership test
      ("is this surname attested in the UK?"), never as a source of names on
      its own — the raw list is polluted with non-UK surnames.
WIKI  Wikipedia, "List of most common surnames in European countries" — the
      per-country top-20/30 tables, so the genuinely most common British,
      Irish, Scottish, Welsh and continental surnames are present even when
      the US-frequency filters would drop them.
"""

import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from xml.etree import ElementTree as ET

CACHE = os.environ.get("NAME_BANK_CACHE", "/tmp/namebank-cache")
UA = "CardGenV2-namebank/1.0 (personal project; contact via repo)"

URLS = {
    "ssa.csv": "https://raw.githubusercontent.com/hadley/data-baby-names/master/baby-names.csv",
    "census-surnames.csv": "https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv",
    "irish-babynames.csv": "https://raw.githubusercontent.com/1danjordan/irishbabynames/master/data-raw/baby-names.csv",
    "uk-surnames.txt": "https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/surnames/uk.txt",
    "ons-girls-2024.xlsx": "https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/birthsdeathsandmarriages/livebirths/datasets/babynamesenglandandwalesbabynamesstatisticsgirls/2024/girlsnames2024.xlsx",
    "ons-boys-2024.xlsx": "https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/birthsdeathsandmarriages/livebirths/datasets/babynamesenglandandwalesbabynamesstatisticsboys/2024/boysnames2024.xlsx",
    "wiki-eu-surnames.json": "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_most_common_surnames_in_European_countries&prop=wikitext&format=json&formatversion=2",
}


def fetch(name):
    """Download a source file into the cache, or reuse the cached copy."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        return path
    req = urllib.request.Request(URLS[name], headers={"User-Agent": UA})
    sys.stderr.write("fetching %s\n" % name)
    with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as out:
        out.write(r.read())
    return path


# ── xlsx reading (stdlib only; openpyxl is not available everywhere) ────────
XL = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _xlsx_sheet_path(zf, title):
    wb = zf.read("xl/workbook.xml").decode("utf8")
    rels = zf.read("xl/_rels/workbook.xml.rels").decode("utf8")
    targets = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
    for name, rid in re.findall(r'<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"', wb):
        if name == title:
            return "xl/" + targets[rid].lstrip("/")
    raise KeyError(title)


def xlsx_rows(path, sheet_title):
    zf = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        for si in ET.fromstring(zf.read("xl/sharedStrings.xml")).iter(XL + "si"):
            shared.append("".join(t.text or "" for t in si.iter(XL + "t")))
    sheet = ET.fromstring(zf.read(_xlsx_sheet_path(zf, sheet_title)))
    for row in sheet.iter(XL + "row"):
        cells = []
        for c in row.iter(XL + "c"):
            v = c.find(XL + "v")
            inline = c.find(XL + "is")
            if c.get("t") == "s" and v is not None:
                cells.append(shared[int(v.text)])
            elif inline is not None:
                cells.append("".join(t.text or "" for t in inline.iter(XL + "t")))
            else:
                cells.append(v.text if v is not None else "")
        yield cells


# ── per-source parsers ─────────────────────────────────────────────────────
def ons_2024():
    """{'female': [(name, count)], 'male': [...]} from the ONS full tables."""
    out = {}
    for sex, key in (("female", "ons-girls-2024.xlsx"), ("male", "ons-boys-2024.xlsx")):
        rows = []
        for r in xlsx_rows(fetch(key), "Table_6"):
            if len(r) >= 3 and r[1] and r[2]:
                try:
                    rows.append((r[1].strip(), int(float(r[2]))))
                except ValueError:
                    pass
        out[sex] = rows
    return out


def ssa_by_decade():
    """{(sex, name): {decade: summed percent}} for US 1880-2008."""
    agg = {}
    with open(fetch("ssa.csv"), newline="") as fh:
        for row in csv.DictReader(fh):
            sex = "female" if row["sex"] == "girl" else "male"
            dec = (int(row["year"]) // 10) * 10
            key = (sex, row["name"])
            agg.setdefault(key, {})
            agg[key][dec] = agg[key].get(dec, 0.0) + float(row["percent"])
    return agg


def irish_by_decade():
    """{(sex, name): {decade: summed count}} for Ireland 1964-2018."""
    agg = {}
    with open(fetch("irish-babynames.csv"), newline="") as fh:
        for row in csv.DictReader(fh):
            if row["n"] in ("NA", ""):
                continue
            dec = (int(row["year"]) // 10) * 10
            key = (row["sex"], row["name"])
            agg.setdefault(key, {})
            agg[key][dec] = agg[key].get(dec, 0) + int(float(row["n"]))
    return agg


def census_surnames():
    """[{name, rank, count, pctwhite, ...}] in rank order, minus the catch-all row."""
    with open(fetch("census-surnames.csv"), newline="") as fh:
        return [r for r in csv.DictReader(fh) if r["name"] != "ALL OTHER NAMES"]


def uk_surname_set():
    with open(fetch("uk-surnames.txt"), encoding="utf8", errors="ignore") as fh:
        return {line.strip().upper() for line in fh if line.strip()}


def wiki_country_surnames():
    """{country: [surname]} from the Wikipedia per-country tables."""
    raw = json.load(open(fetch("wiki-eu-surnames.json")))["parse"]["wikitext"]
    parts = re.split(r"^==+\s*([^=\n]+?)\s*==+\s*$", raw, flags=re.M)
    out = {}
    for i in range(1, len(parts), 2):
        country, body = parts[i].strip(), parts[i + 1]
        names = []
        for line in body.splitlines():
            if not line.strip().startswith("|"):
                continue
            for cell in line.strip().lstrip("|").split("||"):
                cell = re.sub(r"\[\[([^\]|]+)\|?[^\]]*\]\]", r"\1", cell)
                cell = re.sub(r"<[^>]+>|\{\{[^}]*\}\}", "", cell)
                cell = cell.split("(")[0].strip().strip("'\"")
                if re.fullmatch(r"[A-Z][A-Za-zÀ-ÿ'’\- ]{2,22}", cell) and cell not in names:
                    names.append(cell)
        out[country] = names
    return out


# The census file stores Irish surnames without the apostrophe (ONEILL, not
# O'NEILL). Restoring it by rule would mangle Owens, Osborne and Oakley, so the
# forms that need it are listed explicitly.
# Only some Mac- surnames take an internal capital. Applying it by rule turned
# Mace into "MacE" and Mackie into "MacKie", so the forms that take one are
# listed instead. Anything not listed keeps plain capitalisation: Machado,
# Mackey, Macklin, Macias, Macon.
MAC_CAPITALISED = {name.lower().capitalize(): name for name in """
MacDonald MacKenzie MacLeod MacMillan MacPherson MacGregor MacIntyre MacLean
MacFarlane MacArthur MacNeil MacRae MacDougall MacInnes MacLachlan MacCallum
MacKinnon MacAskill MacLennan MacIver MacEwan MacLaren MacNab MacQueen
MacTaggart MacVicar MacWilliam MacAlister MacDuff MacGill MacGowan MacKay
""".split()}

O_APOSTROPHE = {
    "ONEILL": "O'Neill", "OBRIEN": "O'Brien", "OCONNOR": "O'Connor",
    "ODONNELL": "O'Donnell", "OSULLIVAN": "O'Sullivan", "OLEARY": "O'Leary",
    "OROURKE": "O'Rourke", "OMALLEY": "O'Malley", "OKEEFE": "O'Keefe",
    "OCONNELL": "O'Connell", "ODONOVAN": "O'Donovan", "OSHEA": "O'Shea",
    "OGRADY": "O'Grady", "OHARA": "O'Hara", "OBYRNE": "O'Byrne",
    "OCALLAGHAN": "O'Callaghan", "ODWYER": "O'Dwyer", "OFARRELL": "O'Farrell",
    "OMEARA": "O'Meara", "OREILLY": "O'Reilly", "ORIORDAN": "O'Riordan",
    "OTOOLE": "O'Toole", "OGORMAN": "O'Gorman", "OHALLORAN": "O'Halloran",
    "OMAHONEY": "O'Mahoney", "OLOUGHLIN": "O'Loughlin", "OKELLY": "O'Kelly",
    "ODAY": "O'Day", "ONEIL": "O'Neil", "OBOYLE": "O'Boyle",
}


def titlecase_surname(name):
    """SMITH -> Smith, MCDONALD -> McDonald, ONEILL -> O'Neill."""
    upper = name.strip().upper()
    if upper in O_APOSTROPHE:
        return O_APOSTROPHE[upper]
    parts = re.split(r"([ '\-])", name.strip().lower())
    out = "".join(p if p in " '-" else p.capitalize() for p in parts)
    out = re.sub(r"^Mc([a-z])", lambda m: "Mc" + m.group(1).upper(), out)
    if out in MAC_CAPITALISED:
        out = MAC_CAPITALISED[out]
    out = re.sub(r"^O'([a-z])", lambda m: "O'" + m.group(1).upper(), out)
    return out

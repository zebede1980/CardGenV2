# tools/

Build-time scripts. Nothing here ships to the browser or runs at runtime.

## build-name-bank.py — the character name bank

Regenerates `src/scripts/name-bank-data.js`, the pool of real Western names the
character generator draws from.

```bash
python3 tools/build-name-bank.py
```

Source files are downloaded on first run and cached in `/tmp/namebank-cache`
(override with `NAME_BANK_CACHE`). Only the standard library is needed — the ONS
workbooks are read by unzipping them and parsing the sheet XML directly, because
`openpyxl` is not available everywhere.

### Why the bank exists

The app used to ask the model to invent every character name. That produced two
complaints, both inherent to asking an LLM for a name:

- **The same name kept coming back.** Mode collapse: asked for "a name" a model
  returns its highest-probability answer, and no amount of prompt pressure
  ("be creative", "avoid your default pick", a ban list of recent names) reliably
  moves it off that answer.
- **Invented names.** Asked for a tradition it knows thinly, a model produces
  something with the right *shape* for that culture but which is not a name
  anyone has.

Drawing from real, frequency-ranked published data fixes both: the randomness is
the app's own, and every name is attested. The model is still told which names to
choose between, because only it knows the character's gender and background from
the concept.

### Sources

| Tag | Dataset | Used for |
| --- | --- | --- |
| ONS | [Baby names in England and Wales, 2024](https://www.ons.gov.uk/peoplepopulationandcommunity/birthsdeathsandmarriages/livebirths/bulletins/babynamesenglandandwales/latest) — full ranked tables, ~7k names with counts. Open Government Licence v3. | Current English/Welsh given names |
| SSA | US Social Security Administration national given names 1880–2008 with per-year popularity. Public domain, via the [hadley/data-baby-names](https://github.com/hadley/data-baby-names) mirror (ssa.gov blocks scripted downloads). | Era buckets back to the 1880s |
| CSO | Central Statistics Office Ireland baby names 1964–2018, via the [1danjordan/irishbabynames](https://github.com/1danjordan/irishbabynames) mirror. | British-Isles names of the 1960s–1990s, which the ONS series (1996+) does not reach |
| CEN | US Census Bureau [2010 surname file](https://www.census.gov/topics/population/genealogy/data/2010_surnames.html) — 151,671 surnames with counts and a self-reported ethnicity breakdown. Public domain, via the [fivethirtyeight/data](https://github.com/fivethirtyeight/data) mirror. | Surname frequency, and picking out surnames of European origin by data rather than by guess |
| UKS | [smashew/NameDatabases](https://github.com/smashew/NameDatabases) UK surname list. | A membership test only — "is this surname attested in the UK?". The raw list is polluted with non-UK surnames and is never a source of names on its own |
| WIKI | Wikipedia, [List of most common surnames in European countries](https://en.wikipedia.org/wiki/List_of_most_common_surnames_in_European_countries). CC BY-SA. | The genuinely most common British, Irish, Scottish, Welsh and continental surnames, which the US-frequency filters rank too low or drop |

British surnames pass **two independent filters** — attested in the UK list *and*
carrying a European profile in the US census — so neither list's noise survives
into the output.

### What is curated rather than derived

Everything hand-written in the build script is marked `CURATED` and is there
because no dataset above covers it:

- Scottish and Welsh given names (ONS is England and Wales combined, and Welsh
  names appear only thinly in it).
- Continental Western European given names, split classic/current.
- Welsh and Scottish surnames the US-frequency filters rank too low to reach.
- The exclusion lists: Irish-Gaelic given names held back from the English pool,
  names of non-European origin excluded from the Western pools, Wikipedia
  etymology glosses, and the list of names LLMs overuse.

### Adding or changing names

Edit the curated lists or the filter thresholds in `build-name-bank.py`, rerun
it, and commit the regenerated `src/scripts/name-bank-data.js`. Do not edit the
generated file by hand — the next build overwrites it.

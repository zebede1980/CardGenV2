#!/usr/bin/env node
// Sanity checks for the generated name bank. Run after tools/build-name-bank.py:
//
//   node tools/check-name-bank.js
//
// These are the invariants the character generator relies on. A rebuild pulls
// from live sources (Wikipedia is edited; ONS publishes a new year), so the
// output can shift without the build script changing — this is what catches it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPTS = path.join(__dirname, "..", "src", "scripts");
const store = {};
const ctx = {
  console,
  localStorage: {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};
vm.createContext(ctx);
vm.runInContext(
  ["name-bank-data.js", "name-bank.js"].map((f) => fs.readFileSync(path.join(SCRIPTS, f), "utf8")).join("\n")
    + "\nthis.NameBank = NameBank; this.DATA = NAME_BANK_DATA;",
  ctx,
  { filename: "name-bank" },
);
const { NameBank, DATA } = ctx;

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("pool sizes");
const ANGLO = ["en", "us", "ie", "sc", "wa"];
const ALL = [...ANGLO, "fr", "de", "it", "es", "nl", "nordic"];
ALL.forEach((region) => {
  const given = DATA.given[region];
  const surnames = DATA.surnames[region] || [];
  check(`${region}: has both sexes`, given && given.female && given.male);
  check(`${region}: surnames >= 20`, surnames.length >= 20, `${surnames.length}`);
  ["female", "male"].forEach((sex) => {
    const total = Object.values(given[sex] || {}).reduce((n, l) => n + l.length, 0);
    check(`${region}.${sex}: given >= 25`, total >= 25, `${total}`);
  });
});

console.log("\ndata hygiene");
const everyGiven = [];
Object.values(DATA.given).forEach((sexes) => Object.values(sexes).forEach(
  (byEra) => Object.values(byEra).forEach((list) => everyGiven.push(...list))));
const everySurname = Object.values(DATA.surnames).flat();
// Accented capitals count: Álvaro and Élodie are correctly spelled names.
const shaped = (n) => typeof n === "string" && /^[A-ZÀ-ÞŠŽ][A-Za-zÀ-ÿ'’\- ]*$/.test(n) && n.length >= 2 && n.length <= 24;
check("every given name is plausibly shaped", everyGiven.every(shaped),
  everyGiven.filter((n) => !shaped(n)).slice(0, 5).join(", "));
check("every surname is plausibly shaped", everySurname.every(shaped),
  everySurname.filter((n) => !shaped(n)).slice(0, 5).join(", "));

// A surname must not appear twice in the same region's list; duplicates skew the
// draw towards them.
Object.entries(DATA.surnames).forEach(([region, list]) => {
  check(`${region}: no duplicate surnames`, new Set(list).size === list.length,
    `${list.length - new Set(list).size} duplicates`);
});

// Names the prompts ban must never be drawable, or the prompt contradicts
// itself ("use Luna Whitworth" / "never use Luna").
const banned = NameBank.BANNED_NAMES_BLOCK.toLowerCase();
const bannedNames = banned.match(/[a-z]{3,}/g) || [];
const bannedSet = new Set(bannedNames);
const drawableBanned = [...new Set([...everyGiven, ...everySurname])]
  .filter((n) => bannedSet.has(n.toLowerCase()))
  // The ban block is prose, so ordinary words in it are false positives.
  .filter((n) => !["names", "female", "male", "surnames", "any", "invented", "two", "syllable",
    "name", "ending", "unless", "the", "concept", "explicitly", "high", "fantasy", "not", "use"].includes(n.toLowerCase()));
check("no banned name is drawable", drawableBanned.length === 0, drawableBanned.join(", "));

console.log("\ndraw behaviour");
["anglo", "western"].forEach((origin) => {
  NameBank.clearHistory();
  const { names } = NameBank.draw({ origin, count: 100 });
  check(`${origin}: 100 draws all succeed`, names.length === 100, `${names.length}`);
  check(`${origin}: 100 draws all distinct`, new Set(names).size === names.length,
    `${names.length - new Set(names).size} repeats`);
  check(`${origin}: every draw is "First Last"`, names.every((n) => /^\S+.* \S+$/.test(n)));
});

Object.keys(NameBank.PERIOD_ERAS).forEach((period) => {
  NameBank.clearHistory();
  ["female", "male", "other"].forEach((gender) => {
    const { names } = NameBank.draw({ origin: "western", period, gender, count: 10 });
    check(`${period}/${gender}: fills 10`, names.length === 10, `${names.length}`);
  });
});

NameBank.clearHistory();
const list = NameBank.shortlist({ origin: "western", per: 6 });
check("shortlist returns 6 female + 6 male", list.female.length === 6 && list.male.length === 6);
check("shortlist entries are all distinct",
  new Set([...list.female, ...list.male, ...list.neutral]).size === list.female.length + list.male.length + list.neutral.length);
check("shortlist does not record to history", NameBank.recentNames().length === 0,
  `${NameBank.recentNames().length} recorded`);

console.log("\ncapability reporting");
check("bank declines eras it has no data for",
  !NameBank.supportsPeriod("medieval") && !NameBank.supportsPeriod("ancient")
  && !NameBank.supportsPeriod("far-future") && !NameBank.supportsPeriod("fantasy"));
check("bank claims the eras it does cover",
  ["any", "victorian", "early-20th", "mid-20th", "contemporary", "near-future"].every(NameBank.supportsPeriod));
check("bank declines non-human name styles",
  ["demon", "alien", "elf", "fae", "angel"].every((t) => !NameBank.supportsType(t)));
check("bank accepts human-named types",
  ["any", "vampire", "werewolf", "ghost", "undead", "witch", "anthropomorphic"].every(NameBank.supportsType));

console.log("\nhistory");
NameBank.clearHistory();
NameBank.recordNames(["Alfie Hodgson"]);
check("records the full name", NameBank.recentNames().includes("Alfie Hodgson"));
const after = NameBank.draw({ origin: "western", count: 200 }).names;
check("a recorded first name is not reused", !after.some((n) => n.split(" ")[0] === "Alfie"));
check("a recorded surname is not reused", !after.some((n) => n.endsWith(" Hodgson")));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);

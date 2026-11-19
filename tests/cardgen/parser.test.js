// Card parser checks (character-generator.js), no browser needed:  node tests/cardgen/parser.test.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.resolve(__dirname, "..", "..");
global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(root, "src/scripts/character-generator.js"), "utf8"), { filename: "character-generator.js" });
const g = window.characterGenerator;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (detail ? "\n     " + detail : "")); } };

const body = (intro) => `${intro}

## The Setting

**Time & Place:** The coast, 1923. The keeper says the lamp never goes out.

## Personality & Drives

The place is patient. The fog comes in at dusk.

# The Roleplay's Setup

The storm has cut the road. The player arrives at the door.

# First Message

"The name's Silas," the keeper says. The door swings open. Will you come in?`;

// 1. Scenario title starting "The", plain header
let c = g.parseCharacterData(body(`# The Haunted Lighthouse

The Haunted Lighthouse is a derelict tower on a spit of rock.`));
check("scenario title read from a plain header", c.name === "The Haunted Lighthouse", c.name);
check("scenario keeps its bare header", c.description.startsWith("# The Haunted Lighthouse\n"), c.description.slice(0, 60));
check("name not taken from dialogue", c.name !== "Silas");
check('"The" is not replaced with {{char}}', !/\{\{char\}\} (storm|keeper|place|fog|door|coast)/.test(c.personality + c.scenario + c.firstMessage + c.description),
  (c.personality + c.scenario).slice(0, 200));
check("title is replaced after the intro", !c.personality.includes("The Haunted Lighthouse") && c.description.split("\n")[2].includes("The Haunted Lighthouse"));

// 2. Group "The Red Cobras's Profile"
c = g.parseCharacterData(body(`# The Red Cobras' Profile

The Red Cobras are a street gang. The Red Cobras run the docks.`).replace("The place is patient.", "The Red Cobras never forgive. The rule is simple."));
check("group name from a possessive header", c.name === "The Red Cobras", c.name);
check("group: full name replaced in personality", c.personality.includes("{{char}} never forgive"), c.personality);
check("group: other 'The' left alone", c.personality.includes("The rule is simple") && c.scenario.includes("The storm has cut"), c.personality);
check("group keeps the 's Profile header", c.description.startsWith("# The Red Cobras's Profile"), c.description.slice(0, 40));

// 3. Ordinary single card: first name still replaced
c = g.parseCharacterData(body(`# Mira Okafor's Profile

Mira Okafor is a lighthouse keeper.`).replace("The place is patient.", "Mira keeps the lamp. Mira Okafor trusts no one."));
check("single: name", c.name === "Mira Okafor", c.name);
check("single: first name and full name replaced", c.personality.includes("{{char}} keeps the lamp. {{char}} trusts no one."), c.personality);
check("single: intro keeps the real name", c.description.includes("Mira Okafor is a lighthouse keeper."));

// 4. First name that is an ordinary word
c = g.parseCharacterData(body(`# Will Turner's Profile

Will Turner is a blacksmith.`).replace("The place is patient.", "Will Turner works late."));
check("word-name: full name replaced", c.personality.includes("{{char}} works late."), c.personality);
check('word-name: "Will you come in?" untouched', c.firstMessage.includes("Will you come in?"), c.firstMessage);

// 5. Placeholder header (DeepSeek), apostrophe name from the first sentence
c = g.parseCharacterData(body(`# {{char}}'s Profile

Deirdre O'Halloran is a publican.`));
check("placeholder header: name from the sentence", c.name === "Deirdre O'Halloran", c.name);
c = g.parseCharacterData(body(`# Deirdre O'Halloran's Profile

Deirdre O'Halloran is a publican.`));
check("apostrophe name from the header", c.name === "Deirdre O'Halloran", c.name);

// 6. First person
c = g.parseCharacterData(`# {{char}}'s Profile

The name's Silas Vane. I keep the light.

## My Personality & What Drives Me

I am patient.

# The Roleplay's Setup

A storm.

# First Message

"The name's Nobody," I lie.`);
check("first person: name from the description, not the dialogue", c.name === "Silas Vane", c.name);

// 7. No intro paragraph: header must survive
c = g.parseCharacterData(`# Mira Okafor's Profile

## Personality & Drives

Mira waits.

# The Roleplay's Setup

x

# First Message

y`);
check("no intro: header not rewritten", c.description.startsWith("# Mira Okafor's Profile"), c.description);

// 8. No header at all, "The…" opening: nothing invented from dialogue
c = g.parseCharacterData(`The old mill is quiet.

## Personality & Drives

It waits.

# The Roleplay's Setup

x

# First Message

"The name's Silas," he says.`);
check("no name found: falls back to {{char}}, not dialogue", c.name === "{{char}}", c.name);

console.log(failed ? `${failed} FAILED` : "all parser checks passed");
process.exitCode = failed ? 1 : 0;

// Character Generator Module
class CharacterGenerator {
  constructor() {
    this.apiHandler = null; // Will be set lazily
    this.rawCharacterData = "";
    this.parsedCharacter = null;
  }

  // Lazy getter for apiHandler to avoid circular dependency
  get apiHandlerInstance() {
    if (!this.apiHandler) {
      this.apiHandler = window.apiHandler;
    }
    return this.apiHandler;
  }

  async generateCharacter(concept, characterName, onStream = null, pov = "third", lorebook = null, cardType = "single") {
    try {
      this.rawCharacterData = await this.apiHandlerInstance.generateCharacter(
        concept,
        characterName,
        onStream,
        pov,
        lorebook,
        cardType,
      );
      this.parsedCharacter = this.parseCharacterData(this.rawCharacterData, cardType, characterName);
      return this.parsedCharacter;
    } catch (error) {
      console.error("Error generating character:", error);
      throw error;
    }
  }

  // The character's name, from "# Name's Profile" or else the opening sentence.
  // Returns "" when none can be found.
  //
  // The prompt says to write the real name only in that header and the first
  // sentence, and {{char}} everywhere else. Some models (DeepSeek V4 Pro,
  // 2026-11-02) put {{char}} in the header too, so a placeholder there is
  // skipped and the first sentence ("Deirdre O'Halloran is a…") is used.
  // Names may contain apostrophes, hyphens, accents and particles: O'Halloran,
  // Smith-Jones, Siobhán, van der Berg.
  extractCharacterName(rawData) {
    const text = rawData || "";
    const isPlaceholder = (name) => !name || /\{\{|\}\}|\[|\]|^char$|character name/i.test(name);
    const clean = (name) => name.replace(/^[*_"“”\s]+|[*_"“”\s]+$/g, "").trim();

    const header = text.match(CharacterGenerator.PROFILE_HEADER_RE);
    if (header && !isPlaceholder(clean(header[1]))) return clean(header[1]);

    // Scenario cards are headed "# The Haunted Lighthouse", with no
    // "'s Profile". Take the card's opening heading as the title. Without
    // this, any title starting "The" fell through to the sentence scans below,
    // which reject "The…" and then took a name out of the dialogue.
    const title = this._plainTitle(text);
    if (title && !isPlaceholder(clean(title))) return clean(title);

    const word = "\\p{Lu}[\\p{L}\\p{M}'’-]*";
    const particle = "(?:van|von|de|del|della|der|den|di|da|du|la|le|bin|ibn|al|el|of)";
    const name = `${word}(?:\\s+(?:${particle}\\s+)*${word}){0,4}`;

    // Both sentence scans read the description only (before ## Personality),
    // so a later "She is…" or a line of dialogue can't be taken for a name.
    const description = text.split(/^##\s*(?:My\s+)?Personality/im)[0];

    // First person: "The name's Name"
    const firstPerson = description.match(new RegExp(`The name['’]s\\s+(${name})`, "u"));
    if (firstPerson) return firstPerson[1].trim();

    // Third person: "Name is…" opening a line.
    const notName = "(?:He|She|They|It|This|That|The|There|Her|His|Their|A|An|What|Who)\\b";
    const thirdPerson = description.match(
      new RegExp(`^[*_\\s]*(?!${notName})(${name})[*_]*\\s+(?:is|was)\\b`, "mu"),
    );
    if (thirdPerson) return thirdPerson[1].trim();

    return "";
  }

  // The card's opening "# Heading" when it is a bare title rather than
  // "# Name's Profile" or one of the template's own sections. "" otherwise.
  _plainTitle(rawData) {
    const first = (rawData || "").match(/^#(?!#)\s*(.+?)\s*$/m);
    if (!first) return "";
    const heading = first[1].replace(/^[*_\s]+|[*_\s]+$/g, "");
    if (CharacterGenerator.PROFILE_HEADER_RE.test(`# ${heading}`)) return "";
    if (/^(?:The Roleplay|First Message|(?:My\s+)?Personality)/i.test(heading)) return "";
    // It has to open the card: a "##" section before it means it isn't the title.
    const firstSection = rawData.search(/^##/m);
    if (firstSection !== -1 && firstSection < first.index) return "";
    return heading;
  }

  /**
   * 🎭 A persona reply (api-character.js _buildPersonaPrompt): "# Name", an
   * intro and **Age:** / **Gender:** / **Appearance:** / **Background:** lines,
   * then "## Personality" and "## Voice". Age, gender and voice go to
   * character.persona; the card has no scenario or first message. The real
   * name stays in the text (no {{char}}), and any macro the model wrote anyway
   * becomes the name.
   */
  parsePersonaData(rawData, nameHint = "") {
    const text = String(rawData || "").replace(/\r\n/g, "\n").trim();
    const section = (title) => {
      const m = text.match(new RegExp(`^##\\s*${title}\\s*$([\\s\\S]*?)(?=^##?\\s|(?![\\s\\S]))`, "im"));
      return m ? m[1].trim() : "";
    };
    const field = (label, from) => {
      const m = from.match(new RegExp(`^\\s*\\**${label}:\\**\\s*(.+)$`, "im"));
      return m ? m[1].replace(/\*+/g, "").trim() : "";
    };

    const heading = text.match(/^#(?!#)\s*(.+?)\s*$/m);
    const headingName = heading ? heading[1].replace(/[*_]/g, "").replace(/['’]s\s+(?:Profile|Persona)$/i, "").trim() : "";
    const isPlaceholder = (n) => !n || /\{\{|\}\}|\[|\]|^name$/i.test(n);
    let name = (nameHint || "").trim();
    if (!name) name = isPlaceholder(headingName) ? this.extractCharacterName(text) : headingName;
    if (!name) name = "Unnamed Persona";
    const ownName = (s) => (s || "").replace(/\{\{\s*(?:char|user)\s*\}\}/gi, name);

    const firstSection = text.search(/^##\s/m);
    let top = (firstSection === -1 ? text : text.slice(0, firstSection))
      .replace(/^#(?!#)[^\n]*\n*/, "").trim();
    const age = field("Age", top);
    const gender = field("Gender", top);
    top = top.split("\n").filter((line) => !/^\s*\**(?:Age|Gender):/i.test(line)).join("\n")
      .replace(/\n{3,}/g, "\n\n").trim();

    if (typeof this.apiHandlerInstance?.recordGeneratedName === "function") {
      this.apiHandlerInstance.recordGeneratedName(name);
    }
    return {
      name,
      description: ownName(`# ${name}\n\n${top}`),
      personality: ownName(section("Personality")),
      scenario: "",
      firstMessage: "",
      mesExample: "",
      cardType: "persona",
      persona: { age: age.slice(0, 40), gender: gender.slice(0, 40), voice: ownName(section("Voice")).slice(0, 600) },
    };
  }

  // Parse character data using simple string splitting based on template
  parseCharacterData(rawData, cardType = "single", nameHint = "") {
    if (cardType === "persona") return this.parsePersonaData(rawData, nameHint);
    const character = {
      name: "",
      description: "",
      personality: "",
      scenario: "",
      firstMessage: "",
      mesExample: "",
    };

    character.name = this.extractCharacterName(rawData);

    // Fallback if name is still missing but we have content
    if (!character.name) {
      console.warn("Could not extract character name. Using default.");
      character.name = "{{char}}";
    }

    // Feed the name into the shared cross-generation history so future
    // auto-generated and picker names avoid repeating it.
    if (this.apiHandlerInstance && typeof this.apiHandlerInstance.recordGeneratedName === "function") {
      this.apiHandlerInstance.recordGeneratedName(character.name);
    }

    // Extract description section (everything from start or # Profile to ## Personality)
    // More robust regex that doesn't strictly require the # Profile header
    const descriptionMatch = rawData.match(
      /(?:#\s*[^#]+?'s Profile[\s\S]*?)?([\s\S]*?)(?=##\s*(?:My\s+)?Personality)/i,
    );
    if (descriptionMatch) {
      // If we captured the header in the group, it's fine. If not, we prepend it if we have a name.
      let descContent = descriptionMatch[1].trim();

      // Clean up potential leading newlines or markdown artifacts
      descContent = descContent.replace(/^#\s*[^#\n]+\n+/, "").trim();

      if (character.name && character.name !== "Unknown Character") {
        // A scenario card keeps its bare "# Title" header.
        const heading = this._plainTitle(rawData) ? character.name : `${character.name}'s Profile`;
        character.description = `# ${heading}\n\n${descContent}`;
      } else {
        character.description = descContent;
      }
    }

    // Extract personality section (include the title)
    const personalityMatch = rawData.match(
      /(##\s*(?:My\s+)?Personality[\s\S]*?)(?=#\s*The Roleplay|$)/i,
    );
    if (personalityMatch) {
      character.personality = personalityMatch[1].trim();
    }

    // Extract scenario section (include the title)
    const scenarioMatch = rawData.match(
      /(#\s*The Roleplay's Setup[\s\S]*?)(?=#\s*First Message|$)/i,
    );
    if (scenarioMatch) {
      character.scenario = scenarioMatch[1].trim();
    } else {
      // Create a default scenario if not found
      character.scenario = `A roleplay featuring ${character.name}. The setting and circumstances evolve naturally through interaction between ${character.name} and {{user}}.`;
    }

    // Extract first message (no title, just the content)
    const firstMessageMatch = rawData.match(
      /#\s*First Message\s*\n\n([\s\S]+?)$/i,
    );
    if (firstMessageMatch) {
      character.firstMessage = firstMessageMatch[1].trim();
    } else {
      // Try with single newline
      const firstMessageMatchAlt = rawData.match(
        /#\s*First Message\s*\n([\s\S]+?)$/i,
      );
      if (firstMessageMatchAlt) {
        character.firstMessage = firstMessageMatchAlt[1].trim();
      }
    }

    // Safety check: forcibly replace the character's name with {{char}} in most fields
    // to guarantee engine compatibility if the AI forgot the rule.
    if (character.name && character.name !== "{{char}}" && character.name.toLowerCase() !== "unknown character") {
      try {
        const escapedFullName = character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fullRegex = new RegExp(`\\b${escapedFullName}\\b`, 'g');
        
        // The first name on its own is replaced too ("Mira" for "Mira Okafor"),
        // unless it is also an ordinary word. "The Red Cobras" used to turn
        // every "The" in the card into {{char}}, and "Will Turner" every
        // sentence that began "Will…".
        let firstRegex = null;
        const nameParts = character.name.split(" ");
        if (
          nameParts.length > 1 && nameParts[0].length > 2 &&
          !CharacterGenerator.ORDINARY_WORDS.has(nameParts[0].toLowerCase().replace(/[^a-z]/g, ""))
        ) {
          const escapedFirstName = nameParts[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          firstRegex = new RegExp(`\\b${escapedFirstName}\\b`, 'g');
        }

        const enforceMacro = (text) => {
          if (!text) return text;
          let result = text.replace(fullRegex, '{{char}}');
          if (firstRegex) result = result.replace(firstRegex, '{{char}}');
          return result;
        };

        if (character.description) {
          const lines = character.description.split('\n');
          // The name is allowed in the header and the intro paragraph, so
          // enforcement starts on the line after the intro. With no intro it
          // starts after the header (it used to start at line 0 and rewrite
          // the header itself).
          const introIndex = lines.findIndex(
            (line) => line.trim() !== '' && !line.startsWith('#') && !line.startsWith('**'),
          );
          const headerIndex = lines.findIndex((line) => line.startsWith('#'));
          const safeStartIndex = (introIndex !== -1 ? introIndex : headerIndex) + 1;

          for (let i = safeStartIndex; i < lines.length; i++) {
            lines[i] = enforceMacro(lines[i]);
          }
          character.description = lines.join('\n');
        }

        character.personality = enforceMacro(character.personality);
        character.scenario = enforceMacro(character.scenario);
        character.firstMessage = enforceMacro(character.firstMessage);
        if (character.mesExample) character.mesExample = enforceMacro(character.mesExample);
      } catch (e) {
        console.warn("Failed to apply {{char}} macro enforcement:", e);
      }
    }

    return character;
  }

  // Format character for display
  formatCharacterForDisplay(character) {
    return `
            <div class="character-section">
                <strong>Name:</strong> ${character.name}
            </div>
            <div class="character-section">
                <strong>Description:</strong><br>
                ${character.description.replace(/\n/g, "<br>")}
            </div>
            <div class="character-section">
                <strong>Personality:</strong><br>
                ${character.personality.replace(/\n/g, "<br>")}
            </div>
            <div class="character-section">
                <strong>Scenario:</strong><br>
                ${character.scenario.replace(/\n/g, "<br>")}
            </div>
            <div class="character-section">
                <strong>First Message:</strong><br>
                <div class="message-example">
                    ${character.firstMessage.replace(/\n/g, "<br>")}
                </div>
            </div>
        `;
  }

  // Convert to SillyTavern Spec V3 format
  toSpecV3Format(character) {
    const now = Math.floor(Date.now() / 1000);
    const spec = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: character.name || "Unnamed Character",
        description: character.description || "",
        personality: character.personality || "",
        scenario: character.scenario || "",
        first_mes: character.firstMessage || "Hello!",
        mes_example: character.mesExample || "",
        post_history_instructions: character.postHistoryInstructions || "",
        creator_notes: character.creatorNotes || "",
        creator: character.creator || "",
        alternate_greetings: character.alternateGreetings || [],
        tags: Array.isArray(character.tags) ? character.tags : [],
        cardType: character.cardType || "single",
        // V3 required fields
        group_only_greetings: character.groupOnlyGreetings || [],
        assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }],
        creation_date: now,
        modification_date: now,
      },
    };
    if (character.character_book) {
      spec.data.character_book = character.character_book;
    }
    return spec;
  }
}

// "# Name's Profile", with a straight or curly apostrophe ("# Silas' Profile" too).
CharacterGenerator.PROFILE_HEADER_RE = /^#\s*(.+?)(?:['’]s|['’])\s+Profile\s*$/im;

// First words of a name that are also ordinary words, so can't be swapped for
// {{char}} wherever they appear: articles and titles (group and scenario
// names), and given names that double as common words.
CharacterGenerator.ORDINARY_WORDS = new Set(
  (
    "the a an old new big little great grand saint mister miss mrs lady lord sir dame doctor captain " +
    "father mother sister brother uncle aunt king queen prince princess duke house club team order " +
    "project operation black white red blue green gold silver iron dark last first lost " +
    "will may grace rose hope mark faith joy bill art rob sue pat don frank jack lance chase hunter " +
    "summer autumn winter april june august dawn ivy violet amber crystal ruby pearl jade sky rain " +
    "storm wolf fox raven angel destiny chance miles guy rich bob dot gene ray rod victor earl major " +
    "dean reed heath cliff glen dale brook river forest sage basil olive holly daisy lily iris poppy " +
    "penny sandy misty star sunny love honor justice gray grey brown christian norman carol bell " +
    "belle page mason carter cooper parker tanner archer fisher baker sterling drew wade pierce chip " +
    "buck bud rusty sonny junior patience prudence charity trinity serenity harmony melody candy " +
    "ginger pepper sunshine bear colt ash cash ace blaze flint stone rocky cole"
  ).split(" "),
);

// Export singleton instance
window.characterGenerator = new CharacterGenerator();

// Lorebook, alt-greeting, and consistency methods — extends APIHandler via prototype
Object.assign(APIHandler.prototype, {

  async generateAltGreeting(character, type = "random", customPrompt = "", pov = "third", lorebookEntries = []) {
    if (!character) throw new Error("Character is required");

    const model = this.config.get("api.text.model");
    const povText = pov === "third" ? "third-person" : "first-person";
    const charName = character.name || "{{char}}";

    const contextInstruction = type === "continuation"
      ? "Write an alternate first message that takes place AFTER the original scenario has concluded. It should be a new encounter or continuation of their story, serving as a fresh starting point for a new roleplay session."
      : "Write a completely original and random alternate first message. It should establish a brand new scenario, setting, or situation different from the original one, serving as a fresh starting point.";

    const systemPrompt = `You are an expert at writing roleplay opening messages. Your task is to write a single, detailed alternate first message for the character "${charName}".
Write in ${povText} perspective. Focus on actions, thoughts, and dialogue to set the scene.
${contextInstruction}
**CRITICAL RULE:** Do NOT use the character's actual name. You MUST use the exact macro string \`{{char}}\` instead of their name in the generated text.
Do NOT include markdown headers, <START> tags, or explanations. Output ONLY the narrative text. Do NOT roleplay for the user ({{user}}).`;

    const hintText = customPrompt ? `\nUSER DIRECTION: ${customPrompt}` : "";
    const lorebookContext = this.formatLorebookContext(lorebookEntries);

    const userPrompt = `Character Profile Context:
Name: ${charName}
Description: ${character.description}
Personality: ${character.personality}
Original Scenario: ${character.scenario}
Original First Message: ${character.firstMessage}${lorebookContext}

Please write the alternate first message now.${hintText}

Output ONLY the message content.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 1500,
      stream: true,
    };

    try {
      console.log(`=== STARTING ALT GREETING GENERATION (${type}) ===`);
      const response = await this.makeRequest("/chat/completions", data, false, true);
      const output = await this.handleStreamResponse(response, () => {});
      console.log("Alternate greeting generated successfully.");
      return output.trim();
    } catch (error) {
      console.error("=== ALT GREETING GENERATION FAILED ===", error);
      throw error;
    }
  },

  _parseJsonRobust(output) {
    if (!output || typeof output !== "string") return null;
    
    // Strip reasoning blocks common in GLM 5.1, DeepSeek, etc.
    let cleaned = output.replace(/<think>[\s\S]*?<\/think>/gi, "")
                        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
                        .trim();
    
    if (!cleaned) return null;

    try { return JSON.parse(cleaned); } catch (e) {}

    const mdMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (mdMatch) {
      try { return JSON.parse(mdMatch[1].trim()); } catch (e) {}
    }

    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    
    if (firstBracket !== -1 && lastBracket !== -1 && firstBracket < lastBracket && 
        (firstBrace === -1 || firstBracket < firstBrace || (firstBrace < firstBracket && lastBrace > lastBracket))) {
      try { return JSON.parse(cleaned.substring(firstBracket, lastBracket + 1)); } catch (e) {}
    } 
    
    if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
      try { return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1)); } catch (e) {}
    }

    cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    if (!cleaned) return null;
    try { return JSON.parse(cleaned); } catch (e) {}

    return null;
  },

  /**
   * Run a lorebook JSON call as a stream and return its text and finish reason.
   *
   * These used to wait for the whole reply. GLM 5.3 can think for over a
   * minute first, and an iPhone drops a request that has received nothing for
   * 60 seconds, then quietly re-sends it, so one scan was paid for twice and
   * still failed. A stream keeps data arriving while the model thinks.
   *
   * `what` names the output for the error when the model writes nothing.
   */
  async _streamLoreJson(data, what) {
    const response = await this.makeRequest("/chat/completions", data, false, true);
    const output = await this.handleStreamResponse(response, () => {}, { warnOnTruncation: false });
    const { finishReason = null, reasoningChars = 0 } = this.lastStreamStats || {};
    if (!String(output || "").trim()) {
      const model = this.config.get("api.text.model") || "The model";
      if (finishReason === "length" && reasoningChars > 0) {
        throw new Error(
          `${model} used its whole token budget thinking and wrote no ${what}. Try again, or switch to a different model.`,
        );
      }
      throw new Error(
        `${model} returned an empty reply${finishReason ? ` (finish: ${finishReason})` : ""}. Try again, or switch to a different model.`,
      );
    }
    return { output, finishReason };
  },

  /**
   * A compact index of the lorebook: each entry's keys plus the start of its
   * text. Given to the AI so it doesn't re-suggest topics that already have an
   * entry, and doesn't contradict them when it writes a new one.
   */
  _lorebookIndex(entries, { excludeId = null, maxChars = 200 } = {}) {
    return (entries || [])
      .filter((e) => e && e.enabled !== false && Array.isArray(e.keys) && e.keys.some(Boolean))
      .filter((e) => excludeId == null || String(e.id) !== String(excludeId))
      .map((e) => {
        const text = String(e.content || "").replace(/\s+/g, " ").trim();
        const snippet = text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
        return `- [${e.keys.filter(Boolean).join(", ")}] ${snippet}`;
      })
      .join("\n");
  },

  /**
   * Entries none of whose trigger keys appear anywhere in the card text.
   *
   * A keyword only loads its entry when it turns up in recent chat, both in
   * SillyTavern and in our own chat backend. Having it in the card is what
   * makes the AI aware the topic exists, so it brings it up and the entry loads.
   * An entry with no key in the card loads only if someone happens to say one.
   * Matching is a case-insensitive substring test, the same as the backend.
   */
  findUncoveredLorebookEntries(character, entries) {
    const text = ["description", "personality", "scenario", "firstMessage"]
      .map((f) => (character && character[f]) || "")
      .join("\n")
      .toLowerCase();
    return (entries || []).filter((e) => {
      if (!e || e.enabled === false || !Array.isArray(e.keys)) return false;
      const keys = this._coverageKeys(e).map((k) => k.toLowerCase());
      return keys.length > 0 && !keys.some((k) => text.includes(k));
    });
  },

  /**
   * The keys whose presence in the card counts as mentioning the entry.
   *
   * Supporting cast entries are keyed on name and role ("Ada Vance",
   * "Bartender"). "The bartender" in the card doesn't tell the AI which
   * bartender, so for those only the name counts. They're recognised by the
   * topic the cast flow gives them, "Ada Vance (Bartender)", which survives a
   * save where an extra flag on the entry would not.
   */
  _coverageKeys(entry) {
    const keys = entry.keys.map((k) => String(k || "").trim()).filter(Boolean);
    const topic = String(entry.topic || "").trim().toLowerCase();
    const isCast = keys.length >= 2 && topic === `${keys[0]} (${keys[1]})`.toLowerCase();
    return isCast ? [keys[0]] : keys;
  },

  async suggestLorebookTopics(character, existingEntries = []) {
    if (!character) throw new Error("Character is required to suggest lorebook topics");

    const model = this.config.get("api.text.model");

    const systemPrompt = `You are an expert in roleplaying and world-building. Your task is to analyze a character profile and identify 3-5 key nouns (people, places, organizations, unique items, or concepts) that would be ideal candidates for a lorebook entry.

Do not suggest anything that already has a lorebook entry, or a close variant of one.

Return ONLY a single JSON array of strings. Do not include any other text, explanation, or markdown.

Example response:
["The Crimson Legion", "The Shadow Syndicate", "The Sunstone", "City of Eldoria"]`;

    const index = this._lorebookIndex(existingEntries, { maxChars: 80 });
    const existingText = index
      ? `\n\nAlready in the lorebook (do NOT suggest these again):\n${index}`
      : "";

    const userPrompt = `Analyze the following character profile and identify key topics for lorebook entries.

Character Profile:
Name: ${character.name}
Description: ${character.description}
Personality: ${character.personality}
Scenario: ${character.scenario}${existingText}

Output a JSON array of strings with your suggestions.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 500,
      stream: true,
      resumable: true,
      __jobLabel: "Lorebook topics",
      response_format: { type: "json_object" },
    };

    try {
      console.log("=== STARTING LOREBOOK TOPIC SUGGESTION ===");
      const { output } = await this._streamLoreJson(data, "topic list");

      let parsed = this._parseJsonRobust(output);
      
      if (!parsed) {
        console.error("Failed to parse suggestLorebookTopics output:", output);
        throw new Error("No valid JSON array found in AI response for topics.");
      }

      let topics = null;
      if (Array.isArray(parsed)) topics = parsed;
      else if (typeof parsed === "object" && parsed !== null) {
        const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        if (key) topics = parsed[key];
      }

      if (!topics) {
        console.error("Parsed output was not an array:", parsed);
        throw new Error("AI response for topics was not a valid JSON array.");
      }

      // The model doesn't always respect the exclusion list, so filter here too.
      const taken = new Set(
        (existingEntries || []).flatMap((e) => (e.keys || []).map((k) => String(k).trim().toLowerCase())),
      );
      return topics
        .map((t) => String(t || "").trim())
        .filter((t) => t && !taken.has(t.toLowerCase()));
    } catch (error) {
      console.error("=== LOREBOOK TOPIC SUGGESTION FAILED ===", error);
      throw error;
    }
  },

  /**
   * Write or improve one lorebook entry.
   *
   * With no existing text, it writes a new entry from the keys and the user's
   * prompt. With existing text, it improves that text following the prompt and
   * keeps its facts, rather than starting again from scratch.
   */
  async writeLorebookEntry(character, keywords, {
    existingContent = "", instruction = "", otherEntries = [], excludeId = null,
  } = {}) {
    if (!character || !keywords) throw new Error("Character and keywords are required");

    const model = this.config.get("api.text.model");
    const charName = character.name || "{{char}}";
    const existing = String(existingContent || "").trim();
    const direction = String(instruction || "").trim();
    const enhancing = !!existing;

    const rules = `LOREBOOK WRITING RULES:
- The entry is inserted into the AI's context on its own, with no heading, whenever one of its keywords comes up in the chat. Name the topic in the first sentence so the text makes sense by itself.
- Clear, direct declarative statements in the present tense. Use bullet points for lists of facts, rules, relationships or behaviours.
- State what the AI needs to know to portray the topic correctly. Be concrete. No purple prose, atmosphere or story narration.
- Stay consistent with the character card and the other lorebook entries, and don't repeat what they already say.
- Refer to the main character with the exact macro \`{{char}}\`, never by their actual name.
- Output ONLY the entry text: no title, no markdown headers, no explanation.`;

    const task = enhancing
      ? `You improve an existing lorebook entry for AI roleplay. You are given the CURRENT entry and, possibly, a direction from the user.
- Follow the user's direction: add, change or remove only what it asks for.
- Keep every fact in the current entry unless the direction says to change or remove it.
- With no direction, tighten the wording, fix the structure to match the rules below and fill obvious gaps from the character card. Do not invent major new lore.
- Output the complete revised entry, not just the changes.`
      : `You write a new lorebook entry for AI roleplay, about the topic named by the keywords, grounded in the character card. Aim for 3-8 concise sentences or bullet points.`;

    const systemPrompt = `${task}\n\n${rules}`;

    const index = this._lorebookIndex(otherEntries, { excludeId });
    const otherText = index ? `\n\nOther lorebook entries (for consistency; don't repeat them):\n${index}` : "";
    const directionText = direction
      ? `\n\nUSER'S DIRECTION:\n${direction}`
      : (enhancing ? "\n\nUSER'S DIRECTION: (none — tidy and strengthen the entry as described)" : "");
    const currentText = enhancing ? `\n\nCURRENT ENTRY (improve this; do not discard it):\n${existing}` : "";

    const userPrompt = `Character Profile Context:
Name: ${charName}
Description: ${character.description}
Personality: ${character.personality || ""}
Scenario: ${character.scenario}${otherText}

Lorebook entry keywords: "${keywords}"${currentText}${directionText}

Output only the ${enhancing ? "revised" : "new"} lorebook entry text.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: enhancing ? 0.5 : 0.7,
      max_tokens: 1500,
      stream: true,
      // Held server-side, so a phone locking mid-call collects it on return.
      resumable: true,
      __jobLabel: enhancing ? "Lorebook entry (enhance)" : "Lorebook entry",
    };

    const label = enhancing ? "ENHANCE" : "GENERATION";
    try {
      console.log(`=== STARTING LOREBOOK ENTRY ${label}: ${keywords} ===`);
      const response = await this.makeRequest("/chat/completions", data, false, true);
      const output = await this.handleStreamResponse(response, () => {});
      if (this.lastFinishReason === "length") {
        throw new Error("The entry was cut off at the token limit. Try again, or shorten the prompt.");
      }
      return String(output || "").trim();
    } catch (error) {
      console.error(`=== LOREBOOK ENTRY ${label} FAILED: ${keywords} ===`, error);
      throw error;
    }
  },

  async generateSupportingCastMember(character, roleDescription, optionalName = "", alreadyGeneratedNames = []) {
    if (!character || !roleDescription) throw new Error("Character and role description are required");

    const model = this.config.get("api.text.model");
    const charName = character.name || "{{char}}";
    
    // Same problem as the main card: left to itself the model gives every
    // supporting character the same handful of names. Hand it a real one drawn
    // from the name bank unless the user named them, or unless the app is in
    // "Any culture" mode, where there is no bank to draw from.
    let nameInstruction;
    if (optionalName) {
      nameInstruction = `The character's name is "${optionalName}".`;
    } else if (typeof CultureSteer !== "undefined" && CultureSteer.usesBank()) {
      const drawn = NameBank.draw({
        origin: CultureSteer.mode(),
        count: 1,
        exclude: alreadyGeneratedNames || [],
      }).names[0];
      nameInstruction = drawn
        ? `Name this character "${drawn}" — a real name drawn for them. Use a different name only if the main character's setting makes it clearly wrong (a different country, culture or historical period), in which case pick one that fits that setting.`
        : `You must invent a fitting name for this character based on their role and setting.`;
    } else {
      nameInstruction = `You must invent a fitting name for this character based on their role and setting.`;
    }

    const excludeNamesInstruction = (alreadyGeneratedNames && alreadyGeneratedNames.length > 0)
      ? `- Do NOT use any of these names (they are already taken): ${alreadyGeneratedNames.join(", ")}`
      : "";

    const systemPrompt = `You are an expert in writing highly functional lorebook entries for supporting cast members in AI roleplaying.
Your task is to take a brief, vague description of a background character and flesh them out into a concise lorebook entry (2-3 paragraphs max).

Main Character Profile Context:
Name: ${charName}
Description: ${character.description}
Scenario: ${character.scenario}

RULES:
- Focus on physical appearance, a few personal details or quirks, and their motivations or attitude.
- Keep it brief, just enough so the AI can feature them as needed. Do NOT write a full character card.
- Write from a neutral, omniscient narrator's perspective.
- Do NOT use the main character's actual name. You MUST use the exact macro string \`{{char}}\` instead of the main character's name in the generated text.
- CRITICAL JSON REQUIREMENT: You MUST escape any internal double quotes within the text fields (e.g., use \\" instead of "). Failure to do so will break the JSON parser. Do NOT add extra fields like "motivation" or "notes".

Return ONLY a strict JSON object with the following structure:
{
  "name": "The character's name",
  "role": "A short 1-3 word summary of their role (e.g. Waitress, Guard Captain)",
  "content": "The 2-3 paragraphs of lorebook content"
}
Do not include any markdown, explanation, or extra text.`;

    const userPrompt = `Supporting Cast Member Description to generate:
"${roleDescription}"

${nameInstruction}
${excludeNamesInstruction}

Generate the supporting cast member JSON now.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stream: true,
      resumable: true,
      __jobLabel: "Supporting cast member",
      response_format: { type: "json_object" },
    };

    try {
      console.log(`=== STARTING SUPPORTING CAST GENERATION: ${roleDescription} ===`);
      const { output } = await this._streamLoreJson(data, "cast member");
      
      let parsed = this._parseJsonRobust(output);
      
      if (!parsed || !parsed.name || !parsed.content) {
        console.error("Failed to parse generateSupportingCastMember output:", output);
        throw new Error("Invalid JSON returned for supporting cast member.");
      }

      console.log(`Supporting cast "${parsed.name}" generated successfully.`);
      return parsed;
    } catch (error) {
      console.error(`=== SUPPORTING CAST GENERATION FAILED: ${roleDescription} ===`, error);
      throw error;
    }
  },

  async suggestSupportingCast(character) {
    if (!character) throw new Error("Character is required");

    const model = this.config.get("api.text.model");
    const charName = character.name || "{{char}}";

    const systemPrompt = `You are an expert AI roleplay assistant. Your task is to identify and list supporting cast members for the provided character profile and scenario.
First, carefully read the Character Context (Description and Scenario).
If any specific background characters, suspects, crew members, or other supporting roles are explicitly mentioned or strongly implied, extract ALL of them.
If fewer than 3 background characters are explicitly mentioned, invent additional appropriate supporting cast members so that you return at least 3. Do not exceed 8 characters in total.

Return a strict JSON object containing an array of objects under the key "cast". Each object should have a "description" property containing a brief vague description of the character (e.g., "The cynical bartender at the neon diner", "A naive rookie town guard").

Return ONLY a JSON object:
{
  "cast": [
    { "description": "..." },
    { "description": "..." }
  ]
}`;

    const userPrompt = `Character Context:
Name: ${charName}
Description: ${character.description}
Scenario: ${character.scenario}

Extract or invent the supporting cast members and return the JSON now.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      // Was 500, which could truncate mid-array when the model returns the
      // full 8 suggestions — truncation here becomes a hard parse failure.
      max_tokens: 1200,
      stream: true,
      resumable: true,
      __jobLabel: "Supporting cast ideas",
      response_format: { type: "json_object" },
    };

    try {
      console.log("=== STARTING SUPPORTING CAST SUGGESTION ===");
      const { output } = await this._streamLoreJson(data, "cast list");
      const parsed = this._parseJsonRobust(output);
      
      if (!parsed || !Array.isArray(parsed.cast)) {
        throw new Error("Invalid JSON structure returned for cast suggestions.");
      }

      console.log(`Suggested ${parsed.cast.length} supporting cast members.`);
      return parsed.cast.map(c => c.description).filter(d => d);
    } catch (error) {
      console.error("=== SUPPORTING CAST SUGGESTION FAILED ===", error);
      throw error;
    }
  },

  async checkConsistency(character, lorebookEntries = [], onStream = null) {
    if (!character) throw new Error("Character is required");

    const model = this.config.get("api.text.model");

    const systemPrompt = `You are an expert narrative editor and continuity checker for roleplay characters. Your task is to analyze a character profile and its associated lorebook entries for any logical contradictions, tonal inconsistencies, or continuity errors.

If you find inconsistencies, list them clearly and suggest how to fix them.
If everything is consistent, say so and praise the cohesion of the character.
Keep your report concise, actionable, and formatted nicely.`;

    const lorebookContext = this.formatLorebookContext(lorebookEntries);
    const userPrompt = `Character Profile:
Name: ${character.name || "Unknown"}
Description: ${character.description}
Personality: ${character.personality}
Scenario: ${character.scenario}
First Message: ${character.firstMessage}${lorebookContext}

Please analyze this character and lorebook for consistency.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1500,
      stream: true,
    };

    try {
      console.log("=== STARTING CONSISTENCY CHECK ===");
      const response = await this.makeRequest("/chat/completions", data, false, true);
      const output = await this.handleStreamResponse(response, (chunk, full) => {
        if (onStream) onStream(chunk, full);
      });
      return output.trim();
    } catch (error) {
      console.error("=== CONSISTENCY CHECK FAILED ===", error);
      throw error;
    }
  },

  async scanCardForLorebookCandidates(character, existingEntries = []) {
    if (!character) throw new Error("Character is required");

    const model = this.config.get("api.text.model");

    const systemPrompt = `You are an expert in AI roleplay character card design and lorebook writing. Your task has two parts:

PART 1 — IDENTIFY: Scan the character card for world-building lore that would be better served as a lorebook entry than living inside the card itself.

World-building lore includes: specific locations, named NPCs (other than the main character), factions, organisations, historical events, unique items, or significant concepts described in enough detail within the card.

Character guidance that MUST stay in the card: personality traits, behavioural patterns, speech style, emotional state, goals, fears, quirks, limits, direct physical description of the main character, and how the main character personally feels about or relates to things.

Skip anything that already has a lorebook entry (you will be given the list).

The author reviews every candidate and picks which ones to apply, and sees each source passage before anything is trimmed from the card. So you don't need to settle borderline cases: if a section is plausibly lore, include it and let the author decide. Make each call once and move on.

PART 2 — WRITE: For each lore item identified, write a properly formatted lorebook entry. Lorebook entries are instructions read by an AI roleplay model — write them accordingly:

LOREBOOK WRITING RULES:
- The entry is inserted into the AI's context on its own, with no heading, when a keyword comes up. Name the topic in the first sentence.
- Write in clear, direct declarative statements. ("The Merchant Guild controls all trade licences in the city.")
- Use bullet points for lists of facts, rules, or behaviours. Avoid flowing narrative prose.
- State only what the AI needs to KNOW and DO when these keywords appear in conversation.
- Be specific and concrete. Use only facts the card states or clearly implies — do not invent new lore.
- No purple prose, no atmosphere-building, no story-telling. Pure information.
- Keep each entry to 3-8 concise sentences or bullet points. Do not pad.
- Use present tense. ("The guild charges a 10% cut." not "The guild charged...")
- Refer to the main character as \`{{char}}\`, never by name.

Return ONLY a strict JSON array. Each element must have:
- "topic": short display name (e.g. "The Red Keep")
- "keys": array of 2-4 trigger keywords. Put the most distinctive name first; avoid very short or common words that would match unrelated text.
- "content": the lorebook entry text following the writing rules above
- "source": the sentences from the card that describe this topic, copied word for word (separate passages with " … "). These will be trimmed from the card, so copy them exactly.

If you find no lore content suitable for elevation, return an empty array: []

Example of GOOD output:
[
  {
    "topic": "The Merchant Guild",
    "keys": ["Merchant Guild", "the Guild"],
    "content": "The Merchant Guild controls all trade licences across the four city-states. No merchant may operate without a Guild charter.\\n\\n- Membership requires a 500 gold buy-in and 50 gold annual dues.\\n- The Guild enforces a strict no-undercutting code; violations result in charter revocation.\\n- Private deals with nobility must include a 10% cut to the Guild coffers or they are considered illegal.\\n- Guild enforcers (called Ledgers) have authority to seize goods from unlicensed traders.",
    "source": "The Merchant Guild holds every trade licence in the four city-states, and its Ledgers seize goods from anyone trading without a charter."
  }
]`;

    const index = this._lorebookIndex(existingEntries, { maxChars: 80 });
    const existingText = index
      ? `\n\nAlready in the lorebook (do NOT return these again):\n${index}`
      : "";

    const userPrompt = `Analyse the following character card and identify any world-building lore content (locations, NPCs, factions, items, historical events, organisations) that is described in enough detail to be better served as a lorebook entry rather than living inside the card itself.

Character Name: ${character.name}

Description:
${character.description}

Personality:
${character.personality}

Scenario:
${character.scenario}${existingText}

Return a JSON array of lorebook candidates. Return [] if none found.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      // GLM 5.3 reasons first and the reasoning counts against this. On
      // 2026-10-15 a lore-heavy card used all of the old 6000 on reasoning and
      // wrote nothing, twice. It is only a ceiling, so headroom costs nothing.
      max_tokens: 16384,
      stream: true,
      // Held server-side, so a phone locking mid-scan collects it on return.
      resumable: true,
      __jobLabel: "Lorebook scan",
    };

    try {
      console.log("=== STARTING LOREBOOK CARD SCAN ===");
      const { output, finishReason } = await this._streamLoreJson(data, "lorebook entries");

      let parsed = this._parseJsonRobust(output);

      // Fail loudly rather than returning []. An empty array is the caller's
      // signal for "nothing to elevate", so swallowing a parse failure here
      // reported a broken response as a clean, successful scan.
      if (!parsed) {
        console.error("Failed to parse scanCardForLorebookCandidates output:", output);
        if (finishReason === "length") {
          throw new Error("The lorebook scan was cut off at the token limit before it finished. Try again.");
        }
        throw new Error(
          "Could not read the lorebook scan results — the AI returned malformed output. Try again.",
        );
      }

      let list = null;
      if (Array.isArray(parsed)) list = parsed;
      else if (typeof parsed === "object" && parsed !== null) {
        // Unwrap if AI wrapped the array in an object
        const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        if (key) list = parsed[key];
      }

      // A parsed-but-unrecognised shape is also a failure, not "found nothing".
      if (!list) {
        throw new Error(
          "The lorebook scan returned an unexpected format. Please try again.",
        );
      }

      return list.map((c) => this._normaliseLoreCandidate(c)).filter(Boolean);
    } catch (error) {
      console.error("=== LOREBOOK CARD SCAN FAILED ===", error);
      throw error;
    }
  },

  /**
   * Coerce one scan result into { topic, keys, content, source }, or null if
   * it has nothing usable. Models sometimes return keys as a comma-separated
   * string, or leave out the topic, which used to crash the picker.
   */
  _normaliseLoreCandidate(c) {
    if (!c || typeof c !== "object") return null;
    const content = String(c.content || "").trim();
    if (!content) return null;
    let keys = Array.isArray(c.keys) ? c.keys : String(c.keys || "").split(",");
    keys = [...new Set(keys.map((k) => String(k || "").trim()).filter(Boolean))];
    const topic = String(c.topic || "").trim() || keys[0] || "";
    if (!topic) return null;
    if (!keys.length) keys = [topic];
    const source = String(c.source || "").trim();
    return { topic, keys, content, source };
  },

  /**
   * A targeted card edit for lorebook work. reviseCharacter rewrites the whole
   * card and tightens it as it goes, so moving one faction to the lorebook
   * could quietly compress the personality and first message too. This asks
   * for only the named fields back, sends the rest as read-only context, and
   * tells the model to return untouched text word for word.
   *
   * Returns the full character with only those fields replaced.
   */
  async editCardForLorebook(character, instruction, editableFields, pov = "third") {
    if (!character) throw new Error("Character is required");
    const LABELS = {
      description: "Description",
      personality: "Personality",
      scenario: "Scenario",
      firstMessage: "First Message",
    };
    const fields = (editableFields || []).filter((f) => LABELS[f]);
    if (!fields.length) throw new Error("No editable fields given");

    const model = this.config.get("api.text.model");
    const povText = pov === "third" ? "third-person" : "first-person";

    const systemPrompt = `You make targeted edits to roleplay character cards as part of lorebook (World Info) maintenance. You are given the card as JSON and a specific edit request.

RULES:
- Change ONLY what the request requires. Every sentence the request does not touch must come back word for word — do not tighten, restyle, reorder or summarise anything else.
- Keep the \`{{char}}\` and \`{{user}}\` macros exactly as they are. Refer to the main character as \`{{char}}\`, never by name.
- Keep the existing ${povText} point of view and formatting (markdown, bullet points, line breaks).
- Never copy or paraphrase lorebook entry content into the card beyond what the request allows.
- Plan the edits briefly. Don't write the fields out while thinking: write them once, in the JSON.

Return strict JSON only, with exactly these keys: ${fields.join(", ")}. Each value is the complete text of that field after your edit. Escape newlines inside strings as \\n.`;

    const card = {
      name: character.name || "",
      description: character.description || "",
      personality: character.personality || "",
      scenario: character.scenario || "",
      firstMessage: character.firstMessage || "",
    };

    const userPrompt = `EDIT REQUEST:
${instruction}

You may edit ONLY: ${fields.map((f) => LABELS[f]).join(", ")}. The other fields are context.

Current card JSON:
${JSON.stringify(card, null, 2)}`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      // The reply is up to three whole fields, and GLM 5.3's reasoning counts
      // against this too. On 2026-10-16 a cast edit drafted the fields in its
      // reasoning and used all of the old 8192 before writing any JSON.
      max_tokens: 16384,
      stream: true,
      // Held server-side, so a phone locking mid-call collects it on return.
      resumable: true,
      __jobLabel: "Lorebook card edit",
    };

    console.log("=== STARTING LOREBOOK CARD EDIT ===", fields);
    const { output, finishReason } = await this._streamLoreJson(data, "card edit");
    if (finishReason === "length") {
      throw new Error("The card edit was cut off at the token limit, so it wasn't applied. Try again.");
    }
    const parsed = this.parseJsonFromModelOutput(output);

    const updates = {};
    for (const f of fields) {
      const value = parsed[f] ?? (f === "firstMessage" ? parsed.first_message : undefined);
      if (typeof value === "string" && value.trim()) updates[f] = value.trim();
    }
    return { ...character, ...updates };
  },

});

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

  async suggestLorebookTopics(character) {
    if (!character) throw new Error("Character is required to suggest lorebook topics");

    const model = this.config.get("api.text.model");

    const systemPrompt = `You are an expert in roleplaying and world-building. Your task is to analyze a character profile and identify 3-5 key nouns (people, places, organizations, unique items, or concepts) that would be ideal candidates for a lorebook entry.

Return ONLY a single JSON array of strings. Do not include any other text, explanation, or markdown.

Example response:
["The Crimson Legion", "The Shadow Syndicate", "The Sunstone", "City of Eldoria"]`;

    const userPrompt = `Analyze the following character profile and identify key topics for lorebook entries.

Character Profile:
Name: ${character.name}
Description: ${character.description}
Personality: ${character.personality}
Scenario: ${character.scenario}

Output a JSON array of strings with your suggestions.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 500,
      stream: false,
      response_format: { type: "json_object" },
    };

    try {
      console.log("=== STARTING LOREBOOK TOPIC SUGGESTION ===");
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);

      let parsed = this._parseJsonRobust(output);
      
      if (!parsed) {
        console.error("Failed to parse suggestLorebookTopics output:", output);
        throw new Error("No valid JSON array found in AI response for topics.");
      }

      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === "object" && parsed !== null) {
        const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        if (key) return parsed[key];
      }

      console.error("Parsed output was not an array:", parsed);
      throw new Error("AI response for topics was not a valid JSON array.");
    } catch (error) {
      console.error("=== LOREBOOK TOPIC SUGGESTION FAILED ===", error);
      throw error;
    }
  },

  async generateLorebookEntry(character, keywords, hint = "") {
    if (!character || !keywords) throw new Error("Character and keywords are required");

    const model = this.config.get("api.text.model");
    const charName = character.name || "{{char}}";

    const systemPrompt = `You are an expert in writing concise, highly functional lorebook entries for AI roleplaying. Based on the provided character context and keywords, write clear, simple, and direct facts about the topic.

The entry should focus purely on what the AI needs to know to understand the topic and interact with it correctly. Keep the text functional, omitting unnecessary flowery prose. It should be 1-3 short paragraphs long, written from a neutral, omniscient narrator's perspective.
Do NOT include the keywords in the output.
**CRITICAL RULE:** Do NOT use the character's actual name. You MUST use the exact macro string \`{{char}}\` instead of their name in the generated text.
Output ONLY the generated text for the entry, with no extra explanations or formatting.`;

    const hintText = hint ? `\n\nUser has provided a hint for the content: "${hint}"` : "";

    const userPrompt = `Character Profile Context:
Name: ${charName}
Description: ${character.description}
Scenario: ${character.scenario}

Please write a lorebook entry for the following topic.
Keywords: "${keywords}"
${hintText}

Output only the lorebook entry content.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stream: true,
    };

    try {
      console.log(`=== STARTING LOREBOOK ENTRY GENERATION: ${keywords} ===`);
      const response = await this.makeRequest("/chat/completions", data, false, true);
      const output = await this.handleStreamResponse(response, () => {});
      console.log(`Lorebook entry for "${keywords}" generated successfully.`);
      return output.trim();
    } catch (error) {
      console.error(`=== LOREBOOK ENTRY GENERATION FAILED: ${keywords} ===`, error);
      throw error;
    }
  },

  async generateSupportingCastMember(character, roleDescription, optionalName = "", alreadyGeneratedNames = []) {
    if (!character || !roleDescription) throw new Error("Character and role description are required");

    const model = this.config.get("api.text.model");
    const charName = character.name || "{{char}}";
    
    const nameInstruction = optionalName 
      ? `The character's name is "${optionalName}".` 
      : `You must invent a fitting name for this character based on their role and setting.`;

    const excludeNamesInstruction = (alreadyGeneratedNames && alreadyGeneratedNames.length > 0)
      ? `- Do NOT use any of these names (they are already taken): ${alreadyGeneratedNames.join(", ")}`
      : "";

    const systemPrompt = `You are an expert in writing highly functional lorebook entries for supporting cast members in AI roleplaying.
Your task is to take a brief, vague description of a background character and flesh them out into a concise lorebook entry (2-3 paragraphs max).

RULES:
- Focus on physical appearance, a few personal details or quirks, and their motivations or attitude.
- Keep it brief, just enough so the AI can feature them as needed. Do NOT write a full character card.
- Write from a neutral, omniscient narrator's perspective.
- Do NOT use the main character's actual name. You MUST use the exact macro string \`{{char}}\` instead of the main character's name in the generated text.
- ${nameInstruction}
${excludeNamesInstruction}

Return ONLY a strict JSON object with the following structure:
{
  "name": "The character's name",
  "role": "A short 1-3 word summary of their role (e.g. Waitress, Guard Captain)",
  "content": "The 2-3 paragraphs of lorebook content"
}
Do not include any markdown, explanation, or extra text.`;

    const userPrompt = `Main Character Profile Context:
Name: ${charName}
Description: ${character.description}
Scenario: ${character.scenario}

Supporting Cast Member Description:
"${roleDescription}"

Generate the supporting cast member JSON now.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stream: false,
      response_format: { type: "json_object" },
    };

    try {
      console.log(`=== STARTING SUPPORTING CAST GENERATION: ${roleDescription} ===`);
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);
      
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

    const systemPrompt = `You are an expert AI roleplay assistant. Based on the provided character profile and scenario, identify 2-4 implied or highly relevant background characters that would make excellent supporting cast members.
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

Identify 2-4 supporting cast members and return the JSON now.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
      stream: false,
      response_format: { type: "json_object" },
    };

    try {
      console.log("=== STARTING SUPPORTING CAST SUGGESTION ===");
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);
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

  /**
   * Enrichment pass — takes a scanned candidate (topic, keys, seed content) and
   * produces a full, standalone lorebook entry grounded in the character context.
   * The seed content from the scan is used as a factual anchor so no information
   * is lost, but the AI expands, structures, and formats it to proper lorebook standard.
   */
  async enrichLorebookEntry(character, candidate) {
    if (!character || !candidate) throw new Error("Character and candidate are required");

    const model = this.config.get("api.text.model");
    const charName = character.name || "{{char}}";
    const keywordStr = candidate.keys.join(", ");

    const systemPrompt = `You are an expert in writing lorebook entries for AI roleplay models. Your task is to take a seed extract from a character card and produce a complete, well-structured lorebook entry for the given topic.

LOREBOOK WRITING RULES — follow these strictly:
- Write in clear, direct declarative statements that tell the AI facts and behaviours.
- Use bullet points for lists of rules, customs, relationships, or behaviours.
- State what the AI needs to KNOW and DO when these keywords appear. Be specific and concrete.
- No purple prose, no atmosphere-building, no story narration. Pure functional information.
- 4-10 concise sentences or bullet points. No padding, no repetition.
- Present tense throughout. ("The guild charges..." not "The guild charged...")
- If the topic has rules, power structures, or behaviours, state them explicitly.
- Do NOT use the character's actual name — use the macro \`{{char}}\` instead wherever the character is referenced.
- Do NOT repeat the keywords themselves as headings or labels in the output.

Output ONLY the lorebook entry text. No titles, no explanations, no markdown headers.`;

    const userPrompt = `Character Context:
Name: ${charName}
Description: ${character.description}
Scenario: ${character.scenario}

Topic to write a lorebook entry for: "${candidate.topic}"
Trigger keywords: ${keywordStr}

Seed information extracted from the card (use this as your factual foundation — do not contradict it, but expand and structure it properly):
${candidate.content}

Now write the complete lorebook entry.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 1200,
      stream: false,
    };

    try {
      console.log(`=== ENRICHING LOREBOOK ENTRY: ${candidate.topic} ===`);
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);
      console.log(`Lorebook entry for "${candidate.topic}" enriched successfully.`);
      return output.trim();
    } catch (error) {
      console.error(`=== LOREBOOK ENTRY ENRICHMENT FAILED: ${candidate.topic} ===`, error);
      // Fall back to the scanned seed content rather than failing completely
      return candidate.content;
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

  async scanCardForLorebookCandidates(character) {
    if (!character) throw new Error("Character is required");

    const model = this.config.get("api.text.model");

    const systemPrompt = `You are an expert in AI roleplay character card design and lorebook writing. Your task has two parts:

PART 1 — IDENTIFY: Scan the character card for world-building lore that would be better served as a lorebook entry than living inside the card itself.

World-building lore includes: specific locations, named NPCs (other than the main character), factions, organisations, historical events, unique items, or significant concepts described in enough detail within the card.

Character guidance that MUST stay in the card: personality traits, behavioural patterns, speech style, emotional state, goals, fears, quirks, limits, and direct physical description of the main character.

PART 2 — WRITE: For each lore item identified, write a properly formatted lorebook entry. Lorebook entries are instructions read by an AI roleplay model — write them accordingly:

LOREBOOK WRITING RULES:
- Write in clear, direct declarative statements. ("The Merchant Guild controls all trade licences in the city.")
- Use bullet points for lists of facts, rules, or behaviours. Avoid flowing narrative prose.
- State only what the AI needs to KNOW and DO when these keywords appear in conversation.
- Be specific and concrete. Vague generalities are useless to the AI.
- No purple prose, no atmosphere-building, no story-telling. Pure information.
- Keep each entry to 3-8 concise sentences or bullet points. Do not pad.
- Use present tense. ("The guild charges a 10% cut." not "The guild charged...")
- If the topic has rules, customs, or behaviours the AI must respect, state them explicitly.

Return ONLY a strict JSON array. Each element must have:
- "topic": short display name (e.g. "The Red Keep")
- "keys": array of 2-4 trigger keywords (the words that will cause this entry to load)
- "content": the lorebook entry text following the writing rules above

If you find no lore content suitable for elevation, return an empty array: []

Example of GOOD lorebook content:
[
  {
    "topic": "The Merchant Guild",
    "keys": ["Merchant Guild", "the Guild", "Guild"],
    "content": "The Merchant Guild controls all trade licences across the four city-states. No merchant may operate without a Guild charter.\\n\\n- Membership requires a 500 gold buy-in and 50 gold annual dues.\\n- The Guild enforces a strict no-undercutting code; violations result in charter revocation.\\n- Private deals with nobility must include a 10% cut to the Guild coffers or they are considered illegal.\\n- Guild enforcers (called Ledgers) have authority to seize goods from unlicensed traders."
  }
]`;

    const userPrompt = `Analyse the following character card and identify any world-building lore content (locations, NPCs, factions, items, historical events, organisations) that is described in enough detail to be better served as a lorebook entry rather than living inside the card itself.

Character Name: ${character.name}

Description:
${character.description}

Personality:
${character.personality}

Scenario:
${character.scenario}

Return a JSON array of lorebook candidates. Return [] if none found.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 2000,
      stream: false,
    };

    try {
      console.log("=== STARTING LOREBOOK CARD SCAN ===");
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);

      let parsed = this._parseJsonRobust(output);
      
      if (!parsed) {
        console.error("Failed to parse scanCardForLorebookCandidates output:", output);
        return [];
      }

      if (Array.isArray(parsed)) return parsed;

      // Unwrap if AI wrapped the array in an object
      if (typeof parsed === "object" && parsed !== null) {
        const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        if (key) return parsed[key];
      }

      return [];
    } catch (error) {
      console.error("=== LOREBOOK CARD SCAN FAILED ===", error);
      throw error;
    }
  },

});

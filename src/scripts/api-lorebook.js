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

      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        const jsonMatch = output.match(/\[\s*".*?"\s*\]/s);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("No valid JSON array found in AI response for topics.");
        }
      }

      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === "object" && parsed !== null) {
        const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        if (key) return parsed[key];
      }

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

    const systemPrompt = `You are an expert in AI roleplay character card design. Your task is to analyse a character card and identify content that is world-building lore rather than character guidance.

World-building lore includes: specific locations, named NPCs (other than the main character), factions, organisations, historical events, unique items, or significant concepts that are described in detail within the card itself.

Character guidance that MUST stay in the card includes: the character's personality traits, behavioural patterns, speech style, emotional state, goals, fears, quirks, limits, and direct physical description.

For each lore item you identify, produce a lorebook entry: a concise factual summary of what the AI needs to know about that topic.

Return ONLY a strict JSON array. Each element must have:
- "topic": short display name (e.g. "The Red Keep")
- "keys": array of trigger keywords (2-4 strings)
- "content": 1-3 short paragraphs — factual, neutral, no purple prose

If you find no lore content suitable for elevation, return an empty array: []

Example:
[
  {
    "topic": "The Merchant Guild",
    "keys": ["Merchant Guild", "the Guild", "Guild"],
    "content": "The Merchant Guild controls trade across the four city-states. Membership requires a steep buy-in and annual dues. The Guild enforces a strict code: no undercutting, no private deals with nobility without a cut going to the Guild coffers."
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

      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        // Try to extract array from a wrapper object or markdown fence
        const arrayMatch = output.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          parsed = JSON.parse(arrayMatch[0]);
        } else {
          const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
          parsed = JSON.parse(cleaned);
        }
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

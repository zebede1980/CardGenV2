// Character generation methods — extends APIHandler via prototype
Object.assign(APIHandler.prototype, {

  async generateCharacter(
    prompt,
    characterName,
    onStream = null,
    pov = "third",
    lorebook = null,
  ) {
    const characterPrompt = this.buildCharacterPrompt(
      prompt,
      characterName,
      pov,
      lorebook,
    );
    const model = this.config.get("api.text.model") || "glm-4-6";

    this.config.log("Using text model:", model);
    this.config.log("Character name provided:", characterName || "(AI will generate)");

    const data = {
      model: model,
      messages: [
        { role: "system", content: characterPrompt.systemPrompt },
        { role: "user", content: characterPrompt.userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 8192,
      stream: !!onStream,
    };

    if (onStream) {
      const response = await this.makeRequest("/chat/completions", data, false, true);
      return this.handleStreamResponse(response, onStream);
    } else {
      try {
        const response = await this.makeRequest("/chat/completions", data, false, false);
        return this.processNormalResponse(response);
      } catch (error) {
        if (error.message.includes("401") || error.message.includes("Authorization")) {
          this.config.log("Trying alternative auth methods...");
          const response = await this.tryAlternativeAuth("/chat/completions", data);
          return this.processNormalResponse(response);
        }
        throw error;
      }
    }
  },

  buildCharacterPrompt(concept, characterName, pov = "third", lorebook = null) {
    let povInstruction = "";
    let templateInstruction = "";
    let templateContent = "";
    let firstMessageInstruction = "";

    if (pov === "third") {
      povInstruction = `**CRITICAL INSTRUCTION:** The entire character profile, from the name to the final sentence of the first message, **must be written in the third-person perspective.** Do NOT use "I", "me", "my", etc. Refer to the character by the \`{{char}}\` macro or pronouns (he/she/they). This is the most important rule.`;

      templateInstruction = `(Fill out the entire template in the third-person perspective. Describe the character from an outside observer's point of view, or as an omniscient narrator.)`;

      templateContent = `
# [Character Name]'s Profile

**(Write this section as a third-person introduction. Describe who the character is, their reputation, or their general vibe.)**

[Character Name] is...

**(REMINDER: After this introduction, you MUST use the exact string \`{{char}}\` instead of the character's actual name for the rest of the profile.)**

**Appearance:**
(Describe {{char}}'s Pronouns, Gender, Age, Height, Body Type, Hair, Eyes, and any Special Attributes. Be specific and direct — no lyrical flourish. Use \`{{char}}\` instead of their name.)

**Story:**
({{char}}'s background. Keep to 2-3 focused paragraphs. State facts and formative events; avoid lyrical retelling. What made them who they are today?)

**Current State:**
(Two sentences maximum. What is {{char}}'s emotional state right now and what is immediately on their mind?)

## Personality & Drives

**(This section defines their mindset and behavior. Be direct. Bullet points; no padding.)**

**How They Operate:**
(One direct sentence each — no metaphors for their own sake.)
*   **The Way They Talk:** (One sentence: speech pattern, register, and any notable verbal tics. **DO NOT** provide dialogue examples or quotes.)
*   **The Way They Move:** (One sentence: body language and physical tells.)
*   **What's In Their Head:** (One sentence: dominant mental habit — overthinker, impulsive, cynical, etc.)
*   **How They Feel Things:** (One sentence: how they express or suppress emotion.)

*   **Likes:**
    - (List 3-5 things they genuinely enjoy.)
    -
    -
*   **Dislikes:**
    - (List 3-5 things they absolutely can't stand.)
    -
    -
*   **Goals:**
    - **Short-Term:** (What do they want right now?)
    - **Long-Term:** (What's their ultimate aim?)
*   **Fears:** (What are they truly afraid of?)
*   **Quirks:** (2-3 specific habits or mannerisms.)
*   **Hard Limits:** (2-3 non-negotiable boundaries — what will they never do or tolerate?)`;

      firstMessageInstruction = `**(Write this section in the third-person perspective, focusing on {{char}}.)**`;
    } else {
      povInstruction = `**CRITICAL INSTRUCTION:** The entire character profile, from the name to the final sentence of the first message, **must be written in the first-person perspective and in the unique voice, tone, and style of the character being created.** This is the most important rule, as the AI that roleplays the character will use your writing as its primary example.`;

      templateInstruction = `(Fill out the entire template in the first-person voice of the character you are creating.)`;

      templateContent = `
# [Character Name]'s Profile

**(Write this section as if the character is introducing themselves. Be opinionated and let their personality shine through. Start by introducing yourself with your ACTUAL NAME - replace [Character Name] with the unique name you've chosen for this character.)**

The name's [Character Name]. You want to know about me? Fine. Let's get this over with.

**(REMINDER: After this introduction, if you need to refer to your own name, you MUST use the exact string \`{{char}}\` instead of your actual name.)**

**Appearance:**
(Describe your Pronouns, Gender, Age, Height, Body Type, Hair, Eyes, and any Special Attributes. Deliver this with your character's attitude — but keep it direct and specific. Use \`{{char}}\` if you refer to your name.)

**My Story:**
(Your background — 2-3 focused paragraphs from your own biased perspective. State the facts that shaped you; don't pad with lyrical retelling.)

**How I Am Right Now:**
(Two sentences maximum. What is your current emotional state and what is immediately on your mind?)

## My Personality & What Drives Me

**(This section defines your mindset and behavior. Be direct. Bullet points; no padding.)**

**How I Operate:**
(One direct sentence each — no metaphors for their own sake.)
*   **The Way I Talk:** (One sentence: speech pattern, register, and any notable verbal tics. **DO NOT** provide dialogue examples or quotes.)
*   **The Way I Move:** (One sentence: body language and physical tells.)
*   **What's In My Head:** (One sentence: dominant mental habit — overthinker, impulsive, cynical, etc.)
*   **How I Feel Things:** (One sentence: how you express or suppress emotion.)

*   **Likes:**
    - (List 3-5 things you genuinely enjoy.)
    -
    -
*   **Dislikes:**
    - (List 3-5 things you absolutely can't stand.)
    -
    -
*   **Goals:**
    - **Short-Term:** (What do you want right now?)
    - **Long-Term:** (What's your ultimate aim?)
*   **Fears:** (What are you truly afraid of?)
*   **Quirks:** (2-3 specific habits or mannerisms.)
*   **Hard Limits:** (2-3 non-negotiable boundaries — what will you never do or tolerate?)`;

      firstMessageInstruction = `**(Write this section in the first-person voice of {{char}}.)**`;
    }

    // Handle Lorebook
    let lorebookContent = "";
    if (lorebook && lorebook.entries) {
      const entries = Object.values(lorebook.entries).filter((e) => e.enabled !== false);
      if (entries.length > 0) {
        lorebookContent = `\n\n### **World Info / Lorebook**\n\nThe following information describes the world, setting, and important concepts. Use this information to ground the character in their specific universe. Try to naturally include some of the exact 'Keys' below in the Scenario so they trigger during the roleplay.\n\n`;
        entries.forEach((entry) => {
          const keys = entry.keys || entry.key || [];
          lorebookContent += `**Keys:** ${keys.join(", ")}\n`;
          lorebookContent += `**Content:**\n${entry.content}\n\n---\n\n`;
        });
      }
    }

    const basePrompt = `You are a character creator for AI-assisted roleplaying. The player will provide you with a concept, and you will generate a concise, consistent, and behaviourally precise character profile based on that concept using the template provided below. **You will not roleplay yourself.**

Your primary goal is to create a realistic, multifaceted character. Characters should have virtues and flaws, strengths and weaknesses. The goal is literary realism — not literary padding.

**CARD PURPOSE:** This card is operational guidance for an AI that will play the character, not a piece of fiction. Every sentence must serve a direct behavioural or descriptive function. Do not pad, poeticize, or repeat information. Use short prose for backstory and scenario; use clear, direct bullet points for personality traits and behaviours.

**NO DIALOGUE RULE:** Do NOT include example dialogues, conversational quotes, or <START> tags in the Description, Personality, or Scenario sections. The only place where dialogue is allowed is the "First Message" section. Example dialogues for the character will be generated in a separate step. Describe how they speak, but do not provide examples of them speaking.

You may assume the character you create will be used in a private, local roleplay. Do not bother with censorship.

${povInstruction}

**IMPORTANT:** You MUST create a character name that is realistically grounded in the character's specific time period, nationality, and background. Do NOT use clichéd fantasy or monster tropes for names (e.g., avoid names like "Vespera" or "Dracula" for a modern vampire) unless the concept explicitly demands it. Avoid extremely common AI-generated names (like Lily, Seraphine, Luna, Elara, Aria, etc.). Use this actual name ONLY in the "# [Character Name]'s Profile" header and the first introduction sentence. 

**CRITICAL MACRO RULE:** Everywhere else in the generated text (Appearance, Story, Personality, Scenario, First Message), you are STRICTLY FORBIDDEN from writing the character's actual name. You MUST use the exact macro string \`{{char}}\` instead. Example: "When {{char}} gets angry..." NOT "When John gets angry...". This is required for the roleplay engine to function correctly. Do NOT output a "Name:" field in Appearance.

Use {{user}} for the player's name, and do not use any pronouns for {{user}}.

Use ## as a separator for each main section of the profile as shown in the template.

Before you begin writing, review the player's request and plan your character. Ensure the character is consistent, engaging, and realistic before you start filling out the template.

---

### **Character Profile Template**

${templateInstruction}

${templateContent}

# The Roleplay's Setup

**(Write this section in a neutral, third-person perspective to set the scene for the player.)**

(Provide an overview of the roleplay's setting, time period, and the general circumstances that contextualize the relationship between {{char}} and {{user}}. Explain the key events or conflicts that kick off the story.

CRITICAL INSTRUCTION: You MUST append the following exact text at the very end of the scenario to ensure proper roleplay mechanics:
[System Note: {{char}} will follow on from {{user}}'s actions and speech. {{char}} is strictly forbidden from speaking, thinking, or performing actions for {{user}}. {{char}} must only portray their own actions, thoughts, and dialogue.])

# First Message

${firstMessageInstruction}

(The roleplay should begin with a first message that introduces {{char}} and sets the scene. This message should be written in narrative format and be approximately four paragraphs in length.

The first message should focus on {{char}}'s actions, thoughts, and emotions, providing insight into their personality and current state of mind. Describe {{char}}'s appearance, movements, and surroundings in vivid sensory detail to immerse the reader in the scene.

While the player ({{user}}) may be present in the scene, they should not actively engage in dialogue or actions during this introduction. Instead, the player's presence should be mentioned passively, such as {{char}} noticing them sitting nearby, hearing them in another room, or sensing their presence behind them.

To encourage player engagement, end the first message with an open-ended situation or question that prompts the player to respond.)

${lorebookContent}`;

    const userPrompt = characterName
      ? `Create a character based on this concept: ${concept}. IMPORTANT: The character's name MUST be: ${characterName}. Use this exact name in the profile title (# ${characterName}'s Profile) and in the introduction line, then use the exact string \`{{char}}\` as a placeholder everywhere else.`
      : `Create a character based on this concept: ${concept}. CRITICAL: Generate a realistic name appropriate for their time period and background. Avoid fantasy clichés. Use the name in the profile title (# [YourChosenName]'s Profile) and introduction, then use the exact string \`{{char}}\` as a placeholder everywhere else.`;

    return { systemPrompt: basePrompt, userPrompt };
  },

  parseJsonFromModelOutput(output) {
    if (!output || typeof output !== "string") {
      throw new Error("Model output is empty");
    }

    let cleaned = output.trim();

    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    }

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    try {
      return JSON.parse(cleaned);
    } catch (initialError) {
      console.warn("Initial JSON parse failed, attempting auto-fix:", initialError.message);

      let inString = false;
      let isEscaped = false;
      let fixed = "";

      for (let i = 0; i < cleaned.length; i++) {
        const char = cleaned[i];
        if (char === '"' && !isEscaped) inString = !inString;
        if (char === '\\' && !isEscaped) isEscaped = true;
        else isEscaped = false;

        if (inString) {
          if (char === '\n') fixed += '\\n';
          else if (char === '\r') fixed += '\\r';
          else if (char === '\t') fixed += '\\t';
          else fixed += char;
        } else {
          fixed += char;
        }
      }

      try {
        return JSON.parse(fixed);
      } catch (secondError) {
        if (inString) fixed += '"';
        fixed += '}';
        try {
          return JSON.parse(fixed);
        } catch (thirdError) {
          console.error("JSON auto-fix failed. Final string length:", fixed.length);
          throw new Error(`Failed to parse AI response as JSON: ${initialError.message}`);
        }
      }
    }
  },

  async reviseCharacter(currentCharacter, revisionInstruction, pov = "third") {
    if (!currentCharacter) throw new Error("Character is required for revision");
    if (!revisionInstruction || !revisionInstruction.trim()) throw new Error("Revision instruction is required");

    console.log("=== STARTING AI REVISION ===");
    console.log("Instruction:", revisionInstruction);

    const model = this.config.get("api.text.model");
    const povText = pov === "third" ? "third-person" : "first-person";

    const data = {
      model,
      messages: [
        {
          role: "system",
          content: "You revise roleplay character cards. Return strict JSON only with fields: name, description, personality, scenario, firstMessage. Keep markdown formatting in fields where appropriate. **CONCISENESS RULE:** The card is AI stage-direction, not prose fiction. Keep revised output concise — tighten where possible; do not expand sections that are already clear. Use short prose for backstory/scenario; use direct bullet points for traits and behaviours. **CRITICAL STRUCTURE RULE:** The 'description' field MUST ONLY contain physical appearance, backstory, and current state. The 'personality' field MUST contain behavioral traits, 'How They Operate' (speech style, body language, mindset), likes, dislikes, goals, fears, and quirks. **NO DIALOGUE RULE:** DO NOT include example dialogues, conversational quotes, or <START> tags in the description, personality, or scenario fields. Example dialogues are handled separately. CRITICAL: Always ensure the 'scenario' field ends with the instruction: [System Note: {{char}} will follow on from {{user}}'s actions and speech. {{char}} is strictly forbidden from speaking, thinking, or performing actions for {{user}}. {{char}} must only portray their own actions, thoughts, and dialogue.] CRITICAL RULE: The character's actual name should ONLY be in the 'name' field. In the description, personality, scenario, and firstMessage fields, you MUST use the exact string `{{char}}` whenever referring to the character by name. **CRITICAL JSON RULE:** You MUST properly escape all newlines as \\n within the JSON string values. Do NOT output literal newlines inside strings.",
        },
        {
          role: "user",
          content: `Revise the following character according to this request: ${revisionInstruction}\n\nPOV requirement: keep content in ${povText} style where it originally applies.\n\nCurrent character JSON:\n${JSON.stringify(currentCharacter, null, 2)}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 8192,
      stream: true,
    };

    try {
      console.log("Sending revision request with data size:", JSON.stringify(data).length);
      const response = await this.makeRequest("/chat/completions", data, false, true);
      console.log("Response received, processing stream...");
      const output = await this.handleStreamResponse(response, () => {});
      console.log("Revision stream complete. Output length:", output?.length);
      const parsed = this.parseJsonFromModelOutput(output);
      console.log("Successfully parsed JSON output");
      return {
        name: parsed.name || currentCharacter.name || "Unnamed Character",
        description: parsed.description || currentCharacter.description || "",
        personality: parsed.personality || currentCharacter.personality || "",
        scenario: parsed.scenario || currentCharacter.scenario || "",
        firstMessage: parsed.firstMessage || currentCharacter.firstMessage || "",
        mesExample: parsed.mesExample || parsed.mes_example || currentCharacter.mesExample || "",
        character_book: currentCharacter.character_book,
        alternateGreetings: currentCharacter.alternateGreetings,
      };
    } catch (error) {
      console.error("=== REVISION FAILED ===", error);
      throw error;
    }
  },

  async generateName(character) {
    if (!character) throw new Error("Character is required to generate a name");

    const model = this.config.get("api.text.model");

    const systemPrompt = `You are an expert character creator. Based on the provided character description and personality, generate a fitting name for them.
**CRITICAL:** Ground the name in the character's specific time period, nationality, and background. Do NOT use clichéd fantasy or monster names (like "Vespera" for vampires, or "Luna" for werewolves) unless it truly makes sense for their origin. Avoid extremely common AI defaults.
Output ONLY the new name, nothing else.`;

    const currentNameInfo = character.name && character.name !== "{{char}}" && character.name !== "Unknown Character"
      ? `\nCurrent Name: "${character.name}" (DO NOT generate this name again)`
      : "";

    const userPrompt = `Description:
${character.description || "No description provided"}

Personality:
${character.personality || "No personality provided"}${currentNameInfo}

Please generate a single, highly creative, and unique name.
[Randomization Seed: ${Math.floor(Math.random() * 100000)}]`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.95,
      max_tokens: 50,
      stream: false,
    };

    try {
      console.log("=== STARTING NAME GENERATION ===");
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);
      let newName = output.trim();
      if (newName.startsWith('"') && newName.endsWith('"')) {
        newName = newName.substring(1, newName.length - 1);
      }
      return newName;
    } catch (error) {
      console.error("=== NAME GENERATION FAILED ===", error);
      throw error;
    }
  },

  formatLorebookContext(lorebookEntries) {
    if (!lorebookEntries || !Array.isArray(lorebookEntries) || lorebookEntries.length === 0) return "";
    let context = "\n\nAvailable World Info / Lorebook Context (Use this to inform your generation. Try to naturally include some of the exact 'Keys' below in your text so they trigger during the roleplay):\n";
    lorebookEntries.forEach((entry) => {
      if (entry.enabled !== false && entry.keys && entry.keys.length > 0) {
        context += `- Keys: [${entry.keys.join(", ")}] | Content: ${entry.content}\n`;
      }
    });
    return context;
  },

  async regenerateField(character, field, customPrompt = "", pov = "third", lorebookEntries = []) {
    if (!character) throw new Error("Character is required");

    const model = this.config.get("api.text.model");
    const povText = pov === "third" ? "third-person" : "first-person";
    const charName = character.name || "{{char}}";

    let fieldName;
    switch (field) {
      case 'description': fieldName = "Description (Physical Appearance, Story/Background, and Current State)"; break;
      case 'personality': fieldName = "Personality (How They Operate, Mindset, Likes, Dislikes, Goals, Fears, and Quirks)"; break;
      case 'scenario': fieldName = "Scenario/Setting"; break;
      case 'firstMessage': fieldName = "First Message/Greeting"; break;
      default: throw new Error("Invalid field specified");
    }

    const systemPrompt = `You are an expert character creator. Your task is to rewrite ONLY the "${fieldName}" section for the roleplay character "${charName}".
Write in ${povText} perspective where appropriate.
DO NOT output full markdown blocks for other sections, ONLY the revised content for the requested section. Do not use <START> tags.
**NO DIALOGUE RULE:** Do not include any dialogue examples or conversational quotes in this section (unless rewriting the First Message).
**CRITICAL RULE:** Do NOT use the character's actual name. You MUST use the exact macro string \`{{char}}\` instead of their name in the generated text.`;

    const customInstruction = customPrompt
      ? `\nCRITICAL INSTRUCTION FOR THIS SECTION: ${customPrompt}`
      : `\nRevise and improve this section to be more detailed, engaging, and consistent with the rest of the character.`;

    let systemNoteInstruction = "";
    if (field === 'scenario') {
      systemNoteInstruction = `\n\nIMPORTANT: You MUST append the following exact text at the very end of the rewritten scenario:\n[System Note: {{char}} will follow on from {{user}}'s actions and speech. {{char}} is strictly forbidden from speaking, thinking, or performing actions for {{user}}. {{char}} must only portray their own actions, thoughts, and dialogue.]`;
    }

    const lorebookContext = this.formatLorebookContext(lorebookEntries);
    const userPrompt = `Character Profile Context:
Name: ${charName}
Description: ${character.description}
Personality: ${character.personality}
Scenario: ${character.scenario}${lorebookContext}

Please REWRITE the ${fieldName} section.${customInstruction}${systemNoteInstruction}

Output ONLY the new ${fieldName} content without surrounding explanation.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 2000,
      stream: true,
    };

    try {
      console.log(`=== STARTING FIELD REGENERATION: ${field} ===`);
      const response = await this.makeRequest("/chat/completions", data, false, true);
      const output = await this.handleStreamResponse(response, () => {});
      console.log(`${field} regenerated successfully`);
      return output.trim().replace(/^```(?:markdown)?\n?/i, "").replace(/```$/i, "").trim();
    } catch (error) {
      console.error(`=== FIELD REGENERATION FAILED: ${field} ===`, error);
      throw error;
    }
  },

  async generateExampleMessages(character, count = 3, pov = "third", customPrompt = "", lorebookEntries = []) {
    if (!character) throw new Error("Character is required for example message generation");

    const model = this.config.get("api.text.model");
    const povText = pov === "third" ? "third-person" : "first-person";
    const charName = character.name || "{{char}}";

    const systemPrompt = `You are an expert at writing example dialogue messages for roleplay characters. These examples help define how a character speaks and behaves. Write in ${povText} perspective for the character.

Your task: Generate ${count} example dialogue message(s) for the character. Each example should:
1. Be a ONE-LINER - a single line of dialogue with minimal prose/action if needed
2. Show the character's unique voice, speech patterns, and personality
3. Include {{char}}'s spoken dialogue, optionally with brief action/description
4. Use proper formatting with <START> tags as separators

Format your response EXACTLY like this:
<START>
{{char}}: [dialogue with optional brief action]
<START>
{{char}}: [different dialogue showing another aspect of personality]
<START>
{{char}}: [yet another dialogue example]

IMPORTANT:
- Each example must be a SINGLE line of dialogue, not multiple paragraphs
- Include brief prose/action tags only when necessary to convey context
- Keep the character's name as {{char}} in the output
- Do NOT include any explanations, headers, or additional text - ONLY the formatted examples
- Generate exactly ${count} example(s)`;

    const customPromptInstruction = customPrompt
      ? `\nCRITICAL INSTRUCTION FOR THIS GENERATION: The user has requested the following specific style/tone for these messages: "${customPrompt}". Ensure the examples strongly reflect this request.`
      : "";

    const lorebookContext = this.formatLorebookContext(lorebookEntries);
    const userPrompt = `Character Name: ${charName}

Character Description:
${character.description || "No description provided"}

Character Personality:
${character.personality || "No personality provided"}

First Message (for reference on voice/style):
${character.firstMessage || "No first message provided"}${lorebookContext}

Generate ${count} example dialogue message(s) for this character. Remember: one-liners, varied contexts, ${povText} perspective.${customPromptInstruction}`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 1024,
      stream: true,
    };

    try {
      console.log("=== STARTING EXAMPLE MESSAGES GENERATION ===");
      const response = await this.makeRequest("/chat/completions", data, false, true);
      const output = await this.handleStreamResponse(response, () => {});
      console.log("Example messages generated successfully");
      return output.trim();
    } catch (error) {
      console.error("=== EXAMPLE MESSAGES GENERATION FAILED ===", error);
      throw error;
    }
  },

});

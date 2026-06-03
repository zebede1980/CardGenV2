// Character generation methods — extends APIHandler via prototype
Object.assign(APIHandler.prototype, {

  async generateCharacter(
    prompt,
    characterName,
    onStream = null,
    pov = "third",
    lorebook = null,
    cardType = "single",
  ) {
    const characterPrompt = this.buildCharacterPrompt(
      prompt,
      characterName,
      pov,
      lorebook,
      cardType,
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

  // Silent (non-streaming) character generation for batch use
  async generateCharacterSilent(prompt, characterName, pov = "third", lorebook = null, cardType = "single") {
    return this.generateCharacter(prompt, characterName, null, pov, lorebook, cardType);
  },

  /**
   * Generate a character with web-search-augmented prompt.
   * Uses buildSearchAugmentedPrompt to weave verified details into the LLM prompt.
   */
  async generateCharacterWithSearch(
    prompt, characterName, searchResults, onStream = null, pov = "third", lorebook = null, cardType = "single",
  ) {
    const characterPrompt = this.buildSearchAugmentedPrompt(
      prompt, characterName, searchResults, pov, lorebook, cardType,
    );
    const model = this.config.get("api.text.model") || "glm-4-6";

    this.config.log("Using text model:", model);
    this.config.log("Character name provided:", characterName || "(AI will generate)");
    this.config.log("Search-augmented prompt: using", (characterPrompt.systemPrompt || "").length, "system chars");

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

  /**
   * Build a search-augmented character prompt by injecting verified web
   * details directly into the system prompt before the template section.
   */
  buildSearchAugmentedPrompt(concept, characterName, searchResults, pov = "third", lorebook = null, cardType = "single") {
    // Delegate non-single card types to existing builders unchanged
    if (cardType === "group") return this._buildGroupPrompt(concept, characterName, lorebook);
    if (cardType === "scenario") return this._buildScenarioPrompt(concept, characterName, lorebook);

    // Start with the existing base prompts
    const basePrompt = this.buildCharacterPrompt(concept, characterName, pov, lorebook, cardType);

    // Build the verified-details injection block
    const sections = [];
    sections.push("---");
    sections.push("");
    sections.push("**🔍 VERIFIED CHARACTER DETAILS (from web search):**");
    sections.push("");
    sections.push("The following details about this character/person were found via web search. **You MUST use these verified details as the ground truth for your generation.** Do not contradict or invent alternative facts where these details exist.");

    if (searchResults.biographical) {
      sections.push("");
      sections.push("**Biographical / Background:**");
      sections.push(searchResults.biographical);
    }
    if (searchResults.appearance) {
      sections.push("");
      sections.push("**Physical Appearance:**");
      sections.push(searchResults.appearance);
    }
    if (searchResults.personality) {
      sections.push("");
      sections.push("**Personality / Character Traits:**");
      sections.push(searchResults.personality);
    }
    if (searchResults.keyFacts) {
      sections.push("");
      sections.push("**Key Facts / Notable Details:**");
      sections.push(searchResults.keyFacts);
    }

    sections.push("");
    sections.push("**IMPORTANT:** Use these verified details for accuracy. If the character is a fictional character from a specific work, set the scenario in that universe. If it's a real person, ground the character in reality.");
    sections.push("---");

    const injectedBlock = sections.join("\n");

    // Insert the search context right before the template header
    const insertionMarker = "### **Character Profile Template**";
    const insertionPoint = basePrompt.systemPrompt.indexOf(insertionMarker);
    if (insertionPoint !== -1) {
      basePrompt.systemPrompt =
        basePrompt.systemPrompt.slice(0, insertionPoint) +
        injectedBlock + "\n\n" +
        basePrompt.systemPrompt.slice(insertionPoint);
    } else {
      basePrompt.systemPrompt += "\n\n" + injectedBlock;
    }

    return basePrompt;
  },

  /**
   * Randomly picks a cultural naming tradition on each call.
   * Injected into name prompts so every generation is pushed into a different
   * cultural space, breaking the AI's tendency to default to Anglo surnames.
   */
  _pickNameStyle() {
    const styles = [
      "Eastern European — Polish, Czech, Slovak, or Romanian",
      "Slavic — Russian, Ukrainian, Bulgarian, or Serbian",
      "Scandinavian — Norwegian, Swedish, Danish, or Icelandic",
      "Celtic — Welsh, Scottish Gaelic, Irish Gaelic, or Breton",
      "Iberian — Spanish, Portuguese, Catalan, or Basque",
      "Italian or Sicilian",
      "Greek — modern or classical",
      "Turkish, Azerbaijani, or Uzbek",
      "Arabic — Levantine, Gulf, or North African",
      "Persian or Dari",
      "South Asian — Hindi, Bengali, Tamil, Punjabi, or Urdu",
      "Japanese",
      "Korean",
      "Chinese — Mandarin or Cantonese romanisation",
      "Vietnamese or Thai",
      "Filipino or Tagalog",
      "West African — Yoruba, Igbo, Akan, or Hausa",
      "East African — Swahili, Amharic, or Somali",
      "Southern African — Zulu, Xhosa, or Shona",
      "Hebrew or Yiddish",
      "Armenian or Georgian",
      "Finnish, Estonian, or Sami",
      "Baltic — Lithuanian or Latvian",
      "Hungarian or Magyar",
      "Dutch or Flemish",
      "German or Austrian",
      "French or Occitan",
      "Albanian or Macedonian",
      "Mongolian, Kazakh, or Kyrgyz",
      "Indigenous Mesoamerican — Nahuatl or Maya inspired",
    ];
    return styles[Math.floor(Math.random() * styles.length)];
  },

  buildCharacterPrompt(concept, characterName, pov = "third", lorebook = null, cardType = "single") {
    // Delegate to type-specific builders
    if (cardType === "group") return this._buildGroupPrompt(concept, characterName, lorebook);
    if (cardType === "scenario") return this._buildScenarioPrompt(concept, characterName, lorebook);

    const nameStyle = this._pickNameStyle();
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
    const lorebookContent = this._buildLorebookContent(lorebook);

    const basePrompt = `You are a character creator for AI-assisted roleplaying. The player will provide you with a concept, and you will generate a concise, consistent, and behaviourally precise character profile based on that concept using the template provided below. **You will not roleplay yourself.**

Your primary goal is to create a realistic, multifaceted character. Characters should have virtues and flaws, strengths and weaknesses. The goal is literary realism — not literary padding.

**CARD PURPOSE:** This card is operational guidance for an AI that will play the character, not a piece of fiction. Every sentence must serve a direct behavioural or descriptive function. Do not pad, poeticize, or repeat information. Use short prose for backstory and scenario; use clear, direct bullet points for personality traits and behaviours.

**NO DIALOGUE RULE:** Do NOT include example dialogues, conversational quotes, or <START> tags in the Description, Personality, or Scenario sections. The only place where dialogue is allowed is the "First Message" section. Example dialogues for the character will be generated in a separate step. Describe how they speak, but do not provide examples of them speaking.

You may assume the character you create will be used in a private, local roleplay. Do not bother with censorship.

${povInstruction}

**NAME — CULTURAL DIVERSITY REQUIRED:** For this character's name, draw from a **${nameStyle}** naming tradition. Use authentic first names and surnames (or single names where culturally appropriate) from that tradition. Exception: if the player's concept explicitly places the character in a clearly different culture or time period, use whatever is most historically and geographically accurate for that context — but in either case do NOT fall back to generic Anglo-American defaults.

**BANNED — do NOT use any of the following overused AI-generated names:**
- Surnames: Voss, Mercer, Drake, Kane, Vale, Stone, Cross, Hart, Crane, Black, Grey, White, Storm, Rowe, Quinn, Pierce, Hayes, Cole, Fox, Grant, Ward, Shaw, Reid, Ash, Dusk, Hale, Mace, Reed, Price, Blair
- Female first names: Aria, Elara, Lyra, Luna, Seraphine, Lily, Nova, Aurora, Celeste, Iris, Zara, Ember, Vivienne, Scarlett, Isolde, Evelyn, Clara, Selene, Freya, Nyx, Raven
- Male first names: Cael, Rael, Zael, Theron, Oryn, Aiden, Caden, Brayden
- Any two-syllable name ending in "-ael", "-iel", or "-yn" unless the concept is explicitly high fantasy

Use this actual name ONLY in the "# [Character Name]'s Profile" header and the first introduction sentence.

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

  _buildLorebookContent(lorebook) {
    if (!lorebook || !lorebook.entries) return "";
    const entries = Object.values(lorebook.entries).filter((e) => e.enabled !== false);
    if (!entries.length) return "";
    let lorebookContent = "\n\n### **World Info / Lorebook**\n\nThe following information describes the world, setting, and important concepts. Use this information to ground the content in its specific universe. Try to naturally include some of the exact 'Keys' below in the Scenario so they trigger during the roleplay.\n\n";
    entries.forEach((entry) => {
      const keys = entry.keys || entry.key || [];
      lorebookContent += `**Keys:** ${keys.join(", ")}\n`;
      lorebookContent += `**Content:**\n${entry.content}\n\n---\n\n`;
    });
    return lorebookContent;
  },

  _buildGroupPrompt(concept, groupName, lorebook) {
    const lorebookContent = this._buildLorebookContent(lorebook);

    const systemPrompt = `You are a group card creator for AI-assisted roleplaying. The player will provide a concept and you will generate a cohesive group card — a profile for two to four connected characters who function as a unit (a gang, a crew, a party, a band, a family, etc.).

**CARD PURPOSE:** This card is operational guidance for an AI that will voice the group collectively. The AI will embody {{char}} as the group's collective identity, differentiating individual members through named dialogue and described actions.

**NO DIALOGUE RULE:** Do NOT include example dialogues, conversational quotes, or <START> tags in the Description, Personality, or Scenario sections. The only place where dialogue is allowed is the "First Message" section.

**PERSPECTIVE:** Write the entire card in the third-person perspective. Do NOT use "I", "me", or "my". Refer to the group collectively as {{char}} and individual members by their first name.

**{{char}} MACRO:** {{char}} = the group's collective name (e.g. "The Red Cobras"). Use it everywhere except in the # Profile header and the opening introduction sentence. Individual member names are NOT replaced — they appear as-is throughout the card.

**MACRO RULE FOR {{user}}:** Use {{user}} for the player character. Do not assign pronouns or a name to {{user}}.

You may assume this card will be used in a private, local roleplay. Do not apply censorship.

Use ## as a separator for each main section as shown in the template.`;

    const templateContent = `
# [Group Name]'s Profile

(Write one paragraph introducing the group — what they are, what they do, their reputation, and their collective vibe. Use the actual group name here ONLY in this header and this opening paragraph.)

(REMINDER: After this introduction, use the exact string \`{{char}}\` instead of the group's actual name everywhere else.)

## Members

(List each member in this exact sub-format. Include 2–4 members.)

### [Member Name] — [Role in group]

**Appearance:** (Gender, approximate age, build, hair, eyes, distinguishing features. Be specific and direct.)
**Personality:** (Two to three sentences: dominant traits, how they behave under pressure, what drives them.)
**Voice:** (One sentence describing their speech pattern, register, and any verbal tics.)

(Repeat the above block for each member.)

## Group Dynamics

*   **Hierarchy:** (Who leads and why. Is it contested? Who defers to whom?)
*   **Bonds:** (What holds them together — shared history, mutual need, loyalty, ideology?)
*   **Tensions:** (What internal friction exists? Unspoken rivalries, conflicting goals, past grievances?)
*   **Shared Goal:** (What do they all want right now, short and long term?)
*   **Quirks:** (2–3 habits or rituals the group shares — things they always do together.)

## Personality & Drives

**How {{char}} Operates as a Unit:**
*   **How They Talk:** (One sentence: the group's collective communication style — do they finish each other's sentences, defer to the leader, speak in code?)
*   **How They Move:** (One sentence: how do they present physically as a group — do they form a wall, spread out, cluster nervously?)
*   **Collective Mood:** (One sentence: the group's prevailing emotional tone right now.)
*   **Likes:** (3–5 things the group collectively enjoys or values.)
*   **Dislikes:** (3–5 things they all can't stand.)
*   **Hard Limits:** (2–3 lines the group will never cross as a unit.)

# The Roleplay's Setup

(Neutral third-person overview of the setting, time period, and circumstances. Explain who {{user}} is in relation to {{char}} and what situation kicks off the roleplay.

CRITICAL INSTRUCTION: Append this exact text at the very end of the scenario:
[System Note: {{char}} will follow on from {{user}}'s actions and speech. When voicing individual members, {{char}} must clearly identify who is speaking or acting. {{char}} is strictly forbidden from speaking, thinking, or performing actions for {{user}}. {{char}} must only portray the group's own actions, thoughts, and dialogue.])

# First Message

(Write a group scene opening in the third-person. Introduce the group in action — show at least two members doing something distinct that reveals their personalities. Describe the environment in vivid sensory detail. {{user}}'s presence should be passive at first — they are noticed, but not yet engaged. End with an open-ended situation or question that invites {{user}} to respond.)

${lorebookContent}`;

    const userPrompt = groupName
      ? `Create a group card based on this concept: ${concept}. IMPORTANT: The group's name MUST be: ${groupName}. Use this exact name in the profile title (# ${groupName}'s Profile) and the introduction paragraph, then use \`{{char}}\` as the placeholder everywhere else.`
      : `Create a group card based on this concept: ${concept}. CRITICAL: Invent a fitting, memorable group name appropriate for their concept. Use it in the profile title (# [YourChosenName]'s Profile) and the introduction, then use \`{{char}}\` everywhere else.`;

    return { systemPrompt, userPrompt: `${userPrompt}\n\nTemplate to fill:\n${templateContent}` };
  },

  _buildScenarioPrompt(concept, scenarioTitle, lorebook) {
    const lorebookContent = this._buildLorebookContent(lorebook);

    const systemPrompt = `You are a scenario card creator for AI-assisted roleplaying. The player will provide a concept and you will generate a location/scenario card — a profile for a place, establishment, or situation that the player will explore.

**CARD PURPOSE:** This card is operational guidance for an AI that will act as an omniscient narrator for the scenario, voicing any NPCs that inhabit the location as needed.

**NO DIALOGUE RULE:** Do NOT include example dialogues, conversational quotes, or <START> tags in the Description, Personality, or Scenario sections. The only place where dialogue is allowed is the "First Message" section.

**PERSPECTIVE:** Write the entire card in the third-person perspective. Use {{char}} as the placeholder for the scenario's title/name (e.g. "The Haunted Lighthouse") everywhere except the profile header and the opening paragraph.

**{{char}} MACRO:** {{char}} = the scenario/location title. An AI playing this card will narrate events AS the scenario, voicing NPCs by name as they appear. Use {{user}} for the player character.

You may assume this card will be used in a private, local roleplay. Do not apply censorship.

Use ## as a separator for each main section as shown in the template.`;

    const templateContent = `
# [Scenario Title]

(Write one paragraph that establishes what this place or situation IS — its nature, its reputation, and its immediate atmosphere. Use the actual scenario title here ONLY in this header and this opening paragraph.)

(REMINDER: After this introduction, use the exact string \`{{char}}\` instead of the scenario's title everywhere else.)

## The Setting

**Time & Place:** (When and where this is — era, country/region, specific location type.)
**Physical Description:** (What does it look, sound, and smell like? 3–5 vivid sensory details that define the atmosphere.)
**Layout:** (Key areas or rooms that matter for the roleplay — described briefly so the AI can navigate them.)
**Mood & Atmosphere:** (The dominant emotional quality — oppressive, festive, eerie, chaotic, sacred — and what causes it.)

## The Situation

**The Hook:** (What is happening right now that draws {{user}} into this scenario? One concrete inciting event or circumstance.)
**The Conflict:** (What tension or problem defines this location at this moment? What is at stake?)
**Secrets:** (2–3 things that are not immediately obvious but can be discovered — hidden rooms, suppressed histories, concealed agendas.)

## Key People

(List 2–4 NPCs that inhabit this scenario. Each is voiced by {{char}} when encountered.)

### [NPC Name] — [Role/function in this location]

**Appearance:** (Gender, approximate age, distinctive visual features. One to two sentences.)
**Personality & Motive:** (Two sentences: how they behave, what they want, and what they are hiding or protecting.)

(Repeat the block for each NPC.)

## Rules of This World

*   **What Is Normal Here:** (2–3 things that are taken for granted in this scenario's logic.)
*   **What Is Forbidden or Dangerous:** (2–3 things that carry consequences — social, physical, or supernatural.)
*   **What Can Change:** (2–3 things that are in flux and can be affected by {{user}}'s choices.)

## Personality & Drives

**The Scenario as a Force:**
*   **Dominant Theme:** (One sentence: the central emotional or philosophical theme this scenario explores.)
*   **Tone:** (One sentence: the tonal register — gritty noir, gothic horror, cosy mystery, high-stakes thriller, etc.)
*   **Recurring Motifs:** (2–3 images, sounds, or sensations that recur throughout this scenario.)
*   **What {{char}} Wants From {{user}}:** (One sentence: what the scenario "needs" from the player — to be solved, survived, escaped, transformed, or simply experienced.)

# The Roleplay's Setup

(Neutral third-person overview of the circumstances that bring {{user}} to this location right now. Who is {{user}} in relation to this place? What do they know, and what don't they know?

CRITICAL INSTRUCTION: Append this exact text at the very end of the scenario:
[System Note: {{char}} will narrate events in this scenario and voice any NPCs encountered. {{char}} is strictly forbidden from speaking, thinking, or performing actions for {{user}}. {{char}} must only portray the scenario's events, atmosphere, and NPC dialogue and actions.])

# First Message

(Write a scene-setting opening in the third-person. Place {{user}} at the threshold of the scenario — arriving, entering, discovering. Describe the environment in vivid sensory detail. Introduce one NPC or one immediate problem that creates a reason for {{user}} to act. End with an open-ended situation that invites {{user}} to respond.)

${lorebookContent}`;

    const userPrompt = scenarioTitle
      ? `Create a scenario card based on this concept: ${concept}. IMPORTANT: The scenario's title MUST be: ${scenarioTitle}. Use this exact title in the profile header (# ${scenarioTitle}) and the opening paragraph, then use \`{{char}}\` as the placeholder everywhere else.`
      : `Create a scenario card based on this concept: ${concept}. CRITICAL: Invent a fitting, evocative title for this scenario appropriate to its concept. Use it in the profile header (# [YourChosenTitle]) and the opening paragraph, then use \`{{char}}\` everywhere else.`;

    return { systemPrompt, userPrompt: `${userPrompt}\n\nTemplate to fill:\n${templateContent}` };
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
          content: (() => {
            // Strip character_book and alternateGreetings from the revision input —
            // the lorebook content is stored separately and should not be copied into
            // card fields; alternateGreetings are preserved on the return value.
            const { character_book: _book, alternateGreetings: _greetings, ...cardForRevision } = currentCharacter;
            return `Revise the following character according to this request: ${revisionInstruction}\n\nPOV requirement: keep content in ${povText} style where it originally applies.\n\nCurrent character JSON:\n${JSON.stringify(cardForRevision, null, 2)}`;
          })(),
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
        creatorNotes: currentCharacter.creatorNotes || "",
        tags: Array.isArray(currentCharacter.tags) ? currentCharacter.tags : [],
        cardType: currentCharacter.cardType || "single",
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
    const nameStyle = this._pickNameStyle();

    const systemPrompt = `You are an expert at creating character names with genuine cultural variety. Generate a single name for the described character.

**CULTURAL STYLE FOR THIS NAME:** Draw from a ${nameStyle} naming tradition. Use an authentic first name and surname (or single name where culturally appropriate) from that tradition — UNLESS the character's description clearly places them in a different culture, in which case use whatever is most historically and geographically accurate. Either way, do NOT fall back to generic Anglo-American defaults.

**BANNED — do NOT use any of these overused AI defaults:**
- Surnames: Voss, Mercer, Drake, Kane, Vale, Stone, Cross, Hart, Crane, Black, Grey, White, Storm, Rowe, Quinn, Pierce, Hayes, Cole, Fox, Grant, Ward, Shaw, Reid, Ash, Dusk, Hale, Mace, Reed, Price, Blair
- Female first names: Aria, Elara, Lyra, Luna, Seraphine, Lily, Nova, Aurora, Celeste, Iris, Zara, Ember, Vivienne, Scarlett, Isolde, Evelyn, Clara, Selene, Freya, Nyx, Raven
- Male first names: Cael, Rael, Zael, Theron, Oryn, Aiden, Caden, Brayden
- Any two-syllable name ending in "-ael", "-iel", or "-yn" unless the concept is explicitly high fantasy

Output ONLY the name — nothing else, no explanation, no punctuation around it.`;

    const currentNameInfo = character.name && character.name !== "{{char}}" && character.name !== "Unknown Character"
      ? `\nCurrent Name: "${character.name}" (DO NOT generate this name again)`
      : "";

    const userPrompt = `Description:
${character.description || "No description provided"}

Personality:
${character.personality || "No personality provided"}${currentNameInfo}

Generate a single name. Remember: draw from a ${nameStyle} tradition unless the character's background demands otherwise.
[Entropy: ${Math.floor(Math.random() * 1000000)}]`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 1.0,
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

  /**
   * Generates 10 varied name options for the Name Generator modal.
   * Accepts gender, character type, time period, guidance, and a list of
   * already-shown names to ban — so every reroll is genuinely fresh.
   */
  async generateNameOptions(character, gender = "any", type = "any", timePeriod = "any", guidance = "", previousNames = []) {
    if (!character) throw new Error("Character is required to generate name options");

    const model = this.config.get("api.text.model");

    // Base cultural traditions pool — now includes English/Western options
    const basePool = [
      "English or British (including classic English surnames and given names)",
      "Irish (Gaelic and anglicised Irish names)",
      "Scottish (Highland and Lowland traditions)",
      "North American (classic American or Canadian names)",
      "Australian or New Zealand",
      "Eastern European (Polish, Czech, Slovak, or Romanian)",
      "Slavic (Russian, Ukrainian, Bulgarian, or Serbian)",
      "Scandinavian (Norwegian, Swedish, Danish, or Icelandic)",
      "Celtic (Welsh, Cornish, or Breton)",
      "Iberian (Spanish, Portuguese, Catalan, or Basque)",
      "Italian or Sicilian",
      "Greek (modern or classical)",
      "Turkish, Azerbaijani, or Uzbek",
      "Arabic (Levantine, Gulf, or North African)",
      "Persian or Dari",
      "South Asian (Hindi, Bengali, Tamil, Punjabi, or Urdu)",
      "Japanese",
      "Korean",
      "Chinese (Mandarin or Cantonese romanisation)",
      "Vietnamese or Thai",
      "Filipino or Tagalog",
      "West African (Yoruba, Igbo, Akan, or Hausa)",
      "East African (Swahili, Amharic, or Somali)",
      "Southern African (Zulu, Xhosa, or Shona)",
      "Hebrew or Yiddish",
      "Armenian or Georgian",
      "Finnish, Estonian, or Sami",
      "Baltic (Lithuanian or Latvian)",
      "Hungarian or Magyar",
      "Dutch or Flemish",
      "German or Austrian",
      "French or Occitan",
      "Albanian or Macedonian",
      "Mongolian, Kazakh, or Kyrgyz",
      "Indigenous Mesoamerican (Nahuatl or Maya inspired)",
    ];

    // Supplementary pool for supernatural types
    const supernaturalPool = [
      "Ancient Sumerian or Akkadian",
      "Ancient Egyptian (pharaonic era)",
      "Ancient Greek or Mycenaean",
      "Hebrew or Enochian angelological tradition (Uriel, Raphael as phonetic style references)",
      "Latin demonological tradition (Ars Goetia phonetics — Bael, Marchosias as style references)",
      "Old Norse or Proto-Germanic",
      "Ancient Sanskrit or early Vedic",
      "Invented — exotic alien phonetics with unusual consonant clusters",
      "Invented — soft flowing elven-style phonetics",
      "Invented — harsh guttural infernal phonetics",
    ];

    // Select the right pool mix based on type
    let pool;
    if (["demon"].includes(type)) {
      pool = [...supernaturalPool, ...basePool.slice(0, 15)];
    } else if (["angel"].includes(type)) {
      pool = [...supernaturalPool.slice(0, 6), ...basePool.slice(0, 20)];
    } else if (["alien"].includes(type)) {
      pool = [...supernaturalPool.slice(6), ...basePool.filter(s =>
        ["Japanese", "Finnish", "Vietnamese", "Mongolian", "Mesoamerican", "Korean", "Filipino"].some(k => s.includes(k))
      ), ...basePool];
    } else if (["elf", "fae"].includes(type)) {
      const elvish = basePool.filter(s =>
        ["Celtic", "Scandinavian", "Finnish", "Baltic", "Greek", "Iberian", "Armenian"].some(k => s.includes(k))
      );
      pool = [...elvish, ...basePool];
    } else {
      pool = basePool;
    }

    // Shuffle and deduplicate, take 10
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    const chosenStyles = [...new Map(shuffled.map(s => [s, s])).values()].slice(0, 10);
    const styleList = chosenStyles.map((s, i) => `${i + 1}. ${s}`).join("\n");

    // Gender
    const genderMap = {
      male: "All names must be masculine.",
      female: "All names must be feminine.",
      other: "All names must be gender-neutral or androgynous.",
    };
    const genderInstruction = genderMap[gender] || "Gender can vary freely across the 10 names.";

    // Character type
    const typeMap = {
      vampire:        "CHARACTER TYPE — Vampire: Names should have an elegant, slightly archaic quality. Eastern European, Western European, and Middle Eastern origins work particularly well. Avoid obviously modern or youthful names.",
      demon:          "CHARACTER TYPE — Demon: Names should sound distinctly non-human. Ancient languages (Sumerian, Akkadian, Enochian, Latin demonology) and invented phonetics are all valid. Unusual consonant clusters are fine. Names do not need to be easy for Western speakers.",
      angel:          "CHARACTER TYPE — Angel: Hebrew, Greek, and Latin angelological traditions are most appropriate. Names ending in -iel, -ael, or -el ARE correct and expected — the normal ban on these endings does NOT apply for angels.",
      elf:            "CHARACTER TYPE — Elf: Names should be flowing, musical, multi-syllable. Celtic, Nordic, Finnish traditions work well. Names ending in -iel or -ael are acceptable for elves.",
      fae:            "CHARACTER TYPE — Fae / Fairy: Names should be whimsical, nature-inspired, often short or musical. Celtic and Irish traditions ideal. Unusual but melodic sounds encouraged.",
      anthropomorphic:"CHARACTER TYPE — Anthropomorphic: Talking animal or furry character. Regular human names or slightly nature/animal-inspired names both work well.",
      werewolf:       "CHARACTER TYPE — Werewolf / Shifter: They live as humans, so regular human names are correct. Germanic, Norse, Slavic, and Celtic traditions fit the folklore particularly well.",
      ghost:          "CHARACTER TYPE — Ghost / Spirit: They retain the names they had in life. Use period-authentic names that feel historical and grounded.",
      alien:          "CHARACTER TYPE — Alien: Names should feel distinctly non-human while remaining pronounceable. Favour the most phonetically unusual traditions or invent names with rare phoneme combinations.",
      undead:         "CHARACTER TYPE — Undead: They retain their living names. Period-appropriate names with a slightly archaic feel.",
      witch:          "CHARACTER TYPE — Witch / Mage: Can be from any tradition — historical, exotic, or slightly unusual. Some witches use craft names distinct from birth names.",
    };
    const typeInstruction = typeMap[type] ? `\n\n${typeMap[type]}` : "\n\nCHARACTER TYPE — Human: Use authentic real-world names from the assigned cultural traditions.";

    // Time period
    const periodMap = {
      ancient:      "TIME PERIOD — Ancient (pre-500 AD): Names must feel authentic to ancient cultures — Mesopotamian, Egyptian, Greek, Roman, Celtic Iron Age, Han Dynasty, Vedic India, etc.",
      medieval:     "TIME PERIOD — Medieval (500–1400 AD): Period-authentic — Old English, Old French, Norse, Slavic, Arabic, Japanese feudal, etc. Avoid obviously modern sounds.",
      renaissance:  "TIME PERIOD — Renaissance / Early Modern (1400–1700): Names fitting the 15th–17th century globally.",
      victorian:    "TIME PERIOD — Victorian era (1800s): 19th-century names from across the world.",
      "early-20th": "TIME PERIOD — Early 20th century (1900–1950).",
      "mid-20th":   "TIME PERIOD — Mid-to-late 20th century (1950–1990).",
      contemporary: "TIME PERIOD — Contemporary / modern day (1990s–2020s). Names should feel current.",
      "near-future":"TIME PERIOD — Near future (2030–2100). Names feel slightly futuristic but grounded in today's trends.",
      "far-future": "TIME PERIOD — Far future / sci-fi. Names can be invented and genuinely futuristic.",
      fantasy:      "TIME PERIOD — Fantasy setting. No real-world era constraint — blend historical periods freely.",
    };
    const periodInstruction = periodMap[timePeriod] ? `\n\n${periodMap[timePeriod]}` : "";

    // Banned previously-seen names
    const previousBan = previousNames.length > 0
      ? `\n\n**PREVIOUSLY SHOWN — do NOT repeat any of these, the user wants entirely fresh options:**\n${previousNames.map(n => `"${n}"`).join(", ")}`
      : "";

    const guidanceInstruction = guidance
      ? `\n\nAdditional guidance from user: "${guidance}" — this is your PRIMARY instruction. If it specifies a cultural style, use that style for all 10 names.`
      : "";

    const systemPrompt = `You are an expert in names from cultures around the world. Generate exactly 10 character names.${typeInstruction}${periodInstruction}

${genderInstruction}

**GUIDANCE IS YOUR PRIMARY INSTRUCTION.** If the user's guidance specifies a cultural origin, nationality, style, or feel (e.g. "Classic English Names", "French nobility", "Japanese", "Viking"), ALL 10 names must follow that direction. In this case, use the cultural tradition list only as inspiration for variety within the requested culture — do not override the user's guidance with unrelated traditions.

If no cultural guidance is given, use the tradition list to produce maximum variety: each name must authentically come from its assigned tradition.

**Banned overused AI defaults — only apply this ban when NO specific cultural guidance is given. If the user has requested a style that includes these names, authentic examples from that tradition are fine:**
- Edgy Anglo surnames to avoid by default: Voss, Drake, Kane, Vale, Stone, Cross, Hart, Crane, Storm, Dusk, Mace, Blair
- Overused female fantasy defaults: Aria, Elara, Lyra, Luna, Seraphine, Nova, Aurora, Celeste, Ember, Selene, Nyx, Raven
- Overused male fantasy defaults: Cael, Rael, Zael, Theron, Oryn, Brayden
- Names ending in -ael, -iel, or -yn UNLESS the character type explicitly permits it${previousNames.length > 0 ? `\n\n**PREVIOUSLY SHOWN — do NOT repeat any of these:**\n${previousNames.map(n => `"${n}"`).join(", ")}` : ""}

Return ONLY a strict JSON array of exactly 10 strings. No objects, no explanations.
Example: ["Yuki Tanaka", "Kofi Mensah", "Ingrid Halvorsen", "Mirela Petrović", ...]`;

    const traditionNote = guidance
      ? `Cultural traditions (use as variety guide within the user's requested style, not as overrides):\n${styleList}`
      : `Cultural traditions to draw from (one per name, in order):\n${styleList}`;

    const userPrompt = `Character context:
${character.description ? `Description: ${character.description.substring(0, 300)}` : "No description provided"}
${character.name && character.name !== "{{char}}" && character.name !== "Unknown Character" ? `Current name: "${character.name}" (do NOT use this again)` : ""}${guidanceInstruction}

${traditionNote}

Generate exactly 10 names as a JSON array. Make each name as different from the others as possible.
[Entropy: ${Math.floor(Math.random() * 2000000)}]`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 1.0,
      max_tokens: 350,
      stream: false,
    };

    try {
      console.log("=== STARTING NAME OPTIONS GENERATION ===");
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);

      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        const arrayMatch = output.match(/\[[\s\S]*\]/);
        if (arrayMatch) parsed = JSON.parse(arrayMatch[0]);
        else throw new Error("Could not parse name list from response");
      }

      if (!Array.isArray(parsed)) throw new Error("Response was not an array");

      return parsed
        .slice(0, 10)
        .map((n) => String(n).trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } catch (error) {
      console.error("=== NAME OPTIONS GENERATION FAILED ===", error);
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

  /**
   * Returns a compact lorebook context listing only trigger keys — NOT entry content.
   * Use this when regenerating individual card fields (scenario, firstMessage, etc.)
   * so the AI knows which keywords to weave in without having full lorebook text
   * available to copy verbatim into the card.
   */
  formatLorebookKeysContext(lorebookEntries) {
    if (!lorebookEntries || !Array.isArray(lorebookEntries) || lorebookEntries.length === 0) return "";
    const allKeys = [];
    lorebookEntries.forEach((entry) => {
      if (entry.enabled !== false && entry.keys && entry.keys.length > 0) {
        allKeys.push(...entry.keys);
      }
    });
    if (allKeys.length === 0) return "";
    const uniqueKeys = [...new Set(allKeys)];
    return `\n\nLorebook trigger keywords — weave these naturally into your text so they activate lorebook entries during roleplay. Do NOT copy or paraphrase lorebook content into this field; just ensure these words appear organically: ${uniqueKeys.join(", ")}`;
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

    const lorebookContext = this.formatLorebookKeysContext(lorebookEntries);
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

    const lorebookContext = this.formatLorebookKeysContext(lorebookEntries);
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

  async generateTags(character) {
    if (!character) throw new Error("Character is required to generate tags");
    const model = this.config.get("api.text.model");

    const systemPrompt = `You are a tagging assistant for SillyTavern character cards. Analyse the character and output a JSON array of concise, lowercase tags that describe the character. Tags should cover:
- Gender (e.g. "female", "male", "non-binary")
- Species / race if not human (e.g. "elf", "android", "vampire")
- Setting / genre (e.g. "fantasy", "sci-fi", "modern", "historical", "post-apocalyptic")
- Personality archetype (e.g. "tsundere", "mentor", "villain", "anti-hero")
- Occupation or role (e.g. "detective", "witch", "soldier")
- Notable traits (e.g. "sarcastic", "loyal", "mysterious")
- Content tone (e.g. "romance", "action", "comedy", "dark", "wholesome")

Rules:
- Output ONLY a valid JSON array of strings, nothing else.
- 5–12 tags total.
- All lowercase, no special characters except hyphens.
- No tag longer than 25 characters.`;

    const userPrompt = `Name: ${character.name || "Unknown"}
Description: ${(character.description || "").slice(0, 800)}
Personality: ${(character.personality || "").slice(0, 400)}
Scenario: ${(character.scenario || "").slice(0, 300)}
First message: ${(character.firstMessage || "").slice(0, 300)}

Output a JSON array of tags only.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 150,
      stream: false,
    };

    try {
      const response = await this.makeRequest("/chat/completions", data, false, false);
      const output = this.processNormalResponse(response);
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        const arrayMatch = output.match(/\[[\s\S]*?\]/);
        if (arrayMatch) parsed = JSON.parse(arrayMatch[0]);
        else throw new Error("Could not parse tags from response");
      }
      if (!Array.isArray(parsed)) throw new Error("Response was not an array");
      return parsed.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12);
    } catch (error) {
      console.error("=== TAG GENERATION FAILED ===", error);
      throw error;
    }
  },

  async generateCreatorNotes(character) {
    if (!character) throw new Error("Character is required to generate creator notes");
    const model = this.config.get("api.text.model");
    const charName = character.name || "the character";

    const systemPrompt = `You write short, punchy "Creator's Notes" blurbs for SillyTavern character cards. These appear on card-sharing websites and must instantly hook a reader.

Rules:
- 2–4 sentences max. No more.
- Use the character's ACTUAL name (not {{char}} or {{user}}).
- Open with who the character is — make it intriguing, not bland.
- Mention the core scenario or hook.
- End with a light tease of what interacting with them offers (tension, romance, mystery, humour, etc.).
- Write in present tense, third person, active voice.
- No hashtags, no lists, no headers — just plain compelling prose.
- Do NOT start with "Meet" or "Introducing". Be more creative.`;

    const userPrompt = `Character name: ${charName}

Description (excerpt):
${(character.description || "").slice(0, 600)}

Personality (excerpt):
${(character.personality || "").slice(0, 400)}

Scenario:
${(character.scenario || "").slice(0, 500)}

First message (for tone reference):
${(character.firstMessage || "").slice(0, 300)}

Write the Creator's Notes blurb now. Plain text only, no formatting.`;

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 256,
      stream: false,
    };

    try {
      const response = await this.makeRequest("/chat/completions", data, false, false);
      return this.processNormalResponse(response).trim();
    } catch (error) {
      console.error("=== CREATOR NOTES GENERATION FAILED ===", error);
      throw error;
    }
  },

  /* ── Inspire Me — Idea Generation ──────────────────────────────────────── */

  /**
   * Generate 4 high-level character ideas based on user filters.
   * Used by the Inspire Me mode's Stage 1 (idea spark).
   */
  async generateInspireIdeas(filters) {
    const prompt = this.buildInspireIdeasPrompt(filters);
    const model = this.config.get("api.text.model") || "glm-4-6";

    const data = {
      model: model,
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userPrompt },
      ],
      temperature: 0.9,
      max_tokens: 2048,
      stream: false,
    };

    const response = await this.makeRequest("/chat/completions", data, false, false);
    return this.processNormalResponse(response);
  },

  /**
   * Build the system + user prompts for brainstorming 4 character ideas.
   */
  buildInspireIdeasPrompt(filters) {
    const genderMap = {
      any: "any gender identity",
      male: "male",
      female: "female",
      genderless: "genderless, non-binary, or agender",
    };
    const orientationMap = {
      any: "any sexual/romantic orientation — do not assume or restrict attraction",
      heterosexual: "heterosexual — attracted to the opposite gender only",
      homosexual: "homosexual (gay/lesbian) — attracted to the same gender only",
      bisexual: "bisexual or pansexual — attracted to people regardless of gender",
      asexual: "asexual or aromantic — experiences little or no romantic/sexual attraction",
    };
    const nsfwMap = {
      sfw: "The ideas MUST be strictly SFW / safe for work.",
      nsfw: "NSFW themes are allowed if the concept calls for it.",
      any: "No content restrictions.",
    };

    const systemPrompt = [
      "You are a creative character-concept brainstormer for a roleplaying-card generator. Your job is to generate 4 unique, compelling character ideas based on user-specified filters.",
      "",
      "Each idea must be a STRICTLY FORMATTED single line like this:",
      "N. **Character Name/Title** — Two to three sentences describing the character's core concept, their defining trait or internal conflict, and the kind of story or scenario they belong in.",
      "",
      "RULES:",
      "- Generate exactly 4 ideas, numbered 1 through 4.",
      `- Gender identity: ${genderMap[filters.gender] || "any gender identity"}.`,
      `- Sexual/romantic orientation: ${orientationMap[filters.orientation] || orientationMap.any}. IMPORTANT — this is separate from gender identity. The character's orientation determines who they are attracted to, not their own gender.`,
      `- ${nsfwMap[filters.nsfw] || "No content restrictions."}`,
      filters.genre !== "any" ? `- Genre / setting: ${filters.genre}.` : "- No particular genre restriction.",
      filters.trope ? `- Consider the trope/archetype direction: ${filters.trope}.` : "",
      "- Be wildly creative and diverse — each idea should feel distinct in tone, setting, and concept.",
      "- Avoid cliches unless using them in an intentionally fresh or subversive way.",
      "- Each description must be exactly 2-3 sentences. No bullet points, no markdown beyond the bolded name.",
      "- Output ONLY the 4 numbered ideas, nothing else — no preamble, no closing remarks.",
    ].filter(Boolean).join("\n");

    const userPrompt = filters.theme
      ? `Theme / direction: ${filters.theme}\n\nGenerate 4 character ideas based on the above theme. Make them distinct and surprising.`
      : "Generate 4 original character ideas. Surprise me with unexpected concepts! Make them diverse in genre, tone, and character type.";

    return { systemPrompt, userPrompt };
  },

});

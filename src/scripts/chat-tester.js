// Chat Tester Module - Handles conversation logic, prompt building, API streaming, and transcript/persona management
class ChatTester {
  constructor(app) {
    this.app = app;
    this.messages = [];
    this.isGenerating = false;
    this.personaName = "User";
    this.maxHistoryMessages = 20;
    // Generation parameters (with defaults)
    this.temperature = 0.85;
    this.topP = 1.0;
    this.maxTokens = 800;
    // Load saved params from localStorage
    this._loadParams();
  }

  /* ---------- Parameter Persistence ---------- */

  _loadParams() {
    try {
      const saved = JSON.parse(localStorage.getItem("chatgen_params") || "null");
      if (saved) {
        if (typeof saved.temperature === "number") this.temperature = saved.temperature;
        if (typeof saved.topP === "number") this.topP = saved.topP;
        if (typeof saved.maxTokens === "number") this.maxTokens = saved.maxTokens;
      }
    } catch (e) { /* ignore */ }
  }

  saveParams() {
    localStorage.setItem("chatgen_params", JSON.stringify({
      temperature: this.temperature,
      topP: this.topP,
      maxTokens: this.maxTokens,
    }));
  }

  /* ---------- Transcript Save / Load ---------- */

  saveTranscript(name) {
    if (this.messages.length === 0) return null;
    const transcripts = ChatTester._getAllTranscripts();
    const id = "tx_" + Date.now();
    const entry = {
      id,
      name: name || `Chat ${new Date().toLocaleDateString()}`,
      characterName: this.app.currentCharacter?.name || "Unknown",
      personaName: this.personaName,
      createdAt: new Date().toISOString(),
      messages: JSON.parse(JSON.stringify(this.messages)),
    };
    transcripts.push(entry);
    if (transcripts.length > 50) transcripts.shift();
    localStorage.setItem("chatgen_transcripts", JSON.stringify(transcripts));
    return entry;
  }

  loadTranscript(id) {
    const transcripts = ChatTester._getAllTranscripts();
    const entry = transcripts.find((t) => t.id === id);
    if (!entry) return false;
    this.messages = JSON.parse(JSON.stringify(entry.messages));
    this.personaName = entry.personaName || "User";
    return true;
  }

  deleteTranscript(id) {
    const transcripts = ChatTester._getAllTranscripts();
    const filtered = transcripts.filter((t) => t.id !== id);
    localStorage.setItem("chatgen_transcripts", JSON.stringify(filtered));
  }

  static _getAllTranscripts() {
    try {
      return JSON.parse(localStorage.getItem("chatgen_transcripts") || "[]");
    } catch (e) { return []; }
  }

  static getAllTranscripts() {
    return ChatTester._getAllTranscripts();
  }

  /* ---------- Persona Management ---------- */

  static getPersonas() {
    try {
      return JSON.parse(localStorage.getItem("chatgen_personas") || "[]");
    } catch (e) { return []; }
  }

  static savePersonas(personas) {
    localStorage.setItem("chatgen_personas", JSON.stringify(personas));
  }

  static addPersona(name, description) {
    const personas = ChatTester.getPersonas();
    const id = "p_" + Date.now();
    personas.push({ id, name: name.trim(), description: description.trim() });
    ChatTester.savePersonas(personas);
    return id;
  }

  static updatePersona(id, name, description) {
    const personas = ChatTester.getPersonas();
    const p = personas.find((p) => p.id === id);
    if (!p) return false;
    p.name = name.trim();
    p.description = description.trim();
    ChatTester.savePersonas(personas);
    return true;
  }

  static deletePersona(id) {
    const personas = ChatTester.getPersonas();
    ChatTester.savePersonas(personas.filter((p) => p.id !== id));
  }

  /* ---------- Prompt Construction ---------- */

  _buildSystemPrompt() {
    const char = this.app.currentCharacter;
    if (!char) return "You are a helpful assistant.";

    const parts = [];

    // Optional persona description
    const personas = ChatTester.getPersonas();
    const activePersona = personas.find((p) => p.name === this.personaName);
    if (activePersona?.description) {
      parts.push(`[${this.personaName}'s Persona]`);
      parts.push(activePersona.description);
      parts.push("");
    }

    // Core instruction block
    const charName = char.name || "{{char}}";
    parts.push(`You are ${charName}.`);
    parts.push(`Stay in character at all times. Respond as ${charName}.`);
    parts.push(`Use *italics* for actions and narration, and "quotes" for speech.`);
    parts.push(`Do not narrate ${this.personaName}'s actions or speak for ${this.personaName}.`);
    parts.push(`Do not break character or refer to yourself as an AI.`);
    parts.push("");

    // Description
    if (char.description) {
      parts.push("[Character Description]");
      parts.push(this._replaceMacros(char.description));
      parts.push("");
    }

    // Personality
    if (char.personality) {
      parts.push("[Personality]");
      parts.push(this._replaceMacros(char.personality));
      parts.push("");
    }

    // Scenario
    if (char.scenario) {
      parts.push("[Scenario]");
      parts.push(this._replaceMacros(char.scenario));
      parts.push("");
    }

    // Relevant lorebook entries
    const relevantLore = this._getRelevantLorebookEntries();
    if (relevantLore.length > 0) {
      parts.push("[Relevant Lore]");
      for (const entry of relevantLore) {
        const label = entry.comment || entry.keys.join(", ");
        parts.push(`--- ${label} ---`);
        parts.push(this._replaceMacros(entry.content));
      }
      parts.push("");
    }

    // Example messages
    if (char.mesExample) {
      parts.push("[Example Messages]");
      parts.push(this._replaceMacros(char.mesExample));
      parts.push("");
    }

    return parts.join("\n");
  }

  _replaceMacros(text) {
    if (!text) return text;
    const charName = this.app.currentCharacter?.name || "{{char}}";
    return text
      .replace(/\{\{char\}\}/gi, charName)
      .replace(/\{\{user\}\}/gi, this.personaName);
  }

  _getRelevantLorebookEntries() {
    const entries = this.app.lorebookEntries || [];
    if (entries.length === 0) return [];

    // Scan last 3 user messages for lorebook keys
    const recentMessages = this.messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content.toLowerCase());

    if (recentMessages.length === 0) return [];

    const matched = [];
    const seen = new Set();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.disable === true) continue;
      if (!entry.keys || entry.keys.length === 0) continue;
      const dedupeKey = entry.id ?? i;

      for (const key of entry.keys) {
        if (!key) continue;
        const keyLower = key.toLowerCase();
        for (const msg of recentMessages) {
          if (msg.includes(keyLower) && !seen.has(dedupeKey)) {
            matched.push(entry);
            seen.add(dedupeKey);
            break;
          }
        }
        if (seen.has(dedupeKey)) break;
      }
    }

    return matched;
  }

  /* ---------- Lorebook Highlighting Helpers ---------- */

  // Returns array of { word, entryName } for any lorebook key found in text
  getLorebookMatches(text) {
    if (!text) return [];
    const entries = this.app.lorebookEntries || [];
    if (entries.length === 0) return [];
    const matches = [];
    const seenWords = new Set();
    for (const entry of entries) {
      if (entry.disable) continue;
      if (!entry.keys) continue;
      for (const key of entry.keys) {
        if (!key || seenWords.has(key.toLowerCase())) continue;
        const idx = text.toLowerCase().indexOf(key.toLowerCase());
        if (idx !== -1) {
          matches.push({
            word: text.slice(idx, idx + key.length),
            entryName: entry.comment || entry.keys.join(", "),
            index: idx,
          });
          seenWords.add(key.toLowerCase());
        }
      }
    }
    // Sort by position
    matches.sort((a, b) => a.index - b.index);
    return matches;
  }

  /* ---------- Public Actions ---------- */

  async sendMessage(content) {
    if (this.isGenerating) return;
    if (!content.trim()) return;
    // Message must already be pushed into this.messages by the caller before invoking this.
    await this._generateResponse();
  }

  async regenerate() {
    if (this.isGenerating) return;

    let lastAssistantIndex = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }

    if (lastAssistantIndex === -1) return;

    this.messages.splice(lastAssistantIndex, 1);
    await this._generateResponse();
  }

  async _generateResponse() {
    if (this.isGenerating) return;
    this.isGenerating = true;

    try {
      const systemPrompt = this._buildSystemPrompt();

      const apiMessages = [{ role: "system", content: systemPrompt }];

      // Inject first message as prior assistant turn for context
      const char = this.app.currentCharacter;
      if (char?.firstMessage && this.messages.length <= 1) {
        apiMessages.push({
          role: "assistant",
          content: this._replaceMacros(char.firstMessage),
        });
      }

      // Add history (respect maxHistoryMessages)
      const history = this.messages.slice(-this.maxHistoryMessages);
      for (const msg of history) {
        apiMessages.push({ role: msg.role, content: msg.content });
      }

      const data = {
        model: this.app.config.get("api.text.model"),
        messages: apiMessages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        top_p: this.topP,
        stream: true,
      };

      const response = await window.apiHandler.makeRequest(
        "/chat/completions",
        data,
        false,
        true,
      );

      const assistantMsg = { role: "assistant", content: "", id: Date.now() };
      this.messages.push(assistantMsg);

      await window.apiHandler.handleStreamResponse(
        response,
        (chunk, fullContent) => {
          assistantMsg.content = fullContent;
          if (this.app._onChatStream) {
            this.app._onChatStream(chunk, fullContent, assistantMsg.id);
          }
        },
      );
    } catch (error) {
      console.error("Chat generation error:", error);
      if (this.app._onChatError) {
        this.app._onChatError(error.message);
      }
    } finally {
      this.isGenerating = false;
      if (this.app._onChatComplete) {
        this.app._onChatComplete();
      }
    }
  }

  editMessage(id, newContent) {
    const index = this.messages.findIndex((m) => m.id === id);
    if (index === -1) return false;

    this.messages[index].content = newContent.trim();
    // Truncate history after this message and regenerate
    this.messages = this.messages.slice(0, index + 1);
    return true;
  }

  deleteMessage(id) {
    const index = this.messages.findIndex((m) => m.id === id);
    if (index === -1) return false;
    this.messages.splice(index, 1);
    return true;
  }

  clear() {
    this.messages = [];
  }

  getMessages() {
    return this.messages;
  }

  setPersonaName(name) {
    this.personaName = name || "User";
  }

  getPersonaName() {
    return this.personaName;
  }

  getTokenEstimate() {
    const systemPrompt = this._buildSystemPrompt();
    let chars = systemPrompt.length;
    for (const msg of this.messages) {
      chars += msg.content.length;
    }
    return Math.ceil(chars / 4);
  }

  stopGeneration() {
    if (this.isGenerating) {
      window.apiHandler.stopGeneration();
    }
  }
}

window.ChatTester = ChatTester;

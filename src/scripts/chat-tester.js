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
    this.frequencyPenalty = 0;
    this.presencePenalty = 0;
    this.topK = 0;
    this.minP = 0;
    this.seed = null;
    this.stopSequences = [];
    // Author's Note
    this.authorsNote = "";
    this.authorsNoteDepth = 2; // 0 = after system, 1 = after first message, etc.
    // Chat slots keyed by character name
    this.slots = {};
    this.activeSlotId = null;
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
        if (typeof saved.frequencyPenalty === "number") this.frequencyPenalty = saved.frequencyPenalty;
        if (typeof saved.presencePenalty === "number") this.presencePenalty = saved.presencePenalty;
        if (typeof saved.topK === "number") this.topK = saved.topK;
        if (typeof saved.minP === "number") this.minP = saved.minP;
        if (typeof saved.seed === "number") this.seed = saved.seed;
        if (Array.isArray(saved.stopSequences)) this.stopSequences = saved.stopSequences;
        if (typeof saved.authorsNote === "string") this.authorsNote = saved.authorsNote;
        if (typeof saved.authorsNoteDepth === "number") this.authorsNoteDepth = saved.authorsNoteDepth;
      }
    } catch (e) { /* ignore */ }
  }

  saveParams() {
    localStorage.setItem("chatgen_params", JSON.stringify({
      temperature: this.temperature,
      topP: this.topP,
      maxTokens: this.maxTokens,
      frequencyPenalty: this.frequencyPenalty,
      presencePenalty: this.presencePenalty,
      topK: this.topK,
      minP: this.minP,
      seed: this.seed,
      stopSequences: this.stopSequences,
      authorsNote: this.authorsNote,
      authorsNoteDepth: this.authorsNoteDepth,
    }));
  }

  /* ---------- Chat Slots ---------- */

  _getSlotKey() {
    const charName = this.app.currentCharacter?.name || "Unknown";
    return charName;
  }

  _loadSlots() {
    try {
      return JSON.parse(localStorage.getItem("chatgen_slots") || "{}");
    } catch (e) { return {}; }
  }

  _saveSlots(slots) {
    localStorage.setItem("chatgen_slots", JSON.stringify(slots));
  }

  getSlots() {
    const key = this._getSlotKey();
    const all = this._loadSlots();
    return all[key] || [];
  }

  createSlot(name) {
    const key = this._getSlotKey();
    const all = this._loadSlots();
    if (!all[key]) all[key] = [];
    const id = "slot_" + Date.now();
    const slot = { id, name: name || `Chat ${all[key].length + 1}`, createdAt: new Date().toISOString(), messages: [] };
    all[key].push(slot);
    this._saveSlots(all);
    return slot;
  }

  renameSlot(id, name) {
    const key = this._getSlotKey();
    const all = this._loadSlots();
    if (!all[key]) return false;
    const slot = all[key].find((s) => s.id === id);
    if (slot) slot.name = name;
    this._saveSlots(all);
    return !!slot;
  }

  deleteSlot(id) {
    const key = this._getSlotKey();
    const all = this._loadSlots();
    if (!all[key]) return false;
    all[key] = all[key].filter((s) => s.id !== id);
    this._saveSlots(all);
    return true;
  }

  loadSlot(id) {
    const key = this._getSlotKey();
    const all = this._loadSlots();
    const slots = all[key] || [];
    const slot = slots.find((s) => s.id === id);
    if (!slot) return false;
    this.activeSlotId = id;
    this.messages = JSON.parse(JSON.stringify(slot.messages || []));
    return true;
  }

  saveCurrentSlot() {
    if (!this.activeSlotId) return;
    const key = this._getSlotKey();
    const all = this._loadSlots();
    if (!all[key]) all[key] = [];
    const slot = all[key].find((s) => s.id === this.activeSlotId);
    if (slot) {
      slot.messages = JSON.parse(JSON.stringify(this.messages));
      slot.updatedAt = new Date().toISOString();
      this._saveSlots(all);
    }
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

  static addPersona(name, description, systemPrefix, systemSuffix) {
    const personas = ChatTester.getPersonas();
    const id = "p_" + Date.now();
    personas.push({ id, name: name.trim(), description: description.trim(), systemPrefix: (systemPrefix || "").trim(), systemSuffix: (systemSuffix || "").trim() });
    ChatTester.savePersonas(personas);
    return id;
  }

  static updatePersona(id, name, description, systemPrefix, systemSuffix) {
    const personas = ChatTester.getPersonas();
    const p = personas.find((p) => p.id === id);
    if (!p) return false;
    p.name = name.trim();
    p.description = description.trim();
    p.systemPrefix = (systemPrefix || "").trim();
    p.systemSuffix = (systemSuffix || "").trim();
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

    // Optional persona description + prefix
    const personas = ChatTester.getPersonas();
    const activePersona = personas.find((p) => p.name === this.personaName);
    if (activePersona?.systemPrefix) {
      parts.push(activePersona.systemPrefix);
      parts.push("");
    }
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

    // Persona suffix
    if (activePersona?.systemSuffix) {
      parts.push(activePersona.systemSuffix);
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

  /* ---------- Swipe Helpers ---------- */

  _ensureSwipeData(msg) {
    if (!msg.swipes) {
      msg.swipes = [msg.content];
      msg.swipeIndex = 0;
    }
  }

  addSwipe(msgId, content) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== "assistant") return false;
    this._ensureSwipeData(msg);
    msg.swipes.push(content);
    msg.swipeIndex = msg.swipes.length - 1;
    msg.content = content;
    return true;
  }

  setSwipeIndex(msgId, index) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== "assistant") return false;
    this._ensureSwipeData(msg);
    if (index < 0 || index >= msg.swipes.length) return false;
    msg.swipeIndex = index;
    msg.content = msg.swipes[index];
    return true;
  }

  getSwipeInfo(msgId) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== "assistant") return null;
    this._ensureSwipeData(msg);
    return { current: msg.swipeIndex, total: msg.swipes.length };
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

    const msg = this.messages[lastAssistantIndex];
    this._ensureSwipeData(msg);
    // Remove the current content from the main array temporarily; we'll add a new swipe
    this.messages.splice(lastAssistantIndex, 1);
    await this._generateResponse(msg);
  }

  async _generateResponse(restoreMsg = null) {
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

      // Author's Note injection at configured depth
      const anDepth = Math.max(0, this.authorsNoteDepth);
      if (this.authorsNote.trim()) {
        const anMsg = { role: "system", content: `[Author's Note]\n${this.authorsNote.trim()}` };
        if (anDepth === 0) {
          apiMessages.push(anMsg);
        } else if (anDepth <= history.length) {
          history.splice(history.length - anDepth, 0, anMsg);
        } else {
          history.unshift(anMsg);
        }
      }

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

      if (this.frequencyPenalty !== 0) data.frequency_penalty = this.frequencyPenalty;
      if (this.presencePenalty !== 0) data.presence_penalty = this.presencePenalty;
      if (this.seed !== null && typeof this.seed === "number") data.seed = this.seed;
      if (this.stopSequences && this.stopSequences.length > 0) {
        data.stop = this.stopSequences;
      }
      // top_k and min_p are not standard OpenAI but many proxies accept them
      if (this.topK > 0) data.top_k = this.topK;
      if (this.minP > 0) data.min_p = this.minP;

      const response = await window.apiHandler.makeRequest(
        "/chat/completions",
        data,
        false,
        true,
      );

      let assistantMsg;
      if (restoreMsg) {
        assistantMsg = restoreMsg;
        assistantMsg.content = "";
        this.messages.push(assistantMsg);
      } else {
        assistantMsg = { role: "assistant", content: "", id: Date.now() };
        this.messages.push(assistantMsg);
      }

      await window.apiHandler.handleStreamResponse(
        response,
        (chunk, fullContent) => {
          assistantMsg.content = fullContent;
          if (this.app._onChatStream) {
            this.app._onChatStream(chunk, fullContent, assistantMsg.id);
          }
        },
      );

      // After stream completes, store as a swipe
      this._ensureSwipeData(assistantMsg);
      if (!restoreMsg) {
        assistantMsg.swipes = [assistantMsg.content];
        assistantMsg.swipeIndex = 0;
      } else {
        assistantMsg.swipes.push(assistantMsg.content);
        assistantMsg.swipeIndex = assistantMsg.swipes.length - 1;
      }
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

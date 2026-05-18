// Chat Tester UI Module - Modal rendering, message bubbles, lorebook highlighting, toolbar params, transcripts, personas
Object.assign(CharacterGeneratorApp.prototype, {
  openChatTester() {
    if (!this.currentCharacter) {
      this.showNotification("Generate a character first to test chat.", "warning");
      return;
    }

    const modal = document.getElementById("chat-tester-modal");
    if (!modal) return;

    // Ensure chat tester instance exists
    if (!this.chatTester) {
      this.chatTester = new ChatTester(this);
    }

    // Set character name in header
    const headerName = document.getElementById("chat-tester-char-name");
    if (headerName) {
      headerName.textContent = this.currentCharacter.name || "Character";
    }

    // Load persona name from input
    const personaInput = document.getElementById("chat-persona-name");
    if (personaInput) {
      personaInput.value = this.chatTester.getPersonaName();
    }

    // Populate param controls
    this._syncChatParamControls();

    // If chat is empty, inject first message as character opening
    const messages = this.chatTester.getMessages();
    if (messages.length === 0 && this.currentCharacter.firstMessage) {
      this.chatTester.messages.push({
        role: "assistant",
        content: this.currentCharacter.firstMessage,
        id: Date.now(),
      });
    }

    this.renderChatMessages();
    this.updateChatTokenCount();
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    // Focus input
    const input = document.getElementById("chat-input");
    if (input) setTimeout(() => input.focus(), 100);
  },

  closeChatTester() {
    const modal = document.getElementById("chat-tester-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  },

  /* ── Param Controls ─────────────────────────────────────────────────────── */

  _syncChatParamControls() {
    if (!this.chatTester) return;
    const tempSlider = document.getElementById("chat-temperature");
    const tempValue = document.getElementById("chat-temp-value");
    const topPSlider = document.getElementById("chat-top-p");
    const topPValue = document.getElementById("chat-top-p-value");
    const maxTokensInput = document.getElementById("chat-max-tokens");

    if (tempSlider) tempSlider.value = this.chatTester.temperature;
    if (tempValue) tempValue.textContent = this.chatTester.temperature;
    if (topPSlider) topPSlider.value = this.chatTester.topP;
    if (topPValue) topPValue.textContent = this.chatTester.topP;
    if (maxTokensInput) maxTokensInput.value = this.chatTester.maxTokens;
  },

  _handleChatParamChange() {
    if (!this.chatTester) return;
    const tempSlider = document.getElementById("chat-temperature");
    const tempValue = document.getElementById("chat-temp-value");
    const topPSlider = document.getElementById("chat-top-p");
    const topPValue = document.getElementById("chat-top-p-value");
    const maxTokensInput = document.getElementById("chat-max-tokens");

    if (tempSlider) {
      this.chatTester.temperature = parseFloat(tempSlider.value);
      if (tempValue) tempValue.textContent = this.chatTester.temperature;
    }
    if (topPSlider) {
      this.chatTester.topP = parseFloat(topPSlider.value);
      if (topPValue) topPValue.textContent = this.chatTester.topP;
    }
    if (maxTokensInput) {
      this.chatTester.maxTokens = parseInt(maxTokensInput.value, 10) || 800;
    }
    this.chatTester.saveParams();
  },

  /* ── Transcripts ────────────────────────────────────────────────────────── */

  _handleChatSaveTranscript() {
    if (!this.chatTester || this.chatTester.getMessages().length === 0) {
      this.showNotification("No messages to save.", "warning");
      return;
    }
    const defaultName = `Chat with ${this.currentCharacter?.name || "Character"} - ${new Date().toLocaleDateString()}`;
    const name = prompt("Transcript name:", defaultName);
    if (!name) return;
    const entry = this.chatTester.saveTranscript(name.trim());
    if (entry) {
      this.showNotification("Transcript saved!", "success");
    }
  },

  _handleChatLoadTranscript() {
    const modal = document.getElementById("chat-transcript-modal");
    if (!modal) return;
    this._renderTranscriptList();
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  },

  _closeTranscriptModal() {
    const modal = document.getElementById("chat-transcript-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  },

  _renderTranscriptList() {
    const list = document.getElementById("chat-transcript-list");
    if (!list) return;
    const transcripts = ChatTester.getAllTranscripts();

    if (transcripts.length === 0) {
      list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:2rem;">No saved transcripts yet.</p>';
      return;
    }

    // Sort newest first
    transcripts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    list.innerHTML = transcripts.map((t) => {
      const msgCount = t.messages ? t.messages.length : 0;
      const date = new Date(t.createdAt).toLocaleDateString();
      return `
        <div class="transcript-item">
          <div class="transcript-info">
            <div class="transcript-name">${escapeHtml(t.name)}</div>
            <div class="transcript-meta">${escapeHtml(t.characterName)} · ${date} · ${msgCount} messages</div>
          </div>
          <div class="transcript-actions">
            <button class="btn-small" data-transcript-action="load" data-transcript-id="${escapeHtml(t.id)}">Load</button>
            <button class="btn-small btn-danger" data-transcript-action="delete" data-transcript-id="${escapeHtml(t.id)}" style="background:var(--error);color:#fff;border-color:var(--error);">Delete</button>
          </div>
        </div>
      `;
    }).join("");
  },

  _handleTranscriptListClick(e) {
    const btn = e.target.closest("[data-transcript-action]");
    if (!btn) return;
    const id = btn.dataset.transcriptId;
    if (btn.dataset.transcriptAction === "load") {
      if (this.chatTester && this.chatTester.isGenerating) {
        this.showNotification("Stop generation before loading a transcript.", "warning");
        return;
      }
      if (this.chatTester.getMessages().length > 0 && !confirm("Loading a transcript will replace the current chat. Continue?")) return;
      this.chatTester.loadTranscript(id);
      this.renderChatMessages();
      this.updateChatTokenCount();
      this._closeTranscriptModal();
      // Update persona input
      const personaInput = document.getElementById("chat-persona-name");
      if (personaInput) personaInput.value = this.chatTester.getPersonaName();
      this.showNotification("Transcript loaded!", "success");
    } else if (btn.dataset.transcriptAction === "delete") {
      if (!confirm("Delete this transcript?")) return;
      this.chatTester.deleteTranscript(id);
      this._renderTranscriptList();
      this.showNotification("Transcript deleted.", "info");
    }
  },

  /* ── Personas ───────────────────────────────────────────────────────────── */

  _handleManagePersonas() {
    const modal = document.getElementById("chat-personas-modal");
    if (!modal) return;
    this._renderPersonaList();
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  },

  _closePersonasModal() {
    const modal = document.getElementById("chat-personas-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  },

  _renderPersonaList() {
    const list = document.getElementById("chat-personas-list");
    if (!list) return;
    const personas = ChatTester.getPersonas();

    if (personas.length === 0) {
      list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:1rem;">No personas yet. Create one below.</p>';
    } else {
      list.innerHTML = personas.map((p) => `
        <div class="persona-item">
          <div class="persona-info">
            <div class="persona-name">${escapeHtml(p.name)}</div>
            ${p.description ? `<div class="persona-desc">${escapeHtml(p.description)}</div>` : ""}
          </div>
          <div class="persona-actions">
            <button class="btn-small" data-persona-action="edit" data-persona-id="${escapeHtml(p.id)}">Edit</button>
            <button class="btn-small btn-danger" data-persona-action="delete" data-persona-id="${escapeHtml(p.id)}" style="background:var(--error);color:#fff;border-color:var(--error);">Delete</button>
          </div>
        </div>
      `).join("");
    }

    document.getElementById("chat-persona-form-name").value = "";
    document.getElementById("chat-persona-form-desc").value = "";
    document.getElementById("chat-persona-form-edit-id").value = "";
  },

  _handlePersonaListClick(e) {
    const btn = e.target.closest("[data-persona-action]");
    if (!btn) return;
    const id = btn.dataset.personaId;
    if (btn.dataset.personaAction === "edit") {
      const personas = ChatTester.getPersonas();
      const p = personas.find((p) => p.id === id);
      if (p) {
        document.getElementById("chat-persona-form-name").value = p.name;
        document.getElementById("chat-persona-form-desc").value = p.description || "";
        document.getElementById("chat-persona-form-edit-id").value = p.id;
        document.getElementById("chat-persona-form-submit-btn").textContent = "Update";
      }
    } else if (btn.dataset.personaAction === "delete") {
      if (!confirm("Delete this persona?")) return;
      ChatTester.deletePersona(id);
      this._renderPersonaList();
      this.showNotification("Persona deleted.", "info");
    }
  },

  _handlePersonaFormSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("chat-persona-form-name").value.trim();
    const desc = document.getElementById("chat-persona-form-desc").value.trim();
    const editId = document.getElementById("chat-persona-form-edit-id").value;

    if (!name) {
      this.showNotification("Enter a persona name.", "warning");
      return;
    }

    if (editId) {
      ChatTester.updatePersona(editId, name, desc);
    } else {
      ChatTester.addPersona(name, desc);
    }

    this._renderPersonaList();
    document.getElementById("chat-persona-form-submit-btn").textContent = "Add";
    document.getElementById("chat-persona-form-edit-id").value = "";

    // Update persona selector dropdown
    const select = document.getElementById("chat-persona-select");
    if (select) this._populatePersonaSelect(select);
  },

  _populatePersonaSelect(select) {
    if (!select) return;
    const personas = ChatTester.getPersonas();
    const current = this.chatTester ? this.chatTester.getPersonaName() : "User";
    select.innerHTML = `<option value="">Type a name or pick…</option>`;
    personas.forEach((p) => {
      select.innerHTML += `<option value="${escapeHtml(p.name)}" ${p.name === current ? "selected" : ""}>${escapeHtml(p.name)}</option>`;
    });
  },

  _handlePersonaSelectChange() {
    const select = document.getElementById("chat-persona-select");
    const input = document.getElementById("chat-persona-name");
    if (!select || !input) return;
    const val = select.value;
    if (val) {
      input.value = val;
      if (this.chatTester) {
        this.chatTester.setPersonaName(val);
        this.renderChatMessages();
      }
      select.value = "";
    }
  },

  /* ── Render ─────────────────────────────────────────────────────────────── */

  renderChatMessages() {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    container.innerHTML = "";
    const messages = this.chatTester ? this.chatTester.getMessages() : [];

    for (const msg of messages) {
      this._appendChatBubble(container, msg);
    }

    this.scrollChatToBottom();
  },

  _appendChatBubble(container, msg) {
    const isUser = msg.role === "user";
    const bubble = document.createElement("div");
    bubble.className = `chat-message ${isUser ? "chat-message-user" : "chat-message-character"}`;
    bubble.dataset.id = msg.id;

    const nameEl = document.createElement("div");
    nameEl.className = "chat-message-name";
    nameEl.textContent = isUser
      ? (this.chatTester?.getPersonaName() || "User")
      : (this.currentCharacter?.name || "Character");

    const contentEl = document.createElement("div");
    contentEl.className = "chat-message-content";
    contentEl.innerHTML = this._formatChatContent(msg.content, isUser);

    const actionsEl = document.createElement("div");
    actionsEl.className = "chat-message-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "chat-action-btn";
    editBtn.textContent = "Edit";
    editBtn.title = "Edit message";
    editBtn.addEventListener("click", () => this._handleChatEdit(msg.id));

    const delBtn = document.createElement("button");
    delBtn.className = "chat-action-btn";
    delBtn.textContent = "Delete";
    delBtn.title = "Delete message";
    delBtn.addEventListener("click", () => this._handleChatDelete(msg.id));

    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(delBtn);

    bubble.appendChild(nameEl);
    bubble.appendChild(contentEl);
    bubble.appendChild(actionsEl);
    container.appendChild(bubble);
  },

  _formatChatContent(text, isUser = false) {
    if (!text) return "";

    if (this.chatTester) {
      text = this.chatTester._replaceMacros(text);
    }

    // Escape HTML
    let html = escapeHtml(text);

    // Lorebook highlighting for user messages
    if (isUser && this.chatTester) {
      const matches = this.chatTester.getLorebookMatches(text);
      if (matches.length > 0) {
        // Build result with <mark> tags around matched words (case-insensitive replacement)
        let result = "";
        let lastIdx = 0;
        const lowerHtml = html.toLowerCase();
        for (const match of matches) {
          const wordLower = match.word.toLowerCase();
          const idx = lowerHtml.indexOf(wordLower, lastIdx);
          if (idx === -1) continue;
          result += html.slice(lastIdx, idx);
          result += `<mark class="lorebook-highlight" title="Lorebook: ${escapeHtml(match.entryName)}">${html.slice(idx, idx + match.word.length)}</mark>`;
          lastIdx = idx + match.word.length;
        }
        result += html.slice(lastIdx);
        html = result;
      }
    }

    // Convert *italics* to <em>
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Convert newlines to <br>
    html = html.replace(/\n/g, "<br>");
    return html;
  },

  updateChatMessage(id, content) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const bubble = container.querySelector(`[data-id="${id}"]`);
    if (!bubble) {
      // Message bubble doesn't exist yet (first chunk), render all
      this.renderChatMessages();
      return;
    }

    const contentEl = bubble.querySelector(".chat-message-content");
    if (contentEl) {
      const isUser = bubble.classList.contains("chat-message-user");
      contentEl.innerHTML = this._formatChatContent(content, isUser);
    }

    this.scrollChatToBottom();
  },

  showChatTypingIndicator() {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    let indicator = document.getElementById("chat-typing-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "chat-typing-indicator";
      indicator.className = "chat-typing-indicator";
      indicator.innerHTML = `
        <div class="chat-message-character" style="opacity:0.7;">
          <div class="chat-message-name">${escapeHtml(this.currentCharacter?.name || "Character")}</div>
          <div class="chat-typing-dots"><span></span><span></span><span></span></div>
        </div>
      `;
      container.appendChild(indicator);
      this.scrollChatToBottom();
    }
  },

  hideChatTypingIndicator() {
    const indicator = document.getElementById("chat-typing-indicator");
    if (indicator) indicator.remove();
  },

  scrollChatToBottom() {
    const container = document.getElementById("chat-messages");
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  },

  updateChatTokenCount() {
    const el = document.getElementById("chat-token-count");
    if (!el || !this.chatTester) return;
    const count = this.chatTester.getTokenEstimate();
    el.textContent = `~${count} tokens`;
  },

  /* ---------- Event Handlers ---------- */

  async handleChatSend() {
    if (!this.chatTester) return;
    if (this.chatTester.isGenerating) return;

    const input = document.getElementById("chat-input");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    input.disabled = true;

    const stopBtn = document.getElementById("chat-stop-btn");
    if (stopBtn) stopBtn.style.display = "inline-flex";

    // Push user message first, then render
    this.chatTester.messages.push({
      role: "user",
      content: text,
      id: Date.now(),
    });
    this.renderChatMessages();
    this.updateChatTokenCount();
    this.showChatTypingIndicator();

    // Set up streaming callbacks
    this._onChatStream = (chunk, fullContent, msgId) => {
      this.hideChatTypingIndicator();
      this.updateChatMessage(msgId, fullContent);
      this.updateChatTokenCount();
    };

    this._onChatError = (message) => {
      this.hideChatTypingIndicator();
      this.showNotification(`Chat error: ${message}`, "error");
      input.disabled = false;
      if (input) input.focus();
      if (stopBtn) stopBtn.style.display = "none";
    };

    this._onChatComplete = () => {
      input.disabled = false;
      if (input) input.focus();
      this.updateChatTokenCount();
      if (stopBtn) stopBtn.style.display = "none";
      this._onChatStream = null;
      this._onChatError = null;
      this._onChatComplete = null;
    };

    await this.chatTester.sendMessage(text);
  },

  async handleChatRegenerate() {
    if (!this.chatTester || this.chatTester.isGenerating) return;

    const stopBtn = document.getElementById("chat-stop-btn");
    if (stopBtn) stopBtn.style.display = "inline-flex";

    this.showChatTypingIndicator();

    this._onChatStream = (chunk, fullContent, msgId) => {
      this.hideChatTypingIndicator();
      this.updateChatMessage(msgId, fullContent);
      this.updateChatTokenCount();
    };

    this._onChatError = (message) => {
      this.hideChatTypingIndicator();
      this.showNotification(`Chat error: ${message}`, "error");
      if (stopBtn) stopBtn.style.display = "none";
    };

    this._onChatComplete = () => {
      this.updateChatTokenCount();
      if (stopBtn) stopBtn.style.display = "none";
      this._onChatStream = null;
      this._onChatError = null;
      this._onChatComplete = null;
    };

    await this.chatTester.regenerate();
  },

  handleChatClear() {
    if (!this.chatTester) return;
    if (this.chatTester.isGenerating) {
      this.showNotification("Stop generation before clearing chat.", "warning");
      return;
    }
    this.chatTester.clear();
    // Re-inject first message if available
    if (this.currentCharacter?.firstMessage) {
      this.chatTester.messages.push({
        role: "assistant",
        content: this.currentCharacter.firstMessage,
        id: Date.now(),
      });
    }
    this.renderChatMessages();
    this.updateChatTokenCount();
  },

  handleChatStop() {
    if (this.chatTester) {
      this.chatTester.stopGeneration();
    }
  },

  _handleChatEdit(id) {
    if (!this.chatTester) return;
    const msg = this.chatTester.getMessages().find((m) => m.id === id);
    if (!msg) return;

    const newContent = prompt("Edit message:", msg.content);
    if (newContent === null) return; // Cancelled

    const trimmed = newContent.trim();
    if (!trimmed) {
      this.showNotification("Message cannot be empty.", "warning");
      return;
    }

    this.chatTester.editMessage(id, trimmed);
    this.renderChatMessages();
    this.updateChatTokenCount();

    // If the edited message was the last one and it's a user message, auto-regenerate
    const messages = this.chatTester.getMessages();
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.id === id && lastMsg.role === "user") {
      this.handleChatRegenerate();
    }
  },

  _handleChatDelete(id) {
    if (!this.chatTester) return;
    if (this.chatTester.isGenerating) {
      this.showNotification("Stop generation before deleting messages.", "warning");
      return;
    }
    if (!confirm("Delete this message?")) return;

    this.chatTester.deleteMessage(id);
    this.renderChatMessages();
    this.updateChatTokenCount();
  },

  handleChatPersonaChange() {
    const input = document.getElementById("chat-persona-name");
    if (input && this.chatTester) {
      this.chatTester.setPersonaName(input.value.trim());
      this.renderChatMessages(); // Update user name labels
    }
  },

  handleChatExport() {
    if (!this.chatTester || !this.currentCharacter) return;
    const messages = this.chatTester.getMessages();
    if (messages.length === 0) {
      this.showNotification("No messages to export.", "warning");
      return;
    }

    const charName = this.currentCharacter.name || "Character";
    const userName = this.chatTester.getPersonaName();
    const lines = [`# Chat with ${charName}\n`];

    for (const msg of messages) {
      const name = msg.role === "user" ? userName : charName;
      lines.push(`**${name}:** ${msg.content}\n`);
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${charName.replace(/\s+/g, "_")}-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showNotification("Chat exported as markdown.", "success");
  },
});

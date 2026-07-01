// Chat Tester UI Module - Modal rendering, message bubbles, lorebook highlighting, toolbar params, transcripts, personas, swipes, markdown, slots
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

    // Sync slot selector
    this._renderChatSlotSelector();

    // If no active slot, create one
    const slots = this.chatTester.getSlots();
    if (!this.chatTester.activeSlotId) {
      if (slots.length === 0) {
        const slot = this.chatTester.createSlot("Main");
        this.chatTester.activeSlotId = slot.id;
      } else {
        this.chatTester.activeSlotId = slots[0].id;
        this.chatTester.loadSlot(slots[0].id);
      }
    }

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

    // ── Mobile enhancements ──────────────────────────────────────────────────
    const isMobile = window.innerWidth <= 768;

    // Touch-device class — show Edit/Delete actions without hover
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
      modal.classList.add("chat-touch-device");
    }

    // Collapse param toolbars on mobile by default
    if (isMobile) {
      modal.classList.add("chat-mobile-params-collapsed");
    } else {
      modal.classList.remove("chat-mobile-params-collapsed");
    }

    // Note: iOS Safari viewport height fallback removed. Use CSS dvh if necessary.

    // Focus input
    const input = document.getElementById("chat-input");
    if (input) setTimeout(() => input.focus(), 100);
  },

  /**
   * Launch a roleplay chat with the currently loaded character.
   * - Switches to the Roleplay Chat tab.
   * - Checks all existing chats for one that already has this character attached.
   * - If found, offers to Continue or start a New Chat.
   * - Otherwise opens the New Chat modal with the character pre-attached.
   */
  async handleChatWithChar() {
    if (!this.currentCharacter) {
      this.showNotification("Generate or import a character first.", "warning");
      return;
    }

    const charName = this.currentCharacter.name || "Character";
    const handler = window.roleplayChatHandler;

    if (!handler) {
      this.showNotification("Roleplay Chat module not loaded.", "error");
      return;
    }

    // 1. Switch to the Roleplay Chat tab
    const tabChat = document.getElementById("tab-roleplaychat");
    if (tabChat) tabChat.click();

    // Give the tab a moment to render
    await new Promise(r => setTimeout(r, 80));

    // 2. Fetch all chats from the server and find the most recent one
    //    that has this character attached (matched by name)
    let existingChatId = null;
    try {
      const res = await window.authFetch("/api/sw/chats/");
      if (res.ok) {
        const allChats = await res.json();
        // Sort newest first so we resume the most recent session
        allChats.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

        for (const c of allChats) {
          const chars = c.characters || [];
          if (chars.some(ch => (ch.name || "").toLowerCase() === charName.toLowerCase())) {
            existingChatId = c.id;
            break;
          }
        }
      }
    } catch (err) {
      console.error("handleChatWithChar: failed to fetch chats", err);
    }

    if (existingChatId) {
      // Show a styled "Continue or New?" dialog
      const overlay = document.createElement("div");
      overlay.id = "chat-with-char-dialog";
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,0.55); display: flex;
        align-items: center; justify-content: center;
      `;
      overlay.innerHTML = `
        <div style="
          background: var(--surface-color); border: 1px solid var(--border);
          border-radius: 0.75rem; padding: 2rem; max-width: 420px; width: 90%;
          box-shadow: 0 8px 32px rgba(0,0,0,0.35);
          display: flex; flex-direction: column; gap: 1.25rem;
        ">
          <h3 style="margin:0; font-size: 1.1rem;">🎭 Chat with ${charName}</h3>
          <p style="margin:0; color: var(--text-secondary); font-size: 0.9rem;">
            A chat with <strong>${charName}</strong> already exists.
            Would you like to continue it or start a fresh one?
          </p>
          <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
            <button id="cwc-continue-btn" class="btn-primary" style="flex:1; min-width:120px;">
              ▶ Continue
            </button>
            <button id="cwc-new-btn" class="btn-outline" style="flex:1; min-width:120px;">
              ✨ New Chat
            </button>
            <button id="cwc-cancel-btn" class="btn-secondary" style="flex:1; min-width:120px;">
              Cancel
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      await new Promise(resolve => {
        overlay.querySelector("#cwc-continue-btn").addEventListener("click", () => {
          document.body.removeChild(overlay);
          handler.loadSessionList().then(() => handler.selectChat(existingChatId));
          resolve("continue");
        });
        overlay.querySelector("#cwc-new-btn").addEventListener("click", async () => {
          document.body.removeChild(overlay);
          await this._openNewChatForChar(charName, handler);
          resolve("new");
        });
        overlay.querySelector("#cwc-cancel-btn").addEventListener("click", () => {
          document.body.removeChild(overlay);
          resolve("cancel");
        });
      });
    } else {
      // No existing session — open the New Chat modal with the character attached
      await this._openNewChatForChar(charName, handler);
    }
  },

  /**
   * Open the Roleplay Chat "New Chat" modal with this character pre-attached.
   * Matches the character to the server-side card list by name (avoiding
   * the local IndexedDB ID vs server ID mismatch).
   */
  async _openNewChatForChar(charName, handler) {
    // Open the modal with no preset; it will load availableCards from the server
    await handler.openNewChatModal(null);

    // Pre-fill the chat title with the character name
    const titleInput = document.getElementById("chat-new-title");
    if (titleInput && !titleInput.value) {
      titleInput.value = charName;
    }

    // Find the matching server-side card by name and pre-select it
    const availableCards = handler.availableCards || [];
    const matchedCard = availableCards.find(
      c => (c.name || "").toLowerCase() === charName.toLowerCase()
    );

    if (matchedCard) {
      if (!handler.newChatSelectedCards) handler.newChatSelectedCards = [];
      const alreadySelected = handler.newChatSelectedCards.some(c => c.id === matchedCard.id);
      if (!alreadySelected) {
        handler.newChatSelectedCards.push(matchedCard);
        handler.renderNewChatSelectedChars();
      }
    }
  },

  closeChatTester() {
    const modal = document.getElementById("chat-tester-modal");
    if (!modal) return;
    // Save current slot before closing
    if (this.chatTester) {
      this.chatTester.saveCurrentSlot();
    }
    modal.classList.remove("show");
    modal.classList.remove("chat-mobile-params-collapsed");
    modal.classList.remove("chat-touch-device");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";

    // Clean up mobile viewport listener if any remains
    if (this._chatMobileVhUpdate) {
      window.removeEventListener("resize", this._chatMobileVhUpdate);
      this._chatMobileVhUpdate = null;
    }
  },

  /* ── Chat Slots ─────────────────────────────────────────────────────────── */

  _renderChatSlotSelector() {
    const select = document.getElementById("chat-slot-select");
    if (!select || !this.chatTester) return;
    const slots = this.chatTester.getSlots();
    const active = this.chatTester.activeSlotId;
    let html = `<option value="" ${!active ? "selected" : ""}>📝 New Chat…</option>`;
    for (const slot of slots) {
      html += `<option value="${escapeHtml(slot.id)}" ${slot.id === active ? "selected" : ""}>${escapeHtml(slot.name)}</option>`;
    }
    select.innerHTML = html;
  },

  _handleChatSlotChange() {
    const select = document.getElementById("chat-slot-select");
    if (!select || !this.chatTester) return;
    const val = select.value;

    // Save current before switching
    this.chatTester.saveCurrentSlot();

    if (!val) {
      // New slot
      const name = prompt("Name for new chat:", `Chat ${this.chatTester.getSlots().length + 1}`);
      if (!name) {
        this._renderChatSlotSelector();
        return;
      }
      const slot = this.chatTester.createSlot(name.trim());
      this.chatTester.activeSlotId = slot.id;
      this.chatTester.messages = [];
      // Inject first message
      if (this.currentCharacter?.firstMessage) {
        this.chatTester.messages.push({
          role: "assistant",
          content: this.currentCharacter.firstMessage,
          id: Date.now(),
        });
      }
    } else {
      this.chatTester.loadSlot(val);
    }

    this.renderChatMessages();
    this.updateChatTokenCount();
    this._renderChatSlotSelector();
  },

  _handleRenameSlot() {
    if (!this.chatTester || !this.chatTester.activeSlotId) return;
    const slots = this.chatTester.getSlots();
    const slot = slots.find((s) => s.id === this.chatTester.activeSlotId);
    if (!slot) return;
    const name = prompt("Rename chat:", slot.name);
    if (name && name.trim()) {
      this.chatTester.renameSlot(slot.id, name.trim());
      this._renderChatSlotSelector();
    }
  },

  _handleDeleteSlot() {
    if (!this.chatTester || !this.chatTester.activeSlotId) return;
    if (!confirm("Delete this chat slot? This cannot be undone.")) return;
    this.chatTester.deleteSlot(this.chatTester.activeSlotId);
    this.chatTester.activeSlotId = null;
    this.chatTester.messages = [];
    // Create a fresh slot
    const slot = this.chatTester.createSlot("Main");
    this.chatTester.activeSlotId = slot.id;
    if (this.currentCharacter?.firstMessage) {
      this.chatTester.messages.push({
        role: "assistant",
        content: this.currentCharacter.firstMessage,
        id: Date.now(),
      });
    }
    this.renderChatMessages();
    this.updateChatTokenCount();
    this._renderChatSlotSelector();
  },

  /* ── Param Controls ─────────────────────────────────────────────────────── */

  _syncChatParamControls() {
    if (!this.chatTester) return;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setVal("chat-temperature", this.chatTester.temperature);
    setText("chat-temp-value", this.chatTester.temperature);
    setVal("chat-top-p", this.chatTester.topP);
    setText("chat-top-p-value", this.chatTester.topP);
    setVal("chat-max-tokens", this.chatTester.maxTokens);

    setVal("chat-freq-penalty", this.chatTester.frequencyPenalty);
    setText("chat-freq-penalty-value", this.chatTester.frequencyPenalty);
    setVal("chat-pres-penalty", this.chatTester.presencePenalty);
    setText("chat-pres-penalty-value", this.chatTester.presencePenalty);
    setVal("chat-top-k", this.chatTester.topK);
    setText("chat-top-k-value", this.chatTester.topK);
    setVal("chat-min-p", this.chatTester.minP);
    setText("chat-min-p-value", this.chatTester.minP);
    setVal("chat-seed", this.chatTester.seed ?? "");
    setVal("chat-stop-sequences", this.chatTester.stopSequences.join(", "));

    setVal("chat-authors-note", this.chatTester.authorsNote);
    setVal("chat-authors-note-depth", this.chatTester.authorsNoteDepth);
    setText("chat-authors-note-depth-value", this.chatTester.authorsNoteDepth);
  },

  _handleChatParamChange() {
    if (!this.chatTester) return;
    const read = (id, parser = (v) => v) => {
      const el = document.getElementById(id);
      return el ? parser(el.value) : undefined;
    };

    this.chatTester.temperature = read("chat-temperature", (v) => parseFloat(v));
    this.chatTester.topP = read("chat-top-p", (v) => parseFloat(v));
    this.chatTester.maxTokens = read("chat-max-tokens", (v) => parseInt(v, 10) || 800);
    this.chatTester.frequencyPenalty = read("chat-freq-penalty", (v) => parseFloat(v));
    this.chatTester.presencePenalty = read("chat-pres-penalty", (v) => parseFloat(v));
    this.chatTester.topK = read("chat-top-k", (v) => parseInt(v, 10) || 0);
    this.chatTester.minP = read("chat-min-p", (v) => parseFloat(v));

    const seedVal = read("chat-seed", (v) => v.trim());
    this.chatTester.seed = seedVal ? parseInt(seedVal, 10) : null;

    const stopVal = read("chat-stop-sequences", (v) => v);
    this.chatTester.stopSequences = stopVal
      ? stopVal.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    this.chatTester.authorsNote = read("chat-authors-note", (v) => v) || "";
    this.chatTester.authorsNoteDepth = read("chat-authors-note-depth", (v) => parseInt(v, 10) || 0);

    // Update displayed values
    const updateText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    updateText("chat-temp-value", this.chatTester.temperature);
    updateText("chat-top-p-value", this.chatTester.topP);
    updateText("chat-freq-penalty-value", this.chatTester.frequencyPenalty);
    updateText("chat-pres-penalty-value", this.chatTester.presencePenalty);
    updateText("chat-top-k-value", this.chatTester.topK);
    updateText("chat-min-p-value", this.chatTester.minP);
    updateText("chat-authors-note-depth-value", this.chatTester.authorsNoteDepth);

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
    document.getElementById("chat-persona-form-prefix").value = "";
    document.getElementById("chat-persona-form-suffix").value = "";
    document.getElementById("chat-persona-form-edit-id").value = "";
    document.getElementById("chat-persona-form-submit-btn").textContent = "Add";
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
        document.getElementById("chat-persona-form-prefix").value = p.systemPrefix || "";
        document.getElementById("chat-persona-form-suffix").value = p.systemSuffix || "";
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
    const prefix = document.getElementById("chat-persona-form-prefix").value.trim();
    const suffix = document.getElementById("chat-persona-form-suffix").value.trim();
    const editId = document.getElementById("chat-persona-form-edit-id").value;

    if (!name) {
      this.showNotification("Enter a persona name.", "warning");
      return;
    }

    if (editId) {
      ChatTester.updatePersona(editId, name, desc, prefix, suffix);
    } else {
      ChatTester.addPersona(name, desc, prefix, suffix);
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

    const messages = this.chatTester ? this.chatTester.getMessages() : [];
    const currentMsgIds = new Set(messages.map(m => String(m.id)));

    // Remove bubbles that no longer exist
    Array.from(container.children).forEach(bubble => {
      if (!currentMsgIds.has(bubble.dataset.id)) {
        bubble.remove();
      }
    });

    // Update existing or append new in order
    for (const msg of messages) {
      const existingBubble = container.querySelector(`[data-id="${msg.id}"]`);
      const newBubble = this._createChatBubble(msg);
      
      if (existingBubble) {
        if (existingBubble.innerHTML !== newBubble.innerHTML) {
          existingBubble.replaceWith(newBubble);
        }
        // Ensure order is correct in case messages were inserted (unlikely in chat, but safe)
        container.appendChild(existingBubble.parentNode ? existingBubble : newBubble);
      } else {
        container.appendChild(newBubble);
      }
    }

    this.scrollChatToBottom();
  },

  _createChatBubble(msg) {
    const isUser = msg.role === "user";
    const bubble = document.createElement("div");
    bubble.className = `chat-message ${isUser ? "chat-message-user" : "chat-message-character"}`;
    bubble.dataset.id = msg.id;

    const inner = document.createElement("div");
    inner.className = "chat-message-inner";

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = `chat-avatar ${isUser ? "chat-avatar-user" : "chat-avatar-char"}`;
    if (isUser) {
      avatar.textContent = (this.chatTester?.getPersonaName() || "User").slice(0, 2).toUpperCase();
    } else {
      const charImg = this.currentCharacter?.avatarBase64;
      if (charImg) {
        avatar.innerHTML = `<img src="${charImg}" alt="">`;
      } else {
        avatar.textContent = (this.currentCharacter?.name || "Char").slice(0, 2).toUpperCase();
      }
    }

    const body = document.createElement("div");
    body.className = "chat-message-body";

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

    body.appendChild(nameEl);
    body.appendChild(contentEl);
    body.appendChild(actionsEl);

    if (isUser) {
      inner.appendChild(body);
      inner.appendChild(avatar);
    } else {
      inner.appendChild(avatar);
      inner.appendChild(body);
    }

    bubble.appendChild(inner);

    // Swipe bar for assistant messages
    if (!isUser) {
      const swipeInfo = this.chatTester?.getSwipeInfo(msg.id);
      if (swipeInfo && swipeInfo.total > 1) {
        const swipeBar = document.createElement("div");
        swipeBar.className = "chat-swipe-bar";
        swipeBar.innerHTML = `
          <button class="chat-swipe-btn" data-swipe-dir="prev" data-swipe-id="${msg.id}" title="Previous swipe">◀</button>
          <span class="chat-swipe-count">${swipeInfo.current + 1} / ${swipeInfo.total}</span>
          <button class="chat-swipe-btn" data-swipe-dir="next" data-swipe-id="${msg.id}" title="Next swipe">▶</button>
        `;
        swipeBar.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-swipe-dir]");
          if (!btn) return;
          const dir = btn.dataset.swipeDir;
          const id = parseInt(btn.dataset.swipeId, 10);
          const info = this.chatTester.getSwipeInfo(id);
          if (!info) return;
          let next = info.current;
          if (dir === "prev") next = Math.max(0, next - 1);
          else next = Math.min(info.total - 1, next + 1);
          this.chatTester.setSwipeIndex(id, next);
          this.renderChatMessages();
        });
        bubble.appendChild(swipeBar);
      }
    }

    return bubble;
  },

  _formatChatContent(text, isUser = false) {
    if (!text) return "";

    if (this.chatTester) {
      text = this.chatTester._replaceMacros(text);
    }

    // Strip CJK characters if enabled in settings
    if (window.config && window.config.get("chat.filterCJK")) {
        text = text.replace(/[\u2E80-\u2FD5\u3190-\u319f\u3400-\u4DBF\u4E00-\u9FCC\uF900-\uFAAD\uAC00-\uD7A3]/g, '');
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

    // Extract code blocks first so internal markdown isn't transformed
    const codeBlocks = [];
    html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
      codeBlocks.push(code);
      return `{{CODE_BLOCK_${codeBlocks.length - 1}}}`;
    });

    // Blockquote lines (after escapeHtml, > becomes >)
    html = html.replace(/^> (.+)$/gm, '<blockquote class="chat-blockquote">$1</blockquote>');

    // Convert newlines to <br>
    html = html.replace(/\n/g, "<br>");

    // Inline markdown
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");   // Bold
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");               // Italics
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");             // Strikethrough
    html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>'); // Inline code

    // Restore code blocks
    codeBlocks.forEach((code, i) => {
      html = html.replace(`{{CODE_BLOCK_${i}}}`, `<pre class="chat-code-block"><code>${code}</code></pre>`);
    });

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
      // Persist slot
      this.chatTester.saveCurrentSlot();
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
      this.chatTester.saveCurrentSlot();
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
    this.chatTester.saveCurrentSlot();
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
    this.chatTester.saveCurrentSlot();

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
    this.chatTester.saveCurrentSlot();
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

  handleChatExportJSONL() {
    if (!this.chatTester || !this.currentCharacter) return;
    const messages = this.chatTester.getMessages();
    if (messages.length === 0) {
      this.showNotification("No messages to export.", "warning");
      return;
    }

    const charName = this.currentCharacter.name || "Character";
    const userName = this.chatTester.getPersonaName();
    const exportData = {
      character_name: charName,
      create_date: new Date().toISOString(),
      chat_metadata: {
        note_prompt: this.chatTester.authorsNote || "",
        note_depth: this.chatTester.authorsNoteDepth,
        exported_from: "CardGenV2",
      },
    };

    const mesLines = messages.map((msg) => {
      const isUser = msg.role === "user";
      return JSON.stringify({
        name: isUser ? userName : charName,
        is_user: isUser,
        mes: msg.content,
        send_date: new Date(msg.id || Date.now()).toISOString(),
        ...(!isUser && msg.swipes && msg.swipes.length > 1 ? { swipes: msg.swipes, swipe_id: msg.swipeIndex } : {}),
      });
    });

    const lines = [JSON.stringify(exportData), ...mesLines];
    const blob = new Blob([lines.join("\n")], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${charName.replace(/\s+/g, "_")}-${Date.now()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showNotification("Chat exported as SillyTavern JSONL.", "success");
  },
});

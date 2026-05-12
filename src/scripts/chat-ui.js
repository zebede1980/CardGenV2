// Chat Tester UI Module - Modal rendering, message bubbles, and event handling
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
      this.chatTester.setPersonaName(personaInput.value.trim());
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
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");

    // Focus input
    const input = document.getElementById("chat-input");
    if (input) setTimeout(() => input.focus(), 100);
  },

  closeChatTester() {
    const modal = document.getElementById("chat-tester-modal");
    if (!modal) return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  },

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
    contentEl.innerHTML = this._formatChatContent(msg.content);

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

  _formatChatContent(text) {
    if (!text) return "";
    // Escape HTML, then convert markdown-like formatting
    let html = escapeHtml(text);
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
      contentEl.innerHTML = this._formatChatContent(content);
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

    const input = document.getElementById("chat-input");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    input.disabled = true;

    const stopBtn = document.getElementById("chat-stop-btn");
    if (stopBtn) stopBtn.style.display = "inline-flex";

    // Render user message immediately
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
      this.handleChatSend();
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

// Bridge from the Character Generator screen into Roleplay Chat.
// This file used to be the whole standalone "Chat Tester" UI module (modal
// rendering, message bubbles, transcripts, personas, slots, sampler params —
// over 1000 lines of it). That modal was fully superseded once Roleplay Chat
// was built out with persistent history, multi-character support, and
// memory — the "Test Chat" button was repointed at handleChatWithChar()
// below, and the old modal/class became dead code. Removed 2026-08-17; see
// git history (pre-dating this commit) if any of it is ever needed again.
Object.assign(CharacterGeneratorApp.prototype, {
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
});

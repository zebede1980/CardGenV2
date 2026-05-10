// SillyTavern Bridge — extends CharacterGeneratorApp prototype
// Handles browsing, loading, and pushing character cards to/from a SillyTavern
// instance on the same Docker network (container-to-container, bypasses nginx).
Object.assign(CharacterGeneratorApp.prototype, {

  // ── Helpers ────────────────────────────────────────────────────────────────

  _stHeaders() {
    const url = this.config.get("st.baseUrl") || "";
    if (!url) return null;
    return { "Content-Type": "application/json", "X-ST-URL": url.replace(/\/$/, "") };
  },

  // ── Connection test ────────────────────────────────────────────────────────

  async handleTestSTConnection() {
    const headers = this._stHeaders();
    if (!headers) {
      this.showNotification("Enter a SillyTavern URL in API Settings first", "warning");
      return;
    }
    const btn = document.getElementById("test-st-btn");
    const status = document.getElementById("st-connection-status");
    if (btn) { btn.disabled = true; btn.textContent = "Testing…"; }
    if (status) { status.textContent = ""; status.className = "st-status"; }
    try {
      const res = await fetch("/api/st/ping", { headers });
      const data = await res.json();
      if (data.ok) {
        if (status) {
          status.textContent = `✅ Connected — ${data.characterCount} character(s)`;
          status.className = "st-status st-status-ok";
        }
        this.showNotification(`Connected to SillyTavern (${data.characterCount} characters)`, "success");
      } else {
        if (status) {
          status.textContent = `❌ Connection failed (${data.status || data.error})`;
          status.className = "st-status st-status-err";
        }
        this.showNotification("SillyTavern connection failed", "error");
      }
    } catch (err) {
      if (status) {
        status.textContent = `❌ ${err.message}`;
        status.className = "st-status st-status-err";
      }
      this.showNotification("SillyTavern connection error", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Test Connection"; }
    }
  },

  // ── Browse ST characters ───────────────────────────────────────────────────

  async handleRefreshSTLibrary() {
    const headers = this._stHeaders();
    const list = document.getElementById("st-characters-list");
    if (!list) return;

    if (!headers) {
      list.innerHTML = '<p class="library-empty">Configure SillyTavern URL in API Settings to browse characters.</p>';
      return;
    }

    list.innerHTML = '<p class="library-empty">Loading…</p>';
    try {
      const res = await fetch("/api/st/characters", { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const characters = await res.json();

      if (!Array.isArray(characters) || characters.length === 0) {
        list.innerHTML = '<p class="library-empty">No characters found in SillyTavern.</p>';
        return;
      }

      // Sort by date_added descending (most recent first)
      characters.sort((a, b) => (b.date_added || 0) - (a.date_added || 0));

      const stUrl = (this.config.get("st.baseUrl") || "").replace(/\/$/, "");
      list.innerHTML = characters.map(c => {
        const name = this._escHtml(c.name || c.data?.name || "Unnamed");
        const avatar = c.avatar || "";
        const date = c.date_added ? new Date(c.date_added).toLocaleDateString() : "";
        const description = c.data?.description || c.description || "";
        const firstMes = c.data?.first_mes || c.first_mes || "";
        const tags = Array.isArray(c.tags) ? c.tags : (Array.isArray(c.data?.tags) ? c.data.tags : []);
        const snippet = this._escHtml((description || firstMes).replace(/\n+/g, " ").trim().slice(0, 120));
        const tagHtml = tags.slice(0, 5).map(t => `<span class="st-card-tag">${this._escHtml(String(t))}</span>`).join("");
        // Route thumbnail through our proxy — the browser can't reach ST directly
        const thumbUrl = avatar
          ? `/api/st/thumbnail?file=${encodeURIComponent(avatar)}&stUrl=${encodeURIComponent(stUrl)}`
          : "";
        const thumbHtml = thumbUrl
          ? `<img class="st-card-thumb" src="${thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="st-card-thumb st-card-thumb-placeholder"></div>`;
        return `
          <div class="library-item st-card">
            ${thumbHtml}
            <div class="st-card-body">
              <div class="library-item-title">${name}</div>
              ${snippet ? `<div class="st-card-snippet">${snippet}…</div>` : ""}
              ${tagHtml ? `<div class="st-card-tags">${tagHtml}</div>` : ""}
              <div class="st-card-footer">
                <span class="library-item-date">${date}</span>
                <div class="library-item-actions">
                  <button class="btn-small" data-action="load-st-card" data-avatar="${this._escHtml(avatar)}" data-name="${this._escHtml(c.name || c.data?.name || "Unnamed")}">Load</button>
                </div>
              </div>
            </div>
          </div>`;
      }).join("");
    } catch (err) {
      console.error("ST library refresh error:", err);
      list.innerHTML = `<p class="library-empty" style="color:var(--error);">Error: ${err.message}</p>`;
    }
  },

  async handleSTLibraryClick(event) {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "load-st-card") {
      await this.loadCardFromST(btn.dataset.avatar, btn.dataset.name);
    }
  },

  // ── Load a card from ST ────────────────────────────────────────────────────

  async loadCardFromST(avatarUrl, name) {
    const headers = this._stHeaders();
    if (!headers) return;

    this.showNotification(`Loading "${name}" from SillyTavern…`, "info");
    try {
      const res = await fetch("/api/st/export", {
        method: "POST",
        headers,
        body: JSON.stringify({ avatar_url: avatarUrl }),
      });
      if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);

      const blob = await res.blob();
      const file = new File([blob], avatarUrl, { type: "image/png" });

      // Remember the source avatar so "Push" knows to update not create
      this.stSourceAvatar = avatarUrl;
      this._updatePushButton();

      // Reuse existing PNG import pipeline — handles all normalisation
      await this.handleImportCardFile(file, false);
      this.showNotification(`"${name}" loaded from SillyTavern`, "success");
    } catch (err) {
      console.error("ST load error:", err);
      this.showNotification(`Failed to load from SillyTavern: ${err.message}`, "error");
    }
  },

  // ── Push current card to ST ────────────────────────────────────────────────

  async handlePushToST() {
    if (!this.currentCharacter) {
      this.showNotification("Generate or load a character first", "warning");
      return;
    }
    const headers = this._stHeaders();
    if (!headers) {
      this.showNotification("Configure SillyTavern URL in API Settings first", "warning");
      return;
    }

    const charName = this.currentCharacter.name || "Unknown";
    const isUpdate = !!this.stSourceAvatar;

    // Build confirmation message
    let confirmMsg;
    if (isUpdate) {
      const sourceName = this.stSourceAvatar.replace(".png", "");
      if (sourceName.toLowerCase() === charName.toLowerCase()) {
        confirmMsg = `Update "${sourceName}" in SillyTavern?`;
      } else {
        // Name changed — offer choice
        const choice = await this._showPushChoiceModal(charName, this.stSourceAvatar);
        if (choice === "cancel") return;
        if (choice === "new") {
          // Push as new, don't preserve source name
          await this._doPushToST(headers, charName, null);
          return;
        }
        // choice === "update" — update the original slot
        await this._doPushToST(headers, charName, this.stSourceAvatar.replace(".png", ""));
        return;
      }
    } else {
      confirmMsg = `Add "${charName}" to SillyTavern as a new character?`;
    }

    if (!confirm(confirmMsg)) return;

    const preservedName = isUpdate ? this.stSourceAvatar.replace(".png", "") : null;
    await this._doPushToST(headers, charName, preservedName);
  },

  async _doPushToST(headers, charName, preservedName) {
    const btn = document.getElementById("push-to-st-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Pushing…"; }
    try {
      this.showNotification("Encoding character card…", "info");

      // Encode the current character to PNG using the same pipeline as Download
      const pngBlob = await this._encodeCurrentCharacterAsPng();
      const arrayBuffer = await pngBlob.arrayBuffer();
      const pngBase64 = this._arrayBufferToBase64(arrayBuffer);

      this.showNotification("Sending to SillyTavern…", "info");
      const body = { pngBase64 };
      if (preservedName) body.preservedName = preservedName;

      const res = await fetch("/api/st/push", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();

      // After a successful push, lock stSourceAvatar to the returned filename
      // so subsequent pushes correctly update the same slot
      if (data.file_name) {
        this.stSourceAvatar = data.file_name.endsWith(".png") ? data.file_name : `${data.file_name}.png`;
        this._updatePushButton();
      }

      const verb = preservedName ? "updated" : "added";
      this.showNotification(`"${charName}" ${verb} in SillyTavern! ✅`, "success");

      // Refresh ST library to reflect the change
      await this.handleRefreshSTLibrary();
    } catch (err) {
      console.error("ST push error:", err);
      this.showNotification(`Push to SillyTavern failed: ${err.message}`, "error");
    } finally {
      if (btn) { btn.disabled = false; this._updatePushButton(); }
    }
  },

  // ── Encode helper ──────────────────────────────────────────────────────────

  async _encodeCurrentCharacterAsPng() {
    // Build the same character object the Download button uses
    const character = this.currentCharacter;

    const imageBlob = this.currentImageUrl
      ? await fetch(this.currentImageUrl).then(r => r.blob()).catch(() => null)
      : null;

    const charData = {
      name: character.name || "",
      description: character.description || "",
      personality: character.personality || "",
      scenario: character.scenario || "",
      first_mes: character.firstMessage || "",
      mes_example: character.mesExample || "",
      creator_notes: character.creatorNotes || "",
      system_prompt: character.systemPrompt || "",
      post_history_instructions: character.postHistoryInstructions || "",
      alternate_greetings: this.altGreetings.map(g => g.content),
      tags: character.tags || [],
      creator: character.creator || "",
      character_version: character.characterVersion || "",
      character_book: this.lorebookData || (this.lorebookEntries.length > 0 ? {
        name: `${character.name || "Character"} Lorebook`,
        entries: this.lorebookEntries,
      } : undefined),
    };

    return await window.pngEncoder.createCharacterCard(imageBlob, charData);
  },

  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  },

  _escHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  },

  // ── Push choice modal (name changed) ──────────────────────────────────────

  _showPushChoiceModal(newName, sourceAvatar) {
    return new Promise(resolve => {
      const modal = document.getElementById("st-push-choice-modal");
      const msg = document.getElementById("st-push-choice-msg");
      if (!modal) { resolve("cancel"); return; }

      if (msg) msg.innerHTML =
        `The character name changed from <strong>${this._escHtml(sourceAvatar.replace(".png",""))}</strong> to <strong>${this._escHtml(newName)}</strong>.<br>What would you like to do?`;

      const close = (choice) => {
        modal.classList.remove("show");
        document.body.style.overflow = "";
        resolve(choice);
      };

      document.getElementById("st-push-update-btn").onclick = () => close("update");
      document.getElementById("st-push-new-btn").onclick = () => close("new");
      document.getElementById("st-push-cancel-btn").onclick = () => close("cancel");

      modal.classList.add("show");
      document.body.style.overflow = "hidden";

      const escHandler = (e) => { if (e.key === "Escape") { document.removeEventListener("keydown", escHandler); close("cancel"); } };
      document.addEventListener("keydown", escHandler);
    });
  },

  // ── Update push button label based on state ────────────────────────────────

  _updatePushButton() {
    const btn = document.getElementById("push-to-st-btn");
    if (!btn) return;
    const stUrl = this.config.get("st.baseUrl");
    if (!stUrl) { btn.style.display = "none"; return; }

    if (this.stSourceAvatar) {
      btn.textContent = `📤 Update in ST (${this.stSourceAvatar.replace(".png", "")})`;
      btn.title = `Update the existing SillyTavern character card "${this.stSourceAvatar}"`;
    } else {
      btn.textContent = "📤 Push to SillyTavern";
      btn.title = "Add this character as a new card in SillyTavern";
    }
    btn.style.display = this.currentCharacter ? "inline-flex" : "none";
  },

});

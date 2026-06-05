// URL Import Module — extends CharacterGeneratorApp prototype
// Handles importing character cards from JanitorAI and Chub.ai URLs
Object.assign(CharacterGeneratorApp.prototype, {

  /* ── Open / Close Modal ────────────────────────────────────────────────── */

  openUrlImportModal() {
    const modal = document.getElementById("url-import-modal");
    if (!modal) return;
    document.getElementById("url-import-input").value = "";
    document.getElementById("url-import-status").innerHTML = "";
    document.getElementById("url-import-preview").style.display = "none";
    this._urlImportData = null;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setTimeout(() => document.getElementById("url-import-input")?.focus(), 100);

    // Inject token input if not exists
    const urlInput = document.getElementById("url-import-input");
    if (urlInput && !document.getElementById("url-import-token-input")) {
      const tokenInput = document.createElement("input");
      tokenInput.id = "url-import-token-input";
      tokenInput.type = "password";
      tokenInput.placeholder = "Chub.ai API Token (Optional, for NSFW/Private)";
      tokenInput.className = "content-box";
      tokenInput.style.cssText = "width:100%; padding:0.6rem 0.75rem; margin-bottom:0.75rem;";
      urlInput.parentNode.insertBefore(tokenInput, urlInput.nextSibling);
    }

    // Inject Import & Remaster button if not exists
    const confirmBtn = document.getElementById("url-import-confirm-btn");
    if (confirmBtn && !document.getElementById("url-import-remaster-btn")) {
      const remasterBtn = document.createElement("button");
      remasterBtn.id = "url-import-remaster-btn";
      remasterBtn.className = "btn-secondary";
      remasterBtn.textContent = "Import & Remaster";
      remasterBtn.style.flex = "1";
      remasterBtn.addEventListener("click", () => this.handleUrlImportRemaster());
      confirmBtn.parentNode.insertBefore(remasterBtn, confirmBtn.nextSibling);
    }
  },

  closeUrlImportModal() {
    const modal = document.getElementById("url-import-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  },

  /* ── Fetch ─────────────────────────────────────────────────────────────── */

  async handleUrlImportFetch() {
    const input = document.getElementById("url-import-input");
    const statusEl = document.getElementById("url-import-status");
    const previewEl = document.getElementById("url-import-preview");
    const fetchBtn = document.getElementById("url-import-fetch-btn");

    const url = input?.value?.trim();
    const token = document.getElementById("url-import-token-input")?.value?.trim();
    if (!url) {
      statusEl.innerHTML = '<span style="color:var(--error);">Please enter a URL.</span>';
      return;
    }

    // Validate URL
    try { new URL(url); } catch {
      statusEl.innerHTML = '<span style="color:var(--error);">Invalid URL format.</span>';
      return;
    }

    if (fetchBtn) { fetchBtn.disabled = true; fetchBtn.textContent = "Fetching…"; }
    statusEl.innerHTML = '<span style="color:var(--text-secondary);">Fetching character data…</span>';
    previewEl.style.display = "none";
    this._urlImportData = null;

    try {
      const res = await (window.authFetch || fetch)("/api/import/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, token }),
      });

      const data = await res.json();

      if (!data.success) {
        statusEl.innerHTML = `<span style="color:var(--error);">❌ ${escapeHtml(data.error)}</span>`;
        return;
      }

      const char = data.character;
      this._urlImportData = char;

      // Show preview
      document.getElementById("url-import-preview-name").textContent = char.name || "Unnamed Character";
      document.getElementById("url-import-preview-desc").textContent =
        (char.description || char.personality || char.firstMessage || "No description available.").slice(0, 500);

      previewEl.style.display = "block";
      statusEl.innerHTML = `<span style="color:var(--success);">✅ Character found: <strong>${escapeHtml(char.name || "Unnamed")}</strong></span>`;
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--error);">❌ Network error: ${escapeHtml(err.message)}</span>`;
    } finally {
      if (fetchBtn) { fetchBtn.disabled = false; fetchBtn.textContent = "Fetch Character"; }
    }
  },

  /* ── Confirm Import ────────────────────────────────────────────────────── */

  async handleUrlImportConfirm() {
    const char = this._urlImportData;
    if (!char) return;

    this.closeUrlImportModal();

    try {
      // Build a character object compatible with the existing import pipeline
      const imported = {
        name: char.name || "Imported Character",
        description: char.description || "",
        personality: char.personality || "",
        scenario: char.scenario || "",
        firstMessage: char.firstMessage || "",
        mesExample: char.mesExample || "",
        creatorNotes: char.creatorNotes || "",
        tags: char.tags || [],
        alternateGreetings: char.alternateGreetings || [],
        systemPrompt: char.systemPrompt || "",
        postHistoryInstructions: char.postHistoryInstructions || "",
        character_book: char.characterBook || null,
        creator: char.creator || "",
        characterVersion: char.characterVersion || "",
      };

      // Set as current character
      this.currentCharacter = imported;
      this.originalCharacter = JSON.parse(JSON.stringify(imported));
      this.lorebookEntries = [];
      this.altGreetings = imported.alternateGreetings || [];
      this.updateAltGreetingsCount();
      this.currentImageUrl = null;

      // If character_book exists, parse it into lorebook entries
      if (imported.character_book) {
        this.lorebookData = imported.character_book;
        const entries = [];
        if (Array.isArray(imported.character_book.entries)) {
          for (const e of imported.character_book.entries) {
            entries.push({
              id: e.id || Date.now() + Math.random(),
              keys: Array.isArray(e.keys) ? e.keys : (e.key ? [e.key] : []),
              content: e.content || "",
              comment: e.comment || (Array.isArray(e.keys) ? e.keys.join(", ") : ""),
              disable: false,
            });
          }
        }
        this.lorebookEntries = entries;
      }
      this.updateLorebookEntryCount();

      // Display
      this.displayCharacter();
      this.hideResultSection();
      this.showResultSection();

      // Clear image area
      const imageContent = document.getElementById("image-content");
      if (imageContent) {
        imageContent.innerHTML = `
          <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
            <div style="font-size:2rem;margin-bottom:1rem;">🌐</div>
            <p style="font-weight:500;margin-bottom:0.5rem;">Character Imported from URL</p>
            <p style="font-size:0.875rem;">Generate or upload an image to complete the card</p>
          </div>`;
      }

      // Show image controls
      const imageControls = document.getElementById("image-controls");
      if (imageControls) imageControls.style.display = "block";
      const buttonsRow = document.getElementById("image-buttons-row");
      if (buttonsRow) buttonsRow.style.display = "";

      // Save to library
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();

      this.showNotification(`Imported "${imported.name}" successfully!`, "success");
    } catch (err) {
      console.error("URL import error:", err);
      this.showNotification(`Import failed: ${err.message}`, "error");
    }
  },

  handleUrlImportCancel() {
    this._urlImportData = null;
    this.closeUrlImportModal();
  },

  async handleUrlImportRemaster() {
    await this.handleUrlImportConfirm();
    if (this.currentCharacter) {
      this.showNotification("Card imported, starting AI remaster...", "info");
      await this.handleAutoRemaster();
    }
  },

});

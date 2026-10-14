// Lorebook Manager Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  openSupportingCastModal() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate or import a character first.", "warning");
      return;
    }
    const modal = document.getElementById("supporting-cast-modal");
    if (modal) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
      this.renderInitialSupportingCastRows();
    }
  },

  closeSupportingCastModal() {
    const modal = document.getElementById("supporting-cast-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  },

  renderInitialSupportingCastRows() {
    const list = document.getElementById("supporting-cast-list");
    if (!list) return;
    list.innerHTML = "";
    // Start with one empty row by default
    this.addSupportingCastRow();
  },

  addSupportingCastRow(description = "", name = "") {
    const list = document.getElementById("supporting-cast-list");
    if (!list) return;
    
    const row = document.createElement("div");
    row.className = "supporting-cast-row";
    row.style.cssText = "display: flex; gap: 0.5rem; align-items: flex-start;";
    
    row.innerHTML = `
      <div style="flex: 2;">
        <input type="text" class="input cast-desc-input" placeholder="e.g. Female Waitress" value="${escapeHtml(description)}" style="width: 100%;" />
      </div>
      <div style="flex: 1;">
        <input type="text" class="input cast-name-input" placeholder="Name (Optional)" value="${escapeHtml(name)}" style="width: 100%;" />
      </div>
      <button type="button" class="btn-outline remove-cast-row-btn" style="padding: 0.5rem; color: var(--error-color); border-color: var(--error-color);">✕</button>
    `;
    
    row.querySelector(".remove-cast-row-btn").addEventListener("click", () => {
      row.remove();
    });
    
    list.appendChild(row);
  },

  async handleGenerateSupportingCast() {
    const list = document.getElementById("supporting-cast-list");
    if (!list) return;
    
    const rows = Array.from(list.querySelectorAll(".supporting-cast-row"));
    const castToGenerate = [];
    
    rows.forEach(row => {
      const desc = row.querySelector(".cast-desc-input").value.trim();
      const name = row.querySelector(".cast-name-input").value.trim();
      if (desc) {
        castToGenerate.push({ description: desc, name: name });
      }
    });
    
    if (castToGenerate.length === 0) {
      this.showNotification("Please enter at least one description.", "warning");
      return;
    }
    
    const generateBtn = document.getElementById("generate-cast-btn");
    const btnText = generateBtn.querySelector(".btn-text");
    const btnLoading = generateBtn.querySelector(".btn-loading");
    
    generateBtn.disabled = true;
    btnText.style.display = "none";
    btnLoading.style.display = "inline";
    
    let generatedCount = 0;
    let alreadyGeneratedNames = [];
    const newEntries = [];
    
    try {
      for (const castMember of castToGenerate) {
        btnLoading.textContent = `Generating ${generatedCount + 1} of ${castToGenerate.length}...`;
        
        try {
          const result = await this.apiHandler.generateSupportingCastMember(
            this.currentCharacter,
            castMember.description,
            castMember.name,
            alreadyGeneratedNames
          );
          
          if (result.name) {
            alreadyGeneratedNames.push(result.name);
          }
          
          const entry = this._castLorebookEntry(result);
          this.lorebookEntries.push(entry);
          newEntries.push(entry);
          generatedCount++;
        } catch (err) {
          console.error(`Failed to generate cast member: ${castMember.description}`, err);
          this.showNotification(`Skipped one cast member due to error.`, "warning");
        }
      }
      
      this.updateLorebookEntryCount();
      this.showNotification(`Successfully generated ${generatedCount} supporting cast members.`, "success");
      this.closeSupportingCastModal();
      if (newEntries.length === 0) return;
      
      // Name them in the card so the AI knows they exist. If that edit is
      // rejected or fails, the new entries are still kept and saved.
      this.showNotification("Adding the new cast members to the card...", "info");
      const approved = await this._executeInjectLorebookKeys(false, { entries: newEntries, mode: "cast" });
      if (!approved) await this.saveCardToLibrary();
      
    } catch (error) {
      console.error("Error generating supporting cast:", error);
      this.showNotification("Failed to generate all supporting cast members. " + error.message, "error");
    } finally {
      generateBtn.disabled = false;
      btnText.style.display = "inline";
      btnLoading.style.display = "none";
    }
  },

  async handleAutoGenerateSupportingCast() {
    if (!this.currentCharacter) return;

    try {
      const suggestions = await this.apiHandler.suggestSupportingCast(this.currentCharacter);
      if (!suggestions || suggestions.length === 0) {
        console.log("No supporting cast suggestions found.");
        return;
      }

      let alreadyGeneratedNames = [];
      const newEntries = [];
      for (const desc of suggestions) {
        this.showStreamMessage(`Generating cast member: ${desc}...\\n`);
        try {
          const result = await this.apiHandler.generateSupportingCastMember(this.currentCharacter, desc, "", alreadyGeneratedNames);
          
          if (result.name) {
            alreadyGeneratedNames.push(result.name);
          }
          
          const entry = this._castLorebookEntry(result);
          this.lorebookEntries.push(entry);
          newEntries.push(entry);
        } catch (err) {
          console.error(`Failed to generate auto cast member: ${desc}`, err);
          this.showStreamMessage(`⚠️ Skipped cast member due to error: ${desc}\\n`);
        }
      }

      this.updateLorebookEntryCount();
      if (newEntries.length > 0) {
        await this._executeInjectLorebookKeys(true, { entries: newEntries, mode: "cast" });
      }
    } catch (error) {
      console.error("Auto-generate cast error:", error);
      throw error;
    }
  },

  /** A unique id for a new lorebook entry (several can be made in the same millisecond). */
  _newLorebookId() {
    return Date.now().toString() + Math.random().toString(36).slice(2, 8);
  },

  /** Turn a generated supporting-cast member into a lorebook entry keyed on their name and role. */
  _castLorebookEntry(result) {
    const keys = [result.name];
    if (result.role && result.role.toLowerCase() !== String(result.name).toLowerCase()) keys.push(result.role);
    return {
      id: this._newLorebookId(),
      keys,
      content: result.content,
      topic: result.role ? `${result.name} (${result.role})` : result.name,
      enabled: true,
    };
  },

  openLorebookManager() {
    if (!this.currentCharacter) {
      this.showNotification(
        "Please generate or import a character first.",
        "warning",
      );
      return;
    }
    const modal = document.getElementById("lorebook-manager-modal");
    if (modal) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
      this.renderLorebookEntries();
      this.resetLorebookEditor();
    }
  },

  closeLorebookManager() {
    const modal = document.getElementById("lorebook-manager-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  },

  updateLorebookEntryCount() {
    const countEl = document.getElementById("lorebook-entry-count");
    if (countEl) {
      const count = this.lorebookEntries.length;
      countEl.textContent = `${count} ${count === 1 ? "entry" : "entries"}`;
    }
    this.updateTokenCounts();
    this.renderLorebookSummary();
  },

  renderLorebookSummary() {
    const summaryEl = document.getElementById("lorebook-summary");
    if (!summaryEl) return;

    if (this.lorebookEntries.length === 0) {
      summaryEl.innerHTML = "";
      summaryEl.style.display = "none";
      return;
    }

    summaryEl.style.display = "block";
    summaryEl.innerHTML = this.lorebookEntries
      .map(
        (entry) => `
        <div data-action="edit-lorebook-entry" data-id="${entry.id}" style="display: flex; align-items: flex-start; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); gap: 0.5rem; cursor: pointer; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='var(--border)'" onmouseout="this.style.backgroundColor='transparent'">
          <div style="flex: 1; min-width: 0;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-primary);">${escapeHtml(entry.keys.join(", "))}:</span>
            <span style="font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: calc(100% - 5rem); vertical-align: bottom;">&nbsp;${escapeHtml(entry.content.substring(0, 80).replace(/\n/g, " "))}${entry.content.length > 80 ? "\u2026" : ""}</span>
          </div>
        </div>`,
      )
      .join("");
  },

  renderLorebookEntries() {
    const listEl = document.getElementById("lorebook-entries-list");
    if (!listEl) return;

    if (this.lorebookEntries.length === 0) {
      listEl.innerHTML =
        '<p class="library-empty">No lorebook entries yet.</p>';
      return;
    }

    listEl.innerHTML = this.lorebookEntries
      .map(
        (entry) => `
      <div class="library-item" style="align-items: flex-start;">
        <div style="flex: 1;">
          <div class="library-item-title" style="margin-bottom: 0.5rem;">${escapeHtml(entry.keys.join(", "))}</div>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin: 0; white-space: pre-wrap; max-height: 60px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(entry.content)}</p>
        </div>
        <div class="library-item-actions">
          <button class="btn-small" data-action="edit-lorebook-entry" data-id="${entry.id}">Edit</button>
          <button class="btn-small" data-action="delete-lorebook-entry" data-id="${entry.id}">Delete</button>
        </div>
      </div>
    `,
      )
      .join("");
  },

  resetLorebookEditor() {
    document.getElementById("lorebook-editor-title").textContent =
      "Add New Entry";
    document.getElementById("lorebook-entry-id").value = "";
    document.getElementById("lorebook-entry-keys").value = "";
    document.getElementById("lorebook-entry-content").value = "";
    const hintInput = document.getElementById("lorebook-entry-hint");
    if (hintInput) hintInput.value = "";
    document.getElementById("cancel-lorebook-edit-btn").style.display = "none";
    this.updateLorebookGenerateButton();
  },

  /**
   * One AI button: it writes a new entry when the Content box is empty and
   * improves the existing text when it isn't. The label says which it will do.
   */
  updateLorebookGenerateButton() {
    const btn = document.getElementById("generate-lorebook-content-btn");
    const contentTextarea = document.getElementById("lorebook-entry-content");
    if (!btn || !contentTextarea || btn.disabled) return;
    const enhancing = !!contentTextarea.value.trim();
    btn.textContent = enhancing ? "✨ Enhance with AI" : "🔄 Generate with AI";
    btn.title = enhancing
      ? "Improve the text already in the Content box, following the AI Prompt if you've entered one. Its facts are kept unless the prompt says otherwise."
      : "Write a new entry from the Keys, using the character card as context and the AI Prompt if you've entered one.";
  },

  async handleSuggestLorebookTopics() {
    const btn = document.getElementById("suggest-lorebook-topics-btn");
    const suggestionsContainer = document.getElementById(
      "lorebook-topic-suggestions",
    );
    if (!this.currentCharacter || !btn || !suggestionsContainer) return;

    btn.disabled = true;
    btn.textContent = "Suggesting...";
    suggestionsContainer.innerHTML = "";

    try {
      const topics = await this.lorebookGenerator.suggestTopics(
        this.currentCharacter,
        this.lorebookEntries,
      );
      if (topics && topics.length > 0) {
        suggestionsContainer.innerHTML = topics
          .map(
            (topic) =>
              `<button class="btn-small topic-suggestion" style="background: var(--surface-color);">${escapeHtml(topic)}</button>`,
          )
          .join("");
      } else {
        suggestionsContainer.innerHTML =
          '<p style="font-size: 0.875rem; color: var(--text-secondary);">No suggestions found.</p>';
      }
    } catch (error) {
      this.showNotification(
        `Failed to get suggestions: ${error.message}`,
        "error",
      );
      suggestionsContainer.innerHTML = `<p style="font-size: 0.875rem; color: var(--error);">Error fetching suggestions.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Suggest Topics from Card";
    }
  },

  async handleGenerateLorebookContent() {
    const btn = document.getElementById("generate-lorebook-content-btn");
    const keysInput = document.getElementById("lorebook-entry-keys");
    const contentTextarea = document.getElementById("lorebook-entry-content");
    const hintInput = document.getElementById("lorebook-entry-hint");
    const idInput = document.getElementById("lorebook-entry-id");
    if (!this.currentCharacter || !btn || !keysInput || !contentTextarea) return;

    const keys = keysInput.value.trim();
    const instruction = hintInput ? hintInput.value.trim() : "";
    const existingContent = contentTextarea.value.trim();
    const enhancing = !!existingContent;
    if (!keys) {
      this.showNotification(
        "Please provide at least one key for the entry.",
        "warning",
      );
      return;
    }

    // The current text stays in the box until a result arrives, so a failed
    // or stopped call never costs the user what they had.
    btn.disabled = true;
    btn.textContent = enhancing ? "Enhancing..." : "Generating...";
    contentTextarea.readOnly = true;

    try {
      const content = await this.lorebookGenerator.writeEntryContent(
        this.currentCharacter,
        keys,
        {
          existingContent,
          instruction,
          otherEntries: this.lorebookEntries,
          excludeId: idInput?.value || null,
        },
      );
      if (!content) throw new Error("The AI returned an empty entry.");
      contentTextarea.value = content;
      // Cleared so a second click doesn't apply the same prompt twice.
      if (hintInput) hintInput.value = "";
      this.showNotification(
        enhancing ? "Entry enhanced — review it, then Save Entry." : "Entry generated — review it, then Save Entry.",
        "success",
      );
    } catch (error) {
      const wasStoppedByUser = error.message?.includes("Generation stopped by user");
      if (!wasStoppedByUser) {
        this.showNotification(
          `Failed to ${enhancing ? "enhance" : "generate"} content: ${error.message}`,
          "error",
        );
      }
    } finally {
      contentTextarea.readOnly = false;
      btn.disabled = false;
      this.updateLorebookGenerateButton();
    }
  },

  handleSaveLorebookEntry() {
    const id = document.getElementById("lorebook-entry-id").value;
    const keys = document.getElementById("lorebook-entry-keys").value.trim();
    const content = document
      .getElementById("lorebook-entry-content")
      .value.trim();

    if (!keys || !content) {
      this.showNotification("Keys and content cannot be empty.", "warning");
      return;
    }

    const keysArray = [...new Set(
      keys
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    )];

    if (id) {
      const index = this.lorebookEntries.findIndex((e) => e.id == id);
      if (index > -1) {
        this.lorebookEntries[index] = {
          ...this.lorebookEntries[index],
          keys: keysArray,
          content,
        };
      }
    } else {
      this.lorebookEntries.push({
        id: this._newLorebookId(),
        keys: keysArray,
        content,
        enabled: true,
      });
    }

    this.renderLorebookEntries();
    this.updateLorebookEntryCount();
    this.resetLorebookEditor();
    this.currentCharacter.character_book = this.buildCharacterBook();
    this.saveCardToLibrary();
    this.showNotification("Lorebook entry saved successfully!", "success");
  },

  handleEditLorebookEntry(id) {
    const entry = this.lorebookEntries.find((e) => e.id == id);
    if (!entry) return;

    document.getElementById("lorebook-editor-title").textContent = "Edit Entry";
    document.getElementById("lorebook-entry-id").value = entry.id;
    document.getElementById("lorebook-entry-keys").value = entry.keys.join(", ");
    document.getElementById("lorebook-entry-content").value = entry.content;
    const hintInput = document.getElementById("lorebook-entry-hint");
    if (hintInput) hintInput.value = "";
    document.getElementById("cancel-lorebook-edit-btn").style.display =
      "inline-block";
    this.updateLorebookGenerateButton();
    document
      .getElementById("lorebook-entry-editor")
      .scrollIntoView({ behavior: "smooth" });
  },

  handleDeleteLorebookEntry(id) {
    if (confirm("Are you sure you want to delete this lorebook entry?")) {
      this.lorebookEntries = this.lorebookEntries.filter((e) => e.id != id);
      this.renderLorebookEntries();
      this.updateLorebookEntryCount();
      this.resetLorebookEditor();
      this.saveCardToLibrary();
      this.showNotification("Lorebook entry deleted.", "info");
    }
  },

  buildCharacterBook() {
    if (!this.lorebookEntries || this.lorebookEntries.length === 0)
      return undefined;

    return {
      name: `${this.currentCharacter?.name || "Character"} Lorebook`,
      description: "Generated by SillyTavern Character Generator",
      scan_depth: 50,
      token_budget: 500,
      recursive_scanning: false,
      extensions: {},
      // `enabled` must be a real boolean: SillyTavern imports an entry with
      // `disable: !entry.enabled`, so a missing flag arrives switched off.
      // Ids are sequential because SillyTavern keys entries by id, and the
      // old parseInt of a timestamp-based id could give two entries the same one.
      entries: this.lorebookEntries.map((entry, index) => ({
        keys: entry.keys,
        content: entry.content,
        extensions: {},
        enabled: entry.enabled !== false,
        insertion_order: 50,
        case_sensitive: false,
        use_regex: false,
        name: entry.topic || entry.keys[0] || "",
        priority: 10,
        id: index + 1,
        comment: entry.topic || "",
        selective: false,
        secondary_keys: [],
        constant: false,
        position: "before_char",
      })),
    };
  },

  handleInjectLorebookKeys() {
    if (!this.currentCharacter) return;
    if (this.lorebookEntries.length === 0) {
      this.showNotification(
        "Please add at least one Lorebook entry first.",
        "warning",
      );
      return;
    }

    const missing = this.apiHandler.findUncoveredLorebookEntries(this.currentCharacter, this.lorebookEntries);
    if (missing.length === 0) {
      this.showNotification("Every entry already has a trigger keyword in the card — nothing to inject.", "info");
      return;
    }

    const names = missing.map((e) => e.keys[0]).join(", ");
    if (
      confirm(
        `${missing.length} ${missing.length === 1 ? "entry has" : "entries have"} no trigger keyword in the card yet: ${names}\n\nThe AI will work them into the Scenario, and into the First Message where they fit. Nothing else changes, and you'll review the edit before it's applied. Proceed?`,
      )
    ) {
      this.closeLorebookManager();
      this._executeInjectLorebookKeys(false, { entries: missing });
    }
  },

  /** Short description of each entry for the card-edit prompts: primary key, other keys, opening of the text. */
  _describeEntriesForCardEdit(entries) {
    return entries.map((e) => {
      const [primary, ...others] = e.keys.filter(Boolean);
      const text = String(e.content || "").replace(/\s+/g, " ").trim();
      const gist = text.length > 140 ? text.slice(0, 140) + "…" : text;
      return `- "${primary}"${others.length ? ` (also: ${others.join(", ")})` : ""} — ${gist}`;
    }).join("\n");
  },

  _keyWeaveInstruction(entries) {
    return (
      `These lorebook entries have no trigger keyword in the card yet. A keyword only loads its entry when it comes up in the chat, so the card needs to mention each one — that is how the AI knows the topic exists and brings it up.\n\n` +
      `For each entry below:\n` +
      `- Work its first keyword into the Scenario, exactly as written, in one natural phrase.\n` +
      `- Also mention it in the First Message if it fits naturally there (a mention in the opening message loads the entry straight away). Don't force it.\n` +
      `- Weave keywords in organically — never as a list or a block of names.\n` +
      `- Add the minimum text needed and keep all existing text. Don't add the entries' details: the lorebook supplies them.\n\n` +
      `Entries:\n${this._describeEntriesForCardEdit(entries)}`
    );
  },

  _castInstruction(entries) {
    return (
      `These supporting characters have just been added to the lorebook, which now holds their full details:\n${this._describeEntriesForCardEdit(entries)}\n\n` +
      `Update the card:\n` +
      `- If the Description or Scenario describes any of them in depth (appearance, backstory), cut that to a brief passing mention by name.\n` +
      `- Where the card refers to one of them vaguely (e.g. "the bartender"), use their name instead.\n` +
      `- Make sure each name appears at least once in the Scenario, woven in naturally. Mention them in the First Message only where it fits.\n` +
      `- Never copy their lorebook details into the card. Leave all other text as it is.`
    );
  },

  /**
   * After a card edit, check that every entry in `entries` still has a trigger
   * key somewhere in the card. Anything missing gets one targeted retry on the
   * Scenario; whatever is still missing after that is returned for a warning.
   */
  async _ensureKeyCoverage(card, entries, pov) {
    let missing = this.apiHandler.findUncoveredLorebookEntries(card, entries);
    if (missing.length === 0) return { card, missing };

    console.log("Lorebook keys missing after card edit, retrying:", missing.map((e) => e.keys[0]));
    try {
      card = await this.apiHandler.editCardForLorebook(card, this._keyWeaveInstruction(missing), ["scenario"], pov);
    } catch (error) {
      if (error.message?.includes("Generation stopped by user")) throw error;
      console.warn("Keyword retry failed:", error);
    }
    missing = this.apiHandler.findUncoveredLorebookEntries(card, entries);
    return { card, missing };
  },

  _warnUncoveredEntries(missing) {
    if (!missing || missing.length === 0) return;
    const names = missing.map((e) => e.keys[0]).join(", ");
    this.showNotification(
      `No trigger keyword in the card for: ${names}. ${missing.length === 1 ? "It" : "These"} will only load if someone happens to say a keyword — try ✨ Inject Keys in the Lorebook Manager.`,
      "warning",
    );
  },

  /**
   * Edit the card so it mentions the given entries' keywords.
   * mode "keys": weave keywords into the Scenario (and First Message where natural).
   * mode "cast": also trim in-depth descriptions of new supporting characters.
   * Returns true if the edit was applied.
   */
  async _executeInjectLorebookKeys(silent = false, { entries = null, mode = "keys" } = {}) {
    const targets = (entries || this.lorebookEntries).filter(
      (e) => e.enabled !== false && Array.isArray(e.keys) && e.keys.some(Boolean),
    );
    if (targets.length === 0) return false;

    const pov = document.getElementById("pov-select")?.value || "third";
    const before = this._captureCardSnapshot();
    const isCast = mode === "cast";

    if (!silent) this.showNotification("Adding lorebook keywords to the card…", "info");

    try {
      this.currentCharacter.character_book = this.buildCharacterBook();
      let revised = await this.apiHandler.editCardForLorebook(
        this.currentCharacter,
        isCast ? this._castInstruction(targets) : this._keyWeaveInstruction(targets),
        isCast ? ["description", "scenario", "firstMessage"] : ["scenario", "firstMessage"],
        pov,
      );
      const coverage = await this._ensureKeyCoverage(revised, targets, pov);
      revised = coverage.card;

      if (silent) {
        this.currentCharacter = revised;
        this.originalCharacter = JSON.parse(JSON.stringify(revised));
        if (coverage.missing.length && typeof this.showStreamMessage === "function") {
          this.showStreamMessage(`⚠️ No trigger keyword in the card for: ${coverage.missing.map((e) => e.keys[0]).join(", ")}\n`);
        }
        return true;
      }

      const approved = await this.promptCardDiffApproval(before, revised);

      if (approved) {
        this.currentCharacter = revised;
        this.originalCharacter = JSON.parse(JSON.stringify(revised));
        this.displayCharacter();
        await this.saveCardToLibrary();
        if (coverage.missing.length) this._warnUncoveredEntries(coverage.missing);
        else this.showNotification("Lorebook keywords added to the card!", "success");
        return true;
      }
      this.showNotification("Card edit discarded.", "info");
      return false;
    } catch (error) {
      console.error("Inject lorebook keys failed:", error);
      const wasStoppedByUser = error.message?.includes("Generation stopped by user");
      if (silent) {
        // The entries themselves were made fine, so this isn't a cast failure.
        if (wasStoppedByUser) throw error;
        if (typeof this.showStreamMessage === "function") {
          this.showStreamMessage(`⚠️ Couldn't add the new entries to the card: ${error.message}\n`);
        }
        return false;
      }
      if (!wasStoppedByUser) {
        this.showNotification(`Failed to add keywords to the card: ${error.message}`, "error");
      }
      return false;
    }
  },

  handleDownloadLorebook() {
    if (this.lorebookEntries.length === 0) {
      this.showNotification("There are no entries to download.", "warning");
      return;
    }

    const lorebookData = {
      name: `${this.currentCharacter?.name || "Character"} Lorebook`,
      description: `A collection of lore entries for the character "${this.currentCharacter?.name || "Unknown"}". Generated by SillyTavern Character Generator.`,
      scan_depth: 100,
      token_budget: 2048,
      recursive_scanning: false,
      extensions: {},
      entries: this.lorebookEntries.map((entry, index) => ({
        keys: entry.keys,
        comment: entry.topic || `Entry for ${entry.keys[0]}`,
        content: entry.content,
        insertion_order: (index + 1) * 10,
        enabled: entry.enabled !== false,
        case_sensitive: false,
        priority: 100,
        id: index + 1,
        constant: false,
        selective: false,
        secondary_keys: [],
      })),
    };

    const jsonString = JSON.stringify(lorebookData, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const filename = `${(this.currentCharacter?.name || "character").replace(/[^a-zA-Z0-9]/g, "_")}_lorebook.json`;
    this.downloadBlob(blob, filename);
    this.showNotification("Lorebook downloaded!", "success");
  },

  handleLorebookUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        this.lorebookData = json;

        const statusIcon = document.getElementById("lorebook-status");
        statusIcon.style.display = "block";
        this.showNotification("Lorebook loaded successfully!", "success");
        console.log("Lorebook loaded:", this.lorebookData);
      } catch (error) {
        console.error("Error parsing lorebook:", error);
        this.showNotification("Failed to parse Lorebook JSON", "error");
        this.lorebookData = null;
        document.getElementById("lorebook-status").style.display = "none";
      }
    };
    reader.readAsText(file);
  },

  // ─── Lore Elevation ───────────────────────────────────────────────────────

  /**
   * Show the lore-elevation modal with the given candidates and return a Promise
   * that resolves with the array of user-selected candidates, or null if cancelled.
   */
  showLoreElevationModal(candidates) {
    return new Promise((resolve) => {
      const modal = document.getElementById("lore-elevation-modal");
      const list = document.getElementById("lore-elevation-candidates-list");
      const confirmBtn = document.getElementById("lore-elevation-confirm-btn");
      const cancelBtn = document.getElementById("lore-elevation-cancel-btn");
      const closeBtn = document.getElementById("lore-elevation-modal-close-btn");
      const selectAllBtn = document.getElementById("lore-elevation-select-all-btn");
      if (!modal || !list) return resolve(null);

      // Render candidate checkboxes
      // Pre-check conflicts: find existing entries whose keys overlap with each candidate
      const existingKeys = this.lorebookEntries.flatMap(e => e.keys.map(k => k.toLowerCase()));

      list.innerHTML = candidates.map((c, i) => {
        const conflictingKeys = c.keys.filter(k => existingKeys.includes(k.toLowerCase()));
        const hasConflict = conflictingKeys.length > 0;
        const conflictingEntry = hasConflict
          ? this.lorebookEntries.find(e => e.keys.some(k => conflictingKeys.map(x => x.toLowerCase()).includes(k.toLowerCase())))
          : null;
        const conflictBadge = hasConflict
          ? `<div style="font-size: 0.75rem; color: var(--warning, #f59e0b); margin-top: 0.3rem; padding: 0.2rem 0.4rem; background: rgba(245,158,11,0.1); border-radius: 0.25rem; border: 1px solid rgba(245,158,11,0.3);">
               ⚠️ Existing entry already covers: <strong>${escapeHtml(conflictingEntry ? conflictingEntry.keys.join(", ") : conflictingKeys.join(", "))}</strong> — unchecked by default, tick to add anyway
             </div>`
          : "";
        return `
        <label style="display: flex; gap: 0.75rem; align-items: flex-start; cursor: pointer; padding: 0.75rem; background: var(--surface-color); border-radius: 0.375rem; border: 1px solid ${hasConflict ? "rgba(245,158,11,0.4)" : "var(--border)"};">
          <input type="checkbox" data-index="${i}" ${hasConflict ? "" : "checked"} style="margin-top: 0.2rem; flex-shrink: 0;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; margin-bottom: 0.25rem;">${escapeHtml(c.topic)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 0.4rem;">Keys: ${escapeHtml(c.keys.join(", "))}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); white-space: pre-wrap; max-height: 80px; overflow: hidden;">${escapeHtml(c.content.substring(0, 200))}${c.content.length > 200 ? "\u2026" : ""}</div>
            ${conflictBadge}
          </div>
        </label>
      `;
      }).join("");

      let resolved = false;
      const done = (result) => {
        if (resolved) return;
        resolved = true;
        this.closeLoreElevationModal();
        resolve(result);
      };

      // Select all toggle
      const handleSelectAll = () => {
        const checkboxes = list.querySelectorAll("input[type=checkbox]");
        const allChecked = [...checkboxes].every(cb => cb.checked);
        checkboxes.forEach(cb => { cb.checked = !allChecked; });
        selectAllBtn.textContent = allChecked ? "Select All" : "Deselect All";
      };

      const handleConfirm = () => {
        const checkboxes = list.querySelectorAll("input[type=checkbox]");
        const selected = [];
        checkboxes.forEach((cb) => {
          if (cb.checked) selected.push(candidates[parseInt(cb.dataset.index)]);
        });
        done(selected);
      };

      const handleCancel = () => done(null);

      // Clone buttons to remove old listeners
      const newConfirm = confirmBtn.cloneNode(true);
      const newCancel = cancelBtn.cloneNode(true);
      const newClose = closeBtn.cloneNode(true);
      const newSelectAll = selectAllBtn.cloneNode(true);
      confirmBtn.replaceWith(newConfirm);
      cancelBtn.replaceWith(newCancel);
      closeBtn.replaceWith(newClose);
      selectAllBtn.replaceWith(newSelectAll);

      newConfirm.addEventListener("click", handleConfirm);
      newCancel.addEventListener("click", handleCancel);
      newClose.addEventListener("click", handleCancel);
      newSelectAll.addEventListener("click", handleSelectAll);

      modal.classList.add("show");
      document.body.style.overflow = "hidden";
    });
  },

  closeLoreElevationModal() {
    const modal = document.getElementById("lore-elevation-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  },

  /** The moved-topics section of the card-edit prompt: what to cut, and what the lorebook now holds. */
  _elevationTopicsText(candidates) {
    return candidates.map((c) => {
      const source = c.source ? `Text in the card that covers it (copied from the card; it may be in any field):\n"${c.source}"\n` : "";
      return `### ${c.topic} (keywords: ${c.keys.join(", ")})\n${source}What the lorebook entry now holds:\n${c.content}`;
    }).join("\n\n");
  },

  /**
   * Core elevation logic shared between standalone scan and Reduce Bloat.
   * Creates lorebook entries for selectedCandidates, then edits the card to
   * cut those topics down to a passing reference (and, for Reduce Bloat,
   * rewrites the whole card to be concise).
   *
   * The new entries are rolled back if the edit is rejected, fails or is stopped.
   *
   * @param {Array} selectedCandidates - candidates the user confirmed
   * @param {boolean} alsoReduceBloat  - whether to also strip bloat from the card
   */
  async executeLoreElevation(selectedCandidates, alsoReduceBloat = false) {
    if (selectedCandidates.length === 0 && !alsoReduceBloat) return true; // Nothing to do

    const pov = document.getElementById("pov-select")?.value || "third";
    const before = this._captureCardSnapshot();
    const oldLorebookEntries = JSON.parse(JSON.stringify(this.lorebookEntries));
    const restoreLorebook = () => {
      this.lorebookEntries = oldLorebookEntries;
      this.renderLorebookEntries();
      this.updateLorebookEntryCount();
      this.currentCharacter.character_book = this.buildCharacterBook();
    };

    // Entries whose keywords the card already mentions — the edit must not
    // lose those mentions (a full bloat rewrite easily can).
    const alreadyCovered = this.lorebookEntries.filter(
      (e) => e.enabled !== false && !this.apiHandler.findUncoveredLorebookEntries(this.currentCharacter, [e]).length,
    );

    // 1. Create lorebook entries for the selected candidates. The scan has
    //    already written them to lorebook standard, so they go in as-is.
    const newEntries = selectedCandidates.map((c) => ({
      id: this._newLorebookId(),
      keys: c.keys,
      content: c.content,
      topic: c.topic,
      enabled: true,
    }));
    if (newEntries.length > 0) {
      this.lorebookEntries.push(...newEntries);
      this.renderLorebookEntries();
      this.updateLorebookEntryCount();
      this.currentCharacter.character_book = this.buildCharacterBook();
    }

    try {
      // 2. Edit the card
      this.syncAltGreetingsToCharacter();
      this.showNotification("Applying changes to card...", "info");

      const topicsText = this._elevationTopicsText(selectedCandidates);
      const keepKeys = alreadyCovered.map((e) => e.keys[0]).filter(Boolean);
      let revised;

      if (alsoReduceBloat) {
        let instruction = "";
        if (selectedCandidates.length > 0) {
          instruction += `These topics have just been moved out of the card into lorebook entries:\n\n${topicsText}\n\n` +
            `Cut each topic's detailed description from the card down to at most one short reference sentence that names it by its first keyword. Keep anything about how {{char}} personally feels about or relates to it — that is character guidance. Make sure the Scenario mentions each topic's first keyword.\n\n`;
        }
        if (keepKeys.length > 0) {
          instruction += `The card currently mentions these lorebook keywords — keep at least one mention of each, exactly as written: ${keepKeys.join(", ")}.\n\n`;
        }
        instruction += "Additionally, rewrite the entire card to be extremely concise and token-efficient. Remove all flowery prose, purple language, and repetition. Every sentence must serve a direct behavioural or descriptive purpose. Bullet points for traits and behaviours; short factual prose only for backstory and scenario. Keep only the absolute core facts that an AI needs to portray this character — make every word count.";
        revised = await this.apiHandler.reviseCharacter(this.currentCharacter, instruction, pov);
      } else {
        const instruction =
          `These topics have just been moved out of the card into lorebook entries:\n\n${topicsText}\n\n` +
          `For each topic:\n` +
          `- Find where the card describes it in detail (the quoted text is a guide) and cut that down to at most one short reference sentence that names it by its first keyword.\n` +
          `- Keep anything about how {{char}} personally feels about or relates to it — that is character guidance and belongs in the card.\n` +
          `- Make sure the Scenario mentions each topic's first keyword at least once, woven in naturally.\n` +
          `- Do not touch any other text.`;
        revised = await this.apiHandler.editCardForLorebook(
          this.currentCharacter, instruction, ["description", "personality", "scenario", "firstMessage"], pov,
        );
      }

      // 3. Check every new or previously-mentioned entry still has a keyword in the card
      const coverage = await this._ensureKeyCoverage(revised, [...newEntries, ...alreadyCovered], pov);
      revised = coverage.card;

      const approved = await this.promptCardDiffApproval(before, revised);

      if (approved) {
        this.currentCharacter = revised;
        this.originalCharacter = JSON.parse(JSON.stringify(revised));
        this.displayCharacter();
        await this.saveCardToLibrary();
        await this.refreshLibraryViews();
        this._warnUncoveredEntries(coverage.missing);
        return true;
      }
      restoreLorebook();
      return false;
    } catch (error) {
      // Without this the new entries stayed while the card still held the
      // same lore, duplicating it.
      restoreLorebook();
      throw error;
    }
  },

  /**
   * Standalone "Scan for Lorebook Content" handler.
   * Scans the card, shows the modal, elevates selected items (no bloat pass).
   */
  async handleScanForLorebook() {
    if (!this.currentCharacter) {
      this.showNotification("Generate or import a character first.", "warning");
      return;
    }

    const btn = document.getElementById("scan-for-lorebook-btn");
    const btnText = btn?.querySelector(".btn-text");
    const btnLoading = btn?.querySelector(".btn-loading");
    if (btn) btn.disabled = true;
    if (btnText) btnText.style.display = "none";
    if (btnLoading) btnLoading.style.display = "inline";

    try {
      this.showNotification("Scanning card for lorebook candidates...", "info");
      const candidates = await this.apiHandler.scanCardForLorebookCandidates(this.currentCharacter, this.lorebookEntries);

      if (!candidates || candidates.length === 0) {
        this.showNotification("No lorebook candidates found in the card.", "info");
        return;
      }

      const selected = await this.showLoreElevationModal(candidates);

      if (selected === null) {
        // User cancelled
        return;
      }

      if (selected.length === 0) {
        this.showNotification("No items selected — no changes made.", "info");
        return;
      }

      this.setRevisionState(true, "scan-for-lorebook-btn");
      const approved = await this.executeLoreElevation(selected, false);
      if (approved) {
        this.showNotification(`${selected.length} item(s) moved to lorebook and card updated!`, "success");
      } else {
        this.showNotification("Scan changes discarded.", "info");
      }
    } catch (error) {
      console.error("Scan for lorebook failed:", error);
      const wasStoppedByUser = error.message?.includes("Generation stopped by user");
      if (!wasStoppedByUser) {
        this.showNotification(`Scan failed: ${error.message}`, "error");
      }
    } finally {
      this.setRevisionState(false);
      if (btn) btn.disabled = false;
      if (btnText) btnText.style.display = "inline";
      if (btnLoading) btnLoading.style.display = "none";
    }
  },

});

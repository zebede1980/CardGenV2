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
        <input type="text" class="input cast-desc-input" placeholder="e.g. Female Waitress" value="${this.escapeHtml(description)}" style="width: 100%;" />
      </div>
      <div style="flex: 1;">
        <input type="text" class="input cast-name-input" placeholder="Name (Optional)" value="${this.escapeHtml(name)}" style="width: 100%;" />
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
    
    try {
      for (const castMember of castToGenerate) {
        btnLoading.textContent = `Generating ${generatedCount + 1} of ${castToGenerate.length}...`;
        
        const result = await this.apiHandler.generateSupportingCastMember(
          this.currentCharacter,
          castMember.description,
          castMember.name
        );
        
        // Use name and role as trigger keys, as requested by user
        const triggerKeys = [result.name];
        if (result.role) {
            triggerKeys.push(result.role);
        }
        
        // Create the lorebook entry
        const entry = {
          id: Date.now() + Math.random(),
          keys: triggerKeys,
          content: result.content,
          topic: result.name + " (" + result.role + ")"
        };
        
        this.lorebookEntries.push(entry);
        generatedCount++;
      }
      
      this.updateLorebookEntryCount();
      this.showNotification(`Successfully generated ${generatedCount} supporting cast members.`, "success");
      this.closeSupportingCastModal();
      
      // Attempt to inject them into the main card
      this.showNotification("Injecting new cast members into the scenario...", "info");
      await this._executeInjectLorebookKeys();
      
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

      let generatedCount = 0;
      for (const desc of suggestions) {
        this.showStreamMessage(`Generating cast member: ${desc}...\\n`);
        const result = await this.apiHandler.generateSupportingCastMember(this.currentCharacter, desc, "");
        
        const triggerKeys = [result.name];
        if (result.role) {
            triggerKeys.push(result.role);
        }
        
        const entry = {
          id: Date.now() + Math.random(),
          keys: triggerKeys,
          content: result.content,
          topic: result.name + " (" + result.role + ")"
        };
        
        this.lorebookEntries.push(entry);
        generatedCount++;
      }

      this.updateLorebookEntryCount();
      if (generatedCount > 0) {
        await this._executeInjectLorebookKeys();
      }
    } catch (error) {
      console.error("Auto-generate cast error:", error);
      throw error;
    }
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
        <div style="display: flex; align-items: flex-start; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); gap: 0.5rem;">
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
    if (!this.currentCharacter || !btn || !keysInput || !contentTextarea) return;

    const keys = keysInput.value.trim();
    const hint = hintInput ? hintInput.value.trim() : "";
    if (!keys) {
      this.showNotification(
        "Please provide at least one key for the entry.",
        "warning",
      );
      return;
    }

    btn.disabled = true;
    btn.textContent = "Generating...";
    contentTextarea.value = "Generating content with AI...";

    try {
      const content = await this.lorebookGenerator.generateEntryContent(
        this.currentCharacter,
        keys,
        hint,
      );
      contentTextarea.value = content;
    } catch (error) {
      this.showNotification(
        `Failed to generate content: ${error.message}`,
        "error",
      );
      contentTextarea.value = `Error: ${error.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = "🔄 Generate with AI";
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

    const keysArray = keys
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

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
        id: Date.now().toString(),
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
      entries: this.lorebookEntries.map((entry, index) => ({
        keys: entry.keys,
        content: entry.content,
        extensions: {},
        enabled: entry.enabled,
        insertion_order: 50,
        case_sensitive: false,
        use_regex: false,
        name: entry.keys[0] || "",
        priority: 10,
        id: parseInt(entry.id) || Date.now() + index,
        comment: "",
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

    if (
      confirm(
        "This will update the Scenario and First Message to mention your Lorebook trigger keywords naturally.\n\n⚠️ Warning: Any manual edits you've made to these fields will be overwritten. Proceed?",
      )
    ) {
      this.closeLorebookManager();
      this._executeInjectLorebookKeys();
    }
  },

  async _executeInjectLorebookKeys() {
    const allKeys = [...new Set(this.lorebookEntries.flatMap((e) => e.keys.filter(Boolean)))];
    if (allKeys.length === 0) return;

    const keyList = allKeys.join(", ");
    const instruction =
      `Update ONLY the Scenario and First Message fields so that each of the following lorebook trigger keywords is mentioned at least once naturally within those texts. Keywords: ${keyList}\n\n` +
      `STRICT RULES:\n` +
      `- Weave each keyword into the existing text organically — do NOT list them or dump them in bulk.\n` +
      `- Do NOT copy, summarise, or paraphrase lorebook entry content into the scenario or first message.\n` +
      `- Keep changes minimal — only add what is necessary to ensure the keywords appear.\n` +
      `- All other card fields (description, personality) must remain completely unchanged.`;

    const pov = document.getElementById("pov-select")?.value || "third";
    const before = this._captureCardSnapshot();

    this.showNotification("Injecting lorebook keys into scenario and first message…", "info");

    try {
      const revised = await this.apiHandler.reviseCharacter(
        this.currentCharacter,
        instruction,
        pov,
      );

      const approved = await this.promptCardDiffApproval(before, revised);

      if (approved) {
        this.currentCharacter = revised;
        this.originalCharacter = JSON.parse(JSON.stringify(revised));
        this.displayCharacter();
        await this.saveCardToLibrary();
        this.showNotification("Lorebook keys injected into Scenario and First Message!", "success");
      } else {
        this.showNotification("Lorebook key injection discarded.", "info");
      }
    } catch (error) {
      console.error("Inject lorebook keys failed:", error);
      const wasStoppedByUser = error.message?.includes("Generation stopped by user");
      if (!wasStoppedByUser) {
        this.showNotification(`Failed to inject keys: ${error.message}`, "error");
      }
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
        comment: `Entry for ${entry.keys[0]}`,
        content: entry.content,
        insertion_order: (index + 1) * 10,
        enabled: entry.enabled,
        case_sensitive: false,
        priority: 100,
        id: entry.id,
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

  /**
   * Core elevation logic shared between standalone scan and Reduce Bloat.
   * Creates lorebook entries for selectedCandidates, then calls reviseCharacter
   * with an instruction to remove those topics from the card and/or reduce bloat.
   *
   * @param {Array} selectedCandidates - candidates the user confirmed
   * @param {boolean} alsoReduceBloat  - whether to also strip bloat from the card
   */
  async executeLoreElevation(selectedCandidates, alsoReduceBloat = false) {
    const pov = document.getElementById("pov-select")?.value || "third";
    const before = this._captureCardSnapshot();
    const oldLorebookEntries = JSON.parse(JSON.stringify(this.lorebookEntries));

    // 1. Create lorebook entries for selected candidates — with enrichment pass
    if (selectedCandidates.length > 0) {
      this.showNotification(`Enriching ${selectedCandidates.length} lorebook entr${selectedCandidates.length === 1 ? 'y' : 'ies'}…`, "info");
      for (let i = 0; i < selectedCandidates.length; i++) {
        const candidate = selectedCandidates[i];
        if (selectedCandidates.length > 1) {
          this.showNotification(`Enriching lorebook entries (${i + 1}/${selectedCandidates.length}): ${candidate.topic}…`, "info");
        }
        let enrichedContent = candidate.content;
        try {
          enrichedContent = await this.apiHandler.enrichLorebookEntry(this.currentCharacter, candidate);
        } catch (enrichErr) {
          console.warn(`Enrichment failed for "${candidate.topic}", using scan content:`, enrichErr);
        }
        this.lorebookEntries.push({
          id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
          keys: candidate.keys,
          content: enrichedContent,
          enabled: true,
        });
      }
      this.renderLorebookEntries();
      this.updateLorebookEntryCount();
      this.currentCharacter.character_book = this.buildCharacterBook();
    }

    // 2. Build revision instruction
    let instruction = "";
    if (selectedCandidates.length > 0) {
      const topicList = selectedCandidates.map(c => `"${c.topic}"`).join(", ");
      instruction += `The following topics have been moved to the lorebook: ${topicList}. Remove the detailed descriptions of these topics from the card body — replace each with at most one brief reference sentence so the card stays anchored in reality without carrying the full lore weight.`;

      // Collect ALL lorebook trigger keys (existing + newly elevated) for scenario injection
      const allLorebookKeys = this.lorebookEntries.flatMap(e => e.keys.filter(Boolean));
      const uniqueKeys = [...new Set(allLorebookKeys)];
      if (uniqueKeys.length > 0) {
        instruction += `\n\nLOREBOOK COHESION: Ensure the Scenario field naturally mentions each of the following trigger keywords at least once so the entries activate during roleplay. Weave them into the existing scenario text organically — do NOT list them, and do NOT copy or paraphrase lorebook entry content into the card. Just ensure each keyword appears naturally. Keywords: ${uniqueKeys.join(", ")}.`;
      }
    }
    if (alsoReduceBloat) {
      if (instruction) instruction += "\n\n";
      instruction += "Additionally, rewrite the entire card to be extremely concise and token-efficient. Remove all flowery prose, purple language, and repetition. Every sentence must serve a direct behavioural or descriptive purpose. Bullet points for traits and behaviours; short factual prose only for backstory and scenario. Keep only the absolute core facts that an AI needs to portray this character — make every word count.";
    }

    if (!instruction) return true; // Nothing to do

    this.syncAltGreetingsToCharacter();
    this.showNotification("Applying changes to card...", "info");

    const revised = await this.apiHandler.reviseCharacter(
      this.currentCharacter,
      instruction,
      pov,
    );

    const approved = await this.promptCardDiffApproval(before, revised);

    if (approved) {
      this.currentCharacter = revised;
      this.originalCharacter = JSON.parse(JSON.stringify(revised));
      this.displayCharacter();
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
      return true;
    } else {
      this.lorebookEntries = oldLorebookEntries;
      this.renderLorebookEntries();
      this.updateLorebookEntryCount();
      this.currentCharacter.character_book = this.buildCharacterBook();
      return false;
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
      const candidates = await this.apiHandler.scanCardForLorebookCandidates(this.currentCharacter);

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

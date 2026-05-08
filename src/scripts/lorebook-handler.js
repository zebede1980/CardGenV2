// Lorebook Manager Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

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
          <div class="library-item-title" style="margin-bottom: 0.5rem;">${entry.keys.join(", ")}</div>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin: 0; white-space: pre-wrap; max-height: 60px; overflow: hidden; text-overflow: ellipsis;">${entry.content}</p>
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
              `<button class="btn-small topic-suggestion" style="background: var(--surface-color);">${topic}</button>`,
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
        "This will use AI to rewrite your current Scenario so it naturally includes your Lorebook keys.\n\n⚠️ Warning: Any manual edits you've made to the Scenario will be overwritten. Proceed?",
      )
    ) {
      this.closeLorebookManager();
      this.showNotification("Injecting keys into scenario...", "info");
      this.handleRegenerateField("scenario");
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

});

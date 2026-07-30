// Character Display and Editing Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  handleCharacterStream(token, fullContent) {
    this.appendStreamContent(token);
  },

  estimateTokens(text) {
    if (!text) return 0;
    // Simple estimation: 1 token ~= 4 chars in English
    return Math.ceil(text.length / 4);
  },

  updateTokenCounts() {
    if (!this.currentCharacter) return;

    // ── Core fields: always sent to the LLM every turn ────────────────────────
    const coreFields = [
      ["name",                   "name-token-count"],
      ["description",            "description-token-count"],
      ["personality",            "personality-token-count"],
      ["scenario",               "scenario-token-count"],
      ["firstMessage",           "first-message-token-count"],
      ["mesExample",             "example-messages-token-count"],
      ["postHistoryInstructions","post-history-token-count"],
    ];

    let coreTokens = 0;
    coreFields.forEach(([field, elementId]) => {
      const text = this.currentCharacter[field] || "";
      const tokens = this.estimateTokens(text);
      coreTokens += tokens;
      const el = document.getElementById(elementId);
      if (el) el.textContent = `(~${tokens} tokens)`;
    });

    // ── Creator's Notes: card metadata, never sent to LLM ─────────────────────
    const creatorNotesText = this.currentCharacter.creatorNotes || "";
    const creatorNotesTokens = this.estimateTokens(creatorNotesText);
    const creatorNotesEl = document.getElementById("creator-notes-token-count");
    if (creatorNotesEl) creatorNotesEl.textContent = `(~${creatorNotesTokens} tokens)`;

    // ── Lorebook: keyword-triggered, NOT always sent ───────────────────────────
    let lorebookTokens = 0;
    this.lorebookEntries.forEach((entry) => {
      lorebookTokens += this.estimateTokens(entry.keys.join(", "));
      lorebookTokens += this.estimateTokens(entry.content);
    });
    const lorebookEl = document.getElementById("lorebook-token-count");
    if (lorebookEl) {
      lorebookEl.textContent = lorebookTokens > 0 ? `(~${lorebookTokens} tokens)` : "";
    }

    // ── Alternate Greetings: card metadata, never sent to LLM ─────────────────
    let altGreetingsTokens = 0;
    this.altGreetings.forEach((greeting) => {
      altGreetingsTokens += this.estimateTokens(greeting.content);
    });
    const altGreetingsEl = document.getElementById("alt-greetings-token-count");
    if (altGreetingsEl) {
      altGreetingsEl.textContent = altGreetingsTokens > 0 ? `(~${altGreetingsTokens} tokens)` : "";
    }

    // ── Totals display ────────────────────────────────────────────────────────
    const fullCardTokens = coreTokens + creatorNotesTokens + lorebookTokens + altGreetingsTokens;

    const coreEl = document.getElementById("core-token-count");
    if (coreEl) {
      coreEl.textContent = `Always sent to LLM: ~${coreTokens.toLocaleString()} tokens`;
    }

    const totalEl = document.getElementById("total-token-count");
    if (totalEl) {
      const extras = [];
      if (lorebookTokens > 0) extras.push(`lorebook ~${lorebookTokens.toLocaleString()}`);
      if (creatorNotesTokens > 0) extras.push(`creator notes ~${creatorNotesTokens.toLocaleString()}`);
      if (altGreetingsTokens > 0) extras.push(`alt greetings ~${altGreetingsTokens.toLocaleString()}`);
      if (extras.length > 0) {
        totalEl.textContent = `Full card total: ~${fullCardTokens.toLocaleString()} tokens (incl. ${extras.join(", ")} — conditional/not sent)`;
      } else {
        totalEl.textContent = "";
      }
    }
  },

  displayCharacter() {
    const nameInput = document.getElementById("character-generated-name");
    const descriptionTextarea = document.getElementById("character-description");
    const personalityTextarea = document.getElementById("character-personality");
    const scenarioTextarea = document.getElementById("character-scenario");
    const firstMessageTextarea = document.getElementById("character-first-message");
    const postHistoryTextarea = document.getElementById("character-post-history");

    if (nameInput) nameInput.value = this.currentCharacter.name || "";
    descriptionTextarea.value = this.currentCharacter.description || "";
    personalityTextarea.value = this.currentCharacter.personality || "";
    scenarioTextarea.value = this.currentCharacter.scenario || "";
    firstMessageTextarea.value = this.currentCharacter.firstMessage || "";
    if (postHistoryTextarea) postHistoryTextarea.value = this.currentCharacter.postHistoryInstructions || "";

    const creatorNotesTextarea = document.getElementById("creator-notes");
    if (creatorNotesTextarea) creatorNotesTextarea.value = this.currentCharacter.creatorNotes || "";

    this._renderTags(this.currentCharacter.tags || []);

    const resetNameBtn = document.getElementById("reset-name-btn");
    const resetDescriptionBtn = document.getElementById("reset-description-btn");
    const resetPersonalityBtn = document.getElementById("reset-personality-btn");
    const resetScenarioBtn = document.getElementById("reset-scenario-btn");
    const resetFirstMessageBtn = document.getElementById("reset-first-message-btn");
    const resetPostHistoryBtn = document.getElementById("reset-post-history-btn");
    const resetCreatorNotesBtn = document.getElementById("reset-creator-notes-btn");

    if (resetNameBtn) resetNameBtn.style.display = "none";
    if (resetDescriptionBtn) resetDescriptionBtn.style.display = "none";
    if (resetPersonalityBtn) resetPersonalityBtn.style.display = "none";
    if (resetScenarioBtn) resetScenarioBtn.style.display = "none";
    if (resetFirstMessageBtn) resetFirstMessageBtn.style.display = "none";
    if (resetPostHistoryBtn) resetPostHistoryBtn.style.display = "none";
    if (resetCreatorNotesBtn) resetCreatorNotesBtn.style.display = "none";

    const exampleMessagesOutput = document.getElementById("example-messages-output");
    if (exampleMessagesOutput) {
      if (this.currentCharacter.mesExample) {
        if (
          exampleMessagesOutput.tagName === "TEXTAREA" ||
          exampleMessagesOutput.tagName === "INPUT"
        ) {
          exampleMessagesOutput.value = this.currentCharacter.mesExample;
        } else {
          exampleMessagesOutput.textContent = this.currentCharacter.mesExample;
        }
        exampleMessagesOutput.style.display = "block";
      } else {
        if (
          exampleMessagesOutput.tagName === "TEXTAREA" ||
          exampleMessagesOutput.tagName === "INPUT"
        ) {
          exampleMessagesOutput.value = "";
        } else {
          exampleMessagesOutput.textContent = "";
        }
        exampleMessagesOutput.style.display = "none";
      }
    }

    this.updateTokenCounts();
  },

  handleCharacterEdit(field) {
    if (!this.originalCharacter || !this.currentCharacter) {
      return;
    }

    let textarea, resetBtn, originalValue, currentField;

    switch (field) {
      case "name":
        textarea = document.getElementById("character-generated-name");
        resetBtn = document.getElementById("reset-name-btn");
        originalValue = this.originalCharacter.name;
        currentField = "name";
        break;
      case "description":
        textarea = document.getElementById("character-description");
        resetBtn = document.getElementById("reset-description-btn");
        originalValue = this.originalCharacter.description;
        currentField = "description";
        break;
      case "personality":
        textarea = document.getElementById("character-personality");
        resetBtn = document.getElementById("reset-personality-btn");
        originalValue = this.originalCharacter.personality;
        currentField = "personality";
        break;
      case "scenario":
        textarea = document.getElementById("character-scenario");
        resetBtn = document.getElementById("reset-scenario-btn");
        originalValue = this.originalCharacter.scenario;
        currentField = "scenario";
        break;
      case "firstMessage":
        textarea = document.getElementById("character-first-message");
        resetBtn = document.getElementById("reset-first-message-btn");
        originalValue = this.originalCharacter.firstMessage;
        currentField = "firstMessage";
        break;
      case "postHistoryInstructions":
        textarea = document.getElementById("character-post-history");
        resetBtn = document.getElementById("reset-post-history-btn");
        originalValue = this.originalCharacter.postHistoryInstructions;
        currentField = "postHistoryInstructions";
        break;
      case "creatorNotes":
        textarea = document.getElementById("creator-notes");
        resetBtn = document.getElementById("reset-creator-notes-btn");
        originalValue = this.originalCharacter.creatorNotes;
        currentField = "creatorNotes";
        break;
    }

    this.currentCharacter[currentField] = textarea.value;

    const currentContent = textarea.value.trim();
    const originalContent = (originalValue || "").trim();

    if (currentContent !== originalContent) {
      resetBtn.style.display = "block";
    } else {
      resetBtn.style.display = "none";
    }

    this.updateTokenCounts();
  },

  handleResetField(field) {
    if (!this.originalCharacter) {
      this.showNotification("No original character to reset to", "warning");
      return;
    }

    let textarea, resetBtn, originalValue, fieldName;

    switch (field) {
      case "name":
        textarea = document.getElementById("character-generated-name");
        resetBtn = document.getElementById("reset-name-btn");
        originalValue = this.originalCharacter.name;
        fieldName = "Name";
        break;
      case "description":
        textarea = document.getElementById("character-description");
        resetBtn = document.getElementById("reset-description-btn");
        originalValue = this.originalCharacter.description;
        fieldName = "Description";
        break;
      case "personality":
        textarea = document.getElementById("character-personality");
        resetBtn = document.getElementById("reset-personality-btn");
        originalValue = this.originalCharacter.personality;
        fieldName = "Personality";
        break;
      case "scenario":
        textarea = document.getElementById("character-scenario");
        resetBtn = document.getElementById("reset-scenario-btn");
        originalValue = this.originalCharacter.scenario;
        fieldName = "Scenario";
        break;
      case "firstMessage":
        textarea = document.getElementById("character-first-message");
        resetBtn = document.getElementById("reset-first-message-btn");
        originalValue = this.originalCharacter.firstMessage;
        fieldName = "First message";
        break;
      case "postHistoryInstructions":
        textarea = document.getElementById("character-post-history");
        resetBtn = document.getElementById("reset-post-history-btn");
        originalValue = this.originalCharacter.postHistoryInstructions;
        fieldName = "Post-history instructions";
        break;
      case "creatorNotes":
        textarea = document.getElementById("creator-notes");
        resetBtn = document.getElementById("reset-creator-notes-btn");
        originalValue = this.originalCharacter.creatorNotes;
        fieldName = "Creator's notes";
        break;
    }

    textarea.value = originalValue || "";
    this.currentCharacter[field] = originalValue || "";

    resetBtn.style.display = "none";

    this.updateTokenCounts();

    this.showNotification(`${fieldName} reset to original`, "success");
  },

  async handleOpenNamePicker() {
    if (!this.currentCharacter) return;
    this.showNamePickerModal();
  },

  showNamePickerModal() {
    const modal = document.getElementById("name-picker-modal");
    const genderSelect = document.getElementById("name-picker-gender");
    const typeSelect = document.getElementById("name-picker-type");
    const periodSelect = document.getElementById("name-picker-period");
    const guidanceInput = document.getElementById("name-picker-guidance");
    const generateBtn = document.getElementById("name-picker-generate-btn");
    const cancelBtn = document.getElementById("name-picker-cancel-btn");
    const grid = document.getElementById("name-picker-grid");
    const statusEl = document.getElementById("name-picker-status");

    if (!modal) return;

    // Reset state
    grid.innerHTML = "";
    statusEl.textContent = "";
    guidanceInput.value = "";
    genderSelect.value = "any";
    typeSelect.value = "any";
    periodSelect.value = "any";

    // Accumulate all shown names across rerolls so we can ban them from the next roll
    let seenNames = [];

    modal.classList.add("show");
    document.body.style.overflow = "hidden";

    const close = () => {
      modal.classList.remove("show");
      document.body.style.overflow = "";
      generateBtn.removeEventListener("click", onGenerate);
      cancelBtn.removeEventListener("click", close);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEscape);
    };

    const onBackdrop = (e) => { if (e.target === modal) close(); };
    const onEscape = (e) => { if (e.key === "Escape") close(); };

    const onGenerate = async () => {
      const gender = genderSelect.value;
      const type = typeSelect.value;
      const timePeriod = periodSelect.value;
      const guidance = guidanceInput.value.trim();

      grid.innerHTML = "";
      statusEl.textContent = seenNames.length > 0
        ? `Generating fresh names (${seenNames.length} previous names excluded)…`
        : "Generating names…";
      generateBtn.disabled = true;
      generateBtn.textContent = "Generating…";

      try {
        const names = await window.apiHandler.generateNameOptions(
          this.currentCharacter, gender, type, timePeriod, guidance, seenNames
        );

        // Accumulate seen names so the next reroll avoids them
        seenNames = [...seenNames, ...names];

        statusEl.textContent = seenNames.length > 10
          ? `Click a name to use it — or adjust options and generate again for a completely fresh set:`
          : "Click a name to use it:";

        grid.innerHTML = names.map((name) =>
          `<button class="name-picker-option" data-name="${name.replace(/"/g, "&quot;")}">${name}</button>`
        ).join("");

        grid.querySelectorAll(".name-picker-option").forEach((btn) => {
          btn.addEventListener("click", () => {
            const chosen = btn.dataset.name;
            const nameInput = document.getElementById("character-generated-name");
            if (nameInput) {
              nameInput.value = chosen;
              this.currentCharacter.name = chosen;
              this.handleCharacterEdit("name");
            }
            this.showNotification(`Name set to "${chosen}"`, "success");
            close();
          });
        });
      } catch (error) {
        statusEl.textContent = `Failed: ${error.message}`;
        console.error("Name picker generation failed:", error);
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = "🎲 Generate Names";
      }
    };

    generateBtn.addEventListener("click", onGenerate);
    cancelBtn.addEventListener("click", close);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEscape);

    // Auto-generate on open
    onGenerate();
  },

  async handleRegenerateName() {
    if (!this.currentCharacter) return;

    const nameInput = document.getElementById("character-generated-name");
    const regenBtn = document.getElementById("regenerate-name-btn");

    if (!nameInput || !regenBtn) return;

    try {
      regenBtn.disabled = true;
      const originalText = regenBtn.textContent;
      regenBtn.textContent = "⏳...";

      const newName = await window.apiHandler.generateName(this.currentCharacter);

      if (newName) {
        nameInput.value = newName;
        this.currentCharacter.name = newName;
        this.handleCharacterEdit("name");
        this.showNotification("Name regenerated!", "success");
      }

      regenBtn.textContent = originalText;
      regenBtn.disabled = false;
    } catch (error) {
      console.error("Name generation failed:", error);
      this.showNotification(`Failed to generate name: ${error.message}`, "error");
      regenBtn.disabled = false;
      regenBtn.textContent = "🔄 Gen Name";
    }
  },

  async handleRegenerateField(field) {
    if (!this.currentCharacter) return;

    let promptInputId, btnId, textAreaId;
    switch (field) {
      case "description":
        promptInputId = "description-prompt";
        btnId = "regenerate-description-btn";
        textAreaId = "character-description";
        break;
      case "personality":
        promptInputId = "personality-prompt";
        btnId = "regenerate-personality-btn";
        textAreaId = "character-personality";
        break;
      case "scenario":
        promptInputId = "scenario-prompt";
        btnId = "regenerate-scenario-btn";
        textAreaId = "character-scenario";
        break;
      case "firstMessage":
        promptInputId = "first-message-prompt";
        btnId = "regenerate-first-message-btn";
        textAreaId = "character-first-message";
        break;
    }

    const promptInput = document.getElementById(promptInputId);
    const regenBtn = document.getElementById(btnId);
    const textArea = document.getElementById(textAreaId);

    if (!regenBtn || !textArea) return;

    const customPrompt = promptInput?.value?.trim() || "";

    try {
      regenBtn.disabled = true;
      const originalText = regenBtn.textContent;
      regenBtn.textContent = "⏳...";

      const pov = document.getElementById("pov-select")?.value || "third";
      const before = this._captureCardSnapshot();
      const newValue = await window.apiHandler.regenerateField(
        this.currentCharacter,
        field,
        customPrompt,
        pov,
        this.lorebookEntries,
      );

      if (newValue) {
        const revised = JSON.parse(JSON.stringify(this.currentCharacter));
        revised[field] = newValue;
        const approved = await this.promptCardDiffApproval(before, revised);

        if (approved) {
          textArea.value = newValue;
          this.currentCharacter[field] = newValue;
          this.handleCharacterEdit(field);
          this.showNotification(`${field} regenerated!`, "success");
        } else {
          this.showNotification(`${field} regeneration discarded.`, "info");
        }
      }

      regenBtn.textContent = originalText;
      regenBtn.disabled = false;
    } catch (error) {
      console.error(`Failed to regenerate ${field}:`, error);
      this.showNotification(`Failed to regenerate ${field}: ${error.message}`, "error");
      regenBtn.disabled = false;
      regenBtn.textContent = "🔄 Redo";
    }
  },

  async handleGenerateExampleMessages(skipDiff = false) {
    if (!this.currentCharacter) return;

    const count = parseInt(
      document.getElementById("example-messages-count")?.value || "3",
      10,
    );
    const outputDiv = document.getElementById("example-messages-output");

    try {
      if (outputDiv.tagName === "TEXTAREA" || outputDiv.tagName === "INPUT") {
        outputDiv.value = "⏳ Generating example messages...";
      } else {
        outputDiv.textContent = "⏳ Generating example messages...";
      }
      outputDiv.style.display = "block";

      const pov = document.getElementById("pov-select")?.value || "third";
      const customPrompt =
        document.getElementById("example-messages-prompt")?.value?.trim() || "";
      const before = this._captureCardSnapshot();
      const examples = await this.apiHandler.generateExampleMessages(
        this.currentCharacter,
        count,
        pov,
        customPrompt,
        this.lorebookEntries,
      );

      const revised = JSON.parse(JSON.stringify(this.currentCharacter));
      revised.mesExample = examples;
      const approved = skipDiff ? true : await this.promptCardDiffApproval(before, revised);

      if (approved) {
        this.currentCharacter.mesExample = examples;

        if (this.originalCharacter) {
          this.originalCharacter.mesExample = this.currentCharacter.mesExample;
        }

        if (outputDiv.tagName === "TEXTAREA" || outputDiv.tagName === "INPUT") {
          outputDiv.value = this.currentCharacter.mesExample;
        } else {
          outputDiv.textContent = this.currentCharacter.mesExample;
        }
        outputDiv.style.display = "block";
        this.updateTokenCounts();
      } else {
        if (outputDiv.tagName === "TEXTAREA" || outputDiv.tagName === "INPUT") {
          outputDiv.value = this.currentCharacter.mesExample || "";
        } else {
          outputDiv.textContent = this.currentCharacter.mesExample || "";
        }
        if (!this.currentCharacter.mesExample) outputDiv.style.display = "none";
        this.showNotification("Example messages discarded.", "info");
      }
    } catch (error) {
      console.error("Example generation failed:", error);
      if (outputDiv.tagName === "TEXTAREA" || outputDiv.tagName === "INPUT") {
        outputDiv.value = `⚠️ Generation failed: ${error.message}`;
      } else {
        outputDiv.textContent = `⚠️ Generation failed: ${error.message}`;
      }
    }
  },

  async handleRegenerateCreatorNotes() {
    if (!this.currentCharacter) return;

    const textArea = document.getElementById("creator-notes");
    const regenBtn = document.getElementById("regenerate-creator-notes-btn");
    const promptInput = document.getElementById("creator-notes-prompt");

    if (!textArea || !regenBtn) return;

    const customPrompt = promptInput?.value?.trim() || "";

    try {
      regenBtn.disabled = true;
      const originalText = regenBtn.textContent;
      regenBtn.textContent = "⏳...";

      const newNotes = await window.apiHandler.generateCreatorNotes(this.currentCharacter, customPrompt);

      if (newNotes) {
        textArea.value = newNotes;
        this.currentCharacter.creatorNotes = newNotes;
        this.showNotification("Creator's Notes regenerated!", "success");
        const resetBtn = document.getElementById("reset-creator-notes-btn");
        if (resetBtn) resetBtn.style.display = "block";
      }

      regenBtn.textContent = originalText;
      regenBtn.disabled = false;
    } catch (error) {
      console.error("Creator's Notes generation failed:", error);
      this.showNotification(`Failed to generate notes: ${error.message}`, "error");
      regenBtn.disabled = false;
      regenBtn.textContent = "🔄 Redo";
    }
  },

  async handleRegeneratePostHistory() {
    if (!this.currentCharacter) return;

    const textArea = document.getElementById("character-post-history");
    const regenBtn = document.getElementById("regenerate-post-history-btn");
    const promptInput = document.getElementById("post-history-prompt");

    if (!textArea || !regenBtn) return;

    const customPrompt = promptInput?.value?.trim() || "";

    try {
      regenBtn.disabled = true;
      const originalText = regenBtn.textContent;
      regenBtn.textContent = "⏳...";

      const newInstructions = await window.apiHandler.generatePostHistoryInstructions(this.currentCharacter, customPrompt);

      if (newInstructions) {
        textArea.value = newInstructions;
        this.currentCharacter.postHistoryInstructions = newInstructions;
        this.handleCharacterEdit("postHistoryInstructions");
        this.showNotification("Post-History Instructions regenerated!", "success");
      }

      regenBtn.textContent = originalText;
      regenBtn.disabled = false;
    } catch (error) {
      console.error("Post-History Instructions generation failed:", error);
      this.showNotification(`Failed to generate instructions: ${error.message}`, "error");
      regenBtn.disabled = false;
      regenBtn.textContent = "🔄 Redo";
    }
  },

  normalizeCharacterFromSpec(specData) {
    if (specData?.data) {
      return {
        name: specData.data.name || "Unnamed Character",
        description: specData.data.description || "",
        personality: specData.data.personality || "",
        scenario: specData.data.scenario || "",
        firstMessage: specData.data.first_mes || "",
        mesExample: specData.data.mes_example || "",
        postHistoryInstructions: specData.data.post_history_instructions || specData.data.postHistoryInstructions || "",
        creatorNotes: specData.data.creator_notes || "",
        character_book: specData.data.character_book || undefined,
        alternateGreetings: specData.data.alternate_greetings || [],
        tags: specData.data.tags || [],
        cardType: specData.data.cardType || "single",
      };
    }

    return {
      name: specData.name || "Unnamed Character",
      description: specData.description || "",
      personality: specData.personality || "",
      scenario: specData.scenario || "",
      firstMessage: specData.firstMessage || specData.first_mes || "",
      mesExample: specData.mesExample || specData.mes_example || "",
      postHistoryInstructions: specData.postHistoryInstructions || specData.post_history_instructions || "",
      creatorNotes: specData.creatorNotes || specData.creator_notes || "",
      character_book: specData.character_book || undefined,
      alternateGreetings:
        specData.alternateGreetings || specData.alternate_greetings || [],
      tags: specData.tags || [],
      cardType: specData.cardType || "single",
    };
  },

  async handleImportCard(event, autoRemaster = false) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await this.handleImportCardFile(file, autoRemaster);
    } finally {
      event.target.value = "";
    }
  },

  async handleImportCardFile(file, autoRemaster = false) {
    try {
      let characterData = null;
      let importedImageUrl = "";

      // Clear any ST slot link — if this import is from ST, loadCardFromST will
      // re-set stSourceAvatar after this function returns
      this.stSourceAvatar = null;
      this._updatePushButton();

      if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) {
        const extracted = await this.pngEncoder.extractCharacterData(file);
        characterData = this.normalizeCharacterFromSpec(extracted);
        importedImageUrl = URL.createObjectURL(file);
      } else {
        const text = await file.text();
        const parsed = JSON.parse(text);
        characterData = this.normalizeCharacterFromSpec(parsed);
      }

      if (!characterData) throw new Error("Unable to parse card content");

      this.currentCharacter = characterData;
      this.originalCharacter = JSON.parse(JSON.stringify(characterData));
      this.displayCharacter();
      this.showResultSection();
      const inputSectionDetails = document.getElementById("input-section-details");
      if (inputSectionDetails) inputSectionDetails.open = false;

      if (importedImageUrl) {
        this.currentImageUrl = importedImageUrl;
        const imageContainer = document.getElementById("image-content");
        imageContainer.innerHTML = `
          <div class="image-container">
            <img src="${importedImageUrl}" alt="${characterData.name}" class="generated-image">
          </div>
        `;
      }

      document.getElementById("image-controls").style.display = "block";
      document.getElementById("image-buttons-row").style.display = "";

      // Restore card type dropdown
      const cardTypeSelect = document.getElementById("card-type-select");
      if (cardTypeSelect) {
        cardTypeSelect.value = characterData.cardType || "single";
        cardTypeSelect.dispatchEvent(new Event("change"));
      }

      if (characterData.character_book && characterData.character_book.entries) {
        this.lorebookEntries = characterData.character_book.entries.map((e) => ({
          id: e.id || Date.now().toString() + Math.random().toString().slice(2, 5),
          keys: e.keys || [],
          content: e.content || "",
          enabled: e.enabled !== false,
        }));
      } else {
        this.lorebookEntries = [];
      }
      this.updateLorebookEntryCount();

      if (characterData.alternateGreetings) {
        this.altGreetings = characterData.alternateGreetings.map((content, i) => ({
          id: Date.now().toString() + i,
          content,
        }));
      } else {
        this.altGreetings = [];
      }
      this.updateAltGreetingsCount();

      await this.saveCardToLibrary();
      await this.refreshLibraryViews();

      if (autoRemaster) {
        this.showNotification("Card imported, starting AI remaster...", "info");
        await this.handleAutoRemaster();
      } else {
        this.showNotification("Card imported for editing", "success");
      }
    } catch (error) {
      console.error("Card import failed:", error);
      this.showNotification(`Card import failed: ${error.message}`, "error");
    }
  },

  showDropImportModal(file) {
    const modal = document.getElementById("drop-import-modal");
    const filenameEl = document.getElementById("drop-import-filename");
    const editBtn = document.getElementById("drop-import-edit-btn");
    const remasterBtn = document.getElementById("drop-import-remaster-btn");
    const reviewBtn = document.getElementById("drop-import-review-btn");
    const cancelBtn = document.getElementById("drop-import-cancel-btn");

    filenameEl.textContent = file.name;
    modal.classList.add("show");
    document.body.style.overflow = "hidden";

    const close = () => {
      modal.classList.remove("show");
      document.body.style.overflow = "";
      editBtn.removeEventListener("click", onEdit);
      remasterBtn.removeEventListener("click", onRemaster);
      if (reviewBtn) reviewBtn.removeEventListener("click", onReview);
      cancelBtn.removeEventListener("click", close);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEscape);
    };

    const onEdit = () => { close(); this.handleImportCardFile(file, false); };
    const onRemaster = () => { close(); this.handleImportCardFile(file, true); };
    const onReview = () => { close(); this.addCardToReviewQueue(file); };
    const onBackdrop = (e) => { if (e.target === modal) close(); };
    const onEscape = (e) => { if (e.key === "Escape") close(); };

    editBtn.addEventListener("click", onEdit);
    remasterBtn.addEventListener("click", onRemaster);
    if (reviewBtn) reviewBtn.addEventListener("click", onReview);
    cancelBtn.addEventListener("click", close);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEscape);
  },

  // ── Review Queue ─────────────────────────────────────────────────────────

  async addCardToReviewQueue(file) {
    try {
      let characterData = null;
      let imageUrl = null;
      let fileBase64 = null;
      const fileName = file.name;
      const fileType = file.type || (fileName.toLowerCase().endsWith(".png") ? "image/png" : "application/json");

      // Read the whole file as base64 for persistence
      fileBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          // result is a data URL like "data:image/png;base64,..." — strip prefix
          const dataUrl = reader.result;
          resolve(dataUrl.split(",")[1] || dataUrl);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      if (fileType === "image/png" || fileName.toLowerCase().endsWith(".png")) {
        const extracted = await this.pngEncoder.extractCharacterData(file);
        characterData = this.normalizeCharacterFromSpec(extracted);
        imageUrl = URL.createObjectURL(file);
      } else {
        const text = await file.text();
        const parsed = JSON.parse(text);
        characterData = this.normalizeCharacterFromSpec(parsed);
      }

      if (!characterData) throw new Error("Unable to parse card content");

      const id = `review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this._reviewQueue.push({ id, name: characterData.name || fileName, imageUrl, characterData, file, fileBase64, fileName, fileType });
      this._renderReviewTray();
      this._saveReviewQueueToStorage();
      this.showNotification(`“${characterData.name || fileName}” added to Review Queue — scroll down to see it`, "success");
    } catch (err) {
      console.error("Review queue add failed:", err);
      this.showNotification(`Could not add to review queue: ${err.message}`, "error");
    }
  },

  _saveReviewQueueToStorage() {
    try {
      const serializable = this._reviewQueue.map(e => ({
        id: e.id,
        name: e.name,
        characterData: e.characterData,
        fileBase64: e.fileBase64,
        fileName: e.fileName,
        fileType: e.fileType,
      }));
      localStorage.setItem("reviewQueue", JSON.stringify(serializable));
    } catch (err) {
      // Quota exceeded or private mode — fail silently
      console.warn("Review queue: could not persist to localStorage:", err.message);
    }
  },

  _loadReviewQueueFromStorage() {
    try {
      const raw = localStorage.getItem("reviewQueue");
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.length === 0) return;

      saved.forEach(e => {
        // Reconstruct object URL from base64 for image display
        let imageUrl = null;
        let file = null;
        if (e.fileBase64) {
          try {
            const byteStr = atob(e.fileBase64);
            const arr = new Uint8Array(byteStr.length);
            for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
            const blob = new Blob([arr], { type: e.fileType || "application/octet-stream" });
            file = new File([blob], e.fileName || "card", { type: e.fileType });
            if (e.fileType === "image/png" || (e.fileName || "").toLowerCase().endsWith(".png")) {
              imageUrl = URL.createObjectURL(blob);
            }
          } catch (decodeErr) {
            console.warn("Review queue: could not decode stored entry", e.id, decodeErr);
          }
        }
        this._reviewQueue.push({
          id: e.id,
          name: e.name,
          characterData: e.characterData,
          imageUrl,
          file,
          fileBase64: e.fileBase64,
          fileName: e.fileName,
          fileType: e.fileType,
        });
      });

      if (this._reviewQueue.length > 0) {
        this._renderReviewTray();
      }
    } catch (err) {
      console.warn("Review queue: failed to restore from localStorage:", err);
    }
  },

  _renderReviewTray() {
    const tray = document.getElementById("review-tray");
    const toggle = document.getElementById("review-tray-toggle");
    const badge = document.getElementById("review-tray-badge");
    const countEl = document.getElementById("review-tray-count");
    const cardsEl = document.getElementById("review-tray-cards");

    const count = this._reviewQueue.length;

    // ── Inline page section (primary UI) ─────────────────────────────────
    const pageSection = document.getElementById("review-queue-section");
    const pageSectionCards = document.getElementById("review-queue-section-cards");
    const pageSectionCount = document.getElementById("review-queue-section-count");
    if (pageSection) pageSection.style.display = count > 0 ? "" : "none";
    if (pageSectionCount) pageSectionCount.textContent = count;

    // Wire Clear All once
    const clearAllBtn = document.getElementById("review-queue-clear-all-btn");
    if (clearAllBtn && !clearAllBtn._wired) {
      clearAllBtn._wired = true;
      clearAllBtn.addEventListener("click", () => {
        this._reviewQueue.forEach(e => { if (e.imageUrl) URL.revokeObjectURL(e.imageUrl); });
        this._reviewQueue = [];
        this._saveReviewQueueToStorage();
        this._closeReviewModal();
        this._renderReviewTray();
      });
    }

    // Render inline cards
    if (pageSectionCards) {
      pageSectionCards.innerHTML = "";
      this._reviewQueue.forEach((entry, idx) => {
        const card = document.createElement("div");
        card.className = "review-tray-card";
        card.title = `Click to review: ${entry.name}`;
        card.innerHTML = `
          <div class="review-tray-card-img">
            ${entry.imageUrl
              ? `<img src="${entry.imageUrl}" alt="${entry.name}">`
              : `<span class="review-tray-card-no-img">?</span>`}
          </div>
          <div class="review-tray-card-name">${entry.name}</div>
          <button class="review-tray-card-remove" title="Remove from queue">&times;</button>
        `;
        card.addEventListener("click", (e) => {
          if (e.target.closest(".review-tray-card-remove")) return;
          this._openReviewModal(idx);
        });
        card.querySelector(".review-tray-card-remove").addEventListener("click", (e) => {
          e.stopPropagation();
          this._removeFromReviewQueue(entry.id);
        });
        pageSectionCards.appendChild(card);
      });
    }

    // ── Floating FAB + toolbar button (secondary/backup) ──────────────────
    if (toggle) toggle.style.display = count > 0 ? "flex" : "none";
    if (badge) badge.textContent = count;
    if (countEl) countEl.textContent = count;

    const toolbarBtn = document.getElementById("review-queue-toolbar-btn");
    const toolbarCount = document.getElementById("review-queue-toolbar-count");
    if (toolbarBtn) {
      toolbarBtn.style.display = count > 0 ? "" : "none";
      if (toolbarCount) toolbarCount.textContent = count;
      if (!toolbarBtn._reviewWired) {
        toolbarBtn._reviewWired = true;
        toolbarBtn.addEventListener("click", () => {
          pageSection?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }

    // Sync old tray cards too (for the slide-up tray if anyone uses it)
    if (cardsEl) {
      cardsEl.innerHTML = "";
      this._reviewQueue.forEach((entry, idx) => {
        const card = document.createElement("div");
        card.className = "review-tray-card";
        card.title = entry.name;
        card.innerHTML = `
          <div class="review-tray-card-img">
            ${entry.imageUrl
              ? `<img src="${entry.imageUrl}" alt="${entry.name}">`
              : `<span class="review-tray-card-no-img">?</span>`}
          </div>
          <div class="review-tray-card-name">${entry.name}</div>
          <button class="review-tray-card-remove" data-id="${entry.id}" title="Remove">&times;</button>
        `;
        card.addEventListener("click", (e) => {
          if (e.target.closest(".review-tray-card-remove")) return;
          this._openReviewModal(idx);
        });
        card.querySelector(".review-tray-card-remove").addEventListener("click", (e) => {
          e.stopPropagation();
          this._removeFromReviewQueue(entry.id);
        });
        cardsEl.appendChild(card);
      });
    }

    // Slide-up tray visibility
    if (tray) {
      if (count === 0) {
        tray.classList.remove("open");
        tray.style.display = "none";
      } else if (tray.classList.contains("open")) {
        tray.style.display = "flex";
      }
    }
  },

  _removeFromReviewQueue(id) {
    const entry = this._reviewQueue.find(e => e.id === id);
    if (entry && entry.imageUrl) URL.revokeObjectURL(entry.imageUrl);
    this._reviewQueue = this._reviewQueue.filter(e => e.id !== id);
    this._saveReviewQueueToStorage();
    this._renderReviewTray();

    // If modal is open and we deleted the current entry, adjust or close
    const modal = document.getElementById("review-card-modal");
    if (modal && modal.classList.contains("show")) {
      if (this._reviewQueue.length === 0) {
        this._closeReviewModal();
      } else {
        this._reviewModalIndex = Math.min(this._reviewModalIndex, this._reviewQueue.length - 1);
        this._populateReviewModal(this._reviewModalIndex);
      }
    }
  },

  _openReviewModal(index) {
    if (this._reviewQueue.length === 0) return;
    this._reviewModalIndex = Math.max(0, Math.min(index, this._reviewQueue.length - 1));
    const modal = document.getElementById("review-card-modal");
    if (!modal) return;
    modal.classList.add("show");
    modal.removeAttribute("aria-hidden");
    document.body.style.overflow = "hidden";
    this._populateReviewModal(this._reviewModalIndex);
    this._bindReviewModalEvents();
  },

  _closeReviewModal() {
    const modal = document.getElementById("review-card-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  },

  _populateReviewModal(index) {
    const entry = this._reviewQueue[index];
    if (!entry) return;
    const cd = entry.characterData;

    // Header name
    const titleEl = document.getElementById("review-card-modal-title");
    if (titleEl) titleEl.textContent = cd.name || "Unnamed";

    // Image
    const imgWrap = document.getElementById("review-card-image-wrap");
    const noImg = document.getElementById("review-card-no-image");
    if (imgWrap) {
      // Remove previous img if any
      imgWrap.querySelectorAll("img").forEach(el => el.remove());
      if (entry.imageUrl) {
        if (noImg) noImg.style.display = "none";
        const img = document.createElement("img");
        img.src = entry.imageUrl;
        img.alt = cd.name;
        img.className = "review-card-image";
        imgWrap.appendChild(img);
      } else {
        if (noImg) noImg.style.display = "flex";
      }
    }

    // Fields
    const fieldsEl = document.getElementById("review-card-fields");
    if (fieldsEl) {
      fieldsEl.innerHTML = this._renderReviewFields(cd);
    }

    // Nav label
    const navLabel = document.getElementById("review-card-nav-label");
    if (navLabel) navLabel.textContent = `${index + 1} / ${this._reviewQueue.length}`;

    // Prev/Next disabled state
    const prevBtn = document.getElementById("review-card-prev");
    const nextBtn = document.getElementById("review-card-next");
    if (prevBtn) prevBtn.disabled = index === 0;
    if (nextBtn) nextBtn.disabled = index === this._reviewQueue.length - 1;
  },

  _renderReviewFields(cd) {
    const field = (label, value) => {
      if (!value || !value.trim()) return "";
      // Simple markdown-ish: bold **x**, italic *x*, headings # 
      const html = value
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/^(#{1,3})\s+(.+)$/gm, (_, hashes, text) => {
          const level = Math.min(hashes.length + 3, 6);
          return `<h${level} class="rcf-heading">${text}</h${level}>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\n/g, "<br>");
      return `<div class="rcf-field"><div class="rcf-label">${label}</div><div class="rcf-value">${html}</div></div>`;
    };

    return [
      field("Description", cd.description),
      field("Personality", cd.personality),
      field("Scenario", cd.scenario),
      field("First Message", cd.firstMessage),
      field("Example Messages", cd.mesExample),
      field("Post-History Instructions", cd.postHistoryInstructions),
      field("Creator Notes", cd.creatorNotes),
      (cd.tags && cd.tags.length
        ? `<div class="rcf-field"><div class="rcf-label">Tags</div><div class="rcf-value rcf-tags">${cd.tags.map(t => `<span class="rcf-tag">${t}</span>`).join("")}</div></div>`
        : ""),
      (cd.alternateGreetings && cd.alternateGreetings.length
        ? field(`Alternate Greetings (${cd.alternateGreetings.length})`, cd.alternateGreetings.join("\n\n---\n\n"))
        : ""),
    ].join("");
  },

  _bindReviewModalEvents() {
    if (this._reviewModalBound) return;
    this._reviewModalBound = true;

    const modal = document.getElementById("review-card-modal");
    const closeBtn = document.getElementById("review-card-modal-close");
    const deleteBtn = document.getElementById("review-card-delete-btn");
    const saveBtn = document.getElementById("review-card-save-btn");
    const remasterBtn = document.getElementById("review-card-remaster-btn");
    const prevBtn = document.getElementById("review-card-prev");
    const nextBtn = document.getElementById("review-card-next");

    if (closeBtn) closeBtn.addEventListener("click", () => this._closeReviewModal());
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) this._closeReviewModal(); });

    if (deleteBtn) deleteBtn.addEventListener("click", () => {
      const entry = this._reviewQueue[this._reviewModalIndex];
      if (entry) this._removeFromReviewQueue(entry.id);
    });

    if (saveBtn) saveBtn.addEventListener("click", () => {
      const entry = this._reviewQueue[this._reviewModalIndex];
      if (!entry) return;
      this._closeReviewModal();
      this.handleImportCardFile(entry.file, false).then(() => {
        this._removeFromReviewQueue(entry.id);
      });
    });

    if (remasterBtn) remasterBtn.addEventListener("click", () => {
      const entry = this._reviewQueue[this._reviewModalIndex];
      if (!entry) return;
      this._closeReviewModal();
      this.handleImportCardFile(entry.file, true).then(() => {
        this._removeFromReviewQueue(entry.id);
      });
    });

    if (prevBtn) prevBtn.addEventListener("click", () => {
      if (this._reviewModalIndex > 0) {
        this._reviewModalIndex--;
        this._populateReviewModal(this._reviewModalIndex);
      }
    });

    if (nextBtn) nextBtn.addEventListener("click", () => {
      if (this._reviewModalIndex < this._reviewQueue.length - 1) {
        this._reviewModalIndex++;
        this._populateReviewModal(this._reviewModalIndex);
      }
    });

    document.addEventListener("keydown", (e) => {
      const modal = document.getElementById("review-card-modal");
      if (!modal || !modal.classList.contains("show")) return;
      if (e.key === "Escape") this._closeReviewModal();
      if (e.key === "ArrowLeft") prevBtn?.click();
      if (e.key === "ArrowRight") nextBtn?.click();
    });
  },

  _initReviewTray() {
    const tray = document.getElementById("review-tray");
    const toggle = document.getElementById("review-tray-toggle");
    const closeBtn = document.getElementById("review-tray-close");

    if (toggle) toggle.addEventListener("click", () => {
      if (tray) { tray.style.display = "flex"; tray.classList.add("open"); }
    });
    if (closeBtn) closeBtn.addEventListener("click", () => {
      if (tray) { tray.classList.remove("open"); tray.style.display = "none"; }
    });

    // Restore persisted queue from previous session
    this._loadReviewQueueFromStorage();
  },



  async handleAutoRemaster() {
    if (!this.currentCharacter) return;

    this.setRevisionState(true, "revise-character-btn");

    try {
      const pov = document.getElementById("pov-select")?.value || "third";
      this.currentCharacter.character_book = this.buildCharacterBook();
      this.syncAltGreetingsToCharacter();
      this.showNotification("Applying AI remaster...", "info");

      const revisionInstruction =
        "This character card may be poorly formatted, inconsistent, or lack proper structure. Remaster it completely to meet the required format, BUT YOU MUST PRESERVE ALL FACTUAL DETAILS AND LORE. Do NOT remove any backstory elements, world-building, relationships, character traits, items, or physical descriptions. Reformat and clarify the writing into the correct sections, but do not delete the underlying concepts or details. Rewrite every section to be logically consistent and behaviourally precise. Use direct bullet points for personality traits and behaviours; use short factual prose for backstory and scenario. Fix grammar and remove flowery prose, but ensure every single piece of factual information from the original card is retained in the new format.";

      const revised = await this.apiHandler.reviseCharacter(
        this.currentCharacter,
        revisionInstruction,
        pov,
      );
      this.currentCharacter = revised;
      this.originalCharacter = JSON.parse(JSON.stringify(revised));
      this.displayCharacter();
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
      this.showNotification("Card remastered successfully!", "success");
    } catch (error) {
      console.error("Remaster failed:", error);
      const wasStoppedByUser = error.message.includes(
        "Generation stopped by user",
      );
      if (!wasStoppedByUser) {
        this.showNotification(`Remaster failed: ${error.message}`, "error");
      }
    } finally {
      this.setRevisionState(false);
    }
  },

  // ── Tag management ──────────────────────────────────────────────────────────

  _renderTags(tags) {
    const container = document.getElementById("character-tags-container");
    const input = document.getElementById("character-tags-input");
    if (!container || !input) return;

    // Remove all pill elements, keep the input
    container.querySelectorAll(".tag-pill").forEach(el => el.remove());

    (tags || []).forEach(tag => {
      const pill = document.createElement("span");
      pill.className = "tag-pill";
      pill.dataset.tag = tag;
      pill.innerHTML = `${escapeHtml(tag)}<span class="tag-pill-remove" aria-label="Remove tag">×</span>`;
      pill.addEventListener("click", () => this._removeTag(tag));
      container.insertBefore(pill, input);
    });
  },

  _escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  },

  _addTag(raw) {
    if (!this.currentCharacter) return;
    const tag = raw.trim().toLowerCase().replace(/[^a-z0-9\-\s]/g, "").replace(/\s+/g, "-");
    if (!tag) return;
    if (!Array.isArray(this.currentCharacter.tags)) this.currentCharacter.tags = [];
    if (!this.currentCharacter.tags.includes(tag)) {
      this.currentCharacter.tags.push(tag);
      this._renderTags(this.currentCharacter.tags);
    }
  },

  _removeTag(tag) {
    if (!this.currentCharacter || !Array.isArray(this.currentCharacter.tags)) return;
    this.currentCharacter.tags = this.currentCharacter.tags.filter(t => t !== tag);
    this._renderTags(this.currentCharacter.tags);
  },

  initTagInput() {
    const container = document.getElementById("character-tags-container");
    const input = document.getElementById("character-tags-input");
    if (!container || !input) return;

    container.addEventListener("click", (e) => {
      if (!e.target.closest(".tag-pill")) input.focus();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        this._addTag(input.value);
        input.value = "";
      } else if (e.key === "Backspace" && input.value === "" && this.currentCharacter?.tags?.length) {
        this._removeTag(this.currentCharacter.tags[this.currentCharacter.tags.length - 1]);
      }
    });

    input.addEventListener("blur", () => {
      if (input.value.trim()) {
        this._addTag(input.value);
        input.value = "";
      }
    });
  },

  async handleAutoTag() {
    if (!this.currentCharacter) return;
    const btn = document.getElementById("auto-tag-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Tagging…"; }
    try {
      const tags = await window.apiHandler.generateTags(this.currentCharacter);
      if (!Array.isArray(this.currentCharacter.tags)) this.currentCharacter.tags = [];
      // Merge — keep existing, add new ones
      tags.forEach(t => { if (!this.currentCharacter.tags.includes(t)) this.currentCharacter.tags.push(t); });
      this._renderTags(this.currentCharacter.tags);
      this.showNotification(`Added ${tags.length} tags`, "success");
    } catch (err) {
      this.showNotification(`Auto-tag failed: ${err.message}`, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🏷️ Auto-Tag"; }
    }
  },

});

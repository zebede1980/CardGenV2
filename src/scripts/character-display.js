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

    let totalTokens = 0;

    const updateFieldCount = (field, elementId) => {
      const text = this.currentCharacter[field] || "";
      const tokens = this.estimateTokens(text);
      totalTokens += tokens;
      const el = document.getElementById(elementId);
      if (el) {
        el.textContent = `(~${tokens} tokens)`;
      }
    };

    updateFieldCount("name", "name-token-count");
    updateFieldCount("description", "description-token-count");
    updateFieldCount("personality", "personality-token-count");
    updateFieldCount("scenario", "scenario-token-count");
    updateFieldCount("firstMessage", "first-message-token-count");
    updateFieldCount("mesExample", "example-messages-token-count");

    let lorebookTokens = 0;
    this.lorebookEntries.forEach((entry) => {
      lorebookTokens += this.estimateTokens(entry.keys.join(", "));
      lorebookTokens += this.estimateTokens(entry.content);
    });
    totalTokens += lorebookTokens;

    let altGreetingsTokens = 0;
    this.altGreetings.forEach((greeting) => {
      altGreetingsTokens += this.estimateTokens(greeting.content);
    });
    totalTokens += altGreetingsTokens;

    const totalEl = document.getElementById("total-token-count");
    if (totalEl) {
      totalEl.textContent = `Approx. Total: ${totalTokens} tokens`;
    }
  },

  displayCharacter() {
    const nameInput = document.getElementById("character-generated-name");
    const descriptionTextarea = document.getElementById("character-description");
    const personalityTextarea = document.getElementById("character-personality");
    const scenarioTextarea = document.getElementById("character-scenario");
    const firstMessageTextarea = document.getElementById("character-first-message");

    if (nameInput) nameInput.value = this.currentCharacter.name || "";
    descriptionTextarea.value = this.currentCharacter.description || "";
    personalityTextarea.value = this.currentCharacter.personality || "";
    scenarioTextarea.value = this.currentCharacter.scenario || "";
    firstMessageTextarea.value = this.currentCharacter.firstMessage || "";

    const resetNameBtn = document.getElementById("reset-name-btn");
    const resetDescriptionBtn = document.getElementById("reset-description-btn");
    const resetPersonalityBtn = document.getElementById("reset-personality-btn");
    const resetScenarioBtn = document.getElementById("reset-scenario-btn");
    const resetFirstMessageBtn = document.getElementById("reset-first-message-btn");

    if (resetNameBtn) resetNameBtn.style.display = "none";
    if (resetDescriptionBtn) resetDescriptionBtn.style.display = "none";
    if (resetPersonalityBtn) resetPersonalityBtn.style.display = "none";
    if (resetScenarioBtn) resetScenarioBtn.style.display = "none";
    if (resetFirstMessageBtn) resetFirstMessageBtn.style.display = "none";

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
      const guidance = guidanceInput.value.trim();

      grid.innerHTML = "";
      statusEl.textContent = "Generating names…";
      generateBtn.disabled = true;
      generateBtn.textContent = "Generating…";

      try {
        const names = await window.apiHandler.generateNameOptions(this.currentCharacter, gender, guidance);
        statusEl.textContent = "Click a name to use it:";
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

    // Auto-generate on open so the user sees names immediately
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
      const newValue = await window.apiHandler.regenerateField(
        this.currentCharacter,
        field,
        customPrompt,
        pov,
        this.lorebookEntries,
      );

      if (newValue) {
        textArea.value = newValue;
        this.currentCharacter[field] = newValue;
        this.handleCharacterEdit(field);
        this.showNotification(`${field} regenerated!`, "success");
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

  async handleGenerateExampleMessages() {
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
      const examples = await this.apiHandler.generateExampleMessages(
        this.currentCharacter,
        count,
        pov,
        customPrompt,
        this.lorebookEntries,
      );

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
    } catch (error) {
      console.error("Example generation failed:", error);
      if (outputDiv.tagName === "TEXTAREA" || outputDiv.tagName === "INPUT") {
        outputDiv.value = `⚠️ Generation failed: ${error.message}`;
      } else {
        outputDiv.textContent = `⚠️ Generation failed: ${error.message}`;
      }
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
        character_book: specData.data.character_book || undefined,
        alternateGreetings: specData.data.alternate_greetings || [],
      };
    }

    return {
      name: specData.name || "Unnamed Character",
      description: specData.description || "",
      personality: specData.personality || "",
      scenario: specData.scenario || "",
      firstMessage: specData.firstMessage || specData.first_mes || "",
      mesExample: specData.mesExample || specData.mes_example || "",
      character_book: specData.character_book || undefined,
      alternateGreetings:
        specData.alternateGreetings || specData.alternate_greetings || [],
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
    const cancelBtn = document.getElementById("drop-import-cancel-btn");

    filenameEl.textContent = file.name;
    modal.classList.add("show");
    document.body.style.overflow = "hidden";

    const close = () => {
      modal.classList.remove("show");
      document.body.style.overflow = "";
      editBtn.removeEventListener("click", onEdit);
      remasterBtn.removeEventListener("click", onRemaster);
      cancelBtn.removeEventListener("click", close);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEscape);
    };

    const onEdit = () => { close(); this.handleImportCardFile(file, false); };
    const onRemaster = () => { close(); this.handleImportCardFile(file, true); };
    const onBackdrop = (e) => { if (e.target === modal) close(); };
    const onEscape = (e) => { if (e.key === "Escape") close(); };

    editBtn.addEventListener("click", onEdit);
    remasterBtn.addEventListener("click", onRemaster);
    cancelBtn.addEventListener("click", close);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEscape);
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
        "This character card is poor quality, inconsistent, or incomplete. Remaster it completely — preserve the core identity, name, and any visual descriptions, but rewrite every section to be concise, logically consistent, and behaviourally precise. The card is guidance for an AI playing the character, not a story. Use direct bullet points for personality traits and behaviours; short factual prose only for backstory and scenario. Fix grammar and remove any purple prose, padding, or repetition. Do not expand sections beyond what is needed to play the character accurately.";

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

});

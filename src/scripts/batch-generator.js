// Batch Generation Module — extends CharacterGeneratorApp prototype
// 2-stage generation: (1) 4 quick-paragraph ideas from one concept, (2) full
// character generated only for the idea the user picks. Keeps the 4 ideas
// genuinely distinct (one AI call, told to diverge) instead of 4 separate
// full generations from the same concept, which tended to converge on very
// similar characters.
Object.assign(CharacterGeneratorApp.prototype, {

  /* ── State ──────────────────────────────────────────────────────────────── */
  _batchIdeas: [],
  _batchSelectedIdx: -1,
  _batchIsGenerating: false,

  /* ── Stage 1: Generate 4 Ideas ──────────────────────────────────────────── */

  async handleBatchGenerate() {
    if (this._batchIsGenerating || this.isGenerating) {
      this.showNotification("Generation already in progress.", "warning");
      return;
    }

    this.saveAPISettings();
    const errors = this.config.validateConfig();
    if (errors.length > 0) {
      this.showNotification(`Configuration errors: ${errors.join(", ")}`, "error");
      return;
    }

    const concept = document.getElementById("character-concept").value.trim();
    const referenceImageDescription = document.getElementById("reference-image-description")?.value?.trim();

    if (!concept && !referenceImageDescription) {
      this.showNotification("Please enter a character concept or reference image description", "warning");
      return;
    }

    const cardType = document.getElementById("card-type-select")?.value || "single";

    this._setBatchButtonStates(true);
    this._openBatchModal();

    this._batchIsGenerating = true;
    this._batchIdeas = [];
    this._batchSelectedIdx = -1;

    const batchGrid = document.getElementById("batch-grid");
    const batchLoading = document.getElementById("batch-loading");
    const batchProgress = document.getElementById("batch-progress");
    const batchDetail = document.getElementById("batch-detail");
    if (batchDetail) { batchDetail.style.display = "none"; batchDetail.innerHTML = ""; }
    if (batchGrid) batchGrid.innerHTML = "";
    if (batchLoading) batchLoading.style.display = "block";
    if (batchProgress) { batchProgress.textContent = "Brainstorming 4 ideas…"; batchProgress.style.color = ""; }

    try {
      const rawIdeas = await window.apiHandler.generateBatchIdeas(concept, referenceImageDescription, cardType);
      this._batchIdeas = this._parseBatchIdeas(rawIdeas);

      this._renderBatchIdeas(batchGrid);
      if (batchLoading) batchLoading.style.display = "none";
      if (batchProgress) batchProgress.textContent = "Pick an idea to generate the full character card.";
    } catch (error) {
      console.error("Batch idea generation failed:", error);
      if (batchLoading) batchLoading.style.display = "none";
      if (batchProgress) {
        batchProgress.textContent = `❌ ${error.message}`;
        batchProgress.style.color = "var(--error)";
      }
      this.showNotification(`Failed to generate ideas: ${error.message}`, "error");
    } finally {
      this._batchIsGenerating = false;
      this._setBatchButtonStates(false);
    }
  },

  /**
   * Parse raw AI text into an array of 4 idea objects.
   * Expected format: "1. **Name** — Description..."
   */
  _parseBatchIdeas(rawText) {
    const ideas = [];
    const lines = rawText.split("\n");
    let currentIdea = null;

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\d+)[\.\)]\s*\*\*(.+?)\*\*\s*(?:—|–|-)\s*(.+)/);
      if (match) {
        if (currentIdea) ideas.push(currentIdea);
        currentIdea = {
          name: match[2].trim(),
          description: match[3].trim(),
        };
      } else if (currentIdea && trimmed) {
        // Continuation line for the current idea
        currentIdea.description += " " + trimmed;
      }
    }
    if (currentIdea) ideas.push(currentIdea);

    // Pad to exactly 4 if the AI returned fewer
    while (ideas.length < 4) {
      ideas.push({
        name: `Idea ${ideas.length + 1}`,
        description: "A unique take on your concept that could go in many directions.",
      });
    }
    return ideas.slice(0, 4);
  },

  _setBatchButtonStates(isGenerating) {
    const batchBtn = document.getElementById("batch-generate-btn");
    const generateBtn = document.getElementById("generate-btn");
    const stopBtn = document.getElementById("stop-btn");

    if (batchBtn) {
      const btnText = batchBtn.querySelector(".btn-text");
      const btnLoading = batchBtn.querySelector(".btn-loading");
      if (btnText) btnText.style.display = isGenerating ? "none" : "inline";
      if (btnLoading) btnLoading.style.display = isGenerating ? "inline" : "none";
      batchBtn.disabled = isGenerating;
    }
    if (generateBtn) {
      const btnText = generateBtn.querySelector(".btn-text");
      const btnLoading = generateBtn.querySelector(".btn-loading");
      if (btnText) btnText.style.display = isGenerating ? "none" : "inline";
      if (btnLoading) btnLoading.style.display = isGenerating ? "inline" : "none";
      generateBtn.disabled = isGenerating;
    }
    if (stopBtn) {
      stopBtn.style.display = isGenerating ? "inline-block" : "none";
    }
  },

  /* ── Modal ──────────────────────────────────────────────────────────────── */

  _openBatchModal() {
    const modal = document.getElementById("batch-modal");
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    const title = modal.querySelector(".modal-title");
    if (title) title.textContent = "🎲 4 Ideas — Pick One";
  },

  closeBatchModal() {
    if (this._batchIsGenerating) {
      this.handleBatchStop();
    }
    const modal = document.getElementById("batch-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  },

  /* ── Render ─────────────────────────────────────────────────────────────── */

  _renderBatchIdeas(grid) {
    if (!grid) return;
    grid.innerHTML = "";

    this._batchIdeas.forEach((idea, idx) => {
      const card = document.createElement("div");
      card.className = "batch-card";
      card.dataset.batchIdx = idx;
      card.innerHTML = `
        <div class="batch-card-header">
          <span class="batch-card-num">#${idx + 1}</span>
          <span class="batch-card-name">${escapeHtml(idea.name)}</span>
        </div>
        <div class="batch-card-section">
          <div class="batch-card-text">${escapeHtml(idea.description)}</div>
        </div>
        <button class="btn-primary batch-pick-btn" data-action="pick-batch" data-idx="${idx}">✨ Generate This Character</button>
      `;
      grid.appendChild(card);
    });
  },

  /* ── Stage 2: Full Character from Chosen Idea ────────────────────────────── */

  async handleBatchPick(idx) {
    if (this.isGenerating) {
      this.showNotification("Generation already in progress.", "warning");
      return;
    }
    const idea = this._batchIdeas[idx];
    if (!idea) return;

    this._batchSelectedIdx = idx;
    this.closeBatchModal();

    const concept = document.getElementById("character-concept").value.trim();
    const characterName = document.getElementById("character-name").value.trim();
    const referenceImageDescription = document.getElementById("reference-image-description")?.value?.trim();
    const pov = document.getElementById("pov-select").value;
    const cardType = document.getElementById("card-type-select")?.value || "single";

    let effectiveConcept = concept
      ? `${concept}\n\nSpecific direction to take: ${idea.name} — ${idea.description}`
      : `${idea.name}: ${idea.description}`;
    if (referenceImageDescription) {
      effectiveConcept += `\n\nReference appearance guidance:\n${referenceImageDescription}`;
    }

    this.isGenerating = true;
    this.setGeneratingState(true);

    this.stSourceAvatar = null;
    this._updatePushButton();

    this.hideResultSection();
    this.currentImageUrl = null;
    if (window.apiHandler) window.apiHandler.lastGeneratedImagePrompt = null;

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    if (customPromptTextarea) { customPromptTextarea.value = ""; if (window.updatePromptCharCount) window.updatePromptCharCount(); }

    ["description-prompt", "personality-prompt", "scenario-prompt", "first-message-prompt", "example-messages-prompt"]
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });

    const imageContent = document.getElementById("image-content");
    if (imageContent) {
      imageContent.innerHTML = `<div class="image-placeholder"><div class="loading-spinner"></div></div>`;
    }

    if (typeof this._resetCharacterMediaState === "function") {
      this._resetCharacterMediaState();
    } else {
      this.currentImageUrl = null;
      this.imageHistoryUrls = [];
    }
    if (typeof this._clearCharacterGallery === "function") {
      this._clearCharacterGallery();
    }

    this.lorebookEntries = [];
    this.updateLorebookEntryCount();
    this.altGreetings = [];
    this.updateAltGreetingsCount();
    this.clearStream();

    try {
      const promptSaved = await this.savePromptToLibrary({
        concept: concept || `${idea.name}: ${idea.description}`,
        characterName, pov, cardType,
        lorebookData: this.lorebookData,
        referenceImageDescription: referenceImageDescription || "",
        referenceImageDataUrl: this.referenceImageDataUrl || "",
      });
      await this.refreshLibraryViews();
      if (!promptSaved) this.showStreamMessage("⚠️ Prompt could not be saved to local library.\n");

      this.showStreamMessage(`🚀 Generating full character from "${idea.name}"...\n\n`);
      this.currentCharacter = await this.characterGenerator.generateCharacter(
        effectiveConcept, characterName,
        (token, fullContent) => this.handleCharacterStream(token, fullContent),
        pov, this.lorebookData, cardType,
      );

      // Stamp cardType
      this.currentCharacter.cardType = cardType;
      if (cardType === "group" || cardType === "scenario") {
        if (!Array.isArray(this.currentCharacter.tags)) this.currentCharacter.tags = [];
        if (!this.currentCharacter.tags.includes(cardType)) this.currentCharacter.tags.push(cardType);
      }

      this.showStreamMessage("\n\n💬 Generating example messages...\n");
      await this.handleGenerateExampleMessages(true);

      this.showStreamMessage("✍️ Generating creator's notes...\n");
      try {
        const notes = await this.apiHandler.generateCreatorNotes(this.currentCharacter);
        if (notes) { this.currentCharacter.creatorNotes = notes; }
      } catch (notesError) {
        console.warn("Creator notes generation failed (non-fatal):", notesError);
      }

      this.showStreamMessage("📜 Generating post-history instructions...\n");
      try {
        const postHistory = await this.apiHandler.generatePostHistoryInstructions(this.currentCharacter);
        if (postHistory) { this.currentCharacter.postHistoryInstructions = postHistory; }
      } catch (phError) {
        console.warn("Post-History Instructions generation failed (non-fatal):", phError);
      }

      this.originalCharacter = JSON.parse(JSON.stringify(this.currentCharacter));

      this.showStreamMessage("\n✅ Character generation complete!\n");
      this.displayCharacter();

      // Auto-generate image if configured (same as handleGenerate)
      const imageApiBase = this.config.get("api.image.baseUrl");
      const imageApiKey = this.config.get("api.image.apiKey");
      const enableImageGeneration = this.config.get("app.enableImageGeneration");
      const hasReferenceImage = !!this.referenceImageDataUrl;

      if (hasReferenceImage) {
        this.currentImageUrl = this.referenceImageDataUrl;
        document.getElementById("image-content").innerHTML = `
          <div class="image-container">
            <img src="${this.currentImageUrl}" alt="${this.currentCharacter.name || "Reference image"}" class="generated-image">
          </div>`;
        this.showStreamMessage("🖼️ Using uploaded reference image as final card image (skipped image API generation)\n");
      } else if (imageApiBase && imageApiKey && enableImageGeneration) {
        try {
          this.showStreamMessage("🎨 Generating character image...\n");

          if (this.config.get("api.image.models") && this.config.get("api.image.models").length > 0) {
            this.config.set("api.image.model", this.config.get("api.image.models")[0]);
            const activeImageModelSelect = document.getElementById("active-image-model");
            if (activeImageModelSelect) activeImageModelSelect.value = this.config.get("api.image.models")[0];
          }
          this.config.set("api.image.style", "realistic");
          const styleSelect = document.getElementById("image-style");
          if (styleSelect) styleSelect.value = "realistic";

          await this.generateImage(true);
          this.showStreamMessage("✅ Image generation complete!\n");
        } catch (imageError) {
          console.error("Image generation error:", imageError);
          this.showStreamMessage(`⚠️ Image generation failed: ${imageError.message}\n`);
          this.showStreamMessage("📝 Continuing with character data only...\n");
          document.getElementById("image-content").innerHTML = `
            <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
              <p>Image generation failed</p>
              <p style="font-size:0.875rem;margin-top:0.5rem;color:var(--error);">${imageError.message}</p>
              <p style="font-size:0.875rem;margin-top:0.5rem;">You can upload your own image</p>
            </div>`;
        }
      } else {
        this.showStreamMessage("⏭️ Skipping image generation (image generation disabled or no API configured)\n");
        document.getElementById("image-content").innerHTML = `
          <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
            <div style="font-size:2rem;margin-bottom:1rem;">🖼️</div>
            <p style="font-weight:500;margin-bottom:0.5rem;">Image Generation Disabled</p>
            <p style="font-size:0.875rem;margin-bottom:1rem;">Enable image generation in settings or upload your own image</p>
            <button onclick="document.getElementById('upload-image-btn').click()" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:0.375rem;cursor:pointer;">
              📁 Upload Image
            </button>
          </div>`;
      }

      this.showResultSection();
      document.getElementById("image-controls").style.display = "block";
      document.getElementById("image-buttons-row").style.display = "";

      if (imageApiBase && imageApiKey) {
        const promptEditor = document.getElementById("image-prompt-editor");
        const customPromptTextarea = document.getElementById("custom-image-prompt");
        const referenceDescription = document.getElementById("reference-image-description")?.value?.trim();

        if (promptEditor) {
          promptEditor.style.display = "block";

          if (customPromptTextarea && referenceDescription && !customPromptTextarea.value.trim()) {
            customPromptTextarea.value = `Character portrait of ${this.currentCharacter.name || "the character"}, based on this reference description: ${referenceDescription}. High quality, detailed features, cinematic lighting, coherent anatomy, expressive face, fitting background.`;
            this.currentCharacter.imagePrompt = customPromptTextarea.value;
            window.updatePromptCharCount();
          }

          if (customPromptTextarea && window.apiHandler.lastGeneratedImagePrompt) {
            customPromptTextarea.value = window.apiHandler.lastGeneratedImagePrompt;
            this.currentCharacter.imagePrompt = window.apiHandler.lastGeneratedImagePrompt;
            window.updatePromptCharCount();
          } else if (!hasReferenceImage && customPromptTextarea && !customPromptTextarea.value.trim()) {
            try {
              customPromptTextarea.value = await window.apiHandler.generateImagePrompt(
                this.currentCharacter.description,
                this.currentCharacter.name,
              );
            } catch (error) {
              console.error("Failed to generate image prompt:", error);
              customPromptTextarea.value = window.apiHandler.buildDirectImagePrompt(
                this.currentCharacter.description, this.currentCharacter.name,
              );
            }
            this.currentCharacter.imagePrompt = customPromptTextarea.value;
            window.updatePromptCharCount();
          }
        }
      }

      await this.saveCardToLibrary();
      await this.refreshLibraryViews();

      this.showNotification("Character generated successfully!", "success");
    } catch (error) {
      console.error("Batch full generation failed:", error);
      if (error.message.includes("Generation stopped by user")) {
        this.showStreamMessage(`\n🛑 Generation stopped.\n`);
      } else {
        this.showStreamMessage(`\n❌ Generation failed: ${error.message}\n`);
        this.showNotification(`Generation failed: ${error.message}`, "error");
      }
      this.hideResultSection();
    } finally {
      this.isGenerating = false;
      this.setGeneratingState(false);
      const inputSectionDetails = document.getElementById("input-section-details");
      if (inputSectionDetails) inputSectionDetails.open = false;
    }
  },

  /* ── Stop ───────────────────────────────────────────────────────────────── */

  handleBatchStop() {
    if (window.apiHandler) window.apiHandler.stopGeneration();
    this._batchIsGenerating = false;
    this._setBatchButtonStates(false);
    this.showNotification("Batch idea generation stopped.", "warning");
  },

  /* ── Grid click delegation ──────────────────────────────────────────────── */

  _handleBatchGridClick(e) {
    const pickBtn = e.target.closest("[data-action='pick-batch']");
    if (pickBtn) {
      const idx = parseInt(pickBtn.dataset.idx, 10);
      this.handleBatchPick(idx);
      return;
    }
  },

});

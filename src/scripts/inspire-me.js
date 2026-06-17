// Inspire Me Module — extends CharacterGeneratorApp prototype
// 2-stage generation: (1) 4 idea sparks from filters, (2) full character from chosen idea
Object.assign(CharacterGeneratorApp.prototype, {

  /* ── State ──────────────────────────────────────────────────────────────── */
  _inspireIdeas: [],
  _inspireSelectedIdx: -1,
  _inspireIsGenerating: false,

  /* ── Stage 1: Generate 4 Ideas ──────────────────────────────────────────── */

  async handleInspireGenerate() {
    if (this._inspireIsGenerating || this.isGenerating) return;

    this.saveAPISettings();
    const errors = this.config.validateConfig();
    if (errors.length > 0) {
      this.showNotification(`Configuration errors: ${errors.join(", ")}`, "error");
      return;
    }

    const filters = {
      gender: document.getElementById("inspire-gender")?.value || "any",
      orientation: document.getElementById("inspire-orientation")?.value || "any",
      theme: document.getElementById("inspire-theme")?.value?.trim() || "",
      nsfw: document.getElementById("inspire-nsfw")?.value || "sfw",
      genre: document.getElementById("inspire-genre")?.value || "any",
      trope: document.getElementById("inspire-trope")?.value?.trim() || "",
    };

    this._inspireIsGenerating = true;
    this._inspireIdeas = [];
    this._inspireSelectedIdx = -1;

    // Open modal with loading state
    this._openInspireModal();
    const loadingEl = document.getElementById("inspire-loading");
    const gridEl = document.getElementById("inspire-ideas-grid");
    const memoArea = document.getElementById("inspire-memo-area");
    const confirmArea = document.getElementById("inspire-confirm-area");
    const memoTextarea = document.getElementById("inspire-memo");

    if (loadingEl) loadingEl.style.display = "block";
    if (gridEl) { gridEl.style.display = "none"; gridEl.innerHTML = ""; }
    if (memoArea) memoArea.style.display = "none";
    if (confirmArea) confirmArea.style.display = "none";
    if (memoTextarea) memoTextarea.value = "";

    try {
      const rawIdeas = await window.apiHandler.generateInspireIdeas(filters);
      this._inspireIdeas = this._parseInspireIdeas(rawIdeas);

      this._renderInspireIdeas();
      if (loadingEl) loadingEl.style.display = "none";
      if (gridEl) gridEl.style.display = "grid";
      if (memoArea) memoArea.style.display = "block";
      if (confirmArea) confirmArea.style.display = "block";
    } catch (error) {
      console.error("Inspire Me idea generation failed:", error);
      this.showNotification(`Failed to generate ideas: ${error.message}`, "error");
      this.closeInspireModal();
    } finally {
      this._inspireIsGenerating = false;
    }
  },

  /**
   * Parse raw AI text into an array of 4 idea objects.
   * Expected format: "1. **Name** — Description..."
   */
  _parseInspireIdeas(rawText) {
    const ideas = [];
    const lines = rawText.split("\n");
    let currentIdea = null;

    for (const line of lines) {
      const trimmed = line.trim();
      // Match: "1. **Name** — Description" or "1) **Name** - Description"
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
        name: `Concept ${ideas.length + 1}`,
        description: "A unique character concept that could go in many directions.",
      });
    }
    return ideas.slice(0, 4);
  },

  /**
   * Render the 4 idea cards inside #inspire-ideas-grid.
   */
  _renderInspireIdeas() {
    const grid = document.getElementById("inspire-ideas-grid");
    if (!grid) return;
    grid.innerHTML = "";

    this._inspireIdeas.forEach((idea, idx) => {
      const card = document.createElement("div");
      card.className = "inspire-idea-card";
      card.dataset.ideaIdx = idx;
      card.innerHTML = [
        `<span class="idea-num">Idea #${idx + 1}</span>`,
        `<span class="idea-name">${escapeHtml(idea.name)}</span>`,
        `<span class="idea-desc">${escapeHtml(idea.description)}</span>`,
      ].join("");
      card.addEventListener("click", () => this._selectInspireIdea(idx));
      grid.appendChild(card);
    });
  },

  /**
   * Highlight the selected idea card and store the index.
   */
  _selectInspireIdea(idx) {
    this._inspireSelectedIdx = idx;
    document.querySelectorAll(".inspire-idea-card").forEach((card, i) => {
      card.classList.toggle("selected", i === idx);
    });
  },

  /* ── Stage 2: Full Character from Chosen Idea ────────────────────────────── */

  async handleInspireFullGenerate() {
    if (this._inspireSelectedIdx < 0) {
      this.showNotification("Please pick one of the ideas first", "warning");
      return;
    }

    // Close modal immediately
    this.closeInspireModal();

    const chosenIdea = this._inspireIdeas[this._inspireSelectedIdx];
    const memo = document.getElementById("inspire-memo")?.value?.trim() || "";

    // Build the effective concept from chosen idea + memo
    const effectiveConcept = `${chosenIdea.name}: ${chosenIdea.description}${memo ? `\n\nAdditional guidance: ${memo}` : ""}`;
    const characterName = document.getElementById("character-name").value.trim();
    const pov = document.getElementById("pov-select").value;
    const cardType = document.getElementById("card-type-select")?.value || "single";

    // Follow the same pattern as handleGenerate()
    this.isGenerating = true;
    this.setGeneratingState(true);

    this.stSourceAvatar = null;
    this._updatePushButton();

    this.hideResultSection();
    this.currentImageUrl = null;
    if (window.apiHandler) window.apiHandler.lastGeneratedImagePrompt = null;

    // Clear image prompt
    const customPromptTextarea = document.getElementById("custom-image-prompt");
    if (customPromptTextarea) { customPromptTextarea.value = ""; if (window.updatePromptCharCount) window.updatePromptCharCount(); }

    ["description-prompt", "personality-prompt", "scenario-prompt", "first-message-prompt", "example-messages-prompt"]
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });

    const imageContent = document.getElementById("image-content");
    if (imageContent) {
      imageContent.innerHTML = `<div class="image-placeholder"><div class="loading-spinner"></div></div>`;
    }

    this.lorebookEntries = [];
    this.updateLorebookEntryCount();
    this.altGreetings = [];
    this.updateAltGreetingsCount();
    this.clearStream();

    try {
      // Save prompt to library
      const promptSaved = await this.savePromptToLibrary({
        concept: `${chosenIdea.name}: ${chosenIdea.description}`,
        characterName, pov, cardType,
        lorebookData: this.lorebookData,
        inspireMemo: memo,
      });
      await this.refreshLibraryViews();
      if (!promptSaved) this.showStreamMessage("⚠️ Prompt could not be saved to local library.\n");

      this.showStreamMessage("🚀 Starting character generation from your chosen idea...\n\n");
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
            window.updatePromptCharCount();
          }

          if (customPromptTextarea && window.apiHandler.lastGeneratedImagePrompt) {
            customPromptTextarea.value = window.apiHandler.lastGeneratedImagePrompt;
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
            window.updatePromptCharCount();
          }
        }
      }

      await this.saveCardToLibrary();
      await this.refreshLibraryViews();

      this.showNotification("Character generated successfully!", "success");
    } catch (error) {
      console.error("Inspire Me full generation failed:", error);
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

  /* ── Modal Management ──────────────────────────────────────────────────── */

  _openInspireModal() {
    const modal = document.getElementById("inspire-picker-modal");
    if (!modal) return;
    modal.classList.add("show");
    document.body.style.overflow = "hidden";
  },

  closeInspireModal() {
    const modal = document.getElementById("inspire-picker-modal");
    if (!modal) return;
    modal.classList.remove("show");
    document.body.style.overflow = "";
  },

});

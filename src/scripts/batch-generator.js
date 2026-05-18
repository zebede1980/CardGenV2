// Batch Generation Module — extends CharacterGeneratorApp prototype
// Generates N character variants from the same concept in parallel,
// then presents a comparison grid to pick the favourite.
Object.assign(CharacterGeneratorApp.prototype, {

  /* ── State ──────────────────────────────────────────────────────────────── */
  _batchVariants: [],       // Array of parsed character objects
  _batchSelectedIdx: -1,
  _batchAbortController: null,
  _batchIsGenerating: false,

  /* ── Entry Point ────────────────────────────────────────────────────────── */

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
    const characterName = document.getElementById("character-name").value.trim();
    const pov = document.getElementById("pov-select").value;
    const cardType = document.getElementById("card-type-select")?.value || "single";
    const referenceImageDescription = document.getElementById("reference-image-description")?.value?.trim();

    if (!concept) {
      this.showNotification("Please enter a character concept", "warning");
      return;
    }

    const VARIANT_COUNT = 4;

    // Set both generate button loading states
    this._setBatchButtonStates(true);

    // Open the batch modal
    this._openBatchModal(VARIANT_COUNT);

    this._batchAbortController = new AbortController();
    this._batchIsGenerating = true;
    this._batchVariants = [];
    this._batchSelectedIdx = -1;

    const batchGrid = document.getElementById("batch-grid");
    const batchLoading = document.getElementById("batch-loading");
    const batchProgress = document.getElementById("batch-progress");
    const batchDetail = document.getElementById("batch-detail");
    if (batchDetail) batchDetail.style.display = "none";
    if (batchGrid) batchGrid.innerHTML = "";
    if (batchLoading) batchLoading.style.display = "block";

    // Copy lorebook
    const lorebookData = this.lorebookData;

    // Build effective concept
    let effectiveConcept = concept;
    if (referenceImageDescription) effectiveConcept += `\n\nReference appearance guidance:\n${referenceImageDescription}`;

    try {
      // Generate first variant with streaming (shown in the stream box)
      if (batchProgress) batchProgress.textContent = `Generating variant 1 of ${VARIANT_COUNT}…`;

      this.clearStream();
      this.showStreamMessage("🚀 Starting batch generation...\n\n");

      const firstVariant = await this.characterGenerator.generateCharacter(
        effectiveConcept, characterName,
        (token, fullContent) => this._onBatchStream(1, VARIANT_COUNT, token, fullContent),
        pov, lorebookData, cardType,
      );

      // Stamp cardType
      firstVariant.cardType = cardType;
      if (cardType === "group" || cardType === "scenario") {
        if (!Array.isArray(firstVariant.tags)) firstVariant.tags = [];
        if (!firstVariant.tags.includes(cardType)) firstVariant.tags.push(cardType);
      }

      this._batchVariants.push(firstVariant);
      this._renderBatchCard(firstVariant, 0, batchGrid);

      if (batchProgress) batchProgress.textContent = `Generated 1 of ${VARIANT_COUNT}…`;

      // Check for abort
      if (this._batchAbortController.signal.aborted) {
        this.showStreamMessage("\n🛑 Batch generation stopped.\n");
        this._finishBatchGeneration(batchLoading);
        return;
      }

      // Generate remaining variants silently in parallel
      const remainingCount = VARIANT_COUNT - 1;
      if (remainingCount > 0) {
        this.showStreamMessage(`\n⚡ Generating ${remainingCount} more variant(s) in parallel...\n`);

        const promises = [];
        for (let i = 0; i < remainingCount; i++) {
          const variantIdx = i + 1;
          promises.push(
            this._generateSingleVariant(effectiveConcept, characterName, pov, lorebookData, cardType, variantIdx)
          );
        }

        // Process as they complete
        let failedCount = 0;
        const results = await Promise.allSettled(promises);
        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            this._batchVariants.push(result.value);
            this._renderBatchCard(result.value, this._batchVariants.length - 1, batchGrid);
            if (batchProgress) batchProgress.textContent = `Generated ${this._batchVariants.length} of ${VARIANT_COUNT}…`;
          } else {
            failedCount++;
            const reason = result.status === "rejected" ? (result.reason?.message || String(result.reason)) : "returned empty";
            console.warn(`Batch variant failed (${reason})`);
            this.showStreamMessage(`⚠️ Variant failed (${reason.slice(0, 80)})\n`);
          }
        }
        if (failedCount > 0 && batchProgress) {
          batchProgress.textContent = `⚠️ ${this._batchVariants.length} of ${VARIANT_COUNT} succeeded (${failedCount} failed — possible rate limit)`;
          batchProgress.style.color = "var(--warning)";
        }
      }

      this._finishBatchGeneration(batchLoading);

      if (this._batchVariants.length === 0) {
        throw new Error("All variants failed to generate.");
      }

      if (batchProgress) {
        batchProgress.textContent = `✅ ${this._batchVariants.length} variant(s) ready. Click one to preview, then pick your favourite.`;
        batchProgress.style.color = "var(--success)";
      }

      this.showStreamMessage(`\n✅ Batch generation complete! ${this._batchVariants.length} variant(s) ready.\n`);
    } catch (error) {
      console.error("Batch generation error:", error);
      this.showStreamMessage(`❌ Batch generation error: ${error.message}\n`);
      this._finishBatchGeneration(batchLoading);
      if (batchProgress) {
        batchProgress.textContent = `❌ ${error.message}`;
        batchProgress.style.color = "var(--error)";
      }
    } finally {
      this._batchIsGenerating = false;
      this._batchAbortController = null;
      this._setBatchButtonStates(false);
    }
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

  async _generateSingleVariant(concept, characterName, pov, lorebookData, cardType, variantIdx) {
    // Use a standalone fetch so parallel calls don't race on APIHandler's shared state
    // (currentAbortController, currentReader etc.)
    if (this._batchAbortController.signal.aborted) return null;

    try {
      // Build the prompt identically to APIHandler.generateCharacterSilent
      const characterPrompt = window.apiHandler.buildCharacterPrompt(
        concept, characterName, pov, lorebookData, cardType,
      );
      const model = this.config.get("api.text.model");
      const apiKey = this.config.get("api.text.apiKey");
      const apiUrl = this.config.get("api.text.baseUrl");
      const authToken = window.cardgenAuth?.getToken() || "";

      if (!apiUrl || !apiKey) throw new Error("API not configured");

      // Make the request directly — bypassing APIHandler's shared state
      const res = await (window.authFetch || fetch)("/api/text/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "X-API-URL": apiUrl,
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: characterPrompt.systemPrompt },
            { role: "user", content: characterPrompt.userPrompt },
          ],
          temperature: 0.8,
          max_tokens: 8192,
          stream: false,
        }),
        signal: this._batchAbortController.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${errText}`);
      }

      const json = await res.json();
      const rawText = window.apiHandler.processNormalResponse(json);
      if (!rawText) throw new Error("Empty response from API");

      const parsed = this.characterGenerator.parseCharacterData(rawText);
      if (!parsed) return null;

      parsed.cardType = cardType;
      if (cardType === "group" || cardType === "scenario") {
        if (!Array.isArray(parsed.tags)) parsed.tags = [];
        if (!parsed.tags.includes(cardType)) parsed.tags.push(cardType);
      }
      return parsed;
    } catch (err) {
      if (err.name === "AbortError") return null;
      console.error(`Variant ${variantIdx + 1} failed:`, err);
      return null;
    }
  },

  _onBatchStream(variantNum, total, chunk, fullContent) {
    // Stream the first variant only
    if (variantNum !== 1) return;
    this.showStreamChunk(chunk);
  },

  /* ── Modal ──────────────────────────────────────────────────────────────── */

  _openBatchModal(count) {
    const modal = document.getElementById("batch-modal");
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    const title = modal.querySelector(".modal-title");
    if (title) title.textContent = `🎭 Batch Generate — ${count} Variants`;
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

  _finishBatchGeneration(loadingEl) {
    if (loadingEl) loadingEl.style.display = "none";
  },

  /* ── Render ─────────────────────────────────────────────────────────────── */

  _renderBatchCard(variant, idx, grid) {
    if (!grid) return;
    const name = variant.name || `Variant ${idx + 1}`;
    const descSnippet = (variant.description || "").replace(/\n+/g, " ").slice(0, 150);
    const persSnippet = (variant.personality || "").replace(/\n+/g, " ").slice(0, 150);
    const scenarioSnippet = (variant.scenario || "").replace(/\n+/g, " ").slice(0, 100);
    const firstMsgSnippet = (variant.firstMessage || "").replace(/\n+/g, " ").slice(0, 100);

    const card = document.createElement("div");
    card.className = "batch-card";
    card.dataset.batchIdx = idx;
    card.innerHTML = `
      <div class="batch-card-header">
        <span class="batch-card-num">#${idx + 1}</span>
        <span class="batch-card-name">${escapeHtml(name)}</span>
      </div>
      <div class="batch-card-section">
        <div class="batch-card-label">Description</div>
        <div class="batch-card-text">${escapeHtml(descSnippet || "(empty)")}${descSnippet.length >= 150 ? "…" : ""}</div>
      </div>
      <div class="batch-card-section">
        <div class="batch-card-label">Personality</div>
        <div class="batch-card-text">${escapeHtml(persSnippet || "(empty)")}${persSnippet.length >= 150 ? "…" : ""}</div>
      </div>
      <div class="batch-card-section">
        <div class="batch-card-label">Scenario</div>
        <div class="batch-card-text">${escapeHtml(scenarioSnippet || "(empty)")}${scenarioSnippet.length >= 100 ? "…" : ""}</div>
      </div>
      <div class="batch-card-section">
        <div class="batch-card-label">First Message</div>
        <div class="batch-card-text">${escapeHtml(firstMsgSnippet || "(empty)")}${firstMsgSnippet.length >= 100 ? "…" : ""}</div>
      </div>
      <button class="btn-primary batch-pick-btn" data-action="pick-batch" data-idx="${idx}">⭐ Pick This</button>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='pick-batch']")) return; // handled below
      this._showBatchDetail(idx);
    });

    grid.appendChild(card);
  },

  _showBatchDetail(idx) {
    const variant = this._batchVariants[idx];
    if (!variant) return;

    const detail = document.getElementById("batch-detail");
    if (!detail) return;

    // Highlight selected card
    document.querySelectorAll(".batch-card").forEach((c) => c.classList.remove("batch-card-selected"));
    const card = document.querySelector(`.batch-card[data-batch-idx="${idx}"]`);
    if (card) card.classList.add("batch-card-selected");

    detail.style.display = "block";
    detail.innerHTML = `
      <h3 style="margin:0 0 0.75rem;">📋 Full Preview: ${escapeHtml(variant.name || `Variant ${idx + 1}`)}</h3>
      ${this._buildBatchFieldHtml("Description", variant.description)}
      ${this._buildBatchFieldHtml("Personality", variant.personality)}
      ${this._buildBatchFieldHtml("Scenario", variant.scenario)}
      ${this._buildBatchFieldHtml("First Message", variant.firstMessage)}
      <button class="btn-primary batch-detail-pick-btn" style="margin-top:0.75rem;" data-action="pick-batch" data-idx="${idx}">⭐ Pick This Variant</button>
    `;

    // Scroll to detail
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  _buildBatchFieldHtml(label, content) {
    if (!content) return "";
    return `
      <div style="margin-bottom:0.75rem;">
        <strong style="color:var(--text-primary);display:block;margin-bottom:0.25rem;">${escapeHtml(label)}</strong>
        <div style="font-size:0.875rem;color:var(--text-secondary);white-space:pre-wrap;max-height:200px;overflow-y:auto;padding:0.5rem;background:var(--surface);border:1px solid var(--border);border-radius:0.375rem;">${escapeHtml(content)}</div>
      </div>
    `;
  },

  /* ── Pick / Select ──────────────────────────────────────────────────────── */

  async handleBatchPick(idx) {
    const variant = this._batchVariants[idx];
    if (!variant) return;

    this._batchSelectedIdx = idx;

    // Set as current character
    this.currentCharacter = variant;
    this.originalCharacter = JSON.parse(JSON.stringify(variant));

    // Clear image
    this.currentImageUrl = null;
    const imageContent = document.getElementById("image-content");
    if (imageContent) {
      imageContent.innerHTML = `
        <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
          <div style="font-size:2rem;margin-bottom:1rem;">🎭</div>
          <p style="font-weight:500;margin-bottom:0.5rem;">Variant Selected</p>
          <p style="font-size:0.875rem;">Generate or upload an image for the card</p>
        </div>`;
    }

    // Display character
    this.displayCharacter();
    this.hideResultSection();
    this.showResultSection();

    // Close batch modal
    this.closeBatchModal();

    // Show image controls
    const imageControls = document.getElementById("image-controls");
    if (imageControls) imageControls.style.display = "block";

    // Save to library
    await this.saveCardToLibrary();
    await this.refreshLibraryViews();

    this.showNotification(`Selected "${variant.name || `Variant ${idx + 1}`}" as your character!`, "success");
  },

  /* ── Stop ───────────────────────────────────────────────────────────────── */

  handleBatchStop() {
    if (this._batchAbortController) {
      this._batchAbortController.abort();
    }
    if (window.apiHandler) window.apiHandler.stopGeneration();
    this._batchIsGenerating = false;
    this._setBatchButtonStates(false);
    this.showNotification("Batch generation stopped.", "warning");
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

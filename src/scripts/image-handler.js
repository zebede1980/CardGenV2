// Image Handling Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  // Read the prompt guidance field (steering hint for AI prompt generation)
  _getGuidance() {
    return document.getElementById("prompt-guidance")?.value?.trim() || "";
  },

  async generateImage(skipSave = false) {
    const imageContainer = document.getElementById("image-content");

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    const customPrompt = customPromptTextarea?.value?.trim();
    const guidance = document.getElementById("prompt-guidance")?.value?.trim() || "";
    const referenceImageDescription = document
      .getElementById("reference-image-description")
      ?.value?.trim();

    window.updatePromptCharCount();

    if (this.currentImageUrl) {
      console.log("📥 Archiving previous image URL:", this.currentImageUrl);
      this._archiveCurrentImage();
    }

    const imageDescriptionInput = referenceImageDescription
      ? `${this.currentCharacter.description}\n\nReference image details:\n${referenceImageDescription}`
      : this.currentCharacter.description;
    const effectivePrompt = customPrompt || null;
    const cardType = this.currentCharacter?.cardType || document.getElementById("card-type-select")?.value || "single";

    const imageResult = await this.imageGenerator.generateAndDisplayImage(
      imageDescriptionInput,
      this.currentCharacter.name,
      imageContainer,
      effectivePrompt,
      cardType,
      guidance,
    );

    this.currentImageUrl = imageResult.url || imageResult;

    if (
      !customPrompt &&
      customPromptTextarea &&
      window.apiHandler.lastGeneratedImagePrompt
    ) {
      customPromptTextarea.value = window.apiHandler.lastGeneratedImagePrompt;
    }

    if (!skipSave) {
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
    }
  },

  async handleRegenerateImage() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      return;
    }

    const imageApiBase = this.config.get("api.image.baseUrl");
    const imageApiKey = this.config.get("api.image.apiKey");

    if (!imageApiBase || !imageApiKey) {
      this.showNotification(
        "Please configure image API settings first",
        "warning",
      );
      return;
    }

    const promptEditor = document.getElementById("image-prompt-editor");
    const customPromptTextarea = document.getElementById("custom-image-prompt");

    const refDescForPrompt = document
      .getElementById("reference-image-description")
      ?.value?.trim();
    const descriptionForPrompt = refDescForPrompt
      ? `${this.currentCharacter.description}\n\nReference image details:\n${refDescForPrompt}`
      : this.currentCharacter.description;
    const cardType = this.currentCharacter?.cardType || document.getElementById("card-type-select")?.value || "single";

    if (promptEditor && customPromptTextarea) {
      if (!customPromptTextarea.value.trim()) {
        try {
          this.showNotification("Generating image prompt...", "info");
          const defaultPrompt = await window.apiHandler.generateImagePrompt(
            descriptionForPrompt,
            this.currentCharacter.name,
            cardType,
            this._getGuidance(),
          );
          customPromptTextarea.value = defaultPrompt;
          if (this.currentCharacter) this.currentCharacter.imagePrompt = defaultPrompt;
          window.updatePromptCharCount();
        } catch (error) {
          console.error("Failed to generate image prompt:", error);
          const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
            descriptionForPrompt,
            this.currentCharacter.name,
          );
          customPromptTextarea.value = fallbackPrompt;
          if (this.currentCharacter) this.currentCharacter.imagePrompt = fallbackPrompt;
          window.updatePromptCharCount();
        }
      }
      promptEditor.style.display = "block";
    }

    this.openImageOptionsModal();
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    if (modalTitle) modalTitle.innerHTML = "🖼️ Review Generated Image";

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");

    const loadingText = loading.querySelector("p");
    if (loadingText)
      loadingText.textContent = "Generating image... this might take a minute.";

    grid.innerHTML = "";
    loading.style.display = "block";

    try {
      const customPrompt = customPromptTextarea?.value?.trim();
      const referenceImageDescription = document
        .getElementById("reference-image-description")
        ?.value?.trim();

      const imageDescriptionInput = referenceImageDescription
        ? `${this.currentCharacter.description}\n\nReference image details:\n${referenceImageDescription}`
        : this.currentCharacter.description;

      const effectivePrompt = customPrompt || null;

      const model = this.config.get("api.image.model") || "";

      const imageUrl = await window.apiHandler.generateImage(
        imageDescriptionInput,
        this.currentCharacter.name,
        effectivePrompt,
        model,
        cardType,
        undefined,
        this._getGuidance(),
      );

      let displayUrl = imageUrl;
      if (
        imageUrl &&
        !imageUrl.startsWith("blob:") &&
        !imageUrl.startsWith("data:")
      ) {
        const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
        const response = await (window.authFetch || fetch)(proxyUrl);
        if (response.ok) {
          const blob = await response.blob();
          displayUrl = URL.createObjectURL(blob);
        }
      }

      loading.style.display = "none";

      // Show current image first so user can compare
      this._insertCurrentImageCard(grid, [displayUrl]);
      if (this.currentImageUrl) {
        const mt = document.querySelector("#image-options-modal .modal-title");
        if (mt) mt.innerHTML = "🖼️ Compare & Choose";
      }

      const wrapper = document.createElement("div");
      wrapper.style.cursor = "pointer";
      wrapper.style.border = "2px solid transparent";
      wrapper.style.borderRadius = "0.5rem";
      wrapper.style.overflow = "hidden";
      wrapper.style.transition = "border-color 0.2s";
      wrapper.style.backgroundColor = "var(--surface-color)";
      wrapper.style.width = "100%";

      wrapper.onmouseenter = () =>
        (wrapper.style.border = "2px solid var(--accent)");
      wrapper.onmouseleave = () =>
        (wrapper.style.border = "2px solid transparent");

      const finalPrompt =
        customPromptTextarea?.value?.trim() ||
        window.apiHandler.lastGeneratedImagePrompt;
      wrapper.onclick = () =>
        this.selectImageOption(displayUrl, finalPrompt, model, [
          { url: displayUrl },
        ]);

      wrapper.innerHTML = `
        <div style="position:absolute;top:0.5rem;left:0.5rem;background:var(--accent);color:#fff;font-size:0.7rem;font-weight:700;padding:0.2rem 0.55rem;border-radius:999px;z-index:1;letter-spacing:0.04em;">NEW</div>
        <img src="${displayUrl}" style="width: 100%; height: auto; display: block;" alt="Generated Image">
        <div style="padding: 1rem; text-align: center; background: rgba(0,0,0,0.1); border-top: 1px solid var(--border);">
            <button class="btn-primary" style="width: 100%;">Use New Image</button>
        </div>
      `;
      wrapper.style.position = "relative";
      grid.appendChild(wrapper);

      // Wire gallery trigger
      const galleryImages = [{ url: displayUrl, prompt: finalPrompt || "", model: model || "", label: "New" }];
      this._makeImageGalleryable(grid, galleryImages);

      this.openImageOptionsModal();
      this.showNotification(`Image generated! Compare and choose.`, "success");
    } catch (error) {
      console.error("Image regeneration error:", error);
      loading.style.display = "none";
      this.closeImageOptionsModal();
      this.showNotification(
        `Image regeneration failed: ${error.message}`,
        "error",
      );
    }
  },


  async handleGenerateFourPrompts() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      return;
    }

    const imageApiBase = this.config.get("api.image.baseUrl");
    const imageApiKey = this.config.get("api.image.apiKey");

    if (!imageApiBase || !imageApiKey) {
      this.showNotification("Please configure image API settings first", "warning");
      return;
    }

    this.openImageOptionsModal();
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    if (modalTitle) modalTitle.innerHTML = "🖼️ Choose Styles for Variations";

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    const loadingText = loading.querySelector("p");
    if (loadingText) loadingText.textContent = "Generating style variations... this might take a minute.";

    loading.style.display = "none";

    // Grab options from main dropdown or fallback
    const mainStyleSelect = document.getElementById("image-style");
    let styleOptionsHtml = '';
    if (mainStyleSelect) {
      styleOptionsHtml = mainStyleSelect.innerHTML;
    } else {
      const styles = ["", "2.5d-realistic-anime", "realistic", "anime", "hand-drawn-anime", "painted-anime", "grunge-anime", "waifu", "comic", "cinematic", "fantasy", "cyberpunk", "3d-render", "watercolor", "pixel", "oil-painting", "concept-art", "sci-fi"];
      styleOptionsHtml = styles.map(s => `<option value="${s}">${s === "" ? 'Default / None' : s}</option>`).join('');
    }

    const mainMoodSelect = document.getElementById("image-mood");
    let moodOptionsHtml = '';
    if (mainMoodSelect) {
      moodOptionsHtml = mainMoodSelect.innerHTML;
    } else {
      const moods = ["", "bright-cheerful", "dark-gothic", "somber-melancholic", "romantic-soft", "energetic-dynamic", "mysterious-eerie", "sexy-seductive", "epic-heroic", "dreamy-ethereal", "gritty-cinematic"];
      moodOptionsHtml = moods.map(s => `<option value="${s}">${s === "" ? 'Default / None' : s}</option>`).join('');
    }

    grid.innerHTML = `
      <div style="grid-column: 1 / -1; display: flex; flex-direction: column; gap: 1.5rem; padding: 1.5rem; background: var(--surface-color); border-radius: 0.5rem; border: 1px solid var(--border);">
        <p style="margin: 0; color: var(--text-primary); font-weight: 500;">Select up to 4 styles and moods for your image variations:</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem;">
          <div style="display: flex; gap: 0.5rem;">
            <select id="style-choice-0" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              ${styleOptionsHtml}
            </select>
            <select id="mood-choice-0" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              ${moodOptionsHtml}
            </select>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <select id="style-choice-1" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              <option value="SKIP">-- Skip --</option>
              ${styleOptionsHtml}
            </select>
            <select id="mood-choice-1" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              ${moodOptionsHtml}
            </select>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <select id="style-choice-2" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              <option value="SKIP">-- Skip --</option>
              ${styleOptionsHtml}
            </select>
            <select id="mood-choice-2" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              ${moodOptionsHtml}
            </select>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <select id="style-choice-3" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              <option value="SKIP">-- Skip --</option>
              ${styleOptionsHtml}
            </select>
            <select id="mood-choice-3" class="content-box" style="flex: 1; padding: 0.5rem; color: var(--text-primary); background-color: var(--bg-color); border: 1px solid var(--border); border-radius: 0.25rem;">
              ${moodOptionsHtml}
            </select>
          </div>
        </div>
        <button id="start-generate-styles-btn" class="btn-primary" style="align-self: flex-start; padding: 0.5rem 2rem;">Generate Images</button>
      </div>
    `;

    // Initialize defaults
    const currentStyle = this.config.get("api.image.style");
    if (currentStyle !== undefined) {
      const firstSelect = document.getElementById("style-choice-0");
      if (firstSelect) firstSelect.value = currentStyle;
    }
    
    const currentMood = this.config.get("api.image.mood");
    if (currentMood !== undefined) {
      const firstMoodSelect = document.getElementById("mood-choice-0");
      if (firstMoodSelect) firstMoodSelect.value = currentMood;
    }

    // Set 1,2,3 to SKIP explicitly
    [1, 2, 3].forEach(i => {
        const sel = document.getElementById(`style-choice-${i}`);
        if (sel) sel.value = "SKIP";
    });

    const startBtn = document.getElementById("start-generate-styles-btn");
    startBtn.onclick = async () => {
      const selectedVariations = [0, 1, 2, 3]
        .map(i => ({
          style: document.getElementById(`style-choice-${i}`)?.value,
          mood: document.getElementById(`mood-choice-${i}`)?.value
        }))
        .filter(v => v.style !== undefined && v.style !== "SKIP");

      if (selectedVariations.length === 0) {
        this.showNotification("Please select at least one style.", "warning");
        return;
      }

      // Start Generation
      grid.innerHTML = "";
      loading.style.display = "block";
      if (modalTitle) modalTitle.innerHTML = "🖼️ Choose an Image Option";

      const model = this.config.get("api.image.model") || (this.config.get("api.image.models") || [])[0] || "";
      if (!model) {
        loading.style.display = "none";
        this.showNotification("No active image model selected", "warning");
        return;
      }

      try {
        const cardType = this.currentCharacter?.cardType || document.getElementById("card-type-select")?.value || "single";
        
        // Find if they selected the same style+mood multiple times to ensure we push for more variety
        const variationCounts = {};
        selectedVariations.forEach(v => {
          const key = `${v.style}-${v.mood}`;
          variationCounts[key] = (variationCounts[key] || 0) + 1;
        });

        // If the user already has a generated/typed prompt in the textarea, use it as guidance
        // so the LLM uses it as the core idea but rewrites it in the selected style
        const customPromptTextarea = document.getElementById("custom-image-prompt");
        const existingPrompt = customPromptTextarea?.value?.trim();

        const promises = selectedVariations.map(async (variation, index) => {
          const style = variation.style;
          const mood = variation.mood;
          const countKey = `${style}-${mood}`;
          
          try {
            let specificGuidance = this._getGuidance() || "";
            if (existingPrompt) {
              specificGuidance = `Base the image heavily on this idea: "${existingPrompt}"\n\n` + specificGuidance;
            }
            
            // If they selected the same variation multiple times, we need to force the LLM to give us variety
            if (variationCounts[countKey] > 1) {
                const variationHint = `This is variation ${index + 1}. Ensure the composition, pose, camera angle, or framing is distinctly unique compared to other variations.`;
                specificGuidance = specificGuidance ? `${specificGuidance}\n\n${variationHint}` : variationHint;
            }

            // 1. Generate a unique prompt for this specific style and variation
            const generatedPrompt = await window.apiHandler.generateImagePrompt(
              this.currentCharacter.description,
              this.currentCharacter.name,
              cardType,
              specificGuidance,
              style,
              mood
            );

            // 2. Generate the image using this unique prompt
            const imageUrl = await window.apiHandler.generateImage(
              this.currentCharacter.description,
              this.currentCharacter.name,
              generatedPrompt,
              model,
              cardType,
              style
            );

            let displayUrl = imageUrl;
            if (imageUrl && !imageUrl.startsWith("blob:") && !imageUrl.startsWith("data:")) {
              const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
              const response = await (window.authFetch || fetch)(proxyUrl);
              if (response.ok) {
                const blob = await response.blob();
                displayUrl = URL.createObjectURL(blob);
              }
            }
            let label = style === "" ? "Default" : style;
            if (mood !== "") label += ` / ${mood}`;
            return { url: displayUrl, prompt: generatedPrompt, model, label, index, styleUsed: style, moodUsed: mood };
          } catch (err) {
            console.error(`Variation "${style}" (mood: ${mood}) failed:`, err);
            return null;
          }
        });

        const results = await Promise.all(promises);
        loading.style.display = "none";

        const validResults = results.filter((r) => r !== null);
        if (validResults.length === 0) throw new Error("All image generations failed.");

        // Prepend current image for comparison
        const newBlobUrls4p = validResults.map(r => r.url);
        this._insertCurrentImageCard(grid, newBlobUrls4p);

        validResults.forEach((res) => {
          const wrapper = document.createElement("div");
          wrapper.style.cursor = "pointer";
          wrapper.style.border = "2px solid transparent";
          wrapper.style.borderRadius = "0.5rem";
          wrapper.style.overflow = "hidden";
          wrapper.style.transition = "border-color 0.2s";
          wrapper.style.backgroundColor = "var(--surface-color)";
          wrapper.onmouseenter = () => (wrapper.style.border = "2px solid var(--accent)");
          wrapper.onmouseleave = () => (wrapper.style.border = "2px solid transparent");
          
          wrapper.onclick = () => {
            const styleSelect = document.getElementById("image-style");
            if (styleSelect) styleSelect.value = res.styleUsed;
            const moodSelect = document.getElementById("image-mood");
            if (moodSelect) moodSelect.value = res.moodUsed;
            
            if (styleSelect || moodSelect) this.saveAPISettings(); // from CharacterGeneratorApp
            this.selectImageOption(res.url, res.prompt, res.model, validResults);
          };
          
          wrapper.innerHTML = `
            <img src="${res.url}" style="width:100%;height:auto;display:block;" alt="${res.label}">
            <div style="padding:0.5rem;text-align:center;font-size:0.8rem;color:var(--text-secondary);background:rgba(0,0,0,0.1);border-top:1px solid var(--border);font-family:monospace;">${res.label} · ${res.model}</div>
          `;
          grid.appendChild(wrapper);
        });

        // Wire gallery triggers
        const galleryImages4p = validResults.map(r => ({ url: r.url, prompt: r.prompt || "", model: r.model || "", label: r.label || `Option ${r.index + 1}` }));
        this._makeImageGalleryable(grid, galleryImages4p);

        this.openImageOptionsModal();
        this.showNotification(`Generated ${validResults.length} style variations!`, "success");
      } catch (error) {
        loading.style.display = "none";
        this.showNotification(`Failed to generate images: ${error.message}`, "error");
      }
    };
  },

  async handleFreeImage(service, model) {
    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      return;
    }

    this.openImageOptionsModal();
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    if (modalTitle) modalTitle.innerHTML = `🆓 Free Image — ${model}`;

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    const loadingText = loading.querySelector("p");
    if (loadingText) loadingText.textContent = `Generating via Pollinations.ai (${model})… this may take up to a minute.`;

    grid.innerHTML = "";
    loading.style.display = "block";

    try {
      // Reuse the existing prompt if one is in the textarea, otherwise generate via text API
      const customPromptTextarea = document.getElementById("custom-image-prompt");
      let imagePrompt = customPromptTextarea?.value?.trim();
      const cardType = this.currentCharacter?.cardType || document.getElementById("card-type-select")?.value || "single";
      if (!imagePrompt) {
        this.showNotification("Building image prompt…", "info");
        try {
          imagePrompt = await window.apiHandler.generateImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
            cardType,
            this._getGuidance(),
          );
          if (customPromptTextarea) {
            customPromptTextarea.value = imagePrompt;
            if (this.currentCharacter) this.currentCharacter.imagePrompt = imagePrompt;
            window.updatePromptCharCount();
          }
        } catch (e) {
          imagePrompt = window.apiHandler.buildDirectImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
        }
      }

      const blobUrl = await window.apiHandler.generateFreeImage(imagePrompt, service, model);

      loading.style.display = "none";

      // Show current image for comparison
      this._insertCurrentImageCard(grid, [blobUrl]);
      if (this.currentImageUrl) {
        const mt = document.querySelector("#image-options-modal .modal-title");
        if (mt) mt.innerHTML = `🆓 Compare & Choose — ${model}`;
      }

      const wrapper = document.createElement("div");
      wrapper.style.cssText = "cursor:pointer;border:2px solid transparent;border-radius:0.5rem;overflow:hidden;transition:border-color 0.2s;background:var(--surface-color);width:100%;position:relative;";
      wrapper.onmouseenter = () => (wrapper.style.border = "2px solid var(--accent)");
      wrapper.onmouseleave = () => (wrapper.style.border = "2px solid transparent");
      wrapper.onclick = () => this.selectImageOption(blobUrl, imagePrompt, `pollinations/${model}`, [{ url: blobUrl }]);

      wrapper.innerHTML = `
        <div style="position:absolute;top:0.5rem;left:0.5rem;background:var(--accent);color:#fff;font-size:0.7rem;font-weight:700;padding:0.2rem 0.55rem;border-radius:999px;z-index:1;letter-spacing:0.04em;">NEW</div>
        <img src="${blobUrl}" style="width: 100%; height: auto; display: block;" alt="Free generated image">
        <div style="padding: 1rem; text-align: center; background: rgba(0,0,0,0.1); border-top: 1px solid var(--border);">
          <button class="btn-primary" style="width: 100%;">Use New Image</button>
          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.4rem;">Pollinations.ai · ${model}</div>
        </div>
      `;
      grid.appendChild(wrapper);

      // Wire gallery trigger
      this._makeImageGalleryable(grid, [{ url: blobUrl, prompt: imagePrompt || "", model: `pollinations/${model}`, label: "Free" }]);

      this.openImageOptionsModal();
      this.showNotification("Free image generated! Compare and choose.", "success");
    } catch (error) {
      console.error("Free image error:", error);
      loading.style.display = "none";
      this.closeImageOptionsModal();
      this.showNotification(`Free image failed: ${error.message}`, "error");
    }
  },

  // Prepends a "Current Image" keep-card into the grid so the user can compare
  // newBlobUrls — blob URLs of the freshly generated images to revoke if user keeps current
  _insertCurrentImageCard(grid, newBlobUrls = []) {
    if (!this.currentImageUrl) return;
    const currentUrl = this.currentImageUrl;

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "cursor:pointer;border:2px solid var(--success);border-radius:0.5rem;overflow:hidden;transition:box-shadow 0.2s;background:var(--surface-color);position:relative;";
    wrapper.onmouseenter = () => { wrapper.style.boxShadow = "0 0 0 4px rgba(31,157,102,0.22)"; };
    wrapper.onmouseleave = () => { wrapper.style.boxShadow = ""; };
    wrapper.onclick = () => {
      // Archive the new generated images rather than discarding them
      newBlobUrls.forEach(url => {
        if (url && url !== currentUrl) this._addToHistory(url);
      });
      this.closeImageOptionsModal();
      this.showNotification("Keeping current image.", "info");
    };
    wrapper.innerHTML = `
      <div style="position:absolute;top:0.5rem;left:0.5rem;background:var(--success);color:#fff;font-size:0.7rem;font-weight:700;padding:0.2rem 0.55rem;border-radius:999px;z-index:1;letter-spacing:0.04em;">CURRENT</div>
      <img src="${currentUrl}" style="width:100%;height:auto;display:block;" alt="Current image">
      <div style="padding:0.75rem;text-align:center;background:rgba(31,157,102,0.08);border-top:1px solid var(--border);">
        <button class="btn-outline" style="width:100%;border-color:var(--success);color:var(--success);">✓ Keep This</button>
      </div>
    `;
    grid.insertBefore(wrapper, grid.firstChild);
  },

  openImageOptionsModal() {
    const modal = document.getElementById("image-options-modal");
    if (modal) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
    }
  },

  closeImageOptionsModal() {
    const modal = document.getElementById("image-options-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  },

  async selectImageOption(selectedUrl, selectedPrompt, selectedModel, allResults) {
    this.closeImageOptionsModal();

    // Archive the image being replaced
    if (this.currentImageUrl && this.currentImageUrl !== selectedUrl) {
      this._archiveCurrentImage();
    }

    this.currentImageUrl = selectedUrl;

    // Archive all other generated images that weren't chosen
    if (Array.isArray(allResults)) {
      allResults.forEach((res) => {
        if (res && res.url && res.url !== selectedUrl) {
          this._addToHistory(res.url);
        }
      });
    }

    const imageContainer = document.getElementById("image-content");
    if (imageContainer) {
      imageContainer.innerHTML =
        window.imageGenerator.formatImageForDisplay(selectedUrl);
    }

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    if (customPromptTextarea) {
      customPromptTextarea.value = selectedPrompt;
      window.updatePromptCharCount();
    }

    const activeImageModelSelect = document.getElementById("active-image-model");
    if (activeImageModelSelect) {
      activeImageModelSelect.value = selectedModel;
      this.config.set("api.image.model", selectedModel);
    }

    this.showNotification("Image selected and saved to card!", "success");

    await this.saveCardToLibrary();
    await this.refreshLibraryViews();
  },

  async handleRegeneratePrompt() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      return;
    }

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    const promptEditor = document.getElementById("image-prompt-editor");
    const regeneratePromptBtn = document.getElementById("draft-prompt-btn");

    if (!customPromptTextarea || !promptEditor) {
      this.showNotification("Prompt editor not found", "error");
      return;
    }

    if (regeneratePromptBtn) {
      regeneratePromptBtn.disabled = true;
      regeneratePromptBtn.textContent = "⏳...";
    }

    try {
      this.showNotification("Regenerating image prompt...", "info");
      const newPrompt = await window.apiHandler.generateImagePrompt(
        this.currentCharacter.description,
        this.currentCharacter.name,
        "single",
        this._getGuidance(),
      );
      customPromptTextarea.value = newPrompt;
      if (this.currentCharacter) this.currentCharacter.imagePrompt = newPrompt;
      window.updatePromptCharCount();
      this.showNotification("Image prompt regenerated!", "success");
    } catch (error) {
      console.error("Failed to regenerate image prompt:", error);
      const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
        this.currentCharacter.description,
        this.currentCharacter.name,
      );
      customPromptTextarea.value = fallbackPrompt;
      if (this.currentCharacter) this.currentCharacter.imagePrompt = fallbackPrompt;
      window.updatePromptCharCount();
      this.showNotification("Using fallback prompt generation", "warning");
    } finally {
      if (regeneratePromptBtn) {
        regeneratePromptBtn.disabled = false;
        regeneratePromptBtn.textContent = "📝 Draft Prompt";
      }
    }

    promptEditor.style.display = "block";
  },

  async handleImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await this.processUploadedImageFile(file);
    } finally {
      if (event.target) event.target.value = "";
    }
  },

  async processUploadedImageFile(file) {
    if (!file) return;

    if (!this.currentCharacter) {
      this.showNotification("Please generate or select a character first", "warning");
      return;
    }

    try {
      if (!file.type.startsWith("image/")) {
        throw new Error("Please select or paste a valid image file (PNG, JPG, WebP)");
      }

      if (this.currentImageUrl) {
        this._archiveCurrentImage();
      }

      this.currentImageUrl = URL.createObjectURL(file);

      const imageContainer = document.getElementById("image-content");
      if (imageContainer) {
        imageContainer.innerHTML = `
          <div class="image-container">
            <img src="${this.currentImageUrl}" alt="${this.currentCharacter.name || 'Character'}" class="generated-image">
          </div>
        `;
      }

      this.showNotification("Character image updated successfully!", "success");
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
    } catch (error) {
      console.error("Image upload error:", error);
      this.showNotification(`Image upload failed: ${error.message}`, "error");
    }
  },

  // ═══ PORTRAIT UPLOAD & PASTE MODAL METHODS ═══
  openPortraitUploadModal() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate or select a character first", "warning");
      return;
    }

    const modal = document.getElementById("image-upload-modal");
    if (!modal) return;

    this.pendingPortraitFile = null;
    this.resetPortraitModalPreview();

    modal.classList.add("show");
    document.body.style.overflow = "hidden";
  },

  closePortraitUploadModal() {
    const modal = document.getElementById("image-upload-modal");
    if (modal) modal.classList.remove("show");
    document.body.style.overflow = "";
    this.pendingPortraitFile = null;
  },

  resetPortraitModalPreview() {
    const dropPrompt = document.getElementById("portrait-drop-prompt");
    const previewWrap = document.getElementById("portrait-modal-preview-wrap");
    const submitBtn = document.getElementById("portrait-modal-submit-btn");
    const fileInput = document.getElementById("portrait-modal-file-input");

    if (dropPrompt) dropPrompt.style.display = "flex";
    if (previewWrap) previewWrap.style.display = "none";
    if (submitBtn) submitBtn.disabled = true;
    if (fileInput) fileInput.value = "";
    this.pendingPortraitFile = null;
  },

  setPortraitModalPreview(file) {
    if (!file || !file.type.startsWith("image/")) {
      this.showNotification("Please select or paste a valid image file", "warning");
      return;
    }

    this.pendingPortraitFile = file;

    const dropPrompt = document.getElementById("portrait-drop-prompt");
    const previewWrap = document.getElementById("portrait-modal-preview-wrap");
    const previewImg = document.getElementById("portrait-modal-preview-img");
    const fileInfo = document.getElementById("portrait-modal-file-info");
    const submitBtn = document.getElementById("portrait-modal-submit-btn");

    if (previewImg) {
      previewImg.src = URL.createObjectURL(file);
    }
    if (fileInfo) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      fileInfo.textContent = `${file.name || 'Pasted Clipboard Image'} (${sizeMb} MB)`;
    }

    if (dropPrompt) dropPrompt.style.display = "none";
    if (previewWrap) previewWrap.style.display = "flex";
    if (submitBtn) submitBtn.disabled = false;
  },

  async applyPortraitModalImage() {
    if (!this.pendingPortraitFile) return;
    const fileToApply = this.pendingPortraitFile;
    this.closePortraitUploadModal();
    await this.processUploadedImageFile(fileToApply);
  },

  initPortraitUploadModalEvents() {
    const modal = document.getElementById("image-upload-modal");
    if (!modal) return;

    const closeBtn = document.getElementById("image-upload-modal-close");
    const cancelBtn = document.getElementById("portrait-modal-cancel-btn");
    const submitBtn = document.getElementById("portrait-modal-submit-btn");
    const browseBtn = document.getElementById("portrait-modal-browse-btn");
    const changeBtn = document.getElementById("portrait-modal-change-btn");
    const fileInput = document.getElementById("portrait-modal-file-input");
    const dropZone = document.getElementById("portrait-drop-zone");

    if (closeBtn) closeBtn.addEventListener("click", () => this.closePortraitUploadModal());
    if (cancelBtn) cancelBtn.addEventListener("click", () => this.closePortraitUploadModal());
    if (submitBtn) submitBtn.addEventListener("click", () => this.applyPortraitModalImage());
    
    if (browseBtn) browseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      fileInput?.click();
    });
    if (changeBtn) changeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resetPortraitModalPreview();
      fileInput?.click();
    });
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (file) this.setPortraitModalPreview(file);
      });
    }

    if (dropZone) {
      dropZone.addEventListener("click", (e) => {
        if (!this.pendingPortraitFile && e.target !== browseBtn && e.target !== changeBtn) {
          fileInput?.click();
        }
      });
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        const file = e.dataTransfer?.files?.[0];
        if (file) this.setPortraitModalPreview(file);
      });
    }

    // Modal-scoped clipboard paste listener
    document.addEventListener("paste", (e) => {
      if (!modal.classList.contains("show")) return;
      if (!e.clipboardData || !e.clipboardData.files.length) return;

      const file = e.clipboardData.files[0];
      if (!file.type.startsWith("image/")) return;

      e.preventDefault();
      e.stopPropagation();
      this.setPortraitModalPreview(file);
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) this.closePortraitUploadModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("show")) {
        this.closePortraitUploadModal();
      }
    });
  },

  async handleReferenceImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    await this.processReferenceImageFile(file);
    if (event.target) event.target.value = "";
  },

  async handleReferenceImagePaste(event) {
    // Prevent cross-over: ignore paste if portrait modal or API modal is open
    const portraitModal = document.getElementById("image-upload-modal");
    if (portraitModal && portraitModal.classList.contains("show")) return;

    const apiModal = document.getElementById("api-settings-modal");
    if (apiModal && apiModal.classList.contains("show")) return;

    // Ignore if any other modal is active
    const activeModal = document.querySelector(".modal-overlay.show");
    if (activeModal) return;

    // Ignore if paste target is customImageStyleInput or another focused input
    if (event.target && event.target.id === "custom-image-style-input") return;

    // Ensure we are on main generator tab or target is inside reference image group
    const activeTab = document.querySelector(".tab-content:not([style*='display: none'])");
    if (activeTab && activeTab.id !== "view-generator" && activeTab.id !== "view-create") {
      const refGroup = document.getElementById("reference-image-file")?.closest(".form-group");
      if (!refGroup || !refGroup.contains(event.target)) return;
    }

    if (!event.clipboardData || !event.clipboardData.files.length) return;
    
    const file = event.clipboardData.files[0];
    if (!file.type.startsWith("image/")) return;

    event.preventDefault();
    await this.processReferenceImageFile(file);
  },

  async processReferenceImageFile(file) {
    try {
      this.imageGenerator.validateImageFile(file);

      const dataUrl = await this.prepareReferenceImageForVision(file);

      this.referenceImageDataUrl = dataUrl;
      this.updateReferenceImagePreview(dataUrl);

      const descriptionField = document.getElementById(
        "reference-image-description",
      );
      const hint = descriptionField?.value?.trim() || "";

      this.showNotification("Analyzing reference image...", "info");
      const imageDescription = await this.apiHandler.describeReferenceImage(
        dataUrl,
        hint,
      );
      if (descriptionField) {
        descriptionField.value = imageDescription;
      }
      this.showNotification("Reference image description generated", "success");
    } catch (error) {
      console.error("Reference image handling failed:", error);
      this.showNotification(
        `Reference image analysis failed: ${error.message}`,
        "warning",
      );
    }
  },

  async prepareReferenceImageForVision(file) {
    const sourceDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () =>
        reject(new Error("Failed to read reference image file"));
      reader.readAsDataURL(file);
    });

    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to process image"));
      image.src = sourceDataUrl;
    });

    const maxSide = 1024;
    const ratio = Math.min(maxSide / img.width, maxSide / img.height, 1);
    const targetWidth = Math.max(1, Math.round(img.width * ratio));
    const targetHeight = Math.max(1, Math.round(img.height * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    return canvas.toDataURL("image/jpeg", 0.82);
  },

  updateReferenceImagePreview(dataUrl) {
    const preview = document.getElementById("reference-image-preview");
    if (!preview) return;

    preview.style.display = "block";
    preview.innerHTML = `<img src="${dataUrl}" alt="Reference image" style="width: 100%; display: block;" />`;
  },

  async handleFetchImageModels() {
    const statusEl = document.getElementById("fetch-models-status");
    const container = document.getElementById("image-models-container");

    if (!statusEl || !container) return;

    statusEl.textContent = "Fetching...";
    statusEl.style.color = "var(--text-secondary)";

    try {
      this.config.loadFromForm();
      const models = await this.apiHandler.fetchModels("image");

      if (models && models.length > 0) {
        const currentSelected = new Set(
          this.config.get("api.image.models") || [],
        );

        container.innerHTML = models
          .map(
            (m) => `
              <div class="image-model-row" style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;">
                <label style="display:flex;align-items:center;gap:0.5rem;flex:1;cursor:pointer;">
                  <input type="checkbox" class="image-model-checkbox" value="${escapeHtml(m.id)}" ${currentSelected.has(m.id) ? "checked" : ""}>
                  ${escapeHtml(m.id)}
                </label>
                <button type="button" class="image-model-delete-btn" data-model="${escapeHtml(m.id)}" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>
              </div>
          `,
          )
          .join("");

        const searchInput = document.getElementById("image-model-search");
        if (searchInput) searchInput.style.display = "block";

        statusEl.textContent = `Found ${models.length} models`;
        statusEl.style.color = "var(--success)";
        this.updateActiveModelsDropdown();
      } else {
        container.innerHTML =
          '<p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0;">No models returned from API.</p>';
        statusEl.textContent = "No models found";
        statusEl.style.color = "var(--warning)";
      }
    } catch (error) {
      statusEl.textContent = "Failed to fetch";
      statusEl.style.color = "var(--error)";
      container.innerHTML = `<p style="font-size: 0.8rem; color: var(--error); margin: 0;">Error: ${escapeHtml(error.message)}</p>`;
    }
  },

  updateActiveModelsDropdown() {
    const select = document.getElementById("active-image-model");
    if (!select) return;

    const models = this.config.get("api.image.models") || [];
    const currentModel = this.config.get("api.image.model") || "";

    if (models.length === 0) {
      select.innerHTML = '<option value="">Default Model</option>';
      if (currentModel && !models.includes(currentModel)) {
        select.innerHTML += `<option value="${currentModel}" selected>${currentModel}</option>`;
      }
    } else {
      select.innerHTML = models
        .map(
          (model) =>
            `<option value="${escapeHtml(model)}" ${model === currentModel ? "selected" : ""}>${escapeHtml(model)}</option>`,
        )
        .join("");

      if (!models.includes(currentModel) && models.length > 0) {
        this.config.set("api.image.model", models[0]);
        select.value = models[0];
      }
    }
  },

  // ── History helpers ────────────────────────────────────────────────────────

  // Single entry-point for adding a URL to the in-memory archive.
  // Deduplicates, enforces the 20-item cap, and refreshes the button.
  _addToHistory(url) {
    if (!url) return;
    if (!this.imageHistoryUrls) this.imageHistoryUrls = [];
    if (this.imageHistoryUrls.includes(url)) return; // already there
    this.imageHistoryUrls.push(url);
    if (this.imageHistoryUrls.length > 20) {
      const oldest = this.imageHistoryUrls.shift();
      if (oldest && oldest.startsWith("blob:")) URL.revokeObjectURL(oldest);
    }
    this.updateImageHistoryButton();
  },

  // Archive the current card image (called before replacing it with a new one).
  _archiveCurrentImage() {
    if (this.currentImageUrl) {
      this._addToHistory(this.currentImageUrl);
    }
  },

  updateImageHistoryButton() {
    const btn = document.getElementById("image-history-btn");
    if (btn) {
      const count = this.imageHistoryUrls ? this.imageHistoryUrls.length : 0;
      if (count > 0) {
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.textContent = `🕰️ History (${count})`;
      } else {
        btn.style.display = "none";
      }
    }
    if (typeof this.updateCropButtonVisibility === "function") {
      this.updateCropButtonVisibility();
    }
  },

  showImageHistory() {
    if (!this.imageHistoryUrls || this.imageHistoryUrls.length === 0) {
      this.showNotification("No image history available for this card.", "info");
      return;
    }
    this.openImageOptionsModal();
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    if (modalTitle) modalTitle.innerHTML = "🕰️ Image History (Compare & Choose)";

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    if (loading) loading.style.display = "none";
    grid.innerHTML = "";

    const validResults = this.imageHistoryUrls.map((url, i) => ({ url, label: `Archived Image ${i + 1}` }));

    this._insertCurrentImageCard(grid, []);

    validResults.forEach((res, index) => {
      const wrapper = document.createElement("div");
      wrapper.style.cursor = "pointer";
      wrapper.style.border = "2px solid transparent";
      wrapper.style.borderRadius = "0.5rem";
      wrapper.style.overflow = "hidden";
      wrapper.style.transition = "border-color 0.2s";
      wrapper.style.backgroundColor = "var(--surface-color)";
      wrapper.style.position = "relative";
      wrapper.onmouseenter = () => (wrapper.style.border = "2px solid var(--accent)");
      wrapper.onmouseleave = () => (wrapper.style.border = "2px solid transparent");
      wrapper.onclick = () => this.restoreImageFromHistory(res.url, index);
      
      wrapper.innerHTML = `
        <div style="position:absolute;top:0.5rem;left:0.5rem;background:var(--bg-color);color:var(--text-primary);font-size:0.7rem;font-weight:700;padding:0.2rem 0.55rem;border-radius:999px;z-index:1;border:1px solid var(--border);">ARCHIVE</div>
        <img src="${res.url}" style="width:100%;height:auto;display:block;" alt="${res.label}">
        <div style="padding:1rem;text-align:center;background:rgba(0,0,0,0.1);border-top:1px solid var(--border);">
          <button class="btn-primary" style="width:100%;">Restore Image</button>
        </div>
      `;
      grid.appendChild(wrapper);
    });

    this._makeImageGalleryable(grid, validResults.map(r => ({ url: r.url, label: r.label })));
  },

  async restoreImageFromHistory(selectedUrl, historyIndex) {
    this.closeImageOptionsModal();

    // Swap: put current image back into history at the same slot, remove restored one
    if (!this.imageHistoryUrls) this.imageHistoryUrls = [];
    if (this.currentImageUrl) {
      this.imageHistoryUrls[historyIndex] = this.currentImageUrl;
    } else {
      this.imageHistoryUrls.splice(historyIndex, 1);
    }

    this.currentImageUrl = selectedUrl;

    const imageContainer = document.getElementById("image-content");
    if (imageContainer) {
      imageContainer.innerHTML = window.imageGenerator?.formatImageForDisplay 
        ? window.imageGenerator.formatImageForDisplay(selectedUrl)
        : `<div class="image-container"><img src="${selectedUrl}" alt="Restored Image" class="generated-image"></div>`;
    }

    this.showNotification("Image restored from history!", "success");
    this.updateImageHistoryButton();

    await this.saveCardToLibrary();
    await this.refreshLibraryViews();
  },

  async handleStyleImageFile(file) {
    try {
      const extractBtn = document.getElementById("extract-style-btn");
      if (extractBtn) extractBtn.textContent = "⏳...";

      this.imageGenerator.validateImageFile(file);
      const dataUrl = await this.prepareReferenceImageForVision(file);

      this.showNotification("Analyzing style from image...", "info");
      const styleDescription = await this.apiHandler.extractStyleFromImage(dataUrl);

      const customStyleInput = document.getElementById("custom-image-style-input");
      if (customStyleInput) {
          customStyleInput.value = styleDescription;
          this.saveAPISettings();
      }

      this.showNotification("Style extracted successfully!", "success");
    } catch (error) {
      console.error("Style extraction failed:", error);
      this.showNotification(`Style extraction failed: ${error.message}`, "error");
    } finally {
      const extractBtn = document.getElementById("extract-style-btn");
      if (extractBtn) extractBtn.textContent = "🖼️ Extract";
    }
  }

});

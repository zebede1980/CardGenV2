// Image Handling Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  async generateImage() {
    const imageContainer = document.getElementById("image-content");

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    const customPrompt = customPromptTextarea?.value?.trim();
    const referenceImageDescription = document
      .getElementById("reference-image-description")
      ?.value?.trim();

    window.updatePromptCharCount();

    if (this.currentImageUrl && this.currentImageUrl.startsWith("blob:")) {
      console.log("🗑️ Revoking previous blob URL:", this.currentImageUrl);
      URL.revokeObjectURL(this.currentImageUrl);
    }

    const imageDescriptionInput = referenceImageDescription
      ? `${this.currentCharacter.description}\n\nReference image details:\n${referenceImageDescription}`
      : this.currentCharacter.description;
    const promptFromReference = referenceImageDescription
      ? `Character portrait of ${this.currentCharacter.name || "the character"}, based on this reference description: ${referenceImageDescription}. High quality, detailed features, cinematic lighting, coherent anatomy, expressive face, fitting background.`
      : "";
    const effectivePrompt = customPrompt || promptFromReference || null;

    const imageResult = await this.imageGenerator.generateAndDisplayImage(
      imageDescriptionInput,
      this.currentCharacter.name,
      imageContainer,
      effectivePrompt,
    );

    this.currentImageUrl = imageResult.url || imageResult;

    if (
      !customPrompt &&
      customPromptTextarea &&
      window.apiHandler.lastGeneratedImagePrompt
    ) {
      customPromptTextarea.value = window.apiHandler.lastGeneratedImagePrompt;
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

    if (promptEditor && customPromptTextarea) {
      if (!customPromptTextarea.value.trim()) {
        try {
          this.showNotification("Generating image prompt...", "info");
          const defaultPrompt = await window.apiHandler.generateImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
          customPromptTextarea.value = defaultPrompt;
          window.updatePromptCharCount();
        } catch (error) {
          console.error("Failed to generate image prompt:", error);
          const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
          customPromptTextarea.value = fallbackPrompt;
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

      const promptFromReference = referenceImageDescription
        ? `Character portrait of ${this.currentCharacter.name || "the character"}, based on this reference description: ${referenceImageDescription}. High quality, detailed features, cinematic lighting, coherent anatomy, expressive face, fitting background.`
        : "";

      const effectivePrompt = customPrompt || promptFromReference || null;

      const model = this.config.get("api.image.model") || "";

      const imageUrl = await window.apiHandler.generateImage(
        imageDescriptionInput,
        this.currentCharacter.name,
        effectivePrompt,
        model,
      );

      let displayUrl = imageUrl;
      if (
        imageUrl &&
        !imageUrl.startsWith("blob:") &&
        !imageUrl.startsWith("data:")
      ) {
        const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
        const response = await fetch(proxyUrl);
        if (response.ok) {
          const blob = await response.blob();
          displayUrl = URL.createObjectURL(blob);
        }
      }

      loading.style.display = "none";

      const wrapper = document.createElement("div");
      wrapper.style.cursor = "pointer";
      wrapper.style.border = "2px solid transparent";
      wrapper.style.borderRadius = "0.5rem";
      wrapper.style.overflow = "hidden";
      wrapper.style.transition = "border-color 0.2s";
      wrapper.style.backgroundColor = "var(--surface-color)";
      wrapper.style.maxWidth = "400px";
      wrapper.style.margin = "0 auto";

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
        <img src="${displayUrl}" style="width: 100%; height: auto; display: block;" alt="Generated Image">
        <div style="padding: 1rem; text-align: center; background: rgba(0,0,0,0.1); border-top: 1px solid var(--border);">
            <button class="btn-primary" style="width: 100%;">Accept Image</button>
        </div>
      `;
      grid.appendChild(wrapper);

      this.showNotification(`Image generated! Review and accept.`, "success");
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

  async handleGenerateFourImages() {
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

    this.openImageOptionsModal();
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    if (modalTitle) modalTitle.innerHTML = "🖼️ Choose an Image Option";

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");

    const loadingText = loading.querySelector("p");
    if (loadingText)
      loadingText.textContent =
        "Generating 4 images... this might take a minute.";

    grid.innerHTML = "";
    loading.style.display = "block";

    try {
      const customPromptTextarea = document.getElementById("custom-image-prompt");
      let basePrompt = customPromptTextarea?.value?.trim();

      if (!basePrompt) {
        try {
          basePrompt = await window.apiHandler.generateImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
          if (customPromptTextarea) {
            customPromptTextarea.value = basePrompt;
            window.updatePromptCharCount();
          }
        } catch (e) {
          basePrompt = window.apiHandler.buildDirectImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
        }
      }

      // Use checked models from the config list; fall back to defaults if none saved
      let savedModels = this.config.get("api.image.models") || [];
      if (savedModels.length === 0) {
        savedModels = ["z-image-turbo", "chroma", "hidream", "qwen-image"];
      }
      // Build exactly 4 slots: take first 4 if ≥4, otherwise loop/repeat
      const models = Array.from({ length: 4 }, (_, i) => savedModels[i % savedModels.length]);

      const promises = models.map((modelName, index) =>
        window.apiHandler
          .generateImage(
            this.currentCharacter.description,
            this.currentCharacter.name,
            basePrompt,
            modelName,
          )
          .then(async (imageUrl) => {
            let displayUrl = imageUrl;
            if (
              imageUrl &&
              !imageUrl.startsWith("blob:") &&
              !imageUrl.startsWith("data:")
            ) {
              const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
              const response = await fetch(proxyUrl);
              if (response.ok) {
                const blob = await response.blob();
                displayUrl = URL.createObjectURL(blob);
              }
            }
            return { url: displayUrl, prompt: basePrompt, model: modelName, index };
          })
          .catch((err) => {
            console.error(`Image generation with ${modelName} failed:`, err);
            return null;
          }),
      );

      const results = await Promise.all(promises);
      loading.style.display = "none";

      const validResults = results.filter((r) => r !== null);
      if (validResults.length === 0) {
        throw new Error("All image generations failed.");
      }

      validResults.forEach((res) => {
        const wrapper = document.createElement("div");
        wrapper.style.cursor = "pointer";
        wrapper.style.border = "2px solid transparent";
        wrapper.style.borderRadius = "0.5rem";
        wrapper.style.overflow = "hidden";
        wrapper.style.transition = "border-color 0.2s";
        wrapper.style.backgroundColor = "var(--surface-color)";

        wrapper.onmouseenter = () =>
          (wrapper.style.border = "2px solid var(--accent)");
        wrapper.onmouseleave = () =>
          (wrapper.style.border = "2px solid transparent");

        wrapper.onclick = () =>
          this.selectImageOption(res.url, res.prompt, res.model, validResults);

        wrapper.innerHTML = `
          <img src="${res.url}" style="width: 100%; height: auto; display: block;" alt="Option ${res.index + 1}">
          <div style="padding: 0.5rem; text-align: center; font-size: 0.8rem; color: var(--text-secondary); background: rgba(0,0,0,0.1); border-top: 1px solid var(--border); font-family: monospace;">${res.model}</div>
        `;
        grid.appendChild(wrapper);
      });
      this.showNotification(
        `Generated ${validResults.length} image options!`,
        "success",
      );
    } catch (error) {
      loading.style.display = "none";
      this.showNotification(
        `Failed to generate images: ${error.message}`,
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
    if (modalTitle) modalTitle.innerHTML = "🖼️ Choose an Image Option";

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    const loadingText = loading.querySelector("p");
    if (loadingText) loadingText.textContent = "Generating 4 prompt variations... this might take a minute.";

    grid.innerHTML = "";
    loading.style.display = "block";

    const model = this.config.get("api.image.model") || (this.config.get("api.image.models") || [])[0] || "";
    if (!model) {
      loading.style.display = "none";
      this.showNotification("No active image model selected", "warning");
      return;
    }

    try {
      // Get or generate the base prompt
      const customPromptTextarea = document.getElementById("custom-image-prompt");
      let basePrompt = customPromptTextarea?.value?.trim();
      if (!basePrompt) {
        try {
          basePrompt = await window.apiHandler.generateImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
          if (customPromptTextarea) {
            customPromptTextarea.value = basePrompt;
            window.updatePromptCharCount();
          }
        } catch (e) {
          basePrompt = window.apiHandler.buildDirectImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
        }
      }

      // Four distinct framing variations on the same base prompt
      const variations = [
        { suffix: "", label: "Default" },
        { suffix: ", close-up portrait, face and shoulders, detailed facial features", label: "Close-up" },
        { suffix: ", full body shot, dynamic pose, showing complete outfit and stature", label: "Full body" },
        { suffix: ", cinematic composition, dramatic lighting, environmental storytelling", label: "Cinematic" },
      ];

      const promises = variations.map(({ suffix, label }, index) => {
        const prompt = basePrompt + suffix;
        return window.apiHandler
          .generateImage(
            this.currentCharacter.description,
            this.currentCharacter.name,
            prompt,
            model,
          )
          .then(async (imageUrl) => {
            let displayUrl = imageUrl;
            if (imageUrl && !imageUrl.startsWith("blob:") && !imageUrl.startsWith("data:")) {
              const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
              const response = await fetch(proxyUrl);
              if (response.ok) {
                const blob = await response.blob();
                displayUrl = URL.createObjectURL(blob);
              }
            }
            return { url: displayUrl, prompt, model, label, index };
          })
          .catch((err) => {
            console.error(`Variation "${label}" failed:`, err);
            return null;
          });
      });

      const results = await Promise.all(promises);
      loading.style.display = "none";

      const validResults = results.filter((r) => r !== null);
      if (validResults.length === 0) throw new Error("All image generations failed.");

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
        wrapper.onclick = () => this.selectImageOption(res.url, res.prompt, res.model, validResults);
        wrapper.innerHTML = `
          <img src="${res.url}" style="width:100%;height:auto;display:block;" alt="${res.label}">
          <div style="padding:0.5rem;text-align:center;font-size:0.8rem;color:var(--text-secondary);background:rgba(0,0,0,0.1);border-top:1px solid var(--border);font-family:monospace;">${res.label} · ${res.model}</div>
        `;
        grid.appendChild(wrapper);
      });

      this.showNotification(`Generated ${validResults.length} prompt variations!`, "success");
    } catch (error) {
      loading.style.display = "none";
      this.showNotification(`Failed to generate images: ${error.message}`, "error");
    }
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

    if (
      this.currentImageUrl &&
      this.currentImageUrl.startsWith("blob:") &&
      this.currentImageUrl !== selectedUrl
    ) {
      URL.revokeObjectURL(this.currentImageUrl);
    }

    this.currentImageUrl = selectedUrl;

    allResults.forEach((res) => {
      if (res.url !== selectedUrl && res.url.startsWith("blob:")) {
        URL.revokeObjectURL(res.url);
      }
    });

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
    const regeneratePromptBtn = document.getElementById("regenerate-prompt-btn");

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
      );
      customPromptTextarea.value = newPrompt;
      window.updatePromptCharCount();
      this.showNotification("Image prompt regenerated!", "success");
    } catch (error) {
      console.error("Failed to regenerate image prompt:", error);
      const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
        this.currentCharacter.description,
        this.currentCharacter.name,
      );
      customPromptTextarea.value = fallbackPrompt;
      window.updatePromptCharCount();
      this.showNotification("Using fallback prompt generation", "warning");
    } finally {
      if (regeneratePromptBtn) {
        regeneratePromptBtn.disabled = false;
        regeneratePromptBtn.textContent = "💡 Prompt";
      }
    }

    promptEditor.style.display = "block";
  },

  async handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      event.target.value = "";
      return;
    }

    try {
      if (!file.type.startsWith("image/")) {
        throw new Error("Please select an image file");
      }

      if (this.currentImageUrl && this.currentImageUrl.startsWith("blob:")) {
        URL.revokeObjectURL(this.currentImageUrl);
      }

      this.currentImageUrl = URL.createObjectURL(file);

      const imageContainer = document.getElementById("image-content");
      imageContainer.innerHTML = `
        <div class="image-container">
          <img src="${this.currentImageUrl}" alt="${this.currentCharacter.name}" class="generated-image">
        </div>
      `;

      this.showNotification("Image uploaded successfully!", "success");
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
    } catch (error) {
      console.error("Image upload error:", error);
      this.showNotification(`Image upload failed: ${error.message}`, "error");
    } finally {
      event.target.value = "";
    }
  },

  async handleReferenceImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

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
    } finally {
      event.target.value = "";
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
                  <input type="checkbox" class="image-model-checkbox" value="${m.id}" ${currentSelected.has(m.id) ? "checked" : ""}>
                  ${m.id}
                </label>
                <button type="button" class="image-model-delete-btn" data-model="${m.id}" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>
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
      container.innerHTML = `<p style="font-size: 0.8rem; color: var(--error); margin: 0;">Error: ${error.message}</p>`;
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
            `<option value="${model}" ${model === currentModel ? "selected" : ""}>${model}</option>`,
        )
        .join("");

      if (!models.includes(currentModel) && models.length > 0) {
        this.config.set("api.image.model", models[0]);
        select.value = models[0];
      }
    }
  },

});

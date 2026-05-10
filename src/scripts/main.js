// Main Application Controller
// Core class definition only — feature modules are loaded separately:
//   app-ui.js             — UI helpers (notifications, stream, state buttons)
//   character-display.js  — display, edit, reset, regenerate fields, import
//   image-handler.js      — image generate/upload/select, reference image, model fetch
//   lorebook-handler.js   — lorebook CRUD, download, upload
//   alt-greetings-handler.js — alternate greetings CRUD
//   library-handler.js    — IndexedDB save/load/delete for prompts & cards
//   revision-handler.js   — AI revision, token reduction, consistency check
class CharacterGeneratorApp {
  constructor() {
    this.characterGenerator = window.characterGenerator;
    this.imageGenerator = window.imageGenerator;
    this.pngEncoder = window.pngEncoder;
    this.lorebookGenerator = window.lorebookGenerator;
    this.config = window.config;
    this.apiHandler = window.apiHandler;
    this.storage = window.characterStorage;
    this.storageReady = false;

    this.currentCharacter = null;
    this.originalCharacter = null;
    this.currentImageUrl = null;
    this.lorebookEntries = [];
    this.altGreetings = [];
    this.lorebookData = null;
    this.referenceImageDataUrl = "";
    this.isGenerating = false;
    this.isRevising = false;
    this.lastConsistencyReport = null;

    this.init();
  }

  async init() {
    const savedConfig = localStorage.getItem("charGeneratorConfig");
    if (savedConfig && (savedConfig.includes('"api":{"baseUrl"') || savedConfig.includes('"textModel"'))) {
      localStorage.removeItem("charGeneratorConfig");
    }
    await this.config.waitForConfig();
    await this.ensureStorageReady();
    this.config.saveToForm();
    this.bindEvents();
    this.checkAPIStatus();
    this.refreshLibraryViews();
  }

  async ensureStorageReady() {
    if (!this.storage) {
      this.storageReady = false;
      this.updateLibraryStatus("Local library unavailable in this session.");
      return;
    }
    try {
      await this.storage.init();
      this.storageReady = true;
      this.updateLibraryStatus("Local library ready.");
    } catch (error) {
      console.error("Failed to initialize IndexedDB:", error);
      this.storageReady = false;
      this.updateLibraryStatus("IndexedDB failed to initialize. Prompt/card saving is disabled.");
    }
  }

  bindEvents() {
    document.getElementById("generate-btn").addEventListener("click", () => this.handleGenerate());
    document.getElementById("stop-btn").addEventListener("click", () => this.handleStop());
    document.getElementById("download-btn").addEventListener("click", () => this.handleDownload());

    const saveCardBtn = document.getElementById("save-card-btn");
    if (saveCardBtn) saveCardBtn.addEventListener("click", () => this.handleSaveCardManual());

    // Import card buttons
    const importCardBtn = document.getElementById("import-card-btn");
    const importCardTopBtn = document.getElementById("import-card-top-btn");
    const importCardInput = document.getElementById("import-card-input");
    const importCardTopInput = document.getElementById("import-card-top-input");
    if (importCardInput || importCardTopInput) {
      if (importCardBtn) importCardBtn.addEventListener("click", () => (importCardInput || importCardTopInput).click());
      if (importCardTopBtn) importCardTopBtn.addEventListener("click", () => (importCardTopInput || importCardInput).click());
      if (importCardInput) importCardInput.addEventListener("change", (e) => this.handleImportCard(e, false));
      if (importCardTopInput) importCardTopInput.addEventListener("change", (e) => this.handleImportCard(e, false));
    }

    // Import & Remaster buttons
    const importRemasterBtn = document.getElementById("import-remaster-btn");
    const importRemasterTopBtn = document.getElementById("import-remaster-top-btn");
    const importRemasterInput = document.getElementById("import-remaster-input");
    const importRemasterTopInput = document.getElementById("import-remaster-top-input");
    if (importRemasterInput || importRemasterTopInput) {
      if (importRemasterBtn) importRemasterBtn.addEventListener("click", () => (importRemasterInput || importRemasterTopInput).click());
      if (importRemasterTopBtn) importRemasterTopBtn.addEventListener("click", () => (importRemasterTopInput || importRemasterInput).click());
      if (importRemasterInput) importRemasterInput.addEventListener("change", (e) => this.handleImportCard(e, true));
      if (importRemasterTopInput) importRemasterTopInput.addEventListener("change", (e) => this.handleImportCard(e, true));
    }

    // Revision buttons
    const reviseCharacterBtn = document.getElementById("revise-character-btn");
    if (reviseCharacterBtn) reviseCharacterBtn.addEventListener("click", () => this.handleReviseCharacter());
    const reduceTokensBtn = document.getElementById("reduce-tokens-btn");
    if (reduceTokensBtn) reduceTokensBtn.addEventListener("click", () => this.handleReduceTokens());
    const scanForLorebookBtn = document.getElementById("scan-for-lorebook-btn");
    if (scanForLorebookBtn) scanForLorebookBtn.addEventListener("click", () => this.handleScanForLorebook());
    const stopRevisionBtn = document.getElementById("stop-revision-btn");
    if (stopRevisionBtn) stopRevisionBtn.addEventListener("click", () => this.handleStopRevision());

    // Image buttons
    document.getElementById("regenerate-image-btn").addEventListener("click", () => this.handleRegenerateImage());
    const generateFourImagesBtn = document.getElementById("generate-four-images-btn");
    if (generateFourImagesBtn) generateFourImagesBtn.addEventListener("click", () => this.handleGenerateFourImages());
    const generateFourPromptsBtn = document.getElementById("generate-four-prompts-btn");
    if (generateFourPromptsBtn) generateFourPromptsBtn.addEventListener("click", () => this.handleGenerateFourPrompts());

    const imgOptModalClose = document.getElementById("image-options-modal-close-btn");
    const imgOptModal = document.getElementById("image-options-modal");
    if (imgOptModalClose) imgOptModalClose.addEventListener("click", () => this.closeImageOptionsModal());
    if (imgOptModal) imgOptModal.addEventListener("click", (e) => { if (e.target === imgOptModal) this.closeImageOptionsModal(); });

    document.getElementById("regenerate-prompt-btn").addEventListener("click", () => this.handleRegeneratePrompt());

    const imageStyleSelect = document.getElementById("image-style");
    if (imageStyleSelect) imageStyleSelect.addEventListener("change", () => this.saveAPISettings());

    // Character field reset buttons
    const resetNameBtn = document.getElementById("reset-name-btn");
    if (resetNameBtn) resetNameBtn.addEventListener("click", () => this.handleResetField("name"));
    document.getElementById("reset-description-btn").addEventListener("click", () => this.handleResetField("description"));
    document.getElementById("reset-personality-btn").addEventListener("click", () => this.handleResetField("personality"));
    document.getElementById("reset-scenario-btn").addEventListener("click", () => this.handleResetField("scenario"));
    document.getElementById("reset-first-message-btn").addEventListener("click", () => this.handleResetField("firstMessage"));

    // Character field edit tracking
    const nameInput = document.getElementById("character-generated-name");
    if (nameInput) nameInput.addEventListener("input", () => this.handleCharacterEdit("name"));
    document.getElementById("character-description").addEventListener("input", () => this.handleCharacterEdit("description"));
    document.getElementById("character-personality").addEventListener("input", () => this.handleCharacterEdit("personality"));
    document.getElementById("character-scenario").addEventListener("input", () => this.handleCharacterEdit("scenario"));
    document.getElementById("character-first-message").addEventListener("input", () => this.handleCharacterEdit("firstMessage"));

    // Image & file uploads
    document.getElementById("upload-image-btn").addEventListener("click", () => document.getElementById("image-upload-input").click());
    document.getElementById("image-upload-input").addEventListener("change", (e) => this.handleImageUpload(e));
    document.getElementById("lorebook-file").addEventListener("change", (e) => this.handleLorebookUpload(e));
    const referenceImageInput = document.getElementById("reference-image-file");
    if (referenceImageInput) referenceImageInput.addEventListener("change", (e) => this.handleReferenceImageUpload(e));

    // Debug mode
    const debugModeCheckbox = document.getElementById("debug-mode");
    if (debugModeCheckbox) {
      debugModeCheckbox.checked = this.config.getDebugMode();
      debugModeCheckbox.addEventListener("change", (e) => this.config.setDebugMode(e.target.checked));
    }

    // API status & settings
    const apiStatus = document.getElementById("api-status");
    apiStatus.addEventListener("click", () => this.handleAPIConfig());
    apiStatus.style.cursor = "pointer";

    document.querySelectorAll("#text-api-base, #text-api-key, #text-model, #vision-model, #image-api-base, #image-api-key, #image-style")
      .forEach((input) => input.addEventListener("change", () => this.saveAPISettings()));

    document.getElementById("clear-config-btn").addEventListener("click", () => this.handleClearConfig());
    document.getElementById("test-connection-btn").addEventListener("click", () => this.handleTestConnection());

    // Ctrl+Enter to generate
    document.getElementById("character-concept").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); this.handleGenerate(); }
    });

    // Image generation toggle
    const enableImageGenerationToggle = document.getElementById("enable-image-generation");
    if (enableImageGenerationToggle) {
      enableImageGenerationToggle.addEventListener("change", (e) => {
        this.config.loadFromForm();
        this.config.saveConfig();
        console.log(`🖼️ Image generation ${e.target.checked ? "enabled" : "disabled"}`);
      });
    }

    // API Settings Modal
    const apiSettingsBtn = document.getElementById("api-settings-btn");
    const modalOverlay = document.getElementById("api-settings-modal");
    const modalCloseBtn = document.getElementById("modal-close-btn");
    apiSettingsBtn.addEventListener("click", () => { modalOverlay.classList.add("show"); document.body.style.overflow = "hidden"; });
    const closeModal = () => { modalOverlay.classList.remove("show"); document.body.style.overflow = ""; };
    modalCloseBtn.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalOverlay.classList.contains("show")) closeModal(); });
    modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

    // Library lists
    const promptList = document.getElementById("stored-prompts-list");
    const cardList = document.getElementById("stored-cards-list");
    const historyList = document.getElementById("history-cards-list");
    if (promptList) promptList.addEventListener("click", (event) => this.handleLibraryPromptClick(event));
    if (cardList) cardList.addEventListener("click", (event) => this.handleLibraryCardClick(event));
    if (historyList) historyList.addEventListener("click", (event) => this.handleLibraryCardClick(event));

    // Example messages
    const exampleMessagesCount = document.getElementById("example-messages-count");
    const regenerateExamplesBtn = document.getElementById("regenerate-examples-btn");
    const regenerateNameBtn = document.getElementById("regenerate-name-btn");
    if (exampleMessagesCount) exampleMessagesCount.addEventListener("change", () => this.handleGenerateExampleMessages());
    if (regenerateExamplesBtn) regenerateExamplesBtn.addEventListener("click", () => this.handleGenerateExampleMessages());
    if (regenerateNameBtn) regenerateNameBtn.addEventListener("click", () => this.handleOpenNamePicker());

    const regenDescBtn = document.getElementById("regenerate-description-btn");
    const regenPersBtn = document.getElementById("regenerate-personality-btn");
    const regenScenBtn = document.getElementById("regenerate-scenario-btn");
    const regenFirstMsgBtn = document.getElementById("regenerate-first-message-btn");
    if (regenDescBtn) regenDescBtn.addEventListener("click", () => this.handleRegenerateField("description"));
    if (regenPersBtn) regenPersBtn.addEventListener("click", () => this.handleRegenerateField("personality"));
    if (regenScenBtn) regenScenBtn.addEventListener("click", () => this.handleRegenerateField("scenario"));
    if (regenFirstMsgBtn) regenFirstMsgBtn.addEventListener("click", () => this.handleRegenerateField("firstMessage"));

    // Lorebook Manager
    const manageLorebookBtn = document.getElementById("manage-lorebook-btn");
    const lorebookModal = document.getElementById("lorebook-manager-modal");
    const lorebookModalCloseBtn = document.getElementById("lorebook-modal-close-btn");
    const suggestTopicsBtn = document.getElementById("suggest-lorebook-topics-btn");
    const generateContentBtn = document.getElementById("generate-lorebook-content-btn");
    const saveEntryBtn = document.getElementById("save-lorebook-entry-btn");
    const cancelEditBtn = document.getElementById("cancel-lorebook-edit-btn");
    const downloadLorebookBtn = document.getElementById("download-lorebook-btn");
    const injectLorebookBtn = document.getElementById("inject-lorebook-btn");
    const entriesList = document.getElementById("lorebook-entries-list");
    const topicSuggestions = document.getElementById("lorebook-topic-suggestions");

    if (manageLorebookBtn) manageLorebookBtn.addEventListener("click", () => this.openLorebookManager());
    if (lorebookModalCloseBtn) lorebookModalCloseBtn.addEventListener("click", () => this.closeLorebookManager());
    if (lorebookModal) lorebookModal.addEventListener("click", (e) => { if (e.target === lorebookModal) this.closeLorebookManager(); });
    if (suggestTopicsBtn) suggestTopicsBtn.addEventListener("click", () => this.handleSuggestLorebookTopics());
    if (generateContentBtn) generateContentBtn.addEventListener("click", () => this.handleGenerateLorebookContent());
    if (saveEntryBtn) saveEntryBtn.addEventListener("click", () => this.handleSaveLorebookEntry());
    if (cancelEditBtn) cancelEditBtn.addEventListener("click", () => this.resetLorebookEditor());
    if (downloadLorebookBtn) downloadLorebookBtn.addEventListener("click", () => this.handleDownloadLorebook());
    if (injectLorebookBtn) injectLorebookBtn.addEventListener("click", () => this.handleInjectLorebookKeys());
    if (entriesList) entriesList.addEventListener("click", (e) => {
      const target = e.target.closest("button[data-action]");
      if (!target) return;
      if (target.dataset.action === "edit-lorebook-entry") this.handleEditLorebookEntry(target.dataset.id);
      if (target.dataset.action === "delete-lorebook-entry") this.handleDeleteLorebookEntry(target.dataset.id);
    });
    if (topicSuggestions) topicSuggestions.addEventListener("click", (e) => {
      const target = e.target.closest("button.topic-suggestion");
      if (!target) return;
      const keysInput = document.getElementById("lorebook-entry-keys");
      keysInput.value = target.textContent;
      keysInput.focus();
    });

    // Fetch Image Models & Active Model Selection
    const fetchImageModelsBtn = document.getElementById("fetch-image-models-btn");
    if (fetchImageModelsBtn) fetchImageModelsBtn.addEventListener("click", () => this.handleFetchImageModels());

    // Manual model entry
    const addImageModelBtn = document.getElementById("add-image-model-btn");
    const manualImageModelInput = document.getElementById("manual-image-model-input");
    if (addImageModelBtn && manualImageModelInput) {
      const addManualModel = () => {
        const modelId = manualImageModelInput.value.trim();
        if (!modelId) return;
        const container = document.getElementById("image-models-container");
        if (!container) return;
        // Remove placeholder text if present
        const placeholder = container.querySelector("p");
        if (placeholder) placeholder.remove();
        // Don't add duplicates
        if (container.querySelector(`input[value="${CSS.escape(modelId)}"]`)) {
          manualImageModelInput.value = "";
          return;
        }
        const row = document.createElement("div");
        row.className = "image-model-row";
        row.style.cssText = "display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;";
        row.innerHTML = `<label style="display:flex;align-items:center;gap:0.5rem;flex:1;cursor:pointer;"><input type="checkbox" class="image-model-checkbox" value="${modelId}" checked> ${modelId}</label><button type="button" class="image-model-delete-btn" data-model="${modelId}" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>`;
        container.appendChild(row);
        manualImageModelInput.value = "";
        this.saveAPISettings();
        const searchInput = document.getElementById("image-model-search");
        if (searchInput) searchInput.style.display = "block";
      };
      addImageModelBtn.addEventListener("click", addManualModel);
      manualImageModelInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addManualModel(); } });
    }

    const imageModelSearch = document.getElementById("image-model-search");
    if (imageModelSearch) {
      imageModelSearch.addEventListener("input", (e) => {
        const term = e.target.value.toLowerCase();
        const container = document.getElementById("image-models-container");
        if (!container) return;
        container.querySelectorAll("label").forEach((label) => {
          label.style.display = label.textContent.toLowerCase().includes(term) ? "flex" : "none";
        });
      });
    }

    const activeImageModelSelect = document.getElementById("active-image-model");
    if (activeImageModelSelect) {
      activeImageModelSelect.addEventListener("change", (e) => this.config.set("api.image.model", e.target.value));
    }

    const imageModelsContainer = document.getElementById("image-models-container");
    if (imageModelsContainer) {
      imageModelsContainer.addEventListener("change", (e) => {
        if (e.target.classList.contains("image-model-checkbox")) this.saveAPISettings();
      });
      imageModelsContainer.addEventListener("click", (e) => {
        const btn = e.target.closest(".image-model-delete-btn");
        if (!btn) return;
        btn.closest(".image-model-row")?.remove();
        if (!imageModelsContainer.querySelector(".image-model-row")) {
          imageModelsContainer.innerHTML = '<p style="font-size:0.8rem;color:var(--text-secondary);margin:0;">No models added. Use Fetch from API or enter a model name above.</p>';
          const searchInput = document.getElementById("image-model-search");
          if (searchInput) searchInput.style.display = "none";
        }
        this.saveAPISettings();
      });
    }

    // Alt Greetings Manager
    const manageAltGreetingsBtn = document.getElementById("manage-alt-greetings-btn");
    const altGreetingsModal = document.getElementById("alt-greetings-manager-modal");
    const altGreetingsModalCloseBtn = document.getElementById("alt-greetings-modal-close-btn");
    const generateAltContBtn = document.getElementById("generate-alt-greeting-cont-btn");
    const generateAltRandBtn = document.getElementById("generate-alt-greeting-rand-btn");
    const saveAltGreetingBtn = document.getElementById("save-alt-greeting-btn");
    const cancelAltEditBtn = document.getElementById("cancel-alt-greeting-edit-btn");
    const altGreetingsList = document.getElementById("alt-greetings-list");

    if (manageAltGreetingsBtn) manageAltGreetingsBtn.addEventListener("click", () => this.openAltGreetingsManager());
    if (altGreetingsModalCloseBtn) altGreetingsModalCloseBtn.addEventListener("click", () => this.closeAltGreetingsManager());
    if (altGreetingsModal) altGreetingsModal.addEventListener("click", (e) => { if (e.target === altGreetingsModal) this.closeAltGreetingsManager(); });
    if (generateAltContBtn) generateAltContBtn.addEventListener("click", () => this.handleGenerateAltGreeting("continuation"));
    if (generateAltRandBtn) generateAltRandBtn.addEventListener("click", () => this.handleGenerateAltGreeting("random"));
    if (saveAltGreetingBtn) saveAltGreetingBtn.addEventListener("click", () => this.handleSaveAltGreeting());
    if (cancelAltEditBtn) cancelAltEditBtn.addEventListener("click", () => this.resetAltGreetingsEditor());
    if (altGreetingsList) altGreetingsList.addEventListener("click", (e) => {
      const target = e.target.closest("button[data-action]");
      if (!target) return;
      if (target.dataset.action === "edit-alt-greeting") this.handleEditAltGreeting(target.dataset.id);
      if (target.dataset.action === "delete-alt-greeting") this.handleDeleteAltGreeting(target.dataset.id);
    });

    // Consistency Check
    const checkConsistencyBtn = document.getElementById("check-consistency-btn");
    const consistencyModal = document.getElementById("consistency-report-modal");
    const consistencyModalCloseBtn = document.getElementById("consistency-modal-close-btn");
    const consistencyAutoFixBtn = document.getElementById("consistency-auto-fix-btn");
    if (checkConsistencyBtn) checkConsistencyBtn.addEventListener("click", () => this.handleCheckConsistency());
    if (consistencyModalCloseBtn) consistencyModalCloseBtn.addEventListener("click", () => this.closeConsistencyModal());
    if (consistencyModal) consistencyModal.addEventListener("click", (e) => { if (e.target === consistencyModal) this.closeConsistencyModal(); });
    if (consistencyAutoFixBtn) consistencyAutoFixBtn.addEventListener("click", () => this.handleConsistencyAutoFix());

    // Drag-and-drop import anywhere on the page
    let dragCounter = 0;
    const dropOverlay = document.getElementById("drop-overlay");

    document.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
      dragCounter++;
      if (dragCounter === 1) dropOverlay.classList.add("show");
    });

    document.addEventListener("dragleave", () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) dropOverlay.classList.remove("show");
    });

    document.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove("show");
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
      const isJson = file.type === "application/json" || file.name.toLowerCase().endsWith(".json");
      if (!isPng && !isJson) {
        this.showNotification("Only .png or .json character cards can be dropped here", "error");
        return;
      }
      this.showDropImportModal(file);
    });
  }

  async checkAPIStatus() {
    const statusElement = document.getElementById("api-status");
    const indicator = statusElement.querySelector(".status-indicator");
    const text = statusElement.querySelector(".status-text");
    try {
      const result = await this.apiHandler.testConnection();
      if (result.success) {
        indicator.className = "status-indicator status-online";
        text.textContent = "API Status: Connected";
      } else {
        indicator.className = "status-indicator status-offline";
        text.textContent = `API Status: ${result.error}`;
      }
    } catch (error) {
      indicator.className = "status-indicator status-offline";
      text.textContent = `API Status: ${error.message}`;
    }
  }

  saveAPISettings() {
    this.config.loadFromForm();
    this.config.saveConfig();
    this.updateActiveModelsDropdown();
    this.checkAPIStatus();
  }

  async handleAPIConfig() {
    this.showNotification("Configure API settings in form above", "info");
  }

  handleClearConfig() {
    if (confirm("Are you sure you want to clear all saved API settings?")) {
      this.config.clearStoredConfig();
      this.showNotification("Configuration cleared! Reloading page...", "success");
      setTimeout(() => window.location.reload(), 500);
    }
  }

  async handleTestConnection() {
    this.showNotification("Testing connection...", "info");
    try {
      this.saveAPISettings();
      const result = await this.apiHandler.testConnection();
      if (result.success) {
        this.showNotification(
          result.authMethod === "alternative"
            ? "Connection successful with alternative auth method! Check console for details."
            : "Connection successful!",
          "success",
        );
      } else {
        this.showNotification(
          result.error.includes("401") || result.error.includes("Authorization")
            ? "Authorization failed! Possible issues: 1) API key expired/invalid 2) Wrong auth format - trying alternatives 3) Check API key and try again"
            : `Connection failed: ${result.error}`,
          "error",
        );
      }
    } catch (error) {
      this.showNotification(`Connection test failed: ${error.message}`, "error");
    }
  }

  async handleGenerate() {
    if (this.isGenerating) return;

    this.saveAPISettings();

    const errors = this.config.validateConfig();
    if (errors.length > 0) {
      this.showNotification(`Configuration errors: ${errors.join(", ")}`, "error");
      return;
    }

    const concept = document.getElementById("character-concept").value.trim();
    const characterName = document.getElementById("character-name").value.trim();
    const referenceImageDescription = document.getElementById("reference-image-description")?.value?.trim();

    if (!concept) {
      this.showNotification("Please enter a character concept", "warning");
      return;
    }

    this.isGenerating = true;
    this.setGeneratingState(true);

    this.hideResultSection();
    this.currentImageUrl = null;
    if (window.apiHandler) window.apiHandler.lastGeneratedImagePrompt = null;

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    if (customPromptTextarea) { customPromptTextarea.value = ""; window.updatePromptCharCount(); }

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
      const pov = document.getElementById("pov-select").value;
      let effectiveConcept = concept;
      if (referenceImageDescription) effectiveConcept += `\n\nReference appearance guidance:\n${referenceImageDescription}`;

      const promptSaved = await this.savePromptToLibrary({
        concept, characterName, pov,
        lorebookData: this.lorebookData,
        referenceImageDescription: referenceImageDescription || "",
        referenceImageDataUrl: this.referenceImageDataUrl || "",
      });
      await this.refreshLibraryViews();
      if (!promptSaved) this.showStreamMessage("⚠️ Prompt could not be saved to local library.\n");

      this.showStreamMessage("🚀 Starting character generation...\n\n");
      this.currentCharacter = await this.characterGenerator.generateCharacter(
        effectiveConcept, characterName,
        (token, fullContent) => this.handleCharacterStream(token, fullContent),
        pov, this.lorebookData,
      );

      this.showStreamMessage("\n\n💬 Generating example messages...\n");
      await this.handleGenerateExampleMessages();

      this.originalCharacter = JSON.parse(JSON.stringify(this.currentCharacter));
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();

      this.showStreamMessage("\n✅ Character generation complete!\n");
      this.displayCharacter();

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
          await this.generateImage();
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
                this.currentCharacter.description, this.currentCharacter.name,
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

      this.showNotification("Character generated successfully!", "success");
    } catch (error) {
      console.error("Generation error:", error);
      if (error.message.includes("Generation stopped by user")) {
        this.showStreamMessage(`\n🛑 Generation stopped.\n`);
      } else {
        this.showStreamMessage(`❌ Error: ${error.message}\n`);
        this.showNotification(`Generation failed: ${error.message}`, "error");
      }
      this.hideResultSection();
    } finally {
      this.isGenerating = false;
      this.setGeneratingState(false);
      const inputSectionDetails = document.getElementById("input-section-details");
      if (inputSectionDetails) inputSectionDetails.open = false;
    }
  }

  async handleDownload() {
    if (!this.currentCharacter || !this.currentImageUrl) {
      this.showNotification("No character to download", "warning");
      return;
    }
    try {
      this.showNotification("Creating character card...", "info");

      const nameInput = document.getElementById("character-generated-name");
      const descriptionTextarea = document.getElementById("character-description");
      const personalityTextarea = document.getElementById("character-personality");
      const scenarioTextarea = document.getElementById("character-scenario");
      const firstMessageTextarea = document.getElementById("character-first-message");
      const exampleMessagesOutput = document.getElementById("example-messages-output");

      if (nameInput) this.currentCharacter.name = nameInput.value.trim();
      this.currentCharacter.description = descriptionTextarea.value.trim();
      this.currentCharacter.personality = personalityTextarea.value.trim();
      this.currentCharacter.scenario = scenarioTextarea.value.trim();
      this.currentCharacter.firstMessage = firstMessageTextarea.value.trim();

      if (exampleMessagesOutput) {
        if (exampleMessagesOutput.tagName === "TEXTAREA" || exampleMessagesOutput.tagName === "INPUT") {
          this.currentCharacter.mesExample = exampleMessagesOutput.value.trim();
        } else if (exampleMessagesOutput.isContentEditable) {
          this.currentCharacter.mesExample = exampleMessagesOutput.innerText.trim();
        }
      }

      this.currentCharacter.character_book = this.buildCharacterBook();
      this.syncAltGreetingsToCharacter();

      let imageBlob = await this.imageGenerator.convertToBlob(this.currentImageUrl);
      imageBlob = await this.imageGenerator.optimizeImageForCard(imageBlob);

      const specV3Data = this.characterGenerator.toSpecV3Format(this.currentCharacter);
      const cardBlob = await this.pngEncoder.createCharacterCard(imageBlob, specV3Data);
      this.pngEncoder.downloadCharacterCard(cardBlob, this.currentCharacter.name);

      const finalSize = this.imageGenerator.formatFileSize(cardBlob.size);
      this.showNotification(`Character card downloaded! Size: ${finalSize}`, "success");
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
    } catch (error) {
      console.error("Download error:", error);
      this.showNotification(`Download failed: ${error.message}`, "error");
    }
  }

  handleStop() {
    if (this.isGenerating) {
      this.showStreamMessage("\n\n🛑 Stopping generation...\n");
      window.apiHandler.stopGeneration();
      this.isGenerating = false;
      this.setGeneratingState(false);
      this.showNotification("Generation stopped by user", "warning");
    }
  }

  handleStopRevision() {
    if (this.isRevising) {
      window.apiHandler.stopGeneration();
      this.isRevising = false;
      this.setRevisionState(false);
      this.showNotification("Revision stopped by user", "warning");
    }
  }
}

// Update prompt character counter
window.updatePromptCharCount = function () {
  const textarea = document.getElementById("custom-image-prompt");
  const counter = document.getElementById("prompt-char-count");
  if (textarea && counter) {
    const length = textarea.value.length;
    counter.textContent = `${length}/1000`;
    counter.style.color = length >= 950 ? "#f59e0b" : "#9ca3af";
  }
};

// Bootstrap — wait for DOM and all modules
document.addEventListener("DOMContentLoaded", async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (!window.config || !window.apiHandler || !window.characterGenerator || !window.imageGenerator || !window.pngEncoder) {
    console.error("Missing modules:", {
      config: !!window.config, apiHandler: !!window.apiHandler,
      characterGenerator: !!window.characterGenerator, imageGenerator: !!window.imageGenerator, pngEncoder: !!window.pngEncoder,
    });
    return;
  }

  window.app = new CharacterGeneratorApp();

  const style = document.createElement("style");
  style.textContent = `
        .tags { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
        .tag { background: var(--bg-tertiary); color: var(--text-secondary); padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.875rem; font-weight: 500; }
        .character-section { margin-bottom: 1.5rem; }
        .character-section strong { color: var(--text-primary); display: block; margin-bottom: 0.5rem; }
        .image-container { text-align: center; }
        .generated-image { max-width: 100%; height: auto; border-radius: var(--radius); box-shadow: var(--shadow-sm); }
        .form-section { background: var(--bg-tertiary); padding: 1rem; border-radius: calc(var(--radius) / 2); margin-bottom: 1rem; }
        .form-section-title { font-weight: 600; margin-bottom: 1rem; color: var(--text-primary); }
    `;
  document.head.appendChild(style);

  console.log("%c🎭 SillyTavern Character Generator", "font-size: 20px; font-weight: bold; color: #0066cc;");
  console.log("%cCreate amazing characters with AI!", "font-size: 14px; color: #666;");
  console.log("%cTip: Press Ctrl+Enter to generate a character", "font-size: 12px; color: #999;");
});
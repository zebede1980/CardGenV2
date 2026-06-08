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
    this.imageHistoryUrls = [];
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

    // Patch displayCharacter to load image prompt fields
    const origDisplay = this.displayCharacter;
    if (origDisplay && !this._displayCharacterPatched) {
      this.displayCharacter = function(...args) {
        origDisplay.apply(this, args);
        const customPromptInput = document.getElementById("custom-image-prompt");
        const promptGuidanceInput = document.getElementById("prompt-guidance");
        if (customPromptInput) {
            customPromptInput.value = this.currentCharacter?.imagePrompt || "";
            if (window.updatePromptCharCount) window.updatePromptCharCount();
        }
        if (promptGuidanceInput) {
            promptGuidanceInput.value = this.currentCharacter?.imageGuidance || "";
        }
      };
      this._displayCharacterPatched = true;
    }

    await this.ensureStorageReady();
    this.config.saveToForm();
    this.initTheme();
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

    // Mode selector — toggle between Classic and Web Search input blocks
    const modeRadios = document.querySelectorAll('input[name="generation-mode"]');
    if (modeRadios.length > 0) {
      const classicBlock = document.getElementById("classic-mode-inputs");
      const searchBlock = document.getElementById("search-mode-inputs");
      const inspireBlock = document.getElementById("inspire-mode-inputs");
      const onModeChange = () => {
        const mode = document.querySelector('input[name="generation-mode"]:checked')?.value || "classic";
        if (classicBlock) classicBlock.style.display = mode === "classic" ? "" : "none";
        if (searchBlock) searchBlock.style.display = mode === "search" ? "" : "none";
        if (inspireBlock) inspireBlock.style.display = mode === "inspire" ? "" : "none";
      };
      modeRadios.forEach((r) => r.addEventListener("change", onModeChange));
      onModeChange();
    }

    // Batch generation — always generate 4 variants
    const batchGenerateBtn = document.getElementById("batch-generate-btn");
    if (batchGenerateBtn) batchGenerateBtn.addEventListener("click", () => this.handleBatchGenerate());

    // Batch modal
    const batchModal = document.getElementById("batch-modal");
    const batchModalCloseBtn = document.getElementById("batch-modal-close-btn");
    const batchGrid = document.getElementById("batch-grid");
    if (batchModalCloseBtn) batchModalCloseBtn.addEventListener("click", () => this.closeBatchModal());
    if (batchModal) batchModal.addEventListener("click", (e) => { if (e.target === batchModal) this.closeBatchModal(); });
    if (batchGrid) batchGrid.addEventListener("click", (e) => this._handleBatchGridClick(e));

    // Inspire Me modal events
    const inspirePickerCloseBtn = document.getElementById("inspire-picker-close-btn");
    const inspirePickerModal = document.getElementById("inspire-picker-modal");
    const inspireGoBtn = document.getElementById("inspire-go-btn");
    if (inspirePickerCloseBtn) inspirePickerCloseBtn.addEventListener("click", () => this.closeInspireModal());
    if (inspirePickerModal) inspirePickerModal.addEventListener("click", (e) => { if (e.target === inspirePickerModal) this.closeInspireModal(); });
    if (inspireGoBtn) inspireGoBtn.addEventListener("click", () => this.handleInspireFullGenerate());

    document.getElementById("download-btn").addEventListener("click", () => this.handleDownload());

    const saveCardBtn = document.getElementById("save-card-btn");
    if (saveCardBtn) saveCardBtn.addEventListener("click", () => this.handleSaveCardManual());
    const snapshotHistoryBtn = document.getElementById("snapshot-history-btn");
    if (snapshotHistoryBtn) snapshotHistoryBtn.addEventListener("click", () => this.handleSnapshotToHistory());

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

    // Remaster Current Card buttons (triggers remaster on already-loaded card)
    const remasterBtn = document.getElementById("remaster-btn");
    const remasterTopBtn = document.getElementById("remaster-top-btn");
    if (remasterBtn) remasterBtn.addEventListener("click", () => this.handleRemasterCurrentCard());
    if (remasterTopBtn) remasterTopBtn.addEventListener("click", () => this.handleRemasterCurrentCard());

    // URL Import button
    const urlImportBtn = document.getElementById("url-import-btn");
    if (urlImportBtn) urlImportBtn.addEventListener("click", () => this.openUrlImportModal());

    // URL Import modal events
    const urlImportModal = document.getElementById("url-import-modal");
    const urlImportModalCloseBtn = document.getElementById("url-import-modal-close-btn");
    const urlImportFetchBtn = document.getElementById("url-import-fetch-btn");
    const urlImportConfirmBtn = document.getElementById("url-import-confirm-btn");
    const urlImportCancelBtn = document.getElementById("url-import-cancel-btn");
    const urlImportInput = document.getElementById("url-import-input");

    if (urlImportModalCloseBtn) urlImportModalCloseBtn.addEventListener("click", () => this.closeUrlImportModal());
    if (urlImportModal) urlImportModal.addEventListener("click", (e) => { if (e.target === urlImportModal) this.closeUrlImportModal(); });
    if (urlImportFetchBtn) urlImportFetchBtn.addEventListener("click", () => this.handleUrlImportFetch());
    if (urlImportConfirmBtn) urlImportConfirmBtn.addEventListener("click", () => this.handleUrlImportConfirm());
    if (urlImportCancelBtn) urlImportCancelBtn.addEventListener("click", () => this.handleUrlImportCancel());
    if (urlImportInput) {
      urlImportInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.handleUrlImportFetch(); }
      });
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
    const imageHistoryBtn = document.getElementById("image-history-btn");
    if (imageHistoryBtn) imageHistoryBtn.addEventListener("click", () => this.showImageHistory());
    const generateFourImagesBtn = document.getElementById("generate-four-images-btn");
    if (generateFourImagesBtn) generateFourImagesBtn.addEventListener("click", () => this.handleGenerateFourImages());
    const generateFourPromptsBtn = document.getElementById("generate-four-prompts-btn");
    if (generateFourPromptsBtn) generateFourPromptsBtn.addEventListener("click", () => this.handleGenerateFourPrompts());

    // Free image dropdown
    const freeImageBtn = document.getElementById("free-image-btn");
    const freeImageMenu = document.getElementById("free-image-menu");
    if (freeImageBtn && freeImageMenu) {
      freeImageBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = freeImageMenu.style.display !== "none";
        freeImageMenu.style.display = isOpen ? "none" : "flex";
      });
      freeImageMenu.addEventListener("click", (e) => {
        const option = e.target.closest(".free-image-option");
        if (!option) return;
        freeImageMenu.style.display = "none";
        this.handleFreeImage(option.dataset.service, option.dataset.model);
      });
      document.addEventListener("click", () => {
        if (freeImageMenu.style.display !== "none") freeImageMenu.style.display = "none";
      });
    }

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

    // Creator's Notes edit tracking
    const creatorNotesTextarea = document.getElementById("creator-notes");
    if (creatorNotesTextarea) creatorNotesTextarea.addEventListener("input", () => {
      if (this.currentCharacter) this.currentCharacter.creatorNotes = creatorNotesTextarea.value;
    });

    const customImagePrompt = document.getElementById("custom-image-prompt");
    if (customImagePrompt) {
      customImagePrompt.addEventListener("input", () => {
        if (this.currentCharacter) this.currentCharacter.imagePrompt = customImagePrompt.value;
      });
    }

    const promptGuidance = document.getElementById("prompt-guidance");
    if (promptGuidance) {
      promptGuidance.addEventListener("input", () => {
        if (this.currentCharacter) this.currentCharacter.imageGuidance = promptGuidance.value;
      });
    }

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

    document.querySelectorAll("#text-api-base, #text-api-key, #text-model, #vision-model, #image-api-base, #image-api-key, #image-style, #creator-name")
      .forEach((input) => input.addEventListener("change", () => this.saveAPISettings()));

    document.getElementById("clear-config-btn").addEventListener("click", () => this.handleClearConfig());
    document.getElementById("test-connection-btn").addEventListener("click", () => this.handleTestConnection());

    // Card type: force POV to third-person and disable it for group/scenario
    const cardTypeSelect = document.getElementById("card-type-select");
    const povSelect = document.getElementById("pov-select");
    const applyCardTypeConstraints = () => {
      const cardType = cardTypeSelect?.value;
      const nameLabel = document.querySelector('label[for="character-name"]');
      const nameInput = document.getElementById("character-name");
      if (cardType === "group" || cardType === "scenario") {
        if (povSelect) { povSelect.value = "third"; povSelect.disabled = true; }
        if (nameLabel) nameLabel.textContent = cardType === "group" ? "Group Name (optional)" : "Scenario Title (optional)";
        if (nameInput) nameInput.placeholder = cardType === "group" ? "e.g. The Red Cobras" : "e.g. The Haunted Lighthouse";
      } else {
        if (povSelect) povSelect.disabled = false;
        if (nameLabel) nameLabel.textContent = "Character Name (optional)";
        if (nameInput) nameInput.placeholder = "";
      }
    };
    if (cardTypeSelect) cardTypeSelect.addEventListener("change", applyCardTypeConstraints);

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

    const clearHistoryBtn = document.getElementById("clear-history-btn");
    if (clearHistoryBtn) clearHistoryBtn.addEventListener("click", () => this.handleClearHistory());
    const clearPromptsBtn = document.getElementById("clear-prompts-btn");
    if (clearPromptsBtn) clearPromptsBtn.addEventListener("click", () => this.handleClearPrompts());
    const migrateCardsBtn = document.getElementById("migrate-cards-btn");
    if (migrateCardsBtn) migrateCardsBtn.addEventListener("click", () => this.handleMigrateCards());
    const galleryCardsBtn = document.getElementById("gallery-cards-btn");
    if (galleryCardsBtn) galleryCardsBtn.addEventListener("click", () => this.handleOpenLibraryGallery());

    // SillyTavern bridge
    const refreshSTBtn = document.getElementById("refresh-st-library-btn");
    if (refreshSTBtn) refreshSTBtn.addEventListener("click", () => this.handleRefreshSTLibrary());
    const stList = document.getElementById("st-characters-list");
    if (stList) stList.addEventListener("click", (e) => this.handleSTLibraryClick(e));
    const stFilter = document.getElementById("st-library-filter");
    if (stFilter) stFilter.addEventListener("input", () => this.handleSTLibraryFilter());
    const pushToSTBtn = document.getElementById("push-to-st-btn");
    if (pushToSTBtn) pushToSTBtn.addEventListener("click", () => this.handlePushToST());
    const testSTBtn = document.getElementById("test-st-btn");
    if (testSTBtn) testSTBtn.addEventListener("click", () => this.handleTestSTConnection());
    // Save ST URL whenever it changes
    const stBaseUrlInput = document.getElementById("st-base-url");
    if (stBaseUrlInput) stBaseUrlInput.addEventListener("change", () => { this.config.loadFromForm(); this.config.saveConfig(); this._updatePushButton(); });
    const stUsernameInput = document.getElementById("st-username");
    if (stUsernameInput) stUsernameInput.addEventListener("change", () => { this.config.loadFromForm(); this.config.saveConfig(); });
    const stPasswordInput = document.getElementById("st-password");
    if (stPasswordInput) stPasswordInput.addEventListener("change", () => { this.config.loadFromForm(); this.config.saveConfig(); });

    // Tags
    const autoTagBtn = document.getElementById("auto-tag-btn");
    if (autoTagBtn) autoTagBtn.addEventListener("click", () => this.handleAutoTag());
    this.initTagInput();

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
        row.innerHTML = `<label style="display:flex;align-items:center;gap:0.5rem;flex:1;cursor:pointer;"><input type="checkbox" class="image-model-checkbox" value="${escapeHtml(modelId)}" checked> ${escapeHtml(modelId)}</label><button type="button" class="image-model-delete-btn" data-model="${escapeHtml(modelId)}" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>`;
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

    // Chat Tester
    const testChatBtn = document.getElementById("test-chat-btn");
    const chatTesterModal = document.getElementById("chat-tester-modal");
    const chatTesterModalCloseBtn = document.getElementById("chat-tester-modal-close-btn");
    const chatSendBtn = document.getElementById("chat-send-btn");
    const chatInput = document.getElementById("chat-input");
    const chatRegenerateBtn = document.getElementById("chat-regenerate-btn");
    const chatClearBtn = document.getElementById("chat-clear-btn");
    const chatStopBtn = document.getElementById("chat-stop-btn");
    const chatExportBtn = document.getElementById("chat-export-btn");
    const chatPersonaInput = document.getElementById("chat-persona-name");

    if (testChatBtn) testChatBtn.addEventListener("click", () => this.openChatTester());
    if (chatTesterModalCloseBtn) chatTesterModalCloseBtn.addEventListener("click", () => this.closeChatTester());
    if (chatTesterModal) chatTesterModal.addEventListener("click", (e) => { if (e.target === chatTesterModal) this.closeChatTester(); });
    if (chatSendBtn) chatSendBtn.addEventListener("click", () => this.handleChatSend());
    if (chatInput) {
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.handleChatSend();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.handleChatSend();
        } else if (e.key === "ArrowUp" && chatInput.selectionStart === 0 && chatInput.selectionEnd === 0 && chatInput.value === "") {
          // Populate with last user message on up-arrow when empty
          if (this.chatTester) {
            const msgs = this.chatTester.getMessages();
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "user") {
                e.preventDefault();
                chatInput.value = msgs[i].content;
                chatInput.selectionStart = chatInput.selectionEnd = chatInput.value.length;
                break;
              }
            }
          }
        }
      });
    }
    if (chatRegenerateBtn) chatRegenerateBtn.addEventListener("click", () => this.handleChatRegenerate());
    if (chatClearBtn) chatClearBtn.addEventListener("click", () => this.handleChatClear());
    if (chatStopBtn) chatStopBtn.addEventListener("click", () => this.handleChatStop());
    if (chatExportBtn) chatExportBtn.addEventListener("click", () => this.handleChatExport());
    if (chatPersonaInput) chatPersonaInput.addEventListener("change", () => this.handleChatPersonaChange());

    // Export dropdown
    const chatExportMdBtn = document.getElementById("chat-export-md-btn");
    const chatExportJsonlBtn = document.getElementById("chat-export-jsonl-btn");
    const chatExportMenu = document.getElementById("chat-export-menu");
    if (chatExportBtn && chatExportMenu) {
      chatExportBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = chatExportMenu.style.display === "none" || !chatExportMenu.style.display;
        chatExportMenu.style.display = isHidden ? "flex" : "none";
      });
      document.addEventListener("click", (e) => {
        if (!chatExportMenu.contains(e.target) && e.target !== chatExportBtn) {
          chatExportMenu.style.display = "none";
        }
      });
    }
    if (chatExportMdBtn) chatExportMdBtn.addEventListener("click", () => { chatExportMenu.style.display = "none"; this.handleChatExport(); });
    if (chatExportJsonlBtn) chatExportJsonlBtn.addEventListener("click", () => { chatExportMenu.style.display = "none"; this.handleChatExportJSONL(); });

    // Chat slot controls
    const chatSlotSelect = document.getElementById("chat-slot-select");
    const chatSlotRenameBtn = document.getElementById("chat-slot-rename-btn");
    const chatSlotDeleteBtn = document.getElementById("chat-slot-delete-btn");
    if (chatSlotSelect) chatSlotSelect.addEventListener("change", () => this._handleChatSlotChange());
    if (chatSlotRenameBtn) chatSlotRenameBtn.addEventListener("click", () => this._handleRenameSlot());
    if (chatSlotDeleteBtn) chatSlotDeleteBtn.addEventListener("click", () => this._handleDeleteSlot());

    // Chat param controls (basic + advanced)
    const chatTemperature = document.getElementById("chat-temperature");
    const chatTopP = document.getElementById("chat-top-p");
    const chatMaxTokens = document.getElementById("chat-max-tokens");
    if (chatTemperature) chatTemperature.addEventListener("input", () => this._handleChatParamChange());
    if (chatTopP) chatTopP.addEventListener("input", () => this._handleChatParamChange());
    if (chatMaxTokens) chatMaxTokens.addEventListener("input", () => this._handleChatParamChange());

    const chatAdvancedToggle = document.getElementById("chat-advanced-toggle");
    const chatAdvancedParams = document.getElementById("chat-advanced-params");
    if (chatAdvancedToggle && chatAdvancedParams) {
      chatAdvancedToggle.addEventListener("click", () => {
        const hidden = chatAdvancedParams.style.display === "none";
        chatAdvancedParams.style.display = hidden ? "flex" : "none";
      });
    }

    [
      "chat-freq-penalty",
      "chat-pres-penalty",
      "chat-top-k",
      "chat-min-p",
      "chat-seed",
      "chat-stop-sequences",
      "chat-authors-note",
      "chat-authors-note-depth",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", () => this._handleChatParamChange());
    });

    // Chat transcript buttons
    const chatSaveTranscriptBtn = document.getElementById("chat-save-transcript-btn");
    const chatLoadTranscriptBtn = document.getElementById("chat-load-transcript-btn");
    if (chatSaveTranscriptBtn) chatSaveTranscriptBtn.addEventListener("click", () => this._handleChatSaveTranscript());
    if (chatLoadTranscriptBtn) chatLoadTranscriptBtn.addEventListener("click", () => this._handleChatLoadTranscript());

    // Transcript modal
    const chatTranscriptModal = document.getElementById("chat-transcript-modal");
    const chatTranscriptModalCloseBtn = document.getElementById("chat-transcript-modal-close-btn");
    const chatTranscriptList = document.getElementById("chat-transcript-list");
    if (chatTranscriptModalCloseBtn) chatTranscriptModalCloseBtn.addEventListener("click", () => this._closeTranscriptModal());
    if (chatTranscriptModal) chatTranscriptModal.addEventListener("click", (e) => { if (e.target === chatTranscriptModal) this._closeTranscriptModal(); });
    if (chatTranscriptList) chatTranscriptList.addEventListener("click", (e) => this._handleTranscriptListClick(e));

    // Personas
    const chatManagePersonasBtn = document.getElementById("chat-manage-personas-btn");
    if (chatManagePersonasBtn) chatManagePersonasBtn.addEventListener("click", () => this._handleManagePersonas());

    const chatPersonasModal = document.getElementById("chat-personas-modal");
    const chatPersonasModalCloseBtn = document.getElementById("chat-personas-modal-close-btn");
    const chatPersonasList = document.getElementById("chat-personas-list");
    const chatPersonaForm = document.getElementById("chat-persona-form");
    if (chatPersonasModalCloseBtn) chatPersonasModalCloseBtn.addEventListener("click", () => this._closePersonasModal());
    if (chatPersonasModal) chatPersonasModal.addEventListener("click", (e) => { if (e.target === chatPersonasModal) this._closePersonasModal(); });
    if (chatPersonasList) chatPersonasList.addEventListener("click", (e) => this._handlePersonaListClick(e));
    if (chatPersonaForm) chatPersonaForm.addEventListener("submit", (e) => this._handlePersonaFormSubmit(e));

    // Persona selector dropdown
    const chatPersonaSelect = document.getElementById("chat-persona-select");
    if (chatPersonaSelect) {
      chatPersonaSelect.addEventListener("change", () => this._handlePersonaSelectChange());
      // Populate initially
      this._populatePersonaSelect(chatPersonaSelect);
    }

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
    
    // Inject API Logs UI
    if (typeof this.injectTechLogsUI === 'function') {
        this.injectTechLogsUI();
    }
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
    this._syncStoryWriterSettings();
  }

  _syncStoryWriterSettings() {
    const text = this.config.config?.api?.text;
    if (!text?.apiKey) return;
    const payload = {
      api_base_url: text.baseUrl || "https://api.openai.com/v1",
      api_key: text.apiKey,
      model: text.model || "",
    };
    (window.authFetch || fetch)("/api/sw/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(e => console.warn("[CardGen] Failed to sync API settings to StoryWriter:", e.message));
  }

  /* ── Theme Toggle ─────────────────────────────────────────────────────── */

  initTheme() {
    const saved = localStorage.getItem("cardgen-theme");
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved ? saved === "dark" : prefersDark;
    this._applyTheme(isDark);

    const btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        const currentlyDark = document.documentElement.getAttribute("data-theme") === "dark";
        this._applyTheme(!currentlyDark);
      });
    }
  }

  _applyTheme(isDark) {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    localStorage.setItem("cardgen-theme", isDark ? "dark" : "light");
    const btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.textContent = isDark ? "☀️ Light" : "🌙 Dark";
      btn.setAttribute("aria-pressed", String(isDark));
      btn.setAttribute("aria-label", isDark ? "Toggle light mode" : "Toggle dark mode");
    }
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

    const generationMode = document.querySelector('input[name="generation-mode"]:checked')?.value || "classic";
    const concept = document.getElementById("character-concept").value.trim();
    const searchQuery = document.getElementById("search-query")?.value?.trim() || "";
    const searchScenario = document.getElementById("search-scenario")?.value?.trim() || "";
    const characterName = document.getElementById("character-name").value.trim();
    const referenceImageDescription = document.getElementById("reference-image-description")?.value?.trim();

    if (generationMode === "inspire") {
      return this.handleInspireGenerate();
    }

    if (generationMode === "classic" && !concept) {
      this.showNotification("Please enter a character concept", "warning");
      return;
    }
    if (generationMode === "search" && !searchQuery) {
      this.showNotification("Please enter a character to search for", "warning");
      return;
    }

    this.isGenerating = true;
    this.setGeneratingState(true);

    // Generating a fresh character — clear any ST source link
    this.stSourceAvatar = null;
    this._updatePushButton();

    this.hideResultSection();
    this.currentImageUrl = null;
    if (window.apiHandler) window.apiHandler.lastGeneratedImagePrompt = null;

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    if (customPromptTextarea) { customPromptTextarea.value = ""; window.updatePromptCharCount(); }

    ["description-prompt", "personality-prompt", "scenario-prompt", "first-message-prompt", "example-messages-prompt"]
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });

    const guidanceInput = document.getElementById("prompt-guidance");
    if (guidanceInput) guidanceInput.value = "";

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
      const cardType = document.getElementById("card-type-select")?.value || "single";
      let effectiveConcept = concept;
      if (generationMode === "classic" && referenceImageDescription) {
        effectiveConcept += `\n\nReference appearance guidance:\n${referenceImageDescription}`;
      }

      const saveConcept = generationMode === "classic" ? concept : searchQuery;
      const promptSaved = await this.savePromptToLibrary({
        concept: saveConcept, characterName, pov, cardType,
        lorebookData: this.lorebookData,
        referenceImageDescription: referenceImageDescription || "",
        referenceImageDataUrl: this.referenceImageDataUrl || "",
      });
      await this.refreshLibraryViews();
      if (!promptSaved) this.showStreamMessage("⚠️ Prompt could not be saved to local library.\n");

      this.showStreamMessage("🚀 Starting character generation...\n\n");
      if (generationMode === "search") {
        this.currentCharacter = await window.characterSearch.generateCharacter(
          searchQuery, searchScenario, characterName,
          (token, fullContent) => this.handleCharacterStream(token, fullContent),
          pov, this.lorebookData, cardType,
        );
      } else {
        this.currentCharacter = await this.characterGenerator.generateCharacter(
          effectiveConcept, characterName,
          (token, fullContent) => this.handleCharacterStream(token, fullContent),
          pov, this.lorebookData, cardType,
        );
      }

      // Stamp cardType on the character and auto-tag non-single types
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
        if (notes) {
          this.currentCharacter.creatorNotes = notes;
        }
      } catch (notesError) {
        console.warn("Creator notes generation failed (non-fatal):", notesError);
      }

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
                this.currentCharacter.description, this.currentCharacter.name,
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

      const creatorNotesTextarea = document.getElementById("creator-notes");
      if (creatorNotesTextarea) this.currentCharacter.creatorNotes = creatorNotesTextarea.value.trim();
      this.currentCharacter.creator = this.config.get("app.creator") || "";

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
    // Stop batch generation if it's running
    if (this._batchIsGenerating) {
      this.handleBatchStop();
      return;
    }
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

  async handleRemasterCurrentCard() {
    if (!this.currentCharacter) {
      this.showNotification("No card loaded to remaster", "warning");
      return;
    }
    this.showNotification("Starting AI remaster...", "info");
    await this.handleAutoRemaster();
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

  // Initialise auth — if already authenticated this resolves immediately
  // and shows the app; otherwise the login overlay stays visible and
  // onAuthSuccess is called after a successful login.
  async function startApp() {
    if (!window.app) {
      // Reload server config now that we have a valid token so the
      // shared API keys/settings are available to this user.
      if (window.config) {
        await window.config.loadConfig().catch(() => {});
        window.config.saveToForm();
      }
      window.app = new CharacterGeneratorApp();
    }
  }

  window.onAuthSuccess = startApp;

  const authenticated = await window.cardgenAuth.initAuth();
  if (authenticated) {
    startApp();
  }

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

        /* Dark mode button fixes */
        [data-theme="dark"] button:not(.btn-primary):not(.btn-secondary):not(.btn-stop):not([style*="background: none"]):not([style*="background:none"]) {
            background: var(--surface, #1c2128);
            color: var(--text-primary, #c9d1d9);
            border: 1px solid var(--border-strong, #4b5563);
        }
        [data-theme="dark"] button:not(.btn-primary):not(.btn-secondary):not(.btn-stop):not([style*="background: none"]):not([style*="background:none"]):hover {
            background: var(--surface-muted, #111820);
        }

          /* Form inputs need explicit color assignment to avoid black text on dark backgrounds */
          input, textarea, select, .content-box, .input {
              color: var(--text-primary);
          }
    `;
  document.head.appendChild(style);

  console.log("%c🎭 SillyTavern Character Generator", "font-size: 20px; font-weight: bold; color: #0066cc;");
  console.log("%cCreate amazing characters with AI!", "font-size: 14px; color: #666;");
  console.log("%cTip: Press Ctrl+Enter to generate a character", "font-size: 12px; color: #999;");
});
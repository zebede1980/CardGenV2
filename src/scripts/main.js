// Main Application Controller
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
    this.originalCharacter = null; // Store the original AI-generated version
    this.currentImageUrl = null;
    this.lorebookEntries = []; // Holds {id, keys, content}
    this.altGreetings = []; // Holds {id, content}
    this.lorebookData = null; // Store loaded lorebook data
    this.referenceImageDataUrl = "";
    // Removed currentImageBlob - we now convert fresh from URL on download
    this.isGenerating = false;
    this.isRevising = false;

    this.init();
  }

  async init() {
    const savedConfig = localStorage.getItem("charGeneratorConfig");
    if (
      savedConfig &&
      (savedConfig.includes('"api":{"baseUrl"') ||
        savedConfig.includes('"textModel"'))
    ) {
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
      this.updateLibraryStatus(
        "IndexedDB failed to initialize. Prompt/card saving is disabled.",
      );
    }
  }

  bindEvents() {
    // Generate button
    const generateBtn = document.getElementById("generate-btn");
    generateBtn.addEventListener("click", () => this.handleGenerate());

    // Stop button
    const stopBtn = document.getElementById("stop-btn");
    stopBtn.addEventListener("click", () => this.handleStop());

    // Download button
    const downloadBtn = document.getElementById("download-btn");
    downloadBtn.addEventListener("click", () => this.handleDownload());

    // Download JSON button
    const downloadJsonBtn = document.getElementById("download-json-btn");
    downloadJsonBtn.addEventListener("click", () => this.handleDownloadJSON());

    // Save Card button
    const saveCardBtn = document.getElementById("save-card-btn");
    if (saveCardBtn) saveCardBtn.addEventListener("click", () => this.handleSaveCardManual());

    // Regenerate button
    const regenerateBtn = document.getElementById("regenerate-btn");
    regenerateBtn.addEventListener("click", () => this.handleRegenerate());

    // Import card button
    const importCardBtn = document.getElementById("import-card-btn");
    const importCardTopBtn = document.getElementById("import-card-top-btn");
    const importCardInput = document.getElementById("import-card-input");
    const importCardTopInput = document.getElementById("import-card-top-input");
    if (importCardInput || importCardTopInput) {
      if (importCardBtn) {
        importCardBtn.addEventListener("click", () =>
          (importCardInput || importCardTopInput).click(),
        );
      }
      if (importCardTopBtn) {
        importCardTopBtn.addEventListener("click", () =>
          (importCardTopInput || importCardInput).click(),
        );
      }
      if (importCardInput) {
        importCardInput.addEventListener("change", (e) =>
          this.handleImportCard(e),
        );
      }
      if (importCardTopInput) {
        importCardTopInput.addEventListener("change", (e) =>
          this.handleImportCard(e),
        );
      }
    }

    // Revision button
    const reviseCharacterBtn = document.getElementById("revise-character-btn");
    if (reviseCharacterBtn) {
      reviseCharacterBtn.addEventListener("click", () =>
        this.handleReviseCharacter(),
      );
    }

    const stopRevisionBtn = document.getElementById("stop-revision-btn");
    if (stopRevisionBtn) {
      stopRevisionBtn.addEventListener("click", () => this.handleStopRevision());
    }

    // Regenerate image button
    const regenerateImageBtn = document.getElementById("regenerate-image-btn");
    regenerateImageBtn.addEventListener("click", () =>
      this.handleRegenerateImage(),
    );
    
    // Generate 4 images button
    const generateFourImagesBtn = document.getElementById("generate-four-images-btn");
    if (generateFourImagesBtn) {
        generateFourImagesBtn.addEventListener("click", () => this.handleGenerateFourImages());
    }
    
    const imgOptModalClose = document.getElementById("image-options-modal-close-btn");
    const imgOptModal = document.getElementById("image-options-modal");
    if (imgOptModalClose) imgOptModalClose.addEventListener("click", () => this.closeImageOptionsModal());
    if (imgOptModal) imgOptModal.addEventListener("click", (e) => {
        if (e.target === imgOptModal) this.closeImageOptionsModal();
    });

    // Regenerate prompt button
    const regeneratePromptBtn = document.getElementById(
      "regenerate-prompt-btn",
    );
    regeneratePromptBtn.addEventListener("click", () =>
      this.handleRegeneratePrompt(),
    );

    // Character field reset buttons
    const resetNameBtn = document.getElementById("reset-name-btn");
    const resetDescriptionBtn = document.getElementById(
      "reset-description-btn",
    );
    const resetPersonalityBtn = document.getElementById(
      "reset-personality-btn",
    );
    const resetScenarioBtn = document.getElementById("reset-scenario-btn");
    const resetFirstMessageBtn = document.getElementById(
      "reset-first-message-btn",
    );

    if (resetNameBtn) {
      resetNameBtn.addEventListener("click", () => this.handleResetField("name"));
    }
    resetDescriptionBtn.addEventListener("click", () =>
      this.handleResetField("description"),
    );
    resetPersonalityBtn.addEventListener("click", () =>
      this.handleResetField("personality"),
    );
    resetScenarioBtn.addEventListener("click", () =>
      this.handleResetField("scenario"),
    );
    resetFirstMessageBtn.addEventListener("click", () =>
      this.handleResetField("firstMessage"),
    );

    // Character field textareas - show reset button when edited
    const nameInput = document.getElementById("character-generated-name");
    const descriptionTextarea = document.getElementById(
      "character-description",
    );
    const personalityTextarea = document.getElementById(
      "character-personality",
    );
    const scenarioTextarea = document.getElementById("character-scenario");
    const firstMessageTextarea = document.getElementById(
      "character-first-message",
    );

    if (nameInput) {
      nameInput.addEventListener("input", () => this.handleCharacterEdit("name"));
    }
    descriptionTextarea.addEventListener("input", () =>
      this.handleCharacterEdit("description"),
    );
    personalityTextarea.addEventListener("input", () =>
      this.handleCharacterEdit("personality"),
    );
    scenarioTextarea.addEventListener("input", () =>
      this.handleCharacterEdit("scenario"),
    );
    firstMessageTextarea.addEventListener("input", () =>
      this.handleCharacterEdit("firstMessage"),
    );

    // Upload image button
    const uploadImageBtn = document.getElementById("upload-image-btn");
    uploadImageBtn.addEventListener("click", () => {
      document.getElementById("image-upload-input").click();
    });

    // Image upload input
    const imageUploadInput = document.getElementById("image-upload-input");
    imageUploadInput.addEventListener("change", (e) =>
      this.handleImageUpload(e),
    );

    // Lorebook upload input
    const lorebookInput = document.getElementById("lorebook-file");
    lorebookInput.addEventListener("change", (e) =>
      this.handleLorebookUpload(e),
    );

    // Reference image upload input
    const referenceImageInput = document.getElementById("reference-image-file");
    if (referenceImageInput) {
      referenceImageInput.addEventListener("change", (e) =>
        this.handleReferenceImageUpload(e),
      );
    }

    // Debug mode toggle
    const debugModeCheckbox = document.getElementById("debug-mode");
    if (debugModeCheckbox) {
      // Load saved debug mode state
      debugModeCheckbox.checked = this.config.getDebugMode();

      // Handle toggle
      debugModeCheckbox.addEventListener("change", (e) => {
        this.config.setDebugMode(e.target.checked);
      });
    }

    // API status click to reconfigure
    const apiStatus = document.getElementById("api-status");
    apiStatus.addEventListener("click", () => this.handleAPIConfig());
    apiStatus.style.cursor = "pointer";

    // Save API settings on input change
    const apiInputs = document.querySelectorAll(
      "#text-api-base, #text-api-key, #text-model, #vision-model, #image-api-base, #image-api-key, #image-model, #image-style",
    );
    apiInputs.forEach((input) => {
      input.addEventListener("change", () => this.saveAPISettings());
    });

    // Clear config button
    const clearConfigBtn = document.getElementById("clear-config-btn");
    clearConfigBtn.addEventListener("click", () => this.handleClearConfig());

    // Test connection button
    const testConnectionBtn = document.getElementById("test-connection-btn");
    testConnectionBtn.addEventListener("click", () =>
      this.handleTestConnection(),
    );

    // Enter key in textarea
    const conceptTextarea = document.getElementById("character-concept");
    conceptTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        this.handleGenerate();
      }
    });

    // Image generation toggle
    const enableImageGenerationToggle = document.getElementById(
      "enable-image-generation",
    );
    if (enableImageGenerationToggle) {
      enableImageGenerationToggle.addEventListener("change", (e) => {
        this.config.loadFromForm(); // Update config with new toggle state
        this.config.saveConfig(); // Save the change
        console.log(
          `🖼️ Image generation ${e.target.checked ? "enabled" : "disabled"}`,
        );
      });
    }

    // API Settings Modal functionality
    const apiSettingsBtn = document.getElementById("api-settings-btn");
    const modalOverlay = document.getElementById("api-settings-modal");
    const modalCloseBtn = document.getElementById("modal-close-btn");

    // Open modal
    apiSettingsBtn.addEventListener("click", () => {
      modalOverlay.classList.add("show");
      document.body.style.overflow = "hidden"; // Prevent background scrolling
    });

    // Close modal function
    const closeModal = () => {
      modalOverlay.classList.remove("show");
      document.body.style.overflow = ""; // Restore scrolling
    };

    // Close modal with close button
    modalCloseBtn.addEventListener("click", closeModal);

    // Close modal with escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modalOverlay.classList.contains("show")) {
        closeModal();
      }
    });

    // Close modal when clicking outside the modal content
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) {
        closeModal();
      }
    });

    const promptList = document.getElementById("stored-prompts-list");
    const cardList = document.getElementById("stored-cards-list");
    const historyList = document.getElementById("history-cards-list");

    if (promptList) {
      promptList.addEventListener("click", (event) =>
        this.handleLibraryPromptClick(event),
      );
    }

    if (cardList) {
      cardList.addEventListener("click", (event) =>
        this.handleLibraryCardClick(event),
      );
    }

    if (historyList) {
      historyList.addEventListener("click", (event) =>
        this.handleLibraryCardClick(event),
      );
    }

    // Example messages controls
    const exampleMessagesCount = document.getElementById("example-messages-count");
    const regenerateExamplesBtn = document.getElementById("regenerate-examples-btn");
    const regenerateNameBtn = document.getElementById("regenerate-name-btn");

    if (exampleMessagesCount) {
      // Auto-regenerate if the user changes the count manually
      exampleMessagesCount.addEventListener("change", () =>
        this.handleGenerateExampleMessages(),
      );
    }

    if (regenerateExamplesBtn) {
      regenerateExamplesBtn.addEventListener("click", () =>
        this.handleGenerateExampleMessages(),
      );
    }

    if (regenerateNameBtn) {
      regenerateNameBtn.addEventListener("click", () => this.handleRegenerateName());
    }

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
    const entriesList = document.getElementById("lorebook-entries-list");
    const topicSuggestions = document.getElementById("lorebook-topic-suggestions");

    if (manageLorebookBtn) manageLorebookBtn.addEventListener("click", () => this.openLorebookManager());
    if (lorebookModalCloseBtn) lorebookModalCloseBtn.addEventListener("click", () => this.closeLorebookManager());
    if (lorebookModal) lorebookModal.addEventListener("click", (e) => {
        if (e.target === lorebookModal) this.closeLorebookManager();
    });
    if (suggestTopicsBtn) suggestTopicsBtn.addEventListener("click", () => this.handleSuggestLorebookTopics());
    if (generateContentBtn) generateContentBtn.addEventListener("click", () => this.handleGenerateLorebookContent());
    if (saveEntryBtn) saveEntryBtn.addEventListener("click", () => this.handleSaveLorebookEntry());
    if (cancelEditBtn) cancelEditBtn.addEventListener("click", () => this.resetLorebookEditor());
    if (downloadLorebookBtn) downloadLorebookBtn.addEventListener("click", () => this.handleDownloadLorebook());

    if (entriesList) entriesList.addEventListener("click", (e) => {
        const target = e.target.closest("button[data-action]");
        if (!target) return;
        const id = target.dataset.id;
        const action = target.dataset.action;
        if (action === "edit-lorebook-entry") this.handleEditLorebookEntry(id);
        if (action === "delete-lorebook-entry") this.handleDeleteLorebookEntry(id);
    });

    if (topicSuggestions) topicSuggestions.addEventListener("click", (e) => {
        const target = e.target.closest("button.topic-suggestion");
        if (!target) return;
        const keysInput = document.getElementById("lorebook-entry-keys");
        keysInput.value = target.textContent;
        keysInput.focus();
    });

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
    if (altGreetingsModal) altGreetingsModal.addEventListener("click", (e) => {
        if (e.target === altGreetingsModal) this.closeAltGreetingsManager();
    });
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
    this.checkAPIStatus();
  }

  async handleAPIConfig() {
    this.showNotification("Configure API settings in form above", "info");
  }

  handleClearConfig() {
    if (confirm("Are you sure you want to clear all saved API settings?")) {
      this.config.clearStoredConfig();
      this.showNotification(
        "Configuration cleared! Reloading page...",
        "success",
      );
      // Reload page to reset everything to defaults
      setTimeout(() => {
        window.location.reload();
      }, 500);
    }
  }

  async handleTestConnection() {
    this.showNotification("Testing connection...", "info");

    try {
      // Save current settings first
      this.saveAPISettings();

      // Test connection
      const result = await this.apiHandler.testConnection();

      if (result.success) {
        if (result.authMethod === "alternative") {
          this.showNotification(
            "Connection successful with alternative auth method! Check console for details.",
            "success",
          );
        } else {
          this.showNotification("Connection successful!", "success");
        }
      } else {
        if (
          result.error.includes("401") ||
          result.error.includes("Authorization")
        ) {
          this.showNotification(
            "Authorization failed! Possible issues: 1) API key expired/invalid 2) Wrong auth format - trying alternatives 3) Check API key and try again",
            "error",
          );
        } else {
          this.showNotification(`Connection failed: ${result.error}`, "error");
        }
      }
    } catch (error) {
      this.showNotification(
        `Connection test failed: ${error.message}`,
        "error",
      );
    }
  }

  async handleGenerate() {
    if (this.isGenerating) return;

    // Save current API settings
    this.saveAPISettings();

    // Validate configuration
    const errors = this.config.validateConfig();
    if (errors.length > 0) {
      this.showNotification(
        `Configuration errors: ${errors.join(", ")}`,
        "error",
      );
      return;
    }

    const concept = document.getElementById("character-concept").value.trim();
    const characterName = document
      .getElementById("character-name")
      .value.trim();
    const referenceImageDescription = document
      .getElementById("reference-image-description")
      ?.value?.trim();

    if (!concept) {
      this.showNotification("Please enter a character concept", "warning");
      return;
    }

    this.isGenerating = true;
    this.setGeneratingState(true);
    this.lorebookEntries = [];
    this.updateLorebookEntryCount();
    this.altGreetings = [];
    this.updateAltGreetingsCount();
    this.clearStream();

    try {
      // Show stream section
      const streamSection = document.querySelector(".stream-section");
      streamSection.style.display = "block";

      const pov = document.getElementById("pov-select").value;
      let effectiveConcept = concept;

      if (referenceImageDescription) {
        effectiveConcept += `\n\nReference appearance guidance:\n${referenceImageDescription}`;
      }

      const promptSaved = await this.savePromptToLibrary({
        concept,
        characterName,
        pov,
        lorebookData: this.lorebookData,
        referenceImageDescription: referenceImageDescription || "",
        referenceImageDataUrl: this.referenceImageDataUrl || "",
      });
      await this.refreshLibraryViews();
      if (!promptSaved) {
        this.showStreamMessage(
          "⚠️ Prompt could not be saved to local library.\n",
        );
      }

      // Generate character data with streaming
      this.showStreamMessage("🚀 Starting character generation...\n\n");
      this.currentCharacter = await this.characterGenerator.generateCharacter(
        effectiveConcept,
        characterName,
        (token, fullContent) => this.handleCharacterStream(token, fullContent),
        pov,
        this.lorebookData,
      );

      this.showStreamMessage("\n\n💬 Generating example messages...\n");
      await this.handleGenerateExampleMessages();

      // Store original for reset functionality
      this.originalCharacter = JSON.parse(
        JSON.stringify(this.currentCharacter),
      );
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();

      this.showStreamMessage("\n✅ Character generation complete!\n");

      // Display character
      this.displayCharacter();

      // Check if image generation is configured and enabled
      const imageApiBase = this.config.get("api.image.baseUrl");
      const imageApiKey = this.config.get("api.image.apiKey");
      const enableImageGeneration = this.config.get(
        "app.enableImageGeneration",
      );
      const hasReferenceImage = !!this.referenceImageDataUrl;

      if (hasReferenceImage) {
        this.currentImageUrl = this.referenceImageDataUrl;
        const imageContainer = document.getElementById("image-content");
        imageContainer.innerHTML = `
          <div class="image-container">
            <img src="${this.currentImageUrl}" alt="${this.currentCharacter.name || "Reference image"}" class="generated-image">
          </div>
        `;
        this.showStreamMessage(
          "🖼️ Using uploaded reference image as final card image (skipped image API generation)\n",
        );
      } else if (imageApiBase && imageApiKey && enableImageGeneration) {
        // Generate image with error handling
        try {
          this.showStreamMessage("🎨 Generating character image...\n");
          await this.generateImage();
          this.showStreamMessage("✅ Image generation complete!\n");
        } catch (imageError) {
          console.error("Image generation error:", imageError);
          this.showStreamMessage(
            `⚠️ Image generation failed: ${imageError.message}\n`,
          );
          this.showStreamMessage("📝 Continuing with character data only...\n");
          // Show placeholder with upload option
          const imageContainer = document.getElementById("image-content");
          imageContainer.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary);">
              <p>Image generation failed</p>
              <p style="font-size: 0.875rem; margin-top: 0.5rem; color: var(--error);">${imageError.message}</p>
              <p style="font-size: 0.875rem; margin-top: 0.5rem;">You can upload your own image</p>
            </div>
          `;
        }
      } else {
        this.showStreamMessage(
          "⏭️ Skipping image generation (image generation disabled or no API configured)\n",
        );
        // Show placeholder with upload option when image generation is disabled
        const imageContainer = document.getElementById("image-content");
        imageContainer.innerHTML = `
          <div style="text-align: center; padding: 2rem; color: var(--text-secondary);">
            <div style="font-size: 2rem; margin-bottom: 1rem;">🖼️</div>
            <p style="font-weight: 500; margin-bottom: 0.5rem;">Image Generation Disabled</p>
            <p style="font-size: 0.875rem; margin-bottom: 1rem;">Enable image generation in settings or upload your own image</p>
            <button onclick="document.getElementById('upload-image-btn').click()" style="padding: 0.5rem 1rem; background: var(--accent); color: white; border: none; border-radius: 0.375rem; cursor: pointer;">
              📁 Upload Image
            </button>
          </div>
        `;
      }

      // Show result section and image controls
      this.showResultSection();
      document.getElementById("image-controls").style.display = "block";

      // Always show prompt editor when image API is configured (regardless of generation setting)
      if (imageApiBase && imageApiKey) {
        const promptEditor = document.getElementById("image-prompt-editor");
        const customPromptTextarea = document.getElementById(
          "custom-image-prompt",
        );
        const referenceDescription = document
          .getElementById("reference-image-description")
          ?.value?.trim();

        if (promptEditor) {
          promptEditor.style.display = "block";

          if (
            customPromptTextarea &&
            referenceDescription &&
            !customPromptTextarea.value.trim()
          ) {
            customPromptTextarea.value = `Character portrait of ${this.currentCharacter.name || "the character"}, based on this reference description: ${referenceDescription}. High quality, detailed features, cinematic lighting, coherent anatomy, expressive face, fitting background.`;
            window.updatePromptCharCount();
          }

          if (
            customPromptTextarea &&
            window.apiHandler.lastGeneratedImagePrompt
          ) {
            // Use the previously generated prompt
            customPromptTextarea.value =
              window.apiHandler.lastGeneratedImagePrompt;
            // Update character counter
            window.updatePromptCharCount();
          } else if (
            !hasReferenceImage &&
            customPromptTextarea &&
            !customPromptTextarea.value.trim()
          ) {
            // Generate prompt only if needed and no reference image was provided.
            try {
              const defaultPrompt = await window.apiHandler.generateImagePrompt(
                this.currentCharacter.description,
                this.currentCharacter.name,
              );
              customPromptTextarea.value = defaultPrompt;
            } catch (error) {
              console.error("Failed to generate image prompt:", error);
              // Fall back to direct prompt building
              const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
                this.currentCharacter.description,
                this.currentCharacter.name,
              );
              customPromptTextarea.value = fallbackPrompt;
            }
            window.updatePromptCharCount();
          }
        }
      }

      this.showNotification("Character generated successfully!", "success");
    } catch (error) {
      console.error("Generation error:", error);

      // Check if this was a user-initiated stop
      const wasStoppedByUser = error.message.includes(
        "Generation stopped by user",
      );

      if (wasStoppedByUser) {
        this.showStreamMessage(`\n🛑 Generation stopped.\n`);
        // Don't show error notification for user-initiated stops
      } else {
        this.showStreamMessage(`❌ Error: ${error.message}\n`);
        this.showNotification(`Generation failed: ${error.message}`, "error");
      }

      // Hide result section if generation failed
      this.hideResultSection();
    } finally {
      this.isGenerating = false;
      this.setGeneratingState(false);

      // Auto-collapse the input section after generation
      const inputSectionDetails = document.getElementById("input-section-details");
      if (inputSectionDetails) {
        inputSectionDetails.open = false;
      }
    }
  }

  handleCharacterStream(token, fullContent) {
    // Append token to stream
    this.appendStreamContent(token);
  }

  showStreamMessage(message) {
    const streamContent = document.getElementById("stream-content");
    const messageElement = document.createElement("div");
    messageElement.textContent = message;
    streamContent.appendChild(messageElement);
    streamContent.scrollTop = streamContent.scrollHeight;
  }

  appendStreamContent(content) {
    const streamContent = document.getElementById("stream-content");

    // Remove placeholder if it exists
    const placeholder = streamContent.querySelector(".stream-placeholder");
    if (placeholder) {
      placeholder.remove();
    }

    // Check if last child is content container
    let contentContainer = streamContent.querySelector(".stream-content");
    if (!contentContainer) {
      contentContainer = document.createElement("div");
      contentContainer.className = "stream-content";
      streamContent.appendChild(contentContainer);
    }

    // Append new content
    contentContainer.textContent += content;
    streamContent.scrollTop = streamContent.scrollHeight;
  }

  clearStream() {
    const streamContent = document.getElementById("stream-content");
    streamContent.innerHTML =
      '<div class="stream-placeholder">Generation output will appear here...</div>';
  }

  async handleDownload() {
    if (!this.currentCharacter || !this.currentImageUrl) {
      this.showNotification("No character to download", "warning");
      return;
    }

    try {
      this.showNotification("Creating character card...", "info");

      // Get the current (possibly edited) character fields
      const nameInput = document.getElementById("character-generated-name");
      const descriptionTextarea = document.getElementById(
        "character-description",
      );
      const personalityTextarea = document.getElementById(
        "character-personality",
      );
      const scenarioTextarea = document.getElementById("character-scenario");
      const firstMessageTextarea = document.getElementById(
        "character-first-message",
      );
      const exampleMessagesOutput = document.getElementById(
        "example-messages-output",
      );

      // Update currentCharacter with edited content
      if (nameInput) {
        this.currentCharacter.name = nameInput.value.trim();
      }
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

      // Embed Lorebook in Character Object before export
      this.currentCharacter.character_book = this.buildCharacterBook();

      // Always convert from currentImageUrl to ensure we get the latest image
      // This ensures regenerated or uploaded images are properly included

      let imageBlob = await this.imageGenerator.convertToBlob(
        this.currentImageUrl,
      );

      // Use image as-is without resizing
      imageBlob = await this.imageGenerator.optimizeImageForCard(imageBlob);

      // Convert to Spec V2 format
      const specV2Data = this.characterGenerator.toSpecV2Format(
        this.currentCharacter,
      );

      // Create character card
      const cardBlob = await this.pngEncoder.createCharacterCard(
        imageBlob,
        specV2Data,
      );
      // You can uncomment this to see a preview modal before download
      /*
      const shouldDownload = confirm(
        "PNG created! Click OK to download, or Cancel to preview in console first.\n\n" +
        "Check the browser console for preview URLs."
      );
      if (!shouldDownload) {
        this.showNotification("Download cancelled", "info");
        return;
      }
      */

      // Download
      this.pngEncoder.downloadCharacterCard(
        cardBlob,
        this.currentCharacter.name,
      );

      const finalSize = this.imageGenerator.formatFileSize(cardBlob.size);
      this.showNotification(
        `Character card downloaded! Size: ${finalSize}`,
        "success",
      );
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
    } catch (error) {
      console.error("Download error:", error);
      this.showNotification(`Download failed: ${error.message}`, "error");
    }
  }

  async handleRegeneratePrompt() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      return;
    }

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    const promptEditor = document.getElementById("image-prompt-editor");

    if (!customPromptTextarea || !promptEditor) {
      this.showNotification("Prompt editor not found", "error");
      return;
    }

    try {
      this.showNotification("Regenerating image prompt...", "info");
      // Use AI to generate a detailed natural language prompt
      const newPrompt = await window.apiHandler.generateImagePrompt(
        this.currentCharacter.description,
        this.currentCharacter.name,
      );
      customPromptTextarea.value = newPrompt;
      // Update character counter
      window.updatePromptCharCount();
      this.showNotification("Image prompt regenerated!", "success");
    } catch (error) {
      console.error("Failed to regenerate image prompt:", error);
      // Fall back to direct prompt building
      const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
        this.currentCharacter.description,
        this.currentCharacter.name,
      );
      customPromptTextarea.value = fallbackPrompt;
      window.updatePromptCharCount();
      this.showNotification("Using fallback prompt generation", "warning");
    }

    // Ensure prompt editor is visible
    promptEditor.style.display = "block";
  }

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

    // Show the prompt editor and populate it with the default prompt
    const promptEditor = document.getElementById("image-prompt-editor");
    const customPromptTextarea = document.getElementById("custom-image-prompt");

    if (promptEditor && customPromptTextarea) {
      // Generate the default prompt if not already populated
      if (!customPromptTextarea.value.trim()) {
        try {
          this.showNotification("Generating image prompt...", "info");
          // Use AI to generate a detailed natural language prompt
          const defaultPrompt = await window.apiHandler.generateImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
          customPromptTextarea.value = defaultPrompt;
          // Update character counter
          window.updatePromptCharCount();
        } catch (error) {
          console.error("Failed to generate image prompt:", error);
          // Fall back to direct prompt building
          const fallbackPrompt = window.apiHandler.buildDirectImagePrompt(
            this.currentCharacter.description,
            this.currentCharacter.name,
          );
          customPromptTextarea.value = fallbackPrompt;
          // Update character counter
          window.updatePromptCharCount();
        }
      }
      promptEditor.style.display = "block";
    }

    try {
      this.showNotification("Regenerating image...", "info");
      await this.generateImage();
      this.showNotification("Image regenerated successfully!", "success");
    } catch (error) {
      console.error("Image regeneration error:", error);
      this.showNotification(
        `Image regeneration failed: ${error.message}`,
        "error",
      );
    }
  }

  async handleGenerateFourImages() {
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
    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    
    grid.innerHTML = "";
    loading.style.display = "block";

    try {
      // Get base prompt
      const customPromptTextarea = document.getElementById("custom-image-prompt");
      let basePrompt = customPromptTextarea?.value?.trim();

      if (!basePrompt) {
          try {
              basePrompt = await window.apiHandler.generateImagePrompt(
                  this.currentCharacter.description,
                  this.currentCharacter.name
              );
              if (customPromptTextarea) {
                  customPromptTextarea.value = basePrompt;
                  window.updatePromptCharCount();
              }
          } catch (e) {
              basePrompt = window.apiHandler.buildDirectImagePrompt(
                  this.currentCharacter.description,
                  this.currentCharacter.name
              );
          }
      }

      // Variations
      const variations = [
          basePrompt,
          basePrompt + ", alternative angle, cinematic lighting",
          basePrompt + ", close-up focus, highly detailed",
          basePrompt + ", dynamic composition, atmospheric"
      ];

      // Call API 4 times concurrently
      const promises = variations.map((promptVar, index) => 
          window.apiHandler.generateImage(
              this.currentCharacter.description,
              this.currentCharacter.name,
              promptVar
          ).then(async imageUrl => {
              // Convert to blob URL immediately
              let displayUrl = imageUrl;
              if (imageUrl && !imageUrl.startsWith("blob:") && !imageUrl.startsWith("data:")) {
                  const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
                  const response = await fetch(proxyUrl);
                  if (response.ok) {
                      const blob = await response.blob();
                      displayUrl = URL.createObjectURL(blob);
                  }
              }
              return { url: displayUrl, prompt: promptVar, index };
          }).catch(err => {
              console.error(`Image variation ${index} failed:`, err);
              return null;
          })
      );

      const results = await Promise.all(promises);
      loading.style.display = "none";

      const validResults = results.filter(r => r !== null);
      if (validResults.length === 0) {
          throw new Error("All image generations failed.");
      }

      validResults.forEach(res => {
          const wrapper = document.createElement("div");
          wrapper.style.cursor = "pointer";
          wrapper.style.border = "2px solid transparent";
          wrapper.style.borderRadius = "0.5rem";
          wrapper.style.overflow = "hidden";
          wrapper.style.transition = "border-color 0.2s";
          wrapper.style.backgroundColor = "var(--surface-color)";
          
          wrapper.onmouseenter = () => wrapper.style.border = "2px solid var(--accent)";
          wrapper.onmouseleave = () => wrapper.style.border = "2px solid transparent";
          
          wrapper.onclick = () => this.selectImageOption(res.url, res.prompt, validResults);

          wrapper.innerHTML = `<img src="${res.url}" style="width: 100%; height: auto; display: block;" alt="Option ${res.index + 1}">`;
          grid.appendChild(wrapper);
      });
      this.showNotification(`Generated ${validResults.length} image options!`, "success");

    } catch (error) {
      loading.style.display = "none";
      this.showNotification(`Failed to generate images: ${error.message}`, "error");
    }
  }

  openImageOptionsModal() {
      const modal = document.getElementById("image-options-modal");
      if (modal) {
          modal.classList.add("show");
          document.body.style.overflow = "hidden";
      }
  }

  closeImageOptionsModal() {
      const modal = document.getElementById("image-options-modal");
      if (modal) {
          modal.classList.remove("show");
          document.body.style.overflow = "";
      }
  }

  async selectImageOption(selectedUrl, selectedPrompt, allResults) {
      this.closeImageOptionsModal();
      
      if (this.currentImageUrl && this.currentImageUrl.startsWith("blob:") && this.currentImageUrl !== selectedUrl) {
        URL.revokeObjectURL(this.currentImageUrl);
      }

      this.currentImageUrl = selectedUrl;
      
      allResults.forEach(res => {
          if (res.url !== selectedUrl && res.url.startsWith("blob:")) {
              URL.revokeObjectURL(res.url);
          }
      });

      const imageContainer = document.getElementById("image-content");
      if (imageContainer) {
          imageContainer.innerHTML = window.imageGenerator.formatImageForDisplay(selectedUrl);
      }

      const customPromptTextarea = document.getElementById("custom-image-prompt");
      if (customPromptTextarea) {
          customPromptTextarea.value = selectedPrompt;
          window.updatePromptCharCount();
      }

      this.showNotification("Image selected and saved to card!", "success");
      
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
  }

  async generateImage() {
    const imageContainer = document.getElementById("image-content");

    // Check if user has provided a custom prompt
    const customPromptTextarea = document.getElementById("custom-image-prompt");
    const customPrompt = customPromptTextarea?.value?.trim();
    const referenceImageDescription = document
      .getElementById("reference-image-description")
      ?.value?.trim();

    // Update character counter
    window.updatePromptCharCount();

    // Clean up previous blob URL if it exists
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

    // Extract URL from the result object
    this.currentImageUrl = imageResult.url || imageResult;

    // If no custom prompt was provided, populate textarea with auto-generated prompt
    if (
      !customPrompt &&
      customPromptTextarea &&
      window.apiHandler.lastGeneratedImagePrompt
    ) {
      customPromptTextarea.value = window.apiHandler.lastGeneratedImagePrompt;
      console.log("Updated custom prompt textarea with auto-generated prompt");
    }

    // Note: We don't store blob here anymore - download converts fresh from URL
    // This ensures regenerated images are properly included in downloads
  }

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
  }

  async handleRegenerateField(field) {
    if (!this.currentCharacter) return;

    let promptInputId, btnId, textAreaId;
    switch(field) {
      case 'description': promptInputId = 'description-prompt'; btnId = 'regenerate-description-btn'; textAreaId = 'character-description'; break;
      case 'personality': promptInputId = 'personality-prompt'; btnId = 'regenerate-personality-btn'; textAreaId = 'character-personality'; break;
      case 'scenario': promptInputId = 'scenario-prompt'; btnId = 'regenerate-scenario-btn'; textAreaId = 'character-scenario'; break;
      case 'firstMessage': promptInputId = 'first-message-prompt'; btnId = 'regenerate-first-message-btn'; textAreaId = 'character-first-message'; break;
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
      const newValue = await window.apiHandler.regenerateField(this.currentCharacter, field, customPrompt, pov);

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
  }

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

    // Reset the field value
    textarea.value = originalValue || "";
    this.currentCharacter[field] = originalValue || "";

    // Hide reset button
    resetBtn.style.display = "none";

    this.showNotification(`${fieldName} reset to original`, "success");
  }

  async handleDownloadJSON() {
    if (!this.currentCharacter) {
      this.showNotification("No character to download", "warning");
      return;
    }

    try {
      this.showNotification("Preparing character JSON...", "info");

      // Get the current (possibly edited) character fields
      const nameInput = document.getElementById("character-generated-name");
      const descriptionTextarea = document.getElementById(
        "character-description",
      );
      const personalityTextarea = document.getElementById(
        "character-personality",
      );
      const scenarioTextarea = document.getElementById("character-scenario");
      const firstMessageTextarea = document.getElementById(
        "character-first-message",
      );
      const exampleMessagesOutput = document.getElementById(
        "example-messages-output",
      );

      // Update currentCharacter with edited content
      if (nameInput) {
        this.currentCharacter.name = nameInput.value.trim();
      }
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

      // Embed Lorebook in Character Object before export
      this.currentCharacter.character_book = this.buildCharacterBook();

      // Convert to Spec V2 format
      const specV2Data = this.characterGenerator.toSpecV2Format(
        this.currentCharacter,
      );

      // Create JSON string with nice formatting
      const jsonString = JSON.stringify(specV2Data, null, 2);

      // Create blob and download
      const blob = new Blob([jsonString], { type: "application/json" });
      this.downloadBlob(
        blob,
        `${this.currentCharacter.name || "character"}_data.json`,
      );

      this.showNotification(
        "Character JSON downloaded successfully!",
        "success",
      );
      await this.saveCardToLibrary();
      await this.refreshLibraryViews();
    } catch (error) {
      console.error("Error downloading JSON:", error);
      this.showNotification("Failed to download JSON", "error");
    }
  }

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

    // Update currentCharacter with the edited content
    this.currentCharacter[currentField] = textarea.value;

    // Show/hide reset button based on whether content has changed
    const currentContent = textarea.value.trim();
    const originalContent = (originalValue || "").trim();

    if (currentContent !== originalContent) {
      resetBtn.style.display = "block";
    } else {
      resetBtn.style.display = "none";
    }
  }

  async handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!this.currentCharacter) {
      this.showNotification("Please generate a character first", "warning");
      event.target.value = ""; // Reset input
      return;
    }

    try {
      // Validate image file
      if (!file.type.startsWith("image/")) {
        throw new Error("Please select an image file");
      }

      // Clean up previous blob URL if it exists
      if (this.currentImageUrl && this.currentImageUrl.startsWith("blob:")) {
        URL.revokeObjectURL(this.currentImageUrl);
        console.log("🗑️ Revoked previous blob URL:", this.currentImageUrl);
      }

      // Create object URL for the uploaded image
      this.currentImageUrl = URL.createObjectURL(file);

      // Display the uploaded image
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
      event.target.value = ""; // Reset input
    }
  }

  // Helper method to download blobs
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  handleRegenerate() {
    // Instead of just clearing, automatically trigger generation again
    this.hideResultSection();
    this.clearStream();
    const streamSection = document.querySelector(".stream-section");
    streamSection.style.display = "none";
    this.currentCharacter = null;
    this.currentImageUrl = null;
    this.lorebookEntries = [];
    this.updateLorebookEntryCount();
    this.altGreetings = [];
    this.updateAltGreetingsCount();
    document.getElementById("image-controls").style.display = "none";

    // Clear image content and prompt editor
    const imageContent = document.getElementById("image-content");
    const promptEditor = document.getElementById("image-prompt-editor");
    const customPromptTextarea = document.getElementById("custom-image-prompt");

    if (imageContent) {
      imageContent.innerHTML = `
        <div class="image-placeholder">
          <div class="loading-spinner"></div>
        </div>
      `;
    }

    if (promptEditor) {
      promptEditor.style.display = "none";
    }

    if (customPromptTextarea) {
      customPromptTextarea.value = "";
      window.updatePromptCharCount();
    }

    const nameInput = document.getElementById("character-generated-name");
    if (nameInput) {
      nameInput.value = "";
    }

    const promptsToClear = ['description-prompt', 'personality-prompt', 'scenario-prompt', 'first-message-prompt'];
    promptsToClear.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });

    const exampleMessagesPrompt = document.getElementById("example-messages-prompt");
    if (exampleMessagesPrompt) {
      exampleMessagesPrompt.value = "";
    }

    // Auto-trigger generation with the same inputs
    const concept = document.getElementById("character-concept").value.trim();
    if (concept) {
      this.showNotification("Regenerating character...", "info");
      // Small delay to allow UI to update
      setTimeout(() => {
        this.handleGenerate();
      }, 100);
    } else {
      // If no concept, just focus on the input
      document.getElementById("character-concept").focus();
      this.showNotification(
        "Please enter a character concept first",
        "warning",
      );
    }
  }

  setGeneratingState(isGenerating) {
    const generateBtn = document.getElementById("generate-btn");
    const stopBtn = document.getElementById("stop-btn");
    const btnText = generateBtn.querySelector(".btn-text");
    const btnLoading = generateBtn.querySelector(".btn-loading");

    if (isGenerating) {
      generateBtn.disabled = true;
      btnText.style.display = "none";
      btnLoading.style.display = "inline";
      stopBtn.style.display = "inline-block";
    } else {
      generateBtn.disabled = false;
      btnText.style.display = "inline";
      btnLoading.style.display = "none";
      stopBtn.style.display = "none";
    }
  }

  setRevisionState(isRevising) {
    this.isRevising = isRevising;
    const reviseBtn = document.getElementById("revise-character-btn");
    const stopBtn = document.getElementById("stop-revision-btn");
    const btnText = reviseBtn?.querySelector(".btn-text");
    const btnLoading = reviseBtn?.querySelector(".btn-loading");

    if (!reviseBtn || !stopBtn) return;

    if (isRevising) {
      reviseBtn.disabled = true;
      if (btnText) btnText.style.display = "none";
      if (btnLoading) btnLoading.style.display = "inline";
      stopBtn.style.display = "inline-block";
    } else {
      reviseBtn.disabled = false;
      if (btnText) btnText.style.display = "inline";
      if (btnLoading) btnLoading.style.display = "none";
      stopBtn.style.display = "none";
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

  displayCharacter() {
    // Update all character fields
    const nameInput = document.getElementById("character-generated-name");
    const descriptionTextarea = document.getElementById(
      "character-description",
    );
    const personalityTextarea = document.getElementById(
      "character-personality",
    );
    const scenarioTextarea = document.getElementById("character-scenario");
    const firstMessageTextarea = document.getElementById(
      "character-first-message",
    );

    if (nameInput) nameInput.value = this.currentCharacter.name || "";
    descriptionTextarea.value = this.currentCharacter.description || "";
    personalityTextarea.value = this.currentCharacter.personality || "";
    scenarioTextarea.value = this.currentCharacter.scenario || "";
    firstMessageTextarea.value = this.currentCharacter.firstMessage || "";

    // Hide all reset buttons initially (will show if user edits)
    const resetNameBtn = document.getElementById("reset-name-btn");
    const resetDescriptionBtn = document.getElementById(
      "reset-description-btn",
    );
    const resetPersonalityBtn = document.getElementById(
      "reset-personality-btn",
    );
    const resetScenarioBtn = document.getElementById("reset-scenario-btn");
    const resetFirstMessageBtn = document.getElementById(
      "reset-first-message-btn",
    );

    if (resetNameBtn) resetNameBtn.style.display = "none";
    if (resetDescriptionBtn) resetDescriptionBtn.style.display = "none";
    if (resetPersonalityBtn) resetPersonalityBtn.style.display = "none";
    if (resetScenarioBtn) resetScenarioBtn.style.display = "none";
    if (resetFirstMessageBtn) resetFirstMessageBtn.style.display = "none";

    // Reset example messages section for new character
    const exampleMessagesOutput = document.getElementById(
      "example-messages-output",
    );
    if (exampleMessagesOutput) {
      if (this.currentCharacter.mesExample) {
        if (exampleMessagesOutput.tagName === "TEXTAREA" || exampleMessagesOutput.tagName === "INPUT") {
          exampleMessagesOutput.value = this.currentCharacter.mesExample;
        } else {
          exampleMessagesOutput.textContent = this.currentCharacter.mesExample;
        }
        exampleMessagesOutput.style.display = "block";
      } else {
        if (exampleMessagesOutput.tagName === "TEXTAREA" || exampleMessagesOutput.tagName === "INPUT") {
          exampleMessagesOutput.value = "";
        } else {
          exampleMessagesOutput.textContent = "";
        }
        exampleMessagesOutput.style.display = "none";
      }
    }

    // Show JSON download button whenever character data is available
    const downloadJsonBtn = document.getElementById("download-json-btn");
    if (downloadJsonBtn) {
      downloadJsonBtn.style.display = "inline-flex";
    }
  }

  async handleSaveCardManual() {
    if (!this.currentCharacter) {
      this.showNotification("No character to save", "warning");
      return;
    }
    this.showNotification("Saving card to permanent library...", "info");
    await this.saveCardToLibrary(true); // true = permanent save
    await this.refreshLibraryViews();
    this.showNotification("Card saved permanently!", "success");
  }

  showResultSection() {
    const resultSection = document.querySelector(".result-section");
    const downloadBtn = document.getElementById("download-btn");
    const downloadJsonBtn = document.getElementById("download-json-btn");
    const saveCardBtn = document.getElementById("save-card-btn");

    resultSection.style.display = "block";
    downloadBtn.style.display = "inline-flex";

    // Show JSON download button when character data is available
    if (downloadJsonBtn && this.currentCharacter) {
      downloadJsonBtn.style.display = "inline-flex";
    }
    if (saveCardBtn && this.currentCharacter) {
      saveCardBtn.style.display = "inline-flex";
    }

    // Smooth scroll to results
    resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  hideResultSection() {
    const resultSection = document.querySelector(".result-section");
    const downloadBtn = document.getElementById("download-btn");
    const downloadJsonBtn = document.getElementById("download-json-btn");
    const saveCardBtn = document.getElementById("save-card-btn");

    resultSection.style.display = "none";
    downloadBtn.style.display = "none";
    if (downloadJsonBtn) downloadJsonBtn.style.display = "none";
    if (saveCardBtn) saveCardBtn.style.display = "none";
  }

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
  }

  async prepareReferenceImageForVision(file) {
    const sourceDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () =>
        reject(new Error("Failed to read reference image file"));
      reader.readAsDataURL(file);
    });

    // Resize/compress before sending to vision to avoid payload-too-large errors.
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
  }

  updateReferenceImagePreview(dataUrl) {
    const preview = document.getElementById("reference-image-preview");
    if (!preview) return;

    preview.style.display = "block";
    preview.innerHTML = `<img src="${dataUrl}" alt="Reference image" style="width: 100%; display: block;" />`;
  }

  normalizeCharacterFromSpec(specData) {
    if (specData?.data) {
      return {
        name: specData.data.name || "Unnamed Character",
        description: specData.data.description || "",
        personality: specData.data.personality || "",
        scenario: specData.data.scenario || "",
        firstMessage: specData.data.first_mes || "",
        mesExample: specData.data.mes_example || "",
      };
    }

    return {
      name: specData.name || "Unnamed Character",
      description: specData.description || "",
      personality: specData.personality || "",
      scenario: specData.scenario || "",
      firstMessage: specData.firstMessage || specData.first_mes || "",
      mesExample: specData.mesExample || specData.mes_example || "",
    };
  }

  async handleImportCard(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      let characterData = null;
      let importedImageUrl = "";

      if (
        file.type === "image/png" ||
        file.name.toLowerCase().endsWith(".png")
      ) {
        const extracted = await this.pngEncoder.extractCharacterData(file);
        characterData = this.normalizeCharacterFromSpec(extracted);
        importedImageUrl = URL.createObjectURL(file);
      } else {
        const text = await file.text();
        const parsed = JSON.parse(text);
        characterData = this.normalizeCharacterFromSpec(parsed);
      }

      if (!characterData) {
        throw new Error("Unable to parse card content");
      }

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
      await this.saveCardToLibrary();
      
      if (characterData.character_book && characterData.character_book.entries) {
        this.lorebookEntries = characterData.character_book.entries.map(e => ({
          id: e.id || Date.now().toString() + Math.random().toString().slice(2, 5),
          keys: e.keys || [],
          content: e.content || "",
          enabled: e.enabled !== false
        }));
      } else {
        this.lorebookEntries = [];
      }
      this.updateLorebookEntryCount();

      if (characterData.alternateGreetings) {
        this.altGreetings = characterData.alternateGreetings.map((content, i) => ({
          id: Date.now().toString() + i,
          content
        }));
      } else {
        this.altGreetings = [];
      }
      this.updateAltGreetingsCount();

      await this.refreshLibraryViews();
      this.showNotification("Card imported for editing", "success");
    } catch (error) {
      console.error("Card import failed:", error);
      this.showNotification(`Card import failed: ${error.message}`, "error");
    } finally {
      event.target.value = "";
    }
  }

  async handleReviseCharacter() {
    if (!this.currentCharacter) {
      this.showNotification("Generate or import a character first", "warning");
      return;
    }

    const revisionInstruction = document
      .getElementById("revision-instruction")
      ?.value?.trim();
    if (!revisionInstruction) {
      this.showNotification("Enter a revision request first", "warning");
      return;
    }

    this.setRevisionState(true);

    try {
      const pov = document.getElementById("pov-select")?.value || "third";
      this.showNotification("Applying AI revision...", "info");
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
      this.showNotification("Character revised successfully", "success");
    } catch (error) {
      console.error("Revision failed:", error);
      const wasStoppedByUser = error.message.includes("Generation stopped by user");
      if (!wasStoppedByUser) {
        this.showNotification(`Revision failed: ${error.message}`, "error");
      }
    } finally {
      this.setRevisionState(false);
    }
  }

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
      const customPrompt = document.getElementById("example-messages-prompt")?.value?.trim() || "";
      const examples = await this.apiHandler.generateExampleMessages(
        this.currentCharacter,
        count,
        pov,
        customPrompt
      );

      // Replace existing examples
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
    } catch (error) {
      console.error("Example generation failed:", error);
      if (outputDiv.tagName === "TEXTAREA" || outputDiv.tagName === "INPUT") {
        outputDiv.value = `⚠️ Generation failed: ${error.message}`;
      } else {
        outputDiv.textContent = `⚠️ Generation failed: ${error.message}`;
      }
    }
  }

  openLorebookManager() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate or import a character first.", "warning");
      return;
    }
    const modal = document.getElementById("lorebook-manager-modal");
    if (modal) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
      this.renderLorebookEntries();
      this.resetLorebookEditor();
    }
  }

  closeLorebookManager() {
    const modal = document.getElementById("lorebook-manager-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  }

  updateLorebookEntryCount() {
      const countEl = document.getElementById("lorebook-entry-count");
      if (countEl) {
          const count = this.lorebookEntries.length;
          countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
      }
  }

  renderLorebookEntries() {
    const listEl = document.getElementById("lorebook-entries-list");
    if (!listEl) return;

    if (this.lorebookEntries.length === 0) {
      listEl.innerHTML = '<p class="library-empty">No lorebook entries yet.</p>';
      return;
    }

    listEl.innerHTML = this.lorebookEntries.map(entry => `
      <div class="library-item" style="align-items: flex-start;">
        <div style="flex: 1;">
          <div class="library-item-title" style="margin-bottom: 0.5rem;">${entry.keys.join(', ')}</div>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin: 0; white-space: pre-wrap; max-height: 60px; overflow: hidden; text-overflow: ellipsis;">${entry.content}</p>
        </div>
        <div class="library-item-actions">
          <button class="btn-small" data-action="edit-lorebook-entry" data-id="${entry.id}">Edit</button>
          <button class="btn-small" data-action="delete-lorebook-entry" data-id="${entry.id}">Delete</button>
        </div>
      </div>
    `).join('');
  }

  resetLorebookEditor() {
    document.getElementById('lorebook-editor-title').textContent = 'Add New Entry';
    document.getElementById('lorebook-entry-id').value = '';
    document.getElementById('lorebook-entry-keys').value = '';
    document.getElementById('lorebook-entry-content').value = '';
    const hintInput = document.getElementById('lorebook-entry-hint');
    if (hintInput) hintInput.value = '';
    document.getElementById('cancel-lorebook-edit-btn').style.display = 'none';
  }

  async handleSuggestLorebookTopics() {
    const btn = document.getElementById("suggest-lorebook-topics-btn");
    const suggestionsContainer = document.getElementById("lorebook-topic-suggestions");
    if (!this.currentCharacter || !btn || !suggestionsContainer) return;

    btn.disabled = true;
    btn.textContent = "Suggesting...";
    suggestionsContainer.innerHTML = '';

    try {
      const topics = await this.lorebookGenerator.suggestTopics(this.currentCharacter);
      if (topics && topics.length > 0) {
        suggestionsContainer.innerHTML = topics.map(topic =>
          `<button class="btn-small topic-suggestion" style="background: var(--surface-color);">${topic}</button>`
        ).join('');
      } else {
        suggestionsContainer.innerHTML = '<p style="font-size: 0.875rem; color: var(--text-secondary);">No suggestions found.</p>';
      }
    } catch (error) {
      this.showNotification(`Failed to get suggestions: ${error.message}`, "error");
      suggestionsContainer.innerHTML = `<p style="font-size: 0.875rem; color: var(--error);">Error fetching suggestions.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Suggest Topics from Card";
    }
  }

  async handleGenerateLorebookContent() {
    const btn = document.getElementById("generate-lorebook-content-btn");
    const keysInput = document.getElementById("lorebook-entry-keys");
    const contentTextarea = document.getElementById("lorebook-entry-content");
    const hintInput = document.getElementById("lorebook-entry-hint");
    if (!this.currentCharacter || !btn || !keysInput || !contentTextarea) return;

    const keys = keysInput.value.trim();
    const hint = hintInput ? hintInput.value.trim() : "";
    if (!keys) {
      this.showNotification("Please provide at least one key for the entry.", "warning");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Generating...";
    contentTextarea.value = "Generating content with AI...";

    try {
      const content = await this.lorebookGenerator.generateEntryContent(this.currentCharacter, keys, hint);
      contentTextarea.value = content;
    } catch (error) {
      this.showNotification(`Failed to generate content: ${error.message}`, "error");
      contentTextarea.value = `Error: ${error.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = "🔄 Generate with AI";
    }
  }

  handleSaveLorebookEntry() {
    const id = document.getElementById('lorebook-entry-id').value;
    const keys = document.getElementById('lorebook-entry-keys').value.trim();
    const content = document.getElementById('lorebook-entry-content').value.trim();

    if (!keys || !content) {
      this.showNotification("Keys and content cannot be empty.", "warning");
      return;
    }

    const keysArray = keys.split(',').map(k => k.trim()).filter(Boolean);

    if (id) { // Editing existing
      const index = this.lorebookEntries.findIndex(e => e.id == id);
      if (index > -1) {
        this.lorebookEntries[index] = { ...this.lorebookEntries[index], keys: keysArray, content };
      }
    } else { // Adding new
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
    this.currentCharacter.character_book = this.buildCharacterBook(); // Sync to character data
    this.saveCardToLibrary(); // Save changes silently to the local library
    this.showNotification("Lorebook entry saved successfully!", "success");
  }

  async savePromptToLibrary(promptData) {
    if (!this.storageReady || !this.storage) return false;
    try {
      const normalized = this.preparePromptRecordForStorage(promptData);
      const fingerprint = [
        normalized.concept || "",
        normalized.characterName || "",
        normalized.pov || "",
        normalized.referenceImageDescription || "",
      ].join("::");

      const existingPrompts = await this.storage.listPrompts();
      const existing = existingPrompts.find(
        (entry) => entry.fingerprint === fingerprint,
      );

      const { _trimmedFields, ...promptRecord } = normalized;
      const fullRecord = {
        ...promptRecord,
        fingerprint,
      };
      if (Number.isInteger(existing?.id) && existing.id > 0) {
        fullRecord.id = existing.id;
      }
      await this.storage.savePrompt(fullRecord);

      if (_trimmedFields?.length) {
        this.showNotification(
          `Prompt saved. Omitted large ${_trimmedFields.join(" and ")} snapshot for storage safety.`,
          "warning",
        );
      }
      return true;
    } catch (error) {
      console.error("Failed to save prompt (full record):", error);

      // Retry with minimal payload so prompts still persist even if optional
      // lorebook/reference snapshots exceed storage limits.
      try {
        const minimal = this.preparePromptRecordForStorage(promptData, {
          minimal: true,
        });
        const fingerprint = [
          minimal.concept || "",
          minimal.characterName || "",
          minimal.pov || "",
          minimal.referenceImageDescription || "",
        ].join("::");

        const existingPrompts = await this.storage.listPrompts();
        const existing = existingPrompts.find(
          (entry) => entry.fingerprint === fingerprint,
        );

        const { _trimmedFields, ...minimalRecord } = minimal;
        const retryRecord = {
          ...minimalRecord,
          fingerprint,
        };
        if (Number.isInteger(existing?.id) && existing.id > 0) {
          retryRecord.id = existing.id;
        }
        await this.storage.savePrompt(retryRecord);

        this.showNotification(
          "Prompt saved in compact mode (large context omitted).",
          "warning",
        );
        return true;
      } catch (retryError) {
        console.error("Failed to save prompt (compact retry):", retryError);
        this.updateLibraryStatus(
          "Failed to save prompt. Check browser storage permissions.",
        );
        return false;
      }
    }
  }

  preparePromptRecordForStorage(promptData, options = {}) {
    const minimal = Boolean(options.minimal);
    const maxEmbeddedChars = 400000;

    const safe = {
      concept: promptData?.concept || "",
      characterName: promptData?.characterName || "",
      pov: promptData?.pov || "third",
      referenceImageDescription: promptData?.referenceImageDescription || "",
      referenceImageDataUrl: "",
      lorebookData: null,
      _trimmedFields: [],
    };

    if (minimal) {
      return safe;
    }

    const referenceImageDataUrl = promptData?.referenceImageDataUrl || "";
    if (referenceImageDataUrl) {
      if (referenceImageDataUrl.length <= maxEmbeddedChars) {
        safe.referenceImageDataUrl = referenceImageDataUrl;
      } else {
        safe._trimmedFields.push("reference-image");
      }
    }

    if (promptData?.lorebookData) {
      try {
        const lorebookJson = JSON.stringify(promptData.lorebookData);
        if (lorebookJson.length <= maxEmbeddedChars) {
          safe.lorebookData = JSON.parse(lorebookJson);
        } else {
          safe._trimmedFields.push("lorebook");
        }
      } catch (error) {
        safe._trimmedFields.push("lorebook");
      }
    }

    return safe;
  }

  async saveCardToLibrary(isPermanent = false) {
    if (!this.storageReady || !this.storage || !this.currentCharacter) return;

    try {
      let imageBlob = null;
      if (this.currentImageUrl) {
        try {
          imageBlob = await this.imageGenerator.convertToBlob(
            this.currentImageUrl,
          );
        } catch (error) {
          console.warn("Skipping image blob save:", error.message);
        }
      }

      await this.storage.saveCard({
        characterName: this.currentCharacter.name || "Unnamed Character",
        character: JSON.parse(JSON.stringify(this.currentCharacter)),
        imageBlob,
        isPermanent
      });

      // Prune history (temp cards) to keep only the last 30
      if (!isPermanent) {
        const allCards = await this.storage.listCards();
        const tempCards = allCards.filter(c => !c.isPermanent);
        if (tempCards.length > 30) {
          // Sort oldest first
          tempCards.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
          const toDelete = tempCards.slice(0, tempCards.length - 30);
          for (const card of toDelete) {
            await this.storage.deleteCard(card.id);
          }
        }
      }
    } catch (error) {
      console.error("Failed to save card:", error);
    }
  }

  formatLibraryTime(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return date.toLocaleString();
  }

  async refreshLibraryViews() {
    if (!this.storageReady || !this.storage) {
      this.renderStorageUnavailableState();
      return;
    }

    try {
      const [prompts, cards] = await Promise.all([
        this.storage.listPrompts(),
        this.storage.listCards(),
      ]);

      const promptList = document.getElementById("stored-prompts-list");
      const cardList = document.getElementById("stored-cards-list");
      const historyList = document.getElementById("history-cards-list");

      if (promptList) {
        if (!prompts.length) {
          promptList.innerHTML =
            '<p class="library-empty">No saved prompts yet.</p>';
        } else {
          promptList.innerHTML = prompts
            .map((prompt) => {
              const promptPreview = prompt.concept ? `"${prompt.concept.substring(0, 30).replace(/\n/g, ' ')}${prompt.concept.length > 30 ? '...' : ''}"` : "(No concept)";
              const titleName = prompt.characterName || promptPreview;
              return `
                <div class="library-item">
                  <div class="library-item-title">${titleName} - ${prompt.pov || "third"} POV</div>
                  <div class="library-item-date">${this.formatLibraryTime(prompt.updatedAt)}</div>
                  <div class="library-item-actions">
                    <button class="btn-small" data-action="load-prompt" data-id="${prompt.id}">Load</button>
                    <button class="btn-small" data-action="delete-prompt" data-id="${prompt.id}">Delete</button>
                  </div>
                </div>
              `})
            .join("");
        }
      }

      const permanentCards = cards.filter(c => c.isPermanent);
      const tempCards = cards.filter(c => !c.isPermanent);

      if (cardList) {
        if (!permanentCards.length) {
          cardList.innerHTML =
            '<p class="library-empty">No permanent cards yet.</p>';
        } else {
          cardList.innerHTML = permanentCards
            .map(
              (card) => `
                <div class="library-item">
                  <div class="library-item-title">${card.characterName || "Unnamed Character"}</div>
                  <div class="library-item-date">${this.formatLibraryTime(card.updatedAt)}</div>
                  <div class="library-item-actions">
                    <button class="btn-small" data-action="load-card" data-id="${card.id}">Load</button>
                    <button class="btn-small" data-action="delete-card" data-id="${card.id}">Delete</button>
                  </div>
                </div>
              `,
            )
            .join("");
        }
      }

      if (historyList) {
        if (!tempCards.length) {
          historyList.innerHTML =
            '<p class="library-empty">No history available.</p>';
        } else {
          historyList.innerHTML = tempCards
            .map(
              (card) => `
                <div class="library-item">
                  <div class="library-item-title">${card.characterName || "Unnamed Character"}</div>
                  <div class="library-item-date">${this.formatLibraryTime(card.updatedAt)}</div>
                  <div class="library-item-actions">
                    <button class="btn-small" data-action="load-card" data-id="${card.id}">Load</button>
                    <button class="btn-small" data-action="delete-card" data-id="${card.id}">Delete</button>
                  </div>
                </div>
              `,
            )
            .join("");
        }
      }

      this.updateLibraryStatus(
        `Saved ${prompts.length} prompt(s), ${permanentCards.length} permanent card(s), and ${tempCards.length} history item(s).`,
      );
    } catch (error) {
      console.error("Failed to refresh IndexedDB library view:", error);
      this.updateLibraryStatus("Failed to load local library.");
    }
  }

  renderStorageUnavailableState() {
    const promptList = document.getElementById("stored-prompts-list");
    const cardList = document.getElementById("stored-cards-list");
    const historyList = document.getElementById("history-cards-list");
    const message =
      '<p class="library-empty">Local storage is unavailable in this browser/session.</p>';

    if (promptList) {
      promptList.innerHTML = message;
    }
    if (cardList) {
      cardList.innerHTML = message;
    }
    if (historyList) {
      historyList.innerHTML = message;
    }
  }

  updateLibraryStatus(text) {
    const status = document.getElementById("library-status");
    if (status) {
      status.textContent = text;
    }
  }

  async handleLibraryPromptClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;

    const action = actionElement.dataset.action;
    const id = Number(actionElement.dataset.id);

    try {
      if (action === "load-prompt") {
        const prompt = await this.storage.getPrompt(id);
        if (!prompt) return;
        document.getElementById("character-concept").value =
          prompt.concept || "";
        document.getElementById("character-name").value =
          prompt.characterName || "";
        document.getElementById("pov-select").value = prompt.pov || "third";
        const refDescription = document.getElementById(
          "reference-image-description",
        );
        if (refDescription) {
          refDescription.value = prompt.referenceImageDescription || "";
        }
        if (prompt.referenceImageDataUrl) {
          this.referenceImageDataUrl = prompt.referenceImageDataUrl;
          this.updateReferenceImagePreview(prompt.referenceImageDataUrl);
        }
        this.lorebookData = prompt.lorebookData || null;
        this.showNotification("Prompt loaded", "success");
      } else if (action === "delete-prompt") {
        await this.storage.deletePrompt(id);
        await this.refreshLibraryViews();
        this.showNotification("Prompt deleted", "info");
      }
    } catch (error) {
      console.error("Prompt library action failed:", error);
      this.showNotification("Prompt action failed", "error");
    }
  }

  async handleLibraryCardClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;

    const action = actionElement.dataset.action;
    const id = Number(actionElement.dataset.id);

    try {
      if (action === "load-card") {
        const card = await this.storage.getCard(id);
        if (!card?.character) return;
        this.currentCharacter = card.character;
        this.originalCharacter = JSON.parse(JSON.stringify(card.character));
        this.displayCharacter();
        this.showResultSection();
        document.getElementById("image-controls").style.display = "block";

        if (card.imageBlob instanceof Blob) {
          if (
            this.currentImageUrl &&
            this.currentImageUrl.startsWith("blob:")
          ) {
            URL.revokeObjectURL(this.currentImageUrl);
          }
          this.currentImageUrl = URL.createObjectURL(card.imageBlob);
          const imageContainer = document.getElementById("image-content");
          imageContainer.innerHTML = `
            <div class="image-container">
              <img src="${this.currentImageUrl}" alt="${card.character.name || "Character"}" class="generated-image">
            </div>
          `;
        }
        this.showNotification("Card loaded", "success");
      } else if (action === "delete-card") {
        await this.storage.deleteCard(id);
        await this.refreshLibraryViews();
        this.showNotification("Card deleted", "info");
      }
    } catch (error) {
      console.error("Card library action failed:", error);
      this.showNotification("Card action failed", "error");
    }
  }

  handleEditLorebookEntry(id) {
    const entry = this.lorebookEntries.find(e => e.id == id);
    if (!entry) return;

    document.getElementById('lorebook-editor-title').textContent = 'Edit Entry';
    document.getElementById('lorebook-entry-id').value = entry.id;
    document.getElementById('lorebook-entry-keys').value = entry.keys.join(', ');
    document.getElementById('lorebook-entry-content').value = entry.content;
    const hintInput = document.getElementById('lorebook-entry-hint');
    if (hintInput) hintInput.value = '';
    document.getElementById('cancel-lorebook-edit-btn').style.display = 'inline-block';
    document.getElementById('lorebook-entry-editor').scrollIntoView({ behavior: 'smooth' });
  }

  buildCharacterBook() {
    if (!this.lorebookEntries || this.lorebookEntries.length === 0) return undefined;
    
    return {
      name: `${this.currentCharacter?.name || 'Character'} Lorebook`,
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
        id: parseInt(entry.id) || (Date.now() + index),
        comment: "",
        selective: false,
        secondary_keys: [],
        constant: false,
        position: "before_char"
      }))
    };
  }

  handleDeleteLorebookEntry(id) {
    if (confirm("Are you sure you want to delete this lorebook entry?")) {
      this.lorebookEntries = this.lorebookEntries.filter(e => e.id != id);
      this.renderLorebookEntries();
      this.updateLorebookEntryCount();
      this.resetLorebookEditor(); // In case the deleted one was being edited
      this.showNotification("Lorebook entry deleted.", "info");
    }
  }

  openAltGreetingsManager() {
    if (!this.currentCharacter) {
      this.showNotification("Please generate or import a character first.", "warning");
      return;
    }
    const modal = document.getElementById("alt-greetings-manager-modal");
    if (modal) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
      this.renderAltGreetings();
      this.resetAltGreetingsEditor();
    }
  }

  closeAltGreetingsManager() {
    const modal = document.getElementById("alt-greetings-manager-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  }

  updateAltGreetingsCount() {
    const countEl = document.getElementById("alt-greetings-count");
    const limitText = document.getElementById("alt-greetings-limit-text");
    if (countEl) {
        const count = this.altGreetings.length;
        countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
    }
    if (limitText) {
        limitText.textContent = `(${this.altGreetings.length}/5)`;
    }

    const editor = document.getElementById("alt-greeting-editor");
    const id = document.getElementById('alt-greeting-id')?.value;
    if (editor) {
        if (this.altGreetings.length >= 5 && !id) {
            editor.style.opacity = "0.5";
            editor.style.pointerEvents = "none";
        } else {
            editor.style.opacity = "1";
            editor.style.pointerEvents = "auto";
        }
    }
  }

  renderAltGreetings() {
    const listEl = document.getElementById("alt-greetings-list");
    if (!listEl) return;

    if (this.altGreetings.length === 0) {
        listEl.innerHTML = '<p class="library-empty">No alternate greetings yet.</p>';
        return;
    }

    listEl.innerHTML = this.altGreetings.map((greeting, index) => `
        <div class="library-item" style="align-items: flex-start;">
            <div style="flex: 1;">
                <div class="library-item-title" style="margin-bottom: 0.5rem;">Greeting ${index + 1}</div>
                <p style="font-size: 0.875rem; color: var(--text-secondary); margin: 0; white-space: pre-wrap; max-height: 80px; overflow: hidden; text-overflow: ellipsis;">${greeting.content}</p>
            </div>
            <div class="library-item-actions">
                <button class="btn-small" data-action="edit-alt-greeting" data-id="${greeting.id}">Edit</button>
                <button class="btn-small" data-action="delete-alt-greeting" data-id="${greeting.id}">Delete</button>
            </div>
        </div>
    `).join('');
  }

  resetAltGreetingsEditor() {
    document.getElementById('alt-greeting-editor-title').textContent = 'Add New Greeting';
    document.getElementById('alt-greeting-id').value = '';
    document.getElementById('alt-greeting-content').value = '';
    const hintInput = document.getElementById('alt-greeting-hint');
    if (hintInput) hintInput.value = '';
    document.getElementById('cancel-alt-greeting-edit-btn').style.display = 'none';
    this.updateAltGreetingsCount();
  }

  async handleGenerateAltGreeting(type) {
    const contentTextarea = document.getElementById("alt-greeting-content");
    const hintInput = document.getElementById("alt-greeting-hint");
    const contBtn = document.getElementById("generate-alt-greeting-cont-btn");
    const randBtn = document.getElementById("generate-alt-greeting-rand-btn");

    if (!this.currentCharacter || !contentTextarea) return;

    const hint = hintInput ? hintInput.value.trim() : "";
    const pov = document.getElementById("pov-select")?.value || "third";

    contBtn.disabled = true;
    randBtn.disabled = true;
    contentTextarea.value = "Generating alternate greeting with AI...";

    try {
        const content = await window.apiHandler.generateAltGreeting(this.currentCharacter, type, hint, pov);
        contentTextarea.value = content;
    } catch (error) {
        this.showNotification(`Failed to generate greeting: ${error.message}`, "error");
        contentTextarea.value = `Error: ${error.message}`;
    } finally {
        contBtn.disabled = false;
        randBtn.disabled = false;
    }
  }

  handleSaveAltGreeting() {
    const id = document.getElementById('alt-greeting-id').value;
    const content = document.getElementById('alt-greeting-content').value.trim();

    if (!content) {
        this.showNotification("Greeting content cannot be empty.", "warning");
        return;
    }

    if (id) {
        const index = this.altGreetings.findIndex(g => g.id == id);
        if (index > -1) {
            this.altGreetings[index].content = content;
        }
    } else {
        if (this.altGreetings.length >= 5) {
            this.showNotification("You can only have up to 5 alternate greetings.", "warning");
            return;
        }
        this.altGreetings.push({
            id: Date.now().toString() + Math.random().toString().slice(2, 5),
            content
        });
    }
    
    this.renderAltGreetings();
    this.updateAltGreetingsCount();
    this.resetAltGreetingsEditor();
    this.syncAltGreetingsToCharacter();
    this.saveCardToLibrary();
    this.showNotification("Alternate greeting saved successfully!", "success");
  }

  handleEditAltGreeting(id) {
    const greeting = this.altGreetings.find(g => g.id == id);
    if (!greeting) return;

    document.getElementById('alt-greeting-editor-title').textContent = 'Edit Greeting';
    document.getElementById('alt-greeting-id').value = greeting.id;
    document.getElementById('alt-greeting-content').value = greeting.content;
    const hintInput = document.getElementById('alt-greeting-hint');
    if (hintInput) hintInput.value = '';
    document.getElementById('cancel-alt-greeting-edit-btn').style.display = 'inline-block';
    document.getElementById('alt-greeting-editor').scrollIntoView({ behavior: 'smooth' });
    this.updateAltGreetingsCount();
  }

  handleDeleteAltGreeting(id) {
    if (confirm("Are you sure you want to delete this alternate greeting?")) {
        this.altGreetings = this.altGreetings.filter(g => g.id != id);
        this.renderAltGreetings();
        this.updateAltGreetingsCount();
        this.resetAltGreetingsEditor();
        this.syncAltGreetingsToCharacter();
        this.saveCardToLibrary();
        this.showNotification("Alternate greeting deleted.", "info");
    }
  }

  syncAltGreetingsToCharacter() {
    if (!this.currentCharacter) return;
    this.currentCharacter.alternateGreetings = this.altGreetings.map(g => g.content);
  }

  handleDownloadLorebook() {
    if (this.lorebookEntries.length === 0) {
      this.showNotification("There are no entries to download.", "warning");
      return;
    }

    const lorebookData = {
      name: `${this.currentCharacter?.name || 'Character'} Lorebook`,
      description: `A collection of lore entries for the character "${this.currentCharacter?.name || 'Unknown'}". Generated by SillyTavern Character Generator.`,
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
        id: entry.id, // Using our own ID
        constant: false,
        selective: false,
        secondary_keys: [],
      })),
    };

    const jsonString = JSON.stringify(lorebookData, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const filename = `${(this.currentCharacter?.name || 'character').replace(/[^a-zA-Z0-9]/g, '_')}_lorebook.json`;
    this.downloadBlob(blob, filename);
    this.showNotification("Lorebook downloaded!", "success");
  }

  showNotification(message, type = "info") {
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;
    notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            color: white;
            font-weight: 500;
            z-index: 10000;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        `;

    // Set background color based on type
    const colors = {
      success: "#28a745",
      error: "#dc3545",
      warning: "#ffc107",
      info: "#0066cc",
    };

    notification.style.backgroundColor = colors[type] || colors.info;
    notification.textContent = message;

    document.body.appendChild(notification);

    // Animate in
    setTimeout(() => {
      notification.style.transform = "translateX(0)";
    }, 10);

    // Remove after 5 seconds
    setTimeout(() => {
      notification.style.transform = "translateX(100%)";
      setTimeout(() => {
        if (notification.parentNode) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 5000);
  }

  // Utility methods
  validateInput() {
    const concept = document.getElementById("character-concept").value.trim();
    const characterName = document
      .getElementById("character-name")
      .value.trim();

    const errors = [];

    if (!concept) {
      errors.push("Character concept is required");
    } else if (concept.length < 10) {
      errors.push("Character concept should be at least 10 characters");
    } else if (concept.length > 1000) {
      errors.push("Character concept should be less than 1000 characters");
    }

    if (characterName && characterName.length > 50) {
      errors.push("Character name should be less than 50 characters");
    }

    return errors;
  }

  // Keyboard shortcuts
  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Ctrl/Cmd + Enter to generate
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (!this.isGenerating) {
          this.handleGenerate();
        }
      }

      // Escape to cancel/clear
      if (e.key === "Escape") {
        if (this.isGenerating) {
          // Cancel generation (would need implementation in API calls)
          this.showNotification(
            "Cannot cancel generation in progress",
            "warning",
          );
        } else {
          this.handleRegenerate();
        }
      }
    });
  }
  handleLorebookUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        this.lorebookData = json;

        // Update UI to show loaded status
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
  }
}

// Update prompt character counter
window.updatePromptCharCount = function () {
  const textarea = document.getElementById("custom-image-prompt");
  const counter = document.getElementById("prompt-char-count");

  if (textarea && counter) {
    const length = textarea.value.length;
    counter.textContent = `${length}/1000`;

    // Change color based on character count
    if (length >= 950) {
      counter.style.color = "#ef4444"; // Red
      counter.style.color = "#f59e0b"; // Orange
    } else {
      counter.style.color = "#9ca3af"; // Gray
    }
  }
};

// Wait for DOM to be loaded
document.addEventListener("DOMContentLoaded", async () => {
  // Wait a moment to ensure all modules are loaded
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify all required modules are loaded
  if (
    !window.config ||
    !window.apiHandler ||
    !window.characterGenerator ||
    !window.imageGenerator ||
    !window.pngEncoder
  ) {
    console.error("Missing modules:", {
      config: !!window.config,
      apiHandler: !!window.apiHandler,
      characterGenerator: !!window.characterGenerator,
      imageGenerator: !!window.imageGenerator,
      pngEncoder: !!window.pngEncoder,
    });
    return;
  }

  // Initialize app
  window.app = new CharacterGeneratorApp();


  // Add some CSS for tags
  const style = document.createElement("style");
  style.textContent = `
        .tags {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-top: 0.5rem;
        }

        .tag {
            background: var(--bg-tertiary);
            color: var(--text-secondary);
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 500;
        }

        .character-section {
            margin-bottom: 1.5rem;
        }

        .character-section strong {
            color: var(--text-primary);
            display: block;
            margin-bottom: 0.5rem;
        }

        .image-container {
            text-align: center;
        }

        .generated-image {
            max-width: 100%;
            height: auto;
            border-radius: var(--radius);
            box-shadow: var(--shadow-sm);
        }

        .form-section {
            background: var(--bg-tertiary);
            padding: 1rem;
            border-radius: calc(var(--radius) / 2);
            margin-bottom: 1rem;
        }

        .form-section-title {
            font-weight: 600;
            margin-bottom: 1rem;
            color: var(--text-primary);
        }
    `;
  document.head.appendChild(style);

  // Console welcome message
  console.log(
    "%c🎭 SillyTavern Character Generator",
    "font-size: 20px; font-weight: bold; color: #0066cc;",
  );
  console.log(
    "%cCreate amazing characters with AI!",
    "font-size: 14px; color: #666;",
  );
  console.log(
    "%cTip: Press Ctrl+Enter to generate a character",
    "font-size: 12px; color: #999;",
  );
});

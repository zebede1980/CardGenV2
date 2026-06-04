// Library / Storage Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  formatLibraryTime(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return date.toLocaleString();
  },

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
      const fullRecord = { ...promptRecord, fingerprint };
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
        const retryRecord = { ...minimalRecord, fingerprint };
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
  },

  preparePromptRecordForStorage(promptData, options = {}) {
    const minimal = Boolean(options.minimal);
    const maxEmbeddedChars = 400000;

    const safe = {
      concept: promptData?.concept || "",
      characterName: promptData?.characterName || "",
      pov: promptData?.pov || "third",
      cardType: promptData?.cardType || "single",
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
  },

  async saveCardToLibrary(isPermanent = false, specificId = null) {
    if (!this.storageReady || !this.storage || !this.currentCharacter) return;

    try {
      this.currentCharacter.character_book = this.buildCharacterBook();
      this.syncAltGreetingsToCharacter();

      let imageBlob = null;
      if (this.currentImageUrl) {
        try {
          if (this.currentImageUrl.startsWith("blob:")) {
            const res = await fetch(this.currentImageUrl);
            imageBlob = await res.blob();
          } else if (this.imageGenerator && typeof this.imageGenerator.convertToBlob === "function") {
            imageBlob = await this.imageGenerator.convertToBlob(this.currentImageUrl);
          }
        } catch (error) {
          console.warn("Skipping image blob save:", error.message);
        }
      }

      let imageHistoryData = [];
      if (this.imageHistoryUrls && this.imageHistoryUrls.length > 0) {
        for (const url of this.imageHistoryUrls) {
          try {
            if (typeof url === 'string' && url.startsWith("data:image/")) {
              imageHistoryData.push(url);
              continue;
            }
            let b;
            if (url.startsWith("blob:")) {
              const res = await fetch(url);
              b = await res.blob();
            } else if (this.imageGenerator && typeof this.imageGenerator.convertToBlob === "function") {
              b = await this.imageGenerator.convertToBlob(url);
            }
            if (b) {
              const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(b);
              });
              imageHistoryData.push(base64);
            }
          } catch (err) {
            console.warn("Skipping history blob save:", err.message);
          }
        }
      }

      const cardData = {
        characterName: this.currentCharacter.name || "Unnamed Character",
        character: JSON.parse(JSON.stringify(this.currentCharacter)),
        imageBlob,
        imageHistory: imageHistoryData,
        isPermanent,
        stSourceAvatar: this.stSourceAvatar || null,
        updatedAt: new Date().toISOString(),
      };

      if (specificId) {
        cardData.id = specificId;
        const cards = await this.storage.listCards();
        const existing = cards.find((c) => c.id === specificId);
        if (existing && existing.createdAt) {
          cardData.createdAt = existing.createdAt;
        } else {
          cardData.createdAt = new Date().toISOString();
        }
      } else {
        cardData.createdAt = new Date().toISOString();
      }

      await this.storage.saveCard(cardData);

      if (!isPermanent) {
        const allCards = await this.storage.listCards();
        const tempCards = allCards.filter((c) => !c.isPermanent);
        if (tempCards.length > 30) {
          tempCards.sort(
            (a, b) => new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime(),
          );
          const toDelete = tempCards.slice(0, tempCards.length - 30);
          for (const card of toDelete) {
            await this.storage.deleteCard(card.id);
          }
        }
      }
    } catch (error) {
      console.error("Failed to save card:", error);
    }
  },

  async handleSnapshotToHistory() {
    if (!this.currentCharacter) {
      this.showNotification("No character to snapshot", "warning");
      return;
    }
    const btn = document.getElementById("snapshot-history-btn");
    if (btn) btn.disabled = true;
    try {
      await this.saveCardToLibrary(false);
      await this.refreshLibraryViews();
      this.showNotification("Snapshot saved to history!", "success");
    } catch (error) {
      this.showNotification(`Snapshot failed: ${error.message}`, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  async handleSaveCardManual() {
    if (!this.currentCharacter) {
      this.showNotification("No character to save", "warning");
      return;
    }

    let saveId = null;
    const charName = this.currentCharacter.name || "Unnamed Character";

    if (this.storageReady && this.storage) {
      const cards = await this.storage.listCards();
      const permanentCards = cards.filter((c) => c.isPermanent);
      const existingCard = permanentCards.find(
        (c) => c.characterName === charName,
      );

      if (existingCard) {
        const doOverwrite = confirm(
          `A character named "${charName}" already exists in your saved library.\n\nWould you like to overwrite it?`,
        );
        if (doOverwrite) {
          saveId = existingCard.id;
        } else {
          const doSaveNew = confirm(
            `Would you like to save this as a new, separate version instead?`,
          );
          if (!doSaveNew) {
            this.showNotification("Save cancelled", "info");
            return;
          }
        }
      }
    }

    this.showNotification("Saving card to permanent library...", "info");
    await this.saveCardToLibrary(true, saveId);
    await this.refreshLibraryViews();
    this.showNotification("Card saved permanently!", "success");
  },

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

      prompts.sort((a, b) => {
        const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return timeB - timeA;
      });
      cards.sort((a, b) => {
        const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return timeB - timeA;
      });

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
              const promptPreview = prompt.concept
                ? `"${escapeHtml(prompt.concept.substring(0, 30).replace(/\n/g, " "))}${prompt.concept.length > 30 ? "..." : ""}"`
                : "(No concept)";
              const titleName = escapeHtml(prompt.characterName || promptPreview);
              return `
                <div class="library-item">
                  <div class="library-item-title">${titleName} - ${escapeHtml(prompt.pov || "third")} POV</div>
                  <div class="library-item-date">${this.formatLibraryTime(prompt.updatedAt)}</div>
                  <div class="library-item-actions">
                    <button class="btn-small" data-action="load-prompt" data-id="${prompt.id}">Load</button>
                    <button class="btn-small" data-action="delete-prompt" data-id="${prompt.id}">Delete</button>
                  </div>
                </div>
              `;
            })
            .join("");
        }
      }

      const permanentCards = cards.filter((c) => c.isPermanent);
      const tempCards = cards.filter((c) => !c.isPermanent);

      const authToken = window.cardgenAuth?.getToken() || "";

      if (cardList) {
        if (!permanentCards.length) {
          cardList.innerHTML =
            '<p class="library-empty">No permanent cards yet.</p>';
        } else {
          cardList.innerHTML = permanentCards
            .map((card) => {
              const tStamp = new Date(card.updatedAt || card.createdAt || 0).getTime();
              const thumbUrl = `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(card.id)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ""}&_t=${tStamp}`;
              return `
                <div class="library-item st-card">
                  <div class="st-card-thumb-wrap">
                    <img class="st-card-thumb" src="${thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'">
                    <div class="st-card-thumb-placeholder"></div>
                  </div>
                  <div class="st-card-body">
                    <div class="library-item-title">${escapeHtml(card.characterName || "Unnamed Character")}</div>
                    <div class="library-item-date">${this.formatLibraryTime(card.updatedAt)}</div>
                    <div class="library-item-actions">
                      <button class="btn-small" data-action="load-card" data-id="${card.id}">Load</button>
                      <button class="btn-small" data-action="delete-card" data-id="${card.id}">Delete</button>
                    </div>
                  </div>
                </div>
              `;
            })
            .join("");
        }
      }

      if (historyList) {
        if (!tempCards.length) {
          historyList.innerHTML =
            '<p class="library-empty">No history available.</p>';
        } else {
          historyList.innerHTML = tempCards
            .map((card) => {
              const tStamp = new Date(card.updatedAt || card.createdAt || 0).getTime();
              const thumbUrl = `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(card.id)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ""}&_t=${tStamp}`;
              return `
                <div class="library-item st-card">
                  <div class="st-card-thumb-wrap">
                    <img class="st-card-thumb" src="${thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'">
                    <div class="st-card-thumb-placeholder"></div>
                  </div>
                  <div class="st-card-body">
                    <div class="library-item-title">${escapeHtml(card.characterName || "Unnamed Character")}</div>
                    <div class="library-item-date">${this.formatLibraryTime(card.updatedAt)}</div>
                    <div class="library-item-actions">
                      <button class="btn-small" data-action="load-card" data-id="${card.id}">Load</button>
                      <button class="btn-small" data-action="delete-card" data-id="${card.id}">Delete</button>
                    </div>
                  </div>
                </div>
              `;
            })
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
  },

  renderStorageUnavailableState() {
    const message =
      '<p class="library-empty">Local storage is unavailable in this browser/session.</p>';
    ["stored-prompts-list", "stored-cards-list", "history-cards-list"].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = message;
      },
    );
  },

  updateLibraryStatus(text) {
    const status = document.getElementById("library-status");
    if (status) {
      status.textContent = text;
    }
  },

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
        const cardTypeSelect = document.getElementById("card-type-select");
        if (cardTypeSelect) {
          cardTypeSelect.value = prompt.cardType || "single";
          cardTypeSelect.dispatchEvent(new Event("change"));
        }
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
  },

  async handleLibraryCardClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;

    const action = actionElement.dataset.action;
    const id = actionElement.dataset.id;

    try {
      if (action === "load-card") {
        const card = await this.storage.getCard(id);
        if (!card?.character) return;
        // Restore the ST slot link if it was saved, otherwise clear it
        this.stSourceAvatar = card.stSourceAvatar || null;
        this._updatePushButton();
        this.currentCharacter = card.character;
        this.originalCharacter = JSON.parse(JSON.stringify(card.character));
        this.displayCharacter();
        this.showResultSection();
        const inputSectionDetails = document.getElementById("input-section-details");
        if (inputSectionDetails) inputSectionDetails.open = false;
        document.getElementById("image-controls").style.display = "block";

        if (
          card.character.character_book &&
          card.character.character_book.entries
        ) {
          this.lorebookEntries = card.character.character_book.entries.map(
            (e) => ({
              id:
                e.id ||
                Date.now().toString() + Math.random().toString().slice(2, 5),
              keys: e.keys || [],
              content: e.content || "",
              enabled: e.enabled !== false,
            }),
          );
        } else {
          this.lorebookEntries = [];
        }
        this.updateLorebookEntryCount();

        if (card.character.alternateGreetings) {
          this.altGreetings = card.character.alternateGreetings.map(
            (content, i) => ({
              id: Date.now().toString() + i,
              content,
            }),
          );
        } else {
          this.altGreetings = [];
        }
        this.updateAltGreetingsCount();

        if (card.imageBlob instanceof Blob) {
          if (
            this.currentImageUrl &&
            this.currentImageUrl.startsWith("blob:")
          ) {
            URL.revokeObjectURL(this.currentImageUrl);
          }
          this.currentImageUrl = URL.createObjectURL(card.imageBlob);
          const imageContainer = document.getElementById("image-content");
          if (imageContainer) {
            imageContainer.innerHTML = `
              <div class="image-container">
                <img src="${this.currentImageUrl}" alt="${card.character.name || "Character"}" class="generated-image">
              </div>
            `;
          }
        }

        if (this.imageHistoryUrls) {
          this.imageHistoryUrls.forEach(url => {
            if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
          });
        }
        this.imageHistoryUrls = [];
        if (card.imageHistory && Array.isArray(card.imageHistory)) {
          for (const item of card.imageHistory) {
            if (item) {
              try {
                if (typeof item === 'string' && item.startsWith('data:image/')) {
                  this.imageHistoryUrls.push(item);
                } else {
                  const blob = item instanceof Blob ? item : new Blob([item]);
                  this.imageHistoryUrls.push(URL.createObjectURL(blob));
                }
              } catch (e) {
                console.warn("Failed to restore history blob:", e);
              }
            }
          }
        }
        if (typeof this.updateImageHistoryButton === "function") this.updateImageHistoryButton();

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
  },

  async handleClearHistory() {
    if (!this.storageReady || !this.storage) return;
    if (!confirm("Delete all history snapshots? This cannot be undone. Permanent saves are not affected.")) return;
    try {
      const cards = await this.storage.listCards();
      const tempCards = cards.filter(c => !c.isPermanent);
      await Promise.all(tempCards.map(c => this.storage.deleteCard(c.id)));
      await this.refreshLibraryViews();
      this.showNotification(`Cleared ${tempCards.length} history item(s)`, "info");
    } catch (error) {
      console.error("Clear history failed:", error);
      this.showNotification("Failed to clear history", "error");
    }
  },

  async handleClearPrompts() {
    if (!this.storageReady || !this.storage) return;
    if (!confirm("Delete all saved prompts? This cannot be undone.")) return;
    try {
      const prompts = await this.storage.listPrompts();
      await Promise.all(prompts.map(p => this.storage.deletePrompt(p.id)));
      await this.refreshLibraryViews();
      this.showNotification(`Cleared ${prompts.length} prompt(s)`, "info");
    } catch (error) {
      console.error("Clear prompts failed:", error);
      this.showNotification("Failed to clear prompts", "error");
    }
  },

  async handleMigrateCards() {
    const btn = document.getElementById("migrate-cards-btn");
    const purge = confirm(
      "Migrate cards from old storage?\n\n" +
      "OK = clear all existing DB cards first, then migrate fresh (recommended — avoids duplicates from previous failed attempts).\n\n" +
      "Cancel = append to existing cards without clearing."
    );

    if (btn) { btn.disabled = true; btn.textContent = "Migrating…"; }
    try {
      const url = purge ? "/api/storage/migrate-cards?purge=true" : "/api/storage/migrate-cards";
      const res = await authFetch(url, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Migration failed");

      if (data.total === 0) {
        this.showNotification(data.message || "No old cards found to migrate.", "info");
      } else {
        const msg = `Migrated ${data.migrated} of ${data.total} card(s).${data.skipped ? ` ${data.skipped} failed — see browser console for details.` : ""}`;
        this.showNotification(msg, data.skipped ? "warning" : "success");
        if (data.errors?.length) console.warn("[Migration] Per-card errors:", data.errors);
        await this.refreshLibraryViews();
      }
    } catch (e) {
      this.showNotification("Migration error: " + e.message, "error");
      console.error("[Migration] Error:", e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "📦 Migrate from old storage"; }
    }
  },

});

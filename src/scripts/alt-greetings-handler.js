// Alt Greetings Manager Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  openAltGreetingsManager() {
    if (!this.currentCharacter) {
      this.showNotification(
        "Please generate or import a character first.",
        "warning",
      );
      return;
    }
    const modal = document.getElementById("alt-greetings-manager-modal");
    if (modal) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
      this.renderAltGreetings();
      this.resetAltGreetingsEditor();
    }
  },

  closeAltGreetingsManager() {
    const modal = document.getElementById("alt-greetings-manager-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  },

  updateAltGreetingsCount() {
    const countEl = document.getElementById("alt-greetings-count");
    const limitText = document.getElementById("alt-greetings-limit-text");
    if (countEl) {
      const count = this.altGreetings.length;
      countEl.textContent = `${count} ${count === 1 ? "entry" : "entries"}`;
    }
    if (limitText) {
      limitText.textContent = `(${this.altGreetings.length})`;
    }
    this.updateTokenCounts();
    this.renderAltGreetingsSummary();
  },

  renderAltGreetings() {
    const listEl = document.getElementById("alt-greetings-list");
    if (!listEl) return;

    if (this.altGreetings.length === 0) {
      listEl.innerHTML =
        '<p class="library-empty">No alternate greetings yet.</p>';
      return;
    }

    listEl.innerHTML = this.altGreetings
      .map(
        (greeting, index) => `
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
    `,
      )
      .join("");
  },

  resetAltGreetingsEditor() {
    document.getElementById("alt-greeting-editor-title").textContent =
      "Add New Greeting";
    document.getElementById("alt-greeting-id").value = "";
    document.getElementById("alt-greeting-content").value = "";
    const hintInput = document.getElementById("alt-greeting-hint");
    if (hintInput) hintInput.value = "";
    document.getElementById("cancel-alt-greeting-edit-btn").style.display =
      "none";
    this.updateAltGreetingsCount();
  },

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
      const content = await window.apiHandler.generateAltGreeting(
        this.currentCharacter,
        type,
        hint,
        pov,
        this.lorebookEntries,
      );
      contentTextarea.value = content;
    } catch (error) {
      this.showNotification(
        `Failed to generate greeting: ${error.message}`,
        "error",
      );
      contentTextarea.value = `Error: ${error.message}`;
    } finally {
      contBtn.disabled = false;
      randBtn.disabled = false;
    }
  },

  handleSaveAltGreeting() {
    const id = document.getElementById("alt-greeting-id").value;
    const content = document
      .getElementById("alt-greeting-content")
      .value.trim();

    if (!content) {
      this.showNotification("Greeting content cannot be empty.", "warning");
      return;
    }

    if (id) {
      const index = this.altGreetings.findIndex((g) => g.id == id);
      if (index > -1) {
        this.altGreetings[index].content = content;
      }
    } else {
      this.altGreetings.push({
        id: Date.now().toString() + Math.random().toString().slice(2, 5),
        content,
      });
    }

    this.renderAltGreetings();
    this.updateAltGreetingsCount();
    this.resetAltGreetingsEditor();
    this.syncAltGreetingsToCharacter();
    this.saveCardToLibrary();
    this.showNotification("Alternate greeting saved successfully!", "success");
  },

  handleEditAltGreeting(id) {
    const greeting = this.altGreetings.find((g) => g.id == id);
    if (!greeting) return;

    document.getElementById("alt-greeting-editor-title").textContent =
      "Edit Greeting";
    document.getElementById("alt-greeting-id").value = greeting.id;
    document.getElementById("alt-greeting-content").value = greeting.content;
    const hintInput = document.getElementById("alt-greeting-hint");
    if (hintInput) hintInput.value = "";
    document.getElementById("cancel-alt-greeting-edit-btn").style.display =
      "inline-block";
    document
      .getElementById("alt-greeting-editor")
      .scrollIntoView({ behavior: "smooth" });
    this.updateAltGreetingsCount();
  },

  handleDeleteAltGreeting(id) {
    if (confirm("Are you sure you want to delete this alternate greeting?")) {
      this.altGreetings = this.altGreetings.filter((g) => g.id != id);
      this.renderAltGreetings();
      this.updateAltGreetingsCount();
      this.resetAltGreetingsEditor();
      this.syncAltGreetingsToCharacter();
      this.saveCardToLibrary();
      this.showNotification("Alternate greeting deleted.", "info");
    }
  },

  syncAltGreetingsToCharacter() {
    if (!this.currentCharacter) return;
    this.currentCharacter.alternateGreetings = this.altGreetings.map(
      (g) => g.content,
    );
  },

  renderAltGreetingsSummary() {
    const summaryEl = document.getElementById("alt-greetings-summary");
    if (!summaryEl) return;

    if (this.altGreetings.length === 0) {
      summaryEl.innerHTML = "";
      summaryEl.style.display = "none";
      return;
    }

    summaryEl.style.display = "block";
    summaryEl.innerHTML = this.altGreetings
      .map(
        (greeting, index) => `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); gap: 0.5rem;">
          <div style="flex: 1; min-width: 0;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-primary);">Greeting ${index + 1}:</span>
            <span style="font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: calc(100% - 5rem); vertical-align: bottom;">&nbsp;${greeting.content.substring(0, 80).replace(/\n/g, " ")}${greeting.content.length > 80 ? "\u2026" : ""}</span>
          </div>
        </div>`,
      )
      .join("");
  },

});

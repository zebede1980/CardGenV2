// Revision and Consistency Check Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

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

    this.setRevisionState(true, "revise-character-btn");
    const before = this._captureCardSnapshot();

    try {
      const pov = document.getElementById("pov-select")?.value || "third";
      this.currentCharacter.character_book = this.buildCharacterBook();
      this.syncAltGreetingsToCharacter();
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
      this.showCardDiff(before, this._captureCardSnapshot());
    } catch (error) {
      console.error("Revision failed:", error);
      const wasStoppedByUser = error.message.includes(
        "Generation stopped by user",
      );
      if (!wasStoppedByUser) {
        this.showNotification(`Revision failed: ${error.message}`, "error");
      }
    } finally {
      this.setRevisionState(false);
    }
  },

  async handleReduceTokens() {
    if (!this.currentCharacter) {
      this.showNotification("Generate or import a character first", "warning");
      return;
    }

    if (
      !confirm(
        "This will:\n1. Scan the card for world-building lore that belongs in the lorebook (you can pick what to move)\n2. Strip all bloat, flowery prose, and repetition from the card\n\nProceed?",
      )
    ) {
      return;
    }

    this.setRevisionState(true, "reduce-tokens-btn");
    const before = this._captureCardSnapshot();

    try {
      this.currentCharacter.character_book = this.buildCharacterBook();
      this.showNotification("Scanning card for lorebook candidates...", "info");

      let selectedCandidates = [];
      try {
        const candidates = await this.apiHandler.scanCardForLorebookCandidates(this.currentCharacter);
        if (candidates && candidates.length > 0) {
          // Temporarily release the revision lock so the modal is usable
          this.setRevisionState(false);
          const selected = await this.showLoreElevationModal(candidates);
          this.setRevisionState(true, "reduce-tokens-btn");
          // null = cancelled — continue with bloat-only pass
          selectedCandidates = selected || [];
        }
      } catch (scanError) {
        // Scan failure is non-fatal — just skip lorebook elevation and proceed
        console.warn("Lorebook scan failed (continuing with bloat reduction only):", scanError);
      }

      await this.executeLoreElevation(selectedCandidates, true);
      this.showNotification("Card bloat reduced successfully!", "success");
      this.showCardDiff(before, this._captureCardSnapshot());
    } catch (error) {
      console.error("Reduction failed:", error);
      const wasStoppedByUser = error.message?.includes("Generation stopped by user");
      if (!wasStoppedByUser) {
        this.showNotification(`Reduction failed: ${error.message}`, "error");
      }
    } finally {
      this.setRevisionState(false);
    }
  },

  async handleCheckConsistency() {
    if (!this.currentCharacter) {
      this.showNotification(
        "Please generate or import a character first",
        "warning",
      );
      return;
    }

    const modal = document.getElementById("consistency-report-modal");
    const content = document.getElementById("consistency-report-content");
    const autoFixBtn = document.getElementById("consistency-auto-fix-btn");

    if (modal && content) {
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
      content.innerHTML =
        '<div style="text-align: center; padding: 2rem;"><div class="loading-spinner" style="margin: 0 auto;"></div><p style="margin-top: 1rem; color: var(--text-secondary);">Analyzing character consistency...</p></div>';
      if (autoFixBtn) autoFixBtn.style.display = "none";

      try {
        let isFirstChunk = true;
        await window.apiHandler.checkConsistency(
          this.currentCharacter,
          this.lorebookEntries,
          (token) => {
            if (isFirstChunk) {
              content.innerHTML = "";
              isFirstChunk = false;
            }
            content.textContent += token;
          },
        );

        this.lastConsistencyReport = content.textContent;
        if (autoFixBtn) autoFixBtn.style.display = "inline-flex";
      } catch (error) {
        content.innerHTML = `<div style="color: var(--error); padding: 1rem;">Failed to check consistency: ${escapeHtml(error.message)}</div>`;
      }
    }
  },

  closeConsistencyModal() {
    const modal = document.getElementById("consistency-report-modal");
    if (modal) {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }
  },

  async handleConsistencyAutoFix() {
    if (!this.currentCharacter || !this.lastConsistencyReport) return;

    if (
      !confirm(
        "This will use AI to rewrite your character card to address the issues found in the consistency report.\n\nProceed?",
      )
    ) {
      return;
    }

    this.closeConsistencyModal();
    this.setRevisionState(true, "revise-character-btn");
    const before = this._captureCardSnapshot();

    try {
      const pov = document.getElementById("pov-select")?.value || "third";
      this.currentCharacter.character_book = this.buildCharacterBook();
      this.syncAltGreetingsToCharacter();
      this.showNotification("Applying AI auto-fixes...", "info");

      const revisionInstruction = `Please review the following consistency report and fix the identified issues in the character card.\n\nConsistency Report:\n${this.lastConsistencyReport}\n\nApply the suggested fixes to resolve any logical contradictions, tonal inconsistencies, or continuity errors while keeping the core identity intact.`;

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
      this.showNotification(
        "Character consistency issues fixed successfully!",
        "success",
      );
      this.showCardDiff(before, this._captureCardSnapshot());
    } catch (error) {
      console.error("Auto-fix failed:", error);
      const wasStoppedByUser = error.message.includes(
        "Generation stopped by user",
      );
      if (!wasStoppedByUser) {
        this.showNotification(`Auto-fix failed: ${error.message}`, "error");
      }
    } finally {
      this.setRevisionState(false);
    }
  },

  /* ── Card Diff View ─────────────────────────────────────────────────────── */

  _captureCardSnapshot() {
    if (!this.currentCharacter) return null;
    const c = this.currentCharacter;
    return {
      name: c.name || "",
      description: c.description || "",
      personality: c.personality || "",
      scenario: c.scenario || "",
      first_mes: c.first_mes || "",
      mesExample: c.mesExample || "",
    };
  },

  _computeDiffWords(oldText, newText) {
    // Simple word-level diff using LCS-like approach
    const oldWords = (oldText || "").split(/(\s+)/);
    const newWords = (newText || "").split(/(\s+)/);
    const result = [];
    let i = 0, j = 0;

    while (i < oldWords.length || j < newWords.length) {
      if (i >= oldWords.length) {
        result.push({ type: "add", text: newWords[j++] });
      } else if (j >= newWords.length) {
        result.push({ type: "del", text: oldWords[i++] });
      } else if (oldWords[i] === newWords[j]) {
        result.push({ type: "same", text: oldWords[i++] });
        j++;
      } else {
        // Greedy: look ahead for next match
        const nextMatchInNew = newWords.indexOf(oldWords[i], j);
        const nextMatchInOld = oldWords.indexOf(newWords[j], i);
        if (nextMatchInNew !== -1 && (nextMatchInOld === -1 || nextMatchInNew - j <= nextMatchInOld - i)) {
          while (j < nextMatchInNew) result.push({ type: "add", text: newWords[j++] });
        } else if (nextMatchInOld !== -1) {
          while (i < nextMatchInOld) result.push({ type: "del", text: oldWords[i++] });
        } else {
          result.push({ type: "del", text: oldWords[i++] });
          result.push({ type: "add", text: newWords[j++] });
        }
      }
    }
    return result;
  },

  _renderDiffHtml(diffParts) {
    return diffParts.map((p) => {
      const text = escapeHtml(p.text);
      if (p.type === "del") return `<span class="diff-del">${text}</span>`;
      if (p.type === "add") return `<span class="diff-add">${text}</span>`;
      return text;
    }).join("");
  },

  showCardDiff(before, after) {
    const modal = document.getElementById("card-diff-modal");
    const content = document.getElementById("card-diff-content");
    const closeBtn = document.getElementById("card-diff-modal-close-btn");
    if (!modal || !content) return;

    const fields = [
      { key: "name", label: "Name" },
      { key: "description", label: "Description" },
      { key: "personality", label: "Personality" },
      { key: "scenario", label: "Scenario" },
      { key: "first_mes", label: "First Message" },
      { key: "mesExample", label: "Example Messages" },
    ];

    const changedFields = fields.filter((f) => (before[f.key] || "") !== (after[f.key] || ""));

    if (changedFields.length === 0) {
      content.innerHTML = `<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No textual changes were made.</p>`;
    } else {
      content.innerHTML = changedFields.map((f) => {
        const diff = this._computeDiffWords(before[f.key], after[f.key]);
        return `
          <div class="diff-field">
            <div class="diff-field-title">${escapeHtml(f.label)}</div>
            <div class="diff-content">${this._renderDiffHtml(diff)}</div>
          </div>
        `;
      }).join("");
    }

    modal.classList.add("show");
    document.body.style.overflow = "hidden";

    const close = () => {
      modal.classList.remove("show");
      document.body.style.overflow = "";
      closeBtn?.removeEventListener("click", close);
      modal.removeEventListener("click", onBackdrop);
    };
    const onBackdrop = (e) => { if (e.target === modal) close(); };

    closeBtn?.addEventListener("click", close);
    modal.addEventListener("click", onBackdrop);
  },

});

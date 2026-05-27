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

      const approved = await this.promptCardDiffApproval(before, revised);

      if (approved) {
        this.currentCharacter = revised;
        this.originalCharacter = JSON.parse(JSON.stringify(revised));
        this.displayCharacter();
        await this.saveCardToLibrary();
        await this.refreshLibraryViews();
        this.showNotification("Character revised successfully", "success");
      } else {
        this.showNotification("Revision discarded", "info");
      }
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

      const approved = await this.executeLoreElevation(selectedCandidates, true);
      if (approved) {
        this.showNotification("Card bloat reduced successfully!", "success");
      } else {
        this.showNotification("Card reduction discarded.", "info");
      }
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

      const approved = await this.promptCardDiffApproval(before, revised);

      if (approved) {
        this.currentCharacter = revised;
        this.originalCharacter = JSON.parse(JSON.stringify(revised));
        this.displayCharacter();
        await this.saveCardToLibrary();
        await this.refreshLibraryViews();
        this.showNotification(
          "Character consistency issues fixed successfully!",
          "success",
        );
      } else {
        this.showNotification("Auto-fix discarded", "info");
      }
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
      firstMessage: c.firstMessage || "",
      mesExample: c.mesExample || "",
    };
  },

  /**
   * Compute line-level LCS matrix.
   * Returns [lcsLength, matrix] where matrix[row][col] = length of LCS.
   */
  _lcsMatrix(oldLines, newLines) {
    const m = oldLines.length, n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp;
  },

  /**
   * Backtrack the LCS matrix to classify lines as same, deleted, or added.
   */
  _lcsOps(oldLines, newLines, dp) {
    const ops = [];
    let i = oldLines.length, j = newLines.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        ops.unshift({ op: "same", oldLine: oldLines[i - 1], newLine: newLines[j - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.unshift({ op: "add", newLine: newLines[j - 1] });
        j--;
      } else {
        ops.unshift({ op: "del", oldLine: oldLines[i - 1] });
        i--;
      }
    }
    return ops;
  },

  /**
   * Word-level diff of two lines. Uses a greedy match with a modest
   * look-ahead to avoid cascading red/green on small changes.
   */
  _diffWords(oldStr, newStr) {
    const oldWords = (oldStr || "").split(/(\s+)/);
    const newWords = (newStr || "").split(/(\s+)/);
    const result = [];
    let o = 0, n = 0;

    while (o < oldWords.length || n < newWords.length) {
      if (o >= oldWords.length) {
        result.push({ type: "add", text: newWords[n++] });
      } else if (n >= newWords.length) {
        result.push({ type: "del", text: oldWords[o++] });
      } else if (oldWords[o] === newWords[n]) {
        result.push({ type: "same", text: oldWords[o] });
        o++; n++;
      } else {
        // Search for a re-sync point within a limited window (look-ahead = 20 words)
        const maxLook = 20;
        let bestDist = Infinity, bestO = o, bestN = n;
        for (let oo = o; oo < Math.min(oldWords.length, o + maxLook); oo++) {
          for (let nn = n; nn < Math.min(newWords.length, n + maxLook); nn++) {
            if (oldWords[oo] === newWords[nn]) {
              const dist = (oo - o) + (nn - n);
              if (dist < bestDist) { bestDist = dist; bestO = oo; bestN = nn; }
            }
          }
        }
        if (bestDist < Infinity && bestDist <= 12) {
          while (o < bestO) result.push({ type: "del", text: oldWords[o++] });
          while (n < bestN) result.push({ type: "add", text: newWords[n++] });
        } else {
          // No decent match found — fall back to pairwise
          result.push({ type: "del", text: oldWords[o++] });
          result.push({ type: "add", text: newWords[n++] });
        }
      }
    }
    return result;
  },

  _computeDiffWords(oldText, newText) {
    const oldLines = (oldText || "").split("\n");
    const newLines = (newText || "").split("\n");
    const dp = this._lcsMatrix(oldLines, newLines);
    const ops = this._lcsOps(oldLines, newLines, dp);

    const result = [];
    for (const op of ops) {
      if (op.op === "same") {
        result.push({ type: "same", text: op.oldLine + "\n" });
      } else if (op.op === "del") {
        // deleted line — all words marked as del
        result.push({ type: "del", text: op.oldLine + "\n" });
      } else {
        // added line — all words marked as add
        result.push({ type: "add", text: op.newLine + "\n" });
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

  promptCardDiffApproval(before, after) {
    return new Promise((resolve) => {
      const modal = document.getElementById("card-diff-modal");
      const content = document.getElementById("card-diff-content");
      let closeBtn = document.getElementById("card-diff-modal-close-btn");
      
      if (!modal || !content) {
        resolve(true);
        return;
      }

      let acceptBtn = document.getElementById("card-diff-accept-btn");
      let rejectBtn = document.getElementById("card-diff-reject-btn");
      
      // Dynamically morph the Close button into Accept/Discard if no UI changes were made
      if (!acceptBtn || !rejectBtn) {
        const footer = closeBtn?.parentElement;
        if (footer) {
          footer.innerHTML = `
            <button id="card-diff-reject-btn" class="btn-secondary" style="margin-right: 0.5rem;">Discard Changes</button>
            <button id="card-diff-accept-btn" class="btn-primary">Accept Changes</button>
          `;
          acceptBtn = document.getElementById("card-diff-accept-btn");
          rejectBtn = document.getElementById("card-diff-reject-btn");
          closeBtn = null;
        }
      }

    const fields = [
      { key: "name", label: "Name" },
      { key: "description", label: "Description" },
      { key: "personality", label: "Personality" },
      { key: "scenario", label: "Scenario" },
      { key: "firstMessage", label: "First Message" },
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

      const cleanup = () => {
        modal.classList.remove("show");
        document.body.style.overflow = "";
        acceptBtn?.removeEventListener("click", onAccept);
        rejectBtn?.removeEventListener("click", onReject);
        closeBtn?.removeEventListener("click", onReject);
        modal.removeEventListener("click", onBackdrop);
      };

      const onAccept = () => { cleanup(); resolve(true); };
      const onReject = () => { cleanup(); resolve(false); };
      const onBackdrop = (e) => { if (e.target === modal) onReject(); };

      acceptBtn?.addEventListener("click", onAccept);
      rejectBtn?.addEventListener("click", onReject);
      closeBtn?.addEventListener("click", onReject);
      modal.addEventListener("click", onBackdrop);
    });
  },

});

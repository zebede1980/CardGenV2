// Card runs, the page's half — extends CharacterGeneratorApp prototype
//
// With "Make new characters on the server" on (Settings → app.serverRuns), the
// card and its finishing fields are written by a run on the proxy
// (proxy/runs/card-runs.js) instead of by requests this page conducts. The page
// posts what was asked for and then only watches: it polls for progress while
// it is visible and does nothing at all while it is hidden. Nothing here can
// stall, so there is no watchdog and no resume loop; a frozen or discarded page
// misses nothing, because the run does not depend on it. A page that loads
// while a run is in progress attaches to it (recoverNewCard in
// card-recovery.js), on this device or another.

const CARD_RUN_POLL_MS = 1500;
const CARD_RUN_STOPPED = "Generation stopped by user";

Object.assign(CharacterGeneratorApp.prototype, {

  serverRunsEnabled() {
    return this.config.get("app.serverRuns") === true;
  },

  /**
   * The middle of making a new character, shared by Generate, 4 ideas and
   * Inspire Me: write the card, stamp its type, get it into History, fill the
   * finishing fields. A card run on the proxy does it when the setting is on;
   * otherwise this page's own requests do. Sets this.currentCharacter.
   */
  async writeNewCard({ mode = "classic", concept = "", brief = "", characterName = "", pov, cardType, searchQuery = "", searchScenario = "", stopMark }) {
    if (this.serverRunsEnabled()) {
      // It carries on if this page is frozen or discarded, and the card is in
      // History either way. This page shows the progress, then does the steps
      // that still need it (cast, portrait).
      this.currentCharacter = await this.runNewCardOnServer({
        mode: mode === "search" ? "search" : "classic",
        concept,
        brief,
        searchQuery,
        searchScenario,
        characterName,
        pov,
        cardType,
        lorebook: this.lorebookData,
        exampleCount: parseInt(document.getElementById("example-messages-count")?.value || "3", 10),
        exampleStyle: document.getElementById("example-messages-prompt")?.value?.trim() || "",
        referenceImage: this.referenceImageDataUrl || "",
      });
      window.apiHandler.throwIfStopped(stopMark);
      return;
    }

    const onStream = (token, fullContent) => this.handleCharacterStream(token, fullContent);
    this.currentCharacter = mode === "search"
      ? await window.characterSearch.generateCharacter(searchQuery, searchScenario, characterName, onStream, pov, this.lorebookData, cardType)
      : await this.characterGenerator.generateCharacter(concept, characterName, onStream, pov, this.lorebookData, cardType);
    window.apiHandler.throwIfStopped(stopMark);

    // Stamp cardType on the character and auto-tag non-single types
    this.currentCharacter.cardType = cardType;
    if (cardType === "group" || cardType === "scenario") {
      if (!Array.isArray(this.currentCharacter.tags)) this.currentCharacter.tags = [];
      if (!this.currentCharacter.tags.includes(cardType)) this.currentCharacter.tags.push(cardType);
    }
    // Into History now, so a tab closed during the later steps doesn't take
    // the card with it. The save at the end replaces this one.
    this.saveDraftToHistory();

    this.showStreamMessage("\n\n💬 Generating example messages, creator's notes and post-history instructions...\n");
    await this.fillFinishingFields(this.currentCharacter, { brief });
    window.apiHandler.throwIfStopped(stopMark);
  },

  // A pause between polls that Stop can cut short, so the page reacts at once.
  _cardRunPause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self._cardRunWake === done) self._cardRunWake = null;
        resolve();
      }
      this._cardRunWake = done;
    });
  },

  /**
   * One request to the card-run routes. Resolves the JSON body; rejects with an
   * Error carrying `.status` for an HTTP error, or with no status when the
   * request never arrived (offline, proxy restarting).
   */
  async _cardRunRequest(method, path, body) {
    const res = await window.authFetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const error = new Error(data?.error?.message || `The server refused the request (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  },

  /**
   * Have the proxy make a new character from `spec`, and follow it to the end.
   * Resolves the finished card (text and finishing fields; no portrait).
   * Throws "Generation stopped by user" on Stop, like the page's own pipeline.
   */
  async runNewCardOnServer(spec) {
    // Made before the request and kept in the marker, so sending it twice (a
    // retry here, or iOS re-sending the POST) is one run, not two paid ones.
    const key = window.crypto?.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
    NewCardMarker.update({ runKey: key });

    let run;
    for (let attempt = 1; ; attempt++) {
      try {
        run = await this._cardRunRequest("POST", "/api/card-runs", { key, spec, settings: this.config.config });
        break;
      } catch (error) {
        if (error.status || attempt >= 4) throw error;
        await this._cardRunPause(800 * attempt);
        await window.apiHandler._waitUntilVisible();
      }
    }
    NewCardMarker.update({ runId: run.id });
    return this._followCardRun(run.id);
  },

  /** Poll a run until it ends, showing its text and messages as they arrive. */
  async _followCardRun(runId) {
    this._activeRunId = runId;
    const stopMark = window.apiHandler.stopMark();
    let shown = 0;       // characters of card text already on screen
    let logSeen = 0;     // run messages already on screen
    let offline = 0;
    let resumed = false;
    try {
      for (;;) {
        // Hidden means frozen or about to be: don't poll, there is nobody to show it to.
        await window.apiHandler._waitUntilVisible();
        window.apiHandler.throwIfStopped(stopMark);

        let run;
        try {
          run = await this._cardRunRequest("GET", `/api/card-runs/${runId}?from=${shown}&log=${logSeen}`);
          offline = 0;
        } catch (error) {
          if (error.status === 404) {
            throw new Error("The server no longer has this generation. If the card was written, it is in History.");
          }
          if (error.status) throw error;
          // No connection (it often returns a moment after the screen does), or the
          // proxy is restarting. The run doesn't need this page; keep asking.
          offline++;
          await this._cardRunPause(Math.min(5000, 500 * offline));
          continue;
        }
        window.apiHandler.throwIfStopped(stopMark);

        if (run.textLength < shown) {
          // The card step started over (a resume after a restart): show it afresh.
          shown = 0;
          this.showStreamMessage("\n↩️ The card is being written again...\n\n");
          continue;
        }
        if (run.text) {
          shown += run.text.length;
          this.handleCharacterStream(run.text);
        }
        for (const line of run.log) this.showStreamMessage(line);
        logSeen = run.logLength;

        if (run.status === "done") {
          // The save at the end of the page's steps replaces the run's History item.
          this._draftHistorySave = Promise.resolve(run.historyId);
          NewCardMarker.update({ historyId: run.historyId });
          return run.card;
        }
        if (run.status === "stopped") throw new Error(CARD_RUN_STOPPED);
        if (run.status === "interrupted" && !resumed) {
          resumed = true;
          this.showStreamMessage("\n⚠️ The server restarted. Carrying on...\n");
          await this._cardRunRequest("POST", `/api/card-runs/${runId}/resume`, { settings: this.config.config });
          continue;
        }
        if (run.status !== "running") throw new Error(run.error || "The generation failed on the server");

        await this._cardRunPause(CARD_RUN_POLL_MS);
      }
    } finally {
      this._activeRunId = null;
    }
  },

  /** Stop pressed: end the run on the server too (closing this page would not). */
  stopCardRun() {
    const runId = this._activeRunId;
    if (!runId) return;
    this._cardRunRequest("POST", `/api/card-runs/${runId}/stop`, {})
      .catch((error) => console.warn("[runs] stop request failed:", error.message));
    // Wake the poll loop after stopGeneration() has run, so it sees the stop.
    setTimeout(() => this._cardRunWake?.(), 0);
  },

  /**
   * On load: a run this page's predecessor started (the marker has its id), or
   * one that is running for this user on any device. Returns true if a card
   * was put on screen.
   */
  async recoverCardRun(marker) {
    let run = null;
    if (marker?.runId) {
      run = await this._cardRunRequest("GET", `/api/card-runs/${marker.runId}?card=1`).catch(() => null);
    } else if (this.serverRunsEnabled()) {
      const list = await this._cardRunRequest("GET", "/api/card-runs?active=1").catch(() => null);
      const active = list?.runs?.[0];
      if (active) run = await this._cardRunRequest("GET", `/api/card-runs/${active.id}?card=1`).catch(() => null);
    }
    if (!run) return false;

    if (run.status === "running" || run.status === "interrupted") return this._attachToCardRun(run, { own: !!marker?.runId });
    if (!run.historyId) return false;

    // It ended while this page was away. The card is in History, whole or not.
    if (!(await this.loadCardIntoEditor(run.historyId, { quiet: true }))) return false;
    this._restoreCardSelects({ pov: run.pov, cardType: run.cardType });
    const name = this.currentCharacter?.name || "A character";
    const missing = [];
    for (const [field, label] of [["mesExample", "example messages"], ["creatorNotes", "creator's notes"], ["postHistoryInstructions", "post-history instructions"]]) {
      if (!this.currentCharacter[field]) missing.push(label);
    }
    if (!this.currentImageUrl) missing.push("portrait");
    const how = run.status === "done" ? "was finished by the server while the app was closed" : `stopped on the server (${run.error || run.status})`;
    const rest = missing.length ? ` Still to generate: ${missing.join(", ")}.` : "";
    this.showStreamMessage(`♻️ ${name} ${how}.${rest}\n`);
    this.showNotification(`${name} ${how}.${rest}`, run.status === "done" ? "success" : "warning");
    return true;
  },

  /**
   * A run still in progress: become the page that is watching it. `own` is
   * true when this browser started it (its marker named the run). Only then
   * does this page draw the portrait at the end: a second device that is just
   * looking on must not pay for a second one.
   */
  async _attachToCardRun(run, { own = false } = {}) {
    if (this.isGenerating) return false;
    this.isGenerating = true;
    this.setGeneratingState(true);
    this.hideResultSection();
    this.clearStream();
    const details = document.getElementById("input-section-details");
    if (details) details.open = true;
    this.showStreamMessage("♻️ A character is being made on the server. Picking it up...\n\n");
    if (own) {
      NewCardMarker.begin({ cardType: run.cardType, pov: run.pov, mode: "attached" });
      NewCardMarker.update({ runId: run.id });
    }
    try {
      await this._followCardRun(run.id);
      const finished = await this._cardRunRequest("GET", `/api/card-runs/${run.id}`);
      if (!(await this.loadCardIntoEditor(finished.historyId, { quiet: true }))) {
        throw new Error("The finished card could not be loaded from History");
      }
      this._restoreCardSelects({ pov: run.pov, cardType: run.cardType });
      this.showStreamMessage("\n✅ Character generation complete!\n");

      // The portrait is this page's step. A reference image was stored as the
      // portrait by the run, so there is one already in that case.
      const canDraw = this.config.get("api.image.baseUrl") && this.config.get("api.image.apiKey") && this.config.get("app.enableImageGeneration");
      if (own && !this.currentImageUrl && canDraw) {
        try {
          this.showStreamMessage("🎨 Generating character image...\n");
          await this.generateNewCharacterImage();
          this.showStreamMessage("✅ Image generation complete!\n");
        } catch (imageError) {
          if (imageError.message?.includes(CARD_RUN_STOPPED)) throw imageError;
          this.showStreamMessage(`⚠️ Image generation failed: ${imageError.message}\n`);
        }
        this._draftHistorySave = Promise.resolve(finished.historyId);
        await this.saveCardToLibrary();
      }
      this.refreshLibraryViews();
      this.showNotification("Character generated successfully!", "success");
      return true;
    } catch (error) {
      if (error.message?.includes(CARD_RUN_STOPPED)) {
        this.showStreamMessage("\n🛑 Generation stopped.\n");
      } else {
        this.showStreamMessage(`❌ Error: ${error.message}\n`);
        this.showNotification(`Generation failed: ${error.message}`, "error");
      }
      return false;
    } finally {
      if (own) this._endNewCard();
      else this._draftHistorySave = null;
      this.isGenerating = false;
      this.setGeneratingState(false);
    }
  },

});

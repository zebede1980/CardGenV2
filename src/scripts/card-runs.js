// Card runs, the page's half — extends CharacterGeneratorApp prototype
//
// With "Make new characters on the server" on (Settings → app.serverRuns), the
// card, its finishing fields and its portrait are made by a run on the proxy
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
  async writeNewCard({ mode = "classic", concept = "", brief = "", characterName = "", pov, cardType, searchQuery = "", searchScenario = "", resetStyle = true, autoCast = false, stopMark }) {
    this._serverPortrait = null;
    this._serverCastDone = false;
    if (this.serverRunsEnabled()) {
      // It carries on if this page is frozen or discarded, and the card is in
      // History either way: text, finishing fields, supporting cast and
      // portrait. This page only shows the progress.
      const canDraw = !!(this.config.get("api.image.baseUrl") && this.config.get("api.image.apiKey") && this.config.get("app.enableImageGeneration"));
      this.currentCharacter = await this.runNewCardOnServer({
        cast: { want: !!autoCast },
        portrait: {
          want: canDraw && !this.referenceImageDataUrl,
          resetStyle,
          referenceDescription: document.getElementById("reference-image-description")?.value?.trim() || "",
          guidance: document.getElementById("prompt-guidance")?.value?.trim() || "",
        },
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
      // The cast step's entries arrive in the card's character_book. They have
      // to be in the Lorebook Manager's list, which every save rebuilds the book from.
      this.lorebookEntries = this._lorebookEntriesFromBook(this.currentCharacter.character_book);
      this.updateLorebookEntryCount();
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

  // The server didn't answer, or only a gateway did (nginx while the proxy
  // restarts): worth asking again. Anything else is an answer.
  _cardRunUnreachable(error) {
    return !error.status || [502, 503, 504].includes(error.status);
  },

  /**
   * _cardRunRequest, asked up to `attempts` times while the server can't be
   * reached. The connection often comes back a moment after the screen does.
   */
  async _cardRunRequestPatiently(method, path, body, attempts = 4) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._cardRunRequest(method, path, body);
      } catch (error) {
        if (!this._cardRunUnreachable(error) || attempt >= attempts) throw error;
        await this._cardRunPause(800 * attempt);
        await window.apiHandler._waitUntilVisible();
      }
    }
  },

  /**
   * Have the proxy make a new character from `spec`, and follow it to the end.
   * Resolves the finished card; its portrait, if the run drew one, is left for
   * generateNewCharacterImage to show. Throws "Generation stopped by user" on
   * Stop, like the page's own pipeline.
   */
  async runNewCardOnServer(spec) {
    return this._startAndFollowCardRun("new-card", spec);
  },

  async _startAndFollowCardRun(kind, spec) {
    // Made before the request and kept in the marker, so sending it twice (a
    // retry here, or iOS re-sending the POST) is one run, not two paid ones.
    const key = window.crypto?.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
    NewCardMarker.update({ runKey: key });

    const run = await this._cardRunRequestPatiently("POST", "/api/card-runs", { key, kind, spec, settings: this.config.config });
    NewCardMarker.update({ runId: run.id });
    return this._followCardRun(run.id);
  },

  /**
   * An AI rewrite of the card on screen: Revise, Remaster, Reduce tokens and
   * Consistency auto-fix all come through here. Resolves the revised card;
   * applying it is the caller's job, usually after the diff dialog.
   *
   * With server runs on, the proxy does the rewrite (and, for Revise, the
   * finishing fields), and saves the result to History as a new item whether
   * or not this page is still here: never over the Library card. The caller's
   * save replaces that item when the change is accepted; _dropRevisionDraft
   * removes it when the change is discarded.
   *
   * Either way, anything typed into the card while it was running is kept.
   */
  async reviseCard(instruction, pov, { withFinishing = false } = {}) {
    const asked = this._captureCardSnapshot();
    this._revisionHistoryId = null;
    let revised;

    if (this.serverRunsEnabled()) {
      let portraitImage = "";
      if (this.currentImageUrl && typeof this._urlToDataUrl === "function") {
        portraitImage = await this._urlToDataUrl(this.currentImageUrl).catch(() => "");
      }
      NewCardMarker.begin({ mode: "revise", pov, cardType: this.currentCharacter.cardType || "single" });
      try {
        revised = await this._startAndFollowCardRun("revise", {
          card: this.currentCharacter,
          instruction,
          pov,
          withFinishing,
          exampleCount: parseInt(document.getElementById("example-messages-count")?.value || "3", 10),
          exampleStyle: document.getElementById("example-messages-prompt")?.value?.trim() || "",
          lorebookEntries: this.lorebookEntries || [],
          portraitImage,
        });
        this._revisionHistoryId = this._lastRunHistoryId || null;
      } finally {
        NewCardMarker.clear();
      }
    } else {
      revised = await this.apiHandler.reviseCharacter(this.currentCharacter, instruction, pov);
      if (withFinishing) {
        // Rewrite the derived fields to match the revised card, so the edit is
        // reviewed and accepted as a whole.
        this.showNotification("Updating example messages, creator's notes and post-history...", "info");
        await this.fillFinishingFields(revised, { revisionNote: instruction });
      }
    }
    return this._keepEditsMadeMeanwhile(asked, revised);
  },

  /**
   * A rewrite takes a minute or two and the fields stay editable. Whatever was
   * typed in a field since the rewrite was asked for wins over the AI's text
   * for that field; the AI's whole version is kept in History so it can still
   * be had.
   */
  async _keepEditsMadeMeanwhile(asked, revised) {
    const now = this._captureCardSnapshot();
    if (!asked || !now) return revised;
    const labels = {
      name: "Name", description: "Description", personality: "Personality", scenario: "Scenario",
      firstMessage: "First Message", mesExample: "Example Messages", creatorNotes: "Creator's Notes",
      postHistoryInstructions: "Post-History Instructions",
    };
    const edited = Object.keys(labels).filter((field) => now[field] !== asked[field]);
    if (edited.length === 0) return revised;

    const aiVersion = JSON.parse(JSON.stringify(revised));
    for (const field of edited) revised[field] = now[field];

    if (this._revisionHistoryId) {
      // The run's History item is the AI's whole version. Leave it there: the
      // save after an accept makes its own item instead of replacing it.
      this._draftHistorySave = null;
      this._revisionHistoryId = null;
    } else if (this.storage && this.storageReady) {
      await this.storage.saveCard({
        characterName: aiVersion.name || "Unnamed Character",
        character: aiVersion,
        isPermanent: false,
        draft: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).catch((error) => console.warn("Could not keep the AI's version in History:", error));
    }
    this.showNotification(
      `Kept what you typed in ${edited.map((f) => labels[f]).join(", ")} while that was running. The AI's version is in History.`,
      "info",
    );
    return revised;
  },

  /** The revision was discarded: its History item, if a run made one, goes too. */
  async _dropRevisionDraft() {
    const id = this._revisionHistoryId;
    this._revisionHistoryId = null;
    if (!id) return;
    this._draftHistorySave = null;
    await this.storage.deleteCard(id).catch((error) => console.warn("Could not remove the discarded revision from History:", error));
    this.refreshLibraryViews?.();
  },

  /** Poll a run until it ends, showing its text and messages as they arrive. */
  async _followCardRun(runId) {
    this._activeRunId = runId;
    const stopMark = window.apiHandler.stopMark();
    let shown = 0;       // characters of card text already on screen
    let logSeen = 0;     // run messages already on screen
    let offline = 0;
    let resumed = false;
    // The run doesn't need the screen on, but someone watching the card being
    // written does: same as the page's own pipeline. Released when hidden.
    window.wakeLockManager?.acquire();
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
          if (!this._cardRunUnreachable(error)) throw error;
          // No connection (it often returns a moment after the screen does), or the
          // proxy is restarting. The run doesn't need this page; keep asking until
          // it answers or Stop is pressed.
          offline++;
          if (offline === 4) this.showStreamMessage("\n⏳ Waiting for the server...\n");
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
          this._lastRunHistoryId = run.historyId;
          NewCardMarker.update({ historyId: run.historyId });
          // generateNewCharacterImage shows the run's portrait instead of drawing one.
          this._serverPortrait = run.portrait ? { status: run.portrait, error: run.portraitError, historyId: run.historyId } : null;
          // The run did (or tried) the cast step, so the page must not repeat it.
          this._serverCastDone = run.cast !== null && run.cast !== undefined;
          return run.card;
        }
        if (run.status === "stopped") throw new Error(CARD_RUN_STOPPED);
        if (run.status === "interrupted" && !resumed) {
          resumed = true;
          this.showStreamMessage("\n⚠️ The server restarted. Carrying on...\n");
          await this._cardRunRequestPatiently("POST", `/api/card-runs/${runId}/resume`, { settings: this.config.config });
          continue;
        }
        if (run.status !== "running") throw new Error(run.error || "The generation failed on the server");

        await this._cardRunPause(CARD_RUN_POLL_MS);
      }
    } finally {
      this._activeRunId = null;
      window.wakeLockManager?.release();
    }
  },

  /** Put the portrait a run stored with the card on screen as this card's image. */
  async _adoptServerPortrait(historyId) {
    const stored = await this.storage.getCard(historyId);
    if (!(stored?.imageBlob instanceof Blob)) throw new Error("The portrait the server drew could not be loaded");
    this.currentImageUrl = URL.createObjectURL(stored.imageBlob);
    const container = document.getElementById("image-content");
    if (container) {
      container.innerHTML = '<div class="image-container"><img alt="Character portrait" class="generated-image"></div>';
      container.querySelector("img").src = this.currentImageUrl;
    }
    // Lets the prompt editor show what was sent, as after a page-drawn portrait.
    if (window.apiHandler) window.apiHandler.lastGeneratedImagePrompt = this.currentCharacter?.imagePrompt || null;
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
      // Throws if the server can't be reached: the caller then keeps the marker,
      // so the next load asks again. A 404 means the run is gone for good.
      run = await this._cardRunRequestPatiently("GET", `/api/card-runs/${marker.runId}?card=1`).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      });
    } else if (this.serverRunsEnabled()) {
      const list = await this._cardRunRequest("GET", "/api/card-runs?active=1").catch(() => null);
      const active = list?.runs?.[0];
      if (active) run = await this._cardRunRequest("GET", `/api/card-runs/${active.id}?card=1`).catch(() => null);
    }
    if (!run) return false;

    if (run.kind === "revise") {
      // Only the browser that asked for it picks a revision back up.
      return marker?.runId ? this._recoverRevision(run) : false;
    }
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
   * A revision whose page went away. Nothing was on screen to protect when
   * this page loaded, so the revised card itself is loaded from History, once
   * the run has finished. The card it was made from is untouched.
   */
  async _recoverRevision(run) {
    try {
      if (run.status === "running" || run.status === "interrupted") {
        this.setRevisionState(true, "revise-character-btn");
        this.showNotification("A revision is still being written on the server. Picking it up...", "info");
        await this._followCardRun(run.id);
      }
      const finished = await this._cardRunRequest("GET", `/api/card-runs/${run.id}`);
      this._draftHistorySave = null;
      if (finished.status !== "done" || !finished.historyId) return false;
      if (!(await this.loadCardIntoEditor(finished.historyId, { quiet: true }))) return false;
      this._restoreCardSelects({ pov: finished.pov, cardType: finished.cardType });
      const name = this.currentCharacter?.name || "The card";
      this.showNotification(`${name}: the revision you asked for was finished by the server. This is the revised card; the one before it is still in your Library or History.`, "success");
      return true;
    } catch (error) {
      console.warn("[recovery] could not pick up the revision:", error);
      return false;
    } finally {
      this.setRevisionState(false);
    }
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
      // Only when the run had no portrait step of its own; if it tried and
      // failed, its message is already in the output above.
      this._serverPortrait = null;
      if (own && !this.currentImageUrl && canDraw && finished.portrait === null) {
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

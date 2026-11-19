// New-card recovery — extends CharacterGeneratorApp prototype
//
// Creating a character is a chain of requests that this page conducts: the
// card, its finishing fields, the cast, the portrait. Each request is held by
// the proxy and survives a locked phone, but the chain lived only in this
// page's memory. If Safari discarded the tab part-way, the next load showed an
// empty form and a card that had been paid for was gone.
//
// Two things fix that until the chain itself runs on the server
// (plans/character-gen-backend-driven.md):
//   - the card is saved to History as soon as its text is parsed
//     (saveDraftToHistory in library-handler.js), and
//   - a marker in localStorage says a new card was in the making. A page that
//     loads and finds a marker nobody finished puts the card back on screen:
//     from History if it got that far, otherwise from the card job the proxy
//     is still holding.
//
// Recovery makes no paid calls. It says which parts still need generating.

const NewCardMarker = {
  KEY: "cardgen.newCard.v1",
  CHANNEL: "cardgen.newCard",
  // The proxy keeps an unread result for 24 hours; after that there is nothing to recover.
  MAX_AGE_MS: 24 * 60 * 60 * 1000,

  read() {
    try {
      const marker = JSON.parse(localStorage.getItem(this.KEY) || "null");
      if (!marker || typeof marker !== "object") return null;
      if (Date.now() - (marker.startedAt || 0) > this.MAX_AGE_MS) {
        this.clear();
        return null;
      }
      return marker;
    } catch (_) {
      return null;
    }
  },

  _write(marker) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(marker));
    } catch (_) {
      // Storage full or unavailable: recovery just won't be offered.
    }
  },

  /** A new card is starting on this page. */
  begin(info = {}) {
    this._write({ ...info, historyId: null, startedAt: Date.now(), page: window.cardgenPage?.id || "" });
    this._listen();
  },

  update(patch) {
    const marker = this.read();
    if (marker && marker.page === (window.cardgenPage?.id || "")) this._write({ ...marker, ...patch });
  },

  /** This page's card is finished, failed or stopped. */
  clear() {
    try {
      localStorage.removeItem(this.KEY);
    } catch (_) { /* ignore */ }
  },

  // Tabs of one browser share localStorage, so a second tab opened while the
  // first is still generating would see its marker. The generating tab
  // answers "still here" on a BroadcastChannel; a discarded tab can't.
  _listen() {
    if (this._channel || typeof BroadcastChannel === "undefined") return;
    this._channel = new BroadcastChannel(this.CHANNEL);
    this._channel.onmessage = (event) => {
      const marker = this.read();
      if (event.data?.type !== "anyone" || !marker) return;
      if (marker.page === (window.cardgenPage?.id || "") && (window.app?.isGenerating || window.app?.isRevising)) {
        this._channel.postMessage({ type: "alive", startedAt: marker.startedAt });
      }
    };
  },

  /** True if the page that set `marker` answers within `waitMs`. */
  ownerIsAlive(marker, waitMs = 400) {
    if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const channel = new BroadcastChannel(this.CHANNEL);
      const finish = (alive) => {
        clearTimeout(timer);
        channel.close();
        resolve(alive);
      };
      const timer = setTimeout(() => finish(false), waitMs);
      channel.onmessage = (event) => {
        if (event.data?.type === "alive" && event.data.startedAt === marker.startedAt) finish(true);
      };
      channel.postMessage({ type: "anyone" });
    });
  },
};

window.NewCardMarker = NewCardMarker;

// Every page of this app answers "here" on this channel, so a page that has
// just loaded can tell whether another tab of this browser is open. It must
// not tidy up work that a tab which is still open is waiting for.
const CardgenPages = {
  CHANNEL: "cardgen.pages",
  // A page hears every other channel object of the same name, its own probe
  // included, so each message says which page it is from.
  me: () => window.cardgenPage?.id || "",
  start() {
    if (this._channel || typeof BroadcastChannel === "undefined") return;
    this._channel = new BroadcastChannel(this.CHANNEL);
    this._channel.onmessage = (event) => {
      if (event.data?.type === "who" && event.data.from !== this.me()) this._channel.postMessage({ type: "here", from: this.me() });
    };
  },
  /** True if another tab of this browser answers within `waitMs`. */
  anotherIsOpen(waitMs = 400) {
    if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const channel = new BroadcastChannel(this.CHANNEL);
      const finish = (open) => { clearTimeout(timer); channel.close(); resolve(open); };
      const timer = setTimeout(() => finish(false), waitMs);
      channel.onmessage = (event) => { if (event.data?.type === "here" && event.data.from !== this.me()) finish(true); };
      channel.postMessage({ type: "who", from: this.me() });
    });
  },
};
CardgenPages.start();

// Labels of the image jobs Character Gen starts (api-image.js).
const CARD_IMAGE_JOB_LABELS = new Set(["Character image", "Image edit"]);
// A job newer than this may belong to a page that is merely slow to wake.
const ORPHANED_IMAGE_AFTER_MS = 2 * 60 * 1000;

// Image requests made from Character Gen carry the card they are for, so the
// proxy can save a picture nobody collected as a History copy of that card.
if (window.apiHandler) {
  window.apiHandler.imageLanding = () => window.app?._imageLanding?.() || null;
}

Object.assign(CharacterGeneratorApp.prototype, {

  /**
   * The card an image request from this page is for, or null: only on the
   * Character Gen view, with a card on screen. While a new card is being made
   * the picture replaces its draft in History rather than adding a second item.
   */
  _imageLanding() {
    if (this._noImageLanding || !this.currentCharacter) return null;
    if (window.cardgenPage?.view() !== "cardgen") return null;
    return { card: this.currentCharacter, replaceHistoryId: this._draftHistoryId || undefined };
  },

  /**
   * On load: pictures a previous page of this browser asked for and never
   * collected. Nothing here can show them the way their screen would have, so
   * the proxy is asked to save each with its card in History now, rather than
   * when its grace period runs out.
   */
  async landOrphanedImages() {
    try {
      const now = Date.now();
      const orphans = (window.ResumableJobs?.list() || [])
        .filter((job) => CARD_IMAGE_JOB_LABELS.has(job.label) && now - (job.startedAt || 0) > ORPHANED_IMAGE_AFTER_MS);
      if (orphans.length === 0) return;
      if (await CardgenPages.anotherIsOpen()) return; // that tab may still be waiting for them

      const res = await window.authFetch("/api/jobs/land", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRefs: orphans.map((job) => job.clientRef) }),
      });
      if (!res.ok) return;
      const { landed = [] } = await res.json();
      for (const job of orphans) window.ResumableJobs.remove(job.clientRef);
      if (landed.length === 0) return;

      const names = [...new Set(landed.map((item) => item.name).filter(Boolean))].join(", ");
      const what = landed.length === 1 ? "A picture" : `${landed.length} pictures`;
      this.showNotification(`${what} drawn while the app was closed ${landed.length === 1 ? "is" : "are"} in History${names ? ` with ${names}` : ""}.`, "info");
      this.refreshLibraryViews?.();
    } catch (error) {
      console.warn("[recovery] could not land uncollected pictures:", error);
    }
  },

  /** A new-card pipeline is starting on this page. Returns its token for _endNewCard. */
  _beginNewCard() {
    this._newCardFlow = (this._newCardFlow || 0) + 1;
    return this._newCardFlow;
  },

  /**
   * A new-card pipeline on this page has ended, whichever way. Returns false,
   * and touches nothing, if a newer pipeline has started since `flow` did.
   */
  _endNewCard(flow) {
    if (flow !== undefined && flow !== this._newCardFlow) return false;
    this._draftHistorySave = null;
    this._draftHistoryId = null;
    this._serverPortrait = null;
    this._serverCastDone = false;
    NewCardMarker.clear();
    return true;
  },

  /**
   * On load: put back a character whose pipeline was cut short by the page
   * going away. Never throws; a failure just leaves the form empty as before.
   */
  async recoverNewCard() {
    this.landOrphanedImages();
    const marker = NewCardMarker.read();
    if (marker) {
      // Another tab is still making it: the marker is that tab's, so leave it be.
      if (await NewCardMarker.ownerIsAlive(marker)) return false;
      if (this.isGenerating || this.currentCharacter) return false; // something newer is already on screen
    }

    // A card run on the proxy (card-runs.js): this page's own, named in the
    // marker, or one in progress for this user that another device started.
    if (marker?.runId || (!marker && this.serverRunsEnabled?.())) {
      try {
        if (await this.recoverCardRun(marker)) {
          NewCardMarker.clear();
          return true;
        }
      } catch (error) {
        // The server couldn't be asked. The run doesn't need this page, and
        // the marker stays so the next load can pick it up.
        console.warn("[recovery] could not pick up the card run:", error);
        return false;
      }
    }
    if (!marker) return false;

    try {
      let missing;
      if (marker.historyId) {
        if (!(await this.loadCardIntoEditor(marker.historyId, { quiet: true }))) return false;
        missing = await this._recoverFinishingFields(marker);
      } else {
        if (!(await this._recoverCardFromJob(marker))) return false;
        missing = ["example messages", "creator's notes", "post-history instructions"];
      }
      if (!this.currentImageUrl) missing.push("portrait");

      const name = this.currentCharacter?.name || "A character";
      const rest = missing.length
        ? ` Still to generate: ${missing.join(", ")}.`
        : "";
      this.showStreamMessage?.(`♻️ Recovered ${name}: the app closed while it was being made.${rest}\n`);
      this.showNotification(`Recovered ${name} from before the app closed.${rest}`, "info");
      return true;
    } catch (error) {
      console.warn("[recovery] could not recover the last character:", error);
      return false;
    } finally {
      NewCardMarker.clear();
    }
  },

  /** The newest job with `label` that this marker's pipeline started, or null. */
  _pendingJobFor(marker, label) {
    const jobs = (window.ResumableJobs?.list() || [])
      .filter((job) => job.label === label && (job.startedAt || 0) >= marker.startedAt - 2000);
    return jobs.length ? jobs[jobs.length - 1] : null;
  },

  /** A held job's reply text, waiting while it is still being written. "" if it can't be had. */
  async _collectJobText(job) {
    const result = await this.apiHandler._tryCollectResult(job.clientRef, false, { maxWaitMs: 15 * 60 * 1000 });
    window.ResumableJobs?.remove(job.clientRef);
    const choice = result?.choices?.[0];
    return { text: choice?.message?.content || "", finishReason: choice?.finish_reason || null };
  },

  /** The page died while the card itself was being written: rebuild it from the held job. */
  async _recoverCardFromJob(marker) {
    const job = this._pendingJobFor(marker, "Character card");
    if (!job) return false;

    this.showStreamMessage?.("♻️ Collecting a character that was being written when the app closed…\n");
    const { text, finishReason } = await this._collectJobText(job);
    if (!text) return false;
    // Throws on an empty reply or a refusal, exactly as a live generation would.
    this.apiHandler._checkCardWritten(text, { finishReason });

    const cardType = marker.cardType || "single";
    const character = this.characterGenerator.parseCharacterData(text);
    character.cardType = cardType;
    if (cardType === "group" || cardType === "scenario") {
      character.tags = Array.isArray(character.tags) ? character.tags : [];
      if (!character.tags.includes(cardType)) character.tags.push(cardType);
    }

    this.stSourceAvatar = null;
    this._updatePushButton?.();
    this._resetCharacterMediaState?.();
    this._clearCharacterGallery?.();
    this.lorebookEntries = [];
    this.updateLorebookEntryCount?.();
    this.altGreetings = [];
    this.updateAltGreetingsCount?.();

    this.currentCharacter = character;
    this.originalCharacter = JSON.parse(JSON.stringify(character));
    this._restoreCardSelects(marker);
    this.displayCharacter();
    this._showRecoveredCard();

    await this.saveCardToLibrary();
    this.refreshLibraryViews();
    return true;
  },

  /**
   * The card was already in History; the finishing-fields reply may be waiting
   * too. Applies it if so. Returns the fields that are still empty.
   */
  async _recoverFinishingFields(marker) {
    const character = this.currentCharacter;
    const labels = { mesExample: "example messages", creatorNotes: "creator's notes", postHistoryInstructions: "post-history instructions" };
    const empty = () => Object.keys(labels).filter((key) => !character[key]);
    this._restoreCardSelects(marker);
    if (!empty().length) return [];

    const job = this._pendingJobFor(marker, "Card finishing fields");
    if (job) {
      try {
        const { text, finishReason } = await this._collectJobText(job);
        const fields = text ? this.apiHandler.parseFinishingFields(text, { truncated: finishReason === "length" }) : {};
        let applied = false;
        for (const key of empty()) {
          if (fields[key]) { character[key] = fields[key]; applied = true; }
        }
        if (applied) {
          this.originalCharacter = JSON.parse(JSON.stringify(character));
          this.displayCharacter();
          // Replaces the draft in History rather than adding a second item.
          this._draftHistorySave = Promise.resolve(marker.historyId);
          await this.saveCardToLibrary();
          this.refreshLibraryViews();
        }
      } catch (error) {
        console.warn("[recovery] finishing fields could not be collected:", error);
      }
    }
    return empty().map((key) => labels[key]);
  },

  // Redo and Regenerate read these selects, so put them back to what the card was made with.
  _restoreCardSelects(marker) {
    const povSelect = document.getElementById("pov-select");
    if (povSelect && marker.pov && [...povSelect.options].some((o) => o.value === marker.pov)) povSelect.value = marker.pov;
    const typeSelect = document.getElementById("card-type-select");
    if (typeSelect && marker.cardType && typeSelect.value !== marker.cardType &&
        [...typeSelect.options].some((o) => o.value === marker.cardType)) {
      typeSelect.value = marker.cardType;
      typeSelect.dispatchEvent(new Event("change"));
    }
  },

  _showRecoveredCard() {
    this.showResultSection();
    const inputSectionDetails = document.getElementById("input-section-details");
    if (inputSectionDetails) inputSectionDetails.open = false;
    const imageControls = document.getElementById("image-controls");
    if (imageControls) imageControls.style.display = "block";
    const imageButtons = document.getElementById("image-buttons-row");
    if (imageButtons) imageButtons.style.display = "";
    const imageContainer = document.getElementById("image-content");
    if (imageContainer && !this.currentImageUrl) {
      imageContainer.innerHTML = `<div class="image-placeholder"><div class="loading-spinner" style="display:none;"></div><p style="color:var(--text-secondary);font-size:0.875rem;">No image</p></div>`;
    }
  },

});

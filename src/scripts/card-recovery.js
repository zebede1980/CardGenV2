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

// The card on Character Gen's screen, written each time the page is hidden.
// A page can be replaced while the app is in the background (a tap on a
// notification that loads a URL, iOS discarding it), and the next one used to
// start with an empty form. It puts this card back instead: the last stored
// copy for the portrait and pictures, then the text as it was on screen, so
// edits that were never saved survive too.
const OpenCardMarker = {
  KEY: "cardgen.openCard.v1",
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
  // A card's text is tens of KB; this only stops a freak one filling localStorage.
  MAX_TEXT_CHARS: 1.5 * 1024 * 1024,

  read() {
    try {
      const marker = JSON.parse(localStorage.getItem(this.KEY) || "null");
      if (!marker || typeof marker !== "object" || Date.now() - (marker.at || 0) > this.MAX_AGE_MS) return null;
      return marker;
    } catch (_) {
      return null;
    }
  },

  remember(app) {
    try {
      if (!app?.storageReady) return; // still booting: what is stored is still right
      if (!app.currentCharacter) {
        localStorage.removeItem(this.KEY);
        return;
      }
      let character = JSON.stringify({
        ...app.currentCharacter,
        character_book: app.buildCharacterBook?.() ?? app.currentCharacter.character_book,
        alternateGreetings: (app.altGreetings || []).map((g) => g.content),
      });
      if (character.length > this.MAX_TEXT_CHARS) character = null;
      localStorage.setItem(this.KEY, JSON.stringify({
        at: Date.now(),
        cardKey: app._editorCardKey(),
        currentCardId: app.currentCardId || null,
        storedId: app._lastStoredId || null,
        stSourceAvatar: app.stSourceAvatar || null,
        pov: document.getElementById("pov-select")?.value || "",
        cardType: document.getElementById("card-type-select")?.value || "",
        character,
      }));
    } catch (_) {
      // Storage full or unavailable: the next page just starts empty, as before.
    }
  },

  start() {
    // "hidden" is the last moment a page is sure to run: iOS may freeze or
    // drop it after that without another event.
    const save = () => this.remember(window.app);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
    window.addEventListener("pagehide", save);
  },
};
OpenCardMarker.start();
window.OpenCardMarker = OpenCardMarker;

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
    // cardKey stays in the browser (api.js takes it off): it ties the job to
    // the card on screen for collectPicturesLeftBehind.
    return { card: this.currentCharacter, replaceHistoryId: this._draftHistoryId || undefined, cardKey: this._editorCardKey() };
  },

  /** Names the card on screen, the same way in this page and the next one. */
  _editorCardKey() {
    if (!this.currentCharacter) return null;
    return this.currentCardId || this._draftHistoryId || `name:${this.currentCharacter.name || ""}`;
  },

  /**
   * On load, with nothing else on screen: put back the card that was there
   * when the last page was hidden (OpenCardMarker). Returns true if it did.
   */
  async restoreOpenCard() {
    const marker = OpenCardMarker.read();
    if (!marker || this.currentCharacter || this.isGenerating) return false;
    let snapshot = null;
    try { snapshot = marker.character ? JSON.parse(marker.character) : null; } catch (_) { snapshot = null; }
    try {
      const loaded = marker.storedId ? await this.loadCardIntoEditor(marker.storedId, { quiet: true }) : false;
      if (!loaded && !snapshot) return false;
      if (this.isGenerating) return false; // the user started something while it loaded
      if (snapshot) {
        // The text as it was on screen, which may be newer than the stored copy.
        if (!loaded) {
          this._resetCharacterMediaState?.();
          this.originalCharacter = JSON.parse(JSON.stringify(snapshot));
        }
        this.currentCharacter = snapshot;
        this.lorebookEntries = this._lorebookEntriesFromBook(snapshot.character_book);
        this.updateLorebookEntryCount?.();
        this.altGreetings = (snapshot.alternateGreetings || []).map((content, i) => ({ id: `${Date.now()}${i}`, content }));
        this.updateAltGreetingsCount?.();
        this.displayCharacter();
        if (!loaded) this._showRecoveredCard();
      }
      this._restoreCardSelects({ pov: marker.pov, cardType: marker.cardType });
      // The card it was, not the History copy its pictures were read from.
      this.currentCardId = marker.currentCardId || null;
      this._lastStoredId = marker.storedId || null;
      this.stSourceAvatar = marker.stSourceAvatar || null;
      this._updatePushButton?.();
      this._renderCharacterGalleryPanel?.();
      this._restoredCardKey = marker.cardKey || null;
      return true;
    } catch (error) {
      console.warn("[recovery] could not put back the card that was open:", error);
      return false;
    }
  },

  /**
   * On load, with no other tab open: Character Gen pictures a previous page
   * of this browser asked for and never collected. Those for the card just
   * put back on screen are offered to pick from, as their own screen would
   * have; the rest are saved to History with their cards.
   */
  async handlePicturesLeftBehind() {
    try {
      const jobs = (window.ResumableJobs?.list() || []).filter((job) => CARD_IMAGE_JOB_LABELS.has(job.label));
      if (jobs.length === 0) return;
      const key = this._restoredCardKey;
      const mine = key && this.currentCharacter ? jobs.filter((job) => job.cardKey === key) : [];
      await this.landOrphanedImages(jobs.filter((job) => !mine.includes(job)));
      if (mine.length) this._whenCardGenShown(() => this.offerPicturesLeftBehind(mine));
    } catch (error) {
      console.warn("[recovery] could not deal with pictures left behind:", error);
    }
  },

  /** Run `fn` now if Character Gen is on screen, else the next time it is. */
  _whenCardGenShown(fn) {
    if (window.cardgenPage?.view() === "cardgen") return fn();
    const tab = document.getElementById("tab-cardgen");
    if (!tab) return fn();
    tab.addEventListener("click", () => setTimeout(fn, 0), { once: true });
  },

  /**
   * The pick-one screen again, for pictures whose page went away: Keep
   * current first, then each picture as it is collected. Nothing is collected
   * once the screen is gone (picked, kept, closed): those are left to the
   * proxy, which saves them to History, so none is lost.
   */
  async offerPicturesLeftBehind(jobs) {
    const character = this.currentCharacter;
    if (!character || this._pendingCandidateUrls) return;
    const modal = document.getElementById("image-options-modal");
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    if (!modal || !grid) return;

    this.openImageOptionsModal();
    if (modalTitle) modalTitle.textContent = "🖼️ Drawn while the app was away: pick one";
    if (loading) loading.style.display = "none";
    grid.innerHTML = "";
    if (!grid.dataset.defaultColumns) grid.dataset.defaultColumns = grid.style.gridTemplateColumns;
    grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(min(120px, 100%), 1fr))";

    const landedUrls = [];
    const landed = [];
    this._pendingCandidateUrls = landedUrls;
    const live = () => this._pendingCandidateUrls === landedUrls && modal.classList.contains("show");

    const tiles = jobs.map((job) => {
      const tile = document.createElement("div");
      tile.className = "left-behind-tile";
      tile.style.cssText = "border:2px solid transparent;border-radius:0.5rem;overflow:hidden;background:var(--surface-color);position:relative;display:flex;flex-direction:column;";
      tile.innerHTML = `
        <div class="compare-body" style="min-height:12rem;display:flex;align-items:center;justify-content:center;padding:1rem;text-align:center;color:var(--text-secondary);font-size:0.85rem;">⏳ Collecting…</div>
        <div class="compare-label" style="padding:0.5rem;text-align:center;font-size:0.8rem;color:var(--text-secondary);background:rgba(0,0,0,0.1);border-top:1px solid var(--border);font-family:monospace;overflow-wrap:anywhere;"></div>`;
      tile.querySelector(".compare-label").textContent = job.model || "picture";
      grid.appendChild(tile);
      return tile;
    });
    this._insertCurrentImageCard(grid, landedUrls);

    const results = await Promise.all(jobs.map((job, i) => this._collectPictureLeftBehind(job, tiles[i], { live, character, landed, landedUrls })));
    if (!live()) return;
    const got = results.filter(Boolean).length;
    if (got === 0) {
      this._pendingCandidateUrls = null;
      this.closeImageOptionsModal();
      this.showNotification("The pictures drawn while the app was away could not be collected. Any that were finished are in History.", "warning", 6000);
    } else {
      this.showNotification(`${got === 1 ? "A picture" : `${got} pictures`} drawn while the app was away: tap the one you want.`, "info");
    }
  },

  /** One picture into its tile. Returns true if it was shown. */
  async _collectPictureLeftBehind(job, tile, { live, character, landed, landedUrls }) {
    const body = tile.querySelector(".compare-body");
    const say = (text) => { if (body && live()) body.textContent = text; };
    try {
      // Wait without collecting, so a picture whose screen has gone is still
      // the proxy's to save.
      const state = await this._waitForImageJob(job.clientRef, live);
      if (state === "abandoned") {
        await this.landOrphanedImages([job], { now: true });
        return false;
      }
      if (!state) {
        window.ResumableJobs.remove(job.clientRef);
        say("Not held any more. If it was finished, it is in History.");
        return false;
      }
      const response = await this.apiHandler._tryCollectResult(job.clientRef, true, { maxWaitMs: 60 * 1000 });
      window.ResumableJobs.remove(job.clientRef);
      if (!response) {
        say("Not held any more. If it was finished, it is in History.");
        return false;
      }
      const result = await response.json();
      const remote = result?.data?.[0]?.url || result?.image || result?.url;
      if (!remote) throw new Error("No picture in the reply");
      const url = await this._fetchAsDisplayUrl(remote);
      if (!live()) {
        // Collected just as the screen went: keep it with the card, as Compare does.
        if (this.currentCharacter === character) {
          this._addToHistory(url);
          this.saveCardToLibrary().then(() => this.refreshLibraryViews()).catch((e) => console.warn("Saving a late picture failed:", e));
        }
        return false;
      }
      const entry = { url, prompt: job.prompt || "", model: job.model || "", label: job.model || "picture" };
      landed.push(entry);
      landedUrls.push(url);
      tile.style.cursor = "pointer";
      tile.onclick = () => this.selectImageOption(url, entry.prompt, entry.model, landed);
      body.style.cssText = "";
      body.innerHTML = "";
      const img = document.createElement("img");
      img.src = url;
      img.alt = entry.label;
      img.style.cssText = "width:100%;height:auto;display:block;";
      body.appendChild(img);
      return true;
    } catch (error) {
      window.ResumableJobs.remove(job.clientRef);
      say(`❌ ${error.message}`);
      return false;
    }
  },

  /**
   * Polls a job's state without collecting it. Resolves the job when it has
   * finished (or failed), null if the proxy no longer has it, or "abandoned"
   * if the screen waiting for it went away first.
   */
  async _waitForImageJob(clientRef, live) {
    for (;;) {
      if (!live()) return "abandoned";
      await this.apiHandler._waitUntilVisible?.();
      try {
        const res = await window.authFetch(`/api/jobs?clientRef=${encodeURIComponent(clientRef)}`);
        if (res.ok) {
          const job = (await res.json()).jobs?.[0];
          if (!job) return null;
          window.ResumableJobs.update(clientRef, { jobId: job.id });
          if (job.status !== "running") return job;
        }
      } catch (_) {
        // No connection yet (just woken): keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  },

  /**
   * Asks the proxy to save these pictures with their cards in History now,
   * rather than when its grace period runs out. Without `now`, only those old
   * enough that the page that asked for them can't just be slow to wake.
   */
  async landOrphanedImages(jobs, { now: landNow = false } = {}) {
    try {
      const now = Date.now();
      const orphans = (jobs || []).filter((job) => landNow || now - (job.startedAt || 0) > ORPHANED_IMAGE_AFTER_MS);
      if (orphans.length === 0) return;

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
      this.showNotification(`${what} drawn while the app was away ${landed.length === 1 ? "is" : "are"} in History${names ? ` with ${names}` : ""}.`, "info");
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
   * On load: put back what the last page had on Character Gen. A character
   * whose making was cut short comes first; failing that, the card that was
   * open; then any pictures that were being drawn for it. Never throws.
   */
  async recoverNewCard() {
    let recovered = false;
    try {
      recovered = await this._recoverInterruptedNewCard();
    } finally {
      // With another tab open this is a second tab, not a replacement for a
      // page that went away: what that tab has on screen and is waiting for
      // stays its own.
      if (!(await CardgenPages.anotherIsOpen())) {
        if (!recovered && !this.currentCharacter && !this.isGenerating) await this.restoreOpenCard();
        await this.handlePicturesLeftBehind();
      }
    }
    return recovered;
  },

  /** A character whose pipeline was cut short by the page going away. */
  async _recoverInterruptedNewCard() {
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

// ✨ Prompt Builder — one sheet for writing image prompts, opened from
// Playground's Generate tab and from Character Gen's Look row. The host hands
// over the subject (an idea, or a character card) and gets back
// { prompt, look, generate }; the sheet knows nothing else about either page.
// The prompt itself is written by apiHandler.writeImagePrompt, the same writer
// behind every other image button.
//
// Phone lock: the write streams as a resumable job, so locking mid-write
// resumes on unlock (handleStreamResponse). Closing the sheet mid-write lets
// it finish in the background; reopening shows the result. Choices and the
// last result are kept per host in localStorage, so a discarded Safari tab
// comes back with them.

(function () {
  const PL = window.PromptLook;
  const STORE_KEY = "cardgen.promptBuilder.v1";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { return {}; }
  }
  function writeStore(host, data) {
    try {
      const all = readStore();
      all[host] = data;
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch { /* private mode or full: the sheet still works, it just won't remember */ }
  }

  function sameSubject(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === "idea" ? (a.idea || "").trim() === (b.idea || "").trim() : a.name === b.name && a.description === b.description;
  }

  class PromptBuilder {
    constructor() {
      this.el = null;
      this.opts = null;
      this.state = null;
      this.states = {};   // per host, so a write that finishes after closing is still there on reopen
      this.runs = {};     // per host run counter, to ignore abandoned writes
      this.lastFocus = null;
      // Match an image's picker lists, by tab ("cards" / "library").
      this.matchItems = {};
      this.matchLoading = {};
      this.matchError = {};
    }

    get config() { return window.apiHandler?.config; }

    // ── Looks available in the dropdown ──
    savedLooks() {
      const list = this.config?.get("api.image.looks");
      return Array.isArray(list) ? list.filter(l => l && l.id) : [];
    }
    presetLooks() {
      const select = document.getElementById("image-style");
      const opts = select ? [...select.options] : [];
      return opts
        .filter(o => o.value && o.value !== "custom")
        .map(o => ({
          id: `preset:${o.value}`,
          name: o.textContent.trim(),
          picks: { medium: [o.textContent.trim()] },
          extra: (window.apiHandler?.styleCues(o.value) || []).join(", "),
        }));
    }
    findLook(id) {
      if (!id) return null;
      if (id.startsWith("saved:")) return this.savedLooks().find(l => `saved:${l.id}` === id) || null;
      if (id.startsWith("builtin:")) return PL.STARTER_LOOKS.find(l => l.id === id) || null;
      if (id.startsWith("preset:")) return this.presetLooks().find(l => l.id === id) || null;
      return null;
    }

    // ── Open / close ──
    // opts: { host, subject, look, lookId, model, shape, onUse({ prompt, look, lookId, generate }) }
    open(opts) {
      this.opts = opts;
      this._ensureDom();
      const host = opts.host;
      const stored = readStore()[host] || {};
      const prefs = window.apiHandler.imagePromptPrefs(opts.model);
      const prev = this.states[host];

      // Same subject as last time — what the host passed then, or what it was
      // edited to in the sheet: carry on from where it was left.
      const resumable = prev && (sameSubject(prev.openedWith, opts.subject) || sameSubject(prev.subject, opts.subject));
      if (resumable) {
        this.state = prev;
        this.state.model = opts.model;
        this.state.shape = opts.shape;
      } else {
        const look = opts.look !== undefined ? PL.normalise(opts.look) : PL.normalise(stored.look);
        this.state = {
          screen: "steer",
          openedWith: { ...opts.subject },
          subject: { ...opts.subject },
          look: look || PL.emptyLook(),
          lookId: opts.look !== undefined ? (opts.lookId || (look ? "custom" : "")) : stored.lookId || "",
          format: prefs.format,
          detail: stored.detail || prefs.detail,
          nsfw: !!stored.nsfw,
          model: opts.model,
          shape: opts.shape,
          open: new Set(["medium"]),
          streamText: "",
          prompt: "",
          takes: [],
          chosenTake: 0,
          error: "",
          addingTo: null,
          savingLook: false,
          matching: false,
        };
        // Last result for this exact subject survives a closed sheet or a discarded tab.
        if (stored.prompt && (sameSubject(stored.subject, opts.subject) || sameSubject(stored.openedWith, opts.subject))) {
          if (opts.subject.kind === "idea" && stored.subject?.kind === "idea") this.state.subject.idea = stored.subject.idea;
          this.state.prompt = stored.prompt;
          this.state.lastPrompt = true;
        }
      }
      this.states[host] = this.state;
      if (this.state.screen === "match") this.state.screen = "steer";
      this.matchItems = {};
      this.matchError = {};

      this.lastFocus = document.activeElement;
      this.el.hidden = false;
      document.documentElement.classList.add("pb-open");
      this.render();
      this.el.querySelector("#pb-title")?.focus();
    }

    close() {
      if (!this.el || this.el.hidden) return;
      this._readInputs();
      this._persist();
      this.el.hidden = true;
      document.documentElement.classList.remove("pb-open");
      if (this.lastFocus?.focus) this.lastFocus.focus();
    }

    _persist() {
      const s = this.state;
      if (!s || !this.opts) return;
      writeStore(this.opts.host, {
        look: s.look, lookId: s.lookId, detail: s.detail, nsfw: !!s.nsfw,
        subject: s.subject, openedWith: s.openedWith, prompt: s.prompt || "",
      });
    }

    _ensureDom() {
      if (this.el) return;
      const el = document.createElement("div");
      el.id = "prompt-builder";
      el.className = "pb-overlay";
      el.hidden = true;
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-labelledby", "pb-title");
      el.innerHTML = `<div class="pb-sheet"><div class="pb-scroll" id="pb-scroll"></div><div class="pb-footer" id="pb-footer"></div></div>
        <input type="file" id="pb-match-file" accept="image/*" hidden>`;
      document.body.appendChild(el);
      this.el = el;

      el.addEventListener("click", (e) => this._onClick(e));
      el.addEventListener("change", (e) => this._onChange(e));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); this.close(); }
        if (e.key === "Enter" && e.target.id === "pb-custom-input") { e.preventDefault(); this._addCustom(); }
        if (e.key === "Enter" && e.target.id === "pb-look-name") { e.preventDefault(); this._saveLook(); }
      });
      // Match an image: filter the tiles in place, without re-rendering (keeps
      // the keyboard up on a phone).
      el.addEventListener("input", (e) => {
        if (e.target.id !== "pb-match-filter") return;
        const q = e.target.value.trim().toLowerCase();
        el.querySelectorAll(".pb-match-tile").forEach(tile => {
          tile.style.display = !q || tile.dataset.name.includes(q) ? "" : "none";
        });
      });
      // A tap on the dimmed backdrop (desktop) closes; choices are kept.
      el.addEventListener("mousedown", (e) => { if (e.target === el) this.close(); });
    }

    // ── Rendering ──
    render() {
      const s = this.state;
      const scroll = this.el.querySelector("#pb-scroll");
      const footer = this.el.querySelector("#pb-footer");
      const keepScroll = scroll.scrollTop;
      const html = {
        steer: () => this._steerHtml(),
        writing: () => this._writingHtml(),
        result: () => this._resultHtml(),
        takes: () => this._takesHtml(),
        match: () => this._matchHtml(),
      }[s.screen]();
      scroll.innerHTML = this._headerHtml() + html.body;
      footer.innerHTML = html.footer || "";
      footer.hidden = !html.footer;
      if (s.screen === "steer") scroll.scrollTop = keepScroll;
      if (s.screen === "writing") {
        const ta = scroll.querySelector("#pb-stream");
        if (ta) { ta.value = s.streamText; ta.scrollTop = ta.scrollHeight; }
      }
      if (s.addingTo) scroll.querySelector("#pb-custom-input")?.focus();
      if (s.savingLook) scroll.querySelector("#pb-look-name")?.focus();
      if (s.screen === "match") this._loadMatchItems(s.matchTab || "cards");
    }

    _headerHtml() {
      const s = this.state;
      const hostLabel = this.opts.host === "character" ? "Character Gen" : "Playground";
      const title = { steer: "✨ Prompt Builder", writing: "Writing your prompt…", result: "Your prompt", takes: "Pick a take", match: "Match an image" }[s.screen];
      const left = s.screen === "writing"
        ? `<button type="button" class="pb-icon" data-act="abandon" aria-label="Stop writing" title="Stop writing">■</button>`
        : s.screen === "steer"
          ? `<button type="button" class="pb-icon" data-act="close" aria-label="Close">✕</button>`
          : `<button type="button" class="pb-icon" data-go="${s.screen === "takes" && s.prompt ? "result" : "steer"}" aria-label="Back">‹</button>`;
      const right = s.screen !== "steer" ? `<button type="button" class="pb-icon" data-act="close" aria-label="Close">✕</button>` : "";
      return `<div class="pb-head">${left}<h2 id="pb-title" tabindex="-1">${title}</h2>${right}</div>
        <div class="pb-pills"><span class="pb-pill pb-pill-accent">${esc(s.model || "no model")}</span>${s.shape ? `<span class="pb-pill">${esc(s.shape)}</span>` : ""}<span class="pb-pill">${hostLabel}</span>${s.nsfw ? `<span class="pb-pill pb-pill-nsfw">🔞 NSFW</span>` : ""}</div>`;
    }

    _steerHtml() {
      const s = this.state;
      let what;
      if (s.subject.kind === "card") {
        const blurb = (s.subject.description || "").replace(/\*\*[^*]+\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 110);
        what = `<div class="pb-card"><div class="pb-avatar">${esc((s.subject.name || "?").slice(0, 2).toUpperCase())}</div>
            <div class="pb-card-meta"><strong>From the card: ${esc(s.subject.name || "Character")}</strong><span>${esc(blurb)}…</span></div></div>
          <label class="pb-label" for="pb-direction">Extra direction <span class="pb-soft">(optional)</span></label>
          <input type="text" id="pb-direction" class="input pb-input" maxlength="200" value="${esc(s.subject.direction || "")}" placeholder="e.g. wolf form, moonlit forest, mid-transformation">`;
      } else {
        what = `<label class="pb-label" for="pb-idea">Your idea</label>
          <textarea id="pb-idea" class="input pb-input" rows="3" maxlength="2000" placeholder="e.g. cyberpunk girl in white ceramic armour, street pose">${esc(s.subject.idea || "")}</textarea>
          <p class="pb-hint">Rough is fine. Everything you write is kept.</p>`;
      }

      const saved = this.savedLooks();
      const opt = (id, name) => `<option value="${esc(id)}" ${s.lookId === id ? "selected" : ""}>${esc(name)}</option>`;
      const lookSelect = `<select id="pb-look" class="input pb-input">
          ${opt("", "None — AI decides")}
          ${s.lookId === "custom" ? opt("custom", "Custom look (not saved)") : ""}
          ${saved.length ? `<optgroup label="Your looks">${saved.map(l => opt(`saved:${l.id}`, `★ ${l.name}`)).join("")}</optgroup>` : ""}
          <optgroup label="Starter looks">${PL.STARTER_LOOKS.filter(l => !l.group).map(l => opt(l.id, l.name)).join("")}</optgroup>
          <optgroup label="From your cards">${PL.STARTER_LOOKS.filter(l => l.group === "cards").map(l => opt(l.id, l.name)).join("")}</optgroup>
          ${this.presetLooks().length ? `<optgroup label="Style presets">${this.presetLooks().map(l => opt(l.id, l.name)).join("")}</optgroup>` : ""}
        </select>`;

      const saveRow = s.savingLook
        ? `<div class="pb-row"><input type="text" id="pb-look-name" class="input pb-input" maxlength="40" placeholder="Name this look" value="${esc(s.look.name && s.lookId === "custom" ? "" : s.look.name || "")}" style="flex:1; min-width:0;">
             <button type="button" class="btn-small btn-primary" data-act="save-look-confirm">Save</button><button type="button" class="btn-small" data-act="save-look-cancel">Cancel</button></div>`
        : `<div class="pb-row">
             <button type="button" class="btn-small" data-act="match" ${s.matching ? "disabled" : ""}>${s.matching ? "⏳ Reading image…" : "🖼️ Match an image"}</button>
             <button type="button" class="btn-small" data-act="save-look">★ Save look</button>
             ${s.lookId.startsWith("saved:") ? `<button type="button" class="btn-small" data-act="delete-look" title="Delete this saved look">🗑️</button>` : ""}
             ${!PL.isEmpty(s.look) ? `<button type="button" class="btn-small" data-act="clear-look">Clear</button>` : ""}
           </div>`;

      const fromImage = s.look.fromImage
        ? `<div class="pb-note"><span><b>Matching an image:</b> ${esc(s.look.fromImage.slice(0, 180))}${s.look.fromImage.length > 180 ? "…" : ""}</span><button type="button" class="pb-x" data-act="drop-image" aria-label="Stop matching the image">✕</button></div>`
        : "";

      const photo = PL.isPhotoMedium(s.look);
      const sections = PL.SECTIONS.map(sec => {
        const isOpen = s.open.has(sec.id);
        const dim = sec.photoOnly && !photo;
        const vals = sec.groups.flatMap(g => s.look.picks[g.key] || []);
        const sum = dim ? "Photos only" : vals.length ? vals.join(", ") : "AI decides";
        const body = !isOpen ? "" : dim
          ? `<p class="pb-hint">Lens and focus apply to photographs. Pick a photo medium to use them.</p>`
          : sec.groups.map(g => this._groupHtml(g, sec)).join("");
        return `<div class="pb-acc${isOpen ? " is-open" : ""}${dim ? " is-dim" : ""}">
          <button type="button" class="pb-acc-head" data-acc="${sec.id}" aria-expanded="${isOpen}">
            <span class="pb-acc-name">${esc(sec.name)}</span><span class="pb-acc-sum${vals.length && !dim ? " is-set" : ""}">${esc(sum)}</span><span class="pb-chev" aria-hidden="true">›</span>
          </button>${isOpen ? `<div class="pb-acc-body">${body}</div>` : ""}</div>`;
      }).join("");

      const seg = (name, vals, cur) => `<div class="pb-seg" role="group" aria-label="${name}">${vals.map(([v, l]) => `<button type="button" data-seg="${name}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join("")}</div>`;
      const fmtHint = { fragments: "Short fragments, like a shot list. Best for modern models.", prose: "Full descriptive sentences.", tags: "Comma tags, for SDXL-family models (Illustrious, Pony)." }[s.format];

      const error = s.error ? `<div class="pb-error" role="alert">${esc(s.error)}</div>` : "";
      const last = s.lastPrompt && s.prompt ? `<button type="button" class="pb-linkbtn" data-go="result">↪ Back to your last prompt</button>` : "";

      return {
        body: `${error}${last}
          <section class="pb-panel" aria-label="What"><span class="pb-eyebrow">What</span>${what}</section>
          <section class="pb-panel" aria-label="How it looks"><span class="pb-eyebrow">How it looks</span>
            <label class="pb-label" for="pb-look">Look</label>${lookSelect}${saveRow}${fromImage}
            <label class="pb-label" for="pb-extra">Anything else about the look <span class="pb-soft">(optional)</span></label>
            <input type="text" id="pb-extra" class="input pb-input" maxlength="300" value="${esc(s.look.extra || "")}" placeholder="e.g. 1980s fashion editorial, rain on the lens">
            <p class="pb-hint">Every section below is optional. Anything left on ✨ AI decides is chosen to fit. Tap any option to see what it means (tap again to un-pick it).</p>
          </section>
          <div class="pb-accs">${sections}</div>
          <section class="pb-panel" aria-label="Output"><span class="pb-eyebrow">Output</span>
            <span class="pb-label">Format</span>${seg("format", [["fragments", "Fragments"], ["prose", "Prose"], ["tags", "Tags"]], s.format)}
            <p class="pb-hint">${fmtHint}</p>
            <span class="pb-label">Detail</span>${seg("detail", [["short", "Short"], ["rich", "Rich"], ["max", "Max"]], s.detail)}
            <label class="pb-check" for="pb-nsfw"><input type="checkbox" id="pb-nsfw" ${s.nsfw ? "checked" : ""}><span>🔞 NSFW</span></label>
            <p class="pb-hint">Steers towards nudity and erotic imagery instead of covering up. Characters are always written as adults (18+). Some text models may still tone it down; edit the result before using it.</p>
          </section>`,
        // Held back while an image's style is being read, or the build would
        // go ahead without the look it was waiting for.
        footer: s.matching
          ? `<button type="button" class="btn-small pb-wide" disabled>🎲 Surprise me</button>
            <button type="button" class="btn-primary pb-wide" disabled aria-busy="true">⏳ Reading image…</button>`
          : `<button type="button" class="btn-small pb-wide" data-act="surprise" title="Bold choices for everything you left to the AI">🎲 Surprise me</button>
            <button type="button" class="btn-primary pb-wide" data-act="build">✨ Build prompt</button>`,
      };
    }

    _groupHtml(g, sec) {
      const s = this.state;
      const picked = s.look.picks[g.key] || [];
      const options = [...g.opts, ...picked.filter(v => !g.opts.includes(v))];
      const label = sec.groups.length > 1 ? `<span class="pb-grp">${esc(g.label)}</span>` : "";
      const desc = (o) => PL.DESCRIPTIONS[o] || "";
      const tip = (o) => (desc(o) ? ` title="${esc(desc(o))}"` : "");
      const chips = options.map(o => `<button type="button" class="pb-chip" data-chip="${g.key}" data-v="${esc(o)}" aria-pressed="${picked.includes(o)}"${tip(o)}>${esc(o)}</button>`).join("");
      const ai = `<button type="button" class="pb-chip pb-chip-ai" data-chip="${g.key}" data-ai="1" aria-pressed="${!picked.length}"${tip("✨ AI decides")}>✨ AI decides</button>`;
      // Phones have no hover, so the last option tapped in this group explains itself here.
      const tapped = s.explain?.key === g.key ? s.explain.v : "";
      const explain = tapped && desc(tapped) ? `<p class="pb-explain" aria-live="polite"><b>${esc(tapped)}</b> — ${esc(desc(tapped))}</p>` : "";
      const custom = !g.custom ? "" : s.addingTo === g.key
        ? `<span class="pb-custom"><input type="text" id="pb-custom-input" class="input pb-input" maxlength="40" placeholder="Your own" aria-label="Your own ${esc(g.label)}"><button type="button" class="btn-small" data-act="custom-add">Add</button></span>`
        : `<button type="button" class="pb-chip pb-chip-add" data-act="custom-open" data-key="${g.key}">＋ Your own</button>`;
      return `${label}<div class="pb-chips">${ai}${chips}${custom}</div>${explain}`;
    }

    // ── 🖼️ Match an image: pick from what's already saved ──
    // Characters are the cards in the Library (portrait via the same
    // authenticated URL the Library's thumbnails use); Library is the
    // Playground image library. Lists are fetched once per opening of the
    // sheet, so something saved in the meantime shows up next time.
    async _loadMatchItems(tab) {
      if (this.matchItems[tab] || this.matchLoading[tab]) return;
      this.matchLoading[tab] = true;
      this.matchError[tab] = "";
      const token = window.cardgenAuth?.getToken() || localStorage.getItem("cardgen_auth_token") || "";
      try {
        if (tab === "cards") {
          const cards = await window.characterStorage.listCards();
          const ordered = [...cards.filter(c => c.isPermanent), ...cards.filter(c => !c.isPermanent)];
          this.matchItems.cards = ordered.map(c => {
            const base = `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(c.id)}`;
            const stamp = new Date(c.updatedAt || c.createdAt || 0).getTime();
            return {
              name: c.characterName || c.character?.name || "Unnamed character",
              sub: c.isPermanent ? "" : "History",
              thumb: `${base}${token ? `&token=${encodeURIComponent(token)}` : ""}&_t=${stamp}`,
              fetchUrl: base,
            };
          });
        } else {
          const rows = await window.characterStorage.listPlaygroundImages();
          this.matchItems.library = rows.map(r => ({
            name: r.label || r.prompt?.slice(0, 40) || "Untitled",
            sub: "",
            thumb: `${r.url}?token=${encodeURIComponent(token)}`,
            fetchUrl: r.url,
          }));
        }
      } catch (err) {
        console.error(`Prompt Builder: couldn't load ${tab} for Match an image:`, err);
        this.matchError[tab] = err.message || "Couldn't load the images";
      } finally {
        this.matchLoading[tab] = false;
      }
      if (this.state?.screen === "match" && (this.state.matchTab || "cards") === tab && !this.el.hidden) this.render();
    }

    _matchHtml() {
      const s = this.state;
      const tab = s.matchTab || "cards";
      const items = this.matchItems[tab];
      const tabs = `<div class="pb-seg" role="group" aria-label="Where to pick from">
          <button type="button" data-seg="matchTab" data-v="cards" aria-pressed="${tab === "cards"}">🧙 Characters</button>
          <button type="button" data-seg="matchTab" data-v="library" aria-pressed="${tab === "library"}">🧪 Library</button>
        </div>`;
      let body;
      if (this.matchError[tab]) {
        body = `<div class="pb-error" role="alert">Couldn't load these images: ${esc(this.matchError[tab])}</div>
          <button type="button" class="btn-small" data-act="match-retry">Try again</button>`;
      } else if (!items) {
        body = `<p class="pb-hint">Loading…</p>`;
      } else if (!items.length) {
        body = `<p class="pb-hint">${tab === "cards" ? "No saved characters yet." : "Nothing in your Playground library yet. Save images there with 💾."}</p>`;
      } else {
        body = `<input type="search" id="pb-match-filter" class="input pb-input" placeholder="Filter by name" aria-label="Filter by name">
          <div class="pb-match-grid">${items.map((it, i) => `
            <button type="button" class="pb-match-tile" data-match="${i}" data-name="${esc(it.name.toLowerCase())}" title="Match ${esc(it.name)}">
              <img src="${esc(it.thumb)}" alt="" loading="lazy" onerror="this.closest('button').style.display = 'none'">
              <span>${esc(it.name)}${it.sub ? ` <em>· ${esc(it.sub)}</em>` : ""}</span>
            </button>`).join("")}</div>`;
      }
      return {
        body: `<p class="pb-hint">Pick a picture whose look you want. Only its style is read (medium, lighting, palette, finish), not who is in it.</p>${tabs}${body}`,
        footer: `<button type="button" class="btn-small pb-wide" data-act="match-upload">📁 Upload from this device</button>`,
      };
    }

    async _matchFromSaved(index) {
      const s = this.state;
      const item = this.matchItems[s.matchTab || "cards"]?.[index];
      if (!item) return;
      s.screen = "steer";
      s.matching = true;
      this.render();
      try {
        const res = await (window.authFetch || fetch)(item.fetchUrl);
        if (!res.ok) throw new Error(`couldn't load the picture (${res.status})`);
        const blob = await res.blob();
        // Our own image routes; a missing or generic content type still means an image.
        const type = blob.type?.startsWith("image/") ? blob.type : "image/png";
        await this._matchImage(new File([blob], "match.png", { type }));
      } catch (err) {
        s.matching = false;
        window.app?.showNotification(`Couldn't read the image's style: ${err.message}`, "error");
        if (this.state === s && !this.el.hidden) this.render();
      }
    }

    _writingHtml() {
      return {
        body: `<section class="pb-panel"><textarea id="pb-stream" class="input pb-input pb-mono" rows="14" readonly aria-label="Prompt being written"></textarea>
          <p class="pb-hint">Writing with the text model. If your phone locks, it carries on and picks up where it left off.</p></section>`,
        footer: `<button type="button" class="btn-small pb-wide" data-act="abandon">■ Stop</button>`,
      };
    }

    _notesHtml() {
      const s = this.state;
      const lines = PL.chosenLines(s.look);
      const count = lines.reduce((n, l) => n + l.values.length, 0);
      const open = PL.openGroups(s.look);
      const words = (s.prompt || "").trim().split(/\s+/).filter(Boolean).length;
      const parts = [];
      parts.push(s.subject.kind === "card" ? `<span><b>Subject:</b> the card${s.subject.direction ? `, plus “${esc(s.subject.direction.slice(0, 60))}”` : ""}</span>` : `<span><b>Subject:</b> your idea</span>`);
      parts.push(`<span><b>Your choices:</b> ${count ? `${count} across ${lines.length} group${lines.length === 1 ? "" : "s"}` : "none"}${s.look.fromImage ? " + an image's style" : ""}</span>`);
      if (open.length) parts.push(`<span><b>AI chose:</b> ${esc(open.join(", "))}</span>`);
      parts.push(`<span><b>Length:</b> ${words} words, ${esc(s.format)}${s.nsfw ? " · 🔞 NSFW on" : ""}</span>`);
      return `<div class="pb-notes">${parts.join("")}</div>`;
    }

    _resultHtml() {
      const s = this.state;
      const useLabel = this.opts.host === "character" ? "Use for this card" : "Use prompt";
      const error = s.error ? `<div class="pb-error" role="alert">${esc(s.error)} Your previous prompt is below.</div>` : "";
      return {
        body: `${error}<section class="pb-panel">
            <label class="pb-label" for="pb-result">Edit anything before using it</label>
            <textarea id="pb-result" class="input pb-input pb-mono" rows="14" maxlength="10000">${esc(s.prompt)}</textarea>
            ${this._notesHtml()}
          </section>
          <div class="pb-row">
            <button type="button" class="btn-small" data-go="steer">← Adjust</button>
            <button type="button" class="btn-small" data-act="build" ${s.matching ? "disabled" : ""}>${s.matching ? "⏳ Reading image…" : "↻ Rebuild"}</button>
            <button type="button" class="btn-small" data-act="variations" ${s.matching ? "disabled" : ""}>🔀 3 variations</button>
          </div>`,
        footer: `<button type="button" class="btn-small pb-wide" data-act="use">${useLabel}</button>
          <button type="button" class="btn-primary pb-wide" data-act="use-generate">Use &amp; Generate</button>`,
      };
    }

    _takesHtml() {
      const s = this.state;
      const cards = s.takes.map((t, i) => `<button type="button" class="pb-take" data-take="${i}" aria-pressed="${i === s.chosenTake}">
          <span class="pb-take-head">${esc(t.label)}</span><span class="pb-take-text">${esc(t.prompt)}</span></button>`).join("");
      const n = s.takes.length;
      return {
        body: `<p class="pb-hint">Each take keeps your choices and changes one thing the AI was free to pick. No image has been made yet: pick one to edit, or 🖼️ Generate all ${n} to draw one image from each and choose between the pictures.</p>${cards}`,
        footer: `<button type="button" class="btn-small pb-wide" data-act="pick-take">Use this one</button>
          <button type="button" class="btn-primary pb-wide" data-act="generate-all" title="Draw one image from each take (${n} image generations)">🖼️ Generate all ${n}</button>`,
      };
    }

    // ── Events ──
    _readInputs() {
      const s = this.state;
      if (!s || !this.el) return;
      const q = (id) => this.el.querySelector(`#${id}`);
      if (q("pb-idea")) s.subject.idea = q("pb-idea").value;
      if (q("pb-direction")) s.subject.direction = q("pb-direction").value;
      if (q("pb-extra") && q("pb-extra").value.trim() !== (s.look.extra || "")) {
        s.look.extra = q("pb-extra").value.trim();
        this._markCustom();
      }
      if (q("pb-result")) s.prompt = q("pb-result").value;
    }

    // Any change to a named look makes it an unsaved custom one (keeping every pick).
    _markCustom() {
      const s = this.state;
      if (s.lookId !== "custom") {
        s.lookId = "custom";
        s.look.name = "";
      }
    }

    _onClick(e) {
      const t = e.target.closest("[data-act],[data-go],[data-acc],[data-chip],[data-seg],[data-take],[data-match]");
      if (!t) return;
      this._readInputs();
      const s = this.state;

      if (t.dataset.go) { s.screen = t.dataset.go; s.error = ""; return this.render(); }
      if (t.dataset.acc) {
        s.open.has(t.dataset.acc) ? s.open.delete(t.dataset.acc) : s.open.add(t.dataset.acc);
        return this.render();
      }
      if (t.dataset.chip) {
        const key = t.dataset.chip;
        const group = PL.GROUP_BY_KEY[key] || {};
        const v = t.dataset.v;
        let list = [...(s.look.picks[key] || [])];
        if (t.dataset.ai) list = [];
        else if (list.includes(v)) list = list.filter(x => x !== v);
        else list = group.single ? [v] : [...list, v];
        s.explain = { key, v: t.dataset.ai ? "✨ AI decides" : v };
        if (list.length) s.look.picks[key] = list; else delete s.look.picks[key];
        this._markCustom();
        return this.render();
      }
      if (t.dataset.seg) { s[t.dataset.seg] = t.dataset.v; this._persist(); return this.render(); }
      if (t.dataset.take) { s.chosenTake = +t.dataset.take; return this.render(); }
      if (t.dataset.match !== undefined) return this._matchFromSaved(+t.dataset.match);

      switch (t.dataset.act) {
        case "close": return this.close();
        case "build": return this._build({});
        case "surprise": return this._build({ surprise: true });
        case "variations": return this._build({ variations: 3 });
        case "abandon": return this._abandon();
        case "use": return this._use(false);
        case "use-generate": return this._use(true);
        case "generate-all": return this._use(true, { all: true });
        case "pick-take": {
          const take = s.takes[s.chosenTake];
          if (take) { s.prompt = take.prompt; s.screen = "result"; this._persist(); }
          return this.render();
        }
        case "custom-open": s.addingTo = t.dataset.key; return this.render();
        case "custom-add": return this._addCustom();
        case "save-look": s.savingLook = true; return this.render();
        case "save-look-cancel": s.savingLook = false; return this.render();
        case "save-look-confirm": return this._saveLook();
        case "delete-look": return this._deleteLook();
        case "clear-look": s.look = PL.emptyLook(); s.lookId = ""; return this.render();
        case "drop-image": s.look.fromImage = ""; this._markCustom(); return this.render();
        case "match": s.screen = "match"; return this.render();
        case "match-upload": s.screen = "steer"; this.render(); return this.el.querySelector("#pb-match-file").click();
        case "match-retry": delete this.matchItems[s.matchTab || "cards"]; this.matchError[s.matchTab || "cards"] = ""; return this.render();
      }
    }

    _onChange(e) {
      const s = this.state;
      if (e.target.id === "pb-look") {
        this._readInputs();
        const id = e.target.value;
        if (id === "custom") return;
        const found = this.findLook(id);
        s.look = found ? PL.normalise({ ...found, name: found.name }) : PL.emptyLook();
        s.lookId = found ? id : "";
        s.savingLook = false;
        return this.render();
      }
      if (e.target.id === "pb-nsfw") {
        this._readInputs();
        s.nsfw = e.target.checked;
        this._persist();
        return this.render();
      }
      if (e.target.id === "pb-match-file") {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) this._matchImage(file);
      }
    }

    _addCustom() {
      const s = this.state;
      const input = this.el.querySelector("#pb-custom-input");
      const v = input?.value.trim();
      const key = s.addingTo;
      s.addingTo = null;
      if (v && key) {
        const group = PL.GROUP_BY_KEY[key] || {};
        const list = s.look.picks[key] || [];
        s.look.picks[key] = group.single ? [v] : [...new Set([...list, v])];
        this._markCustom();
      }
      this.render();
    }

    _saveLook() {
      const s = this.state;
      const name = this.el.querySelector("#pb-look-name")?.value.trim();
      if (!name) { window.app?.showNotification("Give the look a name first", "warning"); return; }
      const looks = this.savedLooks();
      const existing = looks.find(l => l.name.toLowerCase() === name.toLowerCase());
      const id = existing?.id || `look${Date.now().toString(36)}`;
      const entry = { id, name, picks: s.look.picks, extra: s.look.extra || "", fromImage: s.look.fromImage || "" };
      const next = existing ? looks.map(l => (l.id === id ? entry : l)) : [...looks, entry];
      this.config.set("api.image.looks", next);
      s.look.name = name;
      s.lookId = `saved:${id}`;
      s.savingLook = false;
      window.app?.showNotification(`Saved “${name}” for Playground and Character Gen`, "success");
      this.render();
    }

    _deleteLook() {
      const s = this.state;
      const id = s.lookId.replace(/^saved:/, "");
      const look = this.savedLooks().find(l => l.id === id);
      if (!look) return;
      this.config.set("api.image.looks", this.savedLooks().filter(l => l.id !== id));
      s.lookId = "custom";
      window.app?.showNotification(`Deleted “${look.name}”. Its choices are still here until you change them.`, "info");
      this.render();
    }

    async _matchImage(file) {
      const s = this.state;
      const app = window.app;
      s.matching = true;
      this.render();
      try {
        if (!file.type.startsWith("image/")) throw new Error("That file isn't an image");
        const dataUrl = app?.prepareReferenceImageForVision ? await app.prepareReferenceImageForVision(file) : await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error("Couldn't read the image"));
          r.readAsDataURL(file);
        });
        const style = await window.apiHandler.extractStyleFromImage(dataUrl);
        if (this.state !== s) return;
        s.look.fromImage = style;
        this._markCustom();
        app?.showNotification("Image style read. It's added to the look.", "success");
      } catch (err) {
        app?.showNotification(`Couldn't read the image's style: ${err.message}`, "error");
      } finally {
        s.matching = false;
        if (this.state === s && !this.el.hidden) this.render();
      }
    }

    // ── Writing ──
    async _build({ surprise = false, variations = 0 }) {
      const s = this.state;
      const host = this.opts.host;
      // Also covers Rebuild / 3 variations reached via "Back to your last prompt".
      if (s.matching) {
        window.app?.showNotification("Still reading the image's style — build once it's done", "warning");
        return;
      }
      if (s.subject.kind === "idea" && !(s.subject.idea || "").trim()) {
        s.error = "Write a rough idea first: who or what is in the picture.";
        s.screen = "steer";
        return this.render();
      }
      if (!window.apiHandler.config.get("api.text.model")) {
        s.error = "No text model is set. Choose one in ⚙️ Settings → Text API.";
        s.screen = "steer";
        return this.render();
      }
      const run = (this.runs[host] = (this.runs[host] || 0) + 1);
      s.error = "";
      s.lastPrompt = false;
      s.streamText = "";
      s.screen = "writing";
      this._persist();
      this.render();

      const spec = {
        subject: { ...s.subject },
        look: PL.isEmpty(s.look) ? null : s.look,
        format: s.format,
        detail: s.detail,
        surprise,
        variations,
        nsfw: !!s.nsfw,
        model: s.model,
        shape: s.shape,
      };
      try {
        const out = await window.apiHandler.writeImagePrompt(spec, {
          label: "Prompt Builder",
          onStream: (_delta, full) => {
            if (this.runs[host] !== run) return;
            s.streamText = full;
            const ta = this.state === s && !this.el.hidden ? this.el.querySelector("#pb-stream") : null;
            if (ta) { ta.value = full; ta.scrollTop = ta.scrollHeight; }
          },
        });
        if (this.runs[host] !== run) return;
        if (variations) {
          s.takes = out;
          s.chosenTake = 0;
          s.screen = "takes";
        } else {
          s.prompt = out;
          s.screen = "result";
        }
        this._persist();
        if (this.el.hidden || this.state !== s) {
          window.app?.showNotification("✨ Your prompt is ready. Open the Prompt Builder to see it.", "success");
        }
      } catch (err) {
        if (this.runs[host] !== run) return;
        console.error("Prompt Builder write failed:", err);
        s.error = err.message || "The prompt couldn't be written. Try again.";
        s.screen = s.prompt ? "result" : "steer";
      }
      if (this.state === s && !this.el.hidden) this.render();
    }

    // Stops waiting for this write. The text call isn't cancelled on the
    // server — Stop elsewhere in the app cancels every running job, which
    // would also kill a card or image being generated alongside.
    _abandon() {
      const host = this.opts.host;
      this.runs[host] = (this.runs[host] || 0) + 1;
      const s = this.state;
      s.screen = s.prompt ? "result" : "steer";
      this.render();
    }

    // `all`: from the takes screen, hand every take over to be drawn (one
    // image each); the highlighted take becomes "the" prompt the host keeps.
    _use(generate, { all = false } = {}) {
      this._readInputs();
      const s = this.state;
      const takes = all ? s.takes.map(t => ({ label: t.label, prompt: t.prompt })) : null;
      if (all) {
        if (!takes.length) return;
        s.prompt = (s.takes[s.chosenTake] || s.takes[0]).prompt;
      }
      const prompt = (s.prompt || "").trim();
      if (!prompt) return;
      this._persist();
      const onUse = this.opts.onUse;
      const look = PL.isEmpty(s.look) ? null : { ...s.look };
      const lookId = s.lookId;
      const subject = { ...s.subject };
      // Next time it opens on the choices, with a link back to this prompt.
      s.screen = "steer";
      s.lastPrompt = true;
      this.close();
      onUse?.({ prompt, takes, look, lookId, subject, generate });
    }
  }

  window.promptBuilder = new PromptBuilder();
})();

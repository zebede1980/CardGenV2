/**
 * HomeHandler
 * The front page: global navigation, Recent activity, and a browser for the
 * character library.
 *
 * The browser (2026-11-24) replaced 20-a-page Prev/Next paging, which got
 * slow with a few hundred cards: every card's full text was downloaded to
 * show the grid, each tile loaded the full-size portrait, and changing page
 * jumped the scroll. Now:
 *   - /api/storage/cards/summary gives a light row per card (name, tags,
 *     dates, uses, a blurb); a card's text is fetched only when it is opened;
 *   - tiles load small thumbnails (/api/storage/cards/thumbnail?w=320);
 *   - one grid that grows as you scroll (a batch at a time), under a sticky
 *     bar with search, sort and filters, so nothing jumps;
 *   - search matches names and tags, ranked, with "Descriptions" to search
 *     the cards' text on the server as well;
 *   - 🏷️ Tag untagged: the proxy tags cards with AI (proxy/runs/tag-runs.js).
 */
class HomeHandler {
    constructor() {
        this.cards = [];          // summaries, see _prepare()
        this.results = [];        // the cards the current search and filters show, in order
        this.shown = 0;           // how many of them are in the grid
        this.descIds = null;      // Set of ids the server's text search matched, or null
        this.descQuery = '';
        this.descFailed = false;
        this.tagRun = null;       // the proxy's tagging run, as last polled
        this.browse = { q: '', desc: false, sort: 'newest', used: 'all', tags: [] };
        try {
            const saved = JSON.parse(localStorage.getItem(HomeHandler.BROWSE_KEY) || 'null');
            if (saved && typeof saved === 'object') {
                if (HomeHandler.SORTS[saved.sort]) this.browse.sort = saved.sort;
                if (['all', 'used', 'unused'].includes(saved.used)) this.browse.used = saved.used;
                this.browse.desc = !!saved.desc;
            }
        } catch (_) { /* private mode */ }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.injectHTML();
        this.bindEvents();

        // Wait briefly for library/storage to be initialized and app authenticated, then load the gallery
        const checkStorage = setInterval(() => {
            if (window.characterStorage && window.app) {
                clearInterval(checkStorage);
                this.loadCards();
                this.loadRecent();
                this.loadTagRun();
            }
        }, 100);
    }

    injectHTML() {
        const viewCardGen = document.getElementById('view-cardgen');
        if (!viewCardGen || document.getElementById('view-home')) return;

        // 1. Create and inject the Home View
        const viewHome = document.createElement('div');
        viewHome.id = 'view-home';
        viewHome.style.display = 'block'; // Set as the default active view

        // Hide the other views
        viewCardGen.style.display = 'none';
        const viewStoryWriter = document.getElementById('view-storywriter');
        if (viewStoryWriter) viewStoryWriter.style.display = 'none';
        const viewChat = document.getElementById('view-roleplaychat');
        if (viewChat) viewChat.style.display = 'none';
        const viewAdventure = document.getElementById('view-adventure');
        if (viewAdventure) viewAdventure.style.display = 'none';

        // Reset existing top tabs
        const tabCardGen = document.getElementById('tab-cardgen');
        if (tabCardGen) tabCardGen.className = 'btn-outline';

        const sortOptions = Object.entries(HomeHandler.SORTS)
            .map(([value, s]) => `<option value="${value}">${s.label}</option>`).join('');

        viewHome.innerHTML = `
            <div class="home-wrap">
                <!-- Recent activity: the latest roleplay chats, messenger chats, stories and adventures -->
                <section id="home-recent-section" class="hr-section">
                    <h2 class="hr-heading">🕘 Recent activity</h2>
                    <div id="home-recent-grid" class="hr-grid">
                        <p class="hr-note">Loading…</p>
                    </div>
                </section>

                <section id="home-chars" class="hc">
                    <div class="hc-head">
                        <h2 id="home-characters-heading" class="hc-title">Your Characters <span id="home-chars-total" class="hc-total"></span></h2>
                        <button type="button" id="home-tag-btn" class="btn-outline hc-tag-btn" hidden></button>
                    </div>
                    <div id="home-tag-status" class="hc-tag-status" hidden></div>

                    <div id="home-chars-bar" class="hc-bar">
                        <div class="hc-search-row">
                            <label class="hc-search">
                                <span class="hc-search-icon" aria-hidden="true">🔍</span>
                                <input type="search" id="home-search" placeholder="Name or tag" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search characters">
                                <button type="button" id="home-search-clear" class="hc-clear" aria-label="Clear search" hidden>✕</button>
                            </label>
                            <select id="home-sort" class="hc-sort" aria-label="Sort characters">${sortOptions}</select>
                        </div>
                        <div id="home-chip-row" class="hc-chips" role="toolbar" aria-label="Filters"></div>
                    </div>

                    <p id="home-chars-summary" class="hc-summary" aria-live="polite"></p>
                    <div id="home-grid" class="hc-grid">
                        <p class="hc-note">Loading your characters…</p>
                    </div>
                    <div id="home-grid-more" class="hc-more" aria-hidden="true"></div>
                </section>
            </div>
        `;

        viewCardGen.parentNode.insertBefore(viewHome, viewCardGen);

        // 2. Add a "Home" button to the main navbar
        const navTabs = tabCardGen?.parentNode;
        if (navTabs) {
            navTabs.classList.add('app-nav-tabs');
            const tabHome = document.createElement('button');
            tabHome.id = 'tab-home';
            tabHome.className = 'btn-primary';
            tabHome.innerHTML = '🏠 Home';
            navTabs.insertBefore(tabHome, tabCardGen);

            // Inject mobile fix for nav tabs to ensure they wrap properly
            if (!document.getElementById('nav-tabs-mobile-fix')) {
                const style = document.createElement('style');
                style.id = 'nav-tabs-mobile-fix';
                style.textContent = `
                    .app-nav-tabs {
                        display: flex !important;
                        flex-wrap: wrap !important;
                        gap: 0.5rem;
                        justify-content: center;
                    }
                    @media (max-width: 768px) {
                        #tab-home, #tab-cardgen, #tab-storywriter, #tab-roleplaychat, #tab-adventure, #tab-messenger {
                            flex: 1 1 30% !important; /* Creates a responsive grid */
                            padding: 0.6rem 0.5rem !important;
                            font-size: 0.85rem !important;
                            margin: 0 !important;
                            text-align: center;
                        }
                        /* clip, not hidden: hidden makes #view-home a scroll
                           container and the sticky search bar would stop sticking. */
                        #view-home {
                            max-width: 100vw;
                            overflow-x: clip;
                        }
                    }
                `;
                document.head.appendChild(style);
            }
        }

        this._buildSheet();
    }

    bindEvents() {
        const tabHome = document.getElementById('tab-home');
        const tabCardGen = document.getElementById('tab-cardgen');
        const tabStoryWriter = document.getElementById('tab-storywriter');
        const tabChat = document.getElementById('tab-roleplaychat');
        const tabAdventure = document.getElementById('tab-adventure');

        const viewHome = document.getElementById('view-home');
        const viewCardGen = document.getElementById('view-cardgen');
        const viewStoryWriter = document.getElementById('view-storywriter');
        const viewChat = document.getElementById('view-roleplaychat');
        const viewAdventure = document.getElementById('view-adventure');

        const switchView = (targetView, targetTab) => {
            if (viewHome) viewHome.style.display = targetView === viewHome ? 'block' : 'none';
            if (viewCardGen) viewCardGen.style.display = targetView === viewCardGen ? 'block' : 'none';
            if (viewStoryWriter) viewStoryWriter.style.display = targetView === viewStoryWriter ? 'block' : 'none';
            if (viewChat) viewChat.style.display = targetView === viewChat ? 'block' : 'none';
            if (viewAdventure) viewAdventure.style.display = targetView === viewAdventure ? 'block' : 'none';

            if (tabHome) tabHome.className = targetTab === tabHome ? 'btn-primary' : 'btn-outline';
            if (tabCardGen) tabCardGen.className = targetTab === tabCardGen ? 'btn-primary' : 'btn-outline';
            if (tabStoryWriter) tabStoryWriter.className = targetTab === tabStoryWriter ? 'btn-primary' : 'btn-outline';
            if (tabChat) tabChat.className = targetTab === tabChat ? 'btn-primary' : 'btn-outline';
            if (tabAdventure) tabAdventure.className = targetTab === tabAdventure ? 'btn-primary' : 'btn-outline';
        };

        if (tabHome) tabHome.addEventListener('click', () => {
            switchView(viewHome, tabHome);
            this.loadCards({ keepPlace: true });
            this.loadRecent();
            this.loadTagRun();
        });
        if (tabCardGen) tabCardGen.addEventListener('click', () => switchView(viewCardGen, tabCardGen));
        if (tabStoryWriter) tabStoryWriter.addEventListener('click', () => switchView(viewStoryWriter, tabStoryWriter));
        if (tabChat) tabChat.addEventListener('click', () => switchView(viewChat, tabChat));
        if (tabAdventure) tabAdventure.addEventListener('click', () => {
            switchView(viewAdventure, tabAdventure);
            if(window.adventureHandler) window.adventureHandler.showView();
        });

        // ── The browser's bar ──
        const search = document.getElementById('home-search');
        const clear = document.getElementById('home-search-clear');
        let typing = null;
        search?.addEventListener('input', () => {
            clear.hidden = !search.value;
            clearTimeout(typing);
            typing = setTimeout(() => this._setBrowse({ q: search.value }), 120);
        });
        search?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); search.blur(); }
        });
        clear?.addEventListener('click', () => {
            search.value = '';
            clear.hidden = true;
            this._setBrowse({ q: '' });
            search.focus();
        });
        const sort = document.getElementById('home-sort');
        if (sort) {
            sort.value = this.browse.sort;
            sort.addEventListener('change', () => this._setBrowse({ sort: sort.value }));
        }
        const chips = document.getElementById('home-chip-row');
        chips?.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-chip]');
            if (!chip) return;
            const kind = chip.dataset.chip;
            if (kind === 'desc') this._setBrowse({ desc: !this.browse.desc });
            else if (kind === 'used') this._setBrowse({ used: this.browse.used === chip.dataset.value ? 'all' : chip.dataset.value });
            else if (kind === 'tag') {
                const tag = chip.dataset.value;
                const tags = this.browse.tags.includes(tag) ? this.browse.tags.filter((t) => t !== tag) : [...this.browse.tags, tag];
                this._setBrowse({ tags });
            } else if (kind === 'clear') {
                if (search) search.value = '';
                if (clear) clear.hidden = true;
                this._setBrowse({ q: '', used: 'all', tags: [] });
            }
        });
        // A mouse wheel scrolls the chip row sideways (a trackpad already can).
        chips?.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && chips.scrollWidth > chips.clientWidth) {
                chips.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });

        document.getElementById('home-grid')?.addEventListener('click', (e) => {
            const tile = e.target.closest('.hc-tile');
            if (!tile) return;
            const card = this.cards.find((c) => String(c.id) === tile.dataset.id);
            if (card) this.openSheet(card);
        });

        // The grid grows as its end comes near. Checked on scroll, once a
        // frame: an IntersectionObserver alone isn't enough, because WebKit
        // can miss the "left the margin" change after a batch is added, and
        // then never reports the next approach (seen in headless WebKit).
        let queued = false;
        const check = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; this._fill(); });
        };
        window.addEventListener('scroll', check, { passive: true });
        window.addEventListener('resize', check, { passive: true });
        const more = document.getElementById('home-grid-more');
        if (more && 'IntersectionObserver' in window) {
            this._moreObserver = new IntersectionObserver((entries) => {
                if (entries.some((en) => en.isIntersecting)) this._fill();
            }, { rootMargin: '0px 0px 900px 0px' });
            this._moreObserver.observe(more);
        }

        document.getElementById('home-tag-btn')?.addEventListener('click', () => this.startTagRun());
        document.getElementById('home-tag-status')?.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'stop') this.stopTagRun();
            if (act === 'dismiss') { this._tagDismissed = this.tagRun?.id; this._renderTagStatus(); }
        });
        // Polling pauses while the page is hidden (a locked phone); pick it up on return.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.tagRun?.status === 'running') this._pollTagRun();
        });
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    async loadCards({ keepPlace = false } = {}) {
        if (!window.authFetch) return;
        try {
            const res = await window.authFetch('/api/storage/cards/summary');
            if (!res.ok) throw new Error(`summary ${res.status}`);
            const rows = await res.json();
            this.cards = rows.map((c) => this._prepare(c));
            this._loaded = true;
            this.render({ keepPlace });
        } catch (e) {
            console.error("Home: Failed to load cards", e);
            if (this._loaded) return; // keep showing what we have
            const grid = document.getElementById('home-grid');
            if (grid) grid.innerHTML = '<p class="hc-note hc-error">Couldn’t load your characters. <button type="button" class="btn-outline btn-small" data-retry>Try again</button></p>';
            grid?.querySelector('[data-retry]')?.addEventListener('click', () => this.loadCards());
        }
    }

    _prepare(c) {
        const name = c.name || 'Unnamed Character';
        return {
            ...c,
            name,
            characterName: name,
            tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t).toLowerCase()) : [],
            _name: name.toLowerCase(),
            _words: name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
            _created: HomeHandler.parseUtc(c.createdAt)?.getTime() || 0,
            _updated: HomeHandler.parseUtc(c.updatedAt)?.getTime() || 0,
            _used: HomeHandler.parseUtc(c.lastUsedAt)?.getTime() || 0,
        };
    }

    // ── Search, sort, filter ────────────────────────────────────────────────

    _setBrowse(change) {
        const before = { ...this.browse };
        Object.assign(this.browse, change);
        try {
            const { sort, used, desc } = this.browse;
            localStorage.setItem(HomeHandler.BROWSE_KEY, JSON.stringify({ sort, used, desc }));
        } catch (_) { /* private mode */ }
        const q = this.browse.q.trim();
        if (this.browse.desc && q && (q !== this.descQuery || !before.desc)) this._searchDescriptions(q);
        if (!q || !this.browse.desc) { this.descIds = null; this.descQuery = ''; this.descFailed = false; }
        this.render({ toTop: true });
    }

    async _searchDescriptions(q) {
        const seq = (this._descSeq = (this._descSeq || 0) + 1);
        this.descQuery = q;
        this.descIds = null;
        this.descFailed = false;
        clearTimeout(this._descTimer);
        await new Promise((r) => { this._descTimer = setTimeout(r, 300); });
        if (seq !== this._descSeq) return;
        try {
            const res = await window.authFetch(`/api/storage/cards/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) throw new Error(`search ${res.status}`);
            const { ids } = await res.json();
            if (seq !== this._descSeq) return;
            this.descIds = new Set((ids || []).map(String));
        } catch (e) {
            if (seq !== this._descSeq) return;
            console.warn('Home: description search failed', e);
            this.descFailed = true;
        }
        this.render({ keepPlace: true });
    }

    /** How well `card` matches each search word (lower is better), or null if it doesn't. */
    _score(card, words) {
        let total = 0;
        for (const w of words) {
            let best = null;
            if (card._name.startsWith(w)) best = 0;
            else if (card._words.some((x) => x.startsWith(w))) best = 1;
            else if (card._name.includes(w)) best = 2;
            else if (card.tags.some((t) => t === w || t.startsWith(w))) best = 3;
            else if (card.tags.some((t) => t.includes(w))) best = 4;
            else if (this.descIds && this.descIds.has(String(card.id))) best = 6;
            if (best === null) return null;
            total += best;
        }
        return total;
    }

    _filtered() {
        const { used, tags } = this.browse;
        const words = this.browse.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const sorter = HomeHandler.SORTS[this.browse.sort]?.compare || HomeHandler.SORTS.newest.compare;
        let list = this.cards.filter((c) => (used === 'all' || (used === 'used' ? c.uses > 0 : c.uses === 0))
            && tags.every((t) => c.tags.includes(t)));
        if (!words.length) return list.sort(sorter);
        const scored = [];
        for (const c of list) {
            const s = this._score(c, words);
            if (s !== null) scored.push([s, c]);
        }
        return scored.sort((a, b) => a[0] - b[0] || sorter(a[1], b[1])).map(([, c]) => c);
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    /**
     * Rebuild the grid for the current search and filters.
     * keepPlace: show at least as many as before (a refresh, a deleted card), so the scroll position holds.
     * toTop: the results changed; if the grid's top is above the sticky bar, bring it back under the bar.
     */
    render({ keepPlace = false, toTop = false } = {}) {
        const grid = document.getElementById('home-grid');
        if (!grid) return;
        this.results = this._filtered();
        const keep = keepPlace ? Math.max(this.shown, HomeHandler.BATCH) : HomeHandler.BATCH;
        this.shown = 0;
        grid.innerHTML = '';
        if (!this.cards.length) {
            grid.innerHTML = this._loaded
                ? '<p class="hc-note">No characters yet. Make one in 🧬 Character Gen and save it to the library.</p>'
                : '<p class="hc-note">Loading your characters…</p>';
        } else if (!this.results.length) {
            grid.innerHTML = '<p class="hc-note">No characters match.</p>';
        } else {
            this._append(Math.min(keep, this.results.length));
        }
        this._renderChips();
        this._renderSummary();
        this._renderTagButton();
        if (toTop) {
            const bar = document.getElementById('home-chars-bar');
            const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
            const top = grid.getBoundingClientRect().top;
            if (top < barBottom) window.scrollBy(0, top - barBottom - 8);
        }
        this._fill();
    }

    _append(count) {
        const grid = document.getElementById('home-grid');
        const end = Math.min(this.results.length, this.shown + count);
        const frag = document.createDocumentFragment();
        for (let i = this.shown; i < end; i++) frag.appendChild(this._tile(this.results[i]));
        grid.appendChild(frag);
        this.shown = end;
        document.getElementById('home-grid-more')?.classList.toggle('hc-more-on', this.shown < this.results.length);
    }

    /** Add batches while the end of the grid is near the bottom of the screen. */
    _fill() {
        const home = document.getElementById('view-home');
        const more = document.getElementById('home-grid-more');
        if (!home || !more || home.style.display === 'none') return;
        for (let guard = 0; guard < 20 && this.shown < this.results.length; guard++) {
            if (more.getBoundingClientRect().top > window.innerHeight + 900) break;
            this._append(HomeHandler.BATCH);
        }
    }

    _thumbUrl(card, width = 320) {
        const token = window.cardgenAuth?.getToken() || '';
        return `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(card.id)}&w=${width}${token ? '&token=' + encodeURIComponent(token) : ''}&v=${card._updated}`;
    }

    _tile(card) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'hc-tile';
        tile.dataset.id = String(card.id);
        tile.title = card.name;
        const initial = this.escapeHtml((card.name || '?').trim().charAt(0).toUpperCase() || '?');
        const pic = card.hasImage
            ? `<img src="${this._thumbUrl(card)}" alt="" loading="lazy" decoding="async">`
            : '';
        const meta = card.uses
            ? `💬 ${card.uses} · ${this.formatRelativeDate(new Date(card._used))}`
            : (Date.now() - card._created < 3 * 86400000 ? '✨ New' : '');
        tile.innerHTML = `
            <span class="hc-pic${card.hasImage ? '' : ' hc-noimg'}" data-initial="${initial}">${pic}</span>
            <span class="hc-name">${this.escapeHtml(card.name)}</span>
            <span class="hc-meta">${meta || '&nbsp;'}</span>`;
        const img = tile.querySelector('img');
        img?.addEventListener('error', () => { img.parentElement.classList.add('hc-noimg'); img.remove(); }, { once: true });
        return tile;
    }

    _renderChips() {
        const row = document.getElementById('home-chip-row');
        if (!row) return;
        const { desc, used, tags } = this.browse;
        const counts = new Map();
        for (const c of this.cards) for (const t of c.tags) counts.set(t, (counts.get(t) || 0) + 1);
        // Picked tags first, then the commonest. A tag on one card isn't much of a filter.
        const top = [...counts.entries()].filter(([t, n]) => n > 1 && !tags.includes(t))
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HomeHandler.MAX_TAG_CHIPS);
        const chip = (kind, value, label, on, extra = '') =>
            `<button type="button" class="hc-chip${on ? ' hc-on' : ''}${extra}" data-chip="${kind}" data-value="${this.escapeHtml(value)}" aria-pressed="${on}">${label}</button>`;
        const active = this.browse.q.trim() || used !== 'all' || tags.length;
        row.innerHTML = [
            active ? chip('clear', '', '✕ Clear', false, ' hc-chip-clear') : '',
            chip('desc', '', '📝 Descriptions', desc),
            chip('used', 'used', '💬 Used', used === 'used'),
            chip('used', 'unused', '🌱 Never used', used === 'unused'),
            top.length || tags.length ? '<span class="hc-sep" aria-hidden="true"></span>' : '',
            ...tags.map((t) => chip('tag', t, `🏷️ ${this.escapeHtml(t)} <span class="hc-n">${counts.get(t) || 0}</span>`, true)),
            ...top.map(([t, n]) => chip('tag', t, `${this.escapeHtml(t)} <span class="hc-n">${n}</span>`, false)),
        ].join('');
        const search = document.getElementById('home-search');
        if (search) search.placeholder = desc ? 'Name, tag or any text' : 'Name or tag';
    }

    _renderSummary() {
        const total = document.getElementById('home-chars-total');
        if (total) total.textContent = this.cards.length ? String(this.cards.length) : '';
        const el = document.getElementById('home-chars-summary');
        if (!el) return;
        const q = this.browse.q.trim();
        const filtered = q || this.browse.used !== 'all' || this.browse.tags.length;
        if (!this.cards.length) { el.textContent = ''; return; }
        let text = filtered
            ? `${this.results.length} of ${this.cards.length} characters`
            : `${this.cards.length} characters · ${HomeHandler.SORTS[this.browse.sort].summary}`;
        if (q && this.browse.desc && !this.descIds && !this.descFailed) text += ' · searching descriptions…';
        if (q && this.browse.desc && this.descFailed) text += ' · description search unavailable';
        el.textContent = text;
    }

    // ── The card sheet: what tapping a tile opens ───────────────────────────

    _buildSheet() {
        if (document.getElementById('home-card-sheet')) return;
        const sheet = document.createElement('div');
        sheet.id = 'home-card-sheet';
        sheet.className = 'hcs-overlay';
        sheet.hidden = true;
        sheet.innerHTML = `
            <div class="hcs-sheet" role="dialog" aria-modal="true" aria-labelledby="hcs-name">
                <button type="button" class="hcs-close" data-act="close" aria-label="Close">✕</button>
                <div class="hcs-top">
                    <button type="button" class="hcs-pic" data-act="details" aria-label="Show the full card"><img alt=""></button>
                    <div class="hcs-info">
                        <h3 id="hcs-name" class="hcs-name"></h3>
                        <div class="hcs-meta"></div>
                        <div class="hcs-tags"></div>
                    </div>
                </div>
                <p class="hcs-blurb"></p>
                <div class="hcs-actions">
                    <button type="button" class="btn-primary" data-act="chat">💬 Chat</button>
                    <button type="button" class="btn-primary" data-act="story">📖 Story</button>
                    <button type="button" class="btn-outline" data-act="text">💌 Text</button>
                    <button type="button" class="btn-outline" data-act="edit">✏️ Edit</button>
                    <button type="button" class="btn-outline" data-act="details">📄 Full card</button>
                    <button type="button" class="btn-outline hcs-delete" data-act="delete">🗑️ Delete</button>
                </div>
            </div>`;
        document.body.appendChild(sheet);
        sheet.addEventListener('click', (e) => {
            if (e.target === sheet) return this.closeSheet();
            const tag = e.target.closest('[data-tag]');
            if (tag) {
                this.closeSheet();
                this._setBrowse({ tags: [tag.dataset.tag] });
                return;
            }
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act) this._sheetAction(act);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !sheet.hidden) this.closeSheet();
        });
    }

    openSheet(card) {
        const sheet = document.getElementById('home-card-sheet');
        if (!sheet) return;
        this._sheetCard = card;
        sheet.querySelector('.hcs-name').textContent = card.name;
        const pic = sheet.querySelector('.hcs-pic');
        const img = pic.querySelector('img');
        pic.dataset.initial = (card.name || '?').trim().charAt(0).toUpperCase() || '?';
        pic.classList.toggle('hc-noimg', !card.hasImage);
        if (card.hasImage) {
            img.hidden = false;
            img.onerror = () => { img.hidden = true; pic.classList.add('hc-noimg'); };
            img.src = this._thumbUrl(card, 640);
        } else {
            img.hidden = true;
            img.removeAttribute('src');
        }
        const bits = [];
        if (card._created) bits.push(`Made ${new Date(card._created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`);
        bits.push(card.uses ? `💬 Used ${card.uses} time${card.uses === 1 ? '' : 's'}, last ${this.formatRelativeDate(new Date(card._used)).toLowerCase()}` : '🌱 Not used yet');
        if (card.hasLorebook) bits.push('📚 Lorebook');
        sheet.querySelector('.hcs-meta').innerHTML = bits.map((b) => `<span>${this.escapeHtml(b)}</span>`).join('');
        sheet.querySelector('.hcs-tags').innerHTML = card.tags.length
            ? card.tags.map((t) => `<button type="button" class="hc-chip hcs-tag" data-tag="${this.escapeHtml(t)}" title="Show every card tagged ${this.escapeHtml(t)}">${this.escapeHtml(t)}</button>`).join('')
            : '<span class="hcs-notags">No tags yet</span>';
        const blurb = sheet.querySelector('.hcs-blurb');
        blurb.textContent = card.blurb ? `${card.blurb}${card.blurb.length >= 240 ? '…' : ''}` : '';
        blurb.hidden = !card.blurb;
        sheet.hidden = false;
        document.documentElement.classList.add('hcs-open');
        sheet.querySelector('.hcs-close').focus({ preventScroll: true });
    }

    closeSheet() {
        const sheet = document.getElementById('home-card-sheet');
        if (!sheet || sheet.hidden) return;
        sheet.hidden = true;
        document.documentElement.classList.remove('hcs-open');
        const tile = document.querySelector(`#home-grid .hc-tile[data-id="${CSS.escape(String(this._sheetCard?.id ?? ''))}"]`);
        tile?.focus({ preventScroll: true });
    }

    async _sheetAction(act) {
        const card = this._sheetCard;
        if (!card) return;
        if (act === 'close') return this.closeSheet();
        this.closeSheet();
        if (act === 'chat') return this.openChat(card);
        if (act === 'story') {
            document.getElementById('tab-storywriter')?.click();
            return window.storyWriterApp?.autowriter?.openSetup({ cards: [{ id: card.id, name: card.name }] });
        }
        if (act === 'text') return window.messengerHandler?.openNewWith({ id: card.id, name: card.name });
        if (act === 'edit') {
            document.getElementById('tab-cardgen')?.click();
            if (window.app) {
                const targetEl = document.createElement('div');
                targetEl.dataset.action = 'load-card';
                targetEl.dataset.id = String(card.id);
                await window.app.handleLibraryCardClick({ target: targetEl });
            }
            return;
        }
        if (act === 'delete') return this.showDeleteConfirmation('card', card, card.hasImage ? this._thumbUrl(card, 640) : null);
        if (act === 'details') {
            try {
                const full = await window.characterStorage.getCard(card.id);
                if (full && window.cardGallery) window.cardGallery.showInfo(full, card.hasImage ? this._thumbUrl(card, 640) : null);
            } catch (e) {
                console.error('Home: could not open the card', e);
                alert('Could not open this card.');
            }
        }
    }

    // Resume the latest chat with this character, or start one.
    async openChat(card) {
        document.getElementById('tab-roleplaychat')?.click();
        if (!window.roleplayChatHandler) return;
        try {
            const res = await window.authFetch('/api/sw/chats/');
            if (!res.ok) throw new Error(`chats ${res.status}`);
            const allChats = await res.json();
            allChats.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
            let foundChatId = null;
            for (const c of allChats) {
                if (c.characters) {
                    if (c.characters.some(ch => String(ch.id) === String(card.id))) { foundChatId = c.id; break; }
                } else {
                    const detailRes = await window.authFetch(`/api/sw/chats/${c.id}`);
                    if (detailRes.ok) {
                        const detail = await detailRes.json();
                        if (detail.characters && detail.characters.some(ch => String(ch.id) === String(card.id))) { foundChatId = c.id; break; }
                    }
                }
            }
            if (foundChatId) await window.roleplayChatHandler.selectChat(foundChatId);
            else await window.roleplayChatHandler.openNewChatModal(card.id);
        } catch (err) {
            console.error("Failed to check existing chats:", err);
            await window.roleplayChatHandler.openNewChatModal(card.id);
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    // ── 🏷️ Tag untagged cards (run by the proxy: proxy/runs/tag-runs.js) ───

    _untaggedCount() {
        return this.cards.filter((c) => !c.tags.length).length;
    }

    _renderTagButton() {
        const btn = document.getElementById('home-tag-btn');
        if (!btn) return;
        const n = this._untaggedCount();
        const running = this.tagRun?.status === 'running';
        btn.hidden = !this._loaded || !n || running;
        btn.textContent = `🏷️ Tag ${n} untagged`;
        btn.title = `Give the ${n} characters without tags their tags with AI, so you can filter by them`;
    }

    async loadTagRun() {
        try {
            const res = await window.authFetch('/api/card-tags/run');
            if (!res.ok) return;
            this.tagRun = await res.json();
            this._renderTagStatus();
            this._renderTagButton();
            if (this.tagRun.status === 'running') this._pollTagRun();
        } catch (_) { /* the panel just doesn't show */ }
    }

    async startTagRun() {
        const n = this._untaggedCount();
        if (!n) return;
        const model = window.config?.get?.('api.text.model') || 'your text model';
        const ok = confirm(`Tag ${n} character${n === 1 ? '' : 's'} with AI?\n\nThis makes one call per character to ${model} (${n} call${n === 1 ? '' : 's'}). It runs on the server, so you can leave this page or lock the phone. Cards that already have tags are left alone.`);
        if (!ok) return;
        const btn = document.getElementById('home-tag-btn');
        if (btn) btn.disabled = true;
        try {
            const res = await window.authFetch('/api/card-tags/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: window.config?.config }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
            this.tagRun = data;
            this._tagDismissed = null;
            this._renderTagStatus();
            this._renderTagButton();
            this._pollTagRun();
        } catch (e) {
            alert(`Couldn't start tagging: ${e.message}`);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async stopTagRun() {
        try {
            const res = await window.authFetch('/api/card-tags/run/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok) this.tagRun = await res.json();
        } catch (_) { /* the next poll shows it */ }
        this._renderTagStatus();
    }

    /** Poll while the run is going and the page is visible; refresh the cards as tags land. */
    _pollTagRun() {
        if (this._tagPolling) return;
        this._tagPolling = true;
        let refreshedAt = this.tagRun?.tagged || 0;
        const tick = async () => {
            if (document.visibilityState !== 'visible') { this._tagPolling = false; return; }
            try {
                const res = await window.authFetch('/api/card-tags/run');
                if (res.ok) this.tagRun = await res.json();
            } catch (_) { /* try again next tick */ }
            this._renderTagStatus();
            const run = this.tagRun || {};
            const finished = run.status !== 'running';
            if (finished || (run.tagged || 0) - refreshedAt >= 12) {
                refreshedAt = run.tagged || 0;
                await this.loadCards({ keepPlace: true });
            }
            if (finished) { this._tagPolling = false; this._renderTagButton(); return; }
            setTimeout(tick, 3000);
        };
        setTimeout(tick, 1500);
    }

    _renderTagStatus() {
        const el = document.getElementById('home-tag-status');
        if (!el) return;
        const run = this.tagRun;
        if (!run || run.status === 'idle' || this._tagDismissed === run.id) { el.hidden = true; return; }
        const pct = run.total ? Math.round(((run.done || 0) / run.total) * 100) : 0;
        const counts = [`${run.tagged || 0} tagged`];
        if (run.failed) counts.push(`${run.failed} failed`);
        if (run.skipped) counts.push(`${run.skipped} skipped`);
        let head;
        let actions = '';
        if (run.status === 'running') {
            head = run.total ? `🏷️ Tagging… ${run.done || 0} of ${run.total}` : '🏷️ Getting started…';
            actions = '<button type="button" class="btn-outline btn-small" data-act="stop">Stop</button>';
        } else {
            const label = { done: '✅ Tagging finished', stopped: '⏹️ Tagging stopped', failed: '⚠️ Tagging stopped', interrupted: '⚠️ Tagging was interrupted' }[run.status] || '🏷️ Tagging';
            head = label;
            actions = '<button type="button" class="hc-x" data-act="dismiss" aria-label="Dismiss">✕</button>';
        }
        const recent = run.status === 'running' && run.recent?.length
            ? `<div class="hc-tag-recent">${run.recent.slice(0, 3).map((r) => `<span><b>${this.escapeHtml(r.name)}</b>: ${this.escapeHtml((r.tags || []).slice(0, 5).join(', '))}</span>`).join('')}</div>`
            : '';
        const left = this._untaggedCount();
        const note = run.error
            ? `<div class="hc-tag-error">${this.escapeHtml(run.error)}${left && run.status !== 'running' ? ` ${left} still untagged; 🏷️ Tag carries on with those.` : ''}</div>`
            : (run.status !== 'running' && run.failed && left ? `<div class="hc-tag-error">${left} still untagged; 🏷️ Tag tries them again.</div>` : '');
        el.innerHTML = `
            <div class="hc-tag-head"><span class="hc-tag-text"><span class="hc-tag-title">${head}</span><span class="hc-tag-counts">${counts.join(' · ')}</span></span>${actions}</div>
            ${run.status === 'running' ? `<div class="hc-tag-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>` : ''}
            ${recent}${note}`;
        el.hidden = false;
    }

    // The four latest things you were doing, from any mode, as one kind of tile.
    async loadRecent() {
        const grid = document.getElementById('home-recent-grid');
        if (!grid) return;
        const get = async (url) => {
            const res = await window.authFetch(url);
            if (!res.ok) throw new Error(`${url} ${res.status}`);
            return res.json();
        };
        const results = await Promise.allSettled([
            get('/api/sw/chats/'), get('/api/sw/messenger/'), get('/api/sw/stories/'), get('/api/sw/adventures/'),
        ]);
        if (results.every((r) => r.status === 'rejected')) {
            grid.innerHTML = '<p class="hr-note">Couldn’t load your recent activity.</p>';
            return;
        }
        const [chats, texts, stories, adventures] = results.map((r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []));
        const people = (list) => (list || []).map((c) => ({ id: c.id, name: c.name || '' }));
        const items = [
            ...chats.map((c) => ({ kind: 'roleplay', id: c.id, title: c.title, at: c.last_at || c.updated_at, characters: null })),
            ...texts.map((c) => ({ kind: 'messenger', id: c.id, title: c.title, at: c.last_at, characters: people(c.characters) })),
            ...stories.map((st) => ({ kind: 'story', id: st.id, title: st.title, at: st.updated_at, characters: people(st.characters) })),
            ...adventures.map((a) => ({ kind: 'adventure', id: a.id, title: a.title, at: a.updated_at, characters: people(a.characters) })),
        ].map((it) => ({ ...it, when: HomeHandler.parseUtc(it.at) }))
            .sort((x, y) => (y.when || 0) - (x.when || 0))
            .slice(0, 4);

        // The roleplay list has no cast: fetch it for the few that are shown.
        await Promise.all(items.filter((it) => !it.characters).map(async (it) => {
            try { it.characters = people((await get(`/api/sw/chats/${it.id}`)).characters); } catch (_) { it.characters = []; }
        }));
        this.renderRecent(items);
    }

    static parseUtc(s) {
        if (!s) return null;
        const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
        return isNaN(d) ? null : d;
    }

    renderRecent(items) {
        const grid = document.getElementById('home-recent-grid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!items.length) {
            grid.innerHTML = '<p class="hr-note">Nothing yet. Pick a character below to start a chat, a story or an adventure.</p>';
            return;
        }
        const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || '';
        const portrait = (id) => `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(id)}${token ? '&token=' + encodeURIComponent(token) : ''}`;

        items.forEach((it) => {
            const mode = HomeHandler.RECENT_MODES[it.kind];
            const cast = it.characters || [];
            const shown = cast.length > 4 ? cast.slice(0, 3) : cast;
            const tile = document.createElement('div');
            tile.className = 'hr-tile';
            tile.tabIndex = 0;
            tile.setAttribute('role', 'button');
            tile.setAttribute('aria-label', `${mode.label}: ${it.title || mode.label}`);

            const art = shown.length
                ? shown.map((c) => `<span class="hr-slot" data-initial="${this.escapeHtml((c.name || '?').charAt(0).toUpperCase())}"><img src="${portrait(c.id)}" alt="" loading="lazy"></span>`).join('')
                  + (cast.length > 4 ? `<span class="hr-slot hr-more">+${cast.length - 3}</span>` : '')
                : `<span class="hr-slot hr-empty" aria-hidden="true">${mode.icon}</span>`;
            const who = cast.map((c) => c.name).filter(Boolean).join(', ');

            tile.innerHTML = `
                <div class="hr-art">
                    ${art}
                    <span class="hr-mode">${mode.icon} ${mode.label}</span>
                    <button type="button" class="hr-del" title="Delete" aria-label="Delete ${this.escapeHtml(it.title || mode.label)}">🗑️</button>
                </div>
                <h3 class="hr-title" title="${this.escapeHtml(it.title)}">${this.escapeHtml(it.title || mode.label)}</h3>
                <div class="hr-who">${who ? '👤 ' + this.escapeHtml(who) : '&nbsp;'}</div>
                <div class="hr-foot"><span class="hr-when">${it.when ? this.formatRelativeDate(it.when) : ''}</span><span class="hr-go">Continue ➔</span></div>`;

            // A portrait that won't load shows the initial instead.
            tile.querySelectorAll('.hr-slot img').forEach((img) => {
                img.addEventListener('error', () => { img.parentElement.classList.add('hr-noimg'); img.remove(); });
            });
            tile.querySelector('.hr-del').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showDeleteConfirmation('activity', { ...it, characters: cast }, shown.length ? shown.map((c) => portrait(c.id)) : null);
            });
            const open = () => this.openRecent(it);
            tile.addEventListener('click', open);
            tile.addEventListener('keydown', (e) => {
                if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
            });
            grid.appendChild(tile);
        });
    }

    async openRecent(it) {
        if (it.kind === 'roleplay') {
            document.getElementById('tab-roleplaychat')?.click();
            await window.roleplayChatHandler?.selectChat(it.id);
        } else if (it.kind === 'messenger') {
            window.messengerHandler?.showView();
            await window.messengerHandler?.openChat(it.id);
        } else if (it.kind === 'story') {
            document.getElementById('tab-storywriter')?.click();
            await window.storyWriterApp?.openStory(it.id);
        } else if (it.kind === 'adventure') {
            document.getElementById('tab-adventure')?.click();
            await window.adventureHandler?.openSession(it.id);
        }
    }

    // Deleted from Home while it is open in its own tab: close it there.
    _closeIfOpen(it) {
        if (it.kind === 'roleplay' && window.roleplayChatHandler?.activeChatId === it.id) {
            window.roleplayChatHandler.activeChatId = null;
            window.roleplayChatHandler.showLobby?.();
        } else if (it.kind === 'messenger' && window.messengerHandler?.chat?.id === it.id) {
            window.messengerHandler.closeChat();
        } else if (it.kind === 'story' && String(window.storyWriterApp?.currentStoryId) === String(it.id)) {
            document.getElementById('sw-back-btn')?.click();
        } else if (it.kind === 'adventure' && window.adventureHandler?.currentSessionId === it.id) {
            window.adventureHandler.closeSession();
        }
    }

    formatRelativeDate(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    showDeleteConfirmation(type, item, imgSrc) {
        // Create modal container
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.8); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(4px);
        `;

        const title = type === 'card' 
            ? (item.characterName || (item.character && item.character.name) || item.name || 'Unknown Character')
            : (item.title || 'Untitled');

        const details = type === 'card'
            ? `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 1rem; max-height: 100px; overflow-y: auto;">
                ${this.escapeHtml((item.character?.description || item.blurb || '').substring(0, 150))}${(item.character?.description || item.blurb || '').length > 150 ? '...' : ''}
               </div>`
            : `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 1rem;">
                Characters: ${this.escapeHtml((item.characters || []).map(c => c.name).join(', ') || 'Unknown')}
               </div>`;

        const content = document.createElement('div');
        content.style.cssText = `
            background: var(--surface-strong); border: 1px solid var(--border-strong);
            border-radius: 1rem; padding: 2rem; max-width: 400px; width: 90%;
            display: flex; flex-direction: column; align-items: center; text-align: center;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        `;

        const imgHtml = !imgSrc
            ? `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:4rem;">${HomeHandler.RECENT_MODES[item.kind]?.icon || '🗂️'}</div>`
            : type === 'activity' && Array.isArray(imgSrc) 
            ? `<div style="position:relative; width:100%; height:100%;">${imgSrc.map((src, i) => `<div style="position:absolute; top:0; left:${(100/imgSrc.length)*i}%; width:${100/imgSrc.length}%; height:100%; overflow:hidden; border-right:${i < imgSrc.length - 1 ? '1px solid var(--border)' : 'none'};"><img src="${src}" style="width:100%; height:100%; object-fit:cover; object-position:top;"></div>`).join('')}</div>`
            : `<img src="${imgSrc}" style="width: 100%; height: 100%; object-fit: cover;">`;

        content.innerHTML = `
            <h2 style="margin: 0 0 1rem 0; color: #e55; font-size: 1.5rem;">Are you sure?</h2>
            <div style="width: 200px; height: 200px; border-radius: 0.5rem; overflow: hidden; margin-bottom: 1.5rem; border: 2px solid var(--border); box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                ${imgHtml}
            </div>
            <h3 style="margin: 0 0 0.5rem 0; font-size: 1.25rem;">${this.escapeHtml(title)}</h3>
            ${details}
            <p style="margin: 0 0 1.5rem 0; font-size: 0.95rem; color: var(--text-primary);">This action cannot be undone.</p>
            <div style="display: flex; gap: 1rem; width: 100%;">
                <button class="btn-outline" id="cancel-delete-btn" style="flex: 1; padding: 0.75rem; font-size: 1rem;">Cancel</button>
                <button class="btn-primary" id="confirm-delete-btn" style="flex: 1; padding: 0.75rem; background: #e55; border-color: #e55; font-size: 1rem;">Yes, Delete</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        content.querySelector('#cancel-delete-btn').addEventListener('click', () => {
            modal.remove();
        });

        content.querySelector('#confirm-delete-btn').addEventListener('click', async () => {
            const btn = content.querySelector('#confirm-delete-btn');
            btn.disabled = true;
            btn.textContent = 'Deleting...';
            try {
                if (type === 'card') {
                    await window.characterStorage.deleteCard(item.id);
                    // Out of the grid at once, the scroll position kept; then the real list.
                    this.cards = this.cards.filter((c) => String(c.id) !== String(item.id));
                    this.render({ keepPlace: true });
                    this.loadCards({ keepPlace: true });
                } else if (type === 'activity') {
                    const res = await window.authFetch(`${HomeHandler.RECENT_MODES[item.kind].api}${encodeURIComponent(item.id)}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error('Failed to delete');
                    this._closeIfOpen(item);
                    this.loadRecent();
                }
                modal.remove();
            } catch (err) {
                console.error('Delete failed:', err);
                btn.disabled = false;
                btn.textContent = 'Error - Try Again';
                alert('Failed to delete. Check console for details.');
            }
        });
    }
}

HomeHandler.RECENT_MODES = {
    roleplay: { icon: '💬', label: 'Roleplay', api: '/api/sw/chats/' },
    messenger: { icon: '💌', label: 'Messenger', api: '/api/sw/chats/' },
    story: { icon: '📖', label: 'Story', api: '/api/sw/stories/' },
    adventure: { icon: '🎲', label: 'Adventure', api: '/api/sw/adventures/' },
};

HomeHandler.BROWSE_KEY = 'cardgen.homeBrowse.v1';
HomeHandler.BATCH = 48;
HomeHandler.MAX_TAG_CHIPS = 40;
HomeHandler.SORTS = {
    newest: { label: 'Newest', summary: 'newest first', compare: (a, b) => b._created - a._created || a._name.localeCompare(b._name) },
    edited: { label: 'Last edited', summary: 'last edited first', compare: (a, b) => b._updated - a._updated || b._created - a._created },
    recent: { label: 'Last used', summary: 'last used first', compare: (a, b) => b._used - a._used || b._created - a._created },
    most: { label: 'Most used', summary: 'most used first', compare: (a, b) => b.uses - a.uses || b._used - a._used || b._created - a._created },
    az: { label: 'A–Z', summary: 'A to Z', compare: (a, b) => a._name.localeCompare(b._name) },
    oldest: { label: 'Oldest', summary: 'oldest first', compare: (a, b) => a._created - b._created || a._name.localeCompare(b._name) },
};

window.homeHandler = new HomeHandler();

/**
 * Adventure mode: a guided story. The narrator writes a beat and offers four
 * choices; you pick one (or write your own) and it writes the next beat.
 *
 * The open adventure is a reader like Story Writer's: a slim top bar (back,
 * title, Aa, ⋯), the story in one column, and a tray stuck to the bottom with
 * the choices, Your own…, New options, and Stop while a beat is being written.
 *
 * Phone locks and dropped connections: the backend writes each beat in a task
 * that outlives the browser's connection and pings every 15 s. A stream that
 * goes 45 s without a byte counts as dropped (time spent hidden or asleep is
 * ignored, per CLAUDE.md's iOS rules) and the beat is fetched from the server
 * instead. Waking the phone never aborts a live stream. Stop cancels on the
 * server too.
 */
(function () {
    const STALL_MS = 45000;
    const RECOVER_POLL_MS = 3000;
    const RECOVER_GIVE_UP_MS = 6 * 60 * 1000;

    // Story Writer's reading options, shared (same key, same CSS variables).
    const PREFS_KEY = 'cardgen.storyReader.v1';
    const SIZES = [0.85, 0.92, 1, 1.08, 1.17, 1.27, 1.4, 1.55, 1.7];
    const DEFAULT_SIZE = 2;
    const SPACING = { compact: 1.5, normal: 1.7, roomy: 1.95 };
    const FONTS = {
        sans: 'inherit',
        serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    };

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
    const isTouch = () => window.matchMedia?.('(hover: none)').matches;

    function parseOptions(raw) {
        let items = [];
        try { items = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []); } catch (_) { items = []; }
        if (!Array.isArray(items)) return [];
        return items.map((o) => (typeof o === 'string' ? { text: o, risk: '' } : { text: String(o?.text || ''), risk: o?.risk || '' }))
            .filter((o) => o.text.trim());
    }

    function parseRoll(raw) {
        try { const r = raw ? JSON.parse(raw) : null; return r && typeof r === 'object' ? r : null; } catch (_) { return null; }
    }

    function loadPrefs() {
        let p = {};
        try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { /* private mode */ }
        return {
            size: Number.isInteger(p.size) && p.size >= 0 && p.size < SIZES.length ? p.size : DEFAULT_SIZE,
            font: FONTS[p.font] ? p.font : 'sans',
            spacing: SPACING[p.spacing] ? p.spacing : 'normal',
        };
    }

    class AdventureHandler {
        constructor() {
            this.session = null;          // the open adventure (detail)
            this.currentSessionId = null;
            this.selectedCharacters = [];
            this.isGenerating = false;
            this.live = null;             // the beat streaming in this page
            this._recovering = null;      // token of a running recovery poll
            this.systemPromptSegments = [];
            this.prefs = loadPrefs();

            this.initDOM();
            this.bindEvents();
            this.injectSettingsModal();
            this._applyPrefs();
        }

        initDOM() {
            const $ = (id) => document.getElementById(id);
            this.viewTabs = {
                cardgen: $('view-cardgen'), storywriter: $('view-storywriter'),
                roleplaychat: $('view-roleplaychat'), adventure: $('view-adventure'),
            };
            this.tabBtns = {
                cardgen: $('tab-cardgen'), storywriter: $('tab-storywriter'),
                roleplaychat: $('tab-roleplaychat'), adventure: $('tab-adventure'),
            };
            this.landingView = $('adv-landing-view');
            this.sessionGrid = $('adv-session-grid');
            this.newBtn = $('adv-new-btn');
            this.newModal = $('adv-new-modal');
            this.selectedCharsContainer = $('adv-selected-chars');
            this.startingScenario = $('adv-starting-scenario');
            this.systemPrompt = $('adv-system-prompt');
            this.startBtn = $('adv-start-btn');

            this.playView = $('adv-play-view');
            this.titleText = $('adv-title-text');
            this.storyArea = $('adv-story-area');
            this.tray = $('adv-tray');
            this.choicesEl = $('adv-choices');
            this.statusEl = $('adv-status');
            this.statusText = $('adv-status-text');
            this.stopBtn = $('adv-stop-btn');
            this.ownRow = $('adv-own-row');
            this.ownInput = $('adv-own-input');
            this.playerEl = $('adv-player');
        }

        bindEvents() {
            const $ = (id) => document.getElementById(id);
            this.tabBtns.adventure?.addEventListener('click', () => this.showView());

            $('adv-add-char-btn').addEventListener('click', () => this._pickCharacter());
            this.newBtn.addEventListener('click', () => this.openNewAdventureModal());
            $('adv-new-modal-close').addEventListener('click', () => this.closeNewAdventureModal());
            this.newModal.addEventListener('click', (e) => { if (e.target === this.newModal) this.closeNewAdventureModal(); });
            this.startBtn.addEventListener('click', () => this.startNewAdventure());
            $('adv-inspire-btn').addEventListener('click', () => this._inspire());

            $('adv-back-btn').addEventListener('click', () => this.closeSession());
            $('adv-title-btn').addEventListener('click', () => this.openRename());
            this.stopBtn.addEventListener('click', () => this.stopGeneration());

            // Your own…
            this.ownRow.addEventListener('submit', (e) => {
                e.preventDefault();
                const text = this.ownInput.value.trim();
                if (!text || this.isGenerating) return;
                this.ownInput.value = '';
                this._showOwn(false);
                this.choose({ text, risk: '' }, 'custom');
            });
            $('adv-own-cancel').addEventListener('click', () => this._showOwn(false));
            this.ownInput.addEventListener('input', () => this._sizeOwn());
            this.ownInput.addEventListener('keydown', (e) => {
                // Desktop: Enter sends, Shift+Enter is a new line. Phones use the Send key.
                if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); this.ownRow.requestSubmit(); }
                if (e.key === 'Escape') this._showOwn(false);
            });

            // Tap a beat's text to show its actions; tap a pick to see the other options.
            this.storyArea.addEventListener('click', (e) => this._onStoryClick(e));

            // Aa and ⋯
            this._bindPopover('adv-aa-btn', 'adv-aa-pop');
            this._bindPopover('adv-more-btn', 'adv-more-pop');
            $('adv-aa-pop').addEventListener('click', (e) => {
                const b = e.target.closest('button');
                if (!b) return;
                if (b.dataset.readerSize !== undefined) {
                    const step = Number(b.dataset.readerSize);
                    this._setPref('size', step === 0 ? DEFAULT_SIZE : Math.max(0, Math.min(SIZES.length - 1, this.prefs.size + step)));
                }
                if (b.dataset.readerFont) this._setPref('font', b.dataset.readerFont);
                if (b.dataset.readerSpacing) this._setPref('spacing', b.dataset.readerSpacing);
            });
            $('adv-more-pop').addEventListener('click', (e) => {
                const b = e.target.closest('[data-adv-more]');
                if (!b) return;
                this.closePopovers();
                const what = b.dataset.advMore;
                if (what === 'rename') this.openRename();
                else if (what === 'cast') this.openCast();
                else if (what === 'journal') this.openJournal?.();
                else if (what === 'adventure') this.openAdventureSettings?.();
                else if (what === 'settings') this.openGlobalSettings();
            });
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#view-adventure .adv-pop-anchor')) this.closePopovers();
            });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closePopovers(); });

            $('adv-player-pause').addEventListener('click', () => this._togglePause());
            $('adv-player-stop').addEventListener('click', () => this._stopReading());

            if (window.ResizeObserver) {
                new ResizeObserver(() => {
                    document.documentElement.style.setProperty('--adv-tray-h', `${this.tray.offsetHeight}px`);
                }).observe(this.tray);
            }

            // Phone unlock / tab switch.
            document.addEventListener('visibilitychange', () => this.syncOnWake());
            window.addEventListener('focus', () => this.syncOnWake());
        }

        // ── Views ────────────────────────────────────────────────────────────

        showView() {
            Object.values(this.viewTabs).forEach((v) => { if (v) v.style.display = 'none'; });
            Object.values(this.tabBtns).forEach((b) => { if (b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); } });
            this.viewTabs.adventure.style.display = 'block';
            this.tabBtns.adventure.classList.remove('btn-outline');
            this.tabBtns.adventure.classList.add('btn-primary');
            if (!this.currentSessionId) {
                this.playView.style.display = 'none';
                this.landingView.style.display = 'block';
                this.loadSessionList();
            }
        }

        closeSession() {
            // A beat being written carries on on the server; just stop listening.
            if (this._abort) { this._abort.abort(); this._abort = null; }
            if (this.isGenerating) { this.isGenerating = false; this._setStatus(null); window.wakeLockManager?.release(); }
            this._recovering = null;
            this._liveActionId = null;
            this._stopReading();
            this.closePopovers();
            this.currentSessionId = null;
            this.session = null;
            this.playView.style.display = 'none';
            this.landingView.style.display = 'block';
            window.scrollTo(0, 0);
            this.loadSessionList();
        }

        async loadSessionList() {
            try {
                const res = await window.authFetch('/api/sw/adventures/');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.sessionGrid.innerHTML = '';
                if (data.length === 0) {
                    this.sessionGrid.innerHTML = '<div class="adv-empty-list">No adventures yet. Tap <b>＋ New adventure</b> to begin.</div>';
                    return;
                }
                data.forEach((sess) => this.sessionGrid.appendChild(this._buildCard(sess)));
            } catch (e) {
                console.error('[Adventure] Failed to load adventures', e);
                this.sessionGrid.innerHTML = '<div class="adv-empty-list">Couldn’t load your adventures. Pull to refresh or try again.</div>';
            }
        }

        _buildCard(sess) {
            const card = document.createElement('div');
            card.className = 'adv-card';
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            const chars = sess.characters || [];
            const updated = new Date(sess.updated_at);
            const when = isNaN(updated) ? '' : updated.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
            const beats = sess.beats || 0;
            card.appendChild(this._buildCover(chars));
            const body = document.createElement('div');
            body.className = 'adv-card-body';
            body.innerHTML = `
                <h3 class="adv-card-title">${esc(sess.title)}</h3>
                ${chars.length ? `<div class="adv-card-cast">${esc(chars.map((c) => c.name).join(', '))}</div>` : ''}
                ${sess.excerpt ? `<p class="adv-card-excerpt">${esc(sess.excerpt)}</p>` : ''}
                <div class="adv-card-meta">${beats} ${beats === 1 ? 'beat' : 'beats'}${when ? ` · Updated ${esc(when)}` : ''}</div>`;
            card.appendChild(body);

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'adv-card-delete';
            del.textContent = '🗑️';
            del.title = 'Delete adventure';
            del.setAttribute('aria-label', `Delete ${sess.title}`);
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete “${sess.title}”? This cannot be undone.`)) return;
                await window.authFetch('/api/sw/adventures/' + sess.id, { method: 'DELETE' });
                this.loadSessionList();
            });
            card.appendChild(del);

            const open = () => this.openSession(sess.id);
            card.addEventListener('click', open);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
            return card;
        }

        /** Portraits for a list card: up to 4, "+N" for the rest, ⚔️ with none. */
        _buildCover(characters) {
            const MAX = 4;
            const cover = document.createElement('div');
            cover.className = 'sw-story-cover';
            if (!characters.length) {
                cover.classList.add('is-empty');
                cover.textContent = '⚔️';
                return cover;
            }
            const shown = characters.length > MAX ? characters.slice(0, MAX - 1) : characters;
            shown.forEach((c) => {
                const slot = document.createElement('div');
                slot.className = 'sw-story-cover-slot';
                const initial = document.createElement('span');
                initial.textContent = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
                slot.appendChild(initial);
                const img = document.createElement('img');
                img.loading = 'lazy';
                img.alt = '';
                img.src = this.getAvatarUrl(c.id);
                img.onerror = () => img.remove();
                slot.appendChild(img);
                cover.appendChild(slot);
            });
            if (characters.length > MAX) {
                const more = document.createElement('div');
                more.className = 'sw-story-cover-slot is-more';
                more.textContent = `+${characters.length - (MAX - 1)}`;
                cover.appendChild(more);
            }
            return cover;
        }

        getAvatarUrl(cardId) {
            const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || '';
            return `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(cardId)}&token=${encodeURIComponent(token)}`;
        }

        _avatar(c, cls = '') {
            const wrap = document.createElement('span');
            wrap.className = `adv-avatar ${cls}`.trim();
            wrap.textContent = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
            const img = document.createElement('img');
            img.alt = '';
            img.src = this.getAvatarUrl(c.id);
            img.onload = () => wrap.replaceWith(img);
            img.onerror = () => {};
            return wrap;
        }

        // ── New adventure ────────────────────────────────────────────────────

        openNewAdventureModal() {
            const segments = window.config?.get('adventure.systemPromptSegments') || [];
            if (this.systemPrompt) this.systemPrompt.value = segments.join('\n\n');
            this.selectedCharacters = [];
            this.renderSelectedCharacters();
            this.startingScenario.value = '';
            document.getElementById('adv-inspire-list').innerHTML = '';
            document.getElementById('adv-inspire-note').textContent = '';
            document.getElementById('adv-new-error').hidden = true;
            this.startBtn.disabled = false;
            this.onNewSheetOpen?.();
            this.newModal.hidden = false;
            document.documentElement.classList.add('saw-open');
        }

        closeNewAdventureModal() {
            this.newModal.hidden = true;
            document.documentElement.classList.remove('saw-open');
        }

        async _pickCharacter() {
            if (!window.cardGallery || !window.characterStorage) {
                alert('The card gallery isn’t loaded yet.');
                return;
            }
            try {
                const allCards = await window.characterStorage.listCards();
                const unselected = allCards.filter((c) => !this.selectedCharacters.includes(c.id) && c.isPermanent);
                window.cardGallery.open(unselected, (picked) => {
                    const id = typeof picked === 'object' ? picked.id : picked;
                    if (!this.selectedCharacters.includes(id)) {
                        this.selectedCharacters.push(id);
                        this.renderSelectedCharacters();
                    }
                });
            } catch (e) {
                console.error('[Adventure] Failed to load cards for the gallery', e);
            }
        }

        async renderSelectedCharacters() {
            const box = this.selectedCharsContainer;
            box.innerHTML = '';
            for (const id of this.selectedCharacters) {
                const card = await window.characterStorage?.getCard(id);
                if (!card) continue;
                const name = card.characterName || card.character?.name || card.name || 'Unknown';
                const chip = document.createElement('span');
                chip.className = 'adv-cast-chip';
                chip.appendChild(this._avatar({ id, name }));
                const label = document.createElement('span');
                label.textContent = name;
                chip.appendChild(label);
                const x = document.createElement('button');
                x.type = 'button';
                x.textContent = '×';
                x.setAttribute('aria-label', `Remove ${name}`);
                x.addEventListener('click', () => {
                    this.selectedCharacters = this.selectedCharacters.filter((cid) => cid !== id);
                    this.renderSelectedCharacters();
                });
                chip.appendChild(x);
                box.appendChild(chip);
            }
        }

        async _inspire() {
            const btn = document.getElementById('adv-inspire-btn');
            const note = document.getElementById('adv-inspire-note');
            const list = document.getElementById('adv-inspire-list');
            btn.disabled = true;
            note.textContent = 'Dreaming up openings…';
            list.innerHTML = '';
            try {
                const ev = await this._utilityCall('/api/sw/adventures/inspire', {
                    card_ids: this.selectedCharacters, genre: this.newSheetGenre?.() || '',
                }, 'openings');
                note.textContent = 'Tap one to use it, then change anything you like.';
                ev.openings.forEach((text) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = text;
                    b.addEventListener('click', () => {
                        this.startingScenario.value = text;
                        list.innerHTML = '';
                        note.textContent = '';
                    });
                    list.appendChild(b);
                });
            } catch (e) {
                note.textContent = `Couldn’t get openings: ${e.message}`;
            } finally {
                btn.disabled = false;
            }
        }

        async startNewAdventure() {
            const errEl = document.getElementById('adv-new-error');
            errEl.hidden = true;
            this.startBtn.disabled = true;
            try {
                const res = await window.authFetch('/api/sw/adventures/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        starting_scenario: this.startingScenario.value.trim(),
                        system_prompt: this.systemPrompt ? this.systemPrompt.value.trim() : '',
                        card_ids: this.selectedCharacters,
                        config: this.newSheetConfig?.() || {},
                    }),
                });
                if (!res.ok) throw new Error(await this._errorText(res));
                const data = await res.json();
                this.closeNewAdventureModal();
                this._showSession(data);
                await this.runBeat({ role: 'system', kind: 'start' });
            } catch (e) {
                errEl.textContent = `Couldn’t start the adventure: ${e.message}`;
                errEl.hidden = false;
            } finally {
                this.startBtn.disabled = false;
            }
        }

        // ── The open adventure ───────────────────────────────────────────────

        async openSession(id) {
            try {
                const res = await window.authFetch('/api/sw/adventures/' + id);
                if (!res.ok) throw new Error(await this._errorText(res));
                const data = await res.json();
                this._showSession(data);
                window.scrollTo(0, document.documentElement.scrollHeight);
                this._afterLoad();
            } catch (e) {
                alert('Failed to load the adventure: ' + e.message);
            }
        }

        _showSession(data) {
            this.session = data;
            this.currentSessionId = data.id;
            this.landingView.style.display = 'none';
            this.playView.style.display = 'flex';
            this._showTitle(data.title);
            this.render();
        }

        /** What the tray should offer once the story is on screen. */
        _afterLoad() {
            const last = this._lastAction();
            if (last && last.role === 'assistant' && !last.content) {
                this._recoverBeat(last.id, null); // still being written on the server
            }
        }

        _lastAction() {
            const a = this.session?.actions || [];
            return a[a.length - 1] || null;
        }

        _showTitle(title) {
            this.titleText.textContent = title || 'Adventure';
            if (this.session) this.session.title = title;
        }

        render() {
            const s = this.session;
            const area = this.storyArea;
            area.innerHTML = '';
            if (s.starting_scenario) {
                const op = document.createElement('div');
                op.className = 'adv-opening';
                op.innerHTML = `<b>How it began</b>${esc(s.starting_scenario)}`;
                area.appendChild(op);
            }
            const actions = s.actions || [];
            const beats = actions.filter((a) => a.role === 'assistant' && a.content);
            const lastBeat = beats[beats.length - 1];
            let prevOptions = [];
            actions.forEach((a) => {
                if (a.role === 'user') {
                    area.appendChild(this._buildPick(a, prevOptions));
                } else if (a.role === 'assistant' && a.content) {
                    area.appendChild(this._buildBeat(a, a === lastBeat, a === lastBeat && a === actions[actions.length - 1]));
                    prevOptions = parseOptions(a.options);
                }
            });
            if (!actions.length && !s.starting_scenario) {
                const empty = document.createElement('p');
                empty.className = 'adv-empty';
                empty.textContent = 'Nothing written yet.';
                area.appendChild(empty);
            }
            this.renderTray();
        }

        /** The tray when nothing is being written: the latest beat's choices, or a way on. */
        renderTray() {
            if (this.isGenerating) return;
            this._setStatus(null);
            const last = this._lastAction();
            this.choicesEl.innerHTML = '';
            this._clearNotice();
            if (!last) {
                this._notice('The story hasn’t started yet.', [['▶ Begin', () => this.runBeat({ role: 'system', kind: 'start' })]]);
                this._renderExtras([]);
                return;
            }
            if (last.role === 'user') {
                // The beat after this choice never arrived (failed, stopped, or lost).
                const prevBeat = [...this.session.actions].reverse().find((a) => a.role === 'assistant' && a.content);
                const buttons = [['🔄 Try again', () => this.runBeat({ role: 'system', kind: 'retry' })]];
                if (prevBeat) buttons.push(['↩ Choose again', () => this.rewindTo(prevBeat.id, false)]);
                this._notice(this._pendingNotice || 'The narrator didn’t finish the next beat.', buttons);
                this._pendingNotice = null;
                return;
            }
            const options = parseOptions(last.options);
            options.forEach((o, i) => this.choicesEl.appendChild(this._buildChoice(o, i)));
            this._renderExtras(options);
        }

        _renderExtras(options) {
            const row = document.createElement('div');
            row.className = 'adv-choice-extra';
            if (!options.length && this._lastAction()) {
                const cont = document.createElement('button');
                cont.type = 'button';
                cont.className = 'adv-choice-solo';
                cont.textContent = '▶ Continue';
                cont.addEventListener('click', () => this.choose({ text: 'Continue the story.', risk: '' }, 'custom'));
                row.appendChild(cont);
            }
            const own = document.createElement('button');
            own.type = 'button';
            own.textContent = '✍️ Your own…';
            own.addEventListener('click', () => this._showOwn(true));
            row.appendChild(own);
            const last = this._lastAction();
            if (last && last.role === 'assistant' && last.content) {
                const reroll = document.createElement('button');
                reroll.type = 'button';
                reroll.textContent = '🎲 New options';
                reroll.addEventListener('click', () => this.newOptions(reroll));
                row.appendChild(reroll);
            }
            this.choicesEl.appendChild(row);
        }

        _buildChoice(o, i) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'adv-choice';
            b.innerHTML = `<span class="adv-choice-num">${i + 1}</span><span class="adv-choice-text">${esc(o.text)}</span>`
                + (o.risk === 'safe' || o.risk === 'risky' ? `<span class="adv-risk adv-risk-${o.risk}">${o.risk === 'risky' ? 'Risky' : 'Safe'}</span>` : '');
            b.addEventListener('click', () => this.choose(o, 'option'));
            return b;
        }

        _showOwn(on) {
            this.ownRow.hidden = !on;
            this.choicesEl.hidden = on;
            if (on) {
                this._sizeOwn();
                this.ownInput.focus();
            }
        }

        _sizeOwn() {
            const t = this.ownInput;
            t.style.height = 'auto';
            t.style.height = `${Math.min(t.scrollHeight, 144)}px`;
        }

        _buildPick(action, options) {
            const wrap = document.createElement('div');
            wrap.className = 'adv-pick';
            wrap.dataset.actionId = action.id;
            const others = options.filter((o) => o.text.trim() !== action.content.trim());
            const isOwn = options.length > 0 && others.length === options.length;
            const roll = parseRoll(action.roll);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'adv-pick-chip';
            chip.innerHTML = `<span class="adv-pick-arrow" aria-hidden="true">${isOwn ? '✍️' : '➜'}</span>`
                + `<span class="adv-pick-text">${esc(action.content)}${roll ? this._rollBadge(roll) : ''}</span>`
                + (others.length ? `<span class="adv-pick-more">${others.length} not taken</span>` : '');
            wrap.appendChild(chip);
            if (others.length) {
                chip.setAttribute('aria-expanded', 'false');
                const list = document.createElement('ul');
                list.className = 'adv-pick-others';
                list.hidden = true;
                others.forEach((o) => { const li = document.createElement('li'); li.textContent = o.text; list.appendChild(li); });
                wrap.appendChild(list);
            } else {
                chip.setAttribute('aria-disabled', 'true');
            }
            return wrap;
        }

        _rollBadge(roll) {
            const label = { crit: 'Critical!', success: 'Success', mixed: 'Partly', fail: 'Fails', fumble: 'Disaster' }[roll.outcome] || roll.outcome;
            return ` <span class="adv-roll adv-roll-${esc(roll.outcome)}" title="d20 roll">🎲 ${esc(roll.d)} · ${esc(label)}</span>`;
        }

        _buildBeat(action, isLatestBeat, isLastAction) {
            const el = document.createElement('article');
            el.className = 'adv-beat';
            el.dataset.actionId = action.id;
            if (isLatestBeat) el.classList.add('is-latest');
            if (action.is_summarized) el.classList.add('is-summarized');
            const text = document.createElement('div');
            text.className = 'adv-beat-text';
            text.innerHTML = this.formatStory(action.content);
            el.appendChild(text);

            const image = document.createElement('div');
            image.className = 'adv-beat-image';
            image.hidden = true;
            el.appendChild(image);
            if (action.has_image) this._loadImage(action, image);

            const bar = document.createElement('div');
            bar.className = 'adv-beat-actions';
            const btn = (icon, label, title, fn, extra = '') => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = `btn-small btn-outline ${extra}`.trim();
                b.title = title;
                b.setAttribute('aria-label', title);
                b.innerHTML = `<span aria-hidden="true">${icon}</span><span class="adv-act-label">${label}</span>`;
                b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
                return b;
            };
            bar.appendChild(btn('🔊', 'Read', 'Read this beat aloud', () => this.readAloud(action, el)));
            bar.appendChild(btn('✏️', 'Edit', 'Edit this beat', () => this.openEditor(action)));
            bar.appendChild(btn('🎨', action.has_image ? 'Redraw' : 'Picture', 'Draw a picture of this scene', (b) => this.drawPicture(action, image, b)));
            if (isLastAction) {
                bar.appendChild(btn('🔄', 'Redo', 'Write this beat again', () => this.regenerate(action)));
                const prev = this._beatBefore(action);
                if (prev && !prev.is_summarized) bar.appendChild(btn('↩', 'Undo', 'Undo your last choice', () => this.rewindTo(prev.id, true), 'adv-act-end'));
            } else if (!action.is_summarized) {
                bar.appendChild(btn('↩', 'Rewind', 'Go back to this point and choose again', () => this.rewindTo(action.id, true), 'adv-act-end'));
            }
            el.appendChild(bar);
            return el;
        }

        _beatBefore(action) {
            const beats = (this.session.actions || []).filter((a) => a.role === 'assistant' && a.content && a.order_index < action.order_index);
            return beats[beats.length - 1] || null;
        }

        _onStoryClick(e) {
            const chip = e.target.closest('.adv-pick-chip');
            if (chip) {
                const list = chip.parentElement.querySelector('.adv-pick-others');
                if (list) {
                    list.hidden = !list.hidden;
                    chip.setAttribute('aria-expanded', String(!list.hidden));
                }
                return;
            }
            const img = e.target.closest('.adv-beat-image img');
            if (img) {
                if (typeof window.app?.openGallery === 'function') {
                    window.app.openGallery([{ url: img.src, prompt: img.dataset.prompt || '', label: 'Adventure scene' }]);
                }
                return;
            }
            const text = e.target.closest('.adv-beat-text');
            if (!text || e.target.closest('a, button, summary, details')) return;
            if (String(window.getSelection?.() || '').trim()) return; // selecting text, not tapping
            const beat = text.closest('.adv-beat');
            const open = !beat.classList.contains('adv-actions-open');
            this.storyArea.querySelectorAll('.adv-actions-open').forEach((b) => b.classList.remove('adv-actions-open'));
            beat.classList.toggle('adv-actions-open', open);
        }

        _notice(message, buttons = []) {
            this._clearNotice();
            const n = document.createElement('div');
            n.className = 'adv-notice';
            n.setAttribute('role', 'status');
            const span = document.createElement('span');
            span.textContent = message;
            n.appendChild(span);
            buttons.forEach(([label, fn]) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn-small btn-outline';
                b.textContent = label;
                b.addEventListener('click', () => { n.remove(); fn(); });
                n.appendChild(b);
            });
            this.storyArea.appendChild(n);
            return n;
        }

        _clearNotice() {
            this.storyArea.querySelectorAll('.adv-notice').forEach((n) => n.remove());
        }

        _setStatus(text) {
            clearInterval(this._statusTimer);
            if (!text) {
                this.statusEl.hidden = true;
                return;
            }
            const started = Date.now();
            const paint = () => {
                const secs = Math.floor((Date.now() - started) / 1000);
                this.statusText.textContent = secs >= 5 ? `${text} ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : text;
            };
            paint();
            this._statusTimer = setInterval(paint, 1000);
            this.statusEl.hidden = false;
        }

        _setGenerating(on, statusText = 'The narrator is plotting…') {
            this.isGenerating = on;
            if (on) {
                this.choicesEl.innerHTML = '';
                this._showOwn(false);
                this.choicesEl.hidden = false;
                this._clearNotice();
                this._setStatus(statusText);
                this.stopBtn.hidden = false;
                window.wakeLockManager?.acquire();
            } else {
                this._setStatus(null);
                window.wakeLockManager?.release();
            }
        }

        // ── Writing a beat ───────────────────────────────────────────────────

        /** Pick an option or send your own direction. */
        choose(option, kind) {
            if (this.isGenerating) return;
            this.runBeat({ role: 'user', content: option.text, kind, risk: option.risk || null });
        }

        _genOptions() {
            const cfg = window.config;
            const maxInput = cfg?.get('adventure.maxInputTokens');
            const rep = cfg?.get('adventure.repetitionPenalty');
            const out = { enable_cot: cfg?.get('adventure.enableCot') !== false };
            if (Number.isFinite(maxInput) && maxInput > 0) out.max_input_tokens = maxInput;
            if (Number.isFinite(rep) && rep > 0) out.repetition_penalty = rep;
            return out;
        }

        async runBeat(body) {
            if (this.isGenerating || !this.currentSessionId) return;
            try {
                await this._runBeat(body);
            } finally {
                this._abort = null;
                this._streamActionId = null;
            }
        }

        async _runBeat(body) {
            const sessionId = this.currentSessionId;
            this._stopReading();
            this._setGenerating(true);

            // The pick goes on screen at once; the server stores it with the beat.
            let pickEl = null;
            if (body.role === 'user' && body.content) {
                const prev = [...this.session.actions].reverse().find((a) => a.role === 'assistant' && a.content);
                pickEl = this._buildPick({ id: '', content: body.content, roll: '' }, prev ? parseOptions(prev.options) : []);
                this.storyArea.appendChild(pickEl);
            }
            if (body.kind === 'regen') {
                const last = this._lastAction();
                const lastEl = last && this.storyArea.querySelector(`.adv-beat[data-action-id="${CSS.escape(last.id)}"]`);
                lastEl?.remove();
            }
            this.storyArea.querySelectorAll('.adv-beat.is-latest').forEach((b) => b.classList.remove('is-latest', 'adv-actions-open'));
            const beatEl = document.createElement('article');
            beatEl.className = 'adv-beat is-streaming';
            const textEl = document.createElement('div');
            textEl.className = 'adv-beat-text';
            beatEl.appendChild(textEl);
            this.storyArea.appendChild(beatEl);
            const follow = this._startFollow(pickEl || beatEl);

            const controller = new AbortController();
            this._abort = controller;
            let text = '';
            let actionId = null;
            let final = null;
            let errorMsg = null;
            let userActionId = null;
            let roll = null;
            try {
                const res = await window.authFetch(`/api/sw/adventures/${sessionId}/action`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...this._genOptions(), ...body }),
                    signal: controller.signal,
                });
                if (!res.ok) throw Object.assign(new Error(await this._errorText(res)), { http: res.status });
                await this._readStream(res, controller, () => actionId, (ev) => {
                    if (ev.type === 'chunk') {
                        text += ev.content;
                        const shown = this._displayText(text);
                        if (shown !== null) {
                            textEl.innerHTML = this.formatStory(shown);
                            if (shown.trim()) this._setStatusOnce('The narrator is writing…');
                            follow();
                        }
                    } else if (ev.type === 'metadata') {
                        actionId = ev.assistant_action_id;
                        this._streamActionId = actionId;
                        userActionId = ev.user_action_id;
                        roll = ev.roll || null;
                        if (pickEl && roll) pickEl.querySelector('.adv-pick-text').insertAdjacentHTML('beforeend', this._rollBadge(roll));
                    } else if (ev.type === 'status') {
                        this._setStatus(ev.message);
                    } else if (ev.type === 'final') {
                        final = ev;
                    } else if (ev.type === 'title') {
                        this._showTitle(ev.title);
                    } else if (ev.type === 'error') {
                        errorMsg = ev.message;
                    } else if (ev.type === 'api_log') {
                        window.apiHandler?.addBackendLog?.(ev.log);
                    }
                });
            } catch (e) {
                if (this.currentSessionId !== sessionId) return;
                if (e.name === 'AbortError' && this._stopped) {
                    // Stop: the cancel call's answer says what the server kept.
                    const result = await this._stopped;
                    this._stopped = null;
                    this._setGenerating(false);
                    await this._reload();
                    if (result && result.deleted) this._pendingNotice = 'Stopped before anything was written.';
                    this.renderTray();
                    this._afterLoad(); // stopped before its id arrived: the server may still be writing
                    return;
                }
                if (e.http) {
                    // Refused before anything started (409 already writing, 400 no key…).
                    this._setGenerating(false);
                    await this._reload();
                    if (e.http === 409) { this._afterLoad(); return; }
                    this._pendingNotice = e.message;
                    this.renderTray();
                    if (this._lastAction()?.role !== 'user') this._notice(e.message);
                    return;
                }
                // Dropped or stalled: the server carries on; fetch the beat from it.
                this._setGenerating(false);
                if (actionId) {
                    this._recoverBeat(actionId, beatEl);
                } else {
                    await this._reload();
                    this._afterLoad();
                }
                return;
            }
            if (this.currentSessionId !== sessionId) return;
            this._setGenerating(false);

            if (!final) {
                // The stream ended without the final event: trust the server.
                await this._reload();
                this._afterLoad();
                return;
            }
            // Bring the local copy in line with what the server stored.
            const acts = this.session.actions;
            if (body.kind === 'regen') {
                const last = acts[acts.length - 1];
                if (last && last.role === 'assistant') acts.pop();
            }
            if (userActionId) {
                acts.push({ id: userActionId, role: 'user', content: body.content, roll: roll ? JSON.stringify(roll) : '', order_index: this._nextIndex() });
                if (pickEl) pickEl.dataset.actionId = userActionId;
            }
            if (final.deleted) {
                beatEl.remove();
                this._pendingNotice = errorMsg ? `The narrator hit a problem: ${errorMsg}` : 'Nothing came back for that beat.';
                if (!userActionId && acts[acts.length - 1]?.role !== 'user') {
                    this.renderTray();
                    this._notice(this._pendingNotice, [['🔄 Try again', () => this.runBeat({ role: 'system', kind: 'retry' })]]);
                    this._pendingNotice = null;
                    return;
                }
                this.renderTray();
                return;
            }
            const prevLatest = acts.filter((a) => a.role === 'assistant' && a.content).pop();
            const action = {
                id: final.action_id, role: 'assistant', content: final.story, options: JSON.stringify(final.options || []),
                is_summarized: false, has_image: false, order_index: this._nextIndex(),
            };
            acts.push(action);
            const isFirst = !acts.some((a) => a.role === 'assistant' && a.content && a !== action);
            beatEl.replaceWith(this._buildBeat(action, true, true));
            if (prevLatest) this._refreshBeat(prevLatest); // its Redo/Undo belong to the new beat now
            if (isFirst) this.render(); else this.renderTray();
            if (errorMsg) this._notice(`The narrator hit a problem partway: ${errorMsg}`);
        }

        /** Rebuild one beat's element, keeping a picture that has already loaded. */
        _refreshBeat(action) {
            const old = this.storyArea.querySelector(`.adv-beat[data-action-id="${CSS.escape(action.id)}"]`);
            if (!old) return;
            const fresh = this._buildBeat({ ...action, has_image: false }, false, false);
            const oldImg = old.querySelector('.adv-beat-image');
            if (oldImg) fresh.querySelector('.adv-beat-image').replaceWith(oldImg);
            old.replaceWith(fresh);
        }

        _nextIndex() {
            const acts = this.session.actions;
            return acts.length ? Math.max(...acts.map((a) => a.order_index ?? 0)) + 1 : 0;
        }

        _setStatusOnce(text) {
            if (this._statusShown === text) return;
            this._statusShown = text;
            this._setStatus(text);
        }

        /** The streamed text minus reasoning still in progress and the choices. Null: nothing to show yet. */
        _displayText(text) {
            const open = text.search(/<think>/i);
            const close = text.search(/<\/think>/i);
            let shown = text;
            if (open >= 0 && close < 0) {
                shown = text.slice(0, open);
                if (!shown.trim()) return null;
            }
            const from = Math.max(close, 0);
            const markers = [/\n[ \t>*_#-]*\[?\s*option\s*1\b/i, /<options>/i, /\n[ \t*_]*(?:choices|options|what happens next)[*_:\s?]*\n/i];
            let cut = shown.length;
            markers.forEach((re) => {
                const m = shown.slice(from).search(re);
                if (m >= 0) cut = Math.min(cut, from + m);
            });
            return shown.slice(0, cut);
        }

        /**
         * Keep a new beat readable from its top: scroll it into view, follow the
         * text as it grows only until its start reaches the top bar, and stop
         * following as soon as the reader scrolls themselves.
         */
        _startFollow(anchorEl) {
            const barH = () => (this.playView.querySelector('.adv-topbar')?.offsetHeight || 56) + 8;
            const top = anchorEl.getBoundingClientRect().top + window.scrollY - barH();
            if (top > window.scrollY) window.scrollTo(0, Math.max(0, top - window.innerHeight * 0.3));
            let lastY = window.scrollY;
            let following = true;
            return () => {
                if (!following) return;
                if (window.scrollY < lastY - 40) { following = false; return; } // the reader scrolled up
                const startTop = anchorEl.getBoundingClientRect().top;
                if (startTop <= barH()) { following = false; return; }
                const trayTop = this.tray.getBoundingClientRect().top;
                const beatBottom = this.storyArea.lastElementChild?.getBoundingClientRect().bottom || 0;
                const over = beatBottom - trayTop + 12;
                if (over > 0) window.scrollBy(0, Math.min(over, startTop - barH()));
                lastY = window.scrollY;
            };
        }

        /**
         * Read an /api/sw SSE stream, calling onEvent(data) for each event.
         * 45 s without a byte counts as a dropped connection: the read is
         * aborted and a StreamStall thrown. Time hidden or asleep doesn't count
         * (iOS freezes timers while locked and fires the late ones on wake).
         */
        async _readStream(res, controller, getActionId, onEvent) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let lastByteAt = Date.now();
            let lastTick = Date.now();
            let stalled = false;
            const stall = () => { if (!stalled) { stalled = true; controller.abort(); } };
            const watchdog = setInterval(() => {
                const now = Date.now();
                const late = now - lastTick > 15000;
                lastTick = now;
                if (document.visibilityState !== 'visible' || late) { lastByteAt = now; return; }
                if (now - lastByteAt > STALL_MS) stall();
            }, 5000);
            // For syncOnWake: after a long sleep, ask whether the beat already
            // finished rather than waiting out the watchdog.
            this.live = {
                lastByteAt: () => lastByteAt,
                checkServer: async () => {
                    const id = getActionId();
                    if (!id) return;
                    try {
                        const r = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}`);
                        if (!r.ok) return;
                        const d = await r.json();
                        const a = (d.actions || []).find((x) => x.id === id);
                        if (!a || a.content) stall();
                    } catch (_) { /* offline for a moment */ }
                },
            };
            try {
                while (true) {
                    let result;
                    try {
                        result = await reader.read();
                    } catch (e) {
                        if (stalled) throw Object.assign(new Error('Beat stream stalled'), { name: 'StreamStall' });
                        throw e;
                    }
                    if (result.done) break;
                    lastByteAt = Date.now();
                    buffer += decoder.decode(result.value, { stream: true });
                    const events = buffer.split('\n\n');
                    buffer = events.pop();
                    for (const ev of events) {
                        if (!ev.startsWith('data: ')) continue; // `: ping` keep-alives
                        let data;
                        try { data = JSON.parse(ev.slice(6)); } catch (_) { continue; }
                        if (data.type === 'done') return;
                        onEvent(data);
                    }
                }
            } finally {
                clearInterval(watchdog);
                this.live = null;
            }
        }

        /**
         * The beat's stream dropped (phone locked, network change) or stalled,
         * or the page found it still being written. The server finishes and
         * saves it, so poll for that one action.
         */
        async _recoverBeat(actionId, beatEl) {
            const sessionId = this.currentSessionId;
            const token = {};
            this._recovering = token;
            this.isGenerating = true;
            this.choicesEl.innerHTML = '';
            this._showOwn(false);
            this._clearNotice();
            this._setStatus(beatEl ? 'Connection dropped. Fetching the beat…' : 'The narrator is still writing…');
            this.stopBtn.hidden = false;
            this._liveActionId = actionId;
            const started = Date.now();
            let outcome = 'timeout';
            while (this._recovering === token && this.currentSessionId === sessionId && Date.now() - started < RECOVER_GIVE_UP_MS) {
                try {
                    const r = await window.authFetch(`/api/sw/adventures/${sessionId}`);
                    if (r.ok) {
                        const d = await r.json();
                        const a = (d.actions || []).find((x) => x.id === actionId);
                        if (!a || a.content) { outcome = a ? 'done' : 'gone'; break; }
                    }
                } catch (_) { /* offline for a moment: keep trying */ }
                await new Promise((res) => setTimeout(res, RECOVER_POLL_MS));
            }
            const ours = this._recovering === token;
            if (ours) this._recovering = null;
            if (this.currentSessionId !== sessionId) return;
            if (!ours) return; // Stop pressed: stopGeneration handles it
            this._liveActionId = null;
            this.isGenerating = false;
            this._setStatus(null);
            if (outcome === 'timeout') {
                beatEl?.remove();
                this._notice('The beat hasn’t arrived yet.', [['Reload', () => this.openSession(sessionId)]]);
                return;
            }
            await this._reload();
            if (outcome === 'gone') this._pendingNotice = 'That beat didn’t make it.';
            this.renderTray();
            const lastBeat = this.storyArea.querySelector('.adv-beat.is-latest');
            lastBeat?.scrollIntoView({ block: 'start' });
        }

        async _reload() {
            const id = this.currentSessionId;
            if (!id) return;
            try {
                const r = await window.authFetch(`/api/sw/adventures/${id}`);
                if (!r.ok) return;
                const d = await r.json();
                if (this.currentSessionId !== id) return;
                this.session = d;
                this._showTitle(d.title);
                this.render();
            } catch (e) {
                console.warn('[Adventure] reload failed', e);
            }
        }

        stopGeneration() {
            const actionId = this._liveActionId;
            const sessionId = this.currentSessionId;
            if (this._recovering) {
                // Stop while fetching a dropped beat: cancel on the server and redraw.
                this._recovering = null;
                this._liveActionId = null;
                this.isGenerating = false;
                this._setStatus(null);
                const id = actionId;
                (id ? this._cancel(sessionId, id) : Promise.resolve(null)).then(async (result) => {
                    await this._reload();
                    if (result?.deleted) { this._pendingNotice = 'Stopped before anything was written.'; this.renderTray(); }
                });
                return;
            }
            if (!this._abort) return;
            this.stopBtn.hidden = true;
            this._stopped = this._streamActionId ? this._cancel(sessionId, this._streamActionId) : Promise.resolve(null);
            this._abort.abort();
            this._abort = null;
        }

        async _cancel(sessionId, actionId) {
            try {
                const r = await window.authFetch(`/api/sw/adventures/${sessionId}/actions/${actionId}/cancel`, { method: 'POST' });
                return r.ok ? r.json() : null;
            } catch (e) {
                console.warn('[Adventure] cancel failed', e);
                return null;
            }
        }

        async syncOnWake() {
            if (document.visibilityState !== 'visible') return;
            if (!this.currentSessionId || this.playView.style.display === 'none') return;
            // A beat streaming here is left alone; the watchdog handles a dead
            // connection. After a long sleep, ask whether it already finished.
            if (this.live) {
                if (Date.now() - this.live.lastByteAt() > 20000) this.live.checkServer();
                return;
            }
            if (this._recovering || this.isGenerating) return;
            try {
                const r = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}`);
                if (!r.ok) return;
                const d = await r.json();
                const here = (this.session.actions || []).map((a) => `${a.id}:${(a.content || '').length}:${a.options}`).join('|');
                const there = (d.actions || []).map((a) => `${a.id}:${(a.content || '').length}:${a.options}`).join('|');
                if (here !== there || d.title !== this.session.title) {
                    // Changed on another device, or a beat is being written there.
                    const y = window.scrollY;
                    this.session = d;
                    this._showTitle(d.title);
                    this.render();
                    window.scrollTo(0, y);
                    this._afterLoad();
                }
            } catch (e) {
                console.warn('[Adventure] syncOnWake failed', e);
            }
        }

        async regenerate(action) {
            if (this.isGenerating) return;
            if (!confirm('Write this beat again? The current version will be replaced.')) return;
            this.runBeat({ role: 'system', kind: 'regen', previous_reply: stripThink(action.content).slice(0, 1500) });
        }

        async rewindTo(actionId, ask) {
            if (this.isGenerating) return;
            if (ask && !confirm('Go back to this point? Everything after it will be removed.')) return;
            try {
                const r = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}/rewind/${actionId}`, { method: 'POST' });
                if (!r.ok) throw new Error(await this._errorText(r));
                this.session = await r.json();
                this.render();
                const el = this.storyArea.querySelector(`.adv-beat[data-action-id="${CSS.escape(actionId)}"]`);
                el?.scrollIntoView({ block: 'start' });
            } catch (e) {
                alert(`Couldn’t go back: ${e.message}`);
            }
        }

        async newOptions(button) {
            const last = this._lastAction();
            if (!last || this.isGenerating) return;
            button.disabled = true;
            const label = button.textContent;
            button.textContent = '🎲 Thinking…';
            try {
                const ev = await this._utilityCall(`/api/sw/adventures/${this.currentSessionId}/actions/${last.id}/options`, this._genOptions(), 'options');
                last.options = JSON.stringify(ev.options);
                this.renderTray();
            } catch (e) {
                button.disabled = false;
                button.textContent = label;
                this._notice(`Couldn’t get new options: ${e.message}`);
            }
        }

        /** POST a short utility call that streams one result event (keeps iOS from cutting it at 60 s). */
        async _utilityCall(url, body, type) {
            const controller = new AbortController();
            const res = await window.authFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(await this._errorText(res));
            let result = null;
            let error = null;
            const keepLive = this.live;
            try {
                await this._readStream(res, controller, () => null, (ev) => {
                    if (ev.type === type) result = ev;
                    else if (ev.type === 'error') error = ev.message;
                });
            } catch (e) {
                throw new Error(e.name === 'StreamStall' || e.name === 'AbortError' ? 'the connection dropped, try again' : e.message);
            } finally {
                this.live = keepLive;
            }
            if (error) throw new Error(error);
            if (!result) throw new Error('nothing came back, try again');
            return result;
        }

        async _errorText(res) {
            try {
                const j = await res.json();
                return j.detail || j.error || `HTTP ${res.status}`;
            } catch (_) {
                return `HTTP ${res.status}`;
            }
        }

        // ── Beat actions: read aloud, edit, picture ──────────────────────────

        readAloud(action, el) {
            if (typeof TTSPlayer === 'undefined') { alert('Narration isn’t available.'); return; }
            this._stopReading();
            const val = (id, d = '') => document.getElementById(id)?.value || d;
            const player = new TTSPlayer();
            player.voice = val('sw-tts-voice', 'p230');
            player.speed = parseFloat(val('sw-tts-speed', '1.0'));
            player.setVolume(parseInt(val('sw-tts-volume', '80'), 10));
            player.provider = val('sw-tts-provider', 'kokoro');
            player.googleApiKey = val('sw-tts-google-key');
            player.nanogptKey = val('sw-tts-nanogpt-key');
            player.nanogptModel = val('sw-tts-nanogpt-model');
            player.nanogptVoice = val('sw-tts-nanogpt-voice');
            player.onQueueEmpty = () => this._stopReading();
            player.onError = (msg) => console.warn('[Adventure] narration:', msg);
            const plain = stripThink(action.content);
            if (typeof SentenceDetector !== 'undefined') {
                const d = new SentenceDetector();
                [...d.feed(plain + '\n'), ...d.flush()].forEach((s) => player.enqueue(s, player.voice));
            } else {
                plain.split(/(?<=[.!?…])\s+/).forEach((s) => s.trim() && player.enqueue(s, player.voice));
            }
            this._player = player;
            this._playingEl = el;
            el.classList.add('is-playing');
            this.playerEl.hidden = false;
            document.getElementById('adv-player-pause').textContent = '⏸ Pause';
        }

        _togglePause() {
            const p = this._player;
            if (!p) return;
            const btn = document.getElementById('adv-player-pause');
            if (p.paused) { p.resume(); btn.textContent = '⏸ Pause'; } else { p.pause(); btn.textContent = '▶ Resume'; }
        }

        _stopReading() {
            if (this._player) { try { this._player.stop(); } catch (_) {} }
            this._player = null;
            this._playingEl?.classList.remove('is-playing');
            this._playingEl = null;
            if (this.playerEl) this.playerEl.hidden = true;
        }

        openEditor(action) {
            const sheet = this._makeSheet(`
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-label="Edit beat">
                    <div class="adv-edit-head">
                        <button type="button" class="btn-small btn-outline" data-act="cancel">Cancel</button>
                        <h2>Edit beat</h2>
                        <button type="button" class="btn-small" data-act="save">Save</button>
                    </div>
                    <div class="adv-edit-error"></div>
                    <textarea class="adv-edit-text" aria-label="Beat text"></textarea>
                </div>`);
            const ta = sheet.querySelector('textarea');
            const original = stripThink(action.content);
            ta.value = original;
            const close = () => this._closeSheet(sheet);
            sheet.querySelector('[data-act="cancel"]').addEventListener('click', () => {
                if (ta.value !== original && !confirm('Discard your changes?')) return;
                close();
            });
            sheet.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = 'Saving…';
                try {
                    const r = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}/actions/${action.id}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: ta.value }),
                    });
                    if (!r.ok) throw new Error(await this._errorText(r));
                    const updated = await r.json();
                    action.content = updated.content;
                    const el = this.storyArea.querySelector(`.adv-beat[data-action-id="${CSS.escape(action.id)}"] .adv-beat-text`);
                    if (el) el.innerHTML = this.formatStory(updated.content);
                    close();
                } catch (err) {
                    sheet.querySelector('.adv-edit-error').textContent = `Couldn’t save: ${err.message}`;
                    btn.disabled = false;
                    btn.textContent = 'Save';
                }
            });
            this._openSheet(sheet);
            ta.focus();
            ta.setSelectionRange(0, 0);
        }

        async _loadImage(action, box) {
            try {
                const r = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}/actions/${action.id}/image`);
                if (!r.ok) return;
                const { image, prompt } = await r.json();
                this._showImage(box, image, prompt);
            } catch (_) { /* leave it hidden */ }
        }

        _showImage(box, url, prompt) {
            box.innerHTML = '';
            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Scene picture';
            img.dataset.prompt = prompt || '';
            box.appendChild(img);
            if (prompt) {
                const p = document.createElement('span');
                p.className = 'adv-image-prompt';
                p.textContent = prompt;
                box.appendChild(p);
            }
            box.hidden = false;
        }

        async drawPicture(action, box, btn) {
            if (!window.apiHandler?.generateImage) { alert('Set up an Image API in ⚙️ API Settings first.'); return; }
            const setLabel = (icon, label) => { btn.innerHTML = `<span aria-hidden="true">${icon}</span><span class="adv-act-label">${label}</span>`; };
            btn.disabled = true;
            setLabel('⏳', 'Drawing…');
            const before = box.innerHTML;
            box.hidden = false;
            box.insertAdjacentHTML('beforeend', '<span class="adv-image-note">Writing the picture prompt…</span>');
            const note = box.lastElementChild;
            try {
                const { prompt } = await this._utilityCall(`/api/sw/adventures/${this.currentSessionId}/actions/${action.id}/image-prompt`, {}, 'prompt');
                note.textContent = 'Drawing…';
                const model = document.getElementById('sw-image-model')?.value || null;
                const url = await window.apiHandler.generateImage(null, null, prompt, model);
                await window.authFetch(`/api/sw/adventures/${this.currentSessionId}/actions/${action.id}/image`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: url, prompt }),
                }).then(async (r) => { if (!r.ok) throw new Error(await this._errorText(r)); });
                action.has_image = true;
                this._showImage(box, url, prompt);
                setLabel('🎨', 'Redraw');
            } catch (e) {
                box.innerHTML = before;
                box.insertAdjacentHTML('beforeend', `<span class="adv-image-note adv-image-error">Picture failed: ${esc(e.message)}</span>`);
                setLabel('🎨', action.has_image ? 'Redraw' : 'Picture');
            } finally {
                btn.disabled = false;
            }
        }

        // ── Sheets: rename, cast ─────────────────────────────────────────────

        _makeSheet(inner) {
            const sheet = document.createElement('div');
            sheet.className = 'pb-overlay adv-sheet';
            sheet.hidden = true;
            sheet.innerHTML = inner;
            sheet.addEventListener('click', (e) => { if (e.target === sheet) this._closeSheet(sheet); });
            sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closeSheet(sheet); });
            sheet.querySelectorAll('[data-sheet-close]').forEach((b) => b.addEventListener('click', () => this._closeSheet(sheet)));
            document.body.appendChild(sheet);
            return sheet;
        }

        _openSheet(sheet) {
            this.closePopovers();
            sheet.hidden = false;
            document.documentElement.classList.add('saw-open');
        }

        _closeSheet(sheet) {
            sheet.remove();
            if (!document.querySelector('.adv-sheet:not([hidden]), #adv-new-modal:not([hidden])')) {
                document.documentElement.classList.remove('saw-open');
            }
        }

        _simpleSheet(title, bodyHtml, footerHtml = '') {
            return this._makeSheet(`
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
                    <div class="pb-scroll">
                        <div class="pb-head"><h2>${esc(title)}</h2><button type="button" class="adv-sheet-x" data-sheet-close aria-label="Close">✕</button></div>
                        ${bodyHtml}
                    </div>
                    ${footerHtml ? `<div class="pb-footer">${footerHtml}</div>` : ''}
                </div>`);
        }

        openRename() {
            if (!this.session) return;
            const sheet = this._simpleSheet('✏️ Rename', `
                <section class="pb-panel">
                    <label class="pb-label" for="adv-rename-input">Title</label>
                    <input type="text" id="adv-rename-input" class="input pb-input" maxlength="200" enterkeyhint="done">
                    <div class="pb-error" hidden></div>
                </section>`, '<button type="button" class="btn-primary pb-wide" data-act="save">Save</button>');
            const input = sheet.querySelector('input');
            input.value = this.session.title || '';
            const save = async () => {
                const title = input.value.trim();
                if (!title) return;
                try {
                    const r = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
                    });
                    if (!r.ok) throw new Error(await this._errorText(r));
                    this._showTitle(title);
                    this.session.title_auto = false;
                    this._closeSheet(sheet);
                } catch (e) {
                    const err = sheet.querySelector('.pb-error');
                    err.textContent = `Couldn’t rename: ${e.message}`;
                    err.hidden = false;
                }
            };
            sheet.querySelector('[data-act="save"]').addEventListener('click', save);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
            this._openSheet(sheet);
            input.focus();
            input.select();
        }

        openCast() {
            const chars = this.session?.characters || [];
            const sheet = this._simpleSheet('🃏 Cast', `<section class="pb-panel"><div class="adv-cast-list"></div>
                <p class="pb-hint">${chars.length ? 'The narrator plays all of them, and the world around them.' : 'No cards in this one: the narrator makes up the cast.'}</p></section>`);
            const list = sheet.querySelector('.adv-cast-list');
            chars.forEach((c) => {
                const row = document.createElement('div');
                row.className = 'adv-cast-row';
                row.appendChild(this._avatar(c));
                const name = document.createElement('div');
                name.innerHTML = `<b>${esc(c.name)}</b>`;
                row.appendChild(name);
                list.appendChild(row);
            });
            this._openSheet(sheet);
        }

        // ── Aa and ⋯ ─────────────────────────────────────────────────────────

        _bindPopover(btnId, popId) {
            const btn = document.getElementById(btnId);
            const pop = document.getElementById(popId);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = pop.hidden;
                this.closePopovers();
                pop.hidden = !open;
                btn.setAttribute('aria-expanded', String(open));
            });
        }

        closePopovers() {
            ['adv-aa', 'adv-more'].forEach((p) => {
                const pop = document.getElementById(`${p}-pop`);
                if (pop) pop.hidden = true;
                document.getElementById(`${p}-btn`)?.setAttribute('aria-expanded', 'false');
            });
        }

        _applyPrefs() {
            const root = document.documentElement.style;
            root.setProperty('--sw-text-scale', String(SIZES[this.prefs.size]));
            root.setProperty('--sw-text-leading', String(SPACING[this.prefs.spacing]));
            root.setProperty('--sw-text-font', FONTS[this.prefs.font]);
            const pop = document.getElementById('adv-aa-pop');
            if (!pop) return;
            pop.querySelectorAll('[data-reader-font]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.readerFont === this.prefs.font)));
            pop.querySelectorAll('[data-reader-spacing]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.readerSpacing === this.prefs.spacing)));
            pop.querySelector('[data-size-label]').textContent = `${Math.round(SIZES[this.prefs.size] * 100)}%`;
            pop.querySelector('[data-reader-size="-1"]').disabled = this.prefs.size === 0;
            pop.querySelector('[data-reader-size="1"]').disabled = this.prefs.size === SIZES.length - 1;
        }

        _setPref(key, value) {
            // Keep the beat at the top of the screen in place while the text reflows.
            const barH = (this.playView.querySelector('.adv-topbar')?.offsetHeight || 56);
            const anchor = [...this.storyArea.querySelectorAll('.adv-beat, .adv-pick')].find((el) => el.getBoundingClientRect().bottom > barH);
            const offset = anchor ? anchor.getBoundingClientRect().top : 0;
            this.prefs = { ...loadPrefs(), [key]: value };
            try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch (_) { /* private mode */ }
            this._applyPrefs();
            // Story Writer's reader keeps its own copy; bring it along.
            const reader = window.storyWriterApp?.reader;
            if (reader?.prefs) { reader.prefs = { ...this.prefs }; reader._applyPrefs?.(); }
            if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - offset);
        }

        // ── Formatting ───────────────────────────────────────────────────────

        escapeHtml(s) { return esc(s); }

        /**
         * Story text to HTML. The reasoning block becomes the collapsed
         * "thinking" element; everything else is escaped before the light
         * markdown, so nothing the model writes reaches the page as live HTML.
         */
        formatStory(text) {
            if (!text) return '';
            let parsed = String(text).replace(/＜/g, '<').replace(/＞/g, '>');
            if (parsed.includes('</think>') && !parsed.includes('<think>')) parsed = '<think>\n' + parsed;
            if (parsed.includes('<think>') && !parsed.includes('</think>')) parsed = parsed.replace(/<think>/gi, '');
            const thinks = [];
            parsed = parsed.replace(/<think>[\s\S]*?<\/think>/gi, (m) => { thinks.push(m); return `%%ADV_THINK_${thinks.length - 1}%%`; });
            parsed = parsed.replace(/<\/?think>/gi, '');
            parsed = esc(parsed.trim());
            parsed = parsed.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
            parsed = parsed.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
            parsed = parsed.replace(/&quot;([^\n]*?)&quot;/g, '<span class="adv-q">&quot;$1&quot;</span>');
            parsed = parsed.replace(/“([^\n]*?)”/g, '<span class="adv-q">&ldquo;$1&rdquo;</span>');
            parsed = parsed.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
            let html = parsed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
                .map((p) => (/^%%ADV_THINK_\d+%%$/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('');
            html = html.replace(/%%ADV_THINK_(\d+)%%/g, (m, i) => {
                const block = thinks[Number(i)];
                return window.RichElementParser
                    ? window.RichElementParser.parse(block).replace(">Character's Thoughts<", ">Narrator’s plan<")
                    : '';
            });
            return html;
        }

        // ── Global settings (⚙️) ─────────────────────────────────────────────

        injectSettingsModal() {
            if (document.getElementById('adv-global-settings-modal')) return;
            const modal = document.createElement('div');
            modal.id = 'adv-global-settings-modal';
            modal.className = 'pb-overlay adv-sheet adv-settings';
            modal.hidden = true;
            modal.innerHTML = `
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-labelledby="adv-settings-heading">
                    <div class="pb-scroll">
                        <div class="pb-head">
                            <h2 id="adv-settings-heading">⚙️ Adventure settings</h2>
                            <button type="button" id="adv-global-settings-close" class="adv-sheet-x" aria-label="Close">✕</button>
                        </div>
                        <section class="pb-panel">
                            <label class="pb-label" for="adv-global-max-input">Context window <span class="pb-soft">(tokens of story the narrator sees)</span></label>
                            <input type="number" inputmode="numeric" id="adv-global-max-input" class="input pb-input" min="1024" step="1024">
                            <label class="pb-label" for="adv-global-rep-penalty">Repetition penalty</label>
                            <input type="number" inputmode="decimal" step="0.05" id="adv-global-rep-penalty" class="input pb-input">
                            <label class="adv-check"><input type="checkbox" id="adv-global-enable-cot" checked> <span>Let the narrator plan before it writes (reasoning)</span></label>
                        </section>
                        <section class="pb-panel">
                            <div class="pb-label">Default system prompt</div>
                            <p class="pb-hint">These pieces are joined to make the starting system prompt of a new adventure. Drag to reorder.</p>
                            <div id="adv-global-prompt-segments" class="adv-segments"></div>
                            <textarea id="adv-global-new-segment" class="input pb-input" rows="3" placeholder="New prompt piece…"></textarea>
                            <button type="button" id="adv-global-add-segment" class="btn-outline btn-small" style="align-self:flex-start">＋ Add piece</button>
                        </section>
                    </div>
                    <div class="pb-footer"><button type="button" id="adv-global-save-btn" class="btn-primary pb-wide">Save settings</button></div>
                </div>`;
            document.body.appendChild(modal);
            document.getElementById('adv-open-global-settings')?.addEventListener('click', () => this.openGlobalSettings());
            const close = () => { modal.hidden = true; if (!document.querySelector('.adv-sheet:not([hidden]):not(#adv-global-settings-modal), #adv-new-modal:not([hidden])')) document.documentElement.classList.remove('saw-open'); };
            this._closeGlobalSettings = close;
            document.getElementById('adv-global-settings-close').addEventListener('click', close);
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
            document.getElementById('adv-global-save-btn').addEventListener('click', () => this.saveGlobalSettings());
            document.getElementById('adv-global-add-segment').addEventListener('click', () => this.addSystemPromptSegment());
            document.getElementById('adv-global-new-segment').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); this.addSystemPromptSegment(); }
            });
        }

        openGlobalSettings() {
            if (!window.config) return;
            this.closePopovers();
            this.systemPromptSegments = [...(window.config.get('adventure.systemPromptSegments') || [])];
            this.renderSystemPromptSegments();
            document.getElementById('adv-global-max-input').value = window.config.get('adventure.maxInputTokens') ?? 8192;
            document.getElementById('adv-global-rep-penalty').value = window.config.get('adventure.repetitionPenalty') ?? 1.0;
            document.getElementById('adv-global-enable-cot').checked = window.config.get('adventure.enableCot') !== false;
            document.getElementById('adv-global-settings-modal').hidden = false;
            document.documentElement.classList.add('saw-open');
        }

        renderSystemPromptSegments() {
            const container = document.getElementById('adv-global-prompt-segments');
            if (!container) return;
            container.innerHTML = '';
            this.systemPromptSegments.forEach((seg, i) => {
                const row = document.createElement('div');
                row.className = 'adv-segment';
                row.draggable = true;
                const handle = document.createElement('div');
                handle.className = 'adv-segment-handle';
                handle.textContent = '☰';
                row.addEventListener('dragstart', (e) => {
                    this.draggedSegmentIndex = i;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', i);
                    setTimeout(() => { row.style.opacity = '0.4'; }, 0);
                });
                row.addEventListener('dragend', () => {
                    row.style.opacity = '1';
                    this.draggedSegmentIndex = null;
                    Array.from(container.children).forEach((r) => { r.style.boxShadow = ''; });
                });
                row.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    if (this.draggedSegmentIndex !== null && this.draggedSegmentIndex !== i) {
                        row.style.boxShadow = this.draggedSegmentIndex < i ? '0 2px 0 var(--accent)' : '0 -2px 0 var(--accent)';
                    }
                });
                row.addEventListener('dragleave', () => { row.style.boxShadow = ''; });
                row.addEventListener('drop', (e) => {
                    e.preventDefault();
                    row.style.boxShadow = '';
                    if (this.draggedSegmentIndex !== null && this.draggedSegmentIndex !== i) {
                        const moved = this.systemPromptSegments.splice(this.draggedSegmentIndex, 1)[0];
                        this.systemPromptSegments.splice(i, 0, moved);
                        this.renderSystemPromptSegments();
                    }
                });
                const input = document.createElement('textarea');
                input.className = 'adv-segment-text';
                input.value = seg;
                input.addEventListener('input', () => {
                    this.systemPromptSegments[i] = input.value;
                    input.style.height = 'auto';
                    input.style.height = `${input.scrollHeight}px`;
                });
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'adv-segment-del';
                del.textContent = '🗑️';
                del.setAttribute('aria-label', 'Delete this piece');
                del.addEventListener('click', () => {
                    this.systemPromptSegments.splice(i, 1);
                    this.renderSystemPromptSegments();
                });
                row.append(handle, input, del);
                container.appendChild(row);
                setTimeout(() => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; }, 0);
            });
        }

        addSystemPromptSegment() {
            const box = document.getElementById('adv-global-new-segment');
            const val = box.value.trim();
            if (!val) return;
            this.systemPromptSegments.push(val);
            box.value = '';
            this.renderSystemPromptSegments();
        }

        saveGlobalSettings() {
            if (!window.config) return;
            window.config.set('adventure.systemPromptSegments', this.systemPromptSegments);
            const maxInput = parseInt(document.getElementById('adv-global-max-input').value, 10);
            const rep = parseFloat(document.getElementById('adv-global-rep-penalty').value);
            window.config.set('adventure.maxInputTokens', Number.isFinite(maxInput) && maxInput > 0 ? maxInput : 8192);
            window.config.set('adventure.repetitionPenalty', Number.isFinite(rep) && rep > 0 ? rep : 1.0);
            window.config.set('adventure.enableCot', document.getElementById('adv-global-enable-cot').checked);
            this._closeGlobalSettings();
            if (this.systemPrompt && !this.newModal.hidden) this.systemPrompt.value = this.systemPromptSegments.join('\n\n');
            window.app?.showNotification?.('Adventure settings saved', 'success');
        }
    }

    window.AdventureHandler = AdventureHandler;
    window.adventureHandler = null;
    const boot = () => { window.adventureHandler = new AdventureHandler(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();

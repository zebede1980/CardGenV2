/**
 * ✨ Auto-written stories, the Story Writer front end for
 * storywriterbackend/app/services/story_autowriter.py.
 *
 * - The New Story sheet: cards, an optional idea, length, ending, how closely
 *   to follow the cards, and the mode (write it all, or write it with me).
 *   No title needed: the AI names the story.
 * - The run panel in the workspace: progress, the chapter being written as it
 *   arrives, Stop / Resume, a note for the next chapter, and the outline on
 *   request (hidden by default so the story stays a surprise).
 *
 * The writing happens on the server and survives the phone locking. This page
 * only polls, with short GETs, while it is visible: no request here waits on
 * the model, so iOS's 60 s cut can't hit it, and nothing is timed, so a frozen
 * timer can't misfire on wake. A poll that fails is simply tried again later.
 */
(function () {
    const POLL_MS = 2500;
    const PREFS_KEY = 'cardgen.storySetup.v1';

    const LENGTHS = [
        { id: 'short', label: 'Short', sub: '~3,000 words · 4 chapters', time: 'about 5–10 min' },
        { id: 'medium', label: 'Medium', sub: '~8,000 words · 7 chapters', time: 'about 10–15 min' },
        { id: 'long', label: 'Long', sub: '~15,000 words · 11 chapters', time: 'about 15–25 min' },
        { id: 'epic', label: 'Epic', sub: '~30,000 words · 18 chapters', time: 'about 25–40 min' },
    ];
    const ENDINGS = [
        ['any', '🎲 AI decides'], ['happy', '😊 Happy'], ['bittersweet', '🌗 Bittersweet'],
        ['dark', '🌑 Dark'], ['twist', '🔀 Twist'],
    ];
    const FAITH = {
        1: ['Faithful', "The card's own scenario; everyone acts exactly as written; no big new characters."],
        2: ['Close', 'Starts from the card’s scenario; a few new places and people; one surprise.'],
        3: ['Balanced', 'The characters stay themselves; the plot is new, with one real twist.'],
        4: ['Loose', 'Names, looks and nature kept; setting and genre may change; several twists.'],
        5: ['Off the rails', 'Only who they are at heart is kept. Anything else goes.'],
    };

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { return {}; }
    }
    function savePrefs(p) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* private mode */ }
    }

    async function postJson(path, body) {
        const res = await window.authFetch(`/api/sw${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || data.error || `Request failed (${res.status})`);
        return data;
    }

    class StoryAutowriter {
        constructor(app) {
            this.app = app;
            this.storyId = null;
            this.status = null;
            this.partial = '';
            this.chaptersSeen = 0;
            this.pollTimer = null;
            this.polling = false;
            this.failures = 0;
            this.holdingWakeLock = false;
            this.picked = [];
            this.allCards = [];
            this.busy = false;

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && this.isLive()) this.poll();
            });
        }

        isLive() {
            return !!this.status && ['planning', 'writing'].includes(this.status.status);
        }

        // ── New Story sheet ──────────────────────────────────────────────────

        /** `cards`: [{ id, name }] to start with, e.g. from a home-screen tile's 📖 Story. */
        async openSetup({ cards = [] } = {}) {
            const prefs = loadPrefs();
            this.form = {
                length: prefs.length || 'medium',
                ending: prefs.ending || 'any',
                faithfulness: prefs.faithfulness || 3,
            };
            this.picked = cards.filter((c) => c && c.id != null).map((c) => ({ id: c.id, name: c.name }));
            this._buildSheet();
            this.sheet.hidden = false;
            document.documentElement.classList.add('saw-open');
            this._renderSheet();
            this._renderPicked();
            this.allCards = await this.app.apiCall('/cards/').catch(() => []);
            // Swap in the full card objects so the picker's "already taken" check matches them.
            this.picked = this.picked.map((p) => this.allCards.find((c) => String(c.id) === String(p.id)) || p);
            this._renderPicked();
        }

        closeSetup() {
            if (!this.sheet) return;
            this.sheet.hidden = true;
            document.documentElement.classList.remove('saw-open');
        }

        _buildSheet() {
            if (this.sheet) return;
            const el = document.createElement('div');
            el.id = 'sw-setup-sheet';
            el.className = 'pb-overlay';
            el.hidden = true;
            el.innerHTML = `
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-labelledby="saw-title">
                    <div class="pb-scroll">
                        <div class="pb-head">
                            <h2 id="saw-title">✨ New story</h2>
                            <button type="button" class="saw-icon" data-act="close" aria-label="Close">✕</button>
                        </div>
                        <section class="pb-panel">
                            <span class="pb-label">Characters</span>
                            <div class="saw-picked" data-el="picked"></div>
                            <div class="pb-row">
                                <button type="button" class="btn-small btn-outline" data-act="add-card">＋ Add a character</button>
                            </div>
                        </section>
                        <section class="pb-panel">
                            <label class="pb-label" for="saw-idea">Your idea <span class="pb-soft">(optional)</span></label>
                            <textarea id="saw-idea" class="textarea pb-input" rows="3" maxlength="2000"
                                placeholder="Leave empty and the AI invents the story from the characters."></textarea>
                        </section>
                        <section class="pb-panel" data-el="auto-only">
                            <span class="pb-label">Length</span>
                            <div class="saw-lengths" data-el="lengths"></div>
                            <span class="pb-label">Ending</span>
                            <div class="pb-row" data-el="endings"></div>
                            <label class="pb-label" for="saw-faith">How closely to follow the cards</label>
                            <input id="saw-faith" type="range" min="1" max="5" step="1" class="saw-range">
                            <div class="saw-range-labels"><span>Faithful</span><span>Balanced</span><span>Off the rails</span></div>
                            <p class="pb-hint" data-el="faith-hint"></p>
                        </section>
                        <section class="pb-panel">
                            <label class="pb-label" for="saw-title-input">Title <span class="pb-soft">(optional)</span></label>
                            <input id="saw-title-input" type="text" class="input pb-input" maxlength="200"
                                placeholder="Leave empty and the AI names it">
                        </section>
                        <p class="pb-hint" data-el="error" role="alert" style="color: var(--error, #e55);"></p>
                    </div>
                    <div class="pb-footer">
                        <button type="button" class="btn-outline pb-wide" data-act="manual">✍️ Write it with me</button>
                        <button type="button" class="btn-primary pb-wide" data-act="auto">✨ Write the whole story</button>
                    </div>
                </div>`;
            document.body.appendChild(el);
            this.sheet = el;

            el.addEventListener('click', (e) => {
                if (e.target === el) return this.closeSetup();
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (act === 'close') this.closeSetup();
                else if (act === 'add-card') this._pickCard();
                else if (act === 'auto') this._submit('auto');
                else if (act === 'manual') this._submit('manual');
                const len = e.target.closest('[data-length]')?.dataset.length;
                if (len) { this.form.length = len; this._renderSheet(); }
                const end = e.target.closest('[data-ending]')?.dataset.ending;
                if (end) { this.form.ending = end; this._renderSheet(); }
                const drop = e.target.closest('[data-drop]')?.dataset.drop;
                if (drop) { this.picked = this.picked.filter((c) => String(c.id) !== drop); this._renderPicked(); }
            });
            el.querySelector('#saw-faith').addEventListener('input', (e) => {
                this.form.faithfulness = parseInt(e.target.value, 10) || 3;
                this._renderSheet();
            });
            el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeSetup(); });
        }

        _renderSheet() {
            const q = (sel) => this.sheet.querySelector(`[data-el="${sel}"]`);
            q('lengths').innerHTML = LENGTHS.map((l) => `
                <button type="button" class="saw-length" data-length="${l.id}" aria-pressed="${l.id === this.form.length}">
                    <b>${l.label}</b><span>${l.sub}</span><span class="pb-soft">${l.time}</span>
                </button>`).join('');
            q('endings').innerHTML = ENDINGS.map(([id, label]) =>
                `<button type="button" class="saw-chip" data-ending="${id}" aria-pressed="${id === this.form.ending}">${label}</button>`).join('');
            this.sheet.querySelector('#saw-faith').value = String(this.form.faithfulness);
            const [name, text] = FAITH[this.form.faithfulness];
            q('faith-hint').innerHTML = `<b>${name}.</b> ${esc(text)}`;
        }

        _renderPicked() {
            const box = this.sheet?.querySelector('[data-el="picked"]');
            if (!box) return;
            box.innerHTML = this.picked.length
                ? this.picked.map((c) => `<span class="saw-picked-chip">${esc(c.name)}
                    <button type="button" class="saw-drop" data-drop="${c.id}" aria-label="Remove ${esc(c.name)}">✕</button></span>`).join('')
                : '<span class="pb-hint">None yet. Add one or more, or leave it to the AI.</span>';
        }

        _pickCard() {
            const taken = new Set(this.picked.map((c) => c.id));
            const available = this.allCards.filter((c) => !taken.has(c.id));
            if (!window.cardGallery || !available.length) return;
            window.cardGallery.open(available, (cardId) => {
                const card = this.allCards.find((c) => String(c.id) === String(cardId));
                if (card && !this.picked.some((c) => c.id === card.id)) this.picked.push(card);
                this._renderPicked();
            });
        }

        async _submit(mode) {
            if (this.busy) return;  // a double tap would start (and pay for) two stories
            const errorEl = this.sheet.querySelector('[data-el="error"]');
            errorEl.textContent = '';
            const idea = this.sheet.querySelector('#saw-idea').value.trim();
            const title = this.sheet.querySelector('#saw-title-input').value.trim();
            const card_ids = this.picked.map((c) => c.id);
            this._setBusy(true);
            try {
                let story;
                if (mode === 'auto') {
                    savePrefs(this.form);
                    story = await postJson('/stories/autowrite', { title, card_ids, idea, ...this.form });
                } else {
                    story = await postJson('/stories/', { title, synopsis: idea, card_ids });
                }
                this.closeSetup();
                this.sheet.querySelector('#saw-idea').value = '';
                this.sheet.querySelector('#saw-title-input').value = '';
                await this.app.openStory(story.id);
            } catch (e) {
                errorEl.textContent = e.message.toLowerCase().includes('api key')
                    ? '⚠️ ' + e.message + ' Set your API credentials in ⚙️ API Settings first.'
                    : '⚠️ ' + e.message;
            } finally {
                this._setBusy(false);
            }
        }

        _setBusy(busy) {
            this.busy = busy;
            this.sheet.querySelectorAll('.pb-footer button').forEach((b) => { b.disabled = busy; });
            const auto = this.sheet.querySelector('[data-act="auto"]');
            auto.textContent = busy ? '⏳ Starting…' : '✨ Write the whole story';
        }

        // ── Workspace ────────────────────────────────────────────────────────

        /** Called by StoryWriterApp.refreshWorkspace after every load. */
        onStoryLoaded(story) {
            if (story.id !== this.storyId) {
                this._stopPolling();
                this.storyId = story.id;
                this.status = null;
                this.partial = '';
            }
            this.chaptersSeen = Math.max(0, ...story.segments.map((s) => s.chapter || 0));
            this._ensurePanel();
            if (!story.is_autowritten) {
                this.panel.hidden = true;
                this._setManualControls(true);
                return;
            }
            this.panel.hidden = false;
            this._render();
            if (!this.polling) this.poll();
        }

        /** Called by StoryWriterApp.renderSegments, which clears the story area. */
        afterRender() {
            this._renderLive();
        }

        /** Leaving the workspace: stop polling. The run carries on server-side. */
        onLeave() {
            this._stopPolling();
            this.storyId = null;
            this.status = null;
            this.partial = '';
        }

        _ensurePanel() {
            if (this.panel) return;
            const panel = document.createElement('div');
            panel.id = 'sw-auto-panel';
            panel.className = 'saw-panel';
            panel.hidden = true;
            panel.innerHTML = `
                <div class="saw-status" data-el="status" aria-live="polite"></div>
                <div class="saw-progress"><div data-el="bar"></div></div>
                <div class="pb-row">
                    <button type="button" class="btn-small btn-stop" data-act="stop">⏹ Stop</button>
                    <button type="button" class="btn-small btn-primary" data-act="resume">▶ Resume</button>
                    <button type="button" class="btn-small btn-outline" data-act="outline">🗺️ Outline</button>
                </div>
                <div class="saw-steer" data-el="steer">
                    <input type="text" class="input pb-input" maxlength="2000" data-el="steer-input"
                        placeholder="Note for the next chapter">
                    <button type="button" class="btn-small btn-outline" data-act="steer">Add note</button>
                </div>
                <p class="pb-hint" data-el="steer-hint"></p>`;
            const area = document.getElementById('sw-story-area');
            area.parentNode.insertBefore(panel, area);
            panel.addEventListener('click', (e) => {
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (act === 'stop') this.stop();
                else if (act === 'resume') this.resume();
                else if (act === 'outline') this.showOutline();
                else if (act === 'steer') this.steer();
            });
            panel.querySelector('[data-el="steer-input"]').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.steer(); }
            });
            this.panel = panel;
        }

        _schedule(ms) {
            clearTimeout(this.pollTimer);
            this.pollTimer = setTimeout(() => this.poll(), ms);
        }

        _stopPolling() {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
            this.polling = false;
            this._wakeLock(false);
        }

        async poll() {
            const id = this.storyId;
            if (!id || this.app.currentStoryId !== id) return this._stopPolling();
            clearTimeout(this.pollTimer);
            this.polling = true;
            // Hidden: don't poll; the visibilitychange listener restarts it.
            if (document.visibilityState !== 'visible') return;
            let s;
            try {
                s = await this.app.apiCall(`/stories/${id}/autowrite?from=${this.partial.length}`);
                this.failures = 0;
            } catch (e) {
                this.failures += 1;
                return this._schedule(Math.min(15000, POLL_MS * (1 + this.failures)));
            }
            if (this.app.currentStoryId !== id || this.storyId !== id) return;
            this.status = s;
            this.partial = s.partial_from === 0 ? (s.partial || '') : this.partial + (s.partial || '');

            if (s.chapters_done !== this.chaptersSeen) {
                const before = this.chaptersSeen;
                this.chaptersSeen = s.chapters_done;
                this.partial = '';
                await this.app.refreshWorkspace();
                this._queueNarration((this.app.story?.segments || []).filter((seg) => (seg.chapter || 0) > before));
            }
            this._syncTitle(s.title);
            this._render();

            if (this.isLive()) {
                this._wakeLock(true);
                this._schedule(POLL_MS);
            } else {
                this._stopPolling();
                if (s.status === 'done' && this.app.story && !this.app.story.has_outline) this.app.refreshWorkspace();
            }
        }

        _syncTitle(title) {
            const input = document.getElementById('sw-title');
            if (!title || !input || !this.app.story || document.activeElement === input) return;
            if (input.value !== title) input.value = title;
            this.app.story.title = title;
        }

        _wakeLock(on) {
            const wl = window.wakeLockManager;
            if (!wl || on === this.holdingWakeLock) return;
            this.holdingWakeLock = on;
            if (on) wl.acquire();
            else wl.release();
        }

        _setManualControls(show) {
            ['sw-generate-btn', 'sw-steering', 'sw-toolbar-generate-btn'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.style.display = show ? '' : 'none';
            });
        }

        _render() {
            if (!this.panel) return;
            const s = this.status;
            const q = (sel) => this.panel.querySelector(`[data-el="${sel}"]`);
            const btn = (act) => this.panel.querySelector(`[data-act="${act}"]`);
            const live = this.isLive();
            const total = s?.total || 0;
            const done = s?.chapters_done || 0;
            let text = '⏳ Checking…';
            if (s) {
                const c = s.chapter || done + 1;
                text = {
                    planning: '🗺️ Planning the story…',
                    writing: {
                        thinking: `✍️ Chapter ${c} of ${total}: thinking it through…`,
                        writing: `✍️ Writing chapter ${c} of ${total}…`,
                        summarising: `📝 Chapter ${c} of ${total}: making notes…`,
                    }[s.phase] || `✍️ Writing chapter ${c} of ${total}…`,
                    done: `✅ Finished: ${total} chapters.`,
                    stopped: `⏸ Stopped after chapter ${done} of ${total}.`,
                    interrupted: `⚠️ Interrupted after chapter ${done} of ${total} (the server restarted).`,
                    failed: `⚠️ It stopped with an error after chapter ${done}: ${s.error || 'unknown'}`,
                    none: '',
                }[s.status] ?? '';
                if (live && s.status === 'writing') text += ' You can lock your phone; it keeps going.';
            }
            q('status').textContent = text;
            q('bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
            btn('stop').hidden = !live;
            btn('resume').hidden = live || !s || s.status === 'done' || s.status === 'none';
            btn('resume').textContent = s?.status === 'failed' ? '↻ Try again' : '▶ Resume';
            btn('outline').hidden = !(this.app.story?.has_outline || (s && s.status !== 'planning' && total));
            q('steer').hidden = !live;
            q('steer-hint').textContent = live && s.steer_pending
                ? `📌 ${s.steer_pending} note${s.steer_pending > 1 ? 's' : ''} waiting for the next chapter.` : '';
            this._setManualControls(!live);
            this._renderLive();
        }

        _renderLive() {
            const area = document.getElementById('sw-story-area');
            if (!area) return;
            let live = document.getElementById('sw-auto-live');
            const s = this.status;
            const show = this.isLive() && s.status === 'writing';
            if (!show) { live?.remove(); return; }
            if (!live) {
                live = document.createElement('div');
                live.id = 'sw-auto-live';
                live.className = 'sw-segment-card saw-live';
                live.innerHTML = '<div class="sw-chapter-heading" data-el="heading"></div><div class="saw-live-text" data-el="text"></div>';
            }
            if (live.parentNode !== area || area.lastElementChild !== live) area.appendChild(live);
            live.querySelector('[data-el="heading"]').textContent = `Chapter ${s.chapter || this.chaptersSeen + 1}`;
            const textEl = live.querySelector('[data-el="text"]');
            if (this.partial) {
                textEl.classList.remove('saw-waiting');
                textEl.innerHTML = this.app._renderSegmentHtml(this.partial);
            } else {
                textEl.classList.add('saw-waiting');
                textEl.textContent = s.phase === 'summarising' ? 'Making notes…' : 'Thinking about what happens next…';
            }
        }

        _queueNarration(segments) {
            const player = this.app.ttsPlayer;
            if (!segments.length || !player || player.stopped) return;
            const voices = window.config?.get('api.tts.characterVoices') || {};
            const voice = document.getElementById('sw-tts-voice')?.value || 'p230';
            this.app._showNarrationControls();
            if (Object.keys(voices).length) {
                (async () => {
                    for (const seg of segments) {
                        if (player.stopped) break;
                        await this.app._extractAndPlayAudiobook(seg, voices, voice);
                    }
                })();
                return;
            }
            const detector = new SentenceDetector();
            segments.forEach((seg) => detector.feed(seg.content + '\n').forEach((t) => player.enqueue(t, voice)));
            detector.flush().forEach((t) => player.enqueue(t, voice));
        }

        async stop() {
            const id = this.storyId;
            const b = this.panel.querySelector('[data-act="stop"]');
            b.disabled = true;
            try {
                this.status = await postJson(`/stories/${id}/autowrite/stop`);
                this.partial = '';
            } catch (e) {
                alert('Could not stop it: ' + e.message);
            } finally {
                b.disabled = false;
            }
            this._stopPolling();
            this._render();
        }

        async resume() {
            const id = this.storyId;
            const b = this.panel.querySelector('[data-act="resume"]');
            b.disabled = true;
            try {
                this.status = await postJson(`/stories/${id}/autowrite/resume`);
                this._render();
                this.poll();
            } catch (e) {
                alert(e.message);
            } finally {
                b.disabled = false;
            }
        }

        async steer() {
            const input = this.panel.querySelector('[data-el="steer-input"]');
            const note = input.value.trim();
            if (!note) return;
            try {
                this.status = { ...this.status, ...(await postJson(`/stories/${this.storyId}/autowrite/steer`, { note })) };
                input.value = '';
                this._render();
            } catch (e) {
                alert('Could not add the note: ' + e.message);
            }
        }

        // ── Outline (spoilers) ───────────────────────────────────────────────

        showOutline() {
            if (!this.outlineSheet) {
                const el = document.createElement('div');
                el.id = 'sw-outline-sheet';
                el.className = 'pb-overlay';
                el.hidden = true;
                el.innerHTML = `
                    <div class="pb-sheet" role="dialog" aria-modal="true" aria-labelledby="saw-outline-title">
                        <div class="pb-scroll">
                            <div class="pb-head">
                                <h2 id="saw-outline-title">🗺️ Outline</h2>
                                <button type="button" class="saw-icon" data-act="close" aria-label="Close">✕</button>
                            </div>
                            <div data-el="body"></div>
                        </div>
                    </div>`;
                document.body.appendChild(el);
                el.addEventListener('click', (e) => {
                    if (e.target === el || e.target.closest('[data-act="close"]')) this._closeOutline();
                    if (e.target.closest('[data-act="reveal"]')) this._loadOutline();
                });
                el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closeOutline(); });
                this.outlineSheet = el;
            }
            this.outlineSheet.querySelector('[data-el="body"]').innerHTML = `
                <section class="pb-panel">
                    <p style="margin:0">The outline is the whole plan, <b>including how it ends</b>. The story is written to it.</p>
                    <div class="pb-row"><button type="button" class="btn-primary" data-act="reveal">Show it (spoilers)</button></div>
                </section>`;
            this.outlineSheet.hidden = false;
            document.documentElement.classList.add('saw-open');
        }

        _closeOutline() {
            this.outlineSheet.hidden = true;
            document.documentElement.classList.remove('saw-open');
        }

        async _loadOutline() {
            const body = this.outlineSheet.querySelector('[data-el="body"]');
            body.innerHTML = '<p class="pb-hint">Loading…</p>';
            try {
                const p = await this.app.apiCall(`/stories/${this.storyId}/outline`);
                const done = this.chaptersSeen;
                body.innerHTML = `
                    <section class="pb-panel">
                        <b>${esc(p.title)}</b>
                        ${p.blurb ? `<p style="margin:0">${esc(p.blurb)}</p>` : ''}
                        ${p.setting ? `<p class="pb-hint"><b>Setting:</b> ${esc(p.setting)}</p>` : ''}
                        ${p.style ? `<p class="pb-hint"><b>Voice:</b> ${esc(p.style)}</p>` : ''}
                    </section>
                    ${(p.cast || []).length ? `<section class="pb-panel"><span class="pb-label">Cast</span>
                        ${p.cast.map((c) => `<p style="margin:0"><b>${esc(c.name)}</b> <span class="pb-soft">${esc(c.role)}</span><br>${esc(c.arc)}</p>`).join('')}
                    </section>` : ''}
                    <section class="pb-panel"><span class="pb-label">Chapters</span>
                        ${p.chapters.map((c, i) => `<p style="margin:0"><b>${i + 1}. ${esc(c.title)}</b>
                            ${i < done ? '<span class="pb-soft">✓ written</span>' : ''}<br>${esc(c.events)}</p>`).join('')}
                    </section>
                    <section class="pb-panel"><span class="pb-label">The ending</span><p style="margin:0">${esc(p.ending)}</p></section>`;
            } catch (e) {
                body.innerHTML = `<p class="pb-hint">Couldn't load the outline: ${esc(e.message)}</p>`;
            }
        }
    }

    window.StoryAutowriter = StoryAutowriter;
    if (window.storyWriterApp) window.storyWriterApp.autowriter = new StoryAutowriter(window.storyWriterApp);
})();

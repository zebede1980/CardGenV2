/**
 * 💌 Messenger: talk to characters as texts, a chat room, or out loud.
 * Dialogue only. plans/chat-bot-messenger.md has the design.
 *
 * Chats live in Roleplay Chat's tables (mode 'messenger'); this tab has its
 * own lobby, its own send route (/api/sw/messenger/{id}/message) and shares
 * Chat's GET /chats/{id}, message edit/delete and Stop (cancel) routes.
 *
 * A reply is one stored message holding a burst of texts, one per paragraph
 * (or "Name: text" lines in a group / chat room). It's split into bubbles
 * when drawn; while streaming, a bubble appears once its paragraph is done.
 *
 * iPhone: the open chat is a fixed shell sized to the visual viewport (body
 * .msg-in-chat, --msg-vh/--msg-vtop via ChatCore.trackViewport), fields are
 * 16px, the reply survives a lock (server task + ChatCore.readStream's
 * sleep-aware watchdog + fetching the reply by id), and waking never aborts it.
 */
(function () {
    const { readStream, utilityCall, errorText, trackViewport, esc } = window.ChatCore;
    const RECOVER_POLL_MS = 3000;
    const RECOVER_GIVE_UP_MS = 5 * 60 * 1000;
    const PREFS_KEY = 'cardgen.messenger.v1';
    const SIZES = [0.9, 1, 1.12, 1.25, 1.4];
    const REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥'];
    const STYLES = [['texting', '📱 Texting'], ['chatroom', '💬 Chat room'], ['conversation', '🗣️ Conversation']];
    const RELATIONSHIPS = [
        ['friend', 'Friend'], ['dating', 'Girlfriend / boyfriend'], ['partner', 'Partner'], ['crush', 'Crush'],
        ['affair', 'Secret affair'], ['therapist', 'Therapist'], ['colleague', 'Colleague'],
        ['match', 'Someone you matched with'], ['stranger', 'Stranger'], ['custom', 'Something else…'],
    ];
    // Photos (plans/messenger-photos.md). A message holds <photo id="…"/> where a
    // photo sits; the picture is fetched on its own. A character's photo is drawn
    // here as an edit of their card portrait: tested best on Qwen Lightning,
    // with nano-gpt's uncensored Qwen edit when the PC is off.
    const PHOTO_MARKER = /^<photo id="([0-9a-f-]{36})"\s*\/>$/;
    const PHOTO_JOBS_KEY = 'cardgen.messenger.photoJobs';
    const PHOTO_FREQ = [['never', 'Never'], ['asked', 'Only when I ask'], ['sometimes', 'Sometimes'], ['often', 'Often']];
    const PREFERRED_PHOTO_MODELS = ['local/qwen-image-2.1-lightning', 'local/qwen-image-2.1'];
    const PREFERRED_PHOTO_FALLBACK = 'qwen-edit-uncensored';
    const RATIOS = [['1:1', 1], ['3:4', 3 / 4], ['4:3', 4 / 3], ['2:3', 2 / 3], ['3:2', 3 / 2], ['9:16', 9 / 16], ['16:9', 16 / 9]];
    const DESCRIBE_PHOTO = 'Someone texted this photo. Describe it in one or two plain sentences, as a caption for someone '
        + 'who can’t see it: who or what is in it, what they’re doing, where, and anything notable. Describe only what can '
        + 'be seen, plainly, including nudity if there is any. No preamble.';
    const OTHER_TABS = ['tab-home', 'tab-cardgen', 'tab-storywriter', 'tab-roleplaychat', 'tab-adventure', 'tab-playground'];
    const OTHER_VIEWS = ['view-home', 'view-cardgen', 'view-storywriter', 'view-roleplaychat', 'view-adventure', 'view-playground'];

    const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
    const isTouch = () => window.matchMedia?.('(hover: none)').matches;
    const parseTime = (s) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s || '') ? s : `${s}Z`);

    function splitLines(text, names) {
        const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
        const out = [];
        String(text || '').split('\n').forEach((line) => {
            if (!line.trim()) return;
            const m = line.match(/^\s*\**([^:*\n]{1,60}?)\**\s*:\s*(.*)$/);
            if (m && byLower.has(m[1].trim().toLowerCase())) out.push({ who: byLower.get(m[1].trim().toLowerCase()), text: m[2].trim() });
            else if (out.length) out[out.length - 1].text += '\n' + line.trim();
            else out.push({ who: names[0] || '', text: line.trim() });
        });
        return out.filter((x) => x.text);
    }

    class MessengerHandler {
        constructor() {
            this.chat = null;
            this.isGenerating = false;
            this.live = null;
            this._recovering = null;
            this.selected = [];
            this.photos = new Map();      // id -> photo row (no picture)
            this._photoImgs = new Map();  // id -> picture (data URI or URL)
            this._portraits = new Map();  // card id -> data URI, or null with no portrait
            this._drawing = new Set();
            this.attach = null;           // the photo you're about to send
            let p = {};
            try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { /* private mode */ }
            this.size = Number.isInteger(p.size) && p.size >= 0 && p.size < SIZES.length ? p.size : 1;
            this.$ = (id) => document.getElementById(id);
            this.view = this.$('view-messenger');
            if (!this.view) return;
            this.timeline = this.$('msg-timeline');
            this.input = this.$('msg-input');
            this._bind();
            this._applySize();
            this._syncViewport = trackViewport('msg', () => document.body.classList.contains('msg-in-chat'), () => {
                // Decided from the last scroll, not now: the shell has already shrunk.
                if (this._stick !== false) requestAnimationFrame(() => this._scrollToBottom());
            });
        }

        // ── Tabs ─────────────────────────────────────────────────────────────

        _bind() {
            const tab = this.$('tab-messenger');
            tab?.addEventListener('click', () => this.showView());
            // The other tabs don't know about this one: hide it when they're used.
            OTHER_TABS.forEach((id) => this.$(id)?.addEventListener('click', () => this._hideView()));

            this.$('msg-new-btn').addEventListener('click', () => this.openNew());
            this.$('msg-back').addEventListener('click', () => this.closeChat());
            this.$('msg-who').addEventListener('click', () => this.openCards());
            this.$('msg-more').addEventListener('click', (e) => { e.stopPropagation(); this._toggleMenu(); });
            this.$('msg-menu').addEventListener('click', (e) => this._onMenu(e));
            document.addEventListener('click', (e) => { if (!e.target.closest('#msg-menu, #msg-more')) this._closeMenu(); });

            this.$('msg-composer').addEventListener('submit', (e) => { e.preventDefault(); this.send(); });
            this.input.addEventListener('input', () => this._sizeInput());
            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); this.send(); }
            });
            this.$('msg-stop').addEventListener('click', () => this.stop());
            this.$('msg-plus').addEventListener('click', () => {
                const tray = this.$('msg-tray');
                tray.hidden = !tray.hidden;
                this.$('msg-plus').setAttribute('aria-expanded', String(!tray.hidden));
            });
            this.$('msg-impersonate').addEventListener('click', () => this.impersonate());
            this.$('msg-photo-btn').addEventListener('click', () => this.$('msg-photo-file').click());
            this.$('msg-photo-file').addEventListener('change', (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) this.attachPhoto(file);
            });
            this.$('msg-describe-btn').addEventListener('click', () => this.describePhoto());
            this.$('msg-jump').addEventListener('click', () => this._scrollToBottom(true));
            this.timeline.addEventListener('scroll', () => this._noteScroll(), { passive: true });
            this.timeline.addEventListener('click', (e) => this._onTimelineClick(e));
            this._bindLongPress();

            document.addEventListener('visibilitychange', () => this.syncOnWake());
            window.addEventListener('focus', () => this.syncOnWake());
        }

        showView() {
            OTHER_VIEWS.forEach((id) => { const v = this.$(id); if (v) v.style.display = 'none'; });
            OTHER_TABS.forEach((id) => { const b = this.$(id); if (b) b.className = 'btn-outline'; });
            document.body.classList.remove('chat-active', 'chat-in-chat');
            this.view.style.display = 'block';
            this.$('tab-messenger').className = 'btn-primary';
            if (!this.chat) this.loadLobby();
            else document.body.classList.add('msg-in-chat');
        }

        _hideView() {
            if (!this.view || this.view.style.display === 'none') return;
            this.view.style.display = 'none';
            this.$('tab-messenger').className = 'btn-outline';
            document.body.classList.remove('msg-in-chat');
        }

        // ── Lobby ────────────────────────────────────────────────────────────

        async loadLobby() {
            const list = this.$('msg-list');
            try {
                const r = await window.authFetch('/api/sw/messenger/');
                if (!r.ok) throw new Error(await errorText(r));
                const chats = await r.json();
                list.innerHTML = '';
                if (!chats.length) {
                    list.innerHTML = '<p class="msg-empty-list">No conversations yet. Tap <b>＋ New</b> and pick someone to text.</p>';
                    return;
                }
                chats.forEach((c) => list.appendChild(this._lobbyRow(c)));
            } catch (e) {
                list.innerHTML = `<p class="msg-empty-list">Couldn’t load your conversations: ${esc(e.message)}</p>`;
            }
        }

        _lobbyRow(c) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'msg-row-chat';
            const when = this._shortWhen(parseTime(c.last_at));
            const icon = { texting: '📱', chatroom: '💬', conversation: '🗣️' }[c.style] || '💌';
            row.innerHTML = `
                <span class="msg-row-avatars"></span>
                <span class="msg-row-main">
                    <span class="msg-row-top"><b>${esc(c.title)}</b><small>${esc(when)}</small></span>
                    <span class="msg-row-last">${c.last_role === 'user' ? 'You: ' : ''}${esc(c.last || 'Say hello 👋')}</span>
                </span>
                <span class="msg-row-side"><span class="msg-row-style" title="${esc(c.style)}">${icon}</span>${c.unread ? '<span class="msg-unread" aria-label="Unread"></span>' : ''}</span>`;
            const av = row.querySelector('.msg-row-avatars');
            (c.characters || []).slice(0, 3).forEach((ch) => av.appendChild(this._avatar(ch)));
            row.addEventListener('click', () => this.openChat(c.id));
            return row;
        }

        _shortWhen(d) {
            if (isNaN(d)) return '';
            const now = new Date();
            const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
            if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (days === 1) return 'Yesterday';
            if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
            return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
        }

        _avatarUrl(id) {
            const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || '';
            return `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
        }

        _avatar(c, cls = '') {
            const span = document.createElement('span');
            span.className = `msg-avatar ${cls}`.trim();
            span.textContent = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
            span.style.setProperty('--hue', String(this._hue(c.name)));
            if (c.id) {
                // Added only once it has loaded: a 404 would otherwise show WebKit's broken-image box.
                const img = new Image();
                img.alt = '';
                img.onload = () => span.appendChild(img);
                img.src = this._avatarUrl(c.id);
            }
            return span;
        }

        _hue(name) {
            let h = 0;
            for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
            return h;
        }

        // ── New conversation ─────────────────────────────────────────────────

        openNewWith(card) {
            this.showView();
            this.openNew([card]);
        }

        openNew(preset = []) {
            this.selected = preset.map((c) => ({ id: c.id, name: c.name }));
            const sheet = this._sheet('💌 New conversation', `
                <section class="pb-panel">
                    <div class="pb-label">Who</div>
                    <div class="msg-chips" data-chips></div>
                    <button type="button" class="btn-outline btn-small msg-add" data-add>＋ Add a character</button>
                </section>
                <div data-settings></div>
                <div class="pb-error" hidden></div>`,
                '<button type="button" class="btn-primary pb-wide" data-start>💌 Start</button>');
            const chips = sheet.querySelector('[data-chips]');
            const paint = () => {
                chips.innerHTML = '';
                if (!this.selected.length) chips.innerHTML = '<span class="pb-hint">Pick one character for a one-to-one chat, or several for a group.</span>';
                this.selected.forEach((c) => {
                    const chip = document.createElement('span');
                    chip.className = 'msg-chip';
                    chip.appendChild(this._avatar(c));
                    chip.insertAdjacentHTML('beforeend', `<span>${esc(c.name)}</span>`);
                    const x = document.createElement('button');
                    x.type = 'button';
                    x.textContent = '×';
                    x.setAttribute('aria-label', `Remove ${c.name}`);
                    x.addEventListener('click', () => { this.selected = this.selected.filter((s) => s.id !== c.id); paint(); });
                    chip.appendChild(x);
                    chips.appendChild(chip);
                });
            };
            paint();
            sheet.querySelector('[data-add]').addEventListener('click', async () => {
                if (!window.cardGallery || !window.characterStorage) return;
                const all = await window.characterStorage.listCards();
                const left = all.filter((c) => c.isPermanent && !this.selected.some((s) => s.id === c.id));
                window.cardGallery.open(left, (picked) => {
                    const id = typeof picked === 'object' ? picked.id : picked;
                    const card = all.find((c) => c.id === id) || picked;
                    const name = card.characterName || card.character?.name || card.name || 'Unknown';
                    if (!this.selected.some((s) => s.id === id)) this.selected.push({ id, name });
                    paint();
                });
            });
            const last = window.config?.get('messenger.lastSettings') || {};
            const form = this._settingsForm(sheet.querySelector('[data-settings]'), { opener: true, time_aware: true, ...last }, {
                persona_name: last.persona_name || '', persona_detail: last.persona_detail || '',
            }, true);
            sheet.querySelector('[data-start]').addEventListener('click', async (e) => {
                const err = sheet.querySelector('.pb-error');
                if (!this.selected.length) { err.textContent = 'Pick at least one character.'; err.hidden = false; return; }
                e.currentTarget.disabled = true;
                const { settings, persona } = form.get();
                try { window.config?.set('messenger.lastSettings', { ...settings, persona_name: persona.name, persona_detail: persona.detail }); } catch (_) { /* not critical */ }
                try {
                    const r = await window.authFetch('/api/sw/messenger/', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            card_ids: this.selected.map((c) => c.id), settings,
                            user_persona_name: persona.name || 'You', user_persona_detail: persona.detail,
                        }),
                    });
                    if (!r.ok) throw new Error(await errorText(r));
                    const chat = await r.json();
                    this._closeSheet(sheet);
                    this.openChat(chat.id);
                } catch (ex) {
                    err.textContent = `Couldn’t start: ${ex.message}`;
                    err.hidden = false;
                    e.currentTarget.disabled = false;
                }
            });
            this._openSheet(sheet);
        }

        /** Style, relationship, persona and options; shared by New and Chat settings. */
        _settingsForm(box, cfg, persona, isNew) {
            const uid = `msg${Math.random().toString(36).slice(2, 8)}`;
            box.innerHTML = `
                <section class="pb-panel">
                    <div class="pb-label">Style</div>
                    <div class="pb-seg msg-seg" role="group" aria-label="Style">
                        ${STYLES.map(([k, l]) => `<button type="button" data-style="${k}">${l}</button>`).join('')}
                    </div>
                    <p class="pb-hint" data-style-hint></p>
                </section>
                <section class="pb-panel">
                    <label class="pb-label" for="${uid}-rel">You are their…</label>
                    <select id="${uid}-rel" class="input pb-input" data-rel>${RELATIONSHIPS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
                    <input type="text" class="input pb-input" data-rel-text maxlength="300" placeholder="e.g. old flame from university, back in touch" hidden>
                    <label class="pb-label" for="${uid}-name">Your name</label>
                    <input type="text" id="${uid}-name" class="input pb-input" data-p-name maxlength="80" placeholder="What they call you">
                    <label class="pb-label" for="${uid}-detail">About you <span class="pb-soft">(optional)</span></label>
                    <textarea id="${uid}-detail" class="input pb-input" data-p-detail rows="3" maxlength="2000" placeholder="Anything they'd know about you"></textarea>
                    <select class="input pb-input" data-p-saved hidden aria-label="Use a saved persona"><option value="">Use a saved persona…</option></select>
                </section>
                <section class="pb-panel">
                    ${isNew ? '<label class="msg-check"><input type="checkbox" data-opener> <span>They text first</span></label>' : ''}
                    <label class="msg-check"><input type="checkbox" data-time> <span>They know the time <span class="pb-soft">(good morning, “you’ve been quiet”)</span></span></label>
                    <label class="msg-check"><input type="checkbox" data-checkin> <span>Check in if I’ve been away</span></label>
                    <select class="input pb-input" data-gap aria-label="After how long">
                        <option value="8">after 8 hours</option><option value="24">after a day</option><option value="72">after 3 days</option>
                    </select>
                    <label class="pb-label" for="${uid}-photos">📷 They send photos</label>
                    <select id="${uid}-photos" class="input pb-input" data-photos>${PHOTO_FREQ.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
                    <p class="pb-hint" data-photos-hint></p>
                </section>
                <details class="pb-panel msg-advanced">
                    <summary class="pb-label">More</summary>
                    <label class="pb-label">Reply length</label>
                    <div class="pb-seg msg-seg" role="group" aria-label="Reply length">
                        <button type="button" data-len="oneliners">One-liners</button><button type="button" data-len="normal">Normal</button><button type="button" data-len="chatty">Chatty</button>
                    </div>
                    <label class="pb-label" for="${uid}-eff">Thinking time</label>
                    <select id="${uid}-eff" class="input pb-input" data-effort>
                        <option value="low">Quick (low)</option><option value="medium">Balanced (medium)</option><option value="high">Careful (high, slower)</option>
                    </select>
                    <label class="msg-check"><input type="checkbox" data-variety> <span>Vary replies</span></label>
                    <label class="pb-label" for="${uid}-temp">Temperature <span class="pb-soft">(blank = your default)</span></label>
                    <input type="number" inputmode="decimal" step="0.05" min="0" max="2" id="${uid}-temp" class="input pb-input" data-temp>
                    <label class="pb-label" for="${uid}-pm">Draw their photos with <span class="pb-soft">(all chats)</span></label>
                    <select id="${uid}-pm" class="input pb-input" data-photo-model></select>
                    <label class="pb-label" for="${uid}-pf">…and when the PC is off</label>
                    <select id="${uid}-pf" class="input pb-input" data-photo-fallback></select>
                </details>`;
            const q = (s) => box.querySelector(s);
            const st = { style: cfg.style || 'texting', len: cfg.length || 'normal' };
            const hints = {
                texting: 'Bubbles, like iMessage or WhatsApp. They send a few short texts at a time.',
                chatroom: 'One column with names, like Discord. In a group they talk to each other too.',
                conversation: 'Talking face to face. One spoken turn at a time, no emoji.',
            };
            const paint = () => {
                box.querySelectorAll('[data-style]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.style === st.style)));
                box.querySelectorAll('[data-len]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.len === st.len)));
                q('[data-style-hint]').textContent = hints[st.style];
                q('[data-rel-text]').hidden = q('[data-rel]').value !== 'custom';
                q('[data-gap]').hidden = !q('[data-checkin]').checked;
                q('[data-photos-hint]').textContent = st.style === 'conversation'
                    ? 'Not in a spoken conversation.'
                    : 'A photo is drawn from their card portrait, so it looks like them.';
            };
            box.addEventListener('click', (e) => {
                const b = e.target.closest('[data-style], [data-len]');
                if (!b) return;
                if (b.dataset.style) st.style = b.dataset.style;
                if (b.dataset.len) st.len = b.dataset.len;
                paint();
            });
            q('[data-rel]').value = cfg.relationship || (cfg.relationship_text ? 'custom' : 'friend');
            q('[data-rel-text]').value = cfg.relationship_text || '';
            q('[data-rel]').addEventListener('change', paint);
            q('[data-checkin]').addEventListener('change', paint);
            q('[data-p-name]').value = persona.persona_name || '';
            q('[data-p-detail]').value = persona.persona_detail || '';
            if (q('[data-opener]')) q('[data-opener]').checked = cfg.opener !== false;
            q('[data-time]').checked = cfg.time_aware !== false;
            q('[data-checkin]').checked = !!cfg.checkin;
            q('[data-gap]').value = String(cfg.checkin_hours || 24);
            q('[data-effort]').value = cfg.reasoning_effort || 'medium';
            q('[data-variety]').checked = cfg.variety !== false;
            q('[data-temp]').value = cfg.temperature ?? '';
            q('[data-photos]').value = PHOTO_FREQ.some(([k]) => k === cfg.photos) ? cfg.photos : 'sometimes';
            const edits = this._editModels();
            const fill = (sel, picked, none) => {
                sel.innerHTML = `<option value="">${esc(none)}</option>` + edits.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
                sel.value = edits.includes(picked) ? picked : '';
            };
            fill(q('[data-photo-model]'), window.config?.get('messenger.photoModel') || '', `Automatic (${this._photoModels().primary || 'no edit model'})`);
            fill(q('[data-photo-fallback]'), window.config?.get('messenger.photoFallback') || '', `Automatic (${this._photoModels().fallback || 'none'})`);
            paint();
            window.authFetch('/api/sw/personas').then((r) => (r.ok ? r.json() : [])).then((list) => {
                const sel = q('[data-p-saved]');
                if (!Array.isArray(list) || !list.length) return;
                list.forEach((p, i) => sel.insertAdjacentHTML('beforeend', `<option value="${i}">${esc(p.name)}</option>`));
                sel.hidden = false;
                sel.addEventListener('change', () => {
                    const p = list[Number(sel.value)];
                    if (!p) return;
                    q('[data-p-name]').value = p.name || '';
                    q('[data-p-detail]').value = [p.age && `Age ${p.age}`, p.gender, p.detail].filter(Boolean).join('. ');
                    sel.value = '';
                });
            }).catch(() => {});
            return {
                get: () => {
                    const rel = q('[data-rel]').value;
                    const temp = parseFloat(q('[data-temp]').value);
                    const settings = {
                        style: st.style, length: st.len,
                        relationship: rel === 'custom' ? '' : rel,
                        relationship_text: rel === 'custom' ? q('[data-rel-text]').value.trim() : '',
                        time_aware: q('[data-time]').checked, checkin: q('[data-checkin]').checked,
                        checkin_hours: Number(q('[data-gap]').value) || 24,
                        reasoning_effort: q('[data-effort]').value, variety: q('[data-variety]').checked,
                        temperature: Number.isFinite(temp) ? temp : null,
                        photos: q('[data-photos]').value,
                    };
                    if (q('[data-opener]')) settings.opener = q('[data-opener]').checked;
                    try {
                        window.config?.set('messenger.photoModel', q('[data-photo-model]').value);
                        window.config?.set('messenger.photoFallback', q('[data-photo-fallback]').value);
                    } catch (_) { /* not critical */ }
                    return { settings, persona: { name: q('[data-p-name]').value.trim(), detail: q('[data-p-detail]').value.trim() } };
                },
            };
        }

        // ── The open chat ────────────────────────────────────────────────────

        async openChat(id) {
            try {
                const r = await window.authFetch(`/api/sw/chats/${id}`);
                if (!r.ok) throw new Error(await errorText(r));
                this.chat = await r.json();
                this.photos = new Map();
                this.attach = null;
                this._paintAttach();
                await this._loadPhotos();
            } catch (e) {
                alert(`Couldn’t open the chat: ${e.message}`);
                return;
            }
            this.$('msg-lobby').hidden = true;
            this.$('msg-chat').hidden = false;
            document.body.classList.add('msg-in-chat');
            window.scrollTo(0, 0);
            this._syncViewport();
            this._paintHeader();
            this.render();
            this._scrollToBottom();
            window.authFetch(`/api/sw/messenger/${id}/read`, { method: 'POST' }).catch(() => {});
            this._drawPending();
            await this._afterOpen();
        }

        async _afterOpen() {
            const msgs = this.chat.messages || [];
            const last = msgs[msgs.length - 1];
            const cfg = this.chat.messenger_config || {};
            if (last && last.role === 'assistant' && !last.content) {
                this._recover(last.id); // still being written on the server
            } else if (!msgs.some((m) => m.content) && cfg.opener !== false) {
                this.runReply({ kind: 'opener' });
            } else if (cfg.checkin) {
                try {
                    const r = await window.authFetch(`/api/sw/messenger/${this.chat.id}/checkin-due`);
                    if (r.ok && (await r.json()).due) this.runReply({ kind: 'checkin' });
                } catch (_) { /* no check-in this time */ }
            }
        }

        closeChat() {
            if (this._abort) { this._abort.abort(); this._abort = null; }
            this._recovering = null;
            this._setGenerating(false);
            this.chat = null;
            this.timeline.innerHTML = ''; // no flash of this chat when the next one opens
            document.body.classList.remove('msg-in-chat');
            this.$('msg-chat').hidden = true;
            this.$('msg-lobby').hidden = false;
            this._closeMenu();
            this.loadLobby();
        }

        _names() { return (this.chat?.characters || []).map((c) => c.name || 'Character'); }
        _style() { return this.chat?.messenger_config?.style || 'texting'; }
        _group() { return (this.chat?.characters || []).length > 1; }
        _me() { return this.chat?.user_persona_name || 'You'; }

        _paintHeader() {
            const chars = this.chat.characters || [];
            const av = this.$('msg-who-avatars');
            av.innerHTML = '';
            chars.slice(0, 3).forEach((c) => av.appendChild(this._avatar(c)));
            this.$('msg-name').textContent = this.chat.title || this._names().join(', ');
            const style = STYLES.find(([k]) => k === this._style());
            this.$('msg-sub').textContent = this.isGenerating ? this._typingLabel() : (style ? style[1] : '');
            this.timeline.dataset.style = this._style();
            this.timeline.classList.toggle('is-group', this._group());
            this.input.placeholder = this._style() === 'conversation' ? 'Say something' : (this._style() === 'chatroom' ? 'Message the room' : 'Text message');
        }

        _typingLabel() {
            const n = this._names();
            if (this._group()) return 'typing…';
            return this._style() === 'conversation' ? `${n[0]} is speaking…` : `${n[0]} is typing…`;
        }

        /** A message as bubbles: [{who, text, me}] */
        _bubbles(m) {
            const text = stripThink(m.content).replace(/<\/?react>/gi, '').trim();
            if (!text) return [];
            const tag = (b) => {
                const pm = b.text.match(PHOTO_MARKER);
                if (pm) return { ...b, photo: pm[1] };
                if (/<photo>/i.test(b.text)) return { ...b, sending: true }; // still streaming: not lifted out yet
                return b;
            };
            let out;
            if (m.role === 'user') out = text.split(/\n\s*\n/).map((t) => ({ who: this._me(), text: t.trim(), me: true }));
            else if (this._group() || this._style() === 'chatroom') out = splitLines(text, this._names()).map((b) => ({ ...b, me: false }));
            else out = text.split(/\n\s*\n/).map((t) => ({ who: m.character_name || this._names()[0], text: t.trim(), me: false }));
            return out.filter((b) => b.text).map(tag);
        }

        render() {
            const tl = this.timeline;
            tl.innerHTML = '';
            const msgs = (this.chat.messages || []).filter((m) => (m.content || '').trim());
            let lastDay = '';
            let prevWho = null;
            const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
            msgs.forEach((m, i) => {
                const at = parseTime(m.created_at);
                const day = isNaN(at) ? '' : at.toDateString();
                if (day && day !== lastDay) {
                    lastDay = day;
                    prevWho = null;
                    const sep = document.createElement('div');
                    sep.className = 'msg-day';
                    sep.textContent = this._dayLabel(at);
                    tl.appendChild(sep);
                }
                const group = document.createElement('div');
                group.className = `msg-msg ${m.role === 'user' ? 'from-me' : 'from-them'}`;
                group.dataset.mid = m.id;
                const bubbles = this._bubbles(m);
                bubbles.forEach((b, j) => {
                    group.appendChild(this._bubbleEl(b, prevWho !== b.who, j === bubbles.length - 1 ? m : null, at));
                    prevWho = b.who;
                });
                if (this._style() === 'texting' && m.role === 'user' && i === lastUserIdx) {
                    const next = msgs[i + 1];
                    const meta = document.createElement('div');
                    meta.className = 'msg-receipt';
                    meta.textContent = next ? `Read ${parseTime(next.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Delivered';
                    group.appendChild(meta);
                }
                tl.appendChild(group);
            });
            if (!msgs.length && !this.isGenerating) {
                tl.innerHTML = `<p class="msg-empty">Say hello to ${esc(this._names().join(' and '))} 👋</p>`;
            }
            this._hydratePhotos();
        }

        _dayLabel(d) {
            const days = Math.floor((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 864e5);
            if (days === 0) return 'Today';
            if (days === 1) return 'Yesterday';
            return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
        }

        /** One bubble. firstOfRun: a new speaker starts (name/avatar shown). msg: set on a message's last bubble. */
        _bubbleEl(b, firstOfRun, msg, at) {
            const style = this._style();
            const row = document.createElement('div');
            row.className = `msg-b-row ${b.me ? 'me' : 'them'}${firstOfRun ? ' first' : ''}`;
            const card = (this.chat.characters || []).find((c) => c.name === b.who);
            if (!b.me) {
                const av = this._avatar(card || { name: b.who });
                if (!firstOfRun) av.classList.add('is-spacer'); // keeps a run's bubbles lined up
                row.appendChild(av);
            }
            const col = document.createElement('div');
            col.className = 'msg-b-col';
            if (firstOfRun && (style !== 'texting' || (this._group() && !b.me))) {
                const name = document.createElement('div');
                name.className = 'msg-b-name';
                name.style.setProperty('--hue', String(this._hue(b.who)));
                name.textContent = b.who;
                if (style === 'chatroom' && at && !isNaN(at)) name.insertAdjacentHTML('beforeend', ` <time>${esc(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>`);
                col.appendChild(name);
            }
            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble';
            if (b.photo || b.sending) {
                bubble.classList.add('msg-photo-b');
                if (b.photo) bubble.dataset.photoId = b.photo;
                bubble.innerHTML = this._photoInner(b);
            } else {
                bubble.innerHTML = this._format(b.text);
            }
            col.appendChild(bubble);
            if (msg) {
                bubble.dataset.last = '1';
                if (msg.reaction) {
                    const r = document.createElement('span');
                    r.className = 'msg-reaction';
                    r.textContent = msg.reaction;
                    r.title = msg.role === 'user' ? `${b.who === this._me() ? (this._names()[0]) : ''} reacted` : 'You reacted';
                    bubble.appendChild(r);
                }
            }
            row.appendChild(col);
            return row;
        }

        _format(text) {
            let t = esc(text);
            t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
            t = t.replace(/(^|\s)@([\w-]{2,30})/g, '$1<span class="msg-mention">@$2</span>');
            t = t.replace(/:(heart|joy|fire|thumbsup|wave|sob|smile|grin|wink|eyes|skull|pray|clap|100):/g, (m, k) => ({
                heart: '❤️', joy: '😂', fire: '🔥', thumbsup: '👍', wave: '👋', sob: '😭', smile: '🙂', grin: '😁',
                wink: '😉', eyes: '👀', skull: '💀', pray: '🙏', clap: '👏', 100: '💯',
            }[k] || m));
            return t.replace(/\n/g, '<br>');
        }

        // ── Sending and replies ──────────────────────────────────────────────

        async send() {
            if (this.isGenerating || !this.chat || this._sending) return;
            let content = this.input.value.trim();
            const ooc = this.$('msg-ooc').value.trim();
            const attach = this.attach;
            if (!content && !ooc && !attach) return;
            if (attach) {
                if (attach.busy) return; // still being described
                const desc = (this.$('msg-attach')?.querySelector('[data-attach-desc]')?.value ?? attach.description ?? '').trim();
                if (!attach.image && !desc) { this.$('msg-attach')?.querySelector('[data-attach-desc]')?.focus(); return; }
                this._sending = true;
                try {
                    const r = await window.authFetch(`/api/sw/messenger/${this.chat.id}/photos`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: attach.image || null, description: desc }),
                    });
                    if (!r.ok) throw new Error(await errorText(r));
                    const p = await r.json();
                    this.photos.set(p.id, p);
                    if (attach.image) this._photoImgs.set(p.id, attach.image);
                    content = [p.marker, content].filter(Boolean).join('\n\n');
                    this.attach = null;
                    this._paintAttach();
                } catch (e) {
                    this._notice(`Couldn’t send the photo: ${e.message}`);
                    return;
                } finally {
                    this._sending = false;
                }
            }
            this.input.value = '';
            this.$('msg-ooc').value = '';
            this.$('msg-tray').hidden = true;
            this._sizeInput();
            this.runReply({ kind: 'send', content, ooc_note: ooc });
        }

        _clientTime() {
            return new Date().toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        _setGenerating(on) {
            this.isGenerating = on;
            this.$('msg-send').hidden = on;
            this.$('msg-stop').hidden = !on;
            if (on) window.wakeLockManager?.acquire(); else if (this._lockHeld) window.wakeLockManager?.release();
            this._lockHeld = on;
            if (this.chat) this._paintHeader();
            this.timeline.querySelector('.msg-typing')?.remove();
            if (on) {
                const typing = document.createElement('div');
                typing.className = 'msg-typing';
                typing.setAttribute('role', 'status');
                typing.innerHTML = `<span class="msg-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="msg-typing-label">${esc(this._typingLabel())}</span>`;
                this.timeline.appendChild(typing);
            }
        }

        async runReply(body) {
            if (this.isGenerating || !this.chat) return;
            const chatId = this.chat.id;
            const cfg = this.chat.messenger_config || {};
            let mine = null;
            if (body.kind === 'send' && body.content) {
                mine = { id: '', role: 'user', content: body.content, created_at: new Date().toISOString(), reaction: '' };
                this.chat.messages.push(mine);
                this.timeline.querySelector('.msg-empty')?.remove();
                this.render();
            }
            if (body.kind === 'regen') {
                const last = this.chat.messages[this.chat.messages.length - 1];
                body.previous_reply = stripThink(last?.content || '').slice(0, 1500);
                this.chat.messages.pop();
                this.render();
            }
            this._setGenerating(true);
            this._scrollToBottom();
            const liveBox = document.createElement('div');
            liveBox.className = 'msg-msg from-them is-live';
            this.timeline.insertBefore(liveBox, this.timeline.querySelector('.msg-typing'));

            const controller = new AbortController();
            this._abort = controller;
            let text = '';
            let replyId = null;
            let final = null;
            let errorMsg = null;
            let shown = 0;
            try {
                const res = await window.authFetch(`/api/sw/messenger/${chatId}/message`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...body, client_time: this._clientTime(),
                        temperature: Number.isFinite(cfg.temperature) ? cfg.temperature : null,
                    }),
                    signal: controller.signal,
                });
                if (!res.ok) throw Object.assign(new Error(await errorText(res)), { http: res.status });
                await readStream(res, controller, {
                    onLive: (l) => { this.live = l; },
                    isFinished: async () => {
                        if (!replyId) return false;
                        const r = await window.authFetch(`/api/sw/chats/${chatId}`);
                        if (!r.ok) return false;
                        const d = await r.json();
                        const m = (d.messages || []).find((x) => x.id === replyId);
                        return !m || !!m.content;
                    },
                    onEvent: (ev) => {
                        if (ev.type === 'chunk') {
                            text += ev.content;
                            shown = this._paintLive(liveBox, text, shown);
                        } else if (ev.type === 'metadata') {
                            replyId = ev.assistant_message_id;
                            this._replyId = replyId;
                            if (mine && ev.user_message_id) mine.id = ev.user_message_id;
                        } else if (ev.type === 'final') {
                            final = ev;
                        } else if (ev.type === 'error') {
                            errorMsg = ev.message;
                        } else if (ev.type === 'api_log') {
                            window.apiHandler?.addBackendLog?.(ev.log);
                        }
                    },
                });
            } catch (e) {
                if (this.chat?.id !== chatId) return;
                if (e.name === 'AbortError' && this._stopping) {
                    await this._stopping;
                    this._stopping = null;
                    this._setGenerating(false);
                    await this._reload();
                    return;
                }
                this._setGenerating(false);
                if (e.http) {
                    await this._reload();
                    if (e.http === 409) await this._afterOpen();
                    else this._notice(`Couldn’t send: ${e.message}`);
                    return;
                }
                liveBox.remove();
                if (replyId) this._recover(replyId);
                else { await this._reload(); this._afterOpen(); }
                return;
            } finally {
                if (this._abort === controller) this._abort = null;
                this._replyId = null;
            }
            if (this.chat?.id !== chatId) return;
            this._setGenerating(false);
            liveBox.remove();
            if (!final) { await this._reload(); return; }
            if (final.deleted) {
                this.render();
                this._notice(errorMsg ? `No reply: ${errorMsg}` : 'No reply came back.', mine || body.kind !== 'send'
                    ? [['Try again', () => this.runReply({ kind: 'retry' })]] : []);
                return;
            }
            if (mine && final.reaction) mine.reaction = final.reaction;
            (final.photos || []).forEach((p) => this.photos.set(p.id, p));
            this.chat.messages.push({ id: final.message_id, role: 'assistant', content: final.content, created_at: new Date().toISOString(), reaction: '', character_name: this._group() ? '' : this._names()[0] });
            this.render();
            this._scrollToBottom();
            this._drawPending();
            if (errorMsg) this._notice(`The reply was cut short: ${errorMsg}`);
            window.authFetch(`/api/sw/messenger/${chatId}/read`, { method: 'POST' }).catch(() => {});
        }

        /** Draw the paragraphs (or lines) that are complete so far. Returns how many are shown. */
        _paintLive(box, text, shown) {
            let visible = text;
            const open = visible.search(/<think>/i);
            const close = visible.search(/<\/think>/i);
            if (open >= 0 && close < 0) visible = visible.slice(0, open);
            visible = stripThink(visible).replace(/^\s*<react>[^<]{0,12}<\/react>/i, '').replace(/<\/?react>?/gi, '');
            const lineMode = this._group() || this._style() === 'chatroom';
            const cut = lineMode ? visible.lastIndexOf('\n') : visible.search(/\n\s*\n(?![\s\S]*\n\s*\n)/);
            const done = cut > 0 ? visible.slice(0, cut) : '';
            const bubbles = this._bubbles({ role: 'assistant', content: done, character_name: this._names()[0] })
                .filter((b) => !/^\s*(\*[^*\n]+\*|_[^_\n]+_)\s*$/.test(b.text));
            if (bubbles.length === shown) return shown;
            box.innerHTML = '';
            let prev = null;
            const lastOld = [...this.timeline.querySelectorAll('.msg-msg:not(.is-live)')].pop();
            if (lastOld?.classList.contains('from-them')) prev = '__';
            bubbles.forEach((b) => { box.appendChild(this._bubbleEl(b, prev !== b.who, null, new Date())); prev = b.who; });
            this._followNew();
            return bubbles.length;
        }

        stop() {
            if (this._recovering) {
                const id = this._recoveringId;
                this._recovering = null;
                this._setGenerating(false);
                if (id) this._cancel(id).then(() => this._reload());
                return;
            }
            if (!this._abort) return;
            this._stopping = this._replyId ? this._cancel(this._replyId) : Promise.resolve(null);
            this._abort.abort();
        }

        async _cancel(id) {
            try {
                const r = await window.authFetch(`/api/sw/chats/${this.chat.id}/messages/${id}/cancel`, { method: 'POST' });
                return r.ok ? r.json() : null;
            } catch (_) { return null; }
        }

        /** The reply's stream dropped or the page found it still being written: poll for it by id. */
        async _recover(replyId) {
            const chatId = this.chat.id;
            const token = {};
            this._recovering = token;
            this._recoveringId = replyId;
            this._setGenerating(true);
            const started = Date.now();
            let outcome = 'timeout';
            while (this._recovering === token && this.chat?.id === chatId && Date.now() - started < RECOVER_GIVE_UP_MS) {
                try {
                    const r = await window.authFetch(`/api/sw/chats/${chatId}`);
                    if (r.ok) {
                        const d = await r.json();
                        const m = (d.messages || []).find((x) => x.id === replyId);
                        if (!m || m.content) { outcome = m ? 'done' : 'gone'; break; }
                    }
                } catch (_) { /* offline for a moment */ }
                await new Promise((res) => setTimeout(res, RECOVER_POLL_MS));
            }
            if (this._recovering !== token || this.chat?.id !== chatId) return;
            this._recovering = null;
            this._setGenerating(false);
            await this._reload();
            if (outcome === 'timeout') this._notice('The reply hasn’t arrived yet.', [['Reload', () => this.openChat(chatId)]]);
        }

        async _reload() {
            if (!this.chat) return;
            const id = this.chat.id;
            try {
                const r = await window.authFetch(`/api/sw/chats/${id}`);
                if (!r.ok || this.chat?.id !== id) return;
                this.chat = await r.json();
                await this._loadPhotos();
                this._paintHeader();
                this.render();
                if (this.isGenerating) this._setGenerating(true);
                this._scrollToBottom();
                this._drawPending();
            } catch (_) { /* keep what's on screen */ }
        }

        async syncOnWake() {
            if (document.visibilityState !== 'visible' || !this.chat || this.$('msg-chat').hidden) return;
            if (this.live) {
                if (Date.now() - this.live.lastByteAt() > 20000) this.live.checkServer();
                return;
            }
            if (this._recovering || this.isGenerating) { this._drawPending(); return; }
            try {
                const r = await window.authFetch(`/api/sw/chats/${this.chat.id}`);
                if (!r.ok) return;
                const d = await r.json();
                const sig = (c) => (c.messages || []).map((m) => `${m.id}:${(m.content || '').length}:${m.reaction || ''}`).join('|');
                if (sig(d) !== sig(this.chat)) {
                    this.chat = d;
                    await this._loadPhotos();
                    this.render();
                    this._scrollToBottom();
                    this._afterOpen();
                }
                this._drawPending();
            } catch (_) { /* try next time */ }
        }

        async impersonate() {
            if (!this.chat) return;
            const btn = this.$('msg-impersonate');
            btn.disabled = true;
            btn.textContent = '✨ Writing…';
            try {
                const ev = await utilityCall(`/api/sw/messenger/${this.chat.id}/impersonate`, { draft: this.input.value }, 'draft');
                this.input.value = ev.content;
                this._sizeInput();
                this.$('msg-tray').hidden = true;
                this.input.focus();
            } catch (e) {
                this._notice(`Couldn’t write it: ${e.message}`);
            } finally {
                btn.disabled = false;
                btn.textContent = '✨ Write my next text';
            }
        }

        _notice(text, buttons = []) {
            this.timeline.querySelectorAll('.msg-notice').forEach((n) => n.remove());
            const n = document.createElement('div');
            n.className = 'msg-notice';
            n.setAttribute('role', 'status');
            n.innerHTML = `<span>${esc(text)}</span>`;
            buttons.forEach(([label, fn]) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn-small btn-outline';
                b.textContent = label;
                b.addEventListener('click', () => { n.remove(); fn(); });
                n.appendChild(b);
            });
            this.timeline.appendChild(n);
            this._scrollToBottom();
        }

        // ── Photos ───────────────────────────────────────────────────────────

        _photoIds(m) {
            return [...String(m?.content || '').matchAll(/<photo id="([0-9a-f-]{36})"\s*\/>/g)].map((x) => x[1]);
        }

        async _loadPhotos() {
            if (!this.chat) return;
            const id = this.chat.id;
            try {
                const r = await window.authFetch(`/api/sw/messenger/${id}/photos`);
                if (!r.ok || this.chat?.id !== id) return;
                const old = this.photos;
                this.photos = new Map((await r.json()).map((p) => [p.id, { ...p, local: old.get(p.id)?.local || null }]));
            } catch (_) { /* photos show as "Photo" until the next load */ }
        }

        _photoInner(b) {
            const icon = '<span class="msg-photo-icon" aria-hidden="true">📷</span>';
            if (b.sending) return `<div class="msg-photo-ph" role="img" aria-label="Sending a photo">${icon}<span>Sending a photo…</span></div>`;
            const p = this.photos.get(b.photo);
            if (!p) return `<div class="msg-photo-words">${icon}<span>Photo</span></div>`;
            if (p.has_image) {
                return `<img class="msg-photo-img" data-photo="${esc(p.id)}" alt="${esc(p.description ? `Photo: ${p.description}` : 'Photo')}">`;
            }
            if (p.owner === 'user' || p.local === 'words') {
                return `<div class="msg-photo-words">${icon}<span>${esc(p.description || 'Photo')}</span></div>`;
            }
            if (p.status === 'failed' || p.local === 'lost') {
                const why = p.local === 'lost' ? 'The photo got lost while the app was closed.' : 'The photo didn’t come through.';
                return `<div class="msg-photo-ph is-failed">${icon}<span>${why}</span>`
                    + `<button type="button" class="btn-small btn-outline" data-photo-retry="${esc(p.id)}">${p.local === 'lost' ? 'Draw it again' : 'Try again'}</button></div>`;
            }
            return `<div class="msg-photo-ph" role="img" aria-label="${esc(p.sender || 'They')} is sending a photo">${icon}<span>${esc(p.sender || 'They')} is sending a photo…</span></div>`;
        }

        /** Put pictures into the photo bubbles on screen, fetching any not cached yet. */
        _hydratePhotos() {
            this.timeline.querySelectorAll('img[data-photo]:not([src])').forEach((img) => {
                const id = img.dataset.photo;
                img.addEventListener('load', () => { if (this._stick !== false) this._scrollToBottom(); }, { once: true });
                const have = this._photoImgs.get(id);
                if (have) { img.src = have; return; }
                this._fetchPhotoImg(id).then((src) => {
                    if (!src) return;
                    this.timeline.querySelectorAll(`img[data-photo="${CSS.escape(id)}"]:not([src])`).forEach((x) => { x.src = src; });
                });
            });
        }

        _fetchPhotoImg(id) {
            if (!this._imgLoads) this._imgLoads = new Map();
            if (!this._imgLoads.has(id)) {
                const chatId = this.chat.id;
                this._imgLoads.set(id, window.authFetch(`/api/sw/messenger/${chatId}/photos/${id}`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((p) => { if (p?.image) this._photoImgs.set(id, p.image); return p?.image || null; })
                    .catch(() => null)
                    .finally(() => this._imgLoads.delete(id)));
            }
            return this._imgLoads.get(id);
        }

        /** Every photo in the chat, oldest first, in the lightbox; swipe between them. */
        _openPhoto(id) {
            const list = [];
            (this.chat.messages || []).forEach((m) => this._photoIds(m).forEach((pid) => {
                const p = this.photos.get(pid);
                const url = this._photoImgs.get(pid);
                if (p && url) list.push({ id: pid, url, label: p.owner === 'user' ? 'You' : p.sender, prompt: p.description || '' });
            }));
            const start = Math.max(0, list.findIndex((x) => x.id === id));
            window.app?.openGallery?.(list, start, 'view');
        }

        _repaintPhoto(id) {
            this.timeline.querySelectorAll(`.msg-photo-b[data-photo-id="${CSS.escape(id)}"]`).forEach((el) => {
                el.innerHTML = this._photoInner({ photo: id });
            });
            this._hydratePhotos();
        }

        /** Image models ticked ✨ Edit in Settings. */
        _editModels() {
            const caps = typeof getImageModelCapabilities === 'function' ? getImageModelCapabilities : null;
            return (window.config?.get('api.image.models') || []).filter((m) => caps?.(m)?.edit);
        }

        /** The model to draw with, and the one to use when the PC is off. */
        _photoModels() {
            const edits = this._editModels();
            const isLocal = (m) => String(m || '').startsWith('local/');
            const picked = window.config?.get('messenger.photoModel') || '';
            const primary = (edits.includes(picked) && picked)
                || PREFERRED_PHOTO_MODELS.find((m) => edits.includes(m))
                || edits.find(isLocal) || edits[0] || '';
            const fbPicked = window.config?.get('messenger.photoFallback') || '';
            // nano-gpt's uncensored Qwen edit was the best hosted stand-in (2026-11-09); used even if not listed.
            let fallback = (edits.includes(fbPicked) && fbPicked)
                || (edits.includes(PREFERRED_PHOTO_FALLBACK) && PREFERRED_PHOTO_FALLBACK)
                || edits.find((m) => !isLocal(m)) || PREFERRED_PHOTO_FALLBACK;
            if (!isLocal(primary) || fallback === primary) fallback = '';
            return { primary, fallback };
        }

        /** A card's portrait, shrunk to ≤1280 px, with its nearest named shape; null if it has none. */
        async _portrait(cardId) {
            if (this._portraits.has(cardId)) return this._portraits.get(cardId);
            let out = null;
            try {
                const r = await fetch(this._avatarUrl(cardId));
                if (r.ok) out = await this._shrink(await r.blob(), 1280, 0.92);
            } catch (_) { /* no portrait */ }
            this._portraits.set(cardId, out);
            return out;
        }

        /** An image file or blob as a JPEG data URI no larger than max px, with its shape. */
        _shrink(blob, max = 1600, quality = 0.85) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    const w = img.naturalWidth;
                    const h = img.naturalHeight;
                    const s = Math.min(1, max / Math.max(w, h));
                    const c = document.createElement('canvas');
                    c.width = Math.round(w * s);
                    c.height = Math.round(h * s);
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    URL.revokeObjectURL(url);
                    const ratio = RATIOS.reduce((best, r) => (Math.abs(Math.log(w / h / r[1])) < Math.abs(Math.log(w / h / best[1])) ? r : best))[0];
                    resolve({ data: c.toDataURL('image/jpeg', quality), ratio });
                };
                img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture couldn’t be opened.')); };
                img.src = url;
            });
        }

        // Draws in flight, by photo id, so a page reloaded mid-draw collects the
        // result instead of paying for it again.
        _jobs() {
            try { return JSON.parse(localStorage.getItem(PHOTO_JOBS_KEY)) || {}; } catch (_) { return {}; }
        }

        _rememberJob(id, ref) {
            const jobs = this._jobs();
            const dayAgo = Date.now() - 864e5;
            Object.keys(jobs).forEach((k) => { if (!(jobs[k].at > dayAgo)) delete jobs[k]; });
            jobs[id] = { ref, at: Date.now() };
            try { localStorage.setItem(PHOTO_JOBS_KEY, JSON.stringify(jobs)); } catch (_) { /* private mode */ }
        }

        _forgetJob(id) {
            const jobs = this._jobs();
            delete jobs[id];
            try { localStorage.setItem(PHOTO_JOBS_KEY, JSON.stringify(jobs)); } catch (_) { /* private mode */ }
        }

        /** Draw every character photo still waiting, one at a time. Never while the page is hidden. */
        _drawPending() {
            if (!this.chat || document.visibilityState !== 'visible') return;
            for (const p of this.photos.values()) {
                if (p.owner !== 'char' || p.status !== 'pending' || p.has_image || p.local || this._drawing.has(p.id)) continue;
                this._drawing.add(p.id);
                this._drawQueue = (this._drawQueue || Promise.resolve()).then(() => this._drawPhoto(p));
            }
        }

        async _drawPhoto(p) {
            const chatId = this.chat?.id;
            if (!chatId) { this._drawing.delete(p.id); return; }
            this._repaintPhoto(p.id);
            try {
                let url = null;
                const prior = this._jobs()[p.id];
                if (prior) {
                    // Started before the page went away: collect it, never pay twice.
                    const res = await window.apiHandler?._tryCollectResult?.(prior.ref, true);
                    if (res) {
                        const out = await res.json();
                        url = out?.data?.[0]?.url || out?.image || out?.url || null;
                    }
                    if (!url) { p.local = 'lost'; this._forgetJob(p.id); return; }
                } else {
                    url = await this._drawFresh(p);
                    if (!url) return; // no portrait or no edit model: the words stand in
                }
                const image = await this._asDataUri(url);
                await this._putPhoto(chatId, p.id, { image, prompt: p.prompt || '' });
                p.status = 'done';
                p.has_image = true;
                this._photoImgs.set(p.id, image);
                this._forgetJob(p.id);
            } catch (e) {
                console.warn('[messenger] photo failed:', e?.message || e);
                p.status = 'failed';
                this._forgetJob(p.id);
                this._putPhoto(chatId, p.id, { status: 'failed' }).catch(() => {});
            } finally {
                this._drawing.delete(p.id);
                if (this.chat?.id === chatId) this._repaintPhoto(p.id);
            }
        }

        async _drawFresh(p) {
            const chars = this.chat.characters || [];
            const card = chars.find((c) => c.name === p.sender) || chars[0];
            const portrait = card ? await this._portrait(card.id) : null;
            const { primary, fallback } = this._photoModels();
            if (!portrait || !primary || !window.apiHandler?.editImage) { p.local = 'words'; return null; }
            // The wording tested on Qwen Lightning (plans/messenger-photos.md): the portrait carries face and style.
            p.prompt = `Make a new picture of this same character: ${p.description} `
                + 'Keep the character’s face, hair and the art style of the picture exactly the same.';
            const run = (model) => {
                const ref = window.ResumableJobs?.newRef?.() || `photo-${Date.now()}`;
                this._rememberJob(p.id, ref);
                return window.apiHandler.editImage({
                    imageBase64: portrait.data, instruction: p.prompt, model, aspectRatio: portrait.ratio, clientRef: ref,
                });
            };
            try {
                return await run(primary);
            } catch (e) {
                if (!fallback || !/offline|unreachable|local gpu/i.test(e?.message || '')) throw e;
                this._forgetJob(p.id);
                return run(fallback);
            }
        }

        /** A hosted model may answer with a link that expires: keep the picture itself. */
        async _asDataUri(url) {
            if (!/^https?:/i.test(url)) return url;
            try {
                const blob = await (await fetch(url)).blob();
                return await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result);
                    fr.onerror = reject;
                    fr.readAsDataURL(blob);
                });
            } catch (_) { return url; }
        }

        async _putPhoto(chatId, id, body) {
            const r = await window.authFetch(`/api/sw/messenger/${chatId}/photos/${id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(await errorText(r));
            return r.json();
        }

        async _redraw(id) {
            const p = this.photos.get(id);
            if (!p || p.owner !== 'char' || this._drawing.has(id) || !this.chat) return;
            this._forgetJob(id);
            Object.assign(p, { local: null, status: 'pending', has_image: false });
            this._photoImgs.delete(id);
            this._repaintPhoto(id);
            try { await this._putPhoto(this.chat.id, id, { status: 'pending' }); } catch (_) { /* drawn anyway */ }
            this._drawPending();
        }

        // ── Your photos ──────────────────────────────────────────────────────

        async attachPhoto(file) {
            if (!this.chat) return;
            this.$('msg-tray').hidden = true;
            const a = { busy: true, image: null, description: '', status: 'Getting it ready…' };
            this.attach = a;
            this._paintAttach();
            try {
                a.image = (await this._shrink(file)).data;
            } catch (e) {
                if (this.attach === a) { this.attach = null; this._paintAttach(); }
                this._notice(e.message);
                return;
            }
            a.status = 'Looking at it…';
            this._paintAttach();
            let desc = '';
            try { desc = await this._describe(a.image); } catch (e) { console.warn('[messenger] describe failed:', e?.message || e); }
            if (this.attach !== a) return;
            a.busy = false;
            a.description = desc;
            a.unread = !desc;
            this._paintAttach();
        }

        /** The vision model's caption of a photo you send, or '' when it can't or won't. */
        async _describe(dataUrl) {
            const api = window.apiHandler;
            const model = window.config?.get('api.text.visionModel') || window.config?.get('api.text.model');
            if (!api?.makeRequest || !model) return '';
            const res = await api.makeRequest('/api/text/chat/completions', {
                model,
                messages: [{ role: 'user', content: [{ type: 'text', text: DESCRIBE_PHOTO }, { type: 'image_url', image_url: { url: dataUrl } }] }],
                max_tokens: 2048, temperature: 0.3, stream: true, resumable: true, __jobLabel: 'Photo description',
            }, false, true);
            const raw = stripThink(await api.handleStreamResponse(res, () => {})).trim().replace(/^["“]|["”]$/g, '');
            if (!raw || /^(i'?m sorry|sorry|i can(?:no|')t|i cannot|i won'?t|i am unable|i'?m unable)/i.test(raw)) return '';
            return raw.slice(0, 600);
        }

        /** A photo you only describe: no picture, your words stand in for it. */
        describePhoto() {
            if (!this.chat) return;
            this.$('msg-tray').hidden = true;
            this.attach = { busy: false, image: null, description: '' };
            this._paintAttach();
            this.$('msg-attach')?.querySelector('[data-attach-desc]')?.focus();
        }


        _paintAttach() {
            let box = this.$('msg-attach');
            const a = this.attach;
            if (!a) { box?.remove(); return; }
            if (!box) {
                box = document.createElement('div');
                box.id = 'msg-attach';
                box.className = 'msg-attach';
                this.$('msg-composer').before(box);
            }
            const hint = a.image
                ? (a.unread ? 'Couldn’t read it: say what’s in it' : 'What’s in it (they go by this)')
                : 'What’s in the photo?';
            box.innerHTML = `${a.image ? '<img class="msg-attach-thumb" alt="Your photo">' : '<span class="msg-attach-icon" aria-hidden="true">📷</span>'}
                <div class="msg-attach-body">${a.busy
                    ? `<span class="msg-attach-status" role="status">${esc(a.status || '')}</span>`
                    : `<input type="text" class="input" data-attach-desc maxlength="600" placeholder="${esc(hint)}" aria-label="${esc(hint)}">`}</div>
                <button type="button" class="msg-attach-x" aria-label="Remove the photo">✕</button>`;
            if (a.image) box.querySelector('img').src = a.image;
            const input = box.querySelector('[data-attach-desc]');
            if (input) {
                input.value = a.description || '';
                input.addEventListener('input', () => { a.description = input.value; });
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.send(); } });
            }
            box.querySelector('.msg-attach-x').addEventListener('click', () => { this.attach = null; this._paintAttach(); });
        }

        // ── Bubble actions and tapbacks ──────────────────────────────────────

        _onTimelineClick(e) {
            if (this._suppressClick) { this._suppressClick = false; return; }
            const retry = e.target.closest('[data-photo-retry]');
            if (retry) { this._redraw(retry.dataset.photoRetry); return; }
            const shot = e.target.closest('img[data-photo]');
            if (shot && shot.complete && shot.naturalWidth) { this._openPhoto(shot.dataset.photo); return; }
            const pick = e.target.closest('[data-tapback]');
            if (pick) { this._react(pick.closest('.msg-msg').dataset.mid, pick.dataset.tapback); return; }
            const act = e.target.closest('[data-act]');
            if (act) { this._doAction(act.dataset.act, act.closest('.msg-msg').dataset.mid); return; }
            const bubble = e.target.closest('.msg-bubble');
            this.timeline.querySelectorAll('.msg-actions, .msg-tapbacks').forEach((x) => x.remove());
            if (!bubble || this.isGenerating) return;
            if (String(window.getSelection?.() || '').trim()) return;
            const group = bubble.closest('.msg-msg');
            const m = this.chat.messages.find((x) => x.id === group.dataset.mid);
            if (!m || !m.id) return;
            const last = this.chat.messages[this.chat.messages.length - 1];
            const bar = document.createElement('div');
            bar.className = 'msg-actions';
            const items = [];
            if (m.role === 'assistant') items.push(['react', '❤️', 'React']);
            if (m.role === 'assistant' && m === last) items.push(['regen', '↻', 'Redo']);
            if (this._photoIds(m).some((id) => this.photos.get(id)?.owner === 'char')) items.push(['redraw', '🎨', 'Redraw photo']);
            items.push(['edit', '✏️', 'Edit'], ['copy', '⧉', 'Copy'], ['delete', '🗑️', 'Delete']);
            bar.innerHTML = items.map(([k, i, l]) => `<button type="button" data-act="${k}" aria-label="${l}"><span aria-hidden="true">${i}</span> ${l}</button>`).join('');
            group.appendChild(bar);
            bar.scrollIntoView({ block: 'nearest' });
        }

        _bindLongPress() {
            let timer = null;
            const start = (e) => {
                const bubble = e.target.closest('.from-them .msg-bubble');
                if (!bubble || this.isGenerating) return;
                timer = setTimeout(() => {
                    this._suppressClick = true;
                    this._showTapbacks(bubble.closest('.msg-msg'));
                }, 480);
            };
            const cancel = () => { clearTimeout(timer); timer = null; };
            this.timeline.addEventListener('touchstart', start, { passive: true });
            this.timeline.addEventListener('touchend', cancel);
            this.timeline.addEventListener('touchmove', cancel, { passive: true });
            this.timeline.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.from-them .msg-bubble')) { e.preventDefault(); this._showTapbacks(e.target.closest('.msg-msg')); }
            });
        }

        _showTapbacks(group) {
            this.timeline.querySelectorAll('.msg-actions, .msg-tapbacks').forEach((x) => x.remove());
            const m = this.chat.messages.find((x) => x.id === group.dataset.mid);
            if (!m || !m.id) return;
            const row = document.createElement('div');
            row.className = 'msg-tapbacks';
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', 'React');
            row.innerHTML = REACTIONS.map((r) => `<button type="button" data-tapback="${r}" aria-pressed="${m.reaction === r}">${r}</button>`).join('');
            group.insertBefore(row, group.firstChild);
        }

        async _react(mid, emoji) {
            const m = this.chat.messages.find((x) => x.id === mid);
            if (!m) return;
            const next = m.reaction === emoji ? '' : emoji;
            try {
                const r = await window.authFetch(`/api/sw/messenger/${this.chat.id}/messages/${mid}/react`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: next }),
                });
                if (!r.ok) throw new Error(await errorText(r));
                m.reaction = next;
            } catch (e) {
                this._notice(`Couldn’t react: ${e.message}`);
            }
            this.render();
        }

        async _doAction(act, mid) {
            const m = this.chat.messages.find((x) => x.id === mid);
            if (!m) return;
            this.timeline.querySelectorAll('.msg-actions').forEach((x) => x.remove());
            if (act === 'react') {
                this._showTapbacks(this.timeline.querySelector(`.msg-msg[data-mid="${CSS.escape(mid)}"]`));
            } else if (act === 'regen') {
                this.runReply({ kind: 'regen' });
            } else if (act === 'redraw') {
                this._photoIds(m).filter((id) => this.photos.get(id)?.owner === 'char').forEach((id) => this._redraw(id));
            } else if (act === 'copy') {
                const words = stripThink(m.content).replace(/<photo id="[^"]*"\s*\/>/g, '[photo]').trim();
                try { await navigator.clipboard.writeText(words); this._toast('Copied'); } catch (_) { /* no clipboard */ }
            } else if (act === 'delete') {
                if (!confirm('Delete this message?')) return;
                await window.authFetch(`/api/sw/chats/${this.chat.id}/messages/${mid}`, { method: 'DELETE' });
                this.chat.messages = this.chat.messages.filter((x) => x.id !== mid);
                this.render();
            } else if (act === 'edit') {
                this.openEditor(m);
            }
        }

        _toast(text) {
            const t = document.createElement('div');
            t.className = 'msg-toast';
            t.textContent = text;
            this.view.appendChild(t);
            setTimeout(() => t.remove(), 1400);
        }

        openEditor(m) {
            const sheet = this._raw(`
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-label="Edit message">
                    <div class="msg-edit-head">
                        <button type="button" class="btn-small btn-outline" data-cancel>Cancel</button>
                        <h2>Edit</h2>
                        <button type="button" class="btn-small" data-save>Save</button>
                    </div>
                    <div class="msg-edit-error"></div>
                    <textarea class="msg-edit-text" aria-label="Message text"></textarea>
                </div>`);
            const ta = sheet.querySelector('textarea');
            ta.value = stripThink(m.content).trim();
            const original = ta.value;
            sheet.querySelector('[data-cancel]').addEventListener('click', () => {
                if (ta.value !== original && !confirm('Discard your changes?')) return;
                this._closeSheet(sheet);
            });
            sheet.querySelector('[data-save]').addEventListener('click', async (e) => {
                e.currentTarget.disabled = true;
                try {
                    const r = await window.authFetch(`/api/sw/chats/${this.chat.id}/messages/${m.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: ta.value.trim() }),
                    });
                    if (!r.ok) throw new Error(await errorText(r));
                    m.content = ta.value.trim();
                    this.render();
                    this._closeSheet(sheet);
                } catch (ex) {
                    sheet.querySelector('.msg-edit-error').textContent = `Couldn’t save: ${ex.message}`;
                    e.currentTarget.disabled = false;
                }
            });
            this._openSheet(sheet);
            ta.focus();
        }

        // ── Header menu, cards, chat settings ────────────────────────────────

        _toggleMenu() {
            const menu = this.$('msg-menu');
            menu.hidden = !menu.hidden;
            this.$('msg-more').setAttribute('aria-expanded', String(!menu.hidden));
        }

        _closeMenu() {
            const menu = this.$('msg-menu');
            if (menu) menu.hidden = true;
            this.$('msg-more')?.setAttribute('aria-expanded', 'false');
        }

        _onMenu(e) {
            const b = e.target.closest('[data-menu]');
            if (!b) return;
            const what = b.dataset.menu;
            if (what === 'smaller' || what === 'larger') {
                this.size = Math.max(0, Math.min(SIZES.length - 1, this.size + (what === 'larger' ? 1 : -1)));
                try { localStorage.setItem(PREFS_KEY, JSON.stringify({ size: this.size })); } catch (_) { /* private mode */ }
                this._applySize();
                return;
            }
            this._closeMenu();
            if (what === 'cards') this.openCards();
            else if (what === 'settings') this.openSettings();
            else if (what === 'delete') this.deleteChat();
        }

        _applySize() {
            this.view?.style.setProperty('--msg-scale', String(SIZES[this.size]));
            const label = this.$('msg-size-label');
            if (label) label.textContent = `${Math.round(SIZES[this.size] * 100)}%`;
        }

        openCards() {
            const chars = this.chat?.characters || [];
            const sheet = this._sheet('🃏 Who you’re talking to', '<section class="pb-panel"><div class="msg-cast"></div></section>');
            const list = sheet.querySelector('.msg-cast');
            chars.forEach((c) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'msg-cast-row';
                row.appendChild(this._avatar(c));
                row.insertAdjacentHTML('beforeend', `<span><b>${esc(c.name)}</b><small>${esc((c.description || '').replace(/\{\{char\}\}/gi, c.name).replace(/\{\{user\}\}/gi, this._me()).slice(0, 140))}</small></span>`);
                row.addEventListener('click', () => window.cardGallery?.showInfo?.({ id: c.id, characterName: c.name, name: c.name }));
                list.appendChild(row);
            });
            this._openSheet(sheet);
        }

        openSettings() {
            const c = this.chat;
            const sheet = this._sheet('⚙️ Chat settings', '<div data-settings></div><div class="pb-error" hidden></div>',
                '<button type="button" class="btn-primary pb-wide" data-save>Save</button>');
            const form = this._settingsForm(sheet.querySelector('[data-settings]'), c.messenger_config || {}, {
                persona_name: c.user_persona_name === 'User' ? '' : c.user_persona_name, persona_detail: c.user_persona_detail,
            }, false);
            sheet.querySelector('[data-save]').addEventListener('click', async (e) => {
                e.currentTarget.disabled = true;
                const { settings, persona } = form.get();
                try {
                    const r = await window.authFetch(`/api/sw/messenger/${c.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ settings, user_persona_name: persona.name || 'You', user_persona_detail: persona.detail }),
                    });
                    if (!r.ok) throw new Error(await errorText(r));
                    const out = await r.json();
                    c.messenger_config = out.messenger_config;
                    c.user_persona_name = out.user_persona_name;
                    c.user_persona_detail = out.user_persona_detail;
                    this._paintHeader();
                    this.render();
                    this._closeSheet(sheet);
                } catch (ex) {
                    const err = sheet.querySelector('.pb-error');
                    err.textContent = `Couldn’t save: ${ex.message}`;
                    err.hidden = false;
                    e.currentTarget.disabled = false;
                }
            });
            this._openSheet(sheet);
        }

        async deleteChat() {
            if (!this.chat || !confirm(`Delete this conversation with ${this._names().join(', ')}? This can’t be undone.`)) return;
            await window.authFetch(`/api/sw/chats/${this.chat.id}`, { method: 'DELETE' });
            this.closeChat();
        }

        // ── Sheets ───────────────────────────────────────────────────────────

        _host() {
            let host = this.$('msg-sheets');
            if (!host) {
                host = document.createElement('div');
                host.id = 'msg-sheets';
                document.body.appendChild(host);
            }
            return host;
        }

        _raw(inner) {
            const sheet = document.createElement('div');
            sheet.className = 'pb-overlay msg-sheet';
            sheet.hidden = true;
            sheet.innerHTML = inner;
            sheet.addEventListener('click', (e) => { if (e.target === sheet) this._closeSheet(sheet); });
            sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closeSheet(sheet); });
            this._host().appendChild(sheet);
            return sheet;
        }

        _sheet(title, body, footer = '') {
            const sheet = this._raw(`
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
                    <div class="pb-scroll">
                        <div class="pb-head"><h2>${esc(title)}</h2><button type="button" class="msg-sheet-x" data-close aria-label="Close">✕</button></div>
                        ${body}
                    </div>
                    ${footer ? `<div class="pb-footer">${footer}</div>` : ''}
                </div>`);
            sheet.querySelector('[data-close]').addEventListener('click', () => this._closeSheet(sheet));
            return sheet;
        }

        _openSheet(sheet) {
            sheet.hidden = false;
            document.documentElement.classList.add('saw-open');
        }

        _closeSheet(sheet) {
            sheet.remove();
            if (!document.querySelector('#msg-sheets .msg-sheet, #adv-sheets .adv-sheet:not([hidden])')) document.documentElement.classList.remove('saw-open');
        }

        // ── Scrolling and the composer ───────────────────────────────────────

        _atBottom() {
            const t = this.timeline;
            return t.scrollHeight - t.clientHeight - t.scrollTop < 60;
        }

        _scrollToBottom(smooth = false) {
            const t = this.timeline;
            t.scrollTo({ top: t.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
            this._stick = true;
            this.$('msg-jump').hidden = true;
            this.$('msg-jump').classList.remove('has-new');
        }

        _followNew() {
            const t = this.timeline;
            if (t.scrollHeight - t.clientHeight - t.scrollTop < 220) this._scrollToBottom();
            else { this.$('msg-jump').hidden = false; this.$('msg-jump').classList.add('has-new'); }
        }

        _noteScroll() {
            const jump = this.$('msg-jump');
            const at = this._atBottom();
            this._stick = at;
            jump.hidden = at;
            if (at) jump.classList.remove('has-new');
        }

        _sizeInput() {
            const t = this.input;
            t.style.height = 'auto';
            t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
        }
    }

    window.MessengerHandler = MessengerHandler;
    const boot = () => { window.messengerHandler = new MessengerHandler(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();

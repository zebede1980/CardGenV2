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
                    };
                    if (q('[data-opener]')) settings.opener = q('[data-opener]').checked;
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
            if (m.role === 'user') return text.split(/\n\s*\n/).map((t) => ({ who: this._me(), text: t.trim(), me: true })).filter((b) => b.text);
            const names = this._names();
            if (this._group() || this._style() === 'chatroom') return splitLines(text, names).map((b) => ({ ...b, me: false }));
            return text.split(/\n\s*\n/).map((t) => ({ who: m.character_name || names[0], text: t.trim(), me: false })).filter((b) => b.text);
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
            bubble.innerHTML = this._format(b.text);
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

        send() {
            if (this.isGenerating || !this.chat) return;
            const content = this.input.value.trim();
            const ooc = this.$('msg-ooc').value.trim();
            if (!content && !ooc) return;
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
            this.chat.messages.push({ id: final.message_id, role: 'assistant', content: final.content, created_at: new Date().toISOString(), reaction: '', character_name: this._group() ? '' : this._names()[0] });
            this.render();
            this._scrollToBottom();
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
                this._paintHeader();
                this.render();
                if (this.isGenerating) this._setGenerating(true);
                this._scrollToBottom();
            } catch (_) { /* keep what's on screen */ }
        }

        async syncOnWake() {
            if (document.visibilityState !== 'visible' || !this.chat || this.$('msg-chat').hidden) return;
            if (this.live) {
                if (Date.now() - this.live.lastByteAt() > 20000) this.live.checkServer();
                return;
            }
            if (this._recovering || this.isGenerating) return;
            try {
                const r = await window.authFetch(`/api/sw/chats/${this.chat.id}`);
                if (!r.ok) return;
                const d = await r.json();
                const sig = (c) => (c.messages || []).map((m) => `${m.id}:${(m.content || '').length}:${m.reaction || ''}`).join('|');
                if (sig(d) !== sig(this.chat)) {
                    this.chat = d;
                    this.render();
                    this._scrollToBottom();
                    this._afterOpen();
                }
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

        // ── Bubble actions and tapbacks ──────────────────────────────────────

        _onTimelineClick(e) {
            if (this._suppressClick) { this._suppressClick = false; return; }
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
            } else if (act === 'copy') {
                try { await navigator.clipboard.writeText(stripThink(m.content).trim()); this._toast('Copied'); } catch (_) { /* no clipboard */ }
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

// 🎭 Persona picker: who you play, the same in Roleplay Chat, Messenger and
// Adventure (Protagonist). plans/persona-mode.md.
//
// A persona is a card of kind "persona" (made in Character Gen, or here). The
// picker shows them as tiles, pre-picks the one you last played with these
// characters or else your default, and also offers "Just a name", "✨ New" and
// "From a card" (any character card, played as you). It returns
// { cardId, name, detail }; with a cardId the chat follows that card from then
// on (the backend copies it in on every turn), so name/detail are only the
// fallback for a card that is later deleted.
//
// "✨ Write it for me" makes the persona with a server card run, which carries
// on if the phone locks or the tab is discarded. The page only polls while it
// is visible, and the run is remembered so the next picker to open finishes it.
(function () {
    const MEMORY_KEY = 'cardgen.personaFor.v1';   // { [characterCardId]: personaCardId }
    const RUN_KEY = 'cardgen.personaRun.v1';      // a "Write it for me" run not yet saved
    const LIST_TTL_MS = 60 * 1000;
    const POLL_MS = 1500;

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } };
    const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ } };

    let cache = null; // { at, rows: [summary rows] }

    async function listCards(force = false) {
        if (!force && cache && Date.now() - cache.at < LIST_TTL_MS) return cache.rows;
        const r = await window.authFetch('/api/storage/cards/summary');
        if (!r.ok) throw new Error(`Couldn’t load your cards (${r.status})`);
        cache = { at: Date.now(), rows: await r.json() };
        return cache.rows;
    }

    const personasOf = (rows) => rows.filter((c) => c.kind === 'persona')
        .sort((a, b) => (b.persona?.isDefault ? 1 : 0) - (a.persona?.isDefault ? 1 : 0) || String(b.lastUsedAt || b.updatedAt || '').localeCompare(String(a.lastUsedAt || a.updatedAt || '')));

    function thumb(card) {
        if (!card?.hasImage) return '';
        const token = window.cardgenAuth?.getToken() || '';
        const t = new Date(card.updatedAt || 0).getTime() || 0;
        return `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(card.id)}&w=160${token ? `&token=${encodeURIComponent(token)}` : ''}&_t=${t}`;
    }

    function waitVisible() {
        if (document.visibilityState === 'visible') return Promise.resolve();
        return new Promise((resolve) => {
            const on = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', on); resolve(); } };
            document.addEventListener('visibilitychange', on);
        });
    }

    async function request(method, path, body) {
        const r = await window.authFetch(path, {
            method, headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try { data = await r.json(); } catch (_) { /* not JSON */ }
        if (!r.ok) {
            const e = new Error(data?.error?.message || data?.error || data?.detail || `The server refused it (${r.status})`);
            e.status = r.status;
            throw e;
        }
        return data;
    }

    /** Save a persona to the Library, with a portrait if given. Resolves its card id. */
    async function saveToLibrary(character, imageBase64 = '') {
        const saved = await request('POST', '/api/storage/cards', {
            isPermanent: true,
            characterName: character.name,
            character: { ...character, cardType: 'persona', tags: [...new Set(['persona', ...(character.tags || [])])] },
            ...(imageBase64 ? { imageBase64 } : {}),
        });
        cache = null;
        return saved.id;
    }

    /** A Library card's portrait as a data URL, or "". */
    async function portraitOf(cardId) {
        try {
            const full = await request('GET', `/api/storage/cards/${encodeURIComponent(cardId)}`);
            return typeof full?.imageBase64 === 'string' && full.imageBase64.startsWith('data:image/') ? full.imageBase64 : '';
        } catch (_) {
            return '';
        }
    }

    /**
     * Follow a "Write it for me" run to the end and save its persona to the
     * Library, once. Polls only while the page is visible; a run whose page went
     * away is finished by the next picker that opens (see resumePending).
     */
    async function finishRun(runId, onStatus = () => {}) {
        for (let misses = 0; ;) {
            await waitVisible();
            let run;
            try {
                run = await request('GET', `/api/card-runs/${runId}`);
                misses = 0;
            } catch (e) {
                if (e.status === 404) { writeJson(RUN_KEY, null); throw new Error('That persona run is gone (the server restarted). It may be in History.'); }
                if (e.status && ![502, 503, 504].includes(e.status)) throw e;
                if (++misses > 20) throw e;
                await sleep(POLL_MS * 2);
                continue;
            }
            if (run.status === 'running') {
                onStatus(run.step === 'finishing' ? 'Tagging…' : 'Writing…');
                await sleep(POLL_MS);
                continue;
            }
            if (run.status !== 'done' || !run.card) {
                writeJson(RUN_KEY, null);
                throw new Error(run.error || `It ${run.status === 'stopped' ? 'was stopped' : 'didn’t finish'}.`);
            }
            // Claim it before saving, so two pickers (or two tabs) don't both save it.
            const pending = readJson(RUN_KEY, null);
            if (pending?.runId === runId && pending.savedId) return null; // another one has it
            writeJson(RUN_KEY, { ...(pending || { runId }), savedId: 'saving' });
            try {
                const image = pending?.runId === runId && pending.portraitFrom ? await portraitOf(pending.portraitFrom) : '';
                return await saveToLibrary(run.card, image);
            } catch (e) {
                writeJson(RUN_KEY, { ...(pending || { runId }), savedId: null }); // let a later try save it
                throw e;
            } finally {
                if (readJson(RUN_KEY, null)?.savedId === 'saving') writeJson(RUN_KEY, null);
            }
        }
    }

    function newKey() {
        return window.crypto?.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
    }

    /**
     * 🎭 "Make a persona from this card": a server Revise run rewrites a
     * character card as a persona (api-character.js _revisePersona) and tags
     * it; the result is saved to the Library as a new card with the same
     * portrait. The original card is left alone. Resolves the new card's id
     * (or null if another page saved it).
     */
    async function makeFromCard(cardId, onStatus = () => {}) {
        const full = await request('GET', `/api/storage/cards/${encodeURIComponent(cardId)}`);
        const character = full?.character || full;
        if (!character?.name) throw new Error('Couldn’t read that card.');
        onStatus('Rewriting…');
        const run = await request('POST', '/api/card-runs', {
            key: newKey(), kind: 'revise', settings: window.config?.config || {},
            spec: {
                card: { ...character, cardType: 'persona', persona: {} },
                instruction: `Rewrite this character card as a persona for the player to play as: keep ${character.name}'s name, look, background and temperament as facts; drop the scenario, the first message, the relationship to {{user}} and every rule about how they behave.`,
                pov: 'third',
                withFinishing: true,
            },
        });
        writeJson(RUN_KEY, { runId: run.id, name: character.name, at: Date.now(), portraitFrom: cardId });
        return finishRun(run.id, onStatus);
    }

    async function resumePending() {
        const pending = readJson(RUN_KEY, null);
        if (!pending?.runId || pending.savedId || Date.now() - (pending.at || 0) > 24 * 3600 * 1000) return null;
        try {
            const id = await finishRun(pending.runId);
            window.app?.showNotification?.(`🎭 Persona “${pending.name || 'new'}” is in your Library`, 'success');
            return id;
        } catch (e) {
            console.warn('[persona] pending run:', e.message);
            return null;
        }
    }

    function remember(castIds, personaCardId) {
        const memory = readJson(MEMORY_KEY, {});
        (castIds || []).forEach((id) => {
            if (personaCardId) memory[id] = personaCardId; else delete memory[id];
        });
        writeJson(MEMORY_KEY, memory);
    }

    /**
     * Mount a picker in `host`.
     *   value: { cardId, name, detail } to start from (an existing chat), or null to suggest one
     *   cast:  () => [character card ids] in the chat (greyed out, and used to suggest)
     *   nameHint / detailHint: prefill "Just a name" without stopping a suggestion
     * Returns { get(), refreshCast(), ready }.
     */
    function mount(host, { value = null, cast = () => [], nameHint = '', detailHint = '' } = {}) {
        const uid = `pp${Math.random().toString(36).slice(2, 8)}`;
        const state = {
            mode: 'card',           // card | name | new
            cardId: value?.cardId || null,
            name: value?.name || nameHint || '',
            detail: value?.detail || detailHint || '',
            touched: !!value,       // an existing choice isn't overridden by suggestions
            rows: [],
            busy: false,
        };
        if (value && !value.cardId) state.mode = 'name';

        // A fresh root each time: a sheet that opens again mounts into the same
        // host, and listeners on the host itself would pile up.
        const root = document.createElement('div');
        root.className = 'pp';
        host.replaceChildren(root);
        root.innerHTML = `
            <div class="pp-row" role="radiogroup" aria-label="Who you play" data-tiles></div>
            <div class="pp-chosen" data-chosen></div>
            <div class="pp-panel" data-name-panel hidden>
                <label class="pb-label" for="${uid}-n">Your name</label>
                <input type="text" id="${uid}-n" class="input pb-input" data-name maxlength="80" placeholder="What they call you" autocomplete="off">
                <label class="pb-label" for="${uid}-d">About you <span class="pb-soft">(optional)</span></label>
                <textarea id="${uid}-d" class="input pb-input" data-detail rows="2" maxlength="2000" placeholder="Anything they'd know about you"></textarea>
            </div>
            <div class="pp-panel" data-new-panel hidden>
                <label class="pb-label" for="${uid}-nn">Name</label>
                <input type="text" id="${uid}-nn" class="input pb-input" data-new-name maxlength="80" placeholder="The name you go by" autocomplete="off">
                <label class="pb-label" for="${uid}-ni">A line about you</label>
                <textarea id="${uid}-ni" class="input pb-input" data-new-idea rows="2" maxlength="1500" placeholder="e.g. a tired night-shift paramedic from Leeds, 34, dry sense of humour"></textarea>
                <div class="pp-actions">
                    <button type="button" class="btn-outline btn-small" data-new-save>💾 Save as typed</button>
                    <button type="button" class="btn-primary btn-small" data-new-write>✨ Write it for me</button>
                </div>
                <p class="pb-hint" data-new-status hidden></p>
            </div>
            <p class="pb-error" data-error hidden></p>`;
        const q = (s) => root.querySelector(s);
        q('[data-name]').value = state.name;
        q('[data-detail]').value = state.detail;

        const castIds = () => (cast() || []).map(Number).filter(Boolean);
        const showError = (msg) => { const el = q('[data-error]'); el.textContent = msg || ''; el.hidden = !msg; };

        function suggest() {
            if (state.touched) return;
            const personas = personasOf(state.rows);
            const memory = readJson(MEMORY_KEY, {});
            const excluded = new Set(castIds());
            const remembered = castIds().map((id) => memory[id]).find((pid) => pid && !excluded.has(pid) && state.rows.some((c) => c.id === pid));
            const fallback = personas.find((p) => p.persona?.isDefault && !excluded.has(p.id));
            const pick = remembered || fallback?.id || null;
            if (pick) { state.mode = 'card'; state.cardId = pick; }
            else if (!state.cardId) state.mode = personas.length ? 'card' : 'name';
        }

        function paint() {
            const excluded = new Set(castIds());
            const personas = personasOf(state.rows);
            // A card picked "from a card" isn't a persona, but is still shown as the choice.
            const picked = state.cardId && !personas.some((p) => p.id === state.cardId)
                ? state.rows.find((c) => c.id === state.cardId) : null;
            const tiles = [...personas, ...(picked ? [picked] : [])].map((c) => {
                const on = state.mode === 'card' && state.cardId === c.id;
                const off = excluded.has(c.id);
                const src = thumb(c);
                return `<label class="pp-tile${on ? ' is-on' : ''}${off ? ' is-off' : ''}" title="${off ? 'Already in this chat as a character' : esc(c.name)}">
                    <input type="radio" name="${uid}" value="card:${c.id}" ${on ? 'checked' : ''} ${off ? 'disabled' : ''}>
                    <span class="pp-face">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : esc((c.name || '?').trim().charAt(0).toUpperCase())}</span>
                    <span class="pp-name">${c.persona?.isDefault ? '★ ' : ''}${esc(c.name || 'Unnamed')}</span>
                </label>`;
            }).join('');
            const extra = (val, icon, label, on) => `<label class="pp-tile pp-tile-action${on ? ' is-on' : ''}">
                    <input type="radio" name="${uid}" value="${val}" ${on ? 'checked' : ''}>
                    <span class="pp-face">${icon}</span><span class="pp-name">${label}</span></label>`;
            q('[data-tiles]').innerHTML = tiles
                + extra('name', '✏️', 'Just a name', state.mode === 'name')
                + extra('new', '✨', 'New persona', state.mode === 'new')
                + `<button type="button" class="pp-tile pp-tile-action pp-from" data-from-card style="background: none"><span class="pp-face">🃏</span><span class="pp-name">From a card</span></button>`;
            q('[data-name-panel]').hidden = state.mode !== 'name';
            q('[data-new-panel]').hidden = state.mode !== 'new';

            const chosen = q('[data-chosen]');
            const card = state.mode === 'card' && state.rows.find((c) => c.id === state.cardId);
            if (card) {
                const meta = [card.persona?.age, card.persona?.gender].filter(Boolean).join(' · ');
                const isPersona = card.kind === 'persona';
                chosen.innerHTML = `<span>Playing as <strong>${esc(card.name)}</strong>${meta ? ` <span class="pb-soft">${esc(meta)}</span>` : ''}${isPersona ? '' : ' <span class="pb-soft">(a character card)</span>'}</span>`
                    + (isPersona && !card.persona?.isDefault ? `<button type="button" class="pp-link" data-make-default>☆ Make default</button>` : '')
                    + (isPersona && card.persona?.isDefault ? '<span class="pb-soft">★ Your default</span>' : '');
                chosen.hidden = false;
            } else {
                chosen.innerHTML = '';
                chosen.hidden = true;
            }

            // Keep the picked tile in view: the row keeps its scroll across a
            // repaint, so a persona just made could be off to one side.
            const row = q('[data-tiles]');
            const on = row.querySelector('.pp-tile.is-on');
            if (on) {
                const r = row.getBoundingClientRect();
                const t = on.getBoundingClientRect();
                if (t.left < r.left || t.right > r.right) row.scrollLeft += t.left - r.left - 8;
            }
        }

        async function load(force = false) {
            try {
                state.rows = await listCards(force);
                showError('');
            } catch (e) {
                state.rows = [];
                if (state.mode === 'card' && !state.cardId) state.mode = 'name';
                showError(e.message);
            }
            if (state.cardId && !state.rows.some((c) => c.id === state.cardId) && state.mode === 'card') {
                // The card is gone: fall back to the copied name.
                state.mode = 'name';
                state.cardId = null;
            }
            suggest();
            paint();
        }

        root.addEventListener('change', (e) => {
            const input = e.target.closest('input[type="radio"]');
            if (!input) return;
            state.touched = true;
            if (input.value.startsWith('card:')) { state.mode = 'card'; state.cardId = Number(input.value.slice(5)); }
            else state.mode = input.value;
            showError('');
            paint();
            if (state.mode === 'name') q('[data-name]').focus({ preventScroll: true });
        });
        q('[data-name]').addEventListener('input', (e) => { state.name = e.target.value; state.touched = true; });
        q('[data-detail]').addEventListener('input', (e) => { state.detail = e.target.value; state.touched = true; });

        root.addEventListener('click', async (e) => {
            if (e.target.closest('[data-from-card]')) {
                if (!window.cardGallery) return;
                const excluded = new Set(castIds());
                const cards = state.rows.filter((c) => !excluded.has(c.id)).map((c) => ({
                    id: c.id, characterName: c.name, isPermanent: true, updatedAt: c.updatedAt, createdAt: c.createdAt,
                    character: { name: c.name, description: c.blurb || '' },
                }));
                window.cardGallery.open(cards, (picked) => {
                    const id = Number(typeof picked === 'object' ? picked.id : picked);
                    if (!id) return;
                    state.touched = true;
                    state.mode = 'card';
                    state.cardId = id;
                    paint();
                });
                return;
            }
            if (e.target.closest('[data-make-default]')) {
                try {
                    await request('POST', `/api/sw/cards/${state.cardId}/default-persona`);
                    await load(true);
                } catch (ex) { showError(`Couldn’t make it the default: ${ex.message}`); }
                return;
            }
            const save = e.target.closest('[data-new-save]');
            const write = e.target.closest('[data-new-write]');
            if ((save || write) && !state.busy) {
                const name = q('[data-new-name]').value.trim();
                const idea = q('[data-new-idea]').value.trim();
                const status = q('[data-new-status]');
                if (!name && !write) { showError('Give your persona a name.'); return; }
                if (write && !idea && !name) { showError('Write a line about who you are.'); return; }
                state.busy = true;
                root.querySelectorAll('[data-new-save], [data-new-write]').forEach((b) => { b.disabled = true; });
                showError('');
                try {
                    let id;
                    if (save) {
                        id = await saveToLibrary({ name, description: `# ${name}${idea ? `\n\n${idea}` : ''}`, personality: '', persona: {} });
                    } else {
                        status.hidden = false;
                        status.textContent = 'Writing… (it carries on if your phone locks)';
                        const run = await request('POST', '/api/card-runs', {
                            key: newKey(), kind: 'new-card', settings: window.config?.config || {},
                            spec: { mode: 'classic', concept: idea || name, brief: idea, characterName: name, cardType: 'persona', pov: 'third',
                                cast: { want: false }, portrait: { want: false } },
                        });
                        writeJson(RUN_KEY, { runId: run.id, name: name || 'new', at: Date.now() });
                        id = await finishRun(run.id, (s) => { status.textContent = `${s} (it carries on if your phone locks)`; });
                    }
                    await load(true);
                    if (id) {
                        state.mode = 'card';
                        state.cardId = id;
                        state.touched = true;
                    }
                    status.hidden = true;
                    q('[data-new-name]').value = '';
                    q('[data-new-idea]').value = '';
                    paint();
                } catch (ex) {
                    status.hidden = true;
                    showError(`Couldn’t make the persona: ${ex.message}`);
                } finally {
                    state.busy = false;
                    root.querySelectorAll('[data-new-save], [data-new-write]').forEach((b) => { b.disabled = false; });
                }
            }
        });

        const ready = load().then(() => resumePending()).then((id) => { if (id) return load(true); });

        return {
            ready,
            /** { cardId, name, detail } for the chosen persona. */
            get() {
                if (state.mode === 'card' && state.cardId) {
                    const card = state.rows.find((c) => c.id === state.cardId);
                    return { cardId: state.cardId, name: card?.name || state.name || 'You', detail: '' };
                }
                return { cardId: null, name: q('[data-name]').value.trim(), detail: q('[data-detail]').value.trim() };
            },
            /** The characters in the chat changed: re-grey, and re-suggest if untouched. */
            refreshCast() {
                if (state.mode === 'card' && castIds().includes(state.cardId)) { state.cardId = null; state.touched = false; }
                suggest();
                paint();
            },
            busy: () => state.busy,
        };
    }

    window.PersonaPicker = { mount, remember, listCards, makeFromCard, _reset: () => { cache = null; } };
})();

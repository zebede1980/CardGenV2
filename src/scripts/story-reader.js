/**
 * The Story Writer reader: what the open story's top bar and sheets do.
 *
 * - Aa: text size, Sans/Serif and line spacing, remembered on this device
 *   (localStorage, not the synced config: a size that suits the phone is
 *   rarely the one that suits the desktop).
 * - ⋯: Story details, Contents, Character cards, Outline, Settings.
 * - Sheets: Story details (static markup in index.html), Contents, Settings
 *   (borrows the list page's settings section and puts it back on close) and
 *   the passage editor.
 *
 * Nothing here makes a request except through the callbacks it is handed, so
 * the phone locking mid-way can't cost anything.
 */
(function () {
    const PREFS_KEY = 'cardgen.storyReader.v1';
    const SIZES = [0.85, 0.92, 1, 1.08, 1.17, 1.27, 1.4, 1.55, 1.7];
    const DEFAULT_SIZE = 2;
    const SPACING = { compact: 1.5, normal: 1.7, roomy: 1.95 };
    const FONTS = {
        sans: 'inherit',
        serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    };

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

    function loadPrefs() {
        let p = {};
        try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { /* private mode */ }
        return {
            size: Number.isInteger(p.size) && p.size >= 0 && p.size < SIZES.length ? p.size : DEFAULT_SIZE,
            font: FONTS[p.font] ? p.font : 'sans',
            spacing: SPACING[p.spacing] ? p.spacing : 'normal',
        };
    }

    class StoryReader {
        constructor(app) {
            this.app = app;
            this.prefs = loadPrefs();
            this.sheets = {};
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this._init());
            } else {
                this._init();
            }
        }

        _init() {
            this.workspace = document.getElementById('sw-workspace-view');
            if (!this.workspace) return;
            this.sheets.details = document.getElementById('sw-details-sheet');
            this._applyPrefs();
            this._bindTopBar();
            this._bindSheet(this.sheets.details);
            this._trackComposerHeight();
        }

        // ── Reading options ──────────────────────────────────────────────────

        _applyPrefs() {
            const root = document.documentElement.style;
            root.setProperty('--sw-text-scale', String(SIZES[this.prefs.size]));
            root.setProperty('--sw-text-leading', String(SPACING[this.prefs.spacing]));
            root.setProperty('--sw-text-font', FONTS[this.prefs.font]);

            const pop = document.getElementById('sw-aa-pop');
            if (!pop) return;
            pop.querySelectorAll('[data-reader-font]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.readerFont === this.prefs.font)));
            pop.querySelectorAll('[data-reader-spacing]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.readerSpacing === this.prefs.spacing)));
            const label = document.getElementById('sw-size-label');
            if (label) label.textContent = `${Math.round(SIZES[this.prefs.size] * 100)}%`;
            pop.querySelector('[data-reader-size="-1"]').disabled = this.prefs.size === 0;
            pop.querySelector('[data-reader-size="1"]').disabled = this.prefs.size === SIZES.length - 1;
        }

        _setPref(key, value) {
            // Keep the passage at the top of the screen in place while the text reflows.
            const anchor = this._topVisiblePassage();
            const offset = anchor ? anchor.getBoundingClientRect().top : 0;
            this.prefs[key] = value;
            try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch (_) { /* private mode */ }
            this._applyPrefs();
            if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - offset);
        }

        _topVisiblePassage() {
            const top = this.workspace.querySelector('.sw-topbar')?.getBoundingClientRect().bottom || 0;
            return Array.from(document.querySelectorAll('#sw-story-area .sw-segment-card'))
                .find((el) => el.getBoundingClientRect().bottom > top + 8) || null;
        }

        // ── Top bar and popovers ─────────────────────────────────────────────

        _bindTopBar() {
            const aaBtn = document.getElementById('sw-aa-btn');
            const aaPop = document.getElementById('sw-aa-pop');
            const moreBtn = document.getElementById('sw-more-btn');
            const morePop = document.getElementById('sw-more-pop');
            this.popovers = [[aaBtn, aaPop], [moreBtn, morePop]];

            aaBtn?.addEventListener('click', (e) => { e.stopPropagation(); this._togglePopover(aaBtn, aaPop); });
            moreBtn?.addEventListener('click', (e) => { e.stopPropagation(); this._togglePopover(moreBtn, morePop); });

            aaPop?.addEventListener('click', (e) => {
                const size = e.target.closest('[data-reader-size]')?.dataset.readerSize;
                if (size !== undefined) {
                    const step = Number(size);
                    const next = step === 0 ? DEFAULT_SIZE : Math.min(SIZES.length - 1, Math.max(0, this.prefs.size + step));
                    this._setPref('size', next);
                }
                const font = e.target.closest('[data-reader-font]')?.dataset.readerFont;
                if (font) this._setPref('font', font);
                const spacing = e.target.closest('[data-reader-spacing]')?.dataset.readerSpacing;
                if (spacing) this._setPref('spacing', spacing);
            });

            morePop?.addEventListener('click', (e) => {
                const act = e.target.closest('[data-reader-more]')?.dataset.readerMore;
                if (!act) return;
                this.closePopovers();
                if (act === 'details') this.openSheet(this.sheets.details);
                else if (act === 'contents') this.openContents();
                else if (act === 'outline') this.app.autowriter?.showOutline();
                else if (act === 'settings') this.openSettings();
            });

            document.getElementById('sw-topbar-title')?.addEventListener('click', () => this.openSheet(this.sheets.details));

            document.addEventListener('click', (e) => {
                if (!e.target.closest('.sw-pop-anchor')) this.closePopovers();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                const open = Object.values(this.sheets).find((s) => s && !s.hidden);
                if (open) this.closeSheet(open);
                else this.closePopovers();
            });
        }

        _togglePopover(btn, pop, force) {
            if (!btn || !pop) return;
            const open = force ?? pop.hidden;
            this.popovers.forEach(([b, p]) => {
                if (p !== pop && p) { p.hidden = true; b?.setAttribute('aria-expanded', 'false'); }
            });
            pop.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
        }

        closePopovers() {
            (this.popovers || []).forEach(([b, p]) => this._togglePopover(b, p, false));
        }

        /** Leaving the story: close everything, and put borrowed panels back. */
        closeAll() {
            this.closePopovers();
            Object.values(this.sheets).forEach((s) => { if (s && !s.hidden) this.closeSheet(s); });
        }

        /** Called by StoryWriterApp.refreshWorkspace after every load. */
        onStoryLoaded(story) {
            const outline = document.querySelector('#sw-more-pop [data-reader-more="outline"]');
            if (outline) outline.hidden = !story?.has_outline;
        }

        // ── The bottom bar's height, for passages' sticky action rows ────────

        _trackComposerHeight() {
            const composer = document.getElementById('sw-composer');
            if (!composer || !window.ResizeObserver) return;
            new ResizeObserver(() => {
                this.workspace.style.setProperty('--sw-composer-h', `${Math.round(composer.offsetHeight)}px`);
            }).observe(composer);
        }

        // ── Sheets ───────────────────────────────────────────────────────────

        _bindSheet(sheet, onClose) {
            if (!sheet) return;
            sheet.addEventListener('click', (e) => {
                if (e.target === sheet || e.target.closest('[data-sheet-close]')) this.closeSheet(sheet);
            });
            if (onClose) sheet._onClose = onClose;
        }

        openSheet(sheet) {
            if (!sheet) return;
            this.closePopovers();
            sheet.hidden = false;
            document.documentElement.classList.add('saw-open');
        }

        closeSheet(sheet) {
            if (!sheet || sheet.hidden) return;
            if (sheet._beforeClose && sheet._beforeClose() === false) return;
            // Blur first so a field's "change" (title, synopsis) fires and saves.
            if (sheet.contains(document.activeElement)) document.activeElement.blur();
            sheet.hidden = true;
            sheet._onClose?.();
            const anyOpen = document.querySelector('.pb-overlay:not([hidden])');
            if (!anyOpen) document.documentElement.classList.remove('saw-open');
        }

        _makeSheet(id, heading, { footer = '' } = {}) {
            const el = document.createElement('div');
            el.id = id;
            el.className = 'pb-overlay sw-sheet';
            el.hidden = true;
            el.innerHTML = `
                <div class="pb-sheet" role="dialog" aria-modal="true" aria-labelledby="${id}-heading">
                    <div class="pb-scroll">
                        <div class="pb-head">
                            <h2 id="${id}-heading">${heading}</h2>
                            <button type="button" class="saw-icon" data-sheet-close aria-label="Close">✕</button>
                        </div>
                        <div data-el="body" class="sw-sheet-body"></div>
                    </div>
                    ${footer}
                </div>`;
            document.body.appendChild(el);
            return el;
        }

        // Contents: every passage, tap to jump.
        openContents() {
            if (!this.sheets.contents) {
                this.sheets.contents = this._makeSheet('sw-contents-sheet', '📑 Contents');
                this._bindSheet(this.sheets.contents);
                this.sheets.contents.addEventListener('click', (e) => {
                    const id = e.target.closest('[data-jump]')?.dataset.jump;
                    if (!id) return;
                    this.closeSheet(this.sheets.contents);
                    const card = document.querySelector(`#sw-story-area [data-segment-id="${CSS.escape(id)}"]`);
                    requestAnimationFrame(() => card?.scrollIntoView({ block: 'start' }));
                });
            }
            const cards = Array.from(document.querySelectorAll('#sw-story-area [data-segment-id]'));
            const body = this.sheets.contents.querySelector('[data-el="body"]');
            body.innerHTML = cards.length
                ? `<ol class="sw-contents">${cards.map((card, i) => {
                    const heading = card.querySelector('.sw-chapter-heading')?.textContent || `Part ${i + 1}`;
                    const text = (card.querySelector('.sw-segment-text')?.textContent || '').replace(/\s+/g, ' ').trim();
                    const snippet = text.length > 110 ? `${text.slice(0, 110).trimEnd()}…` : text;
                    return `<li><button type="button" data-jump="${esc(card.dataset.segmentId)}">
                        <span class="sw-contents-title">${esc(heading)}</span>
                        <span class="sw-contents-snippet">${esc(snippet)}</span></button></li>`;
                }).join('')}</ol>`
                : '<p class="pb-hint">Nothing written yet.</p>';
            this.openSheet(this.sheets.contents);
        }

        // Settings: borrow the list page's section (same ids, so its wiring
        // keeps working) and put it back exactly where it was on close.
        openSettings() {
            const panel = document.getElementById('sw-settings-panel');
            if (!panel) return;
            if (!this.sheets.settings) {
                this.sheets.settings = this._makeSheet('sw-settings-sheet', '⚙️ Story Writer settings');
                this._bindSheet(this.sheets.settings, () => {
                    if (this._settingsHome?.parentNode) this._settingsHome.parentNode.insertBefore(panel, this._settingsHome);
                });
            }
            if (!this._settingsHome) {
                this._settingsHome = document.createComment('sw-settings-panel home');
                panel.parentNode.insertBefore(this._settingsHome, panel);
            }
            this.sheets.settings.querySelector('[data-el="body"]').appendChild(panel);
            const details = document.getElementById('sw-settings-details');
            if (details) details.open = true;
            this.openSheet(this.sheets.settings);
        }

        /**
         * Full-screen editor for one passage. `onSave(text)` does the saving
         * and throws on failure; the sheet stays open with the error then.
         */
        openEditor({ heading, text, onSave }) {
            if (!this.sheets.editor) {
                const el = document.createElement('div');
                el.id = 'sw-edit-sheet';
                el.className = 'pb-overlay sw-sheet';
                el.hidden = true;
                el.innerHTML = `
                    <div class="pb-sheet" role="dialog" aria-modal="true" aria-labelledby="sw-edit-heading">
                        <div class="sw-edit-head">
                            <button type="button" class="btn-small btn-outline" data-act="cancel">Cancel</button>
                            <h2 id="sw-edit-heading"></h2>
                            <button type="button" class="btn-small btn-primary" data-act="save">Save</button>
                        </div>
                        <p class="pb-hint sw-edit-error" data-el="error" role="alert"></p>
                        <textarea class="textarea sw-edit-text" data-el="text" aria-labelledby="sw-edit-heading"></textarea>
                    </div>`;
                document.body.appendChild(el);
                this.sheets.editor = el;
                el._beforeClose = () => {
                    const changed = el.querySelector('[data-el="text"]').value !== this._editing?.text;
                    return !changed || this._editing?.saved || confirm('Discard your changes to this passage?');
                };
                el.addEventListener('click', (e) => {
                    const act = e.target.closest('[data-act]')?.dataset.act;
                    if (act === 'cancel') this.closeSheet(el);
                    else if (act === 'save') this._saveEditor();
                });
            }
            const el = this.sheets.editor;
            this._editing = { text, onSave, saved: false };
            el.querySelector('#sw-edit-heading').textContent = heading;
            el.querySelector('[data-el="error"]').textContent = '';
            const area = el.querySelector('[data-el="text"]');
            area.value = text;
            const save = el.querySelector('[data-act="save"]');
            save.disabled = false;
            save.textContent = 'Save';
            this.openSheet(el);
            area.scrollTop = 0;
        }

        async _saveEditor() {
            const el = this.sheets.editor;
            const editing = this._editing;
            if (!editing || editing.busy) return;
            const save = el.querySelector('[data-act="save"]');
            const errorEl = el.querySelector('[data-el="error"]');
            const value = el.querySelector('[data-el="text"]').value;
            if (value === editing.text) { editing.saved = true; this.closeSheet(el); return; }
            editing.busy = true;
            save.disabled = true;
            save.textContent = '⏳ Saving…';
            errorEl.textContent = '';
            try {
                await editing.onSave(value);
                editing.saved = true;
                this.closeSheet(el);
            } catch (e) {
                errorEl.textContent = `⚠️ Couldn't save: ${e.message}`;
            } finally {
                editing.busy = false;
                save.disabled = false;
                save.textContent = 'Save';
            }
        }
    }

    window.StoryReader = StoryReader;
    if (window.storyWriterApp) window.storyWriterApp.reader = new StoryReader(window.storyWriterApp);
})();

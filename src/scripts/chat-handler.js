/**
 * RoleplayChatHandler
 * Handles state, DOM binding, and backend API interactions for the Roleplay Chat tab.
 */

// A reply stream silent for this long is treated as dropped, and the finished
// reply is fetched from the server instead. The backend sends an SSE ping every
// 15 s (SSE_HEARTBEAT_SECONDS in routers/chat.py), so 45 s is three missed pings.
const CHAT_STREAM_STALL_MS = 45000;
// After a dropped stream, how often and how long to poll for the saved reply.
const CHAT_RECOVER_POLL_MS = 4000;
const CHAT_RECOVER_GIVE_UP_MS = 6 * 60 * 1000;

// Phones and tablets: Return types a newline (Send sends), the keyboard isn't
// popped up uninvited, and actions are revealed by tapping a message.
const chatIsTouch = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

class RoleplayChatHandler {
    constructor() {
        this.activeChatId = null;
        this.isGenerating = false;
        this.chats = [];
        this.availablePersonas = [];
        this._personasLoaded = false;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.bindElements();
        this.fixLayout();
        this.bindEvents();
        this.setupTabIntegration();
        this.loadPersonas();
        this._trackVisualViewport();
    }

    /* ── Lobby / Chat-view navigation ──────────────────────────────────────── */
    showLobby() {
        const lobby = document.getElementById('chat-lobby');
        const activeView = document.getElementById('chat-active-view');
        if (lobby) lobby.style.display = 'flex';
        if (activeView) activeView.style.display = 'none';
        const grid = document.getElementById('chat-session-list');
        if (grid) grid.scrollTop = 0;
        this._closePopovers();
        document.body.classList.remove('chat-in-chat');
    }

    showChatView() {
        const lobby = document.getElementById('chat-lobby');
        const activeView = document.getElementById('chat-active-view');
        if (lobby) lobby.style.display = 'none';
        if (activeView) activeView.style.display = 'flex';
        document.body.classList.add('chat-in-chat');
        // Safari may have the page scrolled from the lobby; the fixed shell
        // follows the visual viewport, so start from the top.
        window.scrollTo(0, 0);
        this._syncVisualViewport();
    }

    // The open chat is a fixed shell sized to the *visible* viewport. iOS
    // Safari doesn't resize the page for the keyboard: it pans the visual
    // viewport over it, which pushed a 100dvh shell's header off the top. So
    // mirror visualViewport into CSS variables on <html> (the edit sheet uses
    // them too) and note when the keyboard is up.
    _trackVisualViewport() {
        const vv = window.visualViewport;
        if (!vv) return;
        const onChange = () => this._syncVisualViewport();
        vv.addEventListener('resize', onChange);
        vv.addEventListener('scroll', onChange);
        window.addEventListener('orientationchange', onChange);
    }

    _syncVisualViewport() {
        const vv = window.visualViewport;
        if (!vv || !document.body.classList.contains('chat-in-chat')) return;
        const root = document.documentElement.style;
        const wasAtBottom = !this.isUserScrolling;
        root.setProperty('--chat-vh', `${Math.round(vv.height)}px`);
        root.setProperty('--chat-vtop', `${Math.round(vv.offsetTop)}px`);
        // A keyboard takes well over 100px; toolbars and zoom don't.
        document.body.classList.toggle('chat-kb-open', window.innerHeight - vv.height > 120);
        // Keep the latest message in view as the keyboard opens and the shell shrinks.
        if (wasAtBottom) requestAnimationFrame(() => this.scrollToBottom(false, true));
    }

    fixLayout() {
        // ↓ jump button: shown whenever the latest text is out of view. During
        // a reply it carries a dot, because text is arriving below.
        const fab = document.getElementById('chat-scroll-bottom-btn');
        this.els.fab = fab;
        if (fab) {
            fab.addEventListener('click', () => {
                this.scrollToBottom(true, true);
                fab.style.display = 'none';
                fab.classList.remove('has-new');
            });

            this.els.timeline.addEventListener('scroll', () => {
                const { scrollTop, scrollHeight, clientHeight } = this.els.timeline;
                const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 50;
                this.isUserScrolling = !isAtBottom;
                fab.style.display = isAtBottom ? 'none' : 'flex';
                if (isAtBottom) fab.classList.remove('has-new');
            }, { passive: true });
        }

        // The composer grows with the tray, an OOC note or a long message;
        // if the latest text was in view, keep it there.
        const composer = document.querySelector('#view-roleplaychat .chat-input-area');
        if (composer && window.ResizeObserver) {
            new ResizeObserver(() => {
                if (!this.isUserScrolling) this.scrollToBottom(false, true);
            }).observe(composer);
        }

        // Still used by the lobby (always-visible delete on chat cards).
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
            document.documentElement.classList.add('touch-device');
        }
    }

    setupTabIntegration() {
        const tabCardGen = document.getElementById('tab-cardgen');
        const tabStoryWriter = document.getElementById('tab-storywriter');
        const tabChat = document.getElementById('tab-roleplaychat');

        const viewCardGen = document.getElementById('view-cardgen');
        const viewStoryWriter = document.getElementById('view-storywriter');
        const viewChat = document.getElementById('view-roleplaychat');

        if (tabChat && viewChat) {
            // Activate chat tab
            tabChat.addEventListener('click', () => {
                if (viewCardGen) viewCardGen.style.display = 'none';
                if (viewStoryWriter) viewStoryWriter.style.display = 'none';
                if (tabCardGen) tabCardGen.className = 'btn-outline';
                if (tabStoryWriter) tabStoryWriter.className = 'btn-outline';

                const resultSection = document.querySelector('.result-section');
                if (resultSection) resultSection.style.display = 'none';

                viewChat.style.display = 'flex';
                tabChat.className = 'btn-primary';

                this.loadSessionList();
                this.loadPersonas();
                document.body.classList.add('chat-active');
            });

            // Hide chat view and reset layout when other tabs are clicked
            const leaveChat = () => {
                viewChat.style.display = 'none';
                tabChat.className = 'btn-outline';
                document.body.classList.remove('chat-active');
                document.body.classList.remove('chat-in-chat');
            };
            if (tabCardGen) tabCardGen.addEventListener('click', leaveChat);
            if (tabStoryWriter) tabStoryWriter.addEventListener('click', leaveChat);
        }
    }

    bindElements() {
        this.els = {
            sessionList: document.getElementById('chat-session-list'),
            newBtn: document.getElementById('chat-new-btn'),
            backBtn: document.getElementById('chat-back-btn'),
            lobbyEmpty: document.getElementById('chat-lobby-empty'),

            globalSettingsBtn: document.getElementById('chat-open-global-settings'),
            globalSettingsModal: document.getElementById('chat-global-settings-modal'),
            globalSettingsMaxBtn: document.getElementById('chat-global-settings-maximize'),
            globalSettingsContent: document.querySelector('#chat-global-settings-modal .api-settings-modal'),
            globalSettingsClose: document.getElementById('chat-global-settings-close'),
            globalMaxInput: document.getElementById('chat-global-max-input'),
            globalMaxOutput: document.getElementById('chat-global-max-output'),
            globalTemp: document.getElementById('chat-global-temperature'),
            globalTopP: document.getElementById('chat-global-top-p'),
            globalRepPen: document.getElementById('chat-global-rep-penalty'),
            globalFilterCJK: document.getElementById('chat-global-filter-cjk'),
            globalEnableCot: document.getElementById('chat-global-enable-cot'),
            globalPromptSegments: document.getElementById('chat-global-prompt-segments'),
            globalNewSegment: document.getElementById('chat-global-new-segment'),
            globalAddSegmentBtn: document.getElementById('chat-global-add-segment'),
            globalSaveBtn: document.getElementById('chat-global-save-btn'),

            activeTitle: document.getElementById('chat-active-title'),
            activeChars: document.getElementById('chat-active-characters'),

            timeline: document.getElementById('chat-timeline'),

            msgInput: document.getElementById('chat-message-input'),
            sendBtn: document.getElementById('roleplay-send-btn'),
            stopBtn: document.getElementById('roleplay-stop-btn'),
            impBtn: document.getElementById('roleplay-impersonate-btn'),

            oocToggleBtn: document.getElementById('chat-toggle-ooc-btn'),
            oocContainer: document.getElementById('chat-ooc-container'),
            oocInput: document.getElementById('chat-ooc-input'),
            speakerSelect: document.getElementById('chat-speaker-select'),

            newModal: document.getElementById('chat-new-modal'),
            newCloseBtn: document.getElementById('chat-new-close-btn'),
            newTitle: document.getElementById('chat-new-title'),
            newSelectedChars: document.getElementById('chat-new-selected-chars'),
            newAddCharBtn: document.getElementById('chat-new-add-char-btn'),
            newSysPrompt: document.getElementById('chat-new-system-prompt'),
            newWritingStyle: document.getElementById('chat-new-writing-style'),
            newResponseLength: document.getElementById('chat-new-response-length'),
            createSubmitBtn: document.getElementById('chat-create-submit-btn'),
            newPersonaManual: document.getElementById('chat-new-persona-manual'),
            newPersonaCard: document.getElementById('chat-new-persona-card'),
            newPersonaName: document.getElementById('chat-new-persona-name'),
            newPersonaAge: document.getElementById('chat-new-persona-age'),
            newPersonaGender: document.getElementById('chat-new-persona-gender'),
            newPersonaDetail: document.getElementById('chat-new-persona-detail'),
            newPersonaCardName: document.getElementById('chat-new-persona-card-name'),
            newPersonaPickBtn: document.getElementById('chat-new-persona-pick-btn'),
            newPersonaSavedSelectContainer: document.getElementById('chat-new-persona-saved-select-container'),
            newPersonaSavedSelect: document.getElementById('chat-new-persona-saved-select'),
            newPersonaSaveCheckbox: document.getElementById('chat-new-persona-save'),

            zoomOutBtn: document.getElementById('chat-zoom-out-btn'),
            zoomResetBtn: document.getElementById('chat-zoom-reset-btn'),
            zoomInBtn: document.getElementById('chat-zoom-in-btn'),

            headerWho: document.getElementById('chat-header-who'),
            headerAvatars: document.getElementById('chat-header-avatars'),
            viewCardsBtn: document.getElementById('chat-view-cards-btn'),
            textSizeBtn: document.getElementById('chat-text-size-btn'),
            textSizePop: document.getElementById('chat-text-size-pop'),
            toolsBtn: document.getElementById('chat-tools-btn'),
            toolsTray: document.getElementById('chat-tools-tray'),
            speakerWrap: document.getElementById('chat-speaker-wrap'),
        };
    }

    /* ── Header popover and composer tray ──────────────────────────────────── */
    _togglePopover(btn, panel, open = !panel.classList.contains('open')) {
        if (!btn || !panel) return;
        panel.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
    }

    _closePopovers() {
        this._togglePopover(this.els.textSizeBtn, this.els.textSizePop, false);
        this._togglePopover(this.els.toolsBtn, this.els.toolsTray, false);
    }

    // The ＋ button carries a dot while something in its tray will shape the
    // next reply: an OOC note, or a chosen speaker.
    _updateToolsBadge() {
        const hasOoc = !!this.els.oocInput?.value.trim();
        const hasSpeaker = !!(this.els.speakerSelect && this.els.speakerWrap?.style.display !== 'none' && this.els.speakerSelect.value);
        this.els.toolsBtn?.classList.toggle('has-extras', hasOoc || hasSpeaker);
        this.els.oocToggleBtn?.classList.toggle('active', this.els.oocContainer?.style.display !== 'none');
    }

    // Don't summon the iPhone keyboard over a reply the user is about to read.
    _focusInput() {
        if (!chatIsTouch()) this.els.msgInput?.focus();
    }

    bindEvents() {
        if (!this.els.sessionList) return;

        this.els.newBtn.addEventListener('click', () => this.openNewChatModal());
        this.els.newCloseBtn.addEventListener('click', () => this.closeNewChatModal());
        this.els.createSubmitBtn.addEventListener('click', () => this.createNewChat());

        // Back button: return to lobby
        if (this.els.backBtn) {
            this.els.backBtn.addEventListener('click', () => {
                this.activeChatId = null;
                this.showLobby();
                this.loadSessionList();
            });
        }

        if (this.els.globalSettingsBtn) {
            this.els.globalSettingsBtn.addEventListener('click', () => this.openGlobalSettings());
        }
        if (this.els.globalSettingsMaxBtn) {
            this.els.globalSettingsMaxBtn.addEventListener('click', () => this.toggleGlobalSettingsMaximize());
        }
        if (this.els.globalSettingsClose) {
            this.els.globalSettingsClose.addEventListener('click', () => this.els.globalSettingsModal.style.display = 'none');
        }
        if (this.els.globalAddSegmentBtn) {
            this.els.globalAddSegmentBtn.addEventListener('click', () => this.addSystemPromptSegment());
        }
        if (this.els.globalSaveBtn) {
            this.els.globalSaveBtn.addEventListener('click', () => this.saveGlobalSettings());
        }

        if (this.els.newAddCharBtn) {
            this.els.newAddCharBtn.addEventListener('click', () => this.openGalleryForNewChat());
        }

        if (this.els.newPersonaSavedSelect) {
            this.els.newPersonaSavedSelect.addEventListener('change', (e) => {
                const selectedId = e.target.value;
                if (!selectedId) {
                    this.els.newPersonaName.value = '';
                    this.els.newPersonaAge.value = '';
                    this.els.newPersonaGender.value = '';
                    this.els.newPersonaDetail.value = '';
                    return;
                }
                const persona = this.savedPersonas.find(p => String(p.id) === String(selectedId));
                if (persona) {
                    this.els.newPersonaName.value = persona.name || '';
                    this.els.newPersonaAge.value = persona.age || '';
                    this.els.newPersonaGender.value = persona.gender || '';
                    this.els.newPersonaDetail.value = persona.detail || '';
                }
            });
        }

        const personaRadios = document.querySelectorAll('input[name="chat_user_persona_type"]');
        personaRadios.forEach(r => r.addEventListener('change', (e) => {
            if (e.target.value === 'manual') {
                this.els.newPersonaManual.style.display = 'block';
                this.els.newPersonaCard.style.display = 'none';
            } else {
                this.els.newPersonaManual.style.display = 'none';
                this.els.newPersonaCard.style.display = 'block';
            }
        }));

        if (this.els.newPersonaPickBtn) {
            this.els.newPersonaPickBtn.addEventListener('click', () => {
                if (!window.cardGallery) return alert("Gallery module not loaded.");
                window.cardGallery.open(this.availableCards || [], (cardId) => {
                    const card = (this.availableCards || []).find(c => c.id === cardId);
                    if (card) {
                        this.userPersonaSelectedCard = card;
                        this.els.newPersonaCardName.textContent = card.name || 'Unnamed';
                        this.els.newPersonaCardName.style.color = 'var(--text-primary)';
                    }
                });
            });
        }

        this.els.oocToggleBtn.addEventListener('click', () => {
            const isHidden = this.els.oocContainer.style.display === 'none';
            this.els.oocContainer.style.display = isHidden ? 'block' : 'none';
            this._togglePopover(this.els.toolsBtn, this.els.toolsTray, false);
            this._updateToolsBadge();
            if (isHidden) this.els.oocInput.focus();
        });

        this.els.oocInput.addEventListener('input', () => this.updateOocBadge());
        this.els.speakerSelect?.addEventListener('change', () => this._updateToolsBadge());

        this.els.sendBtn.addEventListener('click', () => this.sendMessage());

        if (this.els.stopBtn) {
            this.els.stopBtn.addEventListener('click', () => this.stopGeneration());
        }

        if (this.els.impBtn) {
            this.els.impBtn.addEventListener('click', () => {
                this._togglePopover(this.els.toolsBtn, this.els.toolsTray, false);
                this.sendImpersonateMessage();
            });
        }

        // Header: tapping who's in the chat opens their cards; Aa holds text size.
        this.els.headerWho?.addEventListener('click', () => this.els.viewCardsBtn?.click());
        this.els.textSizeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._togglePopover(this.els.textSizeBtn, this.els.textSizePop);
        });
        this.els.toolsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._togglePopover(this.els.toolsBtn, this.els.toolsTray);
        });
        // A tap anywhere else closes the popover and the tray.
        document.addEventListener('click', (e) => {
            if (!document.body.classList.contains('chat-in-chat')) return;
            if (!e.target.closest('#chat-text-size-pop, #chat-text-size-btn')) {
                this._togglePopover(this.els.textSizeBtn, this.els.textSizePop, false);
            }
            if (!e.target.closest('#chat-tools-tray, #chat-tools-btn')) {
                this._togglePopover(this.els.toolsBtn, this.els.toolsTray, false);
            }
        });

        // Grows with its text up to the CSS max-height (150px, or 30% of the
        // visible screen when the keyboard leaves less), then scrolls.
        const autoResizeInput = (el) => {
            const max = parseFloat(getComputedStyle(el).maxHeight) || 150;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, max) + 'px';
            el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
        };

        this.els.msgInput.addEventListener('input', () => autoResizeInput(this.els.msgInput));
        // Trigger initial resize
        setTimeout(() => autoResizeInput(this.els.msgInput), 0);
        this.els.msgInput.placeholder = chatIsTouch() ? 'Message…' : 'Message… (Shift+Enter for a new line)';

        // Enter sends with a keyboard; on a phone Return types a newline (there's
        // no Shift to hold) and the Send button sends.
        this.els.msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !chatIsTouch()) {
                e.preventDefault();
                this.sendMessage();
            } else if (e.key === 'Escape') {
                this.els.msgInput.blur();
            }
        });

        this.els.globalNewSegment.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                this.addSystemPromptSegment();
            }
        });

        this.els.oocInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (chatIsTouch()) this.els.msgInput.focus();
                else this.sendMessage();
            }
        });

        // Only visibility: window 'focus' also fired on every return to the
        // browser window and, mid-reply, aborted a healthy stream and redrew
        // the whole chat.
        document.addEventListener('visibilitychange', () => this.syncOnWake());

        if (this.els.zoomOutBtn) {
            this.els.zoomOutBtn.addEventListener('click', () => this.setZoom(this.chatZoom - 0.1));
        }
        if (this.els.zoomInBtn) {
            this.els.zoomInBtn.addEventListener('click', () => this.setZoom(this.chatZoom + 0.1));
        }
        if (this.els.zoomResetBtn) {
            this.els.zoomResetBtn.addEventListener('click', () => this.setZoom(1));
        }

        this.chatZoom = window.config ? (window.config.get("chat.textZoom") || 1) : 1;
        this.setZoom(this.chatZoom);
    }

    setZoom(level) {
        this.chatZoom = Math.max(0.5, Math.min(3, level));
        const view = document.getElementById('view-roleplaychat');
        if (view) {
            view.style.setProperty('--chat-text-zoom', this.chatZoom);
        }
        if (window.config) {
            window.config.set("chat.textZoom", this.chatZoom);
        }
    }

    updateOocBadge() {
        if (!this.els.oocToggleBtn || !this.els.oocInput) return;
        const hasContent = this.els.oocInput.value.trim().length > 0;
        this.els.oocToggleBtn.classList.toggle('has-ooc', hasContent);
        this._updateToolsBadge();
    }

    async syncOnWake() {
        if (document.visibilityState !== 'visible') return;

        this.loadSessionList(); // Refresh the lobby in case external changes occurred

        if (!this.activeChatId) return;

        // A reply streaming in this page is left alone: the stall watchdog in
        // _readChatStream handles a connection that died while the phone was
        // locked. But don't make the user wait out the watchdog if the reply
        // may already be finished: when nothing has arrived for a while, ask.
        if (this._liveStream) {
            if (Date.now() - this._liveStream.lastByteAt() > 20000) this._liveStream.checkServer();
            return;
        }
        // Being fetched after a dropped stream, or the server is still writing
        // a reply this page didn't start (the pending banner polls for it).
        if (this._recovering || this.isGenerating) return;

        try {
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}`);
            if (!res.ok) return;
            const chat = await res.json();
            const messages = chat.messages || [];
            const lastMsg = messages[messages.length - 1];

            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '') {
                this.selectChat(this.activeChatId); // shows the pending banner
                return;
            }

            this._hidePendingGenerationBanner();

            // Changed elsewhere (another device, or a reply that finished while
            // this page was away): redraw.
            const domCount = this.els.timeline.querySelectorAll('.chat-bubble-wrapper').length;
            let needsReload = messages.length !== domCount;
            if (!needsReload && messages.length > 0) {
                const lastDomBubble = this.els.timeline.querySelector('.chat-bubble-wrapper:last-child .chat-bubble');
                if (lastDomBubble && lastDomBubble.textContent.trim() === '' && lastMsg.content !== '') {
                    needsReload = true;
                }
            }
            if (needsReload) this.selectChat(this.activeChatId);
        } catch (e) {
            console.error('Failed to sync chat on wake', e);
        }
    }

    /**
     * Show a non-intrusive banner above the input bar when the server is known
     * to be mid-generation (empty assistant placeholder detected in the DB).
     * Provides a Cancel button that deletes the placeholder row.
     */
    _showPendingGenerationBanner(pendingMsgId, autoPoll = false) {
        const bannerId = 'chat-pending-gen-banner';
        if (document.getElementById(bannerId)) {
            // Update the stored msg id in case of re-entry
            document.getElementById(bannerId)._pendingMsgId = pendingMsgId;
            return;
        }

        const banner = document.createElement('div');
        banner.id = bannerId;
        banner._pendingMsgId = pendingMsgId;
        banner.style.cssText = [
            'display:flex', 'align-items:center', 'gap:0.75rem',
            'padding:0.5rem 0.9rem', 'background:var(--surface-color,#2a2a35)',
            'border-top:1px solid var(--border,#3a3a4a)',
            'border-bottom:1px solid var(--border,#3a3a4a)',
            'font-size:0.85rem', 'color:var(--text-secondary)',
        ].join(';');

        const spinner = document.createElement('span');
        spinner.textContent = '⏳';
        spinner.style.animation = 'none';

        const label = document.createElement('span');
        label.textContent = 'Generation in progress on the server…';
        label.style.flex = '1';

        const waitBtn = document.createElement('button');
        waitBtn.className = 'btn-outline btn-small';
        waitBtn.textContent = 'Reconnect';
        waitBtn.title = 'Poll for the completed response';
        waitBtn.onclick = async () => {
            waitBtn.disabled = true;
            waitBtn.textContent = 'Polling...';
            // Poll until content appears (max ~3 minutes)
            let attempts = 0;
            const poll = async () => {
                try {
                    const r = await window.authFetch(`/api/sw/chats/${this.activeChatId}`);
                    if (!r.ok) return;
                    const c = await r.json();
                    const msgs = c.messages || [];
                    const last = msgs[msgs.length - 1];
                    if (!last || last.content !== '') {
                        // Content arrived — reload the chat
                        this.selectChat(this.activeChatId);
                        return;
                    }
                } catch (_) {}
                if (++attempts < 36) setTimeout(poll, 5000); // retry every 5s for 3 min
                else this._showPendingGenerationBanner(pendingMsgId); // give up: re-show banner
            };
            poll();
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-outline btn-small';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.title = 'Delete the pending response and return to ready state';
        cancelBtn.style.color = 'var(--error, #e05c5c)';
        cancelBtn.onclick = async () => {
            const msgId = document.getElementById(bannerId)?._pendingMsgId;
            this._hidePendingGenerationBanner();
            if (!msgId) { this.selectChat(this.activeChatId); return; }
            try {
                await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${msgId}`, { method: 'DELETE' });
            } catch (_) {}
            this.selectChat(this.activeChatId);
        };

        banner.appendChild(spinner);
        banner.appendChild(label);
        banner.appendChild(waitBtn);
        banner.appendChild(cancelBtn);

        // Insert immediately above the input row
        const inputRow = this.els.msgInput?.closest('[class*="chat-input"], form, .chat-compose') ||
                         this.els.sendBtn?.parentElement;
        if (inputRow && inputRow.parentElement) {
            inputRow.parentElement.insertBefore(banner, inputRow);
        } else {
            // Fallback: append to the chat view
            const view = document.getElementById('view-roleplaychat');
            if (view) view.appendChild(banner);
        }
        
        if (autoPoll && !banner.dataset.polling) {
            banner.dataset.polling = "true";
            waitBtn.click();
        }
    }

    /** Remove the pending-generation banner if it exists. */
    _hidePendingGenerationBanner() {
        const banner = document.getElementById('chat-pending-gen-banner');
        if (banner) banner.remove();
    }

    openGlobalSettings() {
        if (!window.config) return;
        this.els.globalMaxInput.value = window.config.get("chat.maxInputTokens") ?? 8192;
        this.els.globalMaxOutput.value = window.config.get("chat.maxOutputTokens") ?? 1024;
        this.els.globalTemp.value = window.config.get("chat.temperature") ?? 0.8;
        this.els.globalTopP.value = window.config.get("chat.topP") ?? 0.95;
        this.els.globalRepPen.value = window.config.get("chat.repetitionPenalty") ?? 1.0;
        this.els.globalFilterCJK.checked = window.config.get("chat.filterCJK") ?? false;
        this.els.globalEnableCot.checked = window.config.get("chat.enableCot") !== false;

        this.systemPromptSegments = [...(window.config.get("chat.systemPromptSegments") || [])];
        this.renderSystemPromptSegments();

        this.els.globalSettingsModal.style.display = 'flex';
    }

    toggleGlobalSettingsMaximize() {
        const content = this.els.globalSettingsContent;
        const btn = this.els.globalSettingsMaxBtn;

        if (!content.classList.contains('maximized')) {
            content.classList.add('maximized');
            content.style.maxWidth = '95vw';
            content.style.width = '95vw';
            content.style.height = '95vh';
            content.style.maxHeight = '95vh';
            btn.innerHTML = '🗗';
            btn.title = 'Restore';
        } else {
            content.classList.remove('maximized');
            content.style.maxWidth = '600px';
            content.style.width = '90%';
            content.style.height = 'auto';
            content.style.maxHeight = '90vh';
            btn.innerHTML = '⛶';
            btn.title = 'Maximize';
        }
    }

    renderSystemPromptSegments() {
        this.els.globalPromptSegments.innerHTML = '';
        this.systemPromptSegments.forEach((seg, i) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '0.5rem';
            row.style.background = 'var(--surface-color)';
            row.style.border = '1px solid var(--border)';
            row.style.borderRadius = '0.4rem';
            row.style.alignItems = 'flex-start';
            row.style.gap = '0.5rem';
            row.draggable = true;

            const dragHandle = document.createElement('div');
            dragHandle.innerHTML = '☰';
            dragHandle.style.cursor = 'grab';
            dragHandle.style.color = 'var(--text-secondary)';
            dragHandle.style.paddingTop = '0.2rem';
            dragHandle.style.userSelect = 'none';
            dragHandle.title = 'Drag to reorder';

            row.addEventListener('dragstart', (e) => {
                this.draggedSegmentIndex = i;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', i);
                setTimeout(() => row.style.opacity = '0.4', 0);
            });

            row.addEventListener('dragend', () => {
                row.style.opacity = '1';
                this.draggedSegmentIndex = null;
                Array.from(this.els.globalPromptSegments.children).forEach(r => r.style.boxShadow = '');
            });

            row.addEventListener('dragover', (e) => {
                e.preventDefault(); // Necessary to allow dropping
                if (this.draggedSegmentIndex !== null && this.draggedSegmentIndex !== i) {
                    if (this.draggedSegmentIndex < i) {
                        row.style.boxShadow = '0 2px 0 var(--accent)';
                    } else {
                        row.style.boxShadow = '0 -2px 0 var(--accent)';
                    }
                }
            });

            row.addEventListener('dragleave', () => {
                row.style.boxShadow = '';
            });

            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.style.boxShadow = '';
                if (this.draggedSegmentIndex !== null && this.draggedSegmentIndex !== i) {
                    const draggedItem = this.systemPromptSegments.splice(this.draggedSegmentIndex, 1)[0];
                    this.systemPromptSegments.splice(i, 0, draggedItem);
                    this.renderSystemPromptSegments();
                }
            });

            const input = document.createElement('textarea');
            input.value = seg;
            input.style.flex = '1';
            input.style.background = 'transparent';
            input.style.border = 'none';
            input.style.color = 'var(--text-primary)';
            input.style.fontFamily = 'inherit';
            input.style.fontSize = '0.85rem';
            input.style.resize = 'none';
            input.style.overflowY = 'hidden';
            input.style.minHeight = '3rem';
            input.style.outline = 'none';
            input.style.padding = '0';
            input.addEventListener('change', (e) => {
                this.systemPromptSegments[i] = e.target.value;
            });

            const autoSize = () => {
                input.style.height = 'auto';
                input.style.height = (input.scrollHeight) + 'px';
            };
            input.addEventListener('input', autoSize);

            const delBtn = document.createElement('button');
            delBtn.innerHTML = '🗑️';
            delBtn.style.background = 'none';
            delBtn.style.border = 'none';
            delBtn.style.cursor = 'pointer';
            delBtn.style.padding = '0.2rem';
            delBtn.onclick = () => {
                this.systemPromptSegments.splice(i, 1);
                this.renderSystemPromptSegments();
            };

            row.appendChild(dragHandle);
            row.appendChild(input);
            row.appendChild(delBtn);
            this.els.globalPromptSegments.appendChild(row);

            // Set initial size after appending to DOM so scrollHeight is correct
            setTimeout(autoSize, 0);
        });
    }

    addSystemPromptSegment() {
        const val = this.els.globalNewSegment.value.trim();
        if (val) {
            this.systemPromptSegments.push(val);
            this.els.globalNewSegment.value = '';
            this.renderSystemPromptSegments();
        }
    }

    saveGlobalSettings() {
        window.config.set("chat.maxInputTokens", parseInt(this.els.globalMaxInput.value) || 8192);
        window.config.set("chat.maxOutputTokens", parseInt(this.els.globalMaxOutput.value) || 1024);
        window.config.set("chat.temperature", parseFloat(this.els.globalTemp.value) || 0.8);
        window.config.set("chat.topP", parseFloat(this.els.globalTopP.value) || 0.95);
        window.config.set("chat.repetitionPenalty", parseFloat(this.els.globalRepPen.value) || 1.0);
        window.config.set("chat.filterCJK", this.els.globalFilterCJK.checked);
        window.config.set("chat.enableCot", this.els.globalEnableCot.checked);
        window.config.set("chat.systemPromptSegments", this.systemPromptSegments);

        this.els.globalSettingsModal.style.display = 'none';

        if (window.app && window.app.showNotification) {
            window.app.showNotification("Global chat settings saved", "success");
        } else {
            alert("Settings saved!");
        }
    }

    async openNewChatModal(preselectCardId = null) {
        this.newChatSelectedCards = [];
        this.renderNewChatSelectedChars();
        this.els.newTitle.value = '';
        if (this.els.newWritingStyle) this.els.newWritingStyle.value = '';
        // Defaults to "medium" (3-5 paragraphs) rather than blank like writing
        // style — unlike style, there's a clear default length preference.
        if (this.els.newResponseLength) this.els.newResponseLength.value = 'medium';

        this.userPersonaSelectedCard = null;
        this.els.newPersonaName.value = '';
        this.els.newPersonaAge.value = '';
        this.els.newPersonaGender.value = '';
        this.els.newPersonaDetail.value = '';
        this.els.newPersonaCardName.textContent = 'No card selected';
        this.els.newPersonaCardName.style.color = 'var(--text-secondary)';
        if (this.els.newPersonaSaveCheckbox) this.els.newPersonaSaveCheckbox.checked = false;

        try {
            const pRes = await window.authFetch('/api/sw/personas');
            if (pRes.ok) {
                this.savedPersonas = await pRes.json();
                if (this.savedPersonas.length > 0 && this.els.newPersonaSavedSelectContainer) {
                    this.els.newPersonaSavedSelectContainer.style.display = 'block';
                    this.els.newPersonaSavedSelect.innerHTML = '<option value="">-- Select a saved persona --</option>';
                    this.savedPersonas.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.textContent = p.name + (p.age ? ` (${p.age})` : '');
                        this.els.newPersonaSavedSelect.appendChild(opt);
                    });
                } else if (this.els.newPersonaSavedSelectContainer) {
                    this.els.newPersonaSavedSelectContainer.style.display = 'none';
                }
            }
        } catch (e) {
            console.error("Failed to load saved personas", e);
        }

        const radioManual = document.querySelector('input[name="chat_user_persona_type"][value="manual"]');
        if (radioManual) radioManual.checked = true;
        if (this.els.newPersonaManual) this.els.newPersonaManual.style.display = 'block';
        if (this.els.newPersonaCard) this.els.newPersonaCard.style.display = 'none';

        const segments = window.config?.get("chat.systemPromptSegments") || [];
        this.els.newSysPrompt.value = segments.join("\n\n");

        this.els.newModal.classList.add('show');

        try {
            const res = await window.authFetch('/api/sw/cards/');
            if (res.ok) {
                this.availableCards = await res.json();
                if (preselectCardId) {
                    const card = this.availableCards.find(c => String(c.id) === String(preselectCardId));
                    if (card) {
                        this.newChatSelectedCards.push(card);
                        this.renderNewChatSelectedChars();
                        // Pre-fill the chat title with the character's name
                        const charName = card.name || card.characterName || '';
                        if (charName && !this.els.newTitle.value) {
                            this.els.newTitle.value = charName;
                        }
                    }
                }
            } else {
                this.availableCards = [];
            }
        } catch (e) {
            console.error("Failed to load cards for modal", e);
            this.availableCards = [];
        }
    }

    openGalleryForNewChat() {
        if (!window.cardGallery) {
            alert("Gallery module not loaded.");
            return;
        }

        const alreadySelected = new Set((this.newChatSelectedCards || []).map(c => c.id));
        const unselectedCards = (this.availableCards || []).filter(c => !alreadySelected.has(c.id));

        window.cardGallery.open(unselectedCards, (selectedCardOrId) => {
            const cardId = typeof selectedCardOrId === 'object' ? selectedCardOrId.id : selectedCardOrId;
            const card = this.availableCards.find(c => c.id === cardId);
            if (card) {
                this.newChatSelectedCards.push(card);
                this.renderNewChatSelectedChars();
            }
        });
    }

    renderNewChatSelectedChars() {
        if (!this.els.newSelectedChars) return;

        this.els.newSelectedChars.innerHTML = '';
        if (!this.newChatSelectedCards || this.newChatSelectedCards.length === 0) {
            this.els.newSelectedChars.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.85rem; margin: auto;">No characters selected</span>';
            return;
        }

        this.newChatSelectedCards.forEach((card, index) => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.display = 'inline-flex';
            tag.style.alignItems = 'center';
            tag.style.gap = '5px';
            tag.style.fontSize = '0.85rem';
            tag.innerHTML = `${this.escapeHtml(card.name || 'Unnamed')} <button style="background:none; border:none; cursor:pointer; color:var(--error);" title="Remove">×</button>`;

            tag.querySelector('button').addEventListener('click', () => {
                this.newChatSelectedCards.splice(index, 1);
                this.renderNewChatSelectedChars();
            });

            this.els.newSelectedChars.appendChild(tag);
        });

        // Update First Message Selection UI
        const fmSection = document.getElementById('chat-new-first-message-section');
        const fmSelect = document.getElementById('chat-new-first-message-select');
        if (fmSection && fmSelect) {
            if (this.newChatSelectedCards.length === 1) {
                const card = this.newChatSelectedCards[0];
                fmSelect.innerHTML = '';

                const optMain = document.createElement('option');
                optMain.value = "-1";
                optMain.textContent = "Main Greeting";
                fmSelect.appendChild(optMain);

                let altGreetings = card.alternate_greetings;
                if (typeof altGreetings === 'string' && altGreetings.trim().length > 0) {
                    try {
                        altGreetings = JSON.parse(altGreetings);
                    } catch (e) {
                        altGreetings = [];
                    }
                }
                if (Array.isArray(altGreetings) && altGreetings.length > 0) {
                    const optRandom = document.createElement('option');
                    optRandom.value = "random";
                    optRandom.textContent = "🎲 Random";
                    fmSelect.appendChild(optRandom);

                    altGreetings.forEach((g, idx) => {
                        const opt = document.createElement('option');
                        opt.value = idx.toString();
                        opt.textContent = `Alternate Greeting ${idx + 1}`;
                        fmSelect.appendChild(opt);
                    });
                }

                // Only show if there are actual alternate greetings to choose from, or always show?
                // The user requested a way to select which first message/alternate one to use.
                // It makes sense to show it if there are alternates. If there are no alternates, we can hide it or show just Main.
                if (Array.isArray(altGreetings) && altGreetings.length > 0) {
                    fmSection.style.display = 'block';
                } else {
                    fmSection.style.display = 'none';
                }
            } else {
                fmSection.style.display = 'none';
            }
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    closeNewChatModal() {
        this.els.newModal.classList.remove('show');
    }

    async createNewChat() {
        const title = this.els.newTitle.value.trim() || 'New Chat';
        const sysPrompt = this.els.newSysPrompt.value.trim();
        const cardIds = (this.newChatSelectedCards || []).map(c => c.id);

        let userPersonaName = "User";
        let userPersonaAge = "";
        let userPersonaGender = "";
        let userPersonaDetail = "";

        let userPersonaCardId = null;

        const typeEl = document.querySelector('input[name="chat_user_persona_type"]:checked');
        const pType = typeEl ? typeEl.value : 'manual';

        if (pType === 'manual') {
            userPersonaName = this.els.newPersonaName.value.trim() || "User";
            userPersonaAge = this.els.newPersonaAge.value.trim();
            userPersonaGender = this.els.newPersonaGender.value.trim();
            userPersonaDetail = this.els.newPersonaDetail.value.trim();
        } else if (pType === 'card' && this.userPersonaSelectedCard) {
            userPersonaName = this.userPersonaSelectedCard.name || "User";
            userPersonaDetail = [this.userPersonaSelectedCard.description, this.userPersonaSelectedCard.personality]
                .filter(x => x).join('\n\n');
            userPersonaCardId = this.userPersonaSelectedCard.id;
        }

        let firstMessageIndex = -1;
        const fmSection = document.getElementById('chat-new-first-message-section');
        if (fmSection && fmSection.style.display !== 'none') {
            const fmSelect = document.getElementById('chat-new-first-message-select');
            if (fmSelect) {
                if (fmSelect.value === 'random') {
                    let altGreetings = [];
                    if (this.newChatSelectedCards.length === 1) {
                        let cardAlt = this.newChatSelectedCards[0].alternate_greetings;
                        if (typeof cardAlt === 'string' && cardAlt.trim().length > 0) {
                            try { altGreetings = JSON.parse(cardAlt); } catch (e) { }
                        } else if (Array.isArray(cardAlt)) {
                            altGreetings = cardAlt;
                        }
                    }
                    const numOptions = 1 + altGreetings.length;
                    firstMessageIndex = Math.floor(Math.random() * numOptions) - 1;
                } else {
                    const parsedVal = parseInt(fmSelect.value, 10);
                    if (!isNaN(parsedVal)) {
                        firstMessageIndex = parsedVal;
                    }
                }
            }
        }

        try {
            this.els.createSubmitBtn.disabled = true;
            this.els.createSubmitBtn.textContent = 'Creating...';

            if (pType === 'manual' && this.els.newPersonaSaveCheckbox && this.els.newPersonaSaveCheckbox.checked) {
                try {
                    await window.authFetch('/api/sw/personas', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: userPersonaName,
                            age: userPersonaAge,
                            gender: userPersonaGender,
                            detail: userPersonaDetail
                        })
                    });
                } catch (e) {
                    console.error("Failed to save persona", e);
                }
            }

            const payload = {
                title,
                system_prompt: sysPrompt,
                writing_style: this.els.newWritingStyle?.value || "",
                response_length: this.els.newResponseLength?.value || "",
                card_ids: cardIds,
                user_persona_name: userPersonaName,
                user_persona_age: userPersonaAge,
                user_persona_gender: userPersonaGender,
                user_persona_detail: userPersonaDetail,
                user_persona_card_id: userPersonaCardId,
                first_message_index: firstMessageIndex
            };

            const res = await window.authFetch('/api/sw/chats/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const newChat = await res.json();
                this.closeNewChatModal();
                await this.loadSessionList();
                this.selectChat(newChat.id);
            }
        } catch (e) {
            console.error("Failed to create chat", e);
        } finally {
            this.els.createSubmitBtn.disabled = false;
            this.els.createSubmitBtn.textContent = 'Start Chatting';
        }
    }

    async loadSessionList() {
        try {
            const res = await window.authFetch('/api/sw/chats/');
            if (!res.ok) return;
            this.chats = await res.json();

            // Pre-fill character data from localStorage cache
            const cache = this._loadCharCache();
            this.chats.forEach(chat => {
                if (!chat.characters && cache[String(chat.id)]) {
                    chat.characters = cache[String(chat.id)];
                }
            });

            this.renderSessionList();

            // Background-fetch character data for chats not yet in cache
            const missing = this.chats.filter(c => !c.characters || c.characters.length === 0);
            if (missing.length > 0) {
                this._fetchMissingCharacters(missing);
            }
        } catch (e) {
            console.error('Failed to load chat sessions', e);
        }
    }

    /* ── Character data cache (so lobby shows avatars without N extra API calls) ── */
    _loadCharCache() {
        try { return JSON.parse(localStorage.getItem('chatgen_char_cache') || '{}'); } catch { return {}; }
    }

    _saveToCharCache(chatId, chars) {
        try {
            const cache = this._loadCharCache();
            cache[String(chatId)] = (chars || []).map(c => ({ id: c.id, name: c.name }));
            localStorage.setItem('chatgen_char_cache', JSON.stringify(cache));
        } catch {}
    }

    async _fetchMissingCharacters(chats) {
        for (const chat of chats) {
            try {
                const res = await window.authFetch(`/api/sw/chats/${chat.id}`);
                if (!res.ok) continue;
                const detail = await res.json();
                chat.characters = detail.characters || [];
                this._saveToCharCache(chat.id, chat.characters);
                this._updateCardAvatars(chat);
            } catch {}
        }
    }

    _updateCardAvatars(chat) {
        const card = document.querySelector(`.chat-session-card[data-id="${chat.id}"]`);
        if (!card) return;
        const existingStrip = card.querySelector('.chat-card-avatars');
        if (!existingStrip) return;
        const newStrip = this._buildAvatarStrip(chat.characters || []);
        existingStrip.replaceWith(newStrip);
        const charsEl = card.querySelector('.chat-card-chars');
        if (charsEl) charsEl.textContent = (chat.characters || []).map(c => c.name).join(', ');
        else if (chat.characters && chat.characters.length > 0) {
            const info = card.querySelector('.chat-card-info');
            if (info) {
                const el = document.createElement('div');
                el.className = 'chat-card-chars';
                el.textContent = chat.characters.map(c => c.name).join(', ');
                info.insertBefore(el, info.children[1]);
            }
        }
    }

    _buildAvatarStrip(characters) {
        const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || '';
        const strip = document.createElement('div');

        if (characters.length === 0) {
            strip.className = 'chat-card-avatars';
            const ph = document.createElement('div');
            ph.className = 'chat-card-avatar-placeholder';
            ph.textContent = '\uD83D\uDCAC'; // 💬
            strip.appendChild(ph);
        } else if (characters.length === 1) {
            strip.className = 'chat-card-avatars';
            const ph = document.createElement('div');
            ph.className = 'chat-card-avatar-placeholder';
            ph.textContent = (characters[0].name || '?')[0].toUpperCase();
            strip.appendChild(ph);
            const img = document.createElement('img');
            img.className = 'chat-card-avatar';
            img.alt = characters[0].name || '';
            img.src = `/api/storage/cards/thumbnail?cardId=${characters[0].id}&token=${token}`;
            img.onerror = () => { img.style.display = 'none'; };
            strip.appendChild(img);
        } else {
            strip.className = 'chat-card-avatars multi';
            const widthPct = 100 / characters.length;
            characters.forEach((char, i) => {
                const slot = document.createElement('div');
                slot.style.cssText = `position:absolute; top:0; left:${widthPct * i}%; width:${widthPct}%; height:100%; overflow:hidden;`;
                const ph = document.createElement('div');
                ph.className = 'chat-card-avatar-placeholder';
                ph.style.cssText = 'position:absolute; inset:0; font-size:1.8rem;';
                ph.textContent = (char.name || '?')[0].toUpperCase();
                slot.appendChild(ph);
                const img = document.createElement('img');
                img.className = 'chat-card-avatar';
                img.alt = char.name || '';
                img.src = `/api/storage/cards/thumbnail?cardId=${char.id}&token=${token}`;
                img.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; object-position:top;';
                img.onerror = () => { img.style.display = 'none'; };
                slot.appendChild(img);
                strip.appendChild(slot);
            });
        }
        return strip;
    }

    renderSessionList() {
        const grid = this.els.sessionList;
        const emptyEl = this.els.lobbyEmpty;
        grid.innerHTML = '';

        if (this.chats.length === 0) {
            if (emptyEl) emptyEl.style.display = 'flex';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        this.chats.forEach(chat => {
            const card = document.createElement('div');
            card.className = 'chat-session-card';
            card.dataset.id = chat.id;

            /* ── Avatar strip (built via helper so _updateCardAvatars can reuse it) ── */
            card.appendChild(this._buildAvatarStrip(chat.characters || []));

            /* ── Text info ── */
            const info = document.createElement('div');
            info.className = 'chat-card-info';

            const titleEl = document.createElement('div');
            titleEl.className = 'chat-card-title';
            titleEl.textContent = chat.title;

            const charsEl = document.createElement('div');
            charsEl.className = 'chat-card-chars';
            charsEl.textContent = (chat.characters || []).map(c => c.name).join(', ');

            const dateEl = document.createElement('div');
            dateEl.className = 'chat-card-date';
            const d = new Date(chat.updated_at);
            dateEl.textContent = isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

            const msgCountEl = document.createElement('div');
            msgCountEl.className = 'chat-card-msg-count';
            const mc = chat.message_count ?? 0;
            msgCountEl.textContent = `💬 ${mc} msg${mc !== 1 ? 's' : ''}`;

            info.appendChild(titleEl);
            if ((chat.characters || []).length > 0) info.appendChild(charsEl);
            const metaRow = document.createElement('div');
            metaRow.className = 'chat-card-meta';
            metaRow.appendChild(dateEl);
            metaRow.appendChild(msgCountEl);
            info.appendChild(metaRow);
            card.appendChild(info);

            /* ── Delete button ── */
            const delBtn = document.createElement('button');
            delBtn.className = 'chat-card-delete';
            delBtn.title = 'Delete chat';
            delBtn.innerHTML = '🗑️';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`Delete "${chat.title}"?`)) {
                    await window.authFetch(`/api/sw/chats/${chat.id}`, { method: 'DELETE' });
                    if (this.activeChatId === chat.id) {
                        this.activeChatId = null;
                        this.showLobby();
                    }
                    this.loadSessionList();
                }
            };
            card.appendChild(delBtn);

            card.addEventListener('click', () => this.selectChat(chat.id));
            grid.appendChild(card);
        });
    }

    async loadPersonas() {
        if (!window.characterStorage) {
            setTimeout(() => this.loadPersonas(), 200);
            return;
        }
        try {
            const allCards = await window.characterStorage.listCards();
            this.availablePersonas = allCards.filter(c => c.isPermanent);

            this.availablePersonas.sort((a, b) => {
                const nameA = (a.characterName || (a.character && a.character.name) || a.name || 'Unnamed').toLowerCase();
                const nameB = (b.characterName || (b.character && b.character.name) || b.name || 'Unnamed').toLowerCase();
                return nameA.localeCompare(nameB);
            });

            if (this.els.userPersonaSelect) {
                const currentVal = localStorage.getItem('chatgen_active_user_persona') || '';

                this.els.userPersonaSelect.innerHTML = '<option value="">User (Default)</option>';
                this.availablePersonas.forEach(card => {
                    const opt = document.createElement('option');
                    opt.value = card.id;
                    const charName = card.characterName || (card.character && card.character.name) || card.name || 'Unnamed';
                    opt.textContent = charName;
                    this.els.userPersonaSelect.appendChild(opt);
                });

                let activeId = currentVal;
                if (this.activeChatId) {
                    activeId = localStorage.getItem(`chatgen_persona_${this.activeChatId}`) || currentVal;
                }

                if (this.availablePersonas.some(c => String(c.id) === String(activeId))) {
                    this.els.userPersonaSelect.value = activeId;
                } else {
                    this.els.userPersonaSelect.value = '';
                    if (!this.activeChatId) {
                        localStorage.removeItem('chatgen_active_user_persona');
                    }
                }
            }
        } catch (e) {
            console.error("Failed to load personas", e);
        } finally {
            this._personasLoaded = true;
        }
    }

    async selectChat(chatId) {
        this.activeChatId = chatId;

        // Switch to the active chat view
        this.showChatView();

        // Prevent race condition: wait for personas to load before rendering messages
        let waitCount = 0;
        while (!this._personasLoaded && waitCount < 20) {
            await new Promise(r => setTimeout(r, 100));
            waitCount++;
        }

        try {
            const res = await window.authFetch(`/api/sw/chats/${chatId}`);
            if (!res.ok) return;
            const chat = await res.json();

            this.els.activeTitle.textContent = chat.title;
            this.els.activeChars.textContent = chat.characters.map(c => c.name).join(', ') || 'No characters linked';
            this.activeChatCharacters = chat.characters || [];
            // Cache character data for lobby avatars
            this._saveToCharCache(chatId, this.activeChatCharacters);
            this._applyChatBackground();
            this._renderHeaderAvatars();

            // Group chats choose who replies next from the composer's tray.
            // sendMessage reads the select only while it's displayed.
            if (this.els.speakerSelect) {
                const isGroup = chat.characters.length > 1;
                this.els.speakerSelect.innerHTML = '';
                if (isGroup) {
                    this.els.speakerSelect.innerHTML = '<option value="">Auto (router)</option>';
                    chat.characters.forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.name;
                        opt.textContent = c.name;
                        this.els.speakerSelect.appendChild(opt);
                    });
                }
                this.els.speakerSelect.style.display = isGroup ? '' : 'none';
                if (this.els.speakerWrap) this.els.speakerWrap.style.display = isGroup ? '' : 'none';
            }
            this._closePopovers();
            this._updateToolsBadge();

            if (this.els.userPersonaSelect) {
                const savedPersona = localStorage.getItem(`chatgen_persona_${chatId}`) || localStorage.getItem('chatgen_active_user_persona') || '';
                if (this.availablePersonas && this.availablePersonas.some(c => String(c.id) === String(savedPersona))) {
                    this.els.userPersonaSelect.value = savedPersona;
                } else {
                    this.els.userPersonaSelect.value = '';
                }
            }

            // Don't arbitrarily hide the banner if the server is still generating
            const lastMsg = chat.messages && chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null;
            const serverIsGenerating = lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '';
            if (serverIsGenerating) {
                this._showPendingGenerationBanner(lastMsg.id, true);
                this.isGenerating = true;
            } else {
                this._hidePendingGenerationBanner();
                this.isGenerating = false;
            }
            this.els.timeline.innerHTML = '';
            this.isUserScrolling = false;
            if (this.els.fab) { this.els.fab.style.display = 'none'; this.els.fab.classList.remove('has-new'); }

            // Ensure messages are sorted chronologically (oldest first)
            const sortedMessages = (chat.messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            sortedMessages.forEach(msg => this.appendMessage(msg));

            if (chat.messages.length === 0) {
                this.els.timeline.innerHTML = '<div class="chat-placeholder"><p>No messages yet. Send a greeting!</p></div>';
            } else {
                setTimeout(() => this.scrollToBottom(false), 50);
            }

            this.els.msgInput.disabled = serverIsGenerating;
            this.els.sendBtn.disabled = serverIsGenerating;
            if (this.els.impBtn) this.els.impBtn.disabled = serverIsGenerating;
        } catch (e) {
            console.error("Failed to load chat details", e);
        }
    }

    // Resolves an explicit card id, falling back to a name match against the
    // active chat's cast — shared by getAvatarUrl and the gallery click
    // handlers, which need the resolved id to fetch that card's gallery.
    _resolveCardId(characterName, cardId = null) {
        let id = cardId;
        if (!id && this.activeChatCharacters) {
            const char = this.activeChatCharacters.find(c => c.name === characterName);
            if (char) id = char.id;
        }
        return id || null;
    }

    getAvatarUrl(characterName, cardId = null) {
        const id = this._resolveCardId(characterName, cardId);
        if (id) {
            const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || "";
            return `/api/storage/cards/thumbnail?cardId=${id}&token=${token}`;
        }
        return null;
    }

    // Sets the faded character-portrait backdrop on the chat timeline.
    // Group chats use the first character — there's no natural way to blend
    // several without picking one, and this keeps it simple.
    _applyChatBackground() {
        if (!this.els.timeline) return;
        const bgChar = this.activeChatCharacters && this.activeChatCharacters[0];
        const bgUrl = bgChar ? this.getAvatarUrl(bgChar.name, bgChar.id) : null;
        this.els.timeline.style.setProperty('--chat-bg-image', bgUrl ? `url("${bgUrl}")` : 'none');
    }

    // Up to two faces beside the title (the rest are named underneath).
    _renderHeaderAvatars() {
        const box = this.els.headerAvatars;
        if (!box) return;
        box.innerHTML = '';
        (this.activeChatCharacters || []).slice(0, 2).forEach(c => {
            const url = this.getAvatarUrl(c.name, c.id);
            const el = document.createElement(url ? 'img' : 'span');
            if (url) { el.src = url; el.alt = ''; }
            else el.textContent = (c.name || '?').substring(0, 2).toUpperCase();
            box.appendChild(el);
        });
    }

    // Fills a message's avatar slot: the card's portrait (tap opens its
    // gallery) or the name's initials.
    _fillAvatar(avatarEl, name, cardId) {
        const avatarUrl = this.getAvatarUrl(name, cardId);
        avatarEl.innerHTML = '';
        if (!avatarUrl) {
            avatarEl.textContent = (name || '?').substring(0, 2).toUpperCase();
            return;
        }
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = '';
        img.className = 'chat-avatar-char-img';
        const resolvedCardId = this._resolveCardId(name, cardId);
        img.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.app && window.app.openCardImageGallery) {
                window.app.openCardImageGallery(resolvedCardId, avatarUrl, name || 'Character');
            }
        });
        avatarEl.appendChild(img);
    }

    _oocDetailsEl(note) {
        const oocEl = document.createElement('details');
        oocEl.style.marginTop = '0.5rem';
        oocEl.style.fontSize = '0.82rem';
        oocEl.innerHTML = `<summary style="cursor: pointer; opacity: 0.7; font-weight: 500;">OOC Instruction</summary><div style="margin-top: 0.25rem; font-style: italic; opacity: 0.8; padding-left: 0.5rem; border-left: 2px solid var(--border);">${this.escapeHtml(note)}</div>`;
        return oocEl;
    }

    getUserPersonaData() {
        if (!this.activeChatId || !this.chats) return null;
        const chat = this.chats.find(c => c.id === this.activeChatId);
        if (!chat) return null;

        return {
            name: chat.user_persona_name || 'User',
            id: chat.user_persona_card_id || null
        };
    }

    /**
     * Generate a deterministic colour from a string (for character accent in group chats)
     */
    _charColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
            hash = hash & hash;
        }
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 55%, 45%)`;
    }

    appendMessage(msg) {
        const placeholder = this.els.timeline.querySelector('.chat-placeholder');
        if (placeholder) placeholder.remove();

        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper ${msg.role}`;

        // Tapping a message shows its actions (one message at a time); tapping
        // it again hides them. Taps on its own controls, links, reasoning
        // blocks or a text selection don't count.
        wrapper.addEventListener('click', (e) => {
            if (e.target.closest('.chat-message-actions-bar, .chat-avatar-char-img, summary, a, button, img, .chat-reply-status')) return;
            if (String(window.getSelection?.() || '').length > 0) return;
            document.querySelectorAll('.chat-bubble-wrapper.actions-visible').forEach(el => {
                if (el !== wrapper) el.classList.remove('actions-visible');
            });
            wrapper.classList.toggle('actions-visible');
        });

        let displayCharName = msg.character_name;
        if ((!displayCharName || displayCharName === 'Routing...') && this.activeChatCharacters && this.activeChatCharacters.length === 1) {
            displayCharName = this.activeChatCharacters[0].name;
        }
        const charName = displayCharName || 'Assistant';

        const userPersona = this.getUserPersonaData();
        const userName = userPersona ? (userPersona.name || 'User') : 'User';

        // ── Name row with timestamp ──
        const nameEl = document.createElement('div');
        nameEl.className = 'chat-bubble-name';

        const nameText = document.createElement('span');
        nameText.className = 'chat-bubble-name-text';
        nameText.textContent = msg.role === 'user' ? userName : charName;
        nameEl.appendChild(nameText);

        // Timestamp
        if (msg.created_at) {
            const timeEl = document.createElement('span');
            timeEl.className = 'chat-bubble-time';
            timeEl.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            nameEl.appendChild(timeEl);
        }

        // ── Bubble ──
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'chat-bubble';

        // Character accent colour for group chats
        if (msg.role !== 'user' && charName && this.activeChatCharacters && this.activeChatCharacters.length > 1) {
            bubbleEl.setAttribute('data-char-accent', charName);
            bubbleEl.style.borderLeftColor = this._charColor(charName);
        }

        let contentStr = msg.content || '';
        bubbleEl.innerHTML = this.formatMessage(contentStr, msg.character_name);

        if (msg.ooc_note) bubbleEl.appendChild(this._oocDetailsEl(msg.ooc_note));

        // ── Avatar ──
        const avatarEl = document.createElement('div');
        avatarEl.className = 'chat-avatar-container';
        if (msg.role === 'user') {
            if (userPersona) this._fillAvatar(avatarEl, userName, userPersona.id);
            else avatarEl.textContent = 'U';
        } else {
            this._fillAvatar(avatarEl, charName, msg.character_card_id);
        }

        // ── Content column ──
        const contentCol = document.createElement('div');
        contentCol.className = 'chat-bubble-content-col';
        contentCol.appendChild(nameEl);
        contentCol.appendChild(bubbleEl);

        wrapper.appendChild(avatarEl);
        wrapper.appendChild(contentCol);

        this.els.timeline.appendChild(wrapper);

        if (msg.id) {
            this.attachMessageActions(wrapper, msg, bubbleEl, nameEl);
        }

        return wrapper;
    }

    attachMessageActions(wrapper, msg, bubbleEl, nameEl) {
        if (wrapper.querySelector('.chat-message-actions-bar')) return;

        const actionBar = document.createElement('div');
        actionBar.className = 'chat-message-actions-bar';

        const actionsEl = document.createElement('div');
        actionsEl.className = 'chat-message-actions';
        actionsEl.style.display = 'flex';
        actionsEl.style.gap = '0.5rem';

        const genImageBtn = document.createElement('button');
        genImageBtn.className = 'chat-action-btn';
        genImageBtn.innerHTML = '🖼️ Gen Image';
        genImageBtn.title = 'Generate a scene image based on this message';
        genImageBtn.onclick = () => this.handleGenerateSceneImage(msg.id, wrapper, bubbleEl);

        const editBtn = document.createElement('button');
        editBtn.className = 'chat-action-btn';
        editBtn.innerHTML = '✏️ Edit';
        editBtn.onclick = () => this.editMessage(msg, bubbleEl, wrapper);

        const delBtn = document.createElement('button');
        delBtn.className = 'chat-action-btn';
        delBtn.innerHTML = '🗑️';
        delBtn.onclick = () => this.deleteMessage(msg.id, wrapper);

        actionsEl.appendChild(genImageBtn);
        actionsEl.appendChild(editBtn);
        actionsEl.appendChild(delBtn);

        // Regen button — only on assistant messages, visibility managed by _updateRegenButtons()
        if (msg.role === 'assistant') {
            const regenBtn = document.createElement('button');
            regenBtn.className = 'chat-action-btn chat-regen-btn';
            regenBtn.innerHTML = '🔄 Regen';
            regenBtn.title = 'Regenerate this response';
            regenBtn.style.display = 'none'; // hidden by default; _updateRegenButtons shows it on the last AI msg
            regenBtn.onclick = () => this.regenerateLastMessage(msg.id, wrapper);
            actionsEl.appendChild(regenBtn);
        }

        actionBar.appendChild(actionsEl);
        // Append inline action bar below the bubble, inside the content column
        bubbleEl.parentElement.appendChild(actionBar);

        // Refresh which assistant bubble shows the Regen button
        this._updateRegenButtons();
    }

    /** Only the last assistant bubble offers Regen, and it keeps its actions on show. */
    _updateRegenButtons() {
        const allAssistantWrappers = Array.from(
            this.els.timeline.querySelectorAll('.chat-bubble-wrapper.assistant')
        );
        allAssistantWrappers.forEach((w, idx) => {
            const isLast = idx === allAssistantWrappers.length - 1;
            w.classList.toggle('is-latest-ai', isLast && !!w.querySelector('.chat-message-actions-bar'));
            const btn = w.querySelector('.chat-regen-btn');
            if (btn) btn.style.display = isLast ? '' : 'none';
        });
    }

    /**
     * Delete the last AI message from the server then generate a brand-new response
     * in its place — without sending any new user message.
     */
    async regenerateLastMessage(messageId, wrapper) {
        if (!this.activeChatId || this.isGenerating) return;

        // 1. Delete the existing assistant message from the server
        try {
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${messageId}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                console.error('Failed to delete message before regen');
                return;
            }
        } catch (e) {
            console.error('Regen delete error', e);
            return;
        }

        // 2. Remove the bubble from the DOM
        wrapper.remove();
        this._updateRegenButtons();

        // 3. Determine speaker for this chat
        let characterName = null;
        if (this.els.speakerSelect && this.els.speakerSelect.style.display !== 'none') {
            characterName = this.els.speakerSelect.value || null;
        }

        // 4. Stream a fresh AI response (no new user message)
        this._setGeneratingUI(true);

        const aiMsgObj = { role: 'assistant', character_name: characterName || 'Routing...', content: '' };
        const aiBubbleWrapper = this.appendMessage(aiMsgObj);
        const contentEl = aiBubbleWrapper.querySelector('.chat-bubble');
        const anchor = this._startReplyScroll(null, aiBubbleWrapper);

        this.abortController = new AbortController();
        let serverAiMsgId = null;
        let dropped = false;

        try {
            const payload = {
                content: '',          // no new user text
                ooc_note: '',
                character_name: characterName
            };

            if (window.config) {
                payload.max_input_tokens = window.config.get('chat.maxInputTokens');
                payload.max_output_tokens = window.config.get('chat.maxOutputTokens');
                payload.temperature = window.config.get('chat.temperature');
                payload.top_p = window.config.get('chat.topP');
                payload.repetition_penalty = window.config.get('chat.repetitionPenalty');
            }

            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: this.abortController.signal
            });

            if (!res.ok) throw new Error('Regen API Request Failed');

            let fullText = '';
            await this._readChatStream(res, this.abortController, () => serverAiMsgId, (data) => {
                if (data.type === 'metadata') {
                    if (data.assistant_message_id) serverAiMsgId = data.assistant_message_id;
                    this._applyReplyMetadata(data, aiMsgObj, aiBubbleWrapper);
                    // user_message_id will be null since we sent empty content/ooc_note
                } else if (data.type === 'chunk') {
                    fullText += data.content;
                    aiMsgObj.content = fullText;
                    contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                    this._followReply(anchor);
                } else if (data.type === 'corrected_content') {
                    // Backend injected <think> tags that the model forgot to output.
                    fullText = data.content;
                    aiMsgObj.content = fullText;
                    contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                    this._followReply(anchor);
                } else if (data.type === 'error') {
                    console.error('Regen generation error:', data.message);
                    contentEl.innerHTML += `<br><span style="color:var(--error);">Error: ${this.escapeHtml(data.message)}</span>`;
                }
            });
        } catch (e) {
            if (e.name !== 'AbortError') {
                // Dropped or stalled (e.g. phone lock). The old message is already
                // deleted; the backend carries on and saves the new one.
                console.error('Regen stream error', e);
                dropped = true;
            }
        } finally {
            this.abortController = null;
        }

        if (dropped) {
            if (serverAiMsgId) {
                await this._recoverReply({ replyId: serverAiMsgId, wrapper: aiBubbleWrapper, contentEl, msgObj: aiMsgObj });
            } else {
                this._setGeneratingUI(false);
                if (this.activeChatId) await this.selectChat(this.activeChatId).catch(() => {});
            }
            return;
        }

        this._setGeneratingUI(false);
        this._focusInput();
        if (serverAiMsgId && !aiMsgObj.id) {
            aiMsgObj.id = serverAiMsgId;
            this.attachMessageActions(aiBubbleWrapper, aiMsgObj, contentEl, aiBubbleWrapper.querySelector('.chat-bubble-name'));
            return;
        }
        // Fallback when the metadata event never arrived: find the id from the chat.
        window.authFetch(`/api/sw/chats/${this.activeChatId}`).then(r => r.json()).then(chat => {
            if (chat && chat.messages && this.activeChatId === chat.id) {
                const lastAi = chat.messages.slice().reverse().find(m => m.role === 'assistant');
                if (lastAi && !aiMsgObj.id) {
                    aiMsgObj.id = lastAi.id;
                    this.attachMessageActions(aiBubbleWrapper, aiMsgObj, contentEl, aiBubbleWrapper.querySelector('.chat-bubble-name'));
                }
            }
        }).catch(e => console.error('Error fetching chat after regen', e));
    }

    async handleGenerateSceneImage(messageId, wrapper, bubbleEl) {
        if (!this.activeChatId) return;

        // Determine which image provider to use
        const forgeEnabled = window.config?.get("api.image.localForge.enabled") || false;
        const forgeUrl = window.config?.get("api.image.localForge.url") || "http://127.0.0.1:7860";

        // Cloud (NanoGPT / OpenAI-compatible) credentials — only used when Forge is off
        const base_url = forgeEnabled ? null : (window.config?.get("api.image.baseUrl") || null);
        const api_key = forgeEnabled ? null : (window.config?.get("api.image.apiKey") || null);
        // Text-to-image, so it needs a model marked 🪄 Generate. There is no
        // dropdown here — the scene image is a one-click action — so taking
        // models[0] blind meant that if an image-to-image model happened to sit
        // first in the list, every scene image was generated by a model that
        // wanted a source image and never got one.
        const model = firstImageModelWithCapability("generate") || null;
        const size = window.config?.get("api.image.size") || "1024x1024";

        // Inject loading spinner inside the bubble
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'chat-scene-image-loading';
        const providerLabel = forgeEnabled ? `🔧 Forge (${forgeUrl})` : '☁️ Cloud API';
        loadingDiv.innerHTML = `
            <div class="loading-spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
            <span>Visualizing scene via ${providerLabel}...</span>
        `;
        loadingDiv.id = `loading-image-${messageId}`;
        bubbleEl.appendChild(loadingDiv);
        this.scrollToBottom();

        try {
            const payload = { base_url, api_key, model, size };
            if (forgeEnabled) payload.forge_url = forgeUrl;

            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${messageId}/generate-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                let errDetail = `Server error ${res.status}`;
                try {
                    const errJson = await res.json();
                    errDetail = errJson.detail || errDetail;
                } catch (_) {
                    errDetail = await res.text() || errDetail;
                }

                // Surface Forge-specific guidance clearly
                if (forgeEnabled && (res.status === 503 || res.status === 502)) {
                    throw new Error(`🔧 Local Forge unreachable: ${errDetail}`);
                }
                throw new Error(errDetail);
            }

            loadingDiv.remove();
            // Refresh the message from DB to sync the newly appended <scene-image> XML tag
            const msgRes = await window.authFetch(`/api/sw/chats/${this.activeChatId}`);
            if (msgRes.ok) {
                const chat = await msgRes.json();
                const updatedMsg = chat.messages.find(m => m.id === messageId);
                if (updatedMsg) {
                    bubbleEl.innerHTML = this.formatMessage(updatedMsg.content, updatedMsg.character_name);
                    this.scrollToBottom();
                }
            }
        } catch (error) {
            console.error('Image generation error:', error);
            loadingDiv.innerHTML = `<span style="color: var(--error);">⚠️ ${this.escapeHtml(error.message)}</span>`;
            setTimeout(() => loadingDiv.remove(), 5000);
        }
    }

    // Editing happens in a full-screen sheet sized to the visible viewport,
    // with Cancel and Save in its header: editing inside the bubble left the
    // controls where the iPhone keyboard could push them out of reach.
    async editMessage(msg, bubbleEl, wrapper) {
        if (document.getElementById('chat-edit-sheet')) return;

        const who = msg.role === 'user' ? 'your message' : (msg.character_name || 'message');
        const sheet = document.createElement('div');
        sheet.id = 'chat-edit-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', 'Edit message');
        sheet.innerHTML = `
            <div class="ces-header">
                <button type="button" class="btn-outline ces-cancel">Cancel</button>
                <span class="ces-title">Edit ${this.escapeHtml(who)}</span>
                <button type="button" class="btn-primary ces-save">Save</button>
            </div>
            ${msg.role === 'assistant' ? `<div class="ces-tools"><button type="button" class="btn-outline ces-think" title="Insert a closing think tag at the cursor, then save">Insert &lt;/think&gt; &amp; save</button></div>` : ''}
            <textarea class="ces-text" spellcheck="true" aria-label="Message text"></textarea>`;
        document.body.appendChild(sheet);
        this._syncVisualViewport();

        const textarea = sheet.querySelector('.ces-text');
        const saveBtn = sheet.querySelector('.ces-save');
        textarea.value = msg.content || '';

        const close = () => {
            document.removeEventListener('keydown', onKey);
            sheet.remove();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
        sheet.querySelector('.ces-cancel').onclick = close;

        const insertThinkBtn = sheet.querySelector('.ces-think');
        if (insertThinkBtn) {
            insertThinkBtn.onclick = () => {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                textarea.value = text.substring(0, start) + '\n</think>\n' + text.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 10;
                saveBtn.click();
            };
        }

        saveBtn.onclick = async () => {
            const newContent = textarea.value.trim();
            try {
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving…';
                const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${msg.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: newContent })
                });
                if (res.ok) {
                    msg.content = newContent;
                    close();
                    bubbleEl.innerHTML = this.formatMessage(msg.content, msg.character_name);
                    if (msg.ooc_note) bubbleEl.appendChild(this._oocDetailsEl(msg.ooc_note));
                } else {
                    alert('Failed to save message');
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                }
            } catch (e) {
                console.error(e);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        };

        // Start at the top of the message; the caret goes where it's tapped.
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(0, 0);
        textarea.scrollTop = 0;
    }

    async deleteMessage(id, wrapper) {
        let truncate = false;

        // Check if there are subsequent messages
        let isLast = true;
        let next = wrapper.nextElementSibling;
        while (next) {
            if (next.classList.contains('chat-bubble-wrapper')) {
                isLast = false;
                break;
            }
            next = next.nextElementSibling;
        }

        if (!isLast) {
            // Ask user whether to truncate or delete just this one
            const choice = await new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';
                overlay.style.display = 'flex';
                overlay.style.zIndex = '9999';

                const modal = document.createElement('div');
                modal.className = 'api-settings-modal';
                modal.style.maxWidth = '400px';
                modal.style.width = '90%';

                modal.innerHTML = `
                    <div class="modal-header">
                        <h2 class="modal-title">Delete Message</h2>
                        <button class="modal-close">×</button>
                    </div>
                    <div class="modal-body" style="padding-bottom: 1.5rem;">
                        <p style="margin-bottom: 1.5rem; font-size: 0.95rem; color: var(--text-primary);">
                            Do you want to delete only this message, or this message AND all following messages in this chat?
                        </p>
                        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                            <button id="del-btn-single" class="btn-outline" style="padding: 0.75rem;">Delete Just This Message</button>
                            <button id="del-btn-all" class="btn-primary" style="padding: 0.75rem; background: var(--error); border-color: var(--error);">Delete This & All Following</button>
                            <button id="del-btn-cancel" class="btn-outline" style="padding: 0.75rem;">Cancel</button>
                        </div>
                    </div>
                `;

                overlay.appendChild(modal);
                document.body.appendChild(overlay);

                const close = () => {
                    document.body.removeChild(overlay);
                };

                modal.querySelector('.modal-close').onclick = () => { close(); resolve('cancel'); };
                modal.querySelector('#del-btn-cancel').onclick = () => { close(); resolve('cancel'); };
                modal.querySelector('#del-btn-single').onclick = () => { close(); resolve('single'); };
                modal.querySelector('#del-btn-all').onclick = () => { close(); resolve('all'); };
            });

            if (choice === 'cancel') return;
            truncate = (choice === 'all');
        } else {
            if (!confirm('Are you sure you want to delete this message?')) return;
        }

        try {
            const url = `/api/sw/chats/${this.activeChatId}/messages/${id}` + (truncate ? '?truncate=true' : '');
            const res = await window.authFetch(url, {
                method: 'DELETE'
            });
            if (res.ok) {
                if (truncate) {
                    let curr = wrapper;
                    while (curr) {
                        let nxt = curr.nextElementSibling;
                        if (curr.classList.contains('chat-bubble-wrapper')) {
                            curr.remove();
                        }
                        curr = nxt;
                    }
                } else {
                    wrapper.remove();
                }
                this._updateRegenButtons();
            } else {
                alert('Failed to delete message');
            }
        } catch (e) {
            console.error(e);
        }
    }

    formatMessage(text, characterName = null) {
        if (!text) return "";
        let parsed = text;

        let charName = characterName;
        // Fallback for user messages in a 1-on-1 chat
        if (!charName && this.activeChatCharacters && this.activeChatCharacters.length === 1) {
            charName = this.activeChatCharacters[0].name;
        }
        charName = charName || "Character";

        const userPersona = this.getUserPersonaData();
        const userName = userPersona ? (userPersona.characterName || (userPersona.character && userPersona.character.name) || userPersona.name || "User") : "User";

        parsed = parsed.replace(/\{\{char\}\}/gi, charName);
        parsed = parsed.replace(/\{\{user\}\}/gi, userName);

        // Strip CJK characters if enabled in settings
        if (window.config && window.config.get("chat.filterCJK")) {
            parsed = parsed.replace(/[\u2E80-\u2FD5\u3190-\u319f\u3400-\u4DBF\u4E00-\u9FCC\uF900-\uFAAD\uAC00-\uD7A3]/g, '');
        }

        // ══════════════════════════════════════════════════════════════════
        // STEP 1 — CoT Extraction
        // Extract <think>…</think> blocks before any other processing.
        // This single-pass pipeline handles all known model quirks:
        //   • Full-width CJK brackets (＜think＞)
        //   • <thinking> / <Thinking> variants
        //   • Orphaned numeric closing tags (</1>, </2> …)
        //   • Arbitrary leading tag names (<reasoning>, <analysis> …)
        //   • GLM-style \n---\n separator
        //   • Preamble text before <think> (primary bleed-through cause)
        //   • Mid-stream unclosed blocks
        //   • Orphaned closing tags without an opener
        // ══════════════════════════════════════════════════════════════════

        // 1a. Full-width bracket normalisation
        parsed = parsed.replace(/＜/g, '<').replace(/＞/g, '>');

        // 1b. <thinking> → <think> normalisation
        parsed = parsed.replace(/<thinking>/gi, '<think>').replace(/<\/thinking>/gi, '</think>');

        // 1c. Orphaned numeric closer (e.g. </1>) → </think> when opener is present
        if (parsed.includes('<think>') && !parsed.includes('</think>')) {
            parsed = parsed.replace(/<\/\d+>/i, '</think>');
        }

        // 1d. Leading unknown tag → treat as <think> block (e.g. <reasoning>…</reasoning>)
        if (!parsed.includes('<think>') && !parsed.includes('</think>')) {
            const leadingTagMatch = parsed.match(/^\s*<([a-zA-Z][a-zA-Z0-9_-]*|[0-9]+)>/);
            if (leadingTagMatch) {
                const knownRichEl = /^(text-message|task|stat-bar|scene-image)$/i;
                const tagName = leadingTagMatch[1];
                if (!knownRichEl.test(tagName) && new RegExp(`</${tagName}>`, 'i').test(parsed)) {
                    parsed = parsed.replace(new RegExp(`<${tagName}>`, 'gi'), '<think>');
                    parsed = parsed.replace(new RegExp(`</${tagName}>`, 'gi'), '</think>');
                }
            }
        }

        // 1e. GLM-style \n---\n separator → wrap as <think> block
        if (!parsed.includes('<think>') && !parsed.includes('</think>')) {
            const sepIdx = parsed.indexOf('\n---\n');
            if (sepIdx > 0) {
                const thinkContent = parsed.slice(0, sepIdx).trim();
                const storyContent = parsed.slice(sepIdx + 5).trim();
                if (thinkContent && storyContent) {
                    parsed = `<think>\n${thinkContent}\n</think>\n${storyContent}`;
                }
            }
        }

        // 1f. Preamble stripping — THE primary bleed-through fix.
        // If the model emitted any text before the opening <think> tag, strip it
        // entirely. It is stray reasoning / formatting artefact, not story prose.
        if (parsed.includes('<think>')) {
            const openIdx = parsed.search(/<think>/i);
            if (openIdx > 0) {
                parsed = parsed.slice(openIdx); // discard everything before <think>
            }
        }

        // 1g. Orphaned </think> without opener → inject <think> at start
        if (parsed.includes('</think>') && !parsed.includes('<think>')) {
            parsed = '<think>\n' + parsed;
        }

        // 1h. Mid-stream: <think> present but no </think> yet.
        // Replace the entire unclosed reasoning block (and anything after it)
        // with an invisible placeholder so no raw thinking text leaks to the user.
        // Whatever story text appeared *before* <think> was already stripped in 1f,
        // so there is nothing visible to preserve here.
        if (parsed.includes('<think>') && !parsed.includes('</think>')) {
            parsed = parsed.replace(/<think>[\s\S]*/i, '<span class="chat-think-streaming" style="display:none;"></span>');
        }

        // ══════════════════════════════════════════════════════════════════
        // STEP 2 — Rich-tag extraction
        // Pull out all structured XML tags (including closed <think> blocks)
        // into a side-array so they survive HTML-escaping untouched.
        // ══════════════════════════════════════════════════════════════════
        const richTags = [];
        const placeholderRegex = /%%RICH_TAG_(\d+)%%/g;

        const extractTag = (match) => {
            richTags.push(match);
            return `%%RICH_TAG_${richTags.length - 1}%%`;
        };

        // Extract the mid-stream hidden span FIRST so it survives escapeHtml() in Step 3.
        parsed = parsed.replace(/<span class="chat-think-streaming"[^>]*><\/span>/g, extractTag);
        parsed = parsed.replace(/<text-message[\s\S]*?<\/text-message>/gi, extractTag);
        parsed = parsed.replace(/<task[\s\S]*?<\/task>/gi, extractTag);
        parsed = parsed.replace(/<stat-bar[\s\S]*?(?:\/>|<\/stat-bar>|>)/gi, extractTag);
        parsed = parsed.replace(/<scene-image[\s\S]*?<\/scene-image>/gi, extractTag);

        // Loop until stable — handles multiple / adjacent <think>…</think> pairs.
        let prevParsed;
        do {
            prevParsed = parsed;
            parsed = parsed.replace(/<think>[\s\S]*?<\/think>/gi, extractTag);
        } while (parsed !== prevParsed);

        // Last-resort: strip any surviving stray unpaired tags
        parsed = parsed.replace(/<think>/gi, '').replace(/<\/think>/gi, '');

        // ══════════════════════════════════════════════════════════════════
        // STEP 3 — HTML escape & Markdown
        // ══════════════════════════════════════════════════════════════════
        parsed = this.escapeHtml(parsed);

        parsed = parsed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        parsed = parsed.replace(/\*([^*]+)\*/g, "<em>$1</em>");
        parsed = parsed.replace(/&quot;([\s\S]*?)&quot;/g, '<span style="color: var(--accent, #8b5cf6); font-weight: 500;">&quot;$1&quot;</span>');
        parsed = parsed.replace(/\u201c([\s\S]*?)\u201d/g, '<span style="color: var(--accent, #8b5cf6); font-weight: 500;">&ldquo;$1&rdquo;</span>');
        parsed = parsed.replace(/^&gt; (.*)$/gm, '<blockquote style="border-left: 3px solid var(--accent); padding-left: 0.75rem; margin: 0.5rem 0; color: var(--text-secondary); font-style: italic;">$1</blockquote>');

        // ══════════════════════════════════════════════════════════════════
        // STEP 4 — Restore rich tags & render
        // ══════════════════════════════════════════════════════════════════
        parsed = parsed.replace(placeholderRegex, (match, index) => richTags[index]);

        // Process <scene-image> tags into clickable image wrappers
        parsed = parsed.replace(/<scene-image\s+src="([^"]+)"\s+prompt="([^"]*)"\s*(?:><\/scene-image>|\/?>)/g, (match, url, prompt) => {
            return `
                <div class="chat-scene-image-wrapper" onclick="if(window.app && window.app.openGallery) window.app.openGallery([{url: '${url}', prompt: decodeURIComponent('${encodeURIComponent(prompt)}'), label: 'Chat Scene'}]);">
                    <img src="${url}" alt="Generated Scene" class="chat-scene-image">
                    <div class="gallery-trigger-overlay">🔍</div>
                </div>
            `;
        });

        // Pass through RichElementParser for <think>, <text-message>, <task>, <stat-bar>
        if (window.RichElementParser) {
            parsed = window.RichElementParser.parse(parsed);
        }

        parsed = parsed.replace(/\n/g, '<br>');
        return parsed;
    }

    scrollToBottom(smooth = false, force = false) {
        if (!this.els.timeline) return;

        if (this.isUserScrolling && !force) return;

        this.els.timeline.scrollTo({
            top: this.els.timeline.scrollHeight,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }

    /* ── Reply scrolling ───────────────────────────────────────────────────── */
    // A long reply is read from its top while it's still being written. So on
    // send, scroll to the user's message (or the reply itself, if the message
    // is long), and while text arrives follow it only until that point reaches
    // the top of the screen; after that the ↓ button lights up instead. Jump
    // to the bottom and it follows from there.
    _startReplyScroll(userWrapper, aiWrapper) {
        const t = this.els.timeline;
        const pick = userWrapper && userWrapper.offsetHeight < t.clientHeight * 0.4 ? userWrapper : aiWrapper;
        const anchor = Math.max(0, pick.offsetTop - 12);
        t.scrollTop = Math.min(t.scrollHeight - t.clientHeight, anchor);
        this.isUserScrolling = false;
        return anchor;
    }

    _followReply(anchor) {
        const t = this.els.timeline;
        if (!t) return;
        if (!this.isUserScrolling) {
            const max = t.scrollHeight - t.clientHeight;
            const top = t.scrollTop > anchor ? max : Math.min(max, anchor);
            if (top > t.scrollTop) t.scrollTop = top;
        }
        this._noteStreamGrowth();
    }

    _noteStreamGrowth() {
        const t = this.els.timeline;
        if (!t || !this.els.fab) return;
        if (t.scrollHeight - t.clientHeight - t.scrollTop > 50) {
            this.els.fab.style.display = 'flex';
            this.els.fab.classList.add('has-new');
        }
    }

    /* ── Reply streams ─────────────────────────────────────────────────────── */
    _setGeneratingUI(on) {
        this.isGenerating = on;
        this.els.sendBtn.style.display = on ? 'none' : '';
        this.els.sendBtn.disabled = false;
        if (this.els.stopBtn) this.els.stopBtn.style.display = on ? '' : 'none';
        if (this.els.impBtn) this.els.impBtn.disabled = on;
    }

    // Name and portrait arrive in the metadata event, once the router has
    // picked who replies.
    _applyReplyMetadata(data, msgObj, wrapper) {
        if (data.character_name) {
            const nameTextEl = wrapper.querySelector('.chat-bubble-name-text');
            if (nameTextEl) nameTextEl.textContent = data.character_name;
            msgObj.character_name = data.character_name;
        }
        if (data.character_card_id) {
            msgObj.character_card_id = data.character_card_id;
            const avatarDiv = wrapper.querySelector('.chat-avatar-container');
            if (avatarDiv) this._fillAvatar(avatarDiv, msgObj.character_name, data.character_card_id);
        }
    }

    // Reads a /api/sw reply stream, calling onEvent(data) for each JSON event.
    // 45 s without a byte (the backend pings every 15 s) counts as a dropped
    // connection: the read is aborted and a StreamStall error thrown, so the
    // caller can fetch the saved reply instead. Per CLAUDE.md's iOS rules the
    // watchdog ignores time the page spent hidden or asleep, since iOS freezes
    // timers while locked and fires the overdue ones the instant it wakes.
    async _readChatStream(res, controller, getReplyId, onEvent) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastByteAt = Date.now();
        let lastTick = Date.now();
        let stalled = false;
        const stall = () => {
            if (stalled) return;
            stalled = true;
            controller.abort();
        };
        const watchdog = setInterval(() => {
            const now = Date.now();
            const late = now - lastTick > 15000; // slept through ticks
            lastTick = now;
            if (document.visibilityState !== 'visible' || late) { lastByteAt = now; return; }
            if (now - lastByteAt > CHAT_STREAM_STALL_MS) stall();
        }, 5000);
        // For syncOnWake: after a long sleep, ask the server whether the reply
        // already finished, rather than waiting out the watchdog.
        this._liveStream = {
            lastByteAt: () => lastByteAt,
            checkServer: async () => {
                const id = getReplyId();
                if (!id) return;
                try {
                    const r = await window.authFetch(`/api/sw/chats/${this.activeChatId}`);
                    if (!r.ok) return;
                    const chat = await r.json();
                    const m = (chat.messages || []).find(x => x.id === id);
                    if (m && m.content) stall(); // recovery picks it up at once
                } catch (_) {}
            },
        };

        try {
            while (true) {
                let result;
                try {
                    result = await reader.read();
                } catch (e) {
                    if (stalled) {
                        const err = new Error('Reply stream stalled');
                        err.name = 'StreamStall';
                        throw err;
                    }
                    throw e;
                }
                if (result.done) break;
                lastByteAt = Date.now();

                buffer += decoder.decode(result.value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop();

                for (const ev of events) {
                    if (!ev.startsWith('data: ')) continue; // `: ping` heartbeats
                    const dataStr = ev.slice(6);
                    if (dataStr.trim() === '[DONE]') continue;
                    try {
                        onEvent(JSON.parse(dataStr));
                    } catch (err) {
                        console.warn('Failed to handle chat SSE data:', dataStr, err);
                    }
                }
            }
        } finally {
            clearInterval(watchdog);
            this._liveStream = null;
        }
    }

    // A reply stream dropped (phone locked, network change) or stalled. The
    // backend keeps writing and saves the reply when it finishes, so poll for
    // that one message and fill in its bubble, rather than redrawing the chat.
    async _recoverReply({ replyId, wrapper, contentEl, msgObj }) {
        const chatId = this.activeChatId;
        const token = {};
        this._recovering = token;
        this._setGeneratingUI(true);

        const status = document.createElement('div');
        status.className = 'chat-reply-status';
        status.innerHTML = '<span>⏳ Connection dropped. Fetching the reply from the server…</span>';
        contentEl.appendChild(status);
        this._noteStreamGrowth();

        const started = Date.now();
        let finalMsg = null;
        let gone = false;
        while (this._recovering === token && this.activeChatId === chatId && Date.now() - started < CHAT_RECOVER_GIVE_UP_MS) {
            try {
                const r = await window.authFetch(`/api/sw/chats/${chatId}`);
                if (r.ok) {
                    const chat = await r.json();
                    const m = (chat.messages || []).find(x => x.id === replyId);
                    if (!m) { gone = true; break; }
                    if (m.content) { finalMsg = m; break; }
                }
            } catch (_) { /* offline for a moment: keep trying */ }
            await new Promise(res => setTimeout(res, CHAT_RECOVER_POLL_MS));
        }

        const stillOurs = this._recovering === token;
        if (stillOurs) {
            this._recovering = null;
            this._setGeneratingUI(false);
        }
        if (this.activeChatId !== chatId) return; // left this chat meanwhile

        if (finalMsg) {
            msgObj.id = finalMsg.id;
            msgObj.content = finalMsg.content;
            if (finalMsg.character_name) msgObj.character_name = finalMsg.character_name;
            contentEl.innerHTML = this.formatMessage(finalMsg.content, msgObj.character_name);
            this.attachMessageActions(wrapper, msgObj, contentEl, wrapper.querySelector('.chat-bubble-name'));
            this._noteStreamGrowth();
        } else if (gone) {
            this.selectChat(chatId); // deleted elsewhere: show what the server has
        } else if (stillOurs) {
            status.innerHTML = '<span>⚠️ The reply hasn’t arrived.</span>';
            const reload = document.createElement('button');
            reload.type = 'button';
            reload.textContent = 'Reload chat';
            reload.onclick = () => this.selectChat(chatId);
            status.appendChild(reload);
        } else {
            status.remove(); // Stop pressed: keep the partial text
        }
    }

    stopGeneration() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this._recovering = null; // ends a recovery poll too
        this._setGeneratingUI(false);
        this._focusInput();
    }

    async sendImpersonateMessage() {
        if (!this.activeChatId || this.isGenerating) return;

        const draftContent = this.els.msgInput.value.trim();
        const oocNote = this.els.oocInput.value.trim();

        // Show a loading state on the impersonate button
        const impBtn = this.els.impBtn;
        const originalLabel = impBtn ? impBtn.innerHTML : '';
        if (impBtn) {
            impBtn.disabled = true;
            impBtn.innerHTML = '⏳ Writing…';
        }
        if (this.els.sendBtn) this.els.sendBtn.disabled = true;

        this.abortController = new AbortController();
        let generatedText = '';

        try {
            const payload = {
                content: draftContent,
                ooc_note: oocNote || '',
                impersonate: true,
            };

            if (window.config) {
                payload.max_input_tokens = window.config.get('chat.maxInputTokens');
                payload.max_output_tokens = window.config.get('chat.maxOutputTokens');
                payload.temperature = window.config.get('chat.temperature');
                payload.top_p = window.config.get('chat.topP');
                payload.repetition_penalty = window.config.get('chat.repetitionPenalty');
                payload.enable_cot = window.config.get('chat.enableCot') !== false;
            }

            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: this.abortController.signal,
            });

            if (!res.ok) throw new Error('Impersonate API request failed');

            await this._readChatStream(res, this.abortController, () => null, (data) => {
                if (data.type === 'chunk') {
                    generatedText += data.content;
                    // Stream text into the input field live
                    this.els.msgInput.value = generatedText;
                    // Auto-resize the textarea if possible
                    this.els.msgInput.dispatchEvent(new Event('input'));
                } else if (data.type === 'error') {
                    console.error('Impersonate stream error:', data.message);
                }
            });
        } catch (e) {
            // Impersonated text isn't saved anywhere, so a dropped stream keeps
            // whatever arrived in the box.
            if (e.name !== 'AbortError') {
                console.error('Impersonate stream error', e);
            }
        } finally {
            this.abortController = null;
            if (impBtn) {
                impBtn.disabled = false;
                impBtn.innerHTML = originalLabel;
            }
            if (this.els.sendBtn) this.els.sendBtn.disabled = false;
            // Here the keyboard is wanted: the next step is editing the text.
            this.els.msgInput.focus();
            // Place cursor at end of generated text
            const len = this.els.msgInput.value.length;
            this.els.msgInput.setSelectionRange(len, len);
        }
    }

    async sendMessage(options = {}) {

        if (!this.activeChatId || this.isGenerating) return;

        // Force save current persona to this chat whenever a message is sent
        if (this.els.userPersonaSelect) {
            const selectedPersona = this.els.userPersonaSelect.value;
            localStorage.setItem(`chatgen_persona_${this.activeChatId}`, selectedPersona);
            localStorage.setItem('chatgen_active_user_persona', selectedPersona);
        }

        let content = this.els.msgInput.value.trim();
        let oocNote = this.els.oocInput.value.trim();

        if (!content && !oocNote) {
            oocNote = 'Please continue the story.';
        }

        let characterName = null;
        if (this.els.speakerSelect && this.els.speakerSelect.style.display !== 'none') {
            characterName = this.els.speakerSelect.value || null;
        }

        // Optimistic UI update
        const userMsgObj = { role: 'user', content, ooc_note: oocNote, created_at: new Date().toISOString() };
        this.els.msgInput.value = '';
        this.els.msgInput.style.height = 'auto';
        this.els.oocInput.value = '';
        this.els.oocContainer.style.display = 'none';
        this.updateOocBadge();
        this._closePopovers();
        // On a phone, put the keyboard away so the reply gets the screen.
        if (chatIsTouch()) this.els.msgInput.blur();
        const userBubbleWrapper = this.appendMessage(userMsgObj);

        this._setGeneratingUI(true);

        // Create empty AI bubble for streaming
        const aiMsgObj = { role: 'assistant', character_name: characterName || 'Routing...', content: '' };
        const aiBubbleWrapper = this.appendMessage(aiMsgObj);
        const contentEl = aiBubbleWrapper.querySelector('.chat-bubble');
        const anchor = this._startReplyScroll(userBubbleWrapper, aiBubbleWrapper);

        this.abortController = new AbortController();
        // IDs sent by backend in the metadata SSE event — captured during streaming
        let serverUserMsgId = null;
        let serverAiMsgId = null;
        let dropped = false;

        try {
            const payload = {
                content,
                ooc_note: oocNote,
                character_name: characterName
            };

            if (window.config) {
                payload.max_input_tokens = window.config.get('chat.maxInputTokens');
                payload.max_output_tokens = window.config.get('chat.maxOutputTokens');
                payload.temperature = window.config.get('chat.temperature');
                payload.top_p = window.config.get('chat.topP');
                payload.repetition_penalty = window.config.get('chat.repetitionPenalty');
                payload.enable_cot = window.config.get('chat.enableCot') !== false;
            }

            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: this.abortController.signal
            });

            if (!res.ok) throw new Error('API Request Failed');

            let fullText = '';
            await this._readChatStream(res, this.abortController, () => serverAiMsgId, (data) => {
                if (data.type === 'api_log' && window.apiHandler) {
                    window.apiHandler.addBackendLog(data.log);
                } else if (data.type === 'metadata') {
                    // Capture server-assigned IDs immediately — used to attach
                    // action buttons as soon as the stream ends (or is aborted),
                    // and to fetch the reply if the stream drops.
                    if (data.user_message_id) serverUserMsgId = data.user_message_id;
                    if (data.assistant_message_id) serverAiMsgId = data.assistant_message_id;
                    this._applyReplyMetadata(data, aiMsgObj, aiBubbleWrapper);
                } else if (data.type === 'chunk') {
                    fullText += data.content;
                    aiMsgObj.content = fullText;
                    contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                    this._followReply(anchor);
                } else if (data.type === 'corrected_content') {
                    // Backend injected <think> tags that the model forgot to output.
                    // Replace the raw streamed text with the corrected version.
                    fullText = data.content;
                    aiMsgObj.content = fullText;
                    contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                    this._followReply(anchor);
                } else if (data.type === 'error') {
                    console.error('Chat generation error:', data.message);
                    contentEl.innerHTML += `<br><span style="color:var(--error);">Error: ${this.escapeHtml(data.message)}</span>`;
                }
            });
        } catch (e) {
            if (e.name !== 'AbortError') {
                // Dropped or stalled (phone lock, network change): the backend
                // carries on and saves the reply; it's fetched below.
                console.error('Chat stream error', e);
                dropped = true;
            }
        } finally {
            this.abortController = null;
        }

        // Attach action buttons using the IDs captured from the metadata SSE event.
        // This is the primary path — fast and doesn't require a round-trip.
        if (serverUserMsgId && userBubbleWrapper && !userMsgObj.id) {
            userMsgObj.id = serverUserMsgId;
            this.attachMessageActions(userBubbleWrapper, userMsgObj,
                userBubbleWrapper.querySelector('.chat-bubble'),
                userBubbleWrapper.querySelector('.chat-bubble-name'));
        }

        if (dropped) {
            if (serverAiMsgId) {
                await this._recoverReply({ replyId: serverAiMsgId, wrapper: aiBubbleWrapper, contentEl, msgObj: aiMsgObj });
            } else {
                // Died before the first event: the server may not even have the
                // message. Show whatever state it reached.
                this._setGeneratingUI(false);
                if (this.activeChatId) await this.selectChat(this.activeChatId).catch(() => {});
            }
            return;
        }

        const hasPendingBanner = !!document.getElementById('chat-pending-gen-banner');
        this._setGeneratingUI(hasPendingBanner);
        if (this.els.impBtn) this.els.impBtn.disabled = hasPendingBanner;
        this.els.sendBtn.disabled = hasPendingBanner;
        this.els.msgInput.disabled = hasPendingBanner;
        if (hasPendingBanner) {
            this.els.sendBtn.style.display = '';
            if (this.els.stopBtn) this.els.stopBtn.style.display = 'none';
        } else {
            this._focusInput();
        }

        if (serverAiMsgId && aiBubbleWrapper && !aiMsgObj.id) {
            aiMsgObj.id = serverAiMsgId;
            this.attachMessageActions(aiBubbleWrapper, aiMsgObj, contentEl, aiBubbleWrapper.querySelector('.chat-bubble-name'));
            this._updateRegenButtons();
        }

        // Fallback: if the metadata event never arrived (e.g. very early network error
        // before the first SSE event), fetch the full chat to recover the IDs.
        if (!userMsgObj.id || !aiMsgObj.id) {
            window.authFetch(`/api/sw/chats/${this.activeChatId}`).then(res => res.json()).then(chat => {
                if (chat && chat.messages && this.activeChatId === chat.id) {
                    const serverMessages = chat.messages;
                    if (!userMsgObj.id) {
                        const lastUser = serverMessages.slice().reverse().find(m => m.role === 'user');
                        if (lastUser && userBubbleWrapper) {
                            userMsgObj.id = lastUser.id;
                            this.attachMessageActions(userBubbleWrapper, userMsgObj,
                                userBubbleWrapper.querySelector('.chat-bubble'),
                                userBubbleWrapper.querySelector('.chat-bubble-name'));
                        }
                    }
                    if (!aiMsgObj.id) {
                        const lastAi = serverMessages[serverMessages.length - 1];
                        if (lastAi && lastAi.role !== 'user') {
                            aiMsgObj.id = lastAi.id;
                            this.attachMessageActions(aiBubbleWrapper, aiMsgObj, contentEl, aiBubbleWrapper.querySelector('.chat-bubble-name'));
                        }
                    }
                    this._updateRegenButtons();
                }
            }).catch(e => console.error('Error fetching updated chat (fallback)', e));
        }
    }

    /* ── Reset chat's system prompt to global baseline ────────────────────── */
    resetToGlobalSystemPrompt(textareaId) {
        const textarea = document.getElementById(textareaId);
        if (!textarea) return;
        const segments = window.config?.get("chat.systemPromptSegments") || [];
        textarea.value = segments.join("\n\n");
    }
}

// Initialize Handler globally
window.roleplayChatHandler = new RoleplayChatHandler();

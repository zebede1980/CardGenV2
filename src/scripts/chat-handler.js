/**
 * RoleplayChatHandler
 * Handles state, DOM binding, and backend API interactions for the Roleplay Chat tab.
 */
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
        this.injectSettingsModal();
        this.setupSidebarToggle();
        this.bindElements();
        this.fixLayout();
        this.bindEvents();
        this.setupTabIntegration();
        this.loadPersonas();
    }

    /* ── Sidebar Toggle (with mobile drawer support) ──────────────────────── */
    setupSidebarToggle() {
        const titleEl = document.getElementById('chat-active-title');
        const sessionList = document.getElementById('chat-session-list');
        const newBtn = document.getElementById('chat-new-btn');
        if (!titleEl || !sessionList) return;

        const sidebar = sessionList.closest('.chat-sidebar');
        if (!sidebar) return;
        sidebar.id = 'chat-sidebar-container';

        const header = titleEl.closest('.chat-header');
        if (!header) return;
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.gap = '0.5rem';

        if (titleEl.parentElement && titleEl.parentElement !== header) {
            titleEl.parentElement.style.flex = '1';
            titleEl.parentElement.style.minWidth = '0';
        }
        titleEl.style.whiteSpace = 'nowrap';
        titleEl.style.overflow = 'hidden';
        titleEl.style.textOverflow = 'ellipsis';

        const charsEl = document.getElementById('chat-active-characters');
        if (charsEl) {
            charsEl.style.whiteSpace = 'nowrap';
            charsEl.style.overflow = 'hidden';
            charsEl.style.textOverflow = 'ellipsis';
        }

        // Create sidebar backdrop for mobile overlay
        if (!document.getElementById('chat-sidebar-backdrop')) {
            const backdrop = document.createElement('div');
            backdrop.id = 'chat-sidebar-backdrop';
            backdrop.className = 'chat-sidebar-backdrop';
            backdrop.addEventListener('click', () => this.closeMobileSidebar());
            document.getElementById('view-roleplaychat').appendChild(backdrop);
        }

        if (!document.getElementById('chat-sidebar-toggle')) {
            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'chat-sidebar-toggle';
            toggleBtn.className = 'btn-outline';
            toggleBtn.style.cssText = 'padding: 0.25rem 0.5rem; margin-right: 0.5rem; display: flex; align-items: center; justify-content: center; border-radius: 0.4rem; cursor: pointer; min-height: 2.25rem; flex-shrink: 0;';
            toggleBtn.innerHTML = '☰';
            toggleBtn.title = 'Chats';

            toggleBtn.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    this.toggleMobileSidebar();
                } else {
                    this.toggleDesktopSidebar();
                }
            });

            header.insertBefore(toggleBtn, header.firstChild);
            this.sidebarToggleBtn = toggleBtn;

            // Fullscreen toggle
            if (!document.getElementById('chat-fullscreen-toggle')) {
                const fsBtn = document.createElement('button');
                fsBtn.id = 'chat-fullscreen-toggle';
                fsBtn.className = 'btn-outline';
                fsBtn.style.cssText = 'padding: 0.25rem 0.5rem; margin-left: auto; display: flex; align-items: center; justify-content: center; border-radius: 0.4rem; cursor: pointer; min-height: 2.25rem; font-size: 1.2rem; flex-shrink: 0;';
                fsBtn.innerHTML = '⛶';
                fsBtn.title = 'Toggle Fullscreen';
                fsBtn.addEventListener('click', () => this.toggleFullscreen());
                header.appendChild(fsBtn);
            }
        }
    }

    toggleMobileSidebar() {
        const sidebar = document.getElementById('chat-sidebar-container');
        const backdrop = document.getElementById('chat-sidebar-backdrop');
        if (!sidebar) return;

        if (sidebar.classList.contains('mobile-drawer-open')) {
            this.closeMobileSidebar();
        } else {
            sidebar.classList.add('mobile-drawer-open');
            if (backdrop) backdrop.classList.add('active');
            if (this.sidebarToggleBtn) this.sidebarToggleBtn.innerHTML = '✕';
        }
    }

    closeMobileSidebar() {
        const sidebar = document.getElementById('chat-sidebar-container');
        const backdrop = document.getElementById('chat-sidebar-backdrop');
        if (sidebar) sidebar.classList.remove('mobile-drawer-open');
        if (backdrop) backdrop.classList.remove('active');
        if (this.sidebarToggleBtn) this.sidebarToggleBtn.innerHTML = '☰';
    }

    toggleDesktopSidebar() {
        const sidebar = document.getElementById('chat-sidebar-container');
        if (!sidebar) return;
        if (sidebar.style.display === 'none') {
            sidebar.style.display = '';
            if (this.sidebarToggleBtn) this.sidebarToggleBtn.innerHTML = '◀';
        } else {
            sidebar.style.display = 'none';
            if (this.sidebarToggleBtn) this.sidebarToggleBtn.innerHTML = '▶';
        }
    }

    injectSettingsModal() {
        if (document.getElementById('chat-global-settings-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'chat-global-settings-modal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.style.zIndex = '2000';
        modal.innerHTML = `
            <div class="api-settings-modal" style="max-width: 600px; width: 90%; max-height: 90vh; height: auto; display: flex; flex-direction: column; transition: max-width 0.2s ease, width 0.2s ease, height 0.2s ease;">
                <div class="modal-header">
                    <h2 class="modal-title">⚙️ Global Chat Settings</h2>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <button id="chat-global-settings-maximize" class="btn-outline btn-small" style="border:none; padding: 0.2rem 0.5rem; font-size: 1.2rem; min-height: unset; height: auto;" title="Maximize">⛶</button>
                        <button id="chat-global-settings-close" class="modal-close">×</button>
                    </div>
                </div>
                <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column;">
                    <div class="form-group">
                        <label>Max Input Tokens (Context Window)</label>
                        <input type="number" id="chat-global-max-input" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group">
                        <label>Max Output Tokens</label>
                        <input type="number" id="chat-global-max-output" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group">
                        <label>Temperature</label>
                        <input type="number" step="0.1" id="chat-global-temperature" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group">
                        <label>Repetition Penalty</label>
                        <input type="number" step="0.05" id="chat-global-rep-penalty" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem;">
                        <input type="checkbox" id="chat-global-filter-cjk" style="width: 1.2rem; height: 1.2rem; cursor: pointer;">
                        <label for="chat-global-filter-cjk" style="margin: 0; cursor: pointer;">Filter out Chinese/Korean characters (GLM bleed fix)</label>
                    </div>
                    <div class="form-group" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
                        <input type="checkbox" id="chat-global-enable-cot" style="width: 1.2rem; height: 1.2rem; cursor: pointer;" checked>
                        <label for="chat-global-enable-cot" style="margin: 0; cursor: pointer;">Enable Chain of Thought (5-Phase Logic)</label>
                    </div>
                    
                    <h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">Modular System Prompt</h3>
                    <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">These segments are combined to form the default system prompt when starting a new chat.</p>
                    
                    <div id="chat-global-prompt-segments" style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; flex: 1; min-height: 250px; overflow-y: auto; padding-right: 0.5rem;">
                        <!-- Segments injected here -->
                    </div>
                    
                    <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
                        <textarea id="chat-global-new-segment" class="content-box" style="flex: 1; resize: vertical;" rows="3" placeholder="New prompt segment (Ctrl+Enter to add)..."></textarea>
                        <button id="chat-global-add-segment" class="btn-primary" style="height: fit-content; padding: 0.8rem 1.2rem;">Add</button>
                    </div>
                    
                    <div style="margin-top: 1.5rem; display: flex; justify-content: flex-end;">
                        <button id="chat-global-save-btn" class="btn-primary">Save Settings</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const newBtn = document.getElementById('chat-new-btn');
        if (newBtn && newBtn.parentNode) {
            const settingsBtn = document.createElement('button');
            settingsBtn.id = 'chat-open-global-settings';
            settingsBtn.className = 'btn-outline';
            settingsBtn.innerHTML = '⚙️ Settings';
            settingsBtn.style.marginLeft = '0.5rem';
            newBtn.parentNode.insertBefore(settingsBtn, newBtn.nextSibling);
        }
    }

    fixLayout() {
        // Prevent global horizontal overflow
        if (!document.getElementById('chat-global-fixes')) {
            const style = document.createElement('style');
            style.id = 'chat-global-fixes';
            style.textContent = `
                html, body { overflow-x: hidden; max-width: 100%; }
                *, *::before, *::after { box-sizing: border-box; }
            `;
            document.head.appendChild(style);
        }

        // Ensure the chat view uses flex layout properly
        const viewChat = document.getElementById('view-roleplaychat');
        if (viewChat) {
            viewChat.style.display = 'flex';
        }

        // The parent of the timeline is the .chat-main column
        if (this.els.timeline && this.els.timeline.parentElement) {
            const mainArea = this.els.timeline.parentElement;
            mainArea.style.flex = '1';
            mainArea.style.display = 'flex';
            mainArea.style.flexDirection = 'column';
            mainArea.style.minWidth = '0';
            mainArea.style.minHeight = '0';
            mainArea.style.overflow = 'hidden';

            this.els.timeline.style.flex = '1 1 0%';
            this.els.timeline.style.overflowY = 'auto';
            this.els.timeline.style.minHeight = '0';
        }



        // Scroll-to-bottom FAB
        const fab = document.getElementById('chat-scroll-bottom-btn');
        if (fab) {
            fab.addEventListener('click', () => {
                this.els.timeline.scrollTop = this.els.timeline.scrollHeight;
                fab.style.display = 'none';
            });
        }

        // Touch device detection for always-visible message actions
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
            document.documentElement.classList.add('touch-device');
            const style = document.createElement('style');
            style.id = 'chat-touch-fixes';
            style.textContent = `.touch-device .chat-bubble-wrapper .chat-message-actions { opacity: 1 !important; }`;
            document.head.appendChild(style);
        }

        // Initial layout adjustment
        this.adjustChatLayout();
    }

    _resetMainLayout() {
        const mainEl = document.querySelector('.main');
        if (!mainEl) return;
        mainEl.style.flex = '';
        mainEl.style.minHeight = '';
        mainEl.style.display = '';
        mainEl.style.flexDirection = '';
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
                setTimeout(() => this.adjustChatLayout(), 10);
            });

            // Hide chat view and reset layout when other tabs are clicked
            const leaveChat = () => {
                viewChat.style.display = 'none';
                tabChat.className = 'btn-outline';
                this._resetMainLayout();
            };
            if (tabCardGen) tabCardGen.addEventListener('click', leaveChat);
            if (tabStoryWriter) tabStoryWriter.addEventListener('click', leaveChat);
        }
    }

    bindElements() {
        this.els = {
            sessionList: document.getElementById('chat-session-list'),
            newBtn: document.getElementById('chat-new-btn'),

            globalSettingsBtn: document.getElementById('chat-open-global-settings'),
            globalSettingsModal: document.getElementById('chat-global-settings-modal'),
            globalSettingsMaxBtn: document.getElementById('chat-global-settings-maximize'),
            globalSettingsContent: document.querySelector('#chat-global-settings-modal .api-settings-modal'),
            globalSettingsClose: document.getElementById('chat-global-settings-close'),
            globalMaxInput: document.getElementById('chat-global-max-input'),
            globalMaxOutput: document.getElementById('chat-global-max-output'),
            globalTemp: document.getElementById('chat-global-temperature'),
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
            createSubmitBtn: document.getElementById('chat-create-submit-btn'),
            newPersonaManual: document.getElementById('chat-new-persona-manual'),
            newPersonaCard: document.getElementById('chat-new-persona-card'),
            newPersonaName: document.getElementById('chat-new-persona-name'),
            newPersonaAge: document.getElementById('chat-new-persona-age'),
            newPersonaGender: document.getElementById('chat-new-persona-gender'),
            newPersonaDetail: document.getElementById('chat-new-persona-detail'),
            newPersonaCardName: document.getElementById('chat-new-persona-card-name'),
            newPersonaPickBtn: document.getElementById('chat-new-persona-pick-btn'),

            zoomOutBtn: document.getElementById('chat-zoom-out-btn'),
            zoomResetBtn: document.getElementById('chat-zoom-reset-btn'),
            zoomInBtn: document.getElementById('chat-zoom-in-btn'),
        };
    }

    bindEvents() {
        if (!this.els.sessionList) return;

        this.els.newBtn.addEventListener('click', () => this.openNewChatModal());
        this.els.newCloseBtn.addEventListener('click', () => this.closeNewChatModal());
        this.els.createSubmitBtn.addEventListener('click', () => this.createNewChat());

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
            if (isHidden) this.els.oocInput.focus();
        });

        this.els.oocInput.addEventListener('input', () => this.updateOocBadge());

        this.els.sendBtn.addEventListener('click', () => this.sendMessage());

        if (this.els.stopBtn) {
            this.els.stopBtn.addEventListener('click', () => this.stopGeneration());
        }

        if (this.els.impBtn) {
            this.els.impBtn.addEventListener('click', () => this.sendImpersonateMessage());
        }

        const autoResizeInput = (el) => {
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 150) + 'px';
            el.style.overflowY = el.scrollHeight > 150 ? 'auto' : 'hidden';
        };

        this.els.msgInput.addEventListener('input', () => autoResizeInput(this.els.msgInput));
        // Trigger initial resize
        setTimeout(() => autoResizeInput(this.els.msgInput), 0);

        this.els.msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            } else if (e.key === 'Escape') {
                this.els.msgInput.blur();
                this.closeMobileSidebar();
            }
        });

        this.els.globalNewSegment.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                this.addSystemPromptSegment();
            }
        });

        this.els.oocInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });



        window.addEventListener('resize', () => this.adjustChatLayout());

        document.addEventListener('visibilitychange', () => this.syncOnWake());
        window.addEventListener('focus', () => this.syncOnWake());

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
    }

    adjustChatLayout() {
        const viewChat = document.getElementById('view-roleplaychat');
        if (!viewChat || viewChat.style.display === 'none') return;

        if (viewChat.classList.contains('chat-fullscreen')) {
            viewChat.style.height = '';
            return;
        }

        // Clear any JS-set height and let CSS flex chain handle it naturally
        viewChat.style.height = '';
        viewChat.style.maxHeight = '';

        // Ensure .main fills remaining space in the flex column
        const mainEl = document.querySelector('.main');
        if (mainEl && viewChat.style.display !== 'none') {
            mainEl.style.flex = '1';
            mainEl.style.minHeight = '0';
            mainEl.style.display = 'flex';
            mainEl.style.flexDirection = 'column';
        }
    }

    async syncOnWake() {
        if (document.visibilityState !== 'visible') return;

        this.loadSessionList(); // Refresh the sidebar in case external changes occurred

        if (!this.activeChatId) return;

        try {
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}`);
            if (!res.ok) return;
            const chat = await res.json();

            const messages = chat.messages || [];
            const lastMsg = messages[messages.length - 1];

            const serverIsGenerating = lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '';

            if (serverIsGenerating || this.isGenerating) {
                if (this.abortController) { 
                    this.abortController.abort(); 
                    this.abortController = null; 
                }
                this.selectChat(this.activeChatId);
                return;
            }

            this._hidePendingGenerationBanner();

            const domCount = this.els.timeline.querySelectorAll('.chat-bubble-wrapper').length;
            const dbCount  = messages.length;
            let needsReload = false;
            
            if (dbCount !== domCount) {
                needsReload = true;
            } else if (dbCount > 0 && domCount > 0) {
                const lastDomBubble = this.els.timeline.querySelector('.chat-bubble-wrapper:last-child .chat-bubble');
                if (lastDomBubble && lastDomBubble.textContent.trim() === '' && lastMsg.content !== '') {
                    needsReload = true;
                }
            }
            
            if (needsReload) {
                this.selectChat(this.activeChatId);
            }
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

        this.userPersonaSelectedCard = null;
        this.els.newPersonaName.value = '';
        this.els.newPersonaAge.value = '';
        this.els.newPersonaGender.value = '';
        this.els.newPersonaDetail.value = '';
        this.els.newPersonaCardName.textContent = 'No card selected';
        this.els.newPersonaCardName.style.color = 'var(--text-secondary)';
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

            const payload = {
                title,
                system_prompt: sysPrompt,
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
            this.renderSessionList();
        } catch (e) {
            console.error("Failed to load chat sessions", e);
        }
    }

    renderSessionList() {
        this.els.sessionList.innerHTML = '';
        if (this.chats.length === 0) {
            this.els.sessionList.innerHTML = '<div style="padding: 1rem; color: var(--text-secondary); text-align: center; font-style: italic;">No chats yet</div>';
            return;
        }

        this.chats.forEach(chat => {
            const el = document.createElement('div');
            el.className = `chat-session-item ${chat.id === this.activeChatId ? 'active' : ''}`;
            el.dataset.id = chat.id;

            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'flex-start';

            const textCol = document.createElement('div');

            const titleEl = document.createElement('div');
            titleEl.style.fontWeight = '600';
            titleEl.textContent = chat.title;

            const dateEl = document.createElement('div');
            dateEl.style.fontSize = '0.75rem';
            dateEl.style.color = 'var(--text-secondary)';
            dateEl.textContent = new Date(chat.updated_at).toLocaleString();

            const delBtn = document.createElement('button');
            delBtn.innerHTML = '🗑️';
            delBtn.title = "Delete Chat";
            delBtn.style.cssText = 'background:none; border:none; cursor:pointer; padding: 0.2rem; filter: grayscale(1); opacity: 0.7;';
            delBtn.onmouseover = () => { delBtn.style.opacity = '1'; delBtn.style.filter = 'none'; };
            delBtn.onmouseout = () => { delBtn.style.opacity = '0.7'; delBtn.style.filter = 'grayscale(1)'; };
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`Are you sure you want to delete "${chat.title}"?`)) {
                    await window.authFetch(`/api/sw/chats/${chat.id}`, { method: 'DELETE' });
                    if (this.activeChatId === chat.id) this.activeChatId = null;
                    this.loadSessionList();
                }
            };

            textCol.appendChild(titleEl);
            textCol.appendChild(dateEl);
            row.appendChild(textCol);
            row.appendChild(delBtn);
            el.appendChild(row);

            el.addEventListener('click', () => this.selectChat(chat.id));
            this.els.sessionList.appendChild(el);
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

    toggleFullscreen() {
        const chatView = document.getElementById('view-roleplaychat');
        const fsBtn = document.getElementById('chat-fullscreen-toggle');
        const sidebar = document.getElementById('chat-sidebar-container');
        const backdrop = document.getElementById('chat-sidebar-backdrop');

        if (!chatView) return;

        if (!chatView.classList.contains('chat-fullscreen')) {
            chatView.classList.add('chat-fullscreen');
            if (fsBtn) { fsBtn.innerHTML = '✖'; fsBtn.title = 'Exit Fullscreen'; }

            // Close mobile sidebar if open
            this.closeMobileSidebar();
            // Hide sidebar and backdrop
            this.preFsSidebarDisplay = sidebar ? sidebar.style.display : '';
            if (sidebar) sidebar.style.display = 'none';
            if (backdrop) backdrop.style.display = 'none';
        } else {
            chatView.classList.remove('chat-fullscreen');
            if (fsBtn) { fsBtn.innerHTML = '⛶'; fsBtn.title = 'Fullscreen'; }

            // Restore sidebar
            if (sidebar) sidebar.style.display = this.preFsSidebarDisplay !== undefined ? this.preFsSidebarDisplay : '';
            if (backdrop) backdrop.style.display = '';

            this.adjustChatLayout();
        }

    }

    async selectChat(chatId) {
        this.activeChatId = chatId;

        // Auto-close mobile sidebar drawer when a chat is selected
        if (window.innerWidth <= 768) {
            this.closeMobileSidebar();
        }

        document.querySelectorAll('.chat-session-item').forEach(el => {
            if (el.dataset.id === chatId) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });

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

            if (this.els.speakerSelect) {
                if (chat.characters.length > 1) {
                    this.els.speakerSelect.innerHTML = '<option value="">🤖 Auto (Router)</option>';
                    chat.characters.forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.name;
                        opt.textContent = c.name;
                        this.els.speakerSelect.appendChild(opt);
                    });
                    this.els.speakerSelect.style.display = 'block';
                } else {
                    this.els.speakerSelect.style.display = 'none';
                    this.els.speakerSelect.innerHTML = '';
                }
            }

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
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '') {
                this._showPendingGenerationBanner(lastMsg.id, true);
            } else {
                this._hidePendingGenerationBanner();
            }
            this.els.timeline.innerHTML = '';


            // Ensure messages are sorted chronologically (oldest first)
            const sortedMessages = (chat.messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            sortedMessages.forEach(msg => this.appendMessage(msg, false));

            if (chat.messages.length === 0) {
                this.els.timeline.innerHTML = '<div class="chat-placeholder"><p>No messages yet. Send a greeting!</p></div>';
            } else {
                setTimeout(() => this.scrollToBottom(false), 50);
            }

            this.els.msgInput.disabled = false;
            this.els.sendBtn.disabled = false;
        } catch (e) {
            console.error("Failed to load chat details", e);
        }
    }

    getAvatarUrl(characterName, cardId = null) {
        let id = cardId;
        if (!id && this.activeChatCharacters) {
            const char = this.activeChatCharacters.find(c => c.name === characterName);
            if (char) id = char.id;
        }
        if (id) {
            const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || "";
            return `/api/storage/cards/thumbnail?cardId=${id}&token=${token}`;
        }
        return null;
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

    appendMessage(msg, alignToTop = false) {
        const placeholder = this.els.timeline.querySelector('.chat-placeholder');
        if (placeholder) placeholder.remove();

        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper ${msg.role}`;

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

        if (msg.ooc_note) {
            const oocEl = document.createElement('details');
            oocEl.style.marginTop = '0.5rem';
            oocEl.style.fontSize = '0.82rem';
            oocEl.innerHTML = `<summary style="cursor: pointer; opacity: 0.7; font-weight: 500;">OOC Instruction</summary><div style="margin-top: 0.25rem; font-style: italic; opacity: 0.8; padding-left: 0.5rem; border-left: 2px solid var(--border);">${this.escapeHtml(msg.ooc_note)}</div>`;
            bubbleEl.appendChild(oocEl);
        }

        // ── Avatar ──
        const avatarEl = document.createElement('div');
        avatarEl.className = 'chat-avatar-container';

        if (msg.role === 'user') {
            if (userPersona) {
                const avatarUrl = this.getAvatarUrl(userName, userPersona.id);
                if (avatarUrl) {
                    avatarEl.innerHTML = `<img src="${avatarUrl}" alt="" class="chat-avatar-user-img" style="width:100%;height:100%;object-fit:cover;cursor:pointer;border-radius:0.5rem;">`;
                    const imgEl = avatarEl.querySelector('img');
                    if (imgEl) {
                        imgEl.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (window.app && window.app.openGallery) {
                                window.app.openGallery([{ url: avatarUrl, label: userName }]);
                            }
                        });
                    }
                } else {
                    avatarEl.textContent = userName.substring(0, 2).toUpperCase();
                    avatarEl.style.fontSize = 'calc(var(--chat-avatar-size) * 0.35)';
                }
            } else {
                avatarEl.textContent = 'U';
                avatarEl.style.fontSize = 'calc(var(--chat-avatar-size) * 0.4)';
            }
        } else {
            const avatarUrl = this.getAvatarUrl(charName, msg.character_card_id);
            if (avatarUrl) {
                avatarEl.innerHTML = `<img src="${avatarUrl}" alt="" class="chat-avatar-char-img" style="width:100%;height:100%;object-fit:cover;cursor:pointer;border-radius:0.5rem;">`;
                const imgEl = avatarEl.querySelector('img');
                if (imgEl) {
                    imgEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (window.app && window.app.openGallery) {
                            window.app.openGallery([{ url: avatarUrl, label: charName }]);
                        }
                    });
                }
            } else {
                avatarEl.textContent = charName.substring(0, 2).toUpperCase();
                avatarEl.style.fontSize = 'calc(var(--chat-avatar-size) * 0.35)';
            }
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

        if (alignToTop) {
            this.scrollToMessage(wrapper);
        }

        return wrapper;
    }

    attachMessageActions(wrapper, msg, bubbleEl, nameEl) {
        if (wrapper.querySelector('.chat-message-actions')) return;

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

        const container = document.createElement('div');
        container.className = 'chat-message-actions-container';
        container.appendChild(actionsEl);
        nameEl.parentElement.insertBefore(container, nameEl);

        // Refresh which assistant bubble shows the Regen button
        this._updateRegenButtons();
    }

    /** Ensure only the last assistant bubble's Regen button is visible */
    _updateRegenButtons() {
        const allAssistantWrappers = Array.from(
            this.els.timeline.querySelectorAll('.chat-bubble-wrapper.assistant')
        );
        allAssistantWrappers.forEach((w, idx) => {
            const btn = w.querySelector('.chat-regen-btn');
            if (!btn) return;
            btn.style.display = (idx === allAssistantWrappers.length - 1) ? '' : 'none';
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
        this.isGenerating = true;
        this.els.sendBtn.style.display = 'none';
        if (this.els.impBtn) this.els.impBtn.style.display = 'none';
        if (this.els.stopBtn) this.els.stopBtn.style.display = '';

        const aiMsgObj = { role: 'assistant', character_name: characterName || 'Routing...', content: '' };
        const aiBubbleWrapper = this.appendMessage(aiMsgObj, true);
        const contentEl = aiBubbleWrapper.querySelector('.chat-bubble');
        const nameTextEl = aiBubbleWrapper.querySelector('.chat-bubble-name-text');

        this.abortController = new AbortController();

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
                payload.repetition_penalty = window.config.get('chat.repetitionPenalty');
            }

            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: this.abortController.signal
            });

            if (!res.ok) throw new Error('Regen API Request Failed');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.slice(6);
                    if (dataStr.trim() === '[DONE]') continue;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === 'metadata') {
                            if (data.character_name) {
                                nameTextEl.textContent = data.character_name;
                                aiMsgObj.character_name = data.character_name;
                            }
                            if (data.character_card_id) {
                                aiMsgObj.character_card_id = data.character_card_id;
                                const avatarUrl = this.getAvatarUrl(data.character_name, data.character_card_id);
                                if (avatarUrl) {
                                    const avatarDiv = aiBubbleWrapper.querySelector('.chat-avatar-container');
                                    if (avatarDiv) {
                                        avatarDiv.innerHTML = `<img src="${avatarUrl}" alt="" class="chat-avatar-char-img" style="width:100%;height:100%;object-fit:cover;cursor:pointer;border-radius:0.5rem;">`;
                                    }
                                }
                            }
                            // user_message_id will be null since we sent empty content/ooc_note
                        } else if (data.type === 'chunk') {
                            fullText += data.content;
                            aiMsgObj.content = fullText;
                            contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                        } else if (data.type === 'error') {
                            console.error('Regen generation error:', data.message);
                            contentEl.innerHTML += `<br><span style="color:var(--error);">Error: ${this.escapeHtml(data.message)}</span>`;
                        }
                    } catch (err) {
                        console.warn('Failed to parse regen SSE data:', dataStr, err);
                    }
                }
            }
        } catch (e) {
            const isAbort = e.name === 'AbortError';
            if (!isAbort) {
                console.error('Regen stream error', e);
                // Network drop (e.g. phone lock): old message already deleted, new one may not have
                // been saved yet. Reload from server to show whatever state the backend reached.
                if (this.activeChatId) {
                    try { await this.selectChat(this.activeChatId); } catch (_) {}
                }
            }
        } finally {
            this.isGenerating = false;
            this.abortController = null;
            this.els.sendBtn.style.display = '';
            if (this.els.impBtn) this.els.impBtn.style.display = '';
            if (this.els.stopBtn) this.els.stopBtn.style.display = 'none';
            this.els.sendBtn.disabled = false;
            this.els.msgInput.focus();

            // Assign server-generated ID so subsequent action buttons work
            window.authFetch(`/api/sw/chats/${this.activeChatId}`).then(r => r.json()).then(chat => {
                if (chat && chat.messages && this.activeChatId === chat.id) {
                    const lastAi = chat.messages.slice().reverse().find(m => m.role === 'assistant');
                    if (lastAi && !aiMsgObj.id) {
                        aiMsgObj.id = lastAi.id;
                        this.attachMessageActions(aiBubbleWrapper, aiMsgObj, contentEl, nameTextEl.parentElement);
                    }
                }
            }).catch(e => console.error('Error fetching chat after regen', e));
        }
    }

    async handleGenerateSceneImage(messageId, wrapper, bubbleEl) {
        if (!this.activeChatId) return;

        // Gather Configured Image Settings
        const base_url = window.config?.get("api.image.baseUrl") || null;
        const api_key = window.config?.get("api.image.apiKey") || null;
        const models = window.config?.get("api.image.models") || [];
        const model = models.length > 0 ? models[0] : null; // Use the first selected model
        const size = window.config?.get("api.image.size") || "1024x1024";

        // Inject loading spinner inside the bubble
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'chat-scene-image-loading';
        loadingDiv.innerHTML = `
            <div class="loading-spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
            <span>Visualizing scene...</span>
        `;
        loadingDiv.id = `loading-image-${messageId}`;
        bubbleEl.appendChild(loadingDiv);
        this.scrollToBottom();

        try {
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${messageId}/generate-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_url, api_key, model, size })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText);
            }

            loadingDiv.remove();
            // Refresh the message context directly from the DB to sync the newly appended XML tag
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
            setTimeout(() => loadingDiv.remove(), 4000);
        }
    }

    async editMessage(msg, bubbleEl, wrapper) {
        if (bubbleEl.querySelector('textarea')) return;

        if (wrapper) wrapper.classList.add('is-editing');

        const currentContent = msg.content || '';
        const originalHTML = bubbleEl.innerHTML;

        const textarea = document.createElement('textarea');
        textarea.className = 'content-box edit-mode-textarea';
        textarea.style.width = '100%';
        textarea.style.minHeight = '250px';
        textarea.style.resize = 'vertical';
        textarea.style.fontFamily = 'inherit';
        textarea.style.marginBottom = '0.5rem';
        textarea.value = currentContent;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary btn-small edit-control-btn';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-outline btn-small edit-control-btn';
        cancelBtn.textContent = 'Cancel';

        const insertThinkBtn = document.createElement('button');
        insertThinkBtn.className = 'btn-outline btn-small edit-control-btn';
        insertThinkBtn.textContent = 'Insert </think>';
        insertThinkBtn.title = 'Insert closing think tag at cursor position';
        insertThinkBtn.style.marginLeft = 'auto';
        insertThinkBtn.onclick = () => {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            textarea.value = text.substring(0, start) + '\n</think>\n' + text.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 10;
            textarea.focus();
        };

        const actionsEl = wrapper ? wrapper.querySelector('.chat-message-actions') : null;
        let originalActions = [];
        if (actionsEl) {
            Array.from(actionsEl.children).forEach(child => {
                if (!child.classList.contains('edit-control-btn')) {
                    originalActions.push({ el: child, display: child.style.display });
                    child.style.display = 'none';
                }
            });
            actionsEl.appendChild(insertThinkBtn);
            actionsEl.appendChild(cancelBtn);
            actionsEl.appendChild(saveBtn);
        } else {
            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.gap = '0.5rem';
            controls.appendChild(saveBtn);
            controls.appendChild(cancelBtn);
            controls.appendChild(insertThinkBtn);
            bubbleEl.appendChild(controls);
        }

        bubbleEl.innerHTML = '';
        bubbleEl.appendChild(textarea);

        // Auto-resize to fit content
        textarea.style.height = 'auto';
        textarea.style.height = Math.max(250, textarea.scrollHeight) + 'px';

        textarea.focus();

        cancelBtn.onclick = () => {
            if (wrapper) wrapper.classList.remove('is-editing');
            if (actionsEl) {
                insertThinkBtn.remove();
                cancelBtn.remove();
                saveBtn.remove();
                originalActions.forEach(item => item.el.style.display = item.display);
            }
            bubbleEl.innerHTML = originalHTML;
        };

        saveBtn.onclick = async () => {
            const newContent = textarea.value.trim();
            try {
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';
                const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${msg.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: newContent })
                });
                if (res.ok) {
                    msg.content = newContent;
                    if (wrapper) wrapper.classList.remove('is-editing');
                    if (actionsEl) {
                        insertThinkBtn.remove();
                        cancelBtn.remove();
                        saveBtn.remove();
                        originalActions.forEach(item => item.el.style.display = item.display);
                    }
                    bubbleEl.innerHTML = this.formatMessage(msg.content, msg.character_name);
                    if (msg.ooc_note) {
                        const oocEl = document.createElement('details');
                        oocEl.style.marginTop = '0.5rem';
                        oocEl.style.fontSize = '0.85rem';
                        oocEl.innerHTML = `<summary style="cursor: pointer; opacity: 0.7; font-weight: 500;">OOC Instruction</summary><div style="margin-top: 0.25rem; font-style: italic; opacity: 0.8; padding-left: 0.5rem; border-left: 2px solid var(--border);">${this.escapeHtml(msg.ooc_note)}</div>`;
                        bubbleEl.appendChild(oocEl);
                    }
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

        // 1. Temporarily extract Rich XML tags to protect their inner attributes from being formatted
        const richTags = [];
        const placeholderRegex = /%%RICH_TAG_(\d+)%%/g;

        // ── Pre-normalisation: full-width brackets ────────
        // Some CJK models output full-width brackets like ＜think＞ instead of <think>.
        parsed = parsed.replace(/＜/g, '<').replace(/＞/g, '>');

        // ── Pre-normalisation: GLM / models that use \n---\n as a separator ────────
        // Some models (e.g. GLM 5.x) output reasoning above a markdown horizontal
        // rule rather than inside <think> tags. Detect this and wrap the content
        // above the FIRST \n---\n as a <think> block so the pipeline below handles
        // it uniformly. Only apply when no <think> tag is already present.
        if (!parsed.includes('<think>') && !parsed.includes('</think>')) {
            const sepIdx = parsed.indexOf('\n---\n');
            if (sepIdx > 0) {
                const thinkContent = parsed.slice(0, sepIdx).trim();
                const storyContent  = parsed.slice(sepIdx + 5).trim(); // 5 = len('\n---\n')
                if (thinkContent && storyContent) {
                    parsed = `<think>\n${thinkContent}\n</think>\n${storyContent}`;
                }
            }
        }

        // Safety Fallback: Normalise malformed <think> blocks before extraction.
        // Case A: Closing tag present but no opener → inject opener at start.
        if (parsed.includes('</think>') && !parsed.includes('<think>')) {
            parsed = '<think>\n' + parsed;
        }
        // Case B: Opening tag present but no closing tag.
        // Do NOT inject </think> at the end — that would swallow all story text into the collapsed block.
        // Instead strip the bare opener; content stays visible as story text.
        // (When streaming, the next chunk that delivers </think> will re-enter this function with both
        //  tags present, and normal extraction will run cleanly at that point.)
        if (parsed.includes('<think>') && !parsed.includes('</think>')) {
            parsed = parsed.replace(/<think>/gi, '');
        }

        const extractTag = (match) => {
            richTags.push(match);
            return `%%RICH_TAG_${richTags.length - 1}%%`;
        };

        parsed = parsed.replace(/<text-message[\s\S]*?<\/text-message>/gi, extractTag);
        parsed = parsed.replace(/<task[\s\S]*?<\/task>/gi, extractTag);
        parsed = parsed.replace(/<stat-bar[\s\S]*?(?:\/>|<\/stat-bar>|>)/gi, extractTag);
        parsed = parsed.replace(/<scene-image[\s\S]*?<\/scene-image>/gi, extractTag);
        parsed = parsed.replace(/<think>[\s\S]*?<\/think>/gi, extractTag);
        // Case C: Strip any stray unpaired tags that survived normalisation (last-resort defence).
        parsed = parsed.replace(/<think>/gi, '').replace(/<\/think>/gi, '');

        // 2. Safely escape the remaining text
        parsed = this.escapeHtml(parsed);

        // 3. Apply Markdown & Aesthetics
        parsed = parsed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        parsed = parsed.replace(/\*([^*]+)\*/g, "<em>$1</em>");
        parsed = parsed.replace(/&quot;([\s\S]*?)&quot;/g, '<span style="color: var(--accent, #8b5cf6); font-weight: 500;">&quot;$1&quot;</span>');
        parsed = parsed.replace(/“([\s\S]*?)”/g, '<span style="color: var(--accent, #8b5cf6); font-weight: 500;">“$1”</span>');
        parsed = parsed.replace(/^&gt; (.*)$/gm, '<blockquote style="border-left: 3px solid var(--accent); padding-left: 0.75rem; margin: 0.5rem 0; color: var(--text-secondary); font-style: italic;">$1</blockquote>');

        // 4. Restore the Rich XML tags
        parsed = parsed.replace(placeholderRegex, (match, index) => richTags[index]);

        // Process <scene-image> tags
        parsed = parsed.replace(/<scene-image\s+src="([^"]+)"\s+prompt="([^"]*)"\s*(?:><\/scene-image>|\/>)/g, (match, url, prompt) => {
            return `
                <div class="chat-scene-image-wrapper" onclick="if(window.app && window.app.openGallery) window.app.openGallery([{url: '${url}', prompt: decodeURIComponent('${encodeURIComponent(prompt)}'), label: 'Chat Scene'}]);">
                    <img src="${url}" alt="Generated Scene" class="chat-scene-image">
                    <div class="gallery-trigger-overlay">🔍</div>
                </div>
            `;
        });

        if (window.RichElementParser) {
            parsed = window.RichElementParser.parse(parsed);
        }

        parsed = parsed.replace(/\n/g, '<br>');
        return parsed;
    }

    scrollToBottom(smooth = false) {
        if (this.els.timeline) {
            this.els.timeline.scrollTo({
                top: this.els.timeline.scrollHeight,
                behavior: smooth ? 'smooth' : 'auto'
            });
        }
    }

    scrollToMessage(element) {
        if (!element || !this.els.timeline) return;
        this.els.timeline.scrollTo({
            top: element.offsetTop,
            behavior: 'smooth'
        });
    }

    stopGeneration() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isGenerating = false;
        this.els.sendBtn.style.display = '';
        if (this.els.impBtn) this.els.impBtn.style.display = '';
        if (this.els.stopBtn) this.els.stopBtn.style.display = 'none';
        this.els.sendBtn.disabled = false;
        this.els.msgInput.focus();
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
            impBtn.innerHTML = '⏳ Generating...';
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

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.slice(6);
                    if (dataStr.trim() === '[DONE]') continue;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === 'chunk') {
                            generatedText += data.content;
                            // Stream text into the input field live
                            this.els.msgInput.value = generatedText;
                            // Auto-resize the textarea if possible
                            this.els.msgInput.dispatchEvent(new Event('input'));
                        } else if (data.type === 'error') {
                            console.error('Impersonate stream error:', data.message);
                        }
                    } catch (err) {
                        console.warn('Failed to parse impersonate SSE data:', dataStr, err);
                    }
                }
            }
        } catch (e) {
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
        this.updateOocBadge();
        const userBubbleWrapper = this.appendMessage(userMsgObj, true);

        this.isGenerating = true;
        this.els.sendBtn.style.display = 'none';
        if (this.els.impBtn) this.els.impBtn.style.display = 'none';
        if (this.els.stopBtn) this.els.stopBtn.style.display = '';

        // Create empty AI bubble for streaming
        const aiMsgObj = { role: 'assistant', character_name: characterName || 'Routing...', content: '' };
        const aiBubbleWrapper = this.appendMessage(aiMsgObj, true);
        const contentEl = aiBubbleWrapper.querySelector('.chat-bubble');
        const nameTextEl = aiBubbleWrapper.querySelector('.chat-bubble-name-text');

        this.abortController = new AbortController();

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

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (dataStr.trim() === '[DONE]') continue;
                        try {
                            const data = JSON.parse(dataStr);
                            if (data.type === 'api_log' && window.apiHandler) {
                                window.apiHandler.addBackendLog(data.log);
                                continue;
                            }

                            if (data.type === 'metadata') {
                                if (data.character_name) {
                                    nameTextEl.textContent = data.character_name;
                                    aiMsgObj.character_name = data.character_name;
                                }
                                if (data.character_card_id) {
                                    aiMsgObj.character_card_id = data.character_card_id;
                                    const avatarUrl = this.getAvatarUrl(data.character_name, data.character_card_id);
                                    if (avatarUrl) {
                                        const imgEl = aiBubbleWrapper.querySelector('.chat-avatar-char-img');
                                        if (imgEl) {
                                            imgEl.src = avatarUrl;
                                        } else {
                                            const avatarDiv = aiBubbleWrapper.querySelector('.chat-avatar-container');
                                            if (avatarDiv) {
                                                avatarDiv.innerHTML = `<img src="${avatarUrl}" alt="" class="chat-avatar-char-img" style="width:100%;height:100%;object-fit:cover;cursor:pointer;border-radius:0.5rem;">`;
                                                const newImgEl = avatarDiv.querySelector('img');
                                                if (newImgEl) {
                                                    newImgEl.addEventListener('click', (e) => {
                                                        e.stopPropagation();
                                                        if (window.app && window.app.openGallery) {
                                                            window.app.openGallery([{ url: avatarUrl, label: data.character_name || 'Character' }]);
                                                        }
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            } else if (data.type === 'chunk') {
                                fullText += data.content;
                                aiMsgObj.content = fullText;
                                contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                            } else if (data.type === 'error') {
                                console.error('Chat generation error:', data.message);
                                contentEl.innerHTML += `<br><span style="color:var(--error);">Error: ${this.escapeHtml(data.message)}</span>`;
                            }
                        } catch (err) {
                            console.warn('Failed to parse chat SSE stream data:', dataStr, err);
                        }
                    }
                }
            }
        } catch (e) {
            const isAbort = e.name === 'AbortError';
            if (!isAbort) {
                console.error('Chat stream error', e);
                // Network drop (e.g. phone lock/503): reload from server to clear partial
                // optimistic bubble and sync any content the backend saved in the background.
                if (this.activeChatId) {
                    try { await this.selectChat(this.activeChatId); } catch (_) {}
                }
            }
        } finally {
            this.isGenerating = false;
            this.abortController = null;
            this.els.sendBtn.style.display = '';
            if (this.els.impBtn) this.els.impBtn.style.display = '';
            if (this.els.stopBtn) this.els.stopBtn.style.display = 'none';
            this.els.sendBtn.disabled = false;
            this.els.msgInput.focus();

            // Background fetch to assign server-generated IDs to new messages so action buttons work
            window.authFetch(`/api/sw/chats/${this.activeChatId}`).then(res => res.json()).then(chat => {
                if (chat && chat.messages && this.activeChatId === chat.id) {
                    const serverMessages = chat.messages;
                    const lastUser = serverMessages.slice().reverse().find(m => m.role === 'user');
                    if (lastUser && userBubbleWrapper && !userMsgObj.id) {
                        userMsgObj.id = lastUser.id;
                        this.attachMessageActions(userBubbleWrapper, userMsgObj, userBubbleWrapper.querySelector('.chat-bubble'), userBubbleWrapper.querySelector('.chat-bubble-name'));
                    }
                    const lastAi = serverMessages[serverMessages.length - 1];
                    if (lastAi && lastAi.role !== 'user' && !aiMsgObj.id) {
                        aiMsgObj.id = lastAi.id;
                        this.attachMessageActions(aiBubbleWrapper, aiMsgObj, contentEl, nameTextEl.parentElement);
                    }
                    // Keep regen button on the correct (last) AI bubble
                    this._updateRegenButtons();
                }
            }).catch(e => console.error("Error fetching updated chat", e));
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

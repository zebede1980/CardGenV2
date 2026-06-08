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
        this.fixMobileLayout();
        this.bindEvents();
        this.setupTabIntegration();
        this.loadPersonas();
    }

    setupSidebarToggle() {
        const titleEl = document.getElementById('chat-active-title');
        const sessionList = document.getElementById('chat-session-list');
        const newBtn = document.getElementById('chat-new-btn');
        if (!titleEl || !sessionList) return;

        // Safely locate the sidebar container by finding the common ancestor of the list and the 'New Chat' button
        let sidebar = sessionList.closest('.sidebar, aside');
        if (!sidebar && newBtn) {
            let curr = sessionList;
            while (curr && curr !== document.body) {
                if (curr.contains(newBtn)) {
                    sidebar = curr;
                    break;
                }
                curr = curr.parentElement;
            }
        }
        if (!sidebar) sidebar = sessionList.parentElement;

        sidebar.id = 'chat-sidebar-container';

        const header = titleEl.parentElement;

        if (!document.getElementById('chat-sidebar-toggle')) {
            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'chat-sidebar-toggle';
            toggleBtn.className = 'btn-outline';
            toggleBtn.style.cssText = 'padding: 0.25rem 0.5rem; margin-right: 0.75rem; display: flex; align-items: center; justify-content: center; border-radius: 0.4rem; cursor: pointer; min-height: 2.25rem;';
            toggleBtn.innerHTML = '◀';
            toggleBtn.title = 'Toggle Chat Sidebar';

            toggleBtn.addEventListener('click', () => {
                if (sidebar.style.display === 'none') {
                    sidebar.style.display = '';
                    toggleBtn.innerHTML = '◀';
                } else {
                    sidebar.style.display = 'none';
                    toggleBtn.innerHTML = '▶';
                }
            });

            header.style.display = 'flex';
            header.style.alignItems = 'center';
            header.insertBefore(toggleBtn, header.firstChild);
            
            if (!document.getElementById('chat-fullscreen-toggle')) {
                const fsBtn = document.createElement('button');
                fsBtn.id = 'chat-fullscreen-toggle';
                fsBtn.className = 'btn-outline';
                fsBtn.style.cssText = 'padding: 0.25rem 0.5rem; margin-left: auto; display: flex; align-items: center; justify-content: center; border-radius: 0.4rem; cursor: pointer; min-height: 2.25rem; font-size: 1.2rem;';
                fsBtn.innerHTML = '⛶';
                fsBtn.title = 'Toggle Fullscreen';
                fsBtn.addEventListener('click', () => this.toggleFullscreen());
                header.appendChild(fsBtn);
            }
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
                    
                    <h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">Modular System Prompt</h3>
                    <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">These segments are combined to form the default system prompt when starting a new chat.</p>
                    
                    <div id="chat-global-prompt-segments" style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; flex: 1; min-height: 250px; overflow-y: auto; padding-right: 0.5rem;">
                        <!-- Segments injected here -->
                    </div>
                    
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="text" id="chat-global-new-segment" class="content-box" style="flex: 1;" placeholder="New prompt segment...">
                        <button id="chat-global-add-segment" class="btn-primary">Add</button>
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

    fixMobileLayout() {
        if (!document.getElementById('chat-mobile-fixes')) {
            const style = document.createElement('style');
            style.id = 'chat-mobile-fixes';
            style.textContent = `
                /* Fix global horizontal scrolling */
                html, body {
                    overflow-x: hidden;
                    max-width: 100vw;
                }
                
                #view-roleplaychat.chat-fullscreen {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    height: 100dvh !important;
                    z-index: 9999 !important;
                    background: var(--bg-page) !important;
                    padding: 0.25rem !important; /* Maximise mobile screen space */
                    box-sizing: border-box !important;
                }
                
                #chat-fullscreen-toggle {
                    display: none !important; /* Hide button on desktop */
                }
                
                /* Make the root chat view a fixed height flex container to prevent scrolling off-screen */
                #view-roleplaychat:not([style*="display: none"]) {
                    display: flex !important;
                }
                
                #view-roleplaychat {
                    height: calc(100vh - 85px);
                    height: calc(100dvh - 85px); /* Subtract approximate top nav height */
                    overflow: hidden;
                    box-sizing: border-box;
                    width: 100%;
                    max-width: 100vw;
                }
                
                #chat-timeline ~ div {
                    flex-shrink: 0;
                }
                
                .chat-bubble pre {
                    max-width: 100%;
                    overflow-x: auto;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                }
                
                @media (max-width: 768px) {
                    #view-roleplaychat {
                        flex-direction: column !important;
                        height: calc(100vh - 130px) !important; /* Extra room for wrapped nav tabs */
                        height: calc(100dvh - 130px) !important;
                    }
                    
                    #chat-fullscreen-toggle {
                        display: flex !important; /* Only show button on mobile screens */
                    }
                    
                    
                    /* Constrain sidebar height on mobile so the chat area is still reachable */
                    #chat-sidebar-container {
                        max-height: 25vh !important;
                        width: 100% !important;
                        border-right: none !important;
                        border-bottom: 1px solid var(--border);
                        flex-shrink: 0;
                        overflow-y: auto;
                    }
                    
                    /* Always show message actions on mobile (since no hover) */
                    .chat-message-actions {
                        opacity: 1 !important;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        // The parent of the timeline is the right-side main chat column
        if (this.els.timeline && this.els.timeline.parentElement) {
            const mainArea = this.els.timeline.parentElement;
            mainArea.style.flex = '1 1 auto';
            mainArea.style.display = 'flex';
            mainArea.style.flexDirection = 'column';
            mainArea.style.minWidth = '0';
            mainArea.style.minHeight = '0'; // Crucial to prevent content pushing timeline out of bounds
            mainArea.style.height = '100%';
            mainArea.style.overflow = 'hidden';
            
            // The timeline takes all remaining space and handles the scrolling
            this.els.timeline.style.flex = '1 1 0%';
            this.els.timeline.style.overflowY = 'auto';
            this.els.timeline.style.minHeight = '0'; // Allow it to shrink
            this.els.timeline.style.paddingBottom = '1rem';
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
                
                viewChat.style.display = 'flex';
                tabChat.className = 'btn-primary';
                
                this.loadSessionList();
                this.loadPersonas();
            });
            
            // Hide chat view when other tabs are clicked
            if (tabCardGen) {
                tabCardGen.addEventListener('click', () => {
                    viewChat.style.display = 'none';
                    tabChat.className = 'btn-outline';
                });
            }
            if (tabStoryWriter) {
                tabStoryWriter.addEventListener('click', () => {
                    viewChat.style.display = 'none';
                    tabChat.className = 'btn-outline';
                });
            }
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
            globalPromptSegments: document.getElementById('chat-global-prompt-segments'),
            globalNewSegment: document.getElementById('chat-global-new-segment'),
            globalAddSegmentBtn: document.getElementById('chat-global-add-segment'),
            globalSaveBtn: document.getElementById('chat-global-save-btn'),

            activeTitle: document.getElementById('chat-active-title'),
            activeChars: document.getElementById('chat-active-characters'),
            
            timeline: document.getElementById('chat-timeline'),
            
            msgInput: document.getElementById('chat-message-input'),
            sendBtn: document.getElementById('chat-send-btn'),
            
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
            userPersonaSelect: document.getElementById('chat-user-persona-select'),
        };
    }

    bindEvents() {
        if(!this.els.sessionList) return; 

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
        
        this.els.oocToggleBtn.addEventListener('click', () => {
            const isHidden = this.els.oocContainer.style.display === 'none';
            this.els.oocContainer.style.display = isHidden ? 'block' : 'none';
            if(isHidden) this.els.oocInput.focus();
        });
        
        this.els.sendBtn.addEventListener('click', () => this.sendMessage());
        
        this.els.msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        
        this.els.oocInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        
        if (this.els.userPersonaSelect) {
            this.els.userPersonaSelect.addEventListener('change', (e) => {
                localStorage.setItem('chatgen_active_user_persona', e.target.value);
                if (this.activeChatId) {
                    this.selectChat(this.activeChatId);
                }
            });
        }
    }

    openGlobalSettings() {
        if (!window.config) return;
        this.els.globalMaxInput.value = window.config.get("chat.maxInputTokens") ?? 8192;
        this.els.globalMaxOutput.value = window.config.get("chat.maxOutputTokens") ?? 1024;
        this.els.globalTemp.value = window.config.get("chat.temperature") ?? 0.8;
        this.els.globalRepPen.value = window.config.get("chat.repetitionPenalty") ?? 1.0;
        
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
        
        try {
            this.els.createSubmitBtn.disabled = true;
            this.els.createSubmitBtn.textContent = 'Creating...';
            
            const res = await window.authFetch('/api/sw/chats/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, system_prompt: sysPrompt, card_ids: cardIds })
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
                if(confirm(`Are you sure you want to delete "${chat.title}"?`)) {
                    await window.authFetch(`/api/sw/chats/${chat.id}`, { method: 'DELETE' });
                    if(this.activeChatId === chat.id) this.activeChatId = null;
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
            this.availablePersonas = allCards;
            
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
                
                if (this.availablePersonas.some(c => String(c.id) === String(currentVal))) {
                    this.els.userPersonaSelect.value = currentVal;
                } else {
                    this.els.userPersonaSelect.value = '';
                    localStorage.removeItem('chatgen_active_user_persona');
                }
            }
        } catch (e) {
            console.error("Failed to load personas", e);
        }
    }

    toggleFullscreen() {
        const chatView = document.getElementById('view-roleplaychat');
        const fsBtn = document.getElementById('chat-fullscreen-toggle');
        const sidebar = document.getElementById('chat-sidebar-container');
        const sidebarToggle = document.getElementById('chat-sidebar-toggle');
        
        if (!chatView) return;

        if (!chatView.classList.contains('chat-fullscreen')) {
            chatView.classList.add('chat-fullscreen');
            fsBtn.innerHTML = '✖';
            fsBtn.title = 'Exit Fullscreen';
            
            // Store previous sidebar state
            this.preFsSidebarDisplay = sidebar ? sidebar.style.display : '';
            if (sidebar) sidebar.style.display = 'none';
            if (sidebarToggle) sidebarToggle.style.display = 'none';
        } else {
            chatView.classList.remove('chat-fullscreen');
            fsBtn.innerHTML = '⛶';
            fsBtn.title = 'Toggle Fullscreen';
            
            // Restore sidebar state
            if (sidebar) sidebar.style.display = this.preFsSidebarDisplay !== undefined ? this.preFsSidebarDisplay : '';
            if (sidebarToggle) sidebarToggle.style.display = '';
        }
        
        setTimeout(() => this.scrollToBottom(), 50);
    }

    async selectChat(chatId) {
        this.activeChatId = chatId;
        
        // Mobile UI improvement: auto-collapse sidebar when a chat is selected
        if (window.innerWidth <= 768) {
            const sidebar = document.getElementById('chat-sidebar-container');
            const toggleBtn = document.getElementById('chat-sidebar-toggle');
            if (sidebar && toggleBtn && sidebar.style.display !== 'none') {
                sidebar.style.display = 'none';
                toggleBtn.innerHTML = '▶';
            }
        }
        
        document.querySelectorAll('.chat-session-item').forEach(el => {
            if(el.dataset.id === chatId) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
        
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

            this.els.timeline.innerHTML = '';
            
            // Ensure messages are sorted chronologically (oldest first)
            const sortedMessages = (chat.messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            sortedMessages.forEach(msg => this.appendMessage(msg));
            
            if(chat.messages.length === 0) {
                this.els.timeline.innerHTML = '<div class="chat-placeholder"><p>No messages yet. Send a greeting!</p></div>';
            }
            
            this.els.msgInput.disabled = false;
            this.els.sendBtn.disabled = false;
            
            // Initial scroll
            setTimeout(() => this.scrollToBottom(), 50);
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
        const id = localStorage.getItem('chatgen_active_user_persona');
        if (!id || !this.availablePersonas) return null;
        return this.availablePersonas.find(c => String(c.id) === String(id)) || null;
    }

    appendMessage(msg) {
        const placeholder = this.els.timeline.querySelector('.chat-placeholder');
        if (placeholder) placeholder.remove();
        
        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper ${msg.role}`;
        wrapper.style.display = 'flex';
        wrapper.style.gap = '10px';
        wrapper.style.marginBottom = '1rem';
        wrapper.style.width = '100%';
        wrapper.style.boxSizing = 'border-box';
        if (msg.role === 'user') {
            wrapper.style.flexDirection = 'row-reverse';
        }
        
        let displayCharName = msg.character_name;
        if ((!displayCharName || displayCharName === 'Routing...') && this.activeChatCharacters && this.activeChatCharacters.length === 1) {
            displayCharName = this.activeChatCharacters[0].name;
        }

        const nameEl = document.createElement('div');
        nameEl.className = 'chat-bubble-name';
        nameEl.style.display = 'flex';
        nameEl.style.justifyContent = 'space-between';
        nameEl.style.alignItems = 'center';
        nameEl.style.width = '100%';
        nameEl.style.marginBottom = '0.25rem';
        
        const nameText = document.createElement('span');
        nameText.className = 'chat-bubble-name-text';
        nameText.style.fontWeight = '600';
        nameText.style.fontSize = '0.85rem';
        nameText.style.color = 'var(--text-secondary)';
        
        // Clear any stray text nodes and only show name for AI to prevent duplication
        nameEl.innerHTML = '';
        nameText.textContent = msg.role === 'user' ? '' : (displayCharName || 'Assistant');
        nameEl.appendChild(nameText);
        
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'chat-bubble';
        bubbleEl.style.padding = '0.75rem 1rem';
        bubbleEl.style.borderRadius = '0.75rem';
        bubbleEl.style.maxWidth = '100%';
        bubbleEl.style.wordBreak = 'break-word';
        
        if (msg.role === 'user') {
            bubbleEl.style.backgroundColor = 'var(--surface-color)';
            bubbleEl.style.color = 'var(--text-primary)';
            bubbleEl.style.border = '1px solid var(--border)';
            bubbleEl.style.borderBottomRightRadius = '0';
        } else {
            bubbleEl.style.backgroundColor = 'var(--bg-tertiary, rgba(0,0,0,0.1))';
            bubbleEl.style.color = 'var(--text-primary)';
            bubbleEl.style.border = '1px solid var(--border)';
            bubbleEl.style.borderBottomLeftRadius = '0';
        }
        
        let contentStr = msg.content || '';
        bubbleEl.innerHTML = this.formatMessage(contentStr, msg.character_name);
        
        if (msg.ooc_note) {
            const oocEl = document.createElement('details');
            oocEl.style.marginTop = '0.5rem';
            oocEl.style.fontSize = '0.85rem';
            oocEl.innerHTML = `<summary style="cursor: pointer; opacity: 0.7; font-weight: 500;">OOC Instruction</summary><div style="margin-top: 0.25rem; font-style: italic; opacity: 0.8; padding-left: 0.5rem; border-left: 2px solid var(--border);">${this.escapeHtml(msg.ooc_note)}</div>`;
            bubbleEl.appendChild(oocEl);
        }
        
        
        const avatarEl = document.createElement('div');
        avatarEl.style.width = '64px';
        avatarEl.style.height = '64px';
        avatarEl.style.flexShrink = '0';
        avatarEl.style.borderRadius = '0.5rem';
        avatarEl.style.overflow = 'hidden';
        avatarEl.style.backgroundColor = 'var(--surface-color)';
        avatarEl.style.display = 'flex';
        avatarEl.style.alignItems = 'center';
        avatarEl.style.justifyContent = 'center';
        avatarEl.style.fontWeight = 'bold';
        
        const userPersona = this.getUserPersonaData();
        const userName = userPersona ? (userPersona.characterName || (userPersona.character && userPersona.character.name) || userPersona.name || "User") : "User";

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
                    avatarEl.style.fontSize = '1.2rem';
                }
            } else {
                avatarEl.textContent = 'U';
                avatarEl.style.fontSize = '1.5rem';
            }
        } else {
            const avatarUrl = this.getAvatarUrl(displayCharName, msg.character_card_id);
            if (avatarUrl) {
                avatarEl.innerHTML = `<img src="${avatarUrl}" alt="" class="chat-avatar-char-img" style="width:100%;height:100%;object-fit:cover;cursor:pointer;border-radius:0.5rem;">`;
                const imgEl = avatarEl.querySelector('img');
                imgEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (window.app && window.app.openGallery) {
                        window.app.openGallery([{ url: avatarUrl, label: displayCharName || 'Character' }]);
                    }
                });
            } else {
                avatarEl.textContent = (displayCharName || 'AI').substring(0, 2).toUpperCase();
            }
        }
        
        const contentCol = document.createElement('div');
        contentCol.style.display = 'flex';
        contentCol.style.flexDirection = 'column';
        contentCol.style.maxWidth = 'calc(100% - 74px)';
        contentCol.style.minWidth = '0'; // CRITICAL: allows flex child to shrink below its content's intrinsic width
        if (msg.role === 'user') contentCol.style.alignItems = 'flex-end';
        
        contentCol.appendChild(nameEl);
        contentCol.appendChild(bubbleEl);
        
        wrapper.appendChild(avatarEl);
        wrapper.appendChild(contentCol);
        
        if (msg.id) {
            this.attachMessageActions(wrapper, msg, bubbleEl, nameEl);
        }
        
        this.els.timeline.appendChild(wrapper);
        this.scrollToBottom();
        
        return wrapper;
    }

    attachMessageActions(wrapper, msg, bubbleEl, nameEl) {
        if (wrapper.querySelector('.chat-message-actions')) return;

        const actionsEl = document.createElement('div');
        actionsEl.className = 'chat-message-actions';
        actionsEl.style.display = 'flex';
        actionsEl.style.gap = '0.5rem';
        actionsEl.style.opacity = '0';
        actionsEl.style.transition = 'opacity 0.2s';

        wrapper.addEventListener('mouseenter', () => actionsEl.style.opacity = '1');
        wrapper.addEventListener('mouseleave', () => actionsEl.style.opacity = '0');

        const editBtn = document.createElement('button');
        editBtn.className = 'chat-action-btn';
        editBtn.innerHTML = '✏️ Edit';
        editBtn.onclick = () => this.editMessage(msg, bubbleEl);

        const delBtn = document.createElement('button');
        delBtn.className = 'chat-action-btn';
        delBtn.innerHTML = '🗑️';
        delBtn.onclick = () => this.deleteMessage(msg.id, wrapper);

        actionsEl.appendChild(editBtn);
        actionsEl.appendChild(delBtn);

        nameEl.appendChild(actionsEl);
    }

    async editMessage(msg, bubbleEl) {
        if (bubbleEl.querySelector('textarea')) return;

        const currentContent = msg.content || '';
        const originalHTML = bubbleEl.innerHTML;
        
        const textarea = document.createElement('textarea');
        textarea.className = 'content-box';
        textarea.style.width = '100%';
        textarea.style.minHeight = '100px';
        textarea.style.fontFamily = 'inherit';
        textarea.style.marginBottom = '0.5rem';
        textarea.value = currentContent;

        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.gap = '0.5rem';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary btn-small';
        saveBtn.textContent = 'Save';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-outline btn-small';
        cancelBtn.textContent = 'Cancel';

        controls.appendChild(saveBtn);
        controls.appendChild(cancelBtn);

        bubbleEl.innerHTML = '';
        bubbleEl.appendChild(textarea);
        bubbleEl.appendChild(controls);
        textarea.focus();

        cancelBtn.onclick = () => {
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
        if (!confirm('Are you sure you want to delete this message?')) return;
        try {
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/messages/${id}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                wrapper.remove();
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

        // 1. Temporarily extract Rich XML tags to protect their inner attributes from being formatted
        const richTags = [];
        const placeholderRegex = /%%RICH_TAG_(\d+)%%/g;
        
        const extractTag = (match) => {
            richTags.push(match);
            return `%%RICH_TAG_${richTags.length - 1}%%`;
        };
        
        parsed = parsed.replace(/<text-message[\s\S]*?<\/text-message>/gi, extractTag);
        parsed = parsed.replace(/<task[\s\S]*?<\/task>/gi, extractTag);
        parsed = parsed.replace(/<stat-bar[\s\S]*?(?:\/>|<\/stat-bar>|>)/gi, extractTag);

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

        if (window.RichElementParser) {
            parsed = window.RichElementParser.parse(parsed);
        }
        
        parsed = parsed.replace(/\n/g, '<br>');
        return parsed;
    }

    scrollToBottom() {
        this.els.timeline.scrollTop = this.els.timeline.scrollHeight;
    }

    async sendMessage() {
        if (!this.activeChatId || this.isGenerating) return;
        
        const content = this.els.msgInput.value.trim();
        let oocNote = this.els.oocInput.value.trim();
        
        if (!content && !oocNote) {
            oocNote = "Please continue the story.";
        }
        
        let characterName = null;
        if (this.els.speakerSelect && this.els.speakerSelect.style.display !== 'none') {
            characterName = this.els.speakerSelect.value || null;
        }
        
        // 1. Optimistic UI update
        const userMsgObj = { role: 'user', content, ooc_note: oocNote };
        this.els.msgInput.value = '';
        this.els.oocInput.value = '';
        const userBubbleWrapper = this.appendMessage(userMsgObj);
        
        this.isGenerating = true;
        this.els.sendBtn.disabled = true;
        
        // 2. Create empty AI bubble for streaming
        const aiMsgObj = { role: 'assistant', character_name: characterName || 'Routing...', content: '' };
        const aiBubbleWrapper = this.appendMessage(aiMsgObj);
        const contentEl = aiBubbleWrapper.querySelector('.chat-bubble');
        const nameTextEl = aiBubbleWrapper.querySelector('.chat-bubble-name-text');
        const nameEl = aiBubbleWrapper.querySelector('.chat-bubble-name');

        try {
            const payload = { 
                content, 
                ooc_note: oocNote, 
                character_name: characterName 
            };
            
            if (window.config) {
                payload.max_input_tokens = window.config.get("chat.maxInputTokens");
                payload.max_output_tokens = window.config.get("chat.maxOutputTokens");
                payload.temperature = window.config.get("chat.temperature");
                payload.repetition_penalty = window.config.get("chat.repetitionPenalty");
            }
            
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) throw new Error("API Request Failed");
            
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let fullText = "";
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop(); // Keep the last partial line in the buffer
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
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
                                        const imgEl = aiBubbleWrapper.querySelector('.chat-avatar-char-img');
                                        if (imgEl) {
                                            imgEl.src = avatarUrl;
                                        } else {
                                            const avatarDiv = aiBubbleWrapper.querySelector('div:first-child');
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
                            } else if (data.type === 'chunk') {
                                fullText += data.content;
                                aiMsgObj.content = fullText;
                                contentEl.innerHTML = this.formatMessage(fullText, aiMsgObj.character_name);
                            } else if (data.type === 'error') {
                                console.error("Chat generation error:", data.message);
                                contentEl.innerHTML += `<br><span style="color:var(--error);">Error: ${this.escapeHtml(data.message)}</span>`;
                            }
                        } catch (err) {
                            console.warn("Failed to parse chat SSE stream data:", dataStr, err);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Stream error", e);
        } finally {
            this.isGenerating = false;
            this.els.sendBtn.disabled = false;
            this.els.msgInput.focus();
        }
    }
}

// Initialize Handler globally
window.roleplayChatHandler = new RoleplayChatHandler();
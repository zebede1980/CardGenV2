/**
 * RoleplayChatHandler
 * Handles state, DOM binding, and backend API interactions for the Roleplay Chat tab.
 */
class RoleplayChatHandler {
    constructor() {
        this.activeChatId = null;
        this.isGenerating = false;
        this.chats = [];
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.bindElements();
        this.bindEvents();
        this.setupTabIntegration();
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
                
                viewChat.style.display = 'block';
                tabChat.className = 'btn-primary';
                
                this.loadSessionList();
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
            newChars: document.getElementById('chat-new-characters'),
            newSysPrompt: document.getElementById('chat-new-system-prompt'),
            createSubmitBtn: document.getElementById('chat-create-submit-btn'),
        };
    }

    bindEvents() {
        if(!this.els.sessionList) return; 

        this.els.newBtn.addEventListener('click', () => this.openNewChatModal());
        this.els.newCloseBtn.addEventListener('click', () => this.closeNewChatModal());
        this.els.createSubmitBtn.addEventListener('click', () => this.createNewChat());
        
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
    }

    async openNewChatModal() {
        try {
            const res = await window.authFetch('/api/cards/');
            const cards = await res.json();
            
            this.els.newChars.innerHTML = '';
            cards.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.name || 'Unnamed';
                this.els.newChars.appendChild(opt);
            });
            
            this.els.newTitle.value = '';
            this.els.newSysPrompt.value = '';
            this.els.newModal.classList.add('show');
        } catch (e) {
            console.error("Failed to load cards for modal", e);
        }
    }

    closeNewChatModal() {
        this.els.newModal.classList.remove('show');
    }

    async createNewChat() {
        const title = this.els.newTitle.value.trim() || 'New Chat';
        const sysPrompt = this.els.newSysPrompt.value.trim();
        const selectedOpts = Array.from(this.els.newChars.selectedOptions);
        const cardIds = selectedOpts.map(o => parseInt(o.value));
        
        try {
            this.els.createSubmitBtn.disabled = true;
            this.els.createSubmitBtn.textContent = 'Creating...';
            
            const res = await window.authFetch('/api/chats/', {
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
            const res = await window.authFetch('/api/chats/');
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
                    await window.authFetch(`/api/chats/${chat.id}`, { method: 'DELETE' });
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

    async selectChat(chatId) {
        this.activeChatId = chatId;
        
        document.querySelectorAll('.chat-session-item').forEach(el => {
            if(el.dataset.id === chatId) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
        
        try {
            const res = await window.authFetch(`/api/chats/${chatId}`);
            if (!res.ok) return;
            const chat = await res.json();
            
            this.els.activeTitle.textContent = chat.title;
            this.els.activeChars.textContent = chat.characters.map(c => c.name).join(', ') || 'No characters linked';
            
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
            chat.messages.forEach(msg => this.appendMessage(msg));
            
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

    appendMessage(msg) {
        const placeholder = this.els.timeline.querySelector('.chat-placeholder');
        if (placeholder) placeholder.remove();
        
        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper ${msg.role}`;
        
        const nameEl = document.createElement('div');
        nameEl.className = 'chat-bubble-name';
        nameEl.textContent = msg.role === 'user' ? 'You' : (msg.character_name || 'Assistant');
        
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'chat-bubble';
        
        let contentStr = msg.content || '';
        if (msg.ooc_note) {
            contentStr += `\n\n*[OOC: ${msg.ooc_note}]*`;
        }
        
        bubbleEl.innerHTML = this.formatMessage(contentStr);
        
        wrapper.appendChild(nameEl);
        wrapper.appendChild(bubbleEl);
        
        this.els.timeline.appendChild(wrapper);
        this.scrollToBottom();
        
        return wrapper;
    }

    formatMessage(text) {
        if (!text) return "";
        let parsed = text;
        
        if (window.RichElementParser) {
            // Parse custom UI XML elements into HTML
            parsed = window.RichElementParser.parse(parsed);
        } else {
            // Basic escape if parser is missing
            parsed = parsed.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
        
        // Convert remaining double-newlines to paragraph breaks
        parsed = parsed.replace(/\n/g, '<br>');
        return parsed;
    }

    scrollToBottom() {
        this.els.timeline.scrollTop = this.els.timeline.scrollHeight;
    }

    async sendMessage() {
        if (!this.activeChatId || this.isGenerating) return;
        
        const content = this.els.msgInput.value.trim();
        const oocNote = this.els.oocInput.value.trim();
        
        if (!content && !oocNote) return;
        
        let characterName = null;
        if (this.els.speakerSelect && this.els.speakerSelect.style.display !== 'none') {
            characterName = this.els.speakerSelect.value || null;
        }
        
        // 1. Optimistic UI update
        this.els.msgInput.value = '';
        this.els.oocInput.value = '';
        this.appendMessage({ role: 'user', content, ooc_note: oocNote });
        
        this.isGenerating = true;
        this.els.sendBtn.disabled = true;
        
        // 2. Create empty AI bubble for streaming
        const aiBubble = this.appendMessage({ role: 'assistant', character_name: characterName || 'Routing...', content: '' });
        const contentEl = aiBubble.querySelector('.chat-bubble');
        const nameEl = aiBubble.querySelector('.chat-bubble-name');
        
        try {
            const res = await window.authFetch(`/api/chats/${this.activeChatId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, ooc_note: oocNote, character_name: characterName })
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
                        const data = JSON.parse(dataStr);
                        
                        if (data.type === 'metadata' && data.character_name) {
                            nameEl.textContent = data.character_name;
                        } else if (data.type === 'chunk') {
                            fullText += data.content;
                            contentEl.innerHTML = this.formatMessage(fullText);
                            if (nameEl.textContent === 'Routing...' || nameEl.textContent === 'Generating...') {
                                nameEl.textContent = 'Assistant'; // Fallback
                            }
                            this.scrollToBottom();
                        } else if (data.type === 'error') {
                            console.error("LLM Error:", data.message);
                            contentEl.innerHTML += `<br><span style="color:var(--error)">[Error: ${data.message}]</span>`;
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
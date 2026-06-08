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
            newSelectedChars: document.getElementById('chat-new-selected-chars'),
            newAddCharBtn: document.getElementById('chat-new-add-char-btn'),
            newSysPrompt: document.getElementById('chat-new-system-prompt'),
            createSubmitBtn: document.getElementById('chat-create-submit-btn'),
        };
    }

    bindEvents() {
        if(!this.els.sessionList) return; 

        this.els.newBtn.addEventListener('click', () => this.openNewChatModal());
        this.els.newCloseBtn.addEventListener('click', () => this.closeNewChatModal());
        this.els.createSubmitBtn.addEventListener('click', () => this.createNewChat());
        
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
    }

    async openNewChatModal(preselectCardId = null) {
        this.newChatSelectedCards = [];
        this.renderNewChatSelectedChars();
        this.els.newTitle.value = '';
        this.els.newSysPrompt.value = '';
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

    appendMessage(msg) {
        const placeholder = this.els.timeline.querySelector('.chat-placeholder');
        if (placeholder) placeholder.remove();
        
        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper ${msg.role}`;
        wrapper.style.display = 'flex';
        wrapper.style.gap = '10px';
        wrapper.style.marginBottom = '1rem';
        if (msg.role === 'user') {
            wrapper.style.flexDirection = 'row-reverse';
        }
        
        const nameEl = document.createElement('div');
        nameEl.className = 'chat-bubble-name';
        nameEl.textContent = msg.role === 'user' ? 'You' : (msg.character_name || 'Assistant');
        nameEl.style.display = 'flex';
        nameEl.style.justifyContent = 'space-between';
        nameEl.style.alignItems = 'center';
        nameEl.style.width = '100%';
        
        const nameText = document.createElement('span');
        nameText.className = 'chat-bubble-name-text';
        nameText.textContent = msg.role === 'user' ? 'You' : (msg.character_name || 'Assistant');
        nameEl.appendChild(nameText);
        
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'chat-bubble';
        
        if (msg.role === 'user') {
            bubbleEl.style.backgroundColor = 'var(--surface-color)';
            bubbleEl.style.color = 'var(--text-primary)';
            bubbleEl.style.border = '1px solid var(--border)';
        }
        
        let contentStr = msg.content || '';
        if (msg.ooc_note) {
            if (contentStr) {
                contentStr += `\n\n*[OOC: ${msg.ooc_note}]*`;
            } else {
                contentStr = `*[OOC: ${msg.ooc_note}]*`;
            }
        }
        
        bubbleEl.innerHTML = this.formatMessage(contentStr, msg.character_name);
        
        
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
        
        if (msg.role === 'user') {
            avatarEl.textContent = 'U';
            avatarEl.style.fontSize = '1.5rem';
        } else {
            const avatarUrl = this.getAvatarUrl(msg.character_name, msg.character_card_id);
            if (avatarUrl) {
                avatarEl.innerHTML = `<img src="${avatarUrl}" alt="" class="chat-avatar-char-img" style="width:100%;height:100%;object-fit:cover;cursor:pointer;border-radius:0.5rem;">`;
                const imgEl = avatarEl.querySelector('img');
                imgEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (window.app && window.app.openGallery) {
                        window.app.openGallery([{ url: avatarUrl, label: msg.character_name || 'Character' }]);
                    }
                });
            } else {
                avatarEl.textContent = (msg.character_name || 'AI').substring(0, 2).toUpperCase();
            }
        }
        
        const contentCol = document.createElement('div');
        contentCol.style.display = 'flex';
        contentCol.style.flexDirection = 'column';
        contentCol.style.maxWidth = 'calc(100% - 74px)';
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
                    let contentStr = msg.content;
                    if (msg.ooc_note) {
                        if (contentStr) contentStr += `\n\n*[OOC: ${msg.ooc_note}]*`;
                        else contentStr = `*[OOC: ${msg.ooc_note}]*`;
                    }
                    bubbleEl.innerHTML = this.formatMessage(contentStr, msg.character_name);
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
        const userName = "User"; // We'll upgrade this when user avatars are added!
        
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
            const res = await window.authFetch(`/api/sw/chats/${this.activeChatId}/message`, {
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
                                this.scrollToBottom();
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
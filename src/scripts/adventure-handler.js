class AdventureHandler {
    constructor() {
        this.currentSessionId = null;
        this.selectedCharacters = [];
        this.isGenerating = false;
        this.systemPromptSegments = [];
        
        this.initDOM();
        this.bindEvents();
        this.injectSettingsModal();
    }

    initDOM() {
        this.viewTabs = {
            cardgen: document.getElementById('view-cardgen'),
            storywriter: document.getElementById('view-storywriter'),
            roleplaychat: document.getElementById('view-roleplaychat'),
            adventure: document.getElementById('view-adventure')
        };
        
        this.tabBtns = {
            cardgen: document.getElementById('tab-cardgen'),
            storywriter: document.getElementById('tab-storywriter'),
            roleplaychat: document.getElementById('tab-roleplaychat'),
            adventure: document.getElementById('tab-adventure')
        };
        
        // Setup View
        this.setupView = document.getElementById('adv-setup-view');
        this.selectedCharsContainer = document.getElementById('adv-selected-chars');
        this.addCharBtn = document.getElementById('adv-add-char-btn');
        this.startingScenario = document.getElementById('adv-starting-scenario');
        this.systemPrompt = document.getElementById('adv-system-prompt');
        this.startBtn = document.getElementById('adv-start-btn');
        this.listContainer = document.getElementById('adv-list');
        
        // Play View
        this.playView = document.getElementById('adv-play-view');
        this.backBtn = document.getElementById('adv-back-btn');
        this.titleInput = document.getElementById('adv-title');
        this.storyArea = document.getElementById('adv-story-area');
        this.optionsArea = document.getElementById('adv-options-area');
        this.loadingIndicator = document.getElementById('adv-loading');
    }

    bindEvents() {
        if(this.tabBtns.adventure) {
            this.tabBtns.adventure.addEventListener('click', () => this.showView());
        }
        
        this.addCharBtn.addEventListener('click', async () => {
            if (!window.cardGallery || !window.characterStorage) {
                alert("Gallery module not loaded.");
                return;
            }
            try {
                const allCards = await window.characterStorage.listCards();
                const unselectedCards = allCards.filter(c => !this.selectedCharacters.includes(c.id) && c.isPermanent);
                window.cardGallery.open(unselectedCards, (selectedCardOrId) => {
                    const cardId = typeof selectedCardOrId === 'object' ? selectedCardOrId.id : selectedCardOrId;
                    if (!this.selectedCharacters.includes(cardId)) {
                        this.selectedCharacters.push(cardId);
                        this.renderSelectedCharacters();
                    }
                });
            } catch (e) {
                console.error("Failed to load cards for gallery", e);
            }
        });
        
        this.startBtn.addEventListener('click', () => this.startNewAdventure());
        this.backBtn.addEventListener('click', () => {
            this.playView.style.display = 'none';
            this.setupView.style.display = 'block';
            this.currentSessionId = null;
            this.loadSessionList();
        });
    }

    showView() {
        // Hide all views, show this one
        Object.values(this.viewTabs).forEach(v => { if(v) v.style.display = 'none'; });
        Object.values(this.tabBtns).forEach(b => { if(b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); } });
        
        this.viewTabs.adventure.style.display = 'block';
        this.tabBtns.adventure.classList.remove('btn-outline');
        this.tabBtns.adventure.classList.add('btn-primary');
        
        this.playView.style.display = 'none';
        this.setupView.style.display = 'block';
        
        const segments = window.config?.get("adventure.systemPromptSegments") || [];
        if (this.systemPrompt) {
            this.systemPrompt.value = segments.join("\n\n");
        }
        
        this.loadSessionList();
    }

    async renderSelectedCharacters() {
        this.selectedCharsContainer.innerHTML = '';
        if (this.selectedCharacters.length === 0) {
            this.selectedCharsContainer.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.85rem; margin: auto;">No characters selected</span>';
            return;
        }
        
        for (const id of this.selectedCharacters) {
            const card = await window.characterStorage.getCard(id);
            if (!card) continue;
            const cardName = card.characterName || (card.character && card.character.name) || card.name || 'Unknown';
            
            const badge = document.createElement('div');
            badge.style.cssText = 'display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.5rem; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem;';
            badge.innerHTML = `
                <span>${cardName}</span>
                <button type="button" class="btn-clear" style="padding:0; font-size:1rem; line-height:1; color:var(--text-soft); border:none; background:transparent; cursor:pointer;" title="Remove">×</button>
            `;
            badge.querySelector('button').addEventListener('click', () => {
                this.selectedCharacters = this.selectedCharacters.filter(cid => cid !== id);
                this.renderSelectedCharacters();
            });
            this.selectedCharsContainer.appendChild(badge);
        }
    }

    async loadSessionList() {
        try {
            const sessions = await authFetch('/api/sw/adventures/');
            const data = await sessions.json();
            
            this.listContainer.innerHTML = '';
            if (data.length === 0) {
                this.listContainer.innerHTML = '<li style="padding:1rem; color:var(--text-secondary); text-align:center;">No adventures saved yet.</li>';
                return;
            }
            
            data.forEach(sess => {
                const li = document.createElement('li');
                li.className = 'story-list-item';
                li.innerHTML = `
                    <div style="flex:1;">
                        <div class="story-list-title">${sess.title}</div>
                        <div class="story-list-date">Updated: ${new Date(sess.updated_at).toLocaleString()}</div>
                    </div>
                    <button class="btn-outline btn-small resume-btn">Resume</button>
                    <button class="btn-danger btn-small delete-btn">Delete</button>
                `;
                
                li.querySelector('.resume-btn').addEventListener('click', () => this.resumeSession(sess.id));
                li.querySelector('.delete-btn').addEventListener('click', async () => {
                    if(confirm("Delete this adventure?")) {
                        await authFetch('/api/sw/adventures/' + sess.id, { method: 'DELETE' });
                        this.loadSessionList();
                    }
                });
                this.listContainer.appendChild(li);
            });
        } catch (e) {
            console.error("Failed to load adventures", e);
        }
    }

    async startNewAdventure() {
        const title = "Adventure " + new Date().toLocaleString();
        const scenario = this.startingScenario.value.trim();
        const sysPrompt = this.systemPrompt ? this.systemPrompt.value.trim() : "";
        const cards = this.selectedCharacters;
        
        try {
            const res = await authFetch('/api/sw/adventures/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    starting_scenario: scenario,
                    system_prompt: sysPrompt,
                    card_ids: cards
                })
            });
            const data = await res.json();
            this.currentSessionId = data.id;
            
            this.setupView.style.display = 'none';
            this.playView.style.display = 'flex';
            this.titleInput.value = data.title;
            this.storyArea.innerHTML = '';
            this.optionsArea.innerHTML = '';
            
            this.selectedCharacters = [];
            this.renderSelectedCharacters();
            this.startingScenario.value = '';
            
            await this.sendAction("", "system"); // Trigger the first generation
        } catch (e) {
            alert("Failed to start adventure: " + e.message);
        }
    }

    async resumeSession(id) {
        try {
            const res = await authFetch('/api/sw/adventures/' + id);
            const data = await res.json();
            
            this.currentSessionId = data.id;
            this.setupView.style.display = 'none';
            this.playView.style.display = 'flex';
            this.titleInput.value = data.title;
            
            this.storyArea.innerHTML = '';
            this.optionsArea.innerHTML = '';
            
            let lastAssistantOptions = null;
            
            data.actions.forEach(action => {
                if (action.is_summarized) return;
                
                if (action.role === 'user') {
                    this.appendStorySegment(`<b>Next:</b> ${action.content}`);
                } else if (action.role === 'assistant') {
                    this.appendStorySegment(this.formatStory(action.content));
                    if (action.options) {
                        try {
                            lastAssistantOptions = JSON.parse(action.options);
                        } catch(e) {}
                    }
                }
            });
            
            if (lastAssistantOptions && lastAssistantOptions.length > 0) {
                this.renderOptions(lastAssistantOptions);
            } else if (data.actions.length > 0 && data.actions[data.actions.length - 1].role === 'user') {
                // Last action was user choice, we need to generate assistant response
                this.sendAction("", "system");
            } else if (data.actions.length === 0) {
                this.sendAction("", "system");
            }
            
            this.scrollToBottom();
        } catch (e) {
            alert("Failed to load adventure: " + e.message);
        }
    }

    appendStorySegment(htmlContent) {
        const div = document.createElement('div');
        div.className = 'adv-story-segment';
        div.style.cssText = 'padding: 0.5rem; border-left: 3px solid var(--accent); margin-bottom: 0.5rem; background: var(--surface); border-radius: 0 8px 8px 0; font-size: 1.05rem; line-height: 1.6;';
        div.innerHTML = htmlContent;
        this.storyArea.appendChild(div);
        this.scrollToBottom();
        return div;
    }

    formatStory(text) {
        return text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');
    }

    scrollToBottom() {
        this.storyArea.scrollTop = this.storyArea.scrollHeight;
    }

    renderOptions(optionsArray) {
        this.optionsArea.innerHTML = '';
        if (!optionsArray || optionsArray.length === 0) {
            // Provide a default continue button if parsing failed
            const btn = document.createElement('button');
            btn.className = 'btn-primary';
            btn.style.padding = '1rem';
            btn.textContent = 'Continue...';
            btn.addEventListener('click', () => this.sendAction("Continue...", "user"));
            this.optionsArea.appendChild(btn);
            return;
        }
        
        optionsArray.forEach((optText, index) => {
            const btn = document.createElement('button');
            btn.className = 'btn-outline adv-option-btn';
            btn.style.cssText = 'padding: 0.8rem; text-align: left; height: 100%; font-size: 0.95rem; line-height: 1.3; display: flex; align-items: center; gap: 0.5rem;';
            
            const numBadge = document.createElement('span');
            numBadge.style.cssText = 'background: var(--accent); color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-weight: bold; font-size: 0.8rem;';
            numBadge.textContent = index + 1;
            
            const textSpan = document.createElement('span');
            textSpan.textContent = optText;
            
            btn.appendChild(numBadge);
            btn.appendChild(textSpan);
            
            btn.addEventListener('click', () => {
                this.appendStorySegment(`<b>Next:</b> ${optText}`);
                this.sendAction(optText, "user");
            });
            this.optionsArea.appendChild(btn);
        });
    }

    async sendAction(content, role) {
        if (this.isGenerating) return;
        this.isGenerating = true;
        this.optionsArea.innerHTML = '';
        this.loadingIndicator.style.display = 'flex';
        
        const segmentDiv = this.appendStorySegment('...');
        let accumulatedText = "";
        
        try {
            const res = await authFetch(`/api/sw/adventures/${this.currentSessionId}/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: content,
                    role: role
                })
            });
            
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let optionsParsed = null;
            let finalCleanedStory = null;
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        
                        const data = JSON.parse(jsonStr);
                        if (data.type === 'chunk') {
                            accumulatedText += data.content;
                            // Update UI dynamically but hide the [OPTION X] markers if they start appearing
                            // Actually, they only appear at the very end.
                            let displayText = accumulatedText;
                            if (displayText.includes('[OPTION')) {
                                displayText = displayText.split('[OPTION')[0];
                            }
                            segmentDiv.innerHTML = this.formatStory(displayText);
                            this.scrollToBottom();
                        } else if (data.type === 'parsed_options') {
                            optionsParsed = data.options;
                            finalCleanedStory = data.cleaned_story;
                        } else if (data.type === 'done') {
                            break;
                        } else if (data.type === 'error') {
                            throw new Error(data.message);
                        }
                    }
                }
            }
            
            if (finalCleanedStory) {
                segmentDiv.innerHTML = this.formatStory(finalCleanedStory);
            }
            if (optionsParsed) {
                this.renderOptions(optionsParsed);
            }
            
        } catch (e) {
            console.error(e);
            segmentDiv.innerHTML = '<span style="color:var(--error);">Error generating story.</span>';
            this.optionsArea.innerHTML = '<button class="btn-primary" onclick="adventureHandler.sendAction(\'\', \'system\')">Retry</button>';
        } finally {
            this.isGenerating = false;
            this.loadingIndicator.style.display = 'none';
            this.scrollToBottom();
        }
    }

    injectSettingsModal() {
        if (document.getElementById('adv-global-settings-modal')) return;
        
        const modal = document.createElement('div');
        modal.id = 'adv-global-settings-modal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.style.zIndex = '2000';
        modal.innerHTML = `
            <div class="api-settings-modal" style="max-width: 600px; width: 90%; max-height: 90vh; height: auto; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h2 class="modal-title">⚙️ Adventure Global Settings</h2>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <button id="adv-global-settings-close" class="modal-close">×</button>
                    </div>
                </div>
                <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column;">
                    <h3 style="margin-top: 0; margin-bottom: 0.5rem;">Modular System Prompt</h3>
                    <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">These segments are combined to form the default system prompt when starting a new adventure.</p>
                    
                    <div id="adv-global-prompt-segments" style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; flex: 1; min-height: 250px; overflow-y: auto; padding-right: 0.5rem;">
                        <!-- Segments injected here -->
                    </div>
                    
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="text" id="adv-global-new-segment" class="content-box" style="flex: 1;" placeholder="New prompt segment...">
                        <button id="adv-global-add-segment" class="btn-primary">Add</button>
                    </div>
                    
                    <div style="margin-top: 1.5rem; display: flex; justify-content: flex-end;">
                        <button id="adv-global-save-btn" class="btn-primary">Save Settings</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add a settings button to the Setup view title
        const setupTitle = document.querySelector('#adv-setup-view .section-title');
        if (setupTitle) {
            const settingsBtn = document.createElement('button');
            settingsBtn.id = 'adv-open-global-settings';
            settingsBtn.className = 'btn-outline btn-small';
            settingsBtn.innerHTML = '⚙️ Settings';
            settingsBtn.style.marginLeft = '1rem';
            settingsBtn.style.fontSize = '0.9rem';
            setupTitle.appendChild(settingsBtn);
            
            settingsBtn.addEventListener('click', () => this.openGlobalSettings());
        }

        document.getElementById('adv-global-settings-close').addEventListener('click', () => {
            document.getElementById('adv-global-settings-modal').style.display = 'none';
        });
        document.getElementById('adv-global-save-btn').addEventListener('click', () => this.saveGlobalSettings());
        document.getElementById('adv-global-add-segment').addEventListener('click', () => this.addSystemPromptSegment());
        
        document.getElementById('adv-global-new-segment').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.addSystemPromptSegment();
        });
    }

    openGlobalSettings() {
        if (!window.config) return;
        this.systemPromptSegments = [...(window.config.get("adventure.systemPromptSegments") || [])];
        this.renderSystemPromptSegments();
        document.getElementById('adv-global-settings-modal').style.display = 'flex';
    }

    renderSystemPromptSegments() {
        const container = document.getElementById('adv-global-prompt-segments');
        if (!container) return;
        container.innerHTML = '';
        
        this.systemPromptSegments.forEach((seg, i) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'flex-start';
            row.style.padding = '0.5rem';
            row.style.background = 'var(--surface-color)';
            row.style.border = '1px solid var(--border)';
            row.style.borderRadius = '0.4rem';
            row.style.gap = '0.5rem';
            row.draggable = true;
            
            const dragHandle = document.createElement('div');
            dragHandle.innerHTML = '☰';
            dragHandle.style.cursor = 'grab';
            dragHandle.style.color = 'var(--text-secondary)';
            dragHandle.style.paddingTop = '0.2rem';
            dragHandle.style.userSelect = 'none';
            
            row.addEventListener('dragstart', (e) => {
                this.draggedSegmentIndex = i;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', i);
                setTimeout(() => row.style.opacity = '0.4', 0);
            });
            
            row.addEventListener('dragend', () => {
                row.style.opacity = '1';
                this.draggedSegmentIndex = null;
                Array.from(container.children).forEach(r => r.style.boxShadow = '');
            });
            
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this.draggedSegmentIndex !== null && this.draggedSegmentIndex !== i) {
                    if (this.draggedSegmentIndex < i) row.style.boxShadow = '0 2px 0 var(--accent)';
                    else row.style.boxShadow = '0 -2px 0 var(--accent)';
                }
            });
            
            row.addEventListener('dragleave', () => row.style.boxShadow = '');
            
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
            container.appendChild(row);

            setTimeout(autoSize, 0);
        });
    }

    addSystemPromptSegment() {
        const newSegInput = document.getElementById('adv-global-new-segment');
        const val = newSegInput.value.trim();
        if (val) {
            this.systemPromptSegments.push(val);
            newSegInput.value = '';
            this.renderSystemPromptSegments();
        }
    }

    saveGlobalSettings() {
        if (!window.config) return;
        window.config.set("adventure.systemPromptSegments", this.systemPromptSegments);
        document.getElementById('adv-global-settings-modal').style.display = 'none';
        
        // Update the textarea if we are currently on the setup view
        const segments = window.config.get("adventure.systemPromptSegments") || [];
        if (this.systemPrompt) {
            this.systemPrompt.value = segments.join("\n\n");
        }
        
        if (window.app && window.app.showNotification) {
            window.app.showNotification("Adventure global settings saved", "success");
        } else {
            alert("Settings saved!");
        }
    }
}

window.adventureHandler = null;
document.addEventListener('DOMContentLoaded', () => {
    window.adventureHandler = new AdventureHandler();
});

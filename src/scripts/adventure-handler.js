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
        
        // Landing & Modal View
        this.landingView = document.getElementById('adv-landing-view');
        this.sessionGrid = document.getElementById('adv-session-grid');
        this.newBtn = document.getElementById('adv-new-btn');
        this.newModal = document.getElementById('adv-new-modal');
        this.newModalClose = document.getElementById('adv-new-modal-close');
        
        // Modal Form Controls
        this.selectedCharsContainer = document.getElementById('adv-selected-chars');
        this.addCharBtn = document.getElementById('adv-add-char-btn');
        this.startingScenario = document.getElementById('adv-starting-scenario');
        this.systemPrompt = document.getElementById('adv-system-prompt');
        this.startBtn = document.getElementById('adv-start-btn');
        
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
        
        this.newBtn.addEventListener('click', () => this.openNewAdventureModal());
        this.newModalClose.addEventListener('click', () => this.closeNewAdventureModal());
        
        this.startBtn.addEventListener('click', () => this.startNewAdventure());
        this.backBtn.addEventListener('click', () => {
            this.playView.style.display = 'none';
            this.landingView.style.display = 'block';
            this.currentSessionId = null;
            this.loadSessionList();
        });

        // ── Phone-lock / tab-switch resilience ────────────────────────────────
        document.addEventListener('visibilitychange', () => this.syncOnWake());
        window.addEventListener('focus', () => this.syncOnWake());
    }

    /**
     * Fires whenever the document becomes visible again (phone unlock, tab switch, app resume).
     *
     * Two behaviours depending on state:
     *   1. Actively generating  — poll the server to see if it finished while the client was
     *      asleep. If so, call resumeSession() to rebuild the play view from saved state.
     *   2. Idle with play view open — silently refresh from server so changes made on another
     *      device (e.g. desktop adding the next story beat) appear automatically.
     */
    async syncOnWake() {
        if (document.visibilityState !== 'visible') return;
        if (!this.currentSessionId) return;
        if (this.playView && this.playView.style.display === 'none') return; // Not in play mode

        try {
            const res = await authFetch(`/api/sw/adventures/${this.currentSessionId}`);
            if (!res.ok) return;
            const data = await res.json();

            const actions = data.actions || [];
            const lastAction = actions[actions.length - 1];

            // ── Detect server-side pending generation (same pattern as Chat) ─
            // Backend creates an empty assistant action before streaming.
            // If the last DB action is an empty assistant, server is still running.
            const serverIsGenerating = lastAction && lastAction.role === 'assistant' && lastAction.content === '';

            if (serverIsGenerating) {
                // Ensure loading state is shown regardless of client isGenerating flag
                this.isGenerating = true;
                this.loadingIndicator.style.display = 'flex';
                // Abort any stale client stream
                if (this._abortController) { this._abortController.abort(); this._abortController = null; }
                // Start polling if not already polling
                if (!this._pollingInterval) {
                    this._pollingInterval = setInterval(async () => {
                        try {
                            const pollRes = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}`);
                            if (!pollRes.ok) return;
                            const pollData = await pollRes.json();
                            const pollActions = pollData.actions || [];
                            const pollLast = pollActions[pollActions.length - 1];
                            if (pollLast && pollLast.role === 'assistant' && pollLast.content !== '') {
                                clearInterval(this._pollingInterval);
                                this._pollingInterval = null;
                                this.isGenerating = false;
                                this.loadingIndicator.style.display = 'none';
                                await this.resumeSession(this.currentSessionId);
                            }
                        } catch(e) {}
                    }, 3000);
                }
                return;
            }

            // No pending generation — check if DOM is out of date
            const domCount = this.storyArea
                ? this.storyArea.querySelectorAll('.adv-story-wrapper[data-role="assistant"]').length
                : 0;
            const dbCount = actions.filter(a => !a.is_summarized && a.role === 'assistant' && a.content !== '').length;

            if (this.isGenerating && this._abortController) {
                // Client was streaming but server already finished — abort stream and reload
                this._wakeAbort = true;
                this._abortController.abort();
            } else if (dbCount !== domCount) {
                // Idle cross-device sync: DB and DOM are out of sync, reload silently
                await this.resumeSession(this.currentSessionId);
            }
            // If dbCount === domCount and not generating: do nothing — avoids needless re-render
        } catch (e) {
            console.error('[Adventure] syncOnWake failed:', e);
        }
    }

    showView() {
        // Hide all views, show this one
        Object.values(this.viewTabs).forEach(v => { if(v) v.style.display = 'none'; });
        Object.values(this.tabBtns).forEach(b => { if(b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); } });
        
        this.viewTabs.adventure.style.display = 'block';
        this.tabBtns.adventure.classList.remove('btn-outline');
        this.tabBtns.adventure.classList.add('btn-primary');
        
        this.playView.style.display = 'none';
        this.landingView.style.display = 'block';
        
        this.loadSessionList();
    }
    
    openNewAdventureModal() {
        const segments = window.config?.get("adventure.systemPromptSegments") || [];
        if (this.systemPrompt) {
            this.systemPrompt.value = segments.join("\n\n");
        }
        
        this.selectedCharacters = [];
        this.renderSelectedCharacters();
        if (this.startingScenario) this.startingScenario.value = '';
        
        this.newModal.style.display = 'flex';
    }
    
    closeNewAdventureModal() {
        this.newModal.style.display = 'none';
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
            
            this.sessionGrid.innerHTML = '';
            if (data.length === 0) {
                this.sessionGrid.innerHTML = '<div style="color: var(--text-secondary); grid-column: 1 / -1;">No adventures saved yet. Click + New Adventure to begin!</div>';
                return;
            }
            
            data.forEach(sess => {
                const card = document.createElement('div');
                card.className = 'content-box';
                card.style.cursor = 'pointer';
                card.style.position = 'relative';
                card.style.display = 'flex';
                card.style.flexDirection = 'column';
                
                // Character Thumbnails
                let thumbnailsHtml = '';
                if (sess.characters && sess.characters.length > 0) {
                    thumbnailsHtml = '<div style="display: flex; gap: -0.5rem; margin-bottom: 0.75rem;">';
                    sess.characters.forEach((char, idx) => {
                        const avatarUrl = this.getAvatarUrl(char.id);
                        thumbnailsHtml += `<img src="${avatarUrl}" title="${char.name}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 2px solid var(--surface-color); margin-left: ${idx === 0 ? '0' : '-8px'}; z-index: ${sess.characters.length - idx}; background: var(--surface-strong);">`;
                    });
                    thumbnailsHtml += '</div>';
                }
                
                card.innerHTML = `
                    ${thumbnailsHtml}
                    <h3 style="margin-top: 0; margin-bottom: 0.25rem; padding-right: 2.5rem; font-size: 1.1rem; line-height: 1.3;">${sess.title}</h3>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 1rem; flex: 1;">Updated: ${new Date(sess.updated_at).toLocaleDateString()}</div>
                    <div style="display: flex; gap: 0.5rem; margin-top: auto;">
                        <button class="btn-outline btn-small resume-btn" style="flex: 1;">Resume</button>
                    </div>
                `;
                
                const delBtn = document.createElement('button');
                delBtn.textContent = '🗑️';
                delBtn.title = 'Delete adventure';
                delBtn.style.cssText = 'position:absolute; top:0.6rem; right:0.6rem; background:none; border:1px solid transparent; border-radius:4px; cursor:pointer; font-size:1rem; color:var(--error-color,#e55); opacity:0.55; padding:0.2rem 0.35rem; line-height:1; z-index: 2;';
                delBtn.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; delBtn.style.borderColor = 'var(--error-color,#e55)'; delBtn.style.background = 'rgba(220,50,50,0.1)'; });
                delBtn.addEventListener('mouseleave', () => { delBtn.style.opacity = '0.55'; delBtn.style.borderColor = 'transparent'; delBtn.style.background = 'none'; });
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if(confirm("Delete this adventure? This cannot be undone.")) {
                        await authFetch('/api/sw/adventures/' + sess.id, { method: 'DELETE' });
                        this.loadSessionList();
                    }
                });
                
                card.addEventListener('click', () => this.resumeSession(sess.id));
                card.querySelector('.resume-btn').addEventListener('click', (e) => { e.stopPropagation(); this.resumeSession(sess.id); });
                
                card.appendChild(delBtn);
                this.sessionGrid.appendChild(card);
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
            
            this.closeNewAdventureModal();
            this.playView.style.display = 'flex';
            this.titleInput.value = data.title;
            this.storyArea.innerHTML = '';
            this.optionsArea.innerHTML = '';
            
            this.selectedCharacters = [];
            this.renderSelectedCharacters();
            this.renderActiveCharacters(data.characters);
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
            this.landingView.style.display = 'none';
            this.playView.style.display = 'flex';
            this.titleInput.value = data.title;
            
            this.storyArea.innerHTML = '';
            this.optionsArea.innerHTML = '';
            
            this.renderActiveCharacters(data.characters);
            
            let lastAssistantOptions = null;
            
            data.actions.forEach(action => {
                if (action.is_summarized) return;
                
                if (action.role === 'user') {
                    this.appendStorySegment(`<b>Next:</b> ${action.content}`, action.id, 'user');
                } else if (action.role === 'assistant') {
                    this.appendStorySegment(this.formatStory(action.content), action.id, 'assistant');
                    if (action.options) {
                        try {
                            lastAssistantOptions = JSON.parse(action.options);
                        } catch(e) {}
                    }
                }
            });
            
            const lastAction = data.actions[data.actions.length - 1];
            const serverIsGenerating = lastAction && lastAction.role === 'assistant' && lastAction.content === '';
            
            if (serverIsGenerating) {
                this.isGenerating = true;
                this.loadingIndicator.style.display = 'flex';
                
                if (this._pollingInterval) clearInterval(this._pollingInterval);
                this._pollingInterval = setInterval(async () => {
                    try {
                        const pollRes = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}`);
                        if (!pollRes.ok) return;
                        const pollData = await pollRes.json();
                        const pollActions = pollData.actions || [];
                        const pollLast = pollActions[pollActions.length - 1];
                        
                        if (pollLast && pollLast.role === 'assistant' && pollLast.content !== '') {
                            clearInterval(this._pollingInterval);
                            this._pollingInterval = null;
                            this.isGenerating = false;
                            this.loadingIndicator.style.display = 'none';
                            this.resumeSession(this.currentSessionId);
                        }
                    } catch(e) {}
                }, 3000);
                
                this.scrollToBottom();
                return;
            }
            
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

    getAvatarUrl(cardId) {
        if (!cardId) return 'assets/default-avatar.png';
        const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || "";
        return `/api/storage/cards/thumbnail?cardId=${cardId}&token=${token}`;
    }

    renderActiveCharacters(characters) {
        const container = document.getElementById('adv-active-characters');
        if (!container) return;
        
        container.innerHTML = '';
        if (!characters || characters.length === 0) {
            container.style.display = 'none';
            return;
        }
        
        container.style.display = 'flex';
        characters.forEach(char => {
            const charName = char.characterName || (char.character && char.character.name) || char.name || 'Unknown';
            const charAvatar = this.getAvatarUrl(char.id);
            
            const badge = document.createElement('div');
            badge.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 0.25rem;';
            badge.innerHTML = `
                <img src="${charAvatar}" alt="${charName}" onerror="this.src='assets/default-avatar.png'" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid var(--accent);">
                <span style="font-size: 0.75rem; color: var(--text-secondary); max-width: 60px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${charName}</span>
            `;
            container.appendChild(badge);
        });
    }

    appendStorySegment(htmlContent, actionId = null, role = 'assistant') {
        const wrapper = document.createElement('div');
        wrapper.className = 'adv-story-wrapper';
        wrapper.style.cssText = 'position: relative; margin-bottom: 0.5rem; display: flex; flex-direction: column;';
        if (actionId) wrapper.dataset.actionId = actionId;
        if (role) wrapper.dataset.role = role;

        const div = document.createElement('div');
        div.className = 'adv-story-segment';
        div.style.cssText = 'padding: 0.5rem; border-left: 3px solid var(--accent); background: var(--surface); border-radius: 0 8px 8px 0; font-size: 1.05rem; line-height: 1.6; position: relative; padding-right: 3rem;';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'adv-story-content';
        contentDiv.innerHTML = htmlContent;
        div.appendChild(contentDiv);

        if (actionId) {
            const actionsEl = document.createElement('div');
            actionsEl.className = 'adv-segment-actions';
            actionsEl.style.cssText = 'position: absolute; top: 0.25rem; right: 0.25rem; display: flex; gap: 0.25rem; opacity: 0.2; transition: opacity 0.2s;';
            div.onmouseenter = () => actionsEl.style.opacity = '1';
            div.onmouseleave = () => actionsEl.style.opacity = '0.2';

            const editBtn = document.createElement('button');
            editBtn.innerHTML = '&#9998;';
            editBtn.title = 'Edit';
            editBtn.style.cssText = 'background: none; border: none; cursor: pointer; font-size: 0.9rem; color: var(--text); padding: 2px;';
            editBtn.onclick = () => this.editAction(actionId, wrapper);
            actionsEl.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.innerHTML = '&#10006;';
            delBtn.title = 'Delete';
            delBtn.style.cssText = 'background: none; border: none; cursor: pointer; font-size: 0.9rem; color: var(--text); padding: 2px;';
            delBtn.onclick = () => this.deleteAction(actionId, wrapper);
            actionsEl.appendChild(delBtn);

            if (role === 'assistant') {
                const regenBtn = document.createElement('button');
                regenBtn.className = 'adv-regen-btn';
                regenBtn.innerHTML = '&#8635;';
                regenBtn.title = 'Regenerate';
                regenBtn.style.cssText = 'background: none; border: none; cursor: pointer; font-size: 0.9rem; color: var(--text); padding: 2px; display: none;';
                regenBtn.onclick = () => this.regenAction(actionId, wrapper);
                actionsEl.appendChild(regenBtn);
            }

            div.appendChild(actionsEl);
        }

        wrapper.appendChild(div);
        this.storyArea.appendChild(wrapper);
        this.scrollToBottom();
        this._updateRegenButtons();
        return div;
    }

    _updateRegenButtons() {
        const allWrappers = Array.from(this.storyArea.querySelectorAll('.adv-story-wrapper'));
        let lastAssistantWrapper = null;
        for (let i = allWrappers.length - 1; i >= 0; i--) {
            if (allWrappers[i].dataset.role === 'assistant') {
                lastAssistantWrapper = allWrappers[i];
                break;
            }
        }
        allWrappers.forEach(w => {
            const btn = w.querySelector('.adv-regen-btn');
            if (btn) {
                btn.style.display = (w === lastAssistantWrapper) ? 'block' : 'none';
            }
        });
    }

    async deleteAction(actionId, wrapper) {
        if (!confirm("Delete this action?")) return;
        try {
            await authFetch(`/api/sw/adventures/${this.currentSessionId}/actions/${actionId}`, { method: 'DELETE' });
            wrapper.remove();
            this._updateRegenButtons();
        } catch (e) {
            console.error("Failed to delete action", e);
        }
    }

    async editAction(actionId, wrapper) {
        const contentDiv = wrapper.querySelector('.adv-story-content');
        const role = wrapper.dataset.role;
        // Extract raw text. If user, remove "<b>Next:</b> " prefix.
        let rawText = contentDiv.innerText;
        if (role === 'user' && rawText.startsWith('Next: ')) {
            rawText = rawText.substring(6).trim();
        }

        const newText = prompt("Edit text:", rawText);
        if (newText === null || newText === rawText) return;

        try {
            const res = await authFetch(`/api/sw/adventures/${this.currentSessionId}/actions/${actionId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: newText })
            });
            const updated = await res.json();
            if (role === 'user') {
                contentDiv.innerHTML = `<b>Next:</b> ${updated.content}`;
            } else {
                contentDiv.innerHTML = this.formatStory(updated.content);
            }
        } catch (e) {
            console.error("Failed to edit action", e);
        }
    }

    async regenAction(actionId, wrapper) {
        if (!confirm("Regenerate this response?")) return;
        try {
            await authFetch(`/api/sw/adventures/${this.currentSessionId}/actions/${actionId}`, { method: 'DELETE' });
            wrapper.remove();
            this._updateRegenButtons();
            // Now generate a new one
            this.sendAction("", "system");
        } catch (e) {
            console.error("Failed to regen action", e);
        }
    }

    escapeHtml(unsafe) {
        if (!unsafe) return "";
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    formatStory(text) {
        if (!text) return "";
        let parsed = text;
        
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
                    <img src="${url}" alt="Generated Scene" class="chat-scene-image" style="max-width:100%; border-radius:0.5rem; margin:0.5rem 0;">
                </div>
            `;
        });

        if (window.RichElementParser) {
            parsed = window.RichElementParser.parse(parsed);
        }
        
        return parsed.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');
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
                const div = this.appendStorySegment(`<b>Next:</b> ${optText}`, null, 'user');
                this.sendAction(optText, "user");
            });
            this.optionsArea.appendChild(btn);
        });
    }

    async sendAction(content, role) {
        if (this.isGenerating) return;
        this.isGenerating = true;
        this._wakeAbort = false;
        this.optionsArea.innerHTML = '';
        this.loadingIndicator.style.display = 'flex';
        
        const wrapper = this.appendStorySegment('...', null, 'assistant');
        const segmentDiv = wrapper.querySelector('.adv-story-segment') || wrapper;
        let accumulatedText = "";
        
        // Get settings from config, defaulting to some sensible values if not set
        const maxInput = window.config?.get("adventure.maxInputTokens") || 2048;
        const maxOutput = window.config?.get("adventure.maxOutputTokens") || 512;
        const repPenalty = window.config?.get("adventure.repetitionPenalty") || 1.0;
        
        this._abortController = new AbortController();
        
        try {
            const res = await window.authFetch(`/api/sw/adventures/${this.currentSessionId}/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: content,
                    role: role,
                    max_input_tokens: maxInput,
                    max_output_tokens: maxOutput,
                    repetition_penalty: repPenalty,
                    enable_cot: window.config?.get("adventure.enableCot") !== false
                }),
                signal: this._abortController.signal
            });
            
            if (!res.ok) {
                if (res.status >= 500 || res.status === 408) {
                    console.warn(`[Adventure] Received ${res.status}, server might succeed in background. Syncing...`);
                    throw new Error(`API Request Failed: ${res.status}`);
                }
                throw new Error('API Request Failed');
            }
            
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let optionsParsed = null;
            let finalCleanedStory = null;
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        
                        const data = JSON.parse(jsonStr);
                        if (data.type === 'api_log' && window.apiHandler) { window.apiHandler.addBackendLog(data.log); } else if (data.type === 'chunk') {
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
                        } else if (data.type === 'metadata') {
                            if (data.assistant_action_id) {
                                wrapper.dataset.actionId = data.assistant_action_id;
                            }
                        } else if (data.type === 'done') {
                            break;
                        } else if (data.type === 'error') {
                            throw new Error(data.message);
                        }
                    }
                }
            }
            
            
            // Now that stream is done, let's re-render the wrapper so it has buttons
            const actionId = wrapper.dataset.actionId;
            wrapper.remove();
            
            const renderStory = finalCleanedStory ? finalCleanedStory : accumulatedText;
            const newDiv = this.appendStorySegment(this.formatStory(renderStory), actionId, 'assistant');
            
            if (optionsParsed) {
                this.renderOptions(optionsParsed);
            }
            
        } catch (e) {
            const isAbort = e.name === 'AbortError';
            const isWakeAbort = isAbort && this._wakeAbort;
            this._wakeAbort = false;
            
            console.error('[Adventure] Generation error:', e);
            wrapper.remove();
            
            if (!isAbort || isWakeAbort) {
                // Network drop or wake-recovery: server likely finished in background, reload.
                await this.resumeSession(this.currentSessionId);
            }
            // Plain abort (future stop button): don't reload
        } finally {
            this.isGenerating = false;
            this._abortController = null;
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
                    <div class="form-group">
                        <label>Max Input Tokens (Context Window)</label>
                        <input type="number" id="adv-global-max-input" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group">
                        <label>Max Output Tokens</label>
                        <input type="number" id="adv-global-max-output" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group">
                        <label>Repetition Penalty</label>
                        <input type="number" step="0.05" id="adv-global-rep-penalty" class="content-box" style="width: 100%;">
                    </div>
                    <div class="form-group" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem;">
                        <input type="checkbox" id="adv-global-enable-cot" style="width: 1.2rem; height: 1.2rem; cursor: pointer;" checked>
                        <label for="adv-global-enable-cot" style="margin: 0; cursor: pointer;">Enable Chain of Thought (5-Phase Logic)</label>
                    </div>
                    
                    <h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">Modular System Prompt</h3>
                    <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">These segments are combined to form the default system prompt when starting a new adventure.</p>
                    
                    <div id="adv-global-prompt-segments" style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; flex: 1; min-height: 250px; overflow-y: auto; padding-right: 0.5rem;">
                        <!-- Segments injected here -->
                    </div>
                    
                    <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
                        <textarea id="adv-global-new-segment" class="content-box" style="flex: 1; resize: vertical;" rows="3" placeholder="New prompt segment (Ctrl+Enter to add)..."></textarea>
                        <button id="adv-global-add-segment" class="btn-primary" style="height: fit-content; padding: 0.8rem 1.2rem;">Add</button>
                    </div>
                    
                    <div style="margin-top: 1.5rem; display: flex; justify-content: flex-end;">
                        <button id="adv-global-save-btn" class="btn-primary">Save Settings</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add a settings button to the Setup view title
        // Bind the settings button that's already in index.html
        const existingSettingsBtn = document.getElementById('adv-open-global-settings');
        if (existingSettingsBtn) {
            existingSettingsBtn.addEventListener('click', () => this.openGlobalSettings());
        }

        document.getElementById('adv-global-settings-close').addEventListener('click', () => {
            document.getElementById('adv-global-settings-modal').style.display = 'none';
        });
        document.getElementById('adv-global-save-btn').addEventListener('click', () => this.saveGlobalSettings());
        document.getElementById('adv-global-add-segment').addEventListener('click', () => this.addSystemPromptSegment());
        
        document.getElementById('adv-global-new-segment').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); this.addSystemPromptSegment(); }
        });
    }

    openGlobalSettings() {
        if (!window.config) return;
        this.systemPromptSegments = [...(window.config.get("adventure.systemPromptSegments") || [])];
        this.renderSystemPromptSegments();
        
        document.getElementById('adv-global-max-input').value = window.config.get("adventure.maxInputTokens") ?? 8192;
        document.getElementById('adv-global-max-output').value = window.config.get("adventure.maxOutputTokens") ?? 1024;
        document.getElementById('adv-global-rep-penalty').value = window.config.get("adventure.repetitionPenalty") ?? 1.0;
        
        const enableCotCheckbox = document.getElementById('adv-global-enable-cot');
        if (enableCotCheckbox) enableCotCheckbox.checked = window.config.get("adventure.enableCot") !== false;
        
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
        
        window.config.set("adventure.maxInputTokens", parseInt(document.getElementById('adv-global-max-input').value, 10) || 8192);
        window.config.set("adventure.maxOutputTokens", parseInt(document.getElementById('adv-global-max-output').value, 10) || 1024);
        window.config.set("adventure.repetitionPenalty", parseFloat(document.getElementById('adv-global-rep-penalty').value) || 1.0);
        
        const enableCotCheckbox = document.getElementById('adv-global-enable-cot');
        if (enableCotCheckbox) window.config.set("adventure.enableCot", enableCotCheckbox.checked);
        
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

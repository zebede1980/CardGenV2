class StoryWriterApp {
    constructor() {
        this.currentStoryId = null;
        this.story = null;
        this.allCards = [];
        this.generating = false;
        
        document.addEventListener('DOMContentLoaded', () => {
            this.bindEvents();
        });
    }

    bindEvents() {
        const tabCardGen = document.getElementById('tab-cardgen');
        const tabStoryWriter = document.getElementById('tab-storywriter');
        const viewCardGen = document.getElementById('view-cardgen');
        const viewStoryWriter = document.getElementById('view-storywriter');
        
        if (tabCardGen && tabStoryWriter) {
            tabCardGen.addEventListener('click', () => {
                viewCardGen.style.display = 'block';
                viewStoryWriter.style.display = 'none';
                tabCardGen.className = 'btn-primary';
                tabStoryWriter.className = 'btn-outline';
            });
            
            tabStoryWriter.addEventListener('click', () => {
                viewCardGen.style.display = 'none';
                viewStoryWriter.style.display = 'block';
                tabCardGen.className = 'btn-outline';
                tabStoryWriter.className = 'btn-primary';
                this.loadSettings();
                this.loadStories();
            });
        }

        document.getElementById('sw-create-btn')?.addEventListener('click', () => this.createStory());
        document.getElementById('sw-back-btn')?.addEventListener('click', () => {
            document.getElementById('sw-list-view').style.display = 'block';
            document.getElementById('sw-workspace-view').style.display = 'none';
            this.currentStoryId = null;
            this.loadStories();
        });
        
        const titleInput = document.getElementById('sw-title');
        if (titleInput) {
            titleInput.addEventListener('change', (e) => this.updateStory(e.target.value, this.story.synopsis));
        }

        const synopsisInput = document.getElementById('sw-synopsis');
        if (synopsisInput) {
            synopsisInput.addEventListener('change', (e) => this.updateStory(this.story.title, e.target.value));
        }

        const addCardSelect = document.getElementById('sw-add-card-select');
        if (addCardSelect) {
            addCardSelect.addEventListener('change', (e) => {
                if(e.target.value) {
                    this.attachCard(parseInt(e.target.value));
                    e.target.value = "";
                }
            });
        }

        document.getElementById('sw-generate-btn')?.addEventListener('click', () => this.generateNext());
        document.getElementById('sw-save-settings-btn')?.addEventListener('click', () => this.saveSettings());
    }

    async apiCall(path, method = 'GET', body = null) {
        const url = `/api/sw${path}`;
        const options = { method, headers: {} };
        if (body) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const res = await window.authFetch(url, options);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    }

    async loadSettings() {
        try {
            const s = await this.apiCall('/settings/');
            document.getElementById('sw-api-url').value = s.api_base_url || '';
            document.getElementById('sw-model').value = s.model || '';
            // Never pre-fill password field with the real key — show placeholder instead
            document.getElementById('sw-api-key').placeholder = s.api_key ? '(key saved — enter new to replace)' : 'sk-...';
            document.getElementById('sw-api-key').value = '';

            // If no API key is configured yet, auto-sync from CardGenV2 config and save silently
            if (!s.api_key) {
                const cfg = window.configManager?.config?.api?.text;
                if (cfg?.apiKey) {
                    console.log('[StoryWriter] Auto-syncing API credentials from CardGenV2 config');
                    const payload = {
                        api_base_url: cfg.baseUrl || s.api_base_url,
                        api_key: cfg.apiKey,
                        model: cfg.model || s.model,
                    };
                    await window.authFetch('/api/sw/settings/', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    document.getElementById('sw-api-url').value = payload.api_base_url || '';
                    document.getElementById('sw-model').value = payload.model || '';
                    document.getElementById('sw-api-key').placeholder = '(key saved — enter new to replace)';
                    document.getElementById('sw-settings-status').textContent = 'Auto-synced from CardGenV2 settings.';
                } else {
                    // Open the settings panel so user knows they need to configure
                    document.getElementById('sw-settings-details').open = true;
                    document.getElementById('sw-settings-status').textContent = 'Please enter your LLM API key to enable generation.';
                }
            }
        } catch (e) {
            console.error('[StoryWriter] Failed to load settings:', e);
        }
    }

    async saveSettings() {
        const btn = document.getElementById('sw-save-settings-btn');
        const status = document.getElementById('sw-settings-status');
        const apiUrl = document.getElementById('sw-api-url').value.trim();
        const model = document.getElementById('sw-model').value.trim();
        const apiKey = document.getElementById('sw-api-key').value.trim();

        if (!apiUrl || !model) {
            status.textContent = 'API Base URL and Model are required.';
            status.style.color = 'var(--error-color, #e55)';
            return;
        }

        const payload = { api_base_url: apiUrl, model };
        if (apiKey) payload.api_key = apiKey;  // only update key if a new one was typed

        btn.disabled = true;
        status.textContent = 'Saving…';
        status.style.color = 'var(--text-secondary)';
        try {
            await window.authFetch('/api/sw/settings/', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            status.textContent = 'Saved!';
            status.style.color = 'var(--success-color, #5c5)';
            document.getElementById('sw-api-key').value = '';
            document.getElementById('sw-api-key').placeholder = '(key saved — enter new to replace)';
        } catch (e) {
            status.textContent = 'Save failed: ' + e.message;
            status.style.color = 'var(--error-color, #e55)';
        } finally {
            btn.disabled = false;
        }
    }

    async loadStories() {
        try {
            const stories = await this.apiCall('/stories/');
            const list = document.getElementById('sw-story-list');
            list.innerHTML = '';
            
            if (stories.length === 0) {
                list.innerHTML = '<p style="color: var(--text-secondary);">No stories yet. Create one above!</p>';
                return;
            }

            stories.forEach(story => {
                const card = document.createElement('div');
                card.className = 'content-box';
                card.style.cursor = 'pointer';
                card.innerHTML = `
                    <h3 style="margin-top: 0; margin-bottom: 0.5rem;">${story.title}</h3>
                    <p style="font-size: 0.85rem; color: var(--text-secondary);">Updated: ${new Date(story.updated_at).toLocaleDateString()}</p>
                `;
                card.addEventListener('click', () => this.openStory(story.id));
                list.appendChild(card);
            });
        } catch (e) { console.error("Failed to load stories", e); }
    }

    async createStory() {
        const title = document.getElementById('sw-new-title').value.trim();
        if (!title) return alert("Enter a title");
        try {
            const story = await this.apiCall('/stories/', 'POST', { title, synopsis: "", card_ids: [] });
            document.getElementById('sw-new-title').value = '';
            this.openStory(story.id);
        } catch (e) { console.error(e); }
    }

    async openStory(id) {
        this.currentStoryId = id;
        document.getElementById('sw-list-view').style.display = 'none';
        document.getElementById('sw-workspace-view').style.display = 'flex';
        await this.refreshWorkspace();
    }

    async refreshWorkspace() {
        if (!this.currentStoryId) return;
        try {
            this.story = await this.apiCall(`/stories/${this.currentStoryId}`);
            this.allCards = await this.apiCall('/cards/').catch(() => []); 
            
            document.getElementById('sw-title').value = this.story.title;
            document.getElementById('sw-synopsis').value = this.story.synopsis;
            
            this.renderCards();
            this.renderSegments();
        } catch (e) { console.error(e); }
    }

    async updateStory(title, synopsis) {
        if (!this.story) return;
        try {
            await this.apiCall(`/stories/${this.story.id}`, 'PUT', { title, synopsis, card_ids: [] });
            this.story.title = title;
            this.story.synopsis = synopsis;
        } catch(e) { console.error(e); }
    }

    renderCards() {
        const container = document.getElementById('sw-attached-cards');
        const select = document.getElementById('sw-add-card-select');
        container.innerHTML = '';
        
        const attachedIds = new Set(this.story.cards.map(sc => sc.card_id));
        
        this.story.cards.forEach(sc => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.display = 'inline-flex';
            tag.style.alignItems = 'center';
            tag.style.gap = '5px';
            tag.innerHTML = `${sc.card.name} <button style="background:none; border:none; cursor:pointer; color:var(--error);" title="Detach">×</button>`;
            tag.querySelector('button').addEventListener('click', () => this.detachCard(sc.card_id));
            container.appendChild(tag);
        });

        const available = this.allCards.filter(c => !attachedIds.has(c.id));
        select.innerHTML = '<option value="">+ Add Character</option>';
        available.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
        select.disabled = available.length === 0;
    }

    async attachCard(cardId) {
        try { await this.apiCall(`/stories/${this.story.id}/cards/${cardId}`, 'POST'); await this.refreshWorkspace(); } catch(e) { console.error(e); }
    }

    async detachCard(cardId) {
        try { await this.apiCall(`/stories/${this.story.id}/cards/${cardId}`, 'DELETE'); await this.refreshWorkspace(); } catch(e) { console.error(e); }
    }

    renderSegments() {
        const area = document.getElementById('sw-story-area');
        area.innerHTML = '';
        
        this.story.segments.forEach(seg => {
            const div = document.createElement('div');
            div.style.padding = '1rem';
            div.style.marginBottom = '1rem';
            div.style.background = 'var(--bg-tertiary)';
            div.style.borderRadius = '0.5rem';
            div.style.borderLeft = seg.is_summary ? '3px solid #f9a825' : '3px solid var(--accent)';
            
            const content = document.createElement('div');
            content.style.lineHeight = '1.7';
            content.style.whiteSpace = 'pre-wrap';
            content.textContent = seg.content;

            // Inline editor (hidden by default)
            const editor = document.createElement('textarea');
            editor.className = 'textarea';
            editor.style.display = 'none';
            editor.style.width = '100%';
            editor.style.minHeight = '8rem';
            editor.style.marginTop = '0.5rem';
            editor.style.background = 'var(--surface-color)';
            editor.value = seg.content;
            
            const actions = document.createElement('div');
            actions.style.marginTop = '0.75rem';
            actions.style.display = 'flex';
            actions.style.gap = '0.5rem';
            actions.style.justifyContent = 'flex-end';

            const editBtn = document.createElement('button');
            editBtn.className = 'btn-small';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => {
                const editing = editor.style.display !== 'none';
                if (editing) {
                    // Cancel — revert
                    editor.value = seg.content;
                    editor.style.display = 'none';
                    content.style.display = '';
                    editBtn.textContent = 'Edit';
                    saveBtn.style.display = 'none';
                } else {
                    editor.style.display = 'block';
                    content.style.display = 'none';
                    editBtn.textContent = 'Cancel';
                    saveBtn.style.display = '';
                    editor.focus();
                }
            });

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn-small btn-primary';
            saveBtn.textContent = 'Save';
            saveBtn.style.display = 'none';
            saveBtn.addEventListener('click', async () => {
                const newText = editor.value;
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving…';
                try {
                    await this.apiCall(`/stories/${this.story.id}/segments/${seg.id}`, 'PUT', { content: newText });
                    seg.content = newText;
                    content.textContent = newText;
                    editor.style.display = 'none';
                    content.style.display = '';
                    editBtn.textContent = 'Edit';
                    saveBtn.style.display = 'none';
                } catch(e) {
                    alert('Failed to save: ' + e.message);
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                }
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-small';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', async () => {
                if(confirm('Delete segment?')) {
                    await this.apiCall(`/stories/${this.story.id}/segments/${seg.id}`, 'DELETE');
                    await this.refreshWorkspace();
                }
            });
            
            actions.appendChild(editBtn);
            actions.appendChild(saveBtn);
            actions.appendChild(delBtn);
            div.appendChild(content);
            div.appendChild(editor);
            div.appendChild(actions);
            area.appendChild(div);
        });
        area.scrollTop = area.scrollHeight;
    }

    async generateNext() {
        if(this.generating || !this.story) return;
        const steering = document.getElementById('sw-steering').value.trim();
        const btn = document.getElementById('sw-generate-btn');
        const area = document.getElementById('sw-story-area');
        
        this.generating = true;
        btn.textContent = 'Generating...';
        btn.disabled = true;

        const streamDiv = document.createElement('div');
        streamDiv.style.padding = '1rem';
        streamDiv.style.marginBottom = '1rem';
        streamDiv.style.background = 'var(--bg-tertiary)';
        streamDiv.style.borderRadius = '0.5rem';
        streamDiv.style.border = '1px dashed var(--accent)';
        streamDiv.style.whiteSpace = 'pre-wrap';
        streamDiv.style.lineHeight = '1.7';
        area.appendChild(streamDiv);
        area.scrollTop = area.scrollHeight;

        try {
            const res = await window.authFetch('/api/sw/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ story_id: this.story.id, steering: steering || null })
            });

            if (!res.ok) {
                const errText = await res.text();
                let errMsg = `Generation failed (${res.status})`;
                try { const j = JSON.parse(errText); errMsg = j.detail || j.error || errMsg; } catch(e) {}
                streamDiv.remove();
                if (errMsg.toLowerCase().includes('api key')) {
                    document.getElementById('sw-settings-details').open = true;
                    alert('\u26a0\ufe0f ' + errMsg + '\n\nPlease configure your API key in the \u2699\ufe0f Generation Settings panel above.');
                } else {
                    alert('Generation failed: ' + errMsg);
                }
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'chunk') {
                                streamDiv.textContent += data.content;
                                area.scrollTop = area.scrollHeight;
                            } else if (data.type === 'error') {
                                alert(data.message);
                            }
                        } catch(e) {}
                    }
                }
            }
            
            document.getElementById('sw-steering').value = '';
            await this.refreshWorkspace();
        } catch (e) {
            console.error(e);
            alert("Generation failed");
            streamDiv.remove();
        } finally {
            this.generating = false;
            btn.textContent = 'Generate Next';
            btn.disabled = false;
        }
    }
}
window.storyWriterApp = new StoryWriterApp();
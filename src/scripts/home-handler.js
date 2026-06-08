/**
 * HomeHandler
 * Provides a front landing page for the application with global navigation and a character gallery.
 */
class HomeHandler {
    constructor() {
        this.cards = [];
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.injectHTML();
        this.bindEvents();
        
        // Wait briefly for library/storage to be initialized, then load the gallery
        const checkStorage = setInterval(() => {
            if (window.characterStorage) {
                clearInterval(checkStorage);
                this.loadCards();
            }
        }, 100);
    }

    injectHTML() {
        const viewCardGen = document.getElementById('view-cardgen');
        if (!viewCardGen || document.getElementById('view-home')) return;

        // 1. Create and inject the Home View
        const viewHome = document.createElement('div');
        viewHome.id = 'view-home';
        viewHome.style.display = 'block'; // Set as the default active view
        
        // Hide the other views
        viewCardGen.style.display = 'none';
        const viewStoryWriter = document.getElementById('view-storywriter');
        if (viewStoryWriter) viewStoryWriter.style.display = 'none';
        const viewChat = document.getElementById('view-roleplaychat');
        if (viewChat) viewChat.style.display = 'none';

        // Reset existing top tabs
        const tabCardGen = document.getElementById('tab-cardgen');
        if (tabCardGen) tabCardGen.className = 'btn-outline';

        viewHome.innerHTML = `
            <div style="max-width: 1400px; margin: 0 auto; padding: 2rem;">
                <h1 style="text-align: center; margin-bottom: 2rem; font-size: 2.5rem; color: var(--text-primary);">SillyTavern Character Generator</h1>
                <div style="display: flex; justify-content: center; gap: 1.5rem; margin-bottom: 3rem; flex-wrap: wrap;">
                    <button id="home-btn-cardgen" class="btn-primary" style="padding: 1.2rem 2.5rem; font-size: 1.2rem; border-radius: 0.8rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">✨ Character Generator</button>
                    <button id="home-btn-story" class="btn-primary" style="padding: 1.2rem 2.5rem; font-size: 1.2rem; border-radius: 0.8rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">📖 Story Mode</button>
                    <button id="home-btn-chat" class="btn-primary" style="padding: 1.2rem 2.5rem; font-size: 1.2rem; border-radius: 0.8rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">💬 Roleplay Chat</button>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
                    <h2 style="margin: 0; font-size: 1.8rem; color: var(--text-primary);">Your Characters</h2>
                    <input type="text" id="home-search" class="content-box" placeholder="Search characters..." style="max-width: 300px; padding: 0.6rem 1rem;">
                </div>
                
                <div id="home-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem;">
                    <div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 3rem;">Loading library...</div>
                </div>
            </div>
        `;

        viewCardGen.parentNode.insertBefore(viewHome, viewCardGen);
        
        // 2. Add a "Home" button to the main navbar
        const navTabs = tabCardGen?.parentNode;
        if (navTabs) {
            navTabs.classList.add('app-nav-tabs');
            const tabHome = document.createElement('button');
            tabHome.id = 'tab-home';
            tabHome.className = 'btn-primary';
            tabHome.innerHTML = '🏠 Home';
            navTabs.insertBefore(tabHome, tabCardGen);
            
            // Inject mobile fix for nav tabs to ensure they wrap properly
            if (!document.getElementById('nav-tabs-mobile-fix')) {
                const style = document.createElement('style');
                style.id = 'nav-tabs-mobile-fix';
                style.textContent = `
                    .app-nav-tabs {
                        display: flex !important;
                        flex-wrap: wrap !important;
                        gap: 0.5rem;
                        justify-content: center;
                    }
                    @media (max-width: 768px) {
                        #tab-home, #tab-cardgen, #tab-storywriter, #tab-roleplaychat {
                            flex: 1 1 40% !important; /* Creates a 2x2 grid */
                            padding: 0.6rem 0.5rem !important;
                            font-size: 0.85rem !important;
                            margin: 0 !important;
                            text-align: center;
                        }
                    }
                `;
                document.head.appendChild(style);
            }
        }
    }

    bindEvents() {
        const tabHome = document.getElementById('tab-home');
        const tabCardGen = document.getElementById('tab-cardgen');
        const tabStoryWriter = document.getElementById('tab-storywriter');
        const tabChat = document.getElementById('tab-roleplaychat');
        
        const viewHome = document.getElementById('view-home');
        const viewCardGen = document.getElementById('view-cardgen');
        const viewStoryWriter = document.getElementById('view-storywriter');
        const viewChat = document.getElementById('view-roleplaychat');

        const switchView = (targetView, targetTab) => {
            if (viewHome) viewHome.style.display = targetView === viewHome ? 'block' : 'none';
            if (viewCardGen) viewCardGen.style.display = targetView === viewCardGen ? 'block' : 'none';
            if (viewStoryWriter) viewStoryWriter.style.display = targetView === viewStoryWriter ? 'block' : 'none';
            if (viewChat) viewChat.style.display = targetView === viewChat ? 'block' : 'none';
            
            if (tabHome) tabHome.className = targetTab === tabHome ? 'btn-primary' : 'btn-outline';
            if (tabCardGen) tabCardGen.className = targetTab === tabCardGen ? 'btn-primary' : 'btn-outline';
            if (tabStoryWriter) tabStoryWriter.className = targetTab === tabStoryWriter ? 'btn-primary' : 'btn-outline';
            if (tabChat) tabChat.className = targetTab === tabChat ? 'btn-primary' : 'btn-outline';
        };

        if (tabHome) tabHome.addEventListener('click', () => { switchView(viewHome, tabHome); this.loadCards(); });
        if (tabCardGen) tabCardGen.addEventListener('click', () => switchView(viewCardGen, tabCardGen));
        if (tabStoryWriter) tabStoryWriter.addEventListener('click', () => switchView(viewStoryWriter, tabStoryWriter));
        if (tabChat) tabChat.addEventListener('click', () => switchView(viewChat, tabChat));

        // Home Hero Buttons
        document.getElementById('home-btn-cardgen')?.addEventListener('click', () => { if (tabCardGen) tabCardGen.click(); });
        document.getElementById('home-btn-story')?.addEventListener('click', () => { if (tabStoryWriter) tabStoryWriter.click(); });
        document.getElementById('home-btn-chat')?.addEventListener('click', () => { if (tabChat) tabChat.click(); });

        document.getElementById('home-search')?.addEventListener('input', (e) => this.filterCards(e.target.value));
    }

    async loadCards() {
        if (!window.characterStorage) return;
        try {
            const allCards = await window.characterStorage.listCards();
            this.cards = allCards.filter(c => c.isPermanent);
            this.renderGrid(this.cards);
        } catch (e) {
            console.error("Home: Failed to load cards", e);
            const grid = document.getElementById('home-grid');
            if (grid) grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--error);">Failed to load library</div>`;
        }
    }

    filterCards(searchTerm) {
        if (!this.cards) return;
        if (!searchTerm || !searchTerm.trim()) {
            this.renderGrid(this.cards);
            return;
        }
        
        const term = searchTerm.toLowerCase().trim();
        const filtered = this.cards.filter(card => {
            const charObj = card.character || card;
            const name = (card.characterName || charObj.name || '').toLowerCase();
            const desc = (charObj.description || '').toLowerCase();
            const pers = (charObj.personality || '').toLowerCase();
            return name.includes(term) || desc.includes(term) || pers.includes(term);
        });
        
        this.renderGrid(filtered);
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    renderGrid(cards) {
        const grid = document.getElementById('home-grid');
        if (!grid) return;
        grid.innerHTML = '';
        
        const authToken = window.cardgenAuth?.getToken() || "";
        
        if (!cards || cards.length === 0) {
            grid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary);">No characters found.</p>';
            return;
        }
        
        const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='%232d2d3d'/><text x='50' y='50' font-family='Arial' font-size='14' fill='%23888' text-anchor='middle' dominant-baseline='middle'>No Image</text></svg>`;
        
        cards.forEach(card => {
            const tile = document.createElement('div');
            tile.className = 'content-box';
            tile.style.display = 'flex';
            tile.style.flexDirection = 'column';
            tile.style.alignItems = 'center';
            tile.style.padding = '1rem';
            tile.style.gap = '0.75rem';
            tile.style.borderRadius = '0.8rem';
            tile.style.background = 'var(--surface-color)';
            tile.style.border = '1px solid var(--border)';
            tile.style.transition = 'transform 0.2s, border-color 0.2s, box-shadow 0.2s';
            tile.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
            
            tile.onmouseenter = () => { tile.style.transform = 'translateY(-2px)'; tile.style.borderColor = 'var(--accent)'; tile.style.boxShadow = '0 6px 12px rgba(0,0,0,0.15)'; };
            tile.onmouseleave = () => { tile.style.transform = 'translateY(0)'; tile.style.borderColor = 'var(--border)'; tile.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)'; };
            
            const cardName = card.characterName || (card.character && card.character.name) || card.name || 'Unknown Character';

            let imgSrc = fallbackSvg;
            if (card.avatar && card.avatar.startsWith('data:')) imgSrc = card.avatar;
            else if (card.imageUrl) imgSrc = card.imageUrl;
            else if (card.image) imgSrc = card.image;
            else if (card.id) {
                const tStamp = new Date(card.updatedAt || card.createdAt || 0).getTime();
                imgSrc = `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(card.id)}${authToken ? '&token=' + encodeURIComponent(authToken) : ''}&_t=${tStamp}`;
            }

            tile.innerHTML = `
                <div style="width: 100%; aspect-ratio: 1/1; border-radius: 0.5rem; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center;">
                    <img src="${imgSrc}" alt="${this.escapeHtml(cardName)}" onerror="this.src='${fallbackSvg.replace(/'/g, "\\'")}'" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
                <h3 style="margin: 0; font-size: 1.2rem; text-align: center; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.escapeHtml(cardName)}">${this.escapeHtml(cardName)}</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; width: 100%; margin-top: auto;">
                    <button class="btn-small btn-outline info-btn" style="border-radius: 0.4rem; padding: 0.5rem;">ℹ️ Info</button>
                    <button class="btn-small btn-outline edit-btn" style="border-radius: 0.4rem; padding: 0.5rem;">✏️ Edit</button>
                    <button class="btn-small btn-primary story-btn" style="border-radius: 0.4rem; padding: 0.5rem;">📖 Story</button>
                    <button class="btn-small btn-primary chat-btn" style="border-radius: 0.4rem; padding: 0.5rem;">💬 Chat</button>
                </div>
            `;

            // Info Button: Uses existing gallery mode info modal
            tile.querySelector('.info-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.cardGallery) window.cardGallery.showInfo(card);
            });

            // Edit Button: Swaps to CardGen tab and directly invokes the load logic
            tile.querySelector('.edit-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                const tabCardGen = document.getElementById('tab-cardgen');
                if (tabCardGen) tabCardGen.click();
                
                if (window.app) {
                    const targetEl = document.createElement('div');
                    targetEl.dataset.action = 'load-card';
                    targetEl.dataset.id = String(card.id);
                    await window.app.handleLibraryCardClick({ target: targetEl });
                }
            });

            // Story Button: Swaps to Story tab, auto-creates a story if needed, and attaches character
            tile.querySelector('.story-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const tabStory = document.getElementById('tab-storywriter');
                if (tabStory) tabStory.click();
                
                setTimeout(() => {
                    const listView = document.getElementById('sw-list-view');
                    // If on the list view, auto-create a new story
                    if (listView && listView.style.display !== 'none') {
                        const titleInput = document.getElementById('sw-new-title');
                        const createBtn = document.getElementById('sw-create-btn');
                        if (titleInput && createBtn) {
                            titleInput.value = `Tale of ${cardName}`;
                            createBtn.click();
                        }
                    }
                    // Attach the character by triggering the selector
                    setTimeout(() => {
                        const swSelect = document.getElementById('sw-add-card-select');
                        if (swSelect) {
                            swSelect.value = card.id;
                            swSelect.dispatchEvent(new Event('change'));
                        }
                    }, 300);
                }, 100);
            });
            
            // Chat Button: Swaps to Chat tab and fetches history to resume or start a new chat
            tile.querySelector('.chat-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                
                const tabChat = document.getElementById('tab-roleplaychat');
                if (tabChat) tabChat.click();
                
                if (!window.roleplayChatHandler) return;
                
                try {
                    const res = await window.authFetch('/api/sw/chats/');
                    if (res.ok) {
                        const allChats = await res.json();
                        allChats.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
                        
                        let foundChatId = null;
                        
                        for (const c of allChats) {
                            if (c.characters) {
                                if (c.characters.some(ch => String(ch.id) === String(card.id))) {
                                    foundChatId = c.id;
                                    break;
                                }
                            } else {
                                const detailRes = await window.authFetch(`/api/sw/chats/${c.id}`);
                                if (detailRes.ok) {
                                    const detail = await detailRes.json();
                                    if (detail.characters && detail.characters.some(ch => String(ch.id) === String(card.id))) {
                                        foundChatId = c.id;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        if (foundChatId) {
                            // Resume latest chat containing this character
                            await window.roleplayChatHandler.selectChat(foundChatId);
                        } else {
                            // No history found, start a new chat with character pre-populated
                            await window.roleplayChatHandler.openNewChatModal(card.id);
                        }
                    }
                } catch (err) {
                    console.error("Failed to check existing chats:", err);
                    await window.roleplayChatHandler.openNewChatModal(card.id);
                }
            });
            
            grid.appendChild(tile);
        });
    }
}

window.homeHandler = new HomeHandler();
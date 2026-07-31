/**
 * HomeHandler
 * Provides a front landing page for the application with global navigation and a character gallery.
 */
class HomeHandler {
    constructor() {
        this.cards = [];
        this.filteredCards = [];
        this.currentPage = 1;
        this.itemsPerPage = 20;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.injectHTML();
        this.bindEvents();
        
        // Wait briefly for library/storage to be initialized and app authenticated, then load the gallery
        const checkStorage = setInterval(() => {
            if (window.characterStorage && window.app) {
                clearInterval(checkStorage);
                this.loadCards();
                this.loadRecentChats();
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
        const viewAdventure = document.getElementById('view-adventure');
        if (viewAdventure) viewAdventure.style.display = 'none';

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
                    <button id="home-btn-adventure" class="btn-primary" style="padding: 1.2rem 2.5rem; font-size: 1.2rem; border-radius: 0.8rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">🎲 Adventure</button>
                </div>

                <!-- Recent Roleplay Chats Section -->
                <div id="home-recent-chats-section" style="margin-bottom: 3rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem;">
                        <h2 style="margin: 0; font-size: 1.8rem; color: var(--text-primary); display: flex; align-items: center; gap: 0.6rem;">
                            💬 Recent Roleplay Chats
                        </h2>
                        <button id="home-view-all-chats-btn" class="btn-outline" style="font-size: 0.9rem; padding: 0.4rem 0.9rem; border-radius: 0.5rem;">View All Chats ➔</button>
                    </div>
                    <div id="home-recent-chats-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 1.5rem;">
                        <div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 2rem;">Loading recent chats...</div>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;">
                    <h2 id="home-characters-heading" style="margin: 0; font-size: 1.8rem; color: var(--text-primary); scroll-margin-top: 120px;">Your Characters</h2>
                    <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                        <div id="home-pagination-top" style="display: none; align-items: center; gap: 0.5rem;">
                            <button id="home-prev-btn-top" class="btn-outline" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;">Prev</button>
                            <span id="home-page-indicator-top" style="color: var(--text-primary); font-weight: 500; font-size: 0.85rem;"></span>
                            <button id="home-next-btn-top" class="btn-outline" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;">Next</button>
                        </div>
                        <input type="text" id="home-search" class="content-box" placeholder="Search characters..." style="max-width: 250px; padding: 0.6rem 1rem;">
                    </div>
                </div>
                
                <div id="home-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 1.5rem;">
                    <div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 3rem;">Loading library...</div>
                </div>

                <div id="home-pagination" style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 2rem; display: none;">
                    <button id="home-prev-btn" class="btn-outline" style="padding: 0.5rem 1rem;">Previous</button>
                    <span id="home-page-indicator" style="color: var(--text-primary); font-weight: 500;">Page 1</span>
                    <button id="home-next-btn" class="btn-outline" style="padding: 0.5rem 1rem;">Next</button>
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
                        #tab-home, #tab-cardgen, #tab-storywriter, #tab-roleplaychat, #tab-adventure {
                            flex: 1 1 30% !important; /* Creates a responsive grid */
                            padding: 0.6rem 0.5rem !important;
                            font-size: 0.85rem !important;
                            margin: 0 !important;
                            text-align: center;
                        }
                        #view-home {
                            max-width: 100vw;
                            overflow-x: hidden;
                        }
                        #view-home > div {
                            padding: 1rem !important;
                        }
                        #view-home h1 {
                            font-size: 1.8rem !important;
                        }
                        #view-home button[id^="home-btn-"] {
                            padding: 0.8rem 1rem !important;
                            font-size: 1rem !important;
                            width: 100%;
                            max-width: 100%;
                        }
                        #view-home #home-grid {
                            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)) !important;
                            gap: 1rem !important;
                        }
                        #view-home #home-grid h3 {
                            font-size: 1rem !important;
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
        const tabAdventure = document.getElementById('tab-adventure');
        
        const viewHome = document.getElementById('view-home');
        const viewCardGen = document.getElementById('view-cardgen');
        const viewStoryWriter = document.getElementById('view-storywriter');
        const viewChat = document.getElementById('view-roleplaychat');
        const viewAdventure = document.getElementById('view-adventure');

        const switchView = (targetView, targetTab) => {
            if (viewHome) viewHome.style.display = targetView === viewHome ? 'block' : 'none';
            if (viewCardGen) viewCardGen.style.display = targetView === viewCardGen ? 'block' : 'none';
            if (viewStoryWriter) viewStoryWriter.style.display = targetView === viewStoryWriter ? 'block' : 'none';
            if (viewChat) viewChat.style.display = targetView === viewChat ? 'block' : 'none';
            if (viewAdventure) viewAdventure.style.display = targetView === viewAdventure ? 'block' : 'none';
            
            if (tabHome) tabHome.className = targetTab === tabHome ? 'btn-primary' : 'btn-outline';
            if (tabCardGen) tabCardGen.className = targetTab === tabCardGen ? 'btn-primary' : 'btn-outline';
            if (tabStoryWriter) tabStoryWriter.className = targetTab === tabStoryWriter ? 'btn-primary' : 'btn-outline';
            if (tabChat) tabChat.className = targetTab === tabChat ? 'btn-primary' : 'btn-outline';
            if (tabAdventure) tabAdventure.className = targetTab === tabAdventure ? 'btn-primary' : 'btn-outline';
        };

        if (tabHome) tabHome.addEventListener('click', () => {
            switchView(viewHome, tabHome);
            this.loadCards();
            this.loadRecentChats();
        });
        if (tabCardGen) tabCardGen.addEventListener('click', () => switchView(viewCardGen, tabCardGen));
        if (tabStoryWriter) tabStoryWriter.addEventListener('click', () => switchView(viewStoryWriter, tabStoryWriter));
        if (tabChat) tabChat.addEventListener('click', () => switchView(viewChat, tabChat));
        if (tabAdventure) tabAdventure.addEventListener('click', () => {
            switchView(viewAdventure, tabAdventure);
            if(window.adventureHandler) window.adventureHandler.showView();
        });

        // Home Hero Buttons
        document.getElementById('home-btn-cardgen')?.addEventListener('click', () => { if (tabCardGen) tabCardGen.click(); });
        document.getElementById('home-btn-story')?.addEventListener('click', () => { if (tabStoryWriter) tabStoryWriter.click(); });
        document.getElementById('home-btn-chat')?.addEventListener('click', () => { if (tabChat) tabChat.click(); });
        document.getElementById('home-btn-adventure')?.addEventListener('click', () => { if (tabAdventure) tabAdventure.click(); });

        document.getElementById('home-view-all-chats-btn')?.addEventListener('click', () => { if (tabChat) tabChat.click(); });

        document.getElementById('home-search')?.addEventListener('input', (e) => this.filterCards(e.target.value));

        const handlePrev = () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.updateView();
                document.getElementById('home-characters-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        };

        const handleNext = () => {
            const totalPages = Math.ceil(this.filteredCards.length / this.itemsPerPage);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.updateView();
                document.getElementById('home-characters-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        };

        document.getElementById('home-prev-btn')?.addEventListener('click', handlePrev);
        document.getElementById('home-next-btn')?.addEventListener('click', handleNext);
        document.getElementById('home-prev-btn-top')?.addEventListener('click', handlePrev);
        document.getElementById('home-next-btn-top')?.addEventListener('click', handleNext);
    }

    async loadCards({ preservePage = false } = {}) {
        if (!window.characterStorage) return;
        try {
            const pageToRestore = preservePage ? this.currentPage : 1;
            const allCards = await window.characterStorage.listCards();
            this.cards = allCards.filter(c => c.isPermanent);
            this.filteredCards = [...this.cards];
            this.currentPage = pageToRestore; // updateView() will clamp if out of range
            this.updateView();
        } catch (e) {
            console.error("Home: Failed to load cards", e);
            const grid = document.getElementById('home-grid');
            if (grid) grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--error);">Failed to load library</div>`;
        }
    }

    filterCards(searchTerm) {
        if (!this.cards) return;
        if (!searchTerm || !searchTerm.trim()) {
            this.filteredCards = [...this.cards];
            this.currentPage = 1;
            this.updateView();
            return;
        }
        
        const term = searchTerm.toLowerCase().trim();
        this.filteredCards = this.cards.filter(card => {
            const charObj = card.character || card;
            const name = (card.characterName || charObj.name || '').toLowerCase();
            const desc = (charObj.description || '').toLowerCase();
            const pers = (charObj.personality || '').toLowerCase();
            let tags = '';
            if (Array.isArray(card.tags)) {
                tags = card.tags.join(' ').toLowerCase();
            } else if (Array.isArray(charObj.tags)) {
                tags = charObj.tags.join(' ').toLowerCase();
            }
            return name.includes(term) || desc.includes(term) || pers.includes(term) || tags.includes(term);
        });
        
        this.currentPage = 1;
        this.updateView();
    }

    updateView() {
        const totalItems = this.filteredCards.length;
        const totalPages = Math.ceil(totalItems / this.itemsPerPage) || 1;
        
        // Ensure currentPage is within valid bounds
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        if (this.currentPage < 1) this.currentPage = 1;

        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        const pageCards = this.filteredCards.slice(startIndex, endIndex);
        
        this.renderGrid(pageCards);

        const paginationDiv = document.getElementById('home-pagination');
        const paginationDivTop = document.getElementById('home-pagination-top');
        
        if (paginationDiv) {
            if (totalItems > this.itemsPerPage) {
                paginationDiv.style.display = 'flex';
                document.getElementById('home-page-indicator').textContent = `Page ${this.currentPage} of ${totalPages}`;
                document.getElementById('home-prev-btn').disabled = this.currentPage === 1;
                document.getElementById('home-next-btn').disabled = this.currentPage === totalPages;
                
                if (paginationDivTop) {
                    paginationDivTop.style.display = 'flex';
                    document.getElementById('home-page-indicator-top').textContent = `Page ${this.currentPage} of ${totalPages}`;
                    document.getElementById('home-prev-btn-top').disabled = this.currentPage === 1;
                    document.getElementById('home-next-btn-top').disabled = this.currentPage === totalPages;
                }
            } else {
                paginationDiv.style.display = 'none';
                if (paginationDivTop) paginationDivTop.style.display = 'none';
            }
        }
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
                <div style="position: relative; width: 100%; aspect-ratio: 1/1; border-radius: 0.5rem; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center;">
                    <img src="${imgSrc}" alt="${this.escapeHtml(cardName)}" onerror="this.src='${fallbackSvg.replace(/'/g, "\\'")}'" style="width: 100%; height: 100%; object-fit: cover;">
                    <button class="delete-card-btn" style="position: absolute; top: 0.5rem; right: 0.5rem; background: rgba(0,0,0,0.6); color: white; border: none; border-radius: 50%; width: 2.2rem; height: 2.2rem; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; transition: background 0.2s;" onmouseover="this.style.background='rgba(220,50,50,0.9)'" onmouseout="this.style.background='rgba(0,0,0,0.6)'" title="Delete Character">🗑️</button>
                </div>
                <h3 style="margin: 0; font-size: 1.2rem; text-align: center; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.escapeHtml(cardName)}">${this.escapeHtml(cardName)}</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; width: 100%; margin-top: auto;">
                    <button class="btn-small btn-outline info-btn" style="border-radius: 0.4rem; padding: 0.5rem;">ℹ️ Info</button>
                    <button class="btn-small btn-outline edit-btn" style="border-radius: 0.4rem; padding: 0.5rem;">✏️ Edit</button>
                    <button class="btn-small btn-primary story-btn" style="border-radius: 0.4rem; padding: 0.5rem;">📖 Story</button>
                    <button class="btn-small btn-primary chat-btn" style="border-radius: 0.4rem; padding: 0.5rem;">💬 Chat</button>
                </div>
            `;

            tile.querySelector('.delete-card-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showDeleteConfirmation('card', card, imgSrc);
            });

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

    async loadRecentChats() {
        const grid = document.getElementById('home-recent-chats-grid');
        if (!grid) return;
        try {
            const res = await window.authFetch('/api/sw/chats/');
            if (!res.ok) {
                grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 1.5rem;">Could not load recent chats</div>';
                return;
            }
            const chats = await res.json();
            if (!chats || chats.length === 0) {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; background: var(--surface-color); border: 1px dashed var(--border); padding: 2.5rem 1.5rem; border-radius: 0.8rem; color: var(--text-secondary);">
                        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">💬</div>
                        <div style="font-size: 1.1rem; color: var(--text-primary); font-weight: 500; margin-bottom: 0.25rem;">No Roleplay Chats Yet</div>
                        <div style="font-size: 0.9rem;">Pick a character card below and click <b>Chat</b> to start a roleplay session!</div>
                    </div>
                `;
                return;
            }

            // Get up to 4 most recent chat sessions
            const recentChats = chats.slice(0, 4);

            // Fetch character details for any chats missing character info
            for (const chat of recentChats) {
                if (!chat.characters || chat.characters.length === 0) {
                    try {
                        const detailRes = await window.authFetch(`/api/sw/chats/${chat.id}`);
                        if (detailRes.ok) {
                            const detail = await detailRes.json();
                            chat.characters = detail.characters || [];
                        }
                    } catch (e) {
                        chat.characters = [];
                    }
                }
            }

            this.renderRecentChats(recentChats);
        } catch (e) {
            console.error("Home: Failed to load recent chats", e);
            grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--error); padding: 1.5rem;">Failed to load recent chats</div>';
        }
    }

    renderRecentChats(chats) {
        const grid = document.getElementById('home-recent-chats-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const authToken = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || "";
        const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='%232d2d3d'/><text x='50' y='50' font-family='Arial' font-size='24' fill='%23888' text-anchor='middle' dominant-baseline='middle'>💬</text></svg>`;

        chats.forEach(chat => {
            const tile = document.createElement('div');
            tile.className = 'content-box';
            tile.style.cssText = `
                display: flex;
                flex-direction: column;
                padding: 1rem;
                gap: 0.75rem;
                border-radius: 0.8rem;
                background: var(--surface-color);
                border: 1px solid var(--border);
                transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                cursor: pointer;
                position: relative;
            `;

            tile.onmouseenter = () => {
                tile.style.transform = 'translateY(-2px)';
                tile.style.borderColor = 'var(--accent)';
                tile.style.boxShadow = '0 6px 12px rgba(0,0,0,0.15)';
            };
            tile.onmouseleave = () => {
                tile.style.transform = 'translateY(0)';
                tile.style.borderColor = 'var(--border)';
                tile.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
            };

            const characters = chat.characters || [];
            const charNames = characters.map(c => c.name).join(', ') || 'Roleplay Chat';

            // Avatar Container
            let avatarHtml = '';
            let modalImgSrc = fallbackSvg;
            if (characters.length === 0) {
                avatarHtml = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:2.5rem; color:var(--text-secondary);">💬</div>`;
            } else if (characters.length === 1) {
                const char = characters[0];
                const imgSrc = char.id ? `/api/storage/cards/thumbnail?cardId=${char.id}${authToken ? '&token=' + encodeURIComponent(authToken) : ''}` : fallbackSvg;
                modalImgSrc = imgSrc;
                avatarHtml = `<img src="${imgSrc}" alt="${this.escapeHtml(char.name)}" onerror="this.src='${fallbackSvg.replace(/'/g, "\\'")}'" style="width:100%; height:100%; object-fit:cover; object-position:top;">`;
            } else {
                const widthPct = 100 / characters.length;
                let slotsHtml = '';
                modalImgSrc = [];
                characters.forEach((char, i) => {
                    const imgSrc = char.id ? `/api/storage/cards/thumbnail?cardId=${char.id}${authToken ? '&token=' + encodeURIComponent(authToken) : ''}` : fallbackSvg;
                    modalImgSrc.push(imgSrc);
                    slotsHtml += `
                        <div style="position:absolute; top:0; left:${widthPct * i}%; width:${widthPct}%; height:100%; overflow:hidden; border-right:${i < characters.length - 1 ? '1px solid var(--border)' : 'none'};">
                            <img src="${imgSrc}" alt="${this.escapeHtml(char.name)}" onerror="this.src='${fallbackSvg.replace(/'/g, "\\'")}'" style="width:100%; height:100%; object-fit:cover; object-position:top;">
                        </div>
                    `;
                });
                avatarHtml = `<div style="position:relative; width:100%; height:100%;">${slotsHtml}</div>`;
            }

            // Formatted Date
            const d = new Date(chat.updated_at);
            const dateStr = isNaN(d) ? '' : this.formatRelativeDate(d);

            tile.innerHTML = `
                <div style="position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 0.5rem; overflow: hidden; background: var(--bg-tertiary);">
                    ${avatarHtml}
                    <button class="delete-chat-btn" style="position: absolute; top: 0.5rem; right: 0.5rem; background: rgba(0,0,0,0.6); color: white; border: none; border-radius: 50%; width: 2.2rem; height: 2.2rem; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; transition: background 0.2s; z-index: 10;" onmouseover="this.style.background='rgba(220,50,50,0.9)'" onmouseout="this.style.background='rgba(0,0,0,0.6)'" title="Delete Chat">🗑️</button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.25rem; flex: 1;">
                    <h3 style="margin: 0; font-size: 1.15rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.escapeHtml(chat.title)}">
                        ${this.escapeHtml(chat.title)}
                    </h3>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        👤 ${this.escapeHtml(charNames)}
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 0.5rem; border-top: 1px solid var(--border);">
                    <span style="font-size: 0.75rem; color: var(--text-secondary);">⏱️ ${dateStr}</span>
                    <button class="btn-small btn-primary" style="padding: 0.35rem 0.75rem; font-size: 0.85rem; border-radius: 0.4rem;">Continue ➔</button>
                </div>
            `;

            tile.querySelector('.delete-chat-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showDeleteConfirmation('chat', chat, modalImgSrc);
            });

            // Click handler: opens chat view and selects active chat session
            tile.addEventListener('click', async (e) => {
                e.stopPropagation();
                const tabChat = document.getElementById('tab-roleplaychat');
                if (tabChat) tabChat.click();
                if (window.roleplayChatHandler) {
                    await window.roleplayChatHandler.selectChat(chat.id);
                }
            });

            grid.appendChild(tile);
        });
    }

    formatRelativeDate(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    showDeleteConfirmation(type, item, imgSrc) {
        // Create modal container
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.8); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(4px);
        `;

        const title = type === 'card' 
            ? (item.characterName || (item.character && item.character.name) || item.name || 'Unknown Character')
            : (item.title || 'Roleplay Chat');

        const details = type === 'card'
            ? `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 1rem; max-height: 100px; overflow-y: auto;">
                ${this.escapeHtml((item.character?.description || '').substring(0, 150))}${item.character?.description?.length > 150 ? '...' : ''}
               </div>`
            : `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 1rem;">
                Characters: ${this.escapeHtml((item.characters || []).map(c => c.name).join(', ') || 'Unknown')}
               </div>`;

        const content = document.createElement('div');
        content.style.cssText = `
            background: var(--surface-strong); border: 1px solid var(--border-strong);
            border-radius: 1rem; padding: 2rem; max-width: 400px; width: 90%;
            display: flex; flex-direction: column; align-items: center; text-align: center;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        `;

        const imgHtml = type === 'chat' && Array.isArray(imgSrc) 
            ? `<div style="position:relative; width:100%; height:100%;">${imgSrc.map((src, i) => `<div style="position:absolute; top:0; left:${(100/imgSrc.length)*i}%; width:${100/imgSrc.length}%; height:100%; overflow:hidden; border-right:${i < imgSrc.length - 1 ? '1px solid var(--border)' : 'none'};"><img src="${src}" style="width:100%; height:100%; object-fit:cover; object-position:top;"></div>`).join('')}</div>`
            : `<img src="${imgSrc}" style="width: 100%; height: 100%; object-fit: cover;">`;

        content.innerHTML = `
            <h2 style="margin: 0 0 1rem 0; color: #e55; font-size: 1.5rem;">Are you sure?</h2>
            <div style="width: 200px; height: 200px; border-radius: 0.5rem; overflow: hidden; margin-bottom: 1.5rem; border: 2px solid var(--border); box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                ${imgHtml}
            </div>
            <h3 style="margin: 0 0 0.5rem 0; font-size: 1.25rem;">${this.escapeHtml(title)}</h3>
            ${details}
            <p style="margin: 0 0 1.5rem 0; font-size: 0.95rem; color: var(--text-primary);">This action cannot be undone.</p>
            <div style="display: flex; gap: 1rem; width: 100%;">
                <button class="btn-outline" id="cancel-delete-btn" style="flex: 1; padding: 0.75rem; font-size: 1rem;">Cancel</button>
                <button class="btn-primary" id="confirm-delete-btn" style="flex: 1; padding: 0.75rem; background: #e55; border-color: #e55; font-size: 1rem;">Yes, Delete</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        content.querySelector('#cancel-delete-btn').addEventListener('click', () => {
            modal.remove();
        });

        content.querySelector('#confirm-delete-btn').addEventListener('click', async () => {
            const btn = content.querySelector('#confirm-delete-btn');
            btn.disabled = true;
            btn.textContent = 'Deleting...';
            try {
                if (type === 'card') {
                    await window.characterStorage.deleteCard(item.id);
                    this.loadCards({ preservePage: true }); // refresh grid, staying on current page
                } else if (type === 'chat') {
                    const res = await window.authFetch(`/api/sw/chats/${item.id}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error('Failed to delete chat');
                    this.loadRecentChats(); // refresh grid
                }
                modal.remove();
            } catch (err) {
                console.error('Delete failed:', err);
                btn.disabled = false;
                btn.textContent = 'Error - Try Again';
                alert('Failed to delete. Check console for details.');
            }
        });
    }
}

window.homeHandler = new HomeHandler();
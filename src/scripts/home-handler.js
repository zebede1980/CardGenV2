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
                this.loadRecent();
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
                <!-- Recent activity: the latest roleplay chats, messenger chats, stories and adventures -->
                <section id="home-recent-section" class="hr-section">
                    <h2 class="hr-heading">🕘 Recent activity</h2>
                    <div id="home-recent-grid" class="hr-grid">
                        <p class="hr-note">Loading…</p>
                    </div>
                </section>

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
                        #tab-home, #tab-cardgen, #tab-storywriter, #tab-roleplaychat, #tab-adventure, #tab-messenger {
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
            this.loadRecent();
        });
        if (tabCardGen) tabCardGen.addEventListener('click', () => switchView(viewCardGen, tabCardGen));
        if (tabStoryWriter) tabStoryWriter.addEventListener('click', () => switchView(viewStoryWriter, tabStoryWriter));
        if (tabChat) tabChat.addEventListener('click', () => switchView(viewChat, tabChat));
        if (tabAdventure) tabAdventure.addEventListener('click', () => {
            switchView(viewAdventure, tabAdventure);
            if(window.adventureHandler) window.adventureHandler.showView();
        });

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
                <div class="home-card-image" title="${this.escapeHtml(cardName)} — click to view the full card" style="position: relative; width: 100%; aspect-ratio: 1/1; border-radius: 0.5rem; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; cursor: pointer;">
                    <img src="${imgSrc}" alt="${this.escapeHtml(cardName)}" onerror="this.src='${fallbackSvg.replace(/'/g, "\\'")}'" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
                <h3 style="margin: 0; font-size: 1.2rem; text-align: center; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.escapeHtml(cardName)}">${this.escapeHtml(cardName)}</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; width: 100%; margin-top: auto;">
                    <button class="btn-small btn-outline delete-card-btn" style="border-radius: 0.4rem; padding: 0.5rem;" title="Delete this character">🗑️ Delete</button>
                    <button class="btn-small btn-outline edit-btn" style="border-radius: 0.4rem; padding: 0.5rem;">✏️ Edit</button>
                    <button class="btn-small btn-primary story-btn" style="border-radius: 0.4rem; padding: 0.5rem;">📖 Story</button>
                    <button class="btn-small btn-primary chat-btn" style="border-radius: 0.4rem; padding: 0.5rem;">💬 Chat</button>
                    <button class="btn-small btn-outline text-btn" style="border-radius: 0.4rem; padding: 0.5rem; grid-column: 1 / -1;" title="Text this character in 💌 Messenger">💌 Text</button>
                </div>
            `;

            tile.querySelector('.delete-card-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showDeleteConfirmation('card', card, imgSrc);
            });

            // Clicking the portrait opens the card's details — the obvious gesture
            // when you spot a card you want to look at. Replaces the old Info button,
            // whose slot in the button grid is now Delete.
            tile.querySelector('.home-card-image').addEventListener('click', (e) => {
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

            // Story Button: Swaps to Story tab and opens the New story sheet with this character picked
            tile.querySelector('.story-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('tab-storywriter')?.click();
                window.storyWriterApp?.autowriter?.openSetup({ cards: [{ id: card.id, name: cardName }] });
            });
            
            // Text Button: opens 💌 Messenger's New sheet with this character picked
            tile.querySelector('.text-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                window.messengerHandler?.openNewWith({ id: card.id, name: cardName });
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

    // The four latest things you were doing, from any mode, as one kind of tile.
    async loadRecent() {
        const grid = document.getElementById('home-recent-grid');
        if (!grid) return;
        const get = async (url) => {
            const res = await window.authFetch(url);
            if (!res.ok) throw new Error(`${url} ${res.status}`);
            return res.json();
        };
        const results = await Promise.allSettled([
            get('/api/sw/chats/'), get('/api/sw/messenger/'), get('/api/sw/stories/'), get('/api/sw/adventures/'),
        ]);
        if (results.every((r) => r.status === 'rejected')) {
            grid.innerHTML = '<p class="hr-note">Couldn’t load your recent activity.</p>';
            return;
        }
        const [chats, texts, stories, adventures] = results.map((r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []));
        const people = (list) => (list || []).map((c) => ({ id: c.id, name: c.name || '' }));
        const items = [
            ...chats.map((c) => ({ kind: 'roleplay', id: c.id, title: c.title, at: c.last_at || c.updated_at, characters: null })),
            ...texts.map((c) => ({ kind: 'messenger', id: c.id, title: c.title, at: c.last_at, characters: people(c.characters) })),
            ...stories.map((st) => ({ kind: 'story', id: st.id, title: st.title, at: st.updated_at, characters: people(st.characters) })),
            ...adventures.map((a) => ({ kind: 'adventure', id: a.id, title: a.title, at: a.updated_at, characters: people(a.characters) })),
        ].map((it) => ({ ...it, when: HomeHandler.parseUtc(it.at) }))
            .sort((x, y) => (y.when || 0) - (x.when || 0))
            .slice(0, 4);

        // The roleplay list has no cast: fetch it for the few that are shown.
        await Promise.all(items.filter((it) => !it.characters).map(async (it) => {
            try { it.characters = people((await get(`/api/sw/chats/${it.id}`)).characters); } catch (_) { it.characters = []; }
        }));
        this.renderRecent(items);
    }

    static parseUtc(s) {
        if (!s) return null;
        const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
        return isNaN(d) ? null : d;
    }

    renderRecent(items) {
        const grid = document.getElementById('home-recent-grid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!items.length) {
            grid.innerHTML = '<p class="hr-note">Nothing yet. Pick a character below to start a chat, a story or an adventure.</p>';
            return;
        }
        const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || '';
        const portrait = (id) => `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(id)}${token ? '&token=' + encodeURIComponent(token) : ''}`;

        items.forEach((it) => {
            const mode = HomeHandler.RECENT_MODES[it.kind];
            const cast = it.characters || [];
            const shown = cast.length > 4 ? cast.slice(0, 3) : cast;
            const tile = document.createElement('div');
            tile.className = 'hr-tile';
            tile.tabIndex = 0;
            tile.setAttribute('role', 'button');
            tile.setAttribute('aria-label', `${mode.label}: ${it.title || mode.label}`);

            const art = shown.length
                ? shown.map((c) => `<span class="hr-slot" data-initial="${this.escapeHtml((c.name || '?').charAt(0).toUpperCase())}"><img src="${portrait(c.id)}" alt="" loading="lazy"></span>`).join('')
                  + (cast.length > 4 ? `<span class="hr-slot hr-more">+${cast.length - 3}</span>` : '')
                : `<span class="hr-slot hr-empty" aria-hidden="true">${mode.icon}</span>`;
            const who = cast.map((c) => c.name).filter(Boolean).join(', ');

            tile.innerHTML = `
                <div class="hr-art">
                    ${art}
                    <span class="hr-mode">${mode.icon} ${mode.label}</span>
                    <button type="button" class="hr-del" title="Delete" aria-label="Delete ${this.escapeHtml(it.title || mode.label)}">🗑️</button>
                </div>
                <h3 class="hr-title" title="${this.escapeHtml(it.title)}">${this.escapeHtml(it.title || mode.label)}</h3>
                <div class="hr-who">${who ? '👤 ' + this.escapeHtml(who) : '&nbsp;'}</div>
                <div class="hr-foot"><span class="hr-when">${it.when ? this.formatRelativeDate(it.when) : ''}</span><span class="hr-go">Continue ➔</span></div>`;

            // A portrait that won't load shows the initial instead.
            tile.querySelectorAll('.hr-slot img').forEach((img) => {
                img.addEventListener('error', () => { img.parentElement.classList.add('hr-noimg'); img.remove(); });
            });
            tile.querySelector('.hr-del').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showDeleteConfirmation('activity', { ...it, characters: cast }, shown.length ? shown.map((c) => portrait(c.id)) : null);
            });
            const open = () => this.openRecent(it);
            tile.addEventListener('click', open);
            tile.addEventListener('keydown', (e) => {
                if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
            });
            grid.appendChild(tile);
        });
    }

    async openRecent(it) {
        if (it.kind === 'roleplay') {
            document.getElementById('tab-roleplaychat')?.click();
            await window.roleplayChatHandler?.selectChat(it.id);
        } else if (it.kind === 'messenger') {
            window.messengerHandler?.showView();
            await window.messengerHandler?.openChat(it.id);
        } else if (it.kind === 'story') {
            document.getElementById('tab-storywriter')?.click();
            await window.storyWriterApp?.openStory(it.id);
        } else if (it.kind === 'adventure') {
            document.getElementById('tab-adventure')?.click();
            await window.adventureHandler?.openSession(it.id);
        }
    }

    // Deleted from Home while it is open in its own tab: close it there.
    _closeIfOpen(it) {
        if (it.kind === 'roleplay' && window.roleplayChatHandler?.activeChatId === it.id) {
            window.roleplayChatHandler.activeChatId = null;
            window.roleplayChatHandler.showLobby?.();
        } else if (it.kind === 'messenger' && window.messengerHandler?.chat?.id === it.id) {
            window.messengerHandler.closeChat();
        } else if (it.kind === 'story' && String(window.storyWriterApp?.currentStoryId) === String(it.id)) {
            document.getElementById('sw-back-btn')?.click();
        } else if (it.kind === 'adventure' && window.adventureHandler?.currentSessionId === it.id) {
            window.adventureHandler.closeSession();
        }
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
            : (item.title || 'Untitled');

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

        const imgHtml = !imgSrc
            ? `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:4rem;">${HomeHandler.RECENT_MODES[item.kind]?.icon || '🗂️'}</div>`
            : type === 'activity' && Array.isArray(imgSrc) 
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
                } else if (type === 'activity') {
                    const res = await window.authFetch(`${HomeHandler.RECENT_MODES[item.kind].api}${encodeURIComponent(item.id)}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error('Failed to delete');
                    this._closeIfOpen(item);
                    this.loadRecent();
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

HomeHandler.RECENT_MODES = {
    roleplay: { icon: '💬', label: 'Roleplay', api: '/api/sw/chats/' },
    messenger: { icon: '💌', label: 'Messenger', api: '/api/sw/chats/' },
    story: { icon: '📖', label: 'Story', api: '/api/sw/stories/' },
    adventure: { icon: '🎲', label: 'Adventure', api: '/api/sw/adventures/' },
};

window.homeHandler = new HomeHandler();
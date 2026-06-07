/**
 * Gallery Mode Module
 * Provides a visual tile-based gallery for character cards.
 */
class CardGallery {
    constructor() {
        this.createModal();
    }

    createModal() {
        // Main Gallery Modal
        this.modal = document.createElement('div');
        this.modal.id = 'card-gallery-modal';
        this.modal.className = 'modal-overlay';
        this.modal.style.display = 'none';
        this.modal.style.zIndex = '2000';
        this.modal.innerHTML = `
            <div class="api-settings-modal" style="max-width: 95vw; width: 1200px; max-height: 90vh; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h2 class="modal-title">🖼️ Character Gallery</h2>
                    <button id="card-gallery-close" class="modal-close">×</button>
                </div>
                <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 1.5rem; background: var(--bg-page, #1e1e2e);">
                    <div id="card-gallery-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.5rem;">
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.modal);

        // Character Info Modal
        this.infoModal = document.createElement('div');
        this.infoModal.id = 'card-gallery-info-modal';
        this.infoModal.className = 'modal-overlay';
        this.infoModal.style.display = 'none';
        this.infoModal.style.zIndex = '2001';
        this.infoModal.innerHTML = `
            <div class="api-settings-modal" style="max-width: 800px; width: 90%; max-height: 90vh; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h2 id="gallery-info-title" class="modal-title">Character Info</h2>
                    <button id="card-gallery-info-close" class="modal-close">×</button>
                </div>
                <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 1.5rem;">
                    <div id="gallery-info-content" style="white-space: pre-wrap; line-height: 1.6;"></div>
                </div>
            </div>
        `;
        document.body.appendChild(this.infoModal);

        // Bind close events
        document.getElementById('card-gallery-close').addEventListener('click', () => this.close());
        document.getElementById('card-gallery-info-close').addEventListener('click', () => this.closeInfo());
    }

    open(cards, onSelect) {
        this.onSelect = onSelect;
        const grid = document.getElementById('card-gallery-grid');
        grid.innerHTML = '';
        
        const authToken = window.cardgenAuth?.getToken() || "";
        
        if (!cards || cards.length === 0) {
            grid.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary);">No characters found.</p>';
        } else {
            const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='%232d2d3d'/><text x='50' y='50' font-family='Arial' font-size='14' fill='%23888' text-anchor='middle' dominant-baseline='middle'>No Image</text></svg>`;
            
            cards.forEach(card => {
                const tile = document.createElement('div');
                tile.className = 'content-box';
                tile.style.display = 'flex';
                tile.style.flexDirection = 'column';
                tile.style.alignItems = 'center';
                tile.style.padding = '1rem';
                tile.style.gap = '0.75rem';
                tile.style.borderRadius = '0.5rem';
                tile.style.background = 'var(--surface-color, #2a2a35)';
                tile.style.border = '1px solid var(--border, #3a3a4a)';
                tile.style.transition = 'transform 0.2s, border-color 0.2s';
                tile.style.cursor = 'pointer';
                
                tile.onmouseenter = () => { tile.style.transform = 'scale(1.03)'; tile.style.borderColor = 'var(--accent, #3b82f6)'; };
                tile.onmouseleave = () => { tile.style.transform = 'scale(1)'; tile.style.borderColor = 'var(--border, #3a3a4a)'; };
                
                const cardName = card.characterName || (card.character && card.character.name) || card.name || 'Unknown Character';

                // Image resolution logic
                let imgSrc = fallbackSvg;
                if (card.avatar && card.avatar.startsWith('data:')) {
                    imgSrc = card.avatar;
                } else if (card.imageUrl) {
                    imgSrc = card.imageUrl;
                } else if (card.image) {
                    imgSrc = card.image;
                } else if (card.id) {
                    const tStamp = new Date(card.updatedAt || card.createdAt || 0).getTime();
                    imgSrc = `/api/storage/cards/thumbnail?cardId=${encodeURIComponent(card.id)}${authToken ? '&token=' + encodeURIComponent(authToken) : ''}&_t=${tStamp}`;
                }

                tile.innerHTML = `
                    <div style="width: 100%; aspect-ratio: 1/1; border-radius: 0.5rem; overflow: hidden; background: var(--bg-tertiary, #1e1e2e); display: flex; align-items: center; justify-content: center;">
                        <img src="${imgSrc}" alt="${this.escapeHtml(cardName)}" onerror="this.src='${fallbackSvg.replace(/'/g, "\\'")}'" style="width: 100%; height: 100%; object-fit: cover;">
                    </div>
                    <h3 style="margin: 0; font-size: 1.1rem; text-align: center; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.escapeHtml(cardName)}">${this.escapeHtml(cardName)}</h3>
                    <div style="display: flex; gap: 0.5rem; width: 100%; margin-top: auto;">
                        <button class="btn-small btn-outline info-btn" style="flex: 1;">Info</button>
                        <button class="btn-small btn-primary select-btn" style="flex: 1;">Select</button>
                    </div>
                `;

                // Prevent tile click from firing when clicking buttons directly
                const handleSelect = (e) => {
                    e.stopPropagation();
                    if (this.onSelect) this.onSelect(card.id || card);
                    this.close();
                };
                
                tile.addEventListener('click', handleSelect);
                tile.querySelector('.select-btn').addEventListener('click', handleSelect);
                
                tile.querySelector('.info-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showInfo(card);
                });
                
                grid.appendChild(tile);
            });
        }
        
        this.modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    close() {
        this.modal.style.display = 'none';
        document.body.style.overflow = '';
    }

    showInfo(card) {
        const charObj = card.character || card;
        const cardName = card.characterName || charObj.name || 'Unknown Character';
        document.getElementById('gallery-info-title').textContent = cardName;
        
        let contentHtml = '';
        if (charObj.description) contentHtml += `<div style="margin-bottom: 1rem;"><strong>Description:</strong><br>${this.escapeHtml(charObj.description)}</div>`;
        if (charObj.personality) contentHtml += `<div style="margin-bottom: 1rem;"><strong>Personality:</strong><br>${this.escapeHtml(charObj.personality)}</div>`;
        if (charObj.scenario) contentHtml += `<div style="margin-bottom: 1rem;"><strong>Scenario:</strong><br>${this.escapeHtml(charObj.scenario)}</div>`;
        if (charObj.firstMessage) contentHtml += `<div style="margin-bottom: 1rem;"><strong>First Message:</strong><br>${this.escapeHtml(charObj.firstMessage)}</div>`;
        
        if (!contentHtml) contentHtml = 'No detailed information available for this character.';
        
        document.getElementById('gallery-info-content').innerHTML = contentHtml;
        this.infoModal.style.display = 'flex';
    }

    closeInfo() {
        this.infoModal.style.display = 'none';
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
}

// Initialize gallery singleton
window.cardGallery = new CardGallery();
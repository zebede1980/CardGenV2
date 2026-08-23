const initChatCharacterCards = () => {
    const btn = document.getElementById('chat-view-cards-btn');
    const modal = document.getElementById('chat-cards-modal');
    const closeBtn = document.getElementById('chat-cards-close-btn');
    const row = document.getElementById('chat-cards-row');

    if (!modal || !row) return;

    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

    const FIELDS = [
        ['description', 'Description'],
        ['personality', 'Personality'],
        ['scenario', 'Scenario'],
        ['first_mes', 'First Message'],
        ['mes_example', 'Example Messages'],
        ['creatorcomment', "Creator's Note"],
        ['tags', 'Tags'],
    ];

    const buildTile = (char, token) => {
        const tile = document.createElement('div');
        tile.className = 'chat-card-tile';

        const imgWrap = document.createElement('div');
        imgWrap.className = 'chat-card-tile-img-wrap';
        const placeholder = document.createElement('div');
        placeholder.className = 'chat-card-tile-placeholder';
        placeholder.textContent = (char.name || '?')[0].toUpperCase();
        imgWrap.appendChild(placeholder);
        const img = document.createElement('img');
        img.className = 'chat-card-tile-img';
        img.alt = char.name || '';
        img.src = `/api/storage/cards/thumbnail?cardId=${char.id}&token=${encodeURIComponent(token)}`;
        img.onerror = () => { img.style.display = 'none'; };
        if (char.id) {
            img.style.cursor = 'pointer';
            img.title = 'View gallery';
            img.addEventListener('click', () => {
                if (window.app && window.app.openCardImageGallery) {
                    window.app.openCardImageGallery(char.id, img.src, char.name);
                }
            });
        }
        imgWrap.appendChild(img);
        tile.appendChild(imgWrap);

        const name = document.createElement('div');
        name.className = 'chat-card-tile-name';
        name.textContent = char.name || 'Unnamed';
        tile.appendChild(name);

        const fields = document.createElement('div');
        fields.className = 'chat-card-tile-fields';
        let html = '';
        FIELDS.forEach(([key, label]) => {
            let val = char[key];
            if (Array.isArray(val)) val = val.filter(Boolean).join(', ');
            if (!val) return;
            html += `<div><strong>${label}:</strong><br>${escapeHtml(val)}</div>`;
        });
        fields.innerHTML = html || '<div>No details available for this character.</div>';
        tile.appendChild(fields);

        return tile;
    };

    const openCharacterCardsViewer = (characters) => {
        if (!characters || !characters.length) {
            alert('No characters linked yet.');
            return;
        }
        const token = window.cardgenAuth?.getToken() || localStorage.getItem('cardgen_auth_token') || '';
        row.innerHTML = '';
        characters.forEach(char => row.appendChild(buildTile(char, token)));
        modal.classList.add('show');
    };

    // Exposed so other modes (e.g. Story Writer) can reuse this same modal/viewer.
    window.openCharacterCardsViewer = openCharacterCardsViewer;

    const close = () => modal.classList.remove('show');

    btn?.addEventListener('click', () => openCharacterCardsViewer(window.roleplayChatHandler?.activeChatCharacters || []));
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatCharacterCards);
} else {
    initChatCharacterCards();
}

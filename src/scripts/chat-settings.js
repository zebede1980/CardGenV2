const initChatSettings = () => {
    const settingsBtn = document.getElementById('chat-settings-btn');
    const modal = document.getElementById('chat-settings-modal');
    const closeBtn = document.getElementById('chat-settings-close-btn');
    const titleInput = document.getElementById('chat-settings-title');
    const promptInput = document.getElementById('chat-settings-system-prompt');
    const saveBtn = document.getElementById('chat-settings-save-btn');

    if (!settingsBtn || !modal) return;

    settingsBtn.addEventListener('click', async () => {
        const chatId = window.roleplayChatHandler?.activeChatId;
        if (!chatId) {
            alert("Please select a chat first.");
            return;
        }

        try {
            const res = await window.authFetch(`/api/sw/chats/${chatId}`);
            if (res.ok) {
                const chat = await res.json();
                titleInput.value = chat.title || '';
                promptInput.value = chat.system_prompt || '';
                modal.classList.add('show');
            }
        } catch (e) {
            console.error("Failed to load chat settings", e);
        }
    });

    closeBtn.addEventListener('click', () => modal.classList.remove('show'));

    saveBtn.addEventListener('click', async () => {
        const chatId = window.roleplayChatHandler?.activeChatId;
        if (!chatId) return;

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            
            const res = await window.authFetch(`/api/sw/chats/${chatId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: titleInput.value.trim(), system_prompt: promptInput.value.trim() })
            });
            
            if (res.ok) {
                modal.classList.remove('show');
                // Refresh UI title if active
                if (window.roleplayChatHandler) {
                    window.roleplayChatHandler.loadSessionList();
                    const activeTitle = document.getElementById('chat-active-title');
                    if (activeTitle) activeTitle.textContent = titleInput.value.trim();
                }
            }
        } catch (e) {
            console.error("Failed to save chat settings", e);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
        }
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatSettings);
} else {
    initChatSettings();
}
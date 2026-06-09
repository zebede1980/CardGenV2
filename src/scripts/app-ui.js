// UI Helper Methods — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {

  showNotification(message, type = "info") {
    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;
    notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            color: white;
            font-weight: 500;
            z-index: 10000;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        `;

    const colors = {
      success: "#28a745",
      error: "#dc3545",
      warning: "#ffc107",
      info: "#0066cc",
    };

    notification.style.backgroundColor = colors[type] || colors.info;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.transform = "translateX(0)";
    }, 10);

    setTimeout(() => {
      notification.style.transform = "translateX(100%)";
      setTimeout(() => {
        if (notification.parentNode) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 5000);
  },

  setGeneratingState(isGenerating) {
    const generateBtn = document.getElementById("generate-btn");
    const stopBtn = document.getElementById("stop-btn");
    const btnText = generateBtn.querySelector(".btn-text");
    const btnLoading = generateBtn.querySelector(".btn-loading");

    if (isGenerating) {
      generateBtn.disabled = true;
      btnText.style.display = "none";
      btnLoading.style.display = "inline";
      stopBtn.style.display = "inline-block";
    } else {
      generateBtn.disabled = false;
      btnText.style.display = "inline";
      btnLoading.style.display = "none";
      stopBtn.style.display = "none";
    }
  },

  setRevisionState(isRevising, buttonId = "revise-character-btn") {
    this.isRevising = isRevising;
    const reviseBtn = document.getElementById("revise-character-btn");
    const reduceBtn = document.getElementById("reduce-tokens-btn");
    const stopBtn = document.getElementById("stop-revision-btn");

    if (reviseBtn) {
      const btnText = reviseBtn.querySelector(".btn-text");
      const btnLoading = reviseBtn.querySelector(".btn-loading");
      if (isRevising && buttonId === "revise-character-btn") {
        reviseBtn.disabled = true;
        if (btnText) btnText.style.display = "none";
        if (btnLoading) btnLoading.style.display = "inline";
      } else {
        reviseBtn.disabled = isRevising;
        if (btnText) btnText.style.display = "inline";
        if (btnLoading) btnLoading.style.display = "none";
      }
    }

    if (reduceBtn) {
      const btnText = reduceBtn.querySelector(".btn-text");
      const btnLoading = reduceBtn.querySelector(".btn-loading");
      if (isRevising && buttonId === "reduce-tokens-btn") {
        reduceBtn.disabled = true;
        if (btnText) btnText.style.display = "none";
        if (btnLoading) btnLoading.style.display = "inline";
      } else {
        reduceBtn.disabled = isRevising;
        if (btnText) btnText.style.display = "inline";
        if (btnLoading) btnLoading.style.display = "none";
      }
    }

    if (stopBtn) {
      stopBtn.style.display = isRevising ? "inline-block" : "none";
    }
  },

  showResultSection() {
    const resultSection = document.querySelector(".result-section");
    const downloadBtn = document.getElementById("download-btn");
    const saveCardBtn = document.getElementById("save-card-btn");
    const snapshotHistoryBtn = document.getElementById("snapshot-history-btn");
    const checkConsistencyBtn = document.getElementById("check-consistency-btn");
    const testChatBtn = document.getElementById("test-chat-btn");
    const remasterBtn = document.getElementById("remaster-btn");
    const remasterTopBtn = document.getElementById("remaster-top-btn");

    resultSection.style.display = "block";
    downloadBtn.style.display = "inline-flex";

    if (saveCardBtn && this.currentCharacter) {
      saveCardBtn.style.display = "inline-flex";
    }
    if (snapshotHistoryBtn && this.currentCharacter) {
      snapshotHistoryBtn.style.display = "inline-flex";
    }
    if (checkConsistencyBtn && this.currentCharacter) {
      checkConsistencyBtn.style.display = "inline-flex";
    }
    if (testChatBtn && this.currentCharacter) {
      testChatBtn.style.display = "inline-flex";
    }
    if (remasterBtn && this.currentCharacter) {
      remasterBtn.style.display = "inline-flex";
    }
    if (remasterTopBtn && this.currentCharacter) {
      remasterTopBtn.style.display = "inline-flex";
    }

    // Show push-to-ST button if ST URL is configured
    const pushToSTBtn = document.getElementById("push-to-st-btn");
    if (pushToSTBtn) this._updatePushButton();

    resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  hideResultSection() {
    const resultSection = document.querySelector(".result-section");
    const downloadBtn = document.getElementById("download-btn");
    const saveCardBtn = document.getElementById("save-card-btn");
    const checkConsistencyBtn = document.getElementById("check-consistency-btn");
    const testChatBtn = document.getElementById("test-chat-btn");
    const remasterBtn = document.getElementById("remaster-btn");
    const remasterTopBtn = document.getElementById("remaster-top-btn");

    resultSection.style.display = "none";
    downloadBtn.style.display = "none";
    if (saveCardBtn) saveCardBtn.style.display = "none";
    if (checkConsistencyBtn) checkConsistencyBtn.style.display = "none";
    if (testChatBtn) testChatBtn.style.display = "none";
    if (remasterBtn) remasterBtn.style.display = "none";
    if (remasterTopBtn) remasterTopBtn.style.display = "none";
  },

  clearStream() {
    const streamContent = document.getElementById("stream-content");
    streamContent.innerHTML =
      '<div class="stream-placeholder">Generation output will appear here...</div>';
  },

  appendStreamContent(content) {
    const streamContent = document.getElementById("stream-content");

    const placeholder = streamContent.querySelector(".stream-placeholder");
    if (placeholder) {
      placeholder.remove();
    }

    let contentContainer = streamContent.querySelector(".stream-content");
    if (!contentContainer) {
      contentContainer = document.createElement("div");
      contentContainer.className = "stream-content";
      streamContent.appendChild(contentContainer);
    }

    contentContainer.textContent += content;
    streamContent.scrollTop = streamContent.scrollHeight;
  },

  showStreamMessage(message) {
    const streamContent = document.getElementById("stream-content");
    const messageElement = document.createElement("div");
    messageElement.textContent = message;
    streamContent.appendChild(messageElement);
    streamContent.scrollTop = streamContent.scrollHeight;
  },

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(url), 100);
  },

  validateInput() {
    const concept = document.getElementById("character-concept").value.trim();
    const characterName = document
      .getElementById("character-name")
      .value.trim();

    const errors = [];

    if (!concept) {
      errors.push("Character concept is required");
    } else if (concept.length < 10) {
      errors.push("Character concept should be at least 10 characters");
    } else if (concept.length > 1000) {
      errors.push("Character concept should be less than 1000 characters");
    }

    if (characterName && characterName.length > 50) {
      errors.push("Character name should be less than 50 characters");
    }

    return errors;
  },

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (!this.isGenerating) {
          this.handleGenerate();
        }
      }

      if (e.key === "Escape") {
        if (this.isGenerating) {
          this.handleStop();
        }
      }
    });
  },

  injectTechLogsUI() {
    if (document.getElementById('tech-logs-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'tech-logs-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.style.zIndex = '3000';
    modal.innerHTML = `
      <div class="api-settings-modal" style="max-width: 1100px; width: 95%; max-height: 90vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h2 class="modal-title">🛠️ API Request Logs</h2>
          <button id="tech-logs-close-btn" class="modal-close">×</button>
        </div>
        <div class="modal-body" style="flex: 1; min-height: 0; display: flex; flex-direction: row; overflow-y: auto; overflow-x: hidden; padding: 0; flex-wrap: wrap;">
          <div id="tech-logs-list" style="flex: 1 1 250px; max-width: 350px; border-right: 1px solid var(--border); overflow-y: auto; background: var(--surface-muted); padding: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem;">
            <div style="color: var(--text-secondary); text-align: center; padding: 1rem;">No logs available.</div>
          </div>
          <div id="tech-logs-details" style="flex: 2 1 400px; min-height: 0; overflow-y: auto; padding: 1rem 1.5rem; background: var(--bg-page); display: flex; flex-direction: column;">
            <div style="color: var(--text-secondary); text-align: center; margin-top: 2rem;">Select a request to view details</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('tech-logs-close-btn').addEventListener('click', () => modal.style.display = 'none');
    modal.addEventListener('click', (e) => { if(e.target === modal) modal.style.display = 'none'; });

    const apiStatus = document.getElementById('api-status');
    if (apiStatus && apiStatus.parentElement) {
        const btn = document.createElement('button');
        btn.id = 'open-tech-logs-btn';
        btn.className = 'btn-outline btn-small';
        btn.innerHTML = '🛠️ API Logs';
        btn.style.marginLeft = '1rem';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openTechLogsModal();
        });
        apiStatus.parentElement.appendChild(btn);
    }
  },

  openTechLogsModal() {
    const modal = document.getElementById('tech-logs-modal');
    if (!modal) return;
    this.renderTechLogsList();
    modal.style.display = 'flex';
  },

  renderTechLogsList() {
    const listEl = document.getElementById('tech-logs-list');
    if (!listEl) return;
    
    const logs = window.apiHandler ? window.apiHandler.requestLogs : [];
    if (!logs || logs.length === 0) {
        listEl.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 1rem;">No requests recorded yet.</div>`;
        return;
    }

    listEl.innerHTML = '';
    logs.forEach(log => {
        const item = document.createElement('div');
        item.style.cssText = 'padding: 0.75rem; background: var(--surface-color); border: 1px solid var(--border); border-radius: 0.4rem; cursor: pointer; display: flex; flex-direction: column; gap: 0.25rem; transition: border-color 0.2s;';
        item.onmouseenter = () => item.style.borderColor = 'var(--accent)';
        item.onmouseleave = () => item.style.borderColor = 'var(--border)';
        
        const timeStr = new Date(log.timestamp).toLocaleTimeString();
        let statusColor = log.status === 200 ? 'var(--success)' : 'var(--error)';
        if (log.status === 'pending') statusColor = 'var(--warning)';

        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-secondary);">
                <span>${timeStr}</span>
                <span style="color: ${statusColor}; font-weight: bold;">${log.status}</span>
            </div>
            <div style="font-weight: 600; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(log.endpoint)}
            </div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">
                ${escapeHtml(log.model || 'Unknown model')} • ${(log.duration/1000).toFixed(2)}s
            </div>
        `;
        
        item.addEventListener('click', () => {
            document.querySelectorAll('#tech-logs-list > div').forEach(el => el.style.borderLeft = '');
            item.style.borderLeft = '3px solid var(--accent)';
            this.showTechLogDetails(log);
        });
        
        listEl.appendChild(item);
    });
  },

  showTechLogDetails(log) {
    const detailsEl = document.getElementById('tech-logs-details');
    if (!detailsEl) return;

    const reqStr = JSON.stringify(log.request, null, 2);
    const resStr = typeof log.response === 'object' ? JSON.stringify(log.response, null, 2) : log.response;
    
    let usageHtml = '';
    if (log.usage) {
        usageHtml = `
        <div style="display: flex; gap: 1rem; margin-bottom: 0.75rem; background: var(--surface-color); padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border); font-size: 0.85rem; flex-wrap: wrap;">
            <div><strong style="color:var(--text-secondary);">Prompt Tokens:</strong> ${log.usage.prompt_tokens || 0}</div>
            <div><strong style="color:var(--text-secondary);">Completion:</strong> ${log.usage.completion_tokens || 0}</div>
            <div><strong style="color:var(--text-secondary);">Total:</strong> ${log.usage.total_tokens || 0}</div>
            ${log.usage.prompt_cache_hit_tokens ? `<div><strong style="color:var(--success);">Cache Hits:</strong> ${log.usage.prompt_cache_hit_tokens}</div>` : ''}
        </div>`;
    }

    detailsEl.innerHTML = `
      <h3 style="margin-top:0; margin-bottom: 0.75rem;">Request Details</h3>
      <div style="display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; font-size: 0.85rem; margin-bottom: 0.75rem; color: var(--text-primary);">
        <div style="color: var(--text-secondary);">Endpoint:</div><div>${escapeHtml(log.endpoint)}</div>
        <div style="color: var(--text-secondary);">Model:</div><div>${escapeHtml(log.model || 'N/A')}</div>
        <div style="color: var(--text-secondary);">Status:</div><div><strong style="color: ${log.status === 200 ? 'var(--success)' : (log.status === 'pending' ? 'var(--warning)' : 'var(--error)')}">${escapeHtml(log.status)}</strong></div>
        <div style="color: var(--text-secondary);">Duration:</div><div>${(log.duration/1000).toFixed(2)}s</div>
      </div>
      ${usageHtml}
      
      <div style="display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-height: 300px; gap: 0.75rem;">
        <div style="display: flex; flex-direction: column; min-height: 0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
            <h4 style="margin: 0;">Request Payload</h4>
            <button class="btn-outline btn-small tech-log-copy-btn" data-target="tech-log-req" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;">📋 Copy</button>
          </div>
          <pre id="tech-log-req" style="flex: 1; min-height: 0; background: var(--surface-strong, #111820); padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border); overflow: auto; font-size: 0.8rem; margin: 0; white-space: pre-wrap; word-break: break-all;"><code>${escapeHtml(reqStr)}</code></pre>
        </div>
        
        <div style="display: flex; flex-direction: column; min-height: 0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
            <h4 style="margin: 0;">Response Payload</h4>
            <button class="btn-outline btn-small tech-log-copy-btn" data-target="tech-log-res" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;">📋 Copy</button>
          </div>
          <pre id="tech-log-res" style="flex: 1; min-height: 0; background: var(--surface-strong, #111820); padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border); overflow: auto; font-size: 0.8rem; margin: 0; white-space: pre-wrap; word-break: break-all;"><code>${escapeHtml(resStr || 'No response recorded yet')}</code></pre>
        </div>
      </div>
    `;

    // Attach copy handlers to the buttons just created
    requestAnimationFrame(() => {
      detailsEl.querySelectorAll('.tech-log-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetId = btn.getAttribute('data-target');
          const preEl = document.getElementById(targetId);
          if (preEl) {
            const text = preEl.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
              const orig = btn.textContent;
              btn.textContent = '✅ Copied!';
              setTimeout(() => { btn.textContent = orig; }, 1500);
            }).catch(() => {
              btn.textContent = '❌ Failed';
              setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
            });
          }
        });
      });
    });
  }
});

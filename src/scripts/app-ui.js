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

});

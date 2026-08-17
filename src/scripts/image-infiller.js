// Image In-filler / Inpainting Capability — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {
  _infillState: {
    img: null,
    stageWidth: 0,
    stageHeight: 0,
    naturalWidth: 0,
    naturalHeight: 0,
    scale: 1,
    brushSize: 30,
    toolMode: "brush", // "brush" or "eraser"
    isDrawing: false,
    lastX: 0,
    lastY: 0,
    history: [], // Stack of ImageData for Undo
    maxHistory: 25,
    listenersInitialized: false,
    pendingResult: null, // Holds the inpainted URL until user confirms Save to Card
  },

  updateInfillButtonVisibility() {
    const btn = document.getElementById("inpaint-image-btn");
    if (btn) {
      if (this.currentImageUrl) {
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
      } else {
        btn.style.display = "none";
      }
    }
    // Reference-image in-fill button (Character Generation screen, pre-card)
    const refBtn = document.getElementById("inpaint-reference-image-btn");
    if (refBtn) {
      refBtn.style.display = this.referenceImageDataUrl ? "inline-flex" : "none";
    }
    // Playground in-fill button (Image Playground tab)
    const pgBtn = document.getElementById("inpaint-playground-image-btn");
    if (pgBtn) {
      pgBtn.style.display = this.playgroundImageUrl ? "inline-flex" : "none";
    }
  },

  // Fetches any image URL (blob:, data:, or remote http(s)) and returns it as a
  // base64 data: URL. Needed for the 'reference' in-fill target because the
  // in-fill provider hands back a blob:/remote URL, but re-describing the
  // result via the vision model requires an embeddable data: URI.
  async _urlToDataUrl(url) {
    if (url.startsWith("data:")) return url;
    const resp = await (window.authFetch || fetch)(url);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error("Failed to convert in-fill result to a data URL"));
      reader.readAsDataURL(blob);
    });
  },

  // target: 'card' (default — this.currentImageUrl), 'reference' (the
  // pre-card reference image, this.referenceImageDataUrl), or 'playground'
  // (the Image Playground tab's working image, this.playgroundImageUrl). See
  // applyCrop()'s equivalent comment in image-cropper.js for why this branches.
  async openInfillModal(target = 'card') {
    this._infillTarget = target;

    if (target === 'reference') {
      if (!this.referenceImageDataUrl) {
        this.showNotification("No reference image available to in-fill", "warning");
        return;
      }
    } else if (target === 'playground') {
      if (!this.playgroundImageUrl) {
        this.showNotification("Upload or paste an image first", "warning");
        return;
      }
    } else {
      if (!this.currentCharacter) {
        this.showNotification("Please generate or select a character first", "warning");
        return;
      }
      if (!this.currentImageUrl) {
        this.showNotification("No image available to in-fill", "warning");
        return;
      }
    }

    const modal = document.getElementById("image-inpaint-modal");
    if (!modal) return;

    this.showNotification("Loading image into In-fill editor...", "info");

    try {
      let imageSrc = target === 'reference' ? this.referenceImageDataUrl
        : target === 'playground' ? this.playgroundImageUrl
        : this.currentImageUrl;

      // If URL is external http(s), convert to Blob URL via proxy to prevent CORS canvas taint
      if (imageSrc.startsWith("http://") || imageSrc.startsWith("https://")) {
        try {
          const resp = await (window.authFetch || fetch)(`/api/proxy-image?url=${encodeURIComponent(imageSrc)}`);
          if (resp.ok) {
            const blob = await resp.blob();
            imageSrc = URL.createObjectURL(blob);
          }
        } catch (e) {
          console.warn("Proxy image fetch failed, proceeding with direct URL:", e);
        }
      }

      const img = new Image();
      img.crossOrigin = "anonymous";

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Failed to load image for inpainting"));
        img.src = imageSrc;
      });

      this._infillState.img = img;
      this._infillState.naturalWidth = img.naturalWidth || 896;
      this._infillState.naturalHeight = img.naturalHeight || 1152;
      this._infillState.history = [];
      this._infillState.toolMode = "brush";
      this._infillState.brushSize = parseInt(document.getElementById("infill-brush-size")?.value) || 30;

      modal.style.display = "flex";

      // Sync provider dropdown with current config
      const modalProviderSelect = document.getElementById("infill-modal-provider");
      if (modalProviderSelect) {
        const configuredProvider = this.config.get("api.image.infill.provider") || "localForge";
        modalProviderSelect.value = configuredProvider;
      }

      // Reset prompt input
      const promptInput = document.getElementById("infill-prompt-input");
      if (promptInput) promptInput.value = "";

      // Sync tool buttons
      this._updateInfillToolButtons();

      requestAnimationFrame(() => {
        this._renderInfillStage();
      });

      this._initInfillListenersOnce();

    } catch (error) {
      console.error("Infill modal error:", error);
      this.showNotification(`Could not open In-fill editor: ${error.message}`, "error");
    }
  },

  closeInfillModal() {
    const modal = document.getElementById("image-inpaint-modal");
    if (modal) {
      modal.style.display = "none";
    }
    const cursor = document.getElementById("infill-brush-cursor");
    if (cursor) cursor.style.display = "none";
    // Hide Save button and clear pending result so next open starts clean
    const saveBtn = document.getElementById("infill-save-btn");
    if (saveBtn) saveBtn.style.display = "none";
    this._infillState.pendingResult = null;
  },

  _renderInfillStage() {
    const { img } = this._infillState;
    if (!img) return;

    const workspace = document.getElementById("infill-workspace");
    const imageCanvas = document.getElementById("infill-image-canvas");
    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (!workspace || !imageCanvas || !maskCanvas) return;

    const naturalW = img.naturalWidth || 896;
    const naturalH = img.naturalHeight || 1152;

    const maxW = Math.max(50, (workspace.clientWidth || 400) - 16);
    const maxH = Math.max(50, (workspace.clientHeight || 400) - 16);

    const scale = Math.min(maxW / naturalW, maxH / naturalH, 1);
    const stageW = Math.round(naturalW * scale);
    const stageH = Math.round(naturalH * scale);

    this._infillState.stageWidth = stageW;
    this._infillState.stageHeight = stageH;
    this._infillState.scale = scale;

    // Size stage container
    const stage = document.getElementById("infill-stage");
    if (stage) {
      stage.style.width = `${stageW}px`;
      stage.style.height = `${stageH}px`;
    }

    // Render underlying image canvas
    imageCanvas.width = stageW;
    imageCanvas.height = stageH;
    const imgCtx = imageCanvas.getContext("2d");
    imgCtx.clearRect(0, 0, stageW, stageH);
    imgCtx.drawImage(img, 0, 0, stageW, stageH);

    // Prepare interactive mask canvas
    maskCanvas.width = stageW;
    maskCanvas.height = stageH;
    const maskCtx = maskCanvas.getContext("2d");
    maskCtx.clearRect(0, 0, stageW, stageH);

    // Save initial blank state to history for undo
    this._saveInfillHistory();
    this._updateInfillHistoryButtons();
  },

  _saveInfillHistory() {
    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    if (this._infillState.history.length >= this._infillState.maxHistory) {
      this._infillState.history.shift();
    }
    this._infillState.history.push(ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height));
    this._updateInfillHistoryButtons();
  },

  _undoInfillStroke() {
    if (this._infillState.history.length <= 1) {
      this.showNotification("Nothing to undo", "info");
      return;
    }
    // Remove current state
    this._infillState.history.pop();
    // Restore previous state
    const previousState = this._infillState.history[this._infillState.history.length - 1];
    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (maskCanvas && previousState) {
      const ctx = maskCanvas.getContext("2d");
      ctx.putImageData(previousState, 0, 0);
    }
    this._updateInfillHistoryButtons();
  },

  _clearInfillMask() {
    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    this._saveInfillHistory();
    this.showNotification("Mask cleared", "info");
  },

  _updateInfillHistoryButtons() {
    const undoBtn = document.getElementById("infill-undo-btn");
    if (undoBtn) {
      undoBtn.disabled = this._infillState.history.length <= 1;
    }
  },

  _updateInfillToolButtons() {
    const mode = this._infillState.toolMode;
    const brushBtn = document.getElementById("infill-tool-brush");
    const eraserBtn = document.getElementById("infill-tool-eraser");
    if (brushBtn) brushBtn.classList.toggle("active", mode === "brush");
    if (eraserBtn) eraserBtn.classList.toggle("active", mode === "eraser");
  },

  _initInfillListenersOnce() {
    if (this._infillState.listenersInitialized) return;
    this._infillState.listenersInitialized = true;

    // Modal Close buttons
    const closeBtn = document.getElementById("image-inpaint-close-btn");
    const cancelBtn = document.getElementById("infill-cancel-btn");
    if (closeBtn) closeBtn.addEventListener("click", () => this.closeInfillModal());
    if (cancelBtn) cancelBtn.addEventListener("click", () => this.closeInfillModal());

    // Tools
    const brushBtn = document.getElementById("infill-tool-brush");
    if (brushBtn) {
      brushBtn.addEventListener("click", () => {
        this._infillState.toolMode = "brush";
        this._updateInfillToolButtons();
      });
    }
    const eraserBtn = document.getElementById("infill-tool-eraser");
    if (eraserBtn) {
      eraserBtn.addEventListener("click", () => {
        this._infillState.toolMode = "eraser";
        this._updateInfillToolButtons();
      });
    }

    // Brush Size Slider & presets
    const brushSlider = document.getElementById("infill-brush-size");
    const brushValLabel = document.getElementById("infill-brush-size-val");
    if (brushSlider) {
      brushSlider.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10);
        this._infillState.brushSize = val;
        if (brushValLabel) brushValLabel.textContent = `${val}px`;
        this._updateBrushCursorSize();
      });
    }

    document.querySelectorAll(".infill-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const size = parseInt(btn.dataset.size, 10);
        if (size && brushSlider) {
          brushSlider.value = size;
          this._infillState.brushSize = size;
          if (brushValLabel) brushValLabel.textContent = `${size}px`;
          this._updateBrushCursorSize();
        }
      });
    });

    // Undo & Clear
    const undoBtn = document.getElementById("infill-undo-btn");
    if (undoBtn) undoBtn.addEventListener("click", () => this._undoInfillStroke());
    const clearBtn = document.getElementById("infill-clear-btn");
    if (clearBtn) clearBtn.addEventListener("click", () => this._clearInfillMask());

    // Apply In-fill button
    const applyBtn = document.getElementById("infill-apply-btn");
    if (applyBtn) applyBtn.addEventListener("click", () => this.handleApplyInfill());

    // Save to Card button
    const saveBtn = document.getElementById("infill-save-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => this.saveInfillToCard());

    // Interactive Stage Drawing & Cursor Follower
    const stage = document.getElementById("infill-stage");
    const maskCanvas = document.getElementById("infill-mask-canvas");
    const cursor = document.getElementById("infill-brush-cursor");

    if (stage && maskCanvas) {
      const getPos = (e) => {
        const rect = maskCanvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
          x: clientX - rect.left,
          y: clientY - rect.top,
          clientX,
          clientY,
        };
      };

      const startDraw = (e) => {
        e.preventDefault();
        this._infillState.isDrawing = true;
        const pos = getPos(e);
        this._infillState.lastX = pos.x;
        this._infillState.lastY = pos.y;
        this._drawMaskPoint(pos.x, pos.y);
      };

      const drawMove = (e) => {
        const pos = getPos(e);
        // Move cursor overlay
        if (cursor) {
          cursor.style.display = "block";
          cursor.style.left = `${pos.clientX}px`;
          cursor.style.top = `${pos.clientY}px`;
        }

        if (!this._infillState.isDrawing) return;
        e.preventDefault();
        this._drawMaskLine(this._infillState.lastX, this._infillState.lastY, pos.x, pos.y);
        this._infillState.lastX = pos.x;
        this._infillState.lastY = pos.y;
      };

      const stopDraw = (e) => {
        if (this._infillState.isDrawing) {
          this._infillState.isDrawing = false;
          this._saveInfillHistory();
        }
      };

      // Mouse events
      maskCanvas.addEventListener("mousedown", startDraw);
      window.addEventListener("mousemove", drawMove);
      window.addEventListener("mouseup", stopDraw);

      // Touch events
      maskCanvas.addEventListener("touchstart", startDraw, { passive: false });
      window.addEventListener("touchmove", drawMove, { passive: false });
      window.addEventListener("touchend", stopDraw);

      maskCanvas.addEventListener("mouseleave", () => {
        if (cursor) cursor.style.display = "none";
      });
      maskCanvas.addEventListener("mouseenter", () => {
        if (cursor) cursor.style.display = "block";
      });
    }

    // Window resize observer
    window.addEventListener("resize", () => {
      const modal = document.getElementById("image-inpaint-modal");
      if (modal && modal.style.display === "flex") {
        this._renderInfillStage();
      }
    });
  },

  _updateBrushCursorSize() {
    const cursor = document.getElementById("infill-brush-cursor");
    if (!cursor) return;
    const size = this._infillState.brushSize;
    cursor.style.width = `${size}px`;
    cursor.style.height = `${size}px`;
    cursor.style.marginLeft = `-${size / 2}px`;
    cursor.style.marginTop = `-${size / 2}px`;
  },

  _drawMaskPoint(x, y) {
    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    const radius = this._infillState.brushSize / 2;

    ctx.save();
    if (this._infillState.toolMode === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(239, 68, 68, 0.75)"; // Vibrant semi-transparent highlight
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  },

  _drawMaskLine(x1, y1, x2, y2) {
    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    const radius = this._infillState.brushSize / 2;

    ctx.save();
    if (this._infillState.toolMode === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = this._infillState.brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(239, 68, 68, 0.75)";
      ctx.lineWidth = this._infillState.brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  },

  // Generates image and mask data URLs optimized for provider requirements (avoids 413 payload limits)
  _getInfillPayloadData(isCloudProvider = false) {
    const { img, naturalWidth, naturalHeight } = this._infillState;
    if (!img) return null;

    const maskCanvas = document.getElementById("infill-mask-canvas");
    if (!maskCanvas) return null;

    let targetW = naturalWidth;
    let targetH = naturalHeight;

    // For Cloud APIs (like Nano-GPT / OpenAI), constrain to max 1024 to prevent 413 entity size limits
    if (isCloudProvider && Math.max(targetW, targetH) > 1024) {
      if (targetW >= targetH) {
        targetH = Math.round((targetH * 1024) / targetW);
        targetW = 1024;
      } else {
        targetW = Math.round((targetW * 1024) / targetH);
        targetH = 1024;
      }
    }

    // 1. Generate base image
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = targetW;
    fullCanvas.height = targetH;
    const imgCtx = fullCanvas.getContext("2d");
    imgCtx.drawImage(img, 0, 0, targetW, targetH);

    // High quality JPEG (0.92) is visually lossless and keeps payload ~300-600KB vs 6-8MB for uncompressed PNG
    const imageDataUrl = isCloudProvider 
      ? fullCanvas.toDataURL("image/jpeg", 0.92) 
      : fullCanvas.toDataURL("image/png");

    // 2. Generate black & white mask matching target dimensions
    const fullMaskCanvas = document.createElement("canvas");
    fullMaskCanvas.width = targetW;
    fullMaskCanvas.height = targetH;
    const maskCtx = fullMaskCanvas.getContext("2d");

    // Fill with pure black #000000 (unmasked areas)
    maskCtx.fillStyle = "#000000";
    maskCtx.fillRect(0, 0, targetW, targetH);

    // Create a temporary canvas with pure white strokes
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = maskCanvas.width;
    tempCanvas.height = maskCanvas.height;
    const tempCtx = tempCanvas.getContext("2d");

    const srcData = maskCanvas.getContext("2d").getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const destData = tempCtx.createImageData(maskCanvas.width, maskCanvas.height);
    let paintedPixelCount = 0;

    for (let i = 0; i < srcData.data.length; i += 4) {
      const alpha = srcData.data[i + 3];
      if (alpha > 20) {
        destData.data[i] = 255;     // R
        destData.data[i + 1] = 255; // G
        destData.data[i + 2] = 255; // B
        destData.data[i + 3] = 255; // A
        paintedPixelCount++;
      } else {
        destData.data[i + 3] = 0;
      }
    }

    if (paintedPixelCount === 0) {
      return { maskDataUrl: null, imageDataUrl: null, paintedPixelCount: 0, targetW, targetH };
    }

    tempCtx.putImageData(destData, 0, 0);

    // Draw scaled white mask onto target black canvas
    maskCtx.drawImage(tempCanvas, 0, 0, targetW, targetH);

    const maskDataUrl = fullMaskCanvas.toDataURL("image/png");

    return {
      imageDataUrl,
      maskDataUrl,
      paintedPixelCount,
      targetW,
      targetH,
    };
  },

  async handleApplyInfill() {
    const applyBtn = document.getElementById("infill-apply-btn");
    const saveBtn = document.getElementById("infill-save-btn");
    const statusEl = document.getElementById("infill-status-message");

    try {
      // Read provider override from modal dropdown
      const providerSelect = document.getElementById("infill-modal-provider");
      const chosenProvider = providerSelect?.value || this.config.get("api.image.infill.provider") || "localForge";
      const isCloudProvider = chosenProvider !== "localForge";

      const payloadData = this._getInfillPayloadData(isCloudProvider);

      if (!payloadData || !payloadData.maskDataUrl || payloadData.paintedPixelCount === 0) {
        this.showNotification("Please paint over the logo, text, or object you want to erase first.", "warning");
        return;
      }

      const { imageDataUrl, maskDataUrl, paintedPixelCount, targetW, targetH } = payloadData;

      // Read prompt
      const promptInput = document.getElementById("infill-prompt-input");
      let userPrompt = promptInput?.value?.trim() || "";

      // If user left prompt blank, build a background-continuation hint.
      // IMPORTANT: Do NOT pass the full character imagePrompt verbatim — it contains character
      // descriptions (face, pose, clothing) which cause Forge to hallucinate character content
      // inside the masked region (a corner/logo area). Instead extract only lighting/style/background
      // terms and prepend a strong background-continuation instruction.
      if (!userPrompt) {
        const rawCardPrompt =
          document.getElementById("custom-image-prompt")?.value?.trim() ||
          this.currentCharacter?.imagePrompt ||
          "";

        if (rawCardPrompt) {
          // Strip common character-description tokens: leave background/style/lighting hints
          const characterTerms = /\b(girl|boy|man|woman|male|female|person|character|face|eyes|hair|skin|body|pose|sitting|standing|holding|wearing|outfit|dress|shirt|smile|look|gaze|portrait|bust|full body|anime|realistic|photorealistic|1girl|1boy|solo|nsfw|sfw|nude|breasts|hips|thighs|beautiful|sexy|cute|handsome|looking at viewer|upper body|lower body|hands|arms|legs|feet|fingers|teeth|lips|nose|ear|cheek|forehead|chin|neck|shoulder|chest|waist|belly|back|butt)\b/gi;
          const backgroundHint = rawCardPrompt
            .split(",")
            .map(t => t.trim())
            .filter(t => !characterTerms.test(t) && t.length > 0)
            .join(", ");
          userPrompt = backgroundHint
            ? `seamless background continuation, ${backgroundHint}`
            : "";
        }
      }

      // Set UI loading state
      if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.innerHTML = `
          <span class="loading-spinner" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 0.4rem; border-width: 2px;"></span>
          In-filling...
        `;
      }
      if (saveBtn) saveBtn.style.display = "none"; // hide Save while re-processing
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: var(--accent, #6366f1);">⏳ Processing with ${chosenProvider === "localForge" ? "Local Forge" : "Infill API"}...</span>`;
      }

      console.log(`🎨 Starting In-fill with provider: ${chosenProvider} (${paintedPixelCount} mask pixels, ${targetW}x${targetH})`);

      const resultImageUrl = await this.apiHandler.inpaintImage({
        imageBase64: imageDataUrl,
        maskBase64: maskDataUrl,
        prompt: userPrompt,
        providerOverride: chosenProvider,
        width: targetW,
        height: targetH,
      });

      if (!resultImageUrl) {
        throw new Error("No image was returned from In-fill provider");
      }

      // Store the pending result — not committed to the card until user clicks Save
      this._infillState.pendingResult = resultImageUrl;

      // Reload the canvas with the new result so the user can review / paint another pass
      const resultImg = new Image();
      await new Promise((resolve, reject) => {
        resultImg.onload = resolve;
        resultImg.onerror = () => reject(new Error("Failed to load inpainted result image"));
        resultImg.src = resultImageUrl;
      });
      this._infillState.img = resultImg;
      this._infillState.naturalWidth = resultImg.naturalWidth || targetW;
      this._infillState.naturalHeight = resultImg.naturalHeight || targetH;

      // Re-render stage with the fresh image (also clears the mask ready for another pass)
      this._renderInfillStage();

      // Show Save button and update status
      if (saveBtn) saveBtn.style.display = "inline-flex";
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #22c55e;">✅ Result looks good? Click <strong>Save to Card</strong> — or paint another area and run again.</span>`;
      }
      this.showNotification("✨ In-fill complete — review the result, then Save to Card when ready.", "success");

    } catch (error) {
      console.error("Apply inpaint error:", error);
      this.showNotification(`In-fill failed: ${error.message}`, "error");
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #ef4444;">❌ Error: ${error.message}</span>`;
      }
    } finally {
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.innerHTML = `✨ Remove &amp; In-fill`;
      }
    }
  },

  // Commits the pending inpaint result to the card, saves to library, and closes the modal.
  async saveInfillToCard() {
    const pendingUrl = this._infillState.pendingResult;
    if (!pendingUrl) {
      this.showNotification("Nothing to save yet — run In-fill first.", "warning");
      return;
    }

    const saveBtn = document.getElementById("infill-save-btn");
    const statusEl = document.getElementById("infill-status-message");

    try {
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="loading-spinner" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 0.4rem; border-width: 2px;"></span> Saving...`;
      }

      if (this._infillTarget === 'reference') {
        // Reference image path: no card exists yet, so none of the card-save
        // side effects below apply.
        const dataUrl = await this._urlToDataUrl(pendingUrl);
        this.referenceImageDataUrl = dataUrl;
        this._infillState.pendingResult = null;
        if (typeof this.updateReferenceImagePreview === "function") {
          this.updateReferenceImagePreview(dataUrl);
        }

        this.closeInfillModal();
        this.showNotification("💾 Reference image updated. Re-describing…", "success");
        this.updateCropButtonVisibility();
        this.updateInfillButtonVisibility();

        if (typeof this.apiHandler?.describeReferenceImage === "function") {
          try {
            const descriptionField = document.getElementById("reference-image-description");
            const hint = descriptionField?.value?.trim() || "";
            const imageDescription = await this.apiHandler.describeReferenceImage(dataUrl, hint);
            if (descriptionField) descriptionField.value = imageDescription;
            this.showNotification("Reference image description updated", "success");
          } catch (descErr) {
            console.error("Re-describe after in-fill failed:", descErr);
            this.showNotification(`Could not re-describe image: ${descErr.message}`, "warning");
          }
        }
        return;
      }

      if (this._infillTarget === 'playground') {
        // Playground path: no card, no vision description to keep in sync.
        const dataUrl = await this._urlToDataUrl(pendingUrl);
        this.playgroundImageUrl = dataUrl;
        this._infillState.pendingResult = null;
        if (typeof this.updatePlaygroundImagePreview === "function") {
          this.updatePlaygroundImagePreview(dataUrl);
        }
        if (typeof this._addPlaygroundHistoryEntry === "function") {
          this._addPlaygroundHistoryEntry(dataUrl, "In-filled");
        }

        this.closeInfillModal();
        this.showNotification("💾 Image updated.", "success");
        this.updateCropButtonVisibility();
        this.updateInfillButtonVisibility();
        return;
      }

      // Archive the old image to history so the user can revert
      if (typeof this._archiveCurrentImage === "function") {
        this._archiveCurrentImage();
      }

      // Commit result to card
      this.currentImageUrl = pendingUrl;
      this._infillState.pendingResult = null;

      // Update the main image display
      const imageContainer = document.getElementById("image-content");
      if (imageContainer) {
        imageContainer.innerHTML = `
          <div class="image-container">
            <img src="${this.currentImageUrl}" alt="${this.currentCharacter?.name || "Character"}" class="generated-image">
          </div>
        `;
      }

      this.closeInfillModal();
      this.showNotification("💾 Image saved to card! Previous image archived to History.", "success");

      if (typeof this.saveCardToLibrary === "function") {
        await this.saveCardToLibrary();
      }
      if (typeof this.refreshLibraryViews === "function") {
        await this.refreshLibraryViews();
      }
      if (typeof this.updateImageHistoryButton === "function") {
        this.updateImageHistoryButton();
      }
      this.updateCropButtonVisibility();
      this.updateInfillButtonVisibility();

    } catch (error) {
      console.error("Save inpaint to card error:", error);
      this.showNotification(`Save failed: ${error.message}`, "error");
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #ef4444;">❌ Save error: ${error.message}</span>`;
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `💾 Save to Card`;
      }
    }
  }
});

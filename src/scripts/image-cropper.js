// Image Cropper Capability — extends CharacterGeneratorApp prototype
Object.assign(CharacterGeneratorApp.prototype, {
  _cropState: {
    img: null,
    rotation: 0, // 0, 90, 180, 270
    flipH: false,
    aspectRatio: null, // null (free), 1 (1:1), 3/4 (3:4), 9/16 (9:16), 4/3 (4:3)
    cropBox: { x: 0, y: 0, width: 0, height: 0 },
    stageWidth: 0,
    stageHeight: 0,
    isDragging: false,
    dragType: null, // 'move' or handle name e.g. 'nw', 'se', etc.
    dragStart: { x: 0, y: 0 },
    cropBoxStart: { x: 0, y: 0, width: 0, height: 0 }
  },

  updateCropButtonVisibility() {
    const btn = document.getElementById("crop-image-btn");
    if (btn) {
      if (this.currentImageUrl) {
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
      } else {
        btn.style.display = "none";
      }
    }
    // Reference-image crop button (Character Generation screen, pre-card)
    const refBtn = document.getElementById("crop-reference-image-btn");
    if (refBtn) {
      refBtn.style.display = this.referenceImageDataUrl ? "inline-flex" : "none";
    }
    // Playground crop button (Image Playground tab)
    const pgBtn = document.getElementById("crop-playground-image-btn");
    if (pgBtn) {
      pgBtn.style.display = this.playgroundImageUrl ? "inline-flex" : "none";
    }
  },

  // target: 'card' (default — the current character's portrait, this.currentImageUrl),
  // 'reference' (the not-yet-a-card reference image, this.referenceImageDataUrl,
  // used before generating a character), or 'playground' (the Image Playground
  // tab's working image, this.playgroundImageUrl — no card/character involved
  // at all). Same modal/cropping UI either way — only where the source comes
  // from and where the result gets saved differs (see the branch in applyCrop()).
  async openCropModal(target = 'card') {
    this._cropTarget = target;

    if (target === 'reference') {
      if (!this.referenceImageDataUrl) {
        this.showNotification("No reference image available to crop", "warning");
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
        this.showNotification("No image available to crop", "warning");
        return;
      }
    }

    const modal = document.getElementById("image-crop-modal");
    if (!modal) return;

    this.showNotification("Loading image into cropper...", "info");

    try {
      let imageSrc = target === 'reference' ? this.referenceImageDataUrl
        : target === 'playground' ? this.playgroundImageUrl
        : this.currentImageUrl;

      // If URL is external http(s), convert to Blob URL via proxy to prevent CORS canvas taint
      // (reference images are always local data: URLs, so this only ever applies to 'card')
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
        img.onerror = () => reject(new Error("Failed to load image for cropping"));
        img.src = imageSrc;
      });

      this._cropState.img = img;
      this._cropState.rotation = 0;
      this._cropState.flipH = false;
      this._cropState.aspectRatio = null; // Default to free aspect ratio

      modal.style.display = "flex";

      // Reset aspect ratio selector active states
      document.querySelectorAll(".crop-aspect-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.ratio === "free");
      });

      requestAnimationFrame(() => {
        this._renderCropStage();
      });
      this._initCropListenersOnce();

    } catch (error) {
      console.error("Crop modal error:", error);
      this.showNotification(`Could not open cropper: ${error.message}`, "error");
    }
  },

  closeCropModal() {
    const modal = document.getElementById("image-crop-modal");
    if (modal) {
      modal.style.display = "none";
    }
  },

  _renderCropStage(resetCropBox = true) {
    const { img, rotation, flipH } = this._cropState;
    if (!img) return;

    const workspace = document.getElementById("crop-workspace");
    const canvas = document.getElementById("crop-canvas");
    if (!workspace || !canvas) return;

    const ctx = canvas.getContext("2d");

    // Determine target dimensions considering rotation
    const isRotatedQuarter = (rotation % 180 !== 0);
    const naturalW = isRotatedQuarter ? img.naturalHeight : img.naturalWidth;
    const naturalH = isRotatedQuarter ? img.naturalWidth : img.naturalHeight;

    // Calculate maximum available stage bounds
    const maxW = Math.max(50, (workspace.clientWidth || 300) - 8);
    const maxH = Math.max(50, (workspace.clientHeight || 300) - 8);

    let stageW = naturalW;
    let stageH = naturalH;

    const scale = Math.min(maxW / naturalW, maxH / naturalH);
    stageW = Math.round(naturalW * scale);
    stageH = Math.round(naturalH * scale);

    canvas.width = stageW;
    canvas.height = stageH;

    this._cropState.stageWidth = stageW;
    this._cropState.stageHeight = stageH;

    // Render rotated/flipped image onto stage canvas
    ctx.save();
    ctx.clearRect(0, 0, stageW, stageH);
    ctx.translate(stageW / 2, stageH / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, 1);

    const drawW = isRotatedQuarter ? stageH : stageW;
    const drawH = isRotatedQuarter ? stageW : stageH;

    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    // Position crop stage box
    const stageContainer = document.getElementById("crop-stage");
    if (stageContainer) {
      stageContainer.style.width = `${stageW}px`;
      stageContainer.style.height = `${stageH}px`;
    }

    if (resetCropBox) {
      this._resetCropBoxToDefault();
    } else {
      this._clampCropBox();
      this._updateCropBoxDOM();
    }
  },

  _resetCropBoxToDefault() {
    const { stageWidth, stageHeight, aspectRatio } = this._cropState;
    let w = Math.round(stageWidth * 0.85);
    let h = Math.round(stageHeight * 0.85);

    if (aspectRatio) {
      if (w / h > aspectRatio) {
        w = Math.round(h * aspectRatio);
      } else {
        h = Math.round(w / aspectRatio);
      }
    }

    const x = Math.round((stageWidth - w) / 2);
    const y = Math.round((stageHeight - h) / 2);

    this._cropState.cropBox = { x, y, width: w, height: h };
    this._updateCropBoxDOM();
  },

  _clampCropBox() {
    const { stageWidth, stageHeight, aspectRatio } = this._cropState;
    let { x, y, width, height } = this._cropState.cropBox;

    width = Math.min(width, stageWidth);
    height = Math.min(height, stageHeight);

    if (aspectRatio) {
      if (width / height > aspectRatio) {
        width = Math.round(height * aspectRatio);
      } else {
        height = Math.round(width / aspectRatio);
      }
    }

    x = Math.max(0, Math.min(stageWidth - width, x));
    y = Math.max(0, Math.min(stageHeight - height, y));

    this._cropState.cropBox = { x, y, width, height };
  },

  _updateCropBoxDOM() {
    const { x, y, width, height } = this._cropState.cropBox;
    const { stageWidth, stageHeight } = this._cropState;

    const cropBoxEl = document.getElementById("crop-box");
    if (cropBoxEl) {
      cropBoxEl.style.left = `${x}px`;
      cropBoxEl.style.top = `${y}px`;
      cropBoxEl.style.width = `${width}px`;
      cropBoxEl.style.height = `${height}px`;
    }

    // Update dark backdrop masks around crop box
    const maskTop = document.getElementById("crop-mask-top");
    const maskBottom = document.getElementById("crop-mask-bottom");
    const maskLeft = document.getElementById("crop-mask-left");
    const maskRight = document.getElementById("crop-mask-right");

    if (maskTop) {
      maskTop.style.top = "0px";
      maskTop.style.height = `${y}px`;
    }
    if (maskBottom) {
      maskBottom.style.top = `${y + height}px`;
      maskBottom.style.height = `${Math.max(0, stageHeight - (y + height))}px`;
    }
    if (maskLeft) {
      maskLeft.style.top = `${y}px`;
      maskLeft.style.height = `${height}px`;
      maskLeft.style.width = `${x}px`;
    }
    if (maskRight) {
      maskRight.style.top = `${y}px`;
      maskRight.style.height = `${height}px`;
      maskRight.style.left = `${x + width}px`;
      maskRight.style.width = `${Math.max(0, stageWidth - (x + width))}px`;
    }
  },

  _initCropListenersOnce() {
    if (this._cropListenersInitialized) return;
    this._cropListenersInitialized = true;

    const cropStage = document.getElementById("crop-stage");
    const cropBox = document.getElementById("crop-box");
    const modal = document.getElementById("image-crop-modal");

    // Close button & cancel
    document.getElementById("image-crop-close-btn")?.addEventListener("click", () => this.closeCropModal());
    document.getElementById("crop-cancel-btn")?.addEventListener("click", () => this.closeCropModal());
    document.getElementById("crop-apply-btn")?.addEventListener("click", () => this.applyCrop());

    window.addEventListener("resize", () => {
      const cropModal = document.getElementById("image-crop-modal");
      if (cropModal && cropModal.style.display !== "none") {
        this._renderCropStage(false);
      }
    });

    // Aspect ratio buttons
    document.getElementById("crop-aspect-buttons")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".crop-aspect-btn");
      if (!btn) return;

      document.querySelectorAll(".crop-aspect-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const ratioAttr = btn.dataset.ratio;
      if (ratioAttr === "free") {
        this._cropState.aspectRatio = null;
      } else if (ratioAttr === "1:1") {
        this._cropState.aspectRatio = 1;
      } else if (ratioAttr === "3:4") {
        this._cropState.aspectRatio = 3 / 4;
      } else if (ratioAttr === "9:16") {
        this._cropState.aspectRatio = 9 / 16;
      } else if (ratioAttr === "4:3") {
        this._cropState.aspectRatio = 4 / 3;
      }
      this._resetCropBoxToDefault();
    });

    // Rotate button
    document.getElementById("crop-rotate-btn")?.addEventListener("click", () => {
      this._cropState.rotation = (this._cropState.rotation + 90) % 360;
      this._renderCropStage(true);
    });

    // Flip button
    document.getElementById("crop-flip-btn")?.addEventListener("click", () => {
      this._cropState.flipH = !this._cropState.flipH;
      this._renderCropStage(false);
    });

    // Reset button
    document.getElementById("crop-reset-btn")?.addEventListener("click", () => {
      this._cropState.rotation = 0;
      this._cropState.flipH = false;
      this._cropState.aspectRatio = null;
      document.querySelectorAll(".crop-aspect-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.ratio === "free");
      });
      this._renderCropStage(true);
    });

    // Pointer event dragging for crop box and handles
    const onPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return; // Only primary click
      const handleEl = e.target.closest(".crop-handle");
      const boxEl = e.target.closest("#crop-box");

      if (!handleEl && !boxEl) return;

      e.preventDefault();
      e.stopPropagation();

      this._cropState.isDragging = true;
      this._cropState.dragType = handleEl ? handleEl.dataset.handle : "move";
      this._cropState.dragStart = { x: e.clientX, y: e.clientY };
      this._cropState.cropBoxStart = { ...this._cropState.cropBox };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!this._cropState.isDragging) return;

      const dx = e.clientX - this._cropState.dragStart.x;
      const dy = e.clientY - this._cropState.dragStart.y;
      const { stageWidth, stageHeight, aspectRatio, dragType, cropBoxStart } = this._cropState;

      let { x, y, width, height } = cropBoxStart;

      if (dragType === "move") {
        x = Math.max(0, Math.min(stageWidth - width, cropBoxStart.x + dx));
        y = Math.max(0, Math.min(stageHeight - height, cropBoxStart.y + dy));
      } else {
        // Handle resizing
        const minSize = 30;

        if (dragType.includes("e")) {
          width = Math.max(minSize, Math.min(stageWidth - cropBoxStart.x, cropBoxStart.width + dx));
        }
        if (dragType.includes("s")) {
          height = Math.max(minSize, Math.min(stageHeight - cropBoxStart.y, cropBoxStart.height + dy));
        }
        if (dragType.includes("w")) {
          const possibleW = cropBoxStart.width - dx;
          if (possibleW >= minSize) {
            const newX = Math.max(0, cropBoxStart.x + dx);
            width = cropBoxStart.width + (cropBoxStart.x - newX);
            x = newX;
          }
        }
        if (dragType.includes("n")) {
          const possibleH = cropBoxStart.height - dy;
          if (possibleH >= minSize) {
            const newY = Math.max(0, cropBoxStart.y + dy);
            height = cropBoxStart.height + (cropBoxStart.y - newY);
            y = newY;
          }
        }

        // Apply aspect ratio constraints if locked
        if (aspectRatio) {
          if (dragType === "e" || dragType === "w") {
            height = Math.round(width / aspectRatio);
          } else {
            width = Math.round(height * aspectRatio);
          }
          // Enforce stage limits with aspect ratio
          if (x + width > stageWidth) width = stageWidth - x;
          if (y + height > stageHeight) height = stageHeight - y;
        }
      }

      this._cropState.cropBox = { x, y, width, height };
      this._updateCropBoxDOM();
    };

    const onPointerUp = () => {
      this._cropState.isDragging = false;
      this._cropState.dragType = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    cropStage?.addEventListener("pointerdown", onPointerDown);
  },

  async applyCrop() {
    const { img, rotation, flipH, cropBox, stageWidth, stageHeight } = this._cropState;
    if (!img || !stageWidth || !stageHeight) return;

    this.showNotification("Processing crop...", "info");

    try {
      // Create offscreen canvas for high-res source rendering
      const isRotatedQuarter = (rotation % 180 !== 0);
      const naturalW = isRotatedQuarter ? img.naturalHeight : img.naturalWidth;
      const naturalH = isRotatedQuarter ? img.naturalWidth : img.naturalHeight;

      // Scale between stage displayed px and full image natural px
      const scaleX = naturalW / stageWidth;
      const scaleY = naturalH / stageHeight;

      const cropX = Math.round(cropBox.x * scaleX);
      const cropY = Math.round(cropBox.y * scaleY);
      const cropW = Math.round(cropBox.width * scaleX);
      const cropH = Math.round(cropBox.height * scaleY);

      // Render full rotated/flipped image to intermediary canvas
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = naturalW;
      fullCanvas.height = naturalH;
      const fullCtx = fullCanvas.getContext("2d");

      fullCtx.save();
      fullCtx.translate(naturalW / 2, naturalH / 2);
      fullCtx.rotate((rotation * Math.PI) / 180);
      fullCtx.scale(flipH ? -1 : 1, 1);

      const drawW = isRotatedQuarter ? naturalH : naturalW;
      const drawH = isRotatedQuarter ? naturalW : naturalH;

      fullCtx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
      fullCtx.restore();

      // Extract cropped region onto final canvas
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropW;
      cropCanvas.height = cropH;
      const cropCtx = cropCanvas.getContext("2d");

      cropCtx.drawImage(
        fullCanvas,
        cropX, cropY, cropW, cropH,
        0, 0, cropW, cropH
      );

      if (this._cropTarget === 'reference') {
        // Reference image path: no card exists yet, so none of the card-save
        // side effects below apply. Needs a real data: URL (not a blob: URL)
        // since it gets re-sent to the vision model for re-description.
        const dataUrl = cropCanvas.toDataURL("image/png");
        this.referenceImageDataUrl = dataUrl;
        if (typeof this.updateReferenceImagePreview === "function") {
          this.updateReferenceImagePreview(dataUrl);
        }

        this.closeCropModal();
        this.showNotification("Reference image cropped. Re-describing…", "success");
        this.updateCropButtonVisibility();
        if (typeof this.updateInfillButtonVisibility === "function") {
          this.updateInfillButtonVisibility();
        }

        // Re-run the vision description so it matches the edited image —
        // same call used when a reference image is first uploaded/pasted.
        if (typeof this.apiHandler?.describeReferenceImage === "function") {
          try {
            const descriptionField = document.getElementById("reference-image-description");
            const hint = descriptionField?.value?.trim() || "";
            const imageDescription = await this.apiHandler.describeReferenceImage(dataUrl, hint);
            if (descriptionField) descriptionField.value = imageDescription;
            this.showNotification("Reference image description updated", "success");
          } catch (descErr) {
            console.error("Re-describe after crop failed:", descErr);
            this.showNotification(`Could not re-describe image: ${descErr.message}`, "warning");
          }
        }
        return;
      }

      if (this._cropTarget === 'playground') {
        // Playground path: no card, no vision description to keep in sync — just
        // update the working image and its preview.
        const dataUrl = cropCanvas.toDataURL("image/png");
        this.playgroundImageUrl = dataUrl;
        if (typeof this.updatePlaygroundImagePreview === "function") {
          this.updatePlaygroundImagePreview(dataUrl);
        }
        if (typeof this._addPlaygroundHistoryEntry === "function") {
          this._addPlaygroundHistoryEntry(dataUrl, "Cropped");
        }
        this.closeCropModal();
        this.showNotification("Image cropped!", "success");
        this.updateCropButtonVisibility();
        if (typeof this.updateInfillButtonVisibility === "function") {
          this.updateInfillButtonVisibility();
        }
        return;
      }

      // Convert cropped canvas to PNG Blob
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Failed to generate cropped image blob");

      // Archive current image so user can undo/restore via History
      if (typeof this._archiveCurrentImage === "function") {
        this._archiveCurrentImage();
      }

      // Update current image URL
      const newUrl = URL.createObjectURL(blob);
      this.currentImageUrl = newUrl;

      // Update `#image-content` container in DOM
      const imageContainer = document.getElementById("image-content");
      if (imageContainer) {
        imageContainer.innerHTML = `
          <div class="image-container">
            <img src="${this.currentImageUrl}" alt="${this.currentCharacter?.name || "Character"}" class="generated-image">
          </div>
        `;
      }

      this.closeCropModal();
      this.showNotification("Character image cropped successfully!", "success");

      // Save to library and refresh views
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
      if (typeof this.updateInfillButtonVisibility === "function") {
        this.updateInfillButtonVisibility();
      }

    } catch (error) {
      console.error("Apply crop error:", error);
      this.showNotification(`Failed to crop image: ${error.message}`, "error");
    }
  }
});

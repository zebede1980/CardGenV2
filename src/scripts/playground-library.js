// Playground Image Library — the images the user chose to keep from the Image
// Playground, held on the server rather than downloaded to whichever device
// happened to be in hand. Saving used to mean a browser download, which meant
// an image made on a phone was stranded there; these live under the account, so
// the same pile is there on every device.
//
// Storage mirrors the character gallery (see character-gallery-panel.js and the
// /api/storage/playground-images routes): a row in the database for the
// metadata, the bytes on the proxy's disk, and an authenticated URL per image.
Object.assign(CharacterGeneratorApp.prototype, {

  // Images are behind requireAuth, and an <img> tag cannot send an
  // Authorization header — hence the ?token=, exactly as the character gallery
  // does it.
  _playgroundLibraryImageUrl(row) {
    const token = window.cardgenAuth?.getToken() || localStorage.getItem("cardgen_auth_token") || "";
    return `${row.url}?token=${encodeURIComponent(token)}`;
  },

  // Fetched through authFetch rather than by pointing _urlToDataUrl at the URL:
  // that helper sends anything non-data/blob through /api/proxy-image, which is
  // for fetching *other people's* servers, not our own authenticated routes.
  async _playgroundLibraryDataUrl(row) {
    const res = await (window.authFetch || fetch)(row.url);
    if (!res.ok) throw new Error(`Could not load the image (${res.status})`);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error("Could not read the image"));
      reader.readAsDataURL(blob);
    });
  },

  // Saves whatever is passed as a data URL. Used by the 💾 on each history
  // thumbnail and by the Save button under the working image.
  async savePlaygroundImageToLibrary(dataUrl, label = "", promptOverride = undefined) {
    if (!dataUrl) return null;
    if (!this.storage?.savePlaygroundImage) {
      this.showNotification("Image library is unavailable", "error");
      return null;
    }
    try {
      // The prompt/instruction that produced it is the one bit of context worth
      // keeping — a grid of faces with no idea how any of them was made is a
      // much less useful pile than one you can read back.
      const prompt = promptOverride !== undefined && promptOverride !== null
        ? promptOverride
        : this._playgroundPromptForLabel(label);
      const row = await this.storage.savePlaygroundImage(dataUrl, { label, prompt });
      this.showNotification("Saved to your image library", "success");
      // Only refresh what is on screen; the library tab renders from scratch
      // each time it is opened anyway.
      if (this._pgActiveTab === "library") this.renderPlaygroundLibrary();
      return row;
    } catch (error) {
      console.error("Playground library save failed:", error);
      this.showNotification(`Save failed: ${error.message}`, "error", 6000);
      return null;
    }
  },

  // Best guess at the text behind an image, from whichever Playground panel
  // made it — the label ("Generated (…)", "Edited (…)", "Combined (…)") says
  // which box to read.
  _playgroundPromptForLabel(label) {
    const from = (id) => document.getElementById(id)?.value?.trim() || "";
    if (label.startsWith("Generated")) return from("playground-generate-prompt");
    if (label.startsWith("Edited")) return from("playground-edit-instruction");
    if (label.startsWith("Combined")) return from("playground-combine-instruction");
    if (label.startsWith("Enhanced")) return from("playground-upscale-instruction");
    return "";
  },

  async renderPlaygroundLibrary() {
    const grid = document.getElementById("playground-library-grid");
    const status = document.getElementById("playground-library-status");
    if (!grid) return;

    if (status) {
      status.style.display = "block";
      status.style.color = "";
      status.textContent = "Loading your saved images…";
    }

    let rows;
    try {
      rows = await (this.storage?.listPlaygroundImages?.() ?? []);
    } catch (error) {
      // A failed load must never look like an empty library — see
      // listPlaygroundImages in storage.js. Offers a retry rather than leaving
      // the tab stuck, since the usual cause is a flaky mobile connection.
      console.error("Playground library load failed:", error);
      grid.innerHTML = "";
      this._playgroundLibraryRows = [];
      if (status) {
        status.style.display = "block";
        status.style.color = "var(--error)";
        status.textContent = `Could not load your library: ${error.message}. `;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn-small";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => this.renderPlaygroundLibrary());
        status.appendChild(retry);
      }
      return;
    }

    this._playgroundLibraryRows = rows;
    grid.innerHTML = "";

    if (status) {
      if (rows.length === 0) {
        status.style.display = "block";
        status.textContent = "Nothing saved yet. Use 💾 on an image in the Playground to keep it here.";
        return;
      }
      status.style.display = "none";
    }

    rows.forEach((row, index) => grid.appendChild(this._buildPlaygroundLibraryTile(row, index)));
  },

  _buildPlaygroundLibraryTile(row, index) {
    const url = this._playgroundLibraryImageUrl(row);
    const when = row.createdAt ? new Date(row.createdAt).toLocaleString() : "";
    const caption = [row.label, when].filter(Boolean).join(" · ");

    const tile = document.createElement("div");
    tile.style.cssText = `
      border: 1px solid var(--border); border-radius: 0.6rem; overflow: hidden;
      display: flex; flex-direction: column;
    `;
    tile.innerHTML = `
      <div data-pg-view style="cursor: zoom-in; aspect-ratio: 1 / 1; overflow: hidden;">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(row.label || "Saved image")}" loading="lazy"
             style="width: 100%; height: 100%; object-fit: cover; display: block;">
      </div>
      <div style="padding: 0.4rem 0.5rem; font-size: 0.7rem; color: var(--text-secondary); word-break: break-word;">
        ${escapeHtml(caption)}
      </div>
      ${row.prompt ? `<div title="${escapeHtml(row.prompt)}" style="padding: 0 0.5rem 0.4rem; font-size: 0.7rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(row.prompt)}</div>` : ""}
      <div style="display: flex; gap: 0.25rem; padding: 0 0.4rem 0.45rem; flex-wrap: wrap; margin-top: auto;">
        <button type="button" data-pg-reopen class="btn-small" title="Bring this back into the Playground as the working image">✏️ Edit</button>
        <button type="button" data-pg-newchar class="btn-small" title="Start a new character from this image">🎭 New character</button>
        <button type="button" data-pg-download class="btn-small" title="Download to this device">⬇</button>
        <button type="button" data-pg-delete class="btn-small" title="Delete from your library">🗑️</button>
      </div>
    `;

    tile.querySelector("[data-pg-view]")?.addEventListener("click", () => this.openPlaygroundLibraryViewer(index));
    tile.querySelector("[data-pg-reopen]")?.addEventListener("click", () => this.reopenPlaygroundLibraryImage(row));
    tile.querySelector("[data-pg-newchar]")?.addEventListener("click", () => this.sendPlaygroundImageToNewCharacter(row));
    tile.querySelector("[data-pg-download]")?.addEventListener("click", () => this.downloadPlaygroundLibraryImage(row));
    tile.querySelector("[data-pg-delete]")?.addEventListener("click", () => this.deletePlaygroundLibraryImage(row));
    return tile;
  },

  // Full-screen viewing reuses the app's existing lightbox, which already has
  // zoom, keyboard/swipe navigation and a download button — see openGallery().
  openPlaygroundLibraryViewer(startIndex = 0) {
    const rows = this._playgroundLibraryRows || [];
    if (rows.length === 0) return;
    const images = rows.map((row) => ({ id: row.id, url: this._playgroundLibraryImageUrl(row) }));
    this.openGallery(images, startIndex, "playgroundLibrary");
  },

  downloadPlaygroundLibraryImage(row) {
    const a = document.createElement("a");
    a.href = this._playgroundLibraryImageUrl(row);
    a.download = `playground-image-${row.id}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.showNotification("Image download started", "info");
  },

  async deletePlaygroundLibraryImage(row) {
    if (!confirm("Delete this image from your library? This cannot be undone.")) return;
    try {
      await this.storage.deletePlaygroundImage(row.id);
      this.showNotification("Image deleted", "success");
      await this.renderPlaygroundLibrary();
    } catch (error) {
      console.error("Playground library delete failed:", error);
      this.showNotification(`Delete failed: ${error.message}`, "error", 6000);
    }
  },

  // Puts a saved image back on the workbench. Until this existed the library
  // was a one-way door — an image could start a new *character* but could not be
  // picked up and edited further, so "come back to this tomorrow and keep
  // working on it" meant re-downloading and re-uploading it by hand.
  //
  // Loads it as the working image exactly as an upload does, history reset,
  // seeded with the prompt that made it so ↻ still works on it.
  async reopenPlaygroundLibraryImage(row) {
    if (this.playgroundImageUrl && !confirm("Replace the current Playground image? Versions you have not saved will be lost.")) {
      return;
    }

    let dataUrl;
    try {
      dataUrl = await this._playgroundLibraryDataUrl(row);
    } catch (error) {
      console.error("Playground library → workbench failed:", error);
      this.showNotification(`Could not load that image: ${error.message}`, "error", 6000);
      return;
    }

    this.playgroundImageUrl = dataUrl;
    this.updatePlaygroundImagePreview(dataUrl);
    if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();

    this.playgroundHistory = [];
    this._addPlaygroundHistoryEntry(
      dataUrl,
      row.label || "From library",
      row.prompt ? { tool: "edit", model: "", prompt: row.prompt } : null,
    );

    this._setPlaygroundToolTab("edit");
    this.showNotification("Loaded into the Playground.", "success");
  },

  // The point of the library: a saved image becomes the starting point for a
  // brand-new character. Clears whatever is on the Character Generator screen,
  // drops the image in as the reference image, and runs the same vision pass an
  // upload would have — so by the time the user is looking at the tab, the
  // description field is already filling itself in.
  async sendPlaygroundImageToNewCharacter(row) {
    if (!confirm("Start a new character from this image? Anything unsaved on the Character Generator screen will be cleared.")) {
      return;
    }

    let dataUrl;
    try {
      dataUrl = await this._playgroundLibraryDataUrl(row);
    } catch (error) {
      console.error("Playground library → new character failed:", error);
      this.showNotification(`Could not load that image: ${error.message}`, "error", 6000);
      return;
    }

    // Clicking the real tab button rather than toggling display by hand: every
    // other view hangs its own show/hide listeners off these buttons (see
    // initPlaygroundTab), so this is what keeps them all in agreement.
    document.getElementById("tab-cardgen")?.click();
    if (typeof this.resetCharacterForm === "function") this.resetCharacterForm();

    try {
      await this.applyReferenceImageDataUrl(dataUrl);
    } catch (error) {
      console.error("Reference image analysis failed:", error);
      this.showNotification(`Reference image analysis failed: ${error.message}`, "warning", 6000);
    }
  },

});

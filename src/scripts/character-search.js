// Character Search Module — web search augmentation for character generation
// Delegates to proxy server which uses Brave Search API
class CharacterSearch {
  constructor() {
    this.apiHandler = null;
    this.lastSearchResults = null;
    this.searchEnabled = true;
    this.searchInProgress = false;
  }

  get apiHandlerInstance() {
    if (!this.apiHandler) this.apiHandler = window.apiHandler;
    return this.apiHandler;
  }

  /**
   * Toggle search on/off from UI
   */
  setEnabled(enabled) {
    this.searchEnabled = enabled;
  }

  /**
   * Generate a character with optional web search augmentation.
   * Falls back to normal generation if search fails or is disabled.
   */
  async generateCharacter(concept, characterName, onStream, pov, lorebook, cardType) {
    const shouldSearch = this.searchEnabled && !this._isGenericConcept(concept);

    if (!shouldSearch) {
      // Normal generation path — no search
      const charGen = window.characterGenerator;
      return charGen.generateCharacter(concept, characterName, onStream, pov, lorebook, cardType);
    }

    // Determine the search name: use characterName if provided, else extract from concept
    const searchName = characterName || this._extractNameFromConcept(concept);

    if (!searchName || searchName.length < 2) {
      // Can't meaningfully search — fall back
      const charGen = window.characterGenerator;
      return charGen.generateCharacter(concept, characterName, onStream, pov, lorebook, cardType);
    }

    try {
      this.searchInProgress = true;
      this._updateSearchStatus("🔍 Searching web for details...", "searching");

      const isFictional = this._detectIfFictional(concept);
      const searchResults = await this._performSearch(searchName, isFictional);
      this.lastSearchResults = searchResults;
      this.searchInProgress = false;

      if (searchResults) {
        // Build augmented concept and use search-aware generation
        const augmentedConcept = this._buildAugmentedConcept(concept, searchResults);
        this._updateSearchStatus("✅ Details found — generating accurate character", "found");
        return await this.apiHandlerInstance.generateCharacterWithSearch(
          augmentedConcept,
          characterName,
          searchResults,
          onStream,
          pov,
          lorebook,
          cardType,
        );
      } else {
        this._updateSearchStatus("⚠️ No details found — generating from concept only", "not-found");
      }
    } catch (error) {
      this.searchInProgress = false;
      console.warn("Web search failed, falling back to normal generation:", error);
      this._updateSearchStatus("⚠️ Search unavailable — generating from concept", "error");
    }

    // Fallback path
    const charGen = window.characterGenerator;
    return charGen.generateCharacter(concept, characterName, onStream, pov, lorebook, cardType);
  }

  /**
   * Heuristic: is this a generic concept ("a stoic blacksmith") vs a specific person/character?
   */
  _isGenericConcept(concept) {
    const trimmed = concept.trim().toLowerCase();
    const genericPatterns = [
      /^a\s+/,           // "a stoic blacksmith"
      /^an\s+/,          // "an elven archer"
      /^create\s+/i,     // "create a wizard"
      /^generate\s+/i,
      /^make\s+/i,
      /^build\s+/i,
      /^design\s+/i,
    ];
    return genericPatterns.some((p) => p.test(trimmed));
  }

  /**
   * Try to extract a name from the concept if no explicit name given
   */
  _extractNameFromConcept(concept) {
    const trimmed = concept.trim();
    // "Tony Stark from Iron Man" -> "Tony Stark"
    const fromMatch = trimmed.match(/^(.+?)\s+from\s+/i);
    if (fromMatch) return fromMatch[1].trim();
    // "the character John Wick" -> "John Wick"
    const charMatch = trimmed.match(/(?:character|person|named?)\s+[""]?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)[""]?/i);
    if (charMatch) return charMatch[1].trim();
    // Just take first 2-3 words as potential name
    const words = trimmed.split(/\s+/);
    return words.slice(0, 3).join(" ");
  }

  /**
   * Heuristic: does the concept mention a work of fiction?
   */
  _detectIfFictional(concept) {
    const fictionIndicators = [
      /\bfrom\b/i, /\bmovie\b/i, /\bfilm\b/i, /\bseries\b/i,
      /\bshow\b/i, /\banime\b/i, /\bgame\b/i, /\bbook\b/i,
      /\bnovel\b/i, /\bcomic\b/i, /\bmarvel\b/i, /\bdc\b/i,
      /\bcharacter\b/i, /\bplayed\s+by\b/i, /\bportrayed\b/i,
      /\bactor\b/i, /\bactress\b/i, /\bfictional\b/i,
    ];
    return fictionIndicators.some((p) => p.test(concept));
  }

  async _performSearch(name, isFictional) {
    const authToken = window.cardgenAuth ? window.cardgenAuth.getToken() : "";
    const response = await fetch("/api/search/character", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name, isFictional }),
    });
    if (!response.ok) {
      if (response.status === 503) {
        console.warn("[CharSearch] Search not configured on server");
      }
      return null;
    }
    const data = await response.json();
    if (!data.success || !data.results) {
      return null;
    }
    return data.results;
  }

  _buildAugmentedConcept(originalConcept, searchResults) {
    let augmented = originalConcept;
    augmented += "\n\n[The following verified details about this person/character were found via web search. Use them to ensure accuracy.]\n";
    if (searchResults.biographical) augmented += `\nBIOGRAPHY:\n${searchResults.biographical}`;
    if (searchResults.appearance) augmented += `\nPHYSICAL APPEARANCE:\n${searchResults.appearance}`;
    if (searchResults.personality) augmented += `\nPERSONALITY:\n${searchResults.personality}`;
    if (searchResults.keyFacts) augmented += `\nKEY FACTS:\n${searchResults.keyFacts}`;
    return augmented;
  }

  _updateSearchStatus(text, statusClass) {
    const el = document.getElementById("search-status");
    if (!el) return;
    el.textContent = text;
    el.style.display = "inline-flex";
    el.className = statusClass;
    // Auto-hide success/info messages after 5 seconds
    if (statusClass === "found" || statusClass === "not-found") {
      if (this._statusTimeout) clearTimeout(this._statusTimeout);
      this._statusTimeout = setTimeout(() => {
        el.style.display = "none";
      }, 5000);
    }
  }
}

// Attach to window
window.characterSearch = new CharacterSearch();

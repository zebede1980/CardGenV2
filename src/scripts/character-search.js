// Character Search Module — web search augmentation for character generation
// Delegates to proxy server which uses Brave Search API
class CharacterSearch {
  constructor() {
    this.apiHandler = null;
    this.lastSearchResults = null;
    this.searchInProgress = false;
  }

  get apiHandlerInstance() {
    if (!this.apiHandler) this.apiHandler = window.apiHandler;
    return this.apiHandler;
  }

  /**
   * Generate a character with web search augmentation.
   * @param {string} searchName — the person/character to search for (e.g. "Ellen Ripley from Alien")
   * @param {string} scenario — optional user-provided scenario. If blank, LLM generates one from search results.
   * @param {string} characterName — optional fixed character name
   * @param {function} onStream — streaming callback
   * @param {string} pov — "first" or "third"
   * @param {object} lorebook — optional lorebook data
   * @param {string} cardType — "single", "group", or "scenario"
   */
  async generateCharacter(searchName, scenario, characterName, onStream, pov, lorebook, cardType) {
    if (!searchName || searchName.length < 2) {
      // No meaningful search term — fall back to normal generation with scenario as concept
      const charGen = window.characterGenerator;
      const concept = scenario || searchName || "";
      return charGen.generateCharacter(concept, characterName, onStream, pov, lorebook, cardType);
    }

    try {
      this.searchInProgress = true;
      this._updateSearchStatus("🔍 Searching web for details...", "searching");

      const isFictional = this._detectIfFictional(searchName);
      const searchResults = await this._performSearch(searchName, isFictional);
      this.lastSearchResults = searchResults;
      this.searchInProgress = false;

      if (searchResults) {
        this._updateSearchStatus("✅ Details found — generating accurate character", "found");

        // Build concept: search results + optional scenario (not searched)
        const augmentedConcept = this._buildAugmentedConcept(searchName, scenario, searchResults);

        const rawCharacter = await this.apiHandlerInstance.generateCharacterWithSearch(
          augmentedConcept,
          characterName,
          searchResults,
          onStream,
          pov,
          lorebook,
          cardType,
        );
        return window.characterGenerator.parseCharacterData(rawCharacter);
      } else {
        this._updateSearchStatus("⚠️ No details found — generating from context only", "not-found");
      }
    } catch (error) {
      this.searchInProgress = false;
      console.warn("Web search failed, falling back to normal generation:", error);
      this._updateSearchStatus("⚠️ Search unavailable — generating from context", "error");
    }

    // Fallback path — use scenario as concept if available
    const charGen = window.characterGenerator;
    const fallbackConcept = scenario || searchName || "";
    return charGen.generateCharacter(fallbackConcept, characterName, onStream, pov, lorebook, cardType);
  }

  /**
   * Heuristic: does the search name mention a work of fiction?
   */
  _detectIfFictional(name) {
    const fictionIndicators = [
      /\bfrom\b/i, /\bmovie\b/i, /\bfilm\b/i, /\bseries\b/i,
      /\bshow\b/i, /\banime\b/i, /\bgame\b/i, /\bbook\b/i,
      /\bnovel\b/i, /\bcomic\b/i, /\bmarvel\b/i, /\bdc\b/i,
      /\bcharacter\b/i, /\bplayed\s+by\b/i, /\bportrayed\b/i,
      /\bactor\b/i, /\bactress\b/i, /\bfictional\b/i,
    ];
    return fictionIndicators.some((p) => p.test(name));
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

  _buildAugmentedConcept(searchName, scenario, searchResults) {
    let augmented = `Character: ${searchName}`;
    augmented += "\n\n[The following verified details about this person/character were found via web search. Use them to ensure accuracy.]\n";
    if (searchResults.biographical) augmented += `\nBIOGRAPHY:\n${searchResults.biographical}`;
    if (searchResults.appearance) augmented += `\nPHYSICAL APPEARANCE:\n${searchResults.appearance}`;
    if (searchResults.personality) augmented += `\nPERSONALITY:\n${searchResults.personality}`;
    if (searchResults.keyFacts) augmented += `\nKEY FACTS:\n${searchResults.keyFacts}`;

    // Append user-provided scenario — this is NOT web-searched, just passed through
    if (scenario && scenario.trim()) {
      augmented += `\n\nSCENARIO / CONTEXT (provided by user — DO NOT change this):\n${scenario.trim()}`;
    }

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

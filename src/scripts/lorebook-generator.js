// Lorebook Generator Module
class LorebookGenerator {
    constructor() {
        this.apiHandler = null;
    }

    get apiHandlerInstance() {
        if (!this.apiHandler) {
            this.apiHandler = window.apiHandler;
        }
        return this.apiHandler;
    }

    async suggestTopics(character, existingEntries = []) {
        if (!character) {
            throw new Error("A character object is required to suggest topics.");
        }
        return await this.apiHandlerInstance.suggestLorebookTopics(character, existingEntries);
    }

    // Writes a new entry when existingContent is empty, otherwise improves
    // the existing text following the instruction.
    async writeEntryContent(character, keywords, options = {}) {
        if (!character || !keywords) {
            throw new Error("Character and keywords are required to write entry content.");
        }
        return await this.apiHandlerInstance.writeLorebookEntry(character, keywords, options);
    }
}

window.lorebookGenerator = new LorebookGenerator();
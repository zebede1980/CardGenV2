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

    async suggestTopics(character) {
        if (!character) {
            throw new Error("A character object is required to suggest topics.");
        }
        return await this.apiHandlerInstance.suggestLorebookTopics(character);
    }

    async generateEntryContent(character, keywords, hint = "") {
        if (!character || !keywords) {
            throw new Error("Character and keywords are required to generate entry content.");
        }
        return await this.apiHandlerInstance.generateLorebookEntry(character, keywords, hint);
    }

    async updateEntryContent(character, keywords, existingContent, instruction) {
        if (!character || !keywords || !existingContent || !instruction) {
            throw new Error("Character, keywords, existing content, and an instruction are required to update an entry.");
        }
        return await this.apiHandlerInstance.updateLorebookEntry(character, keywords, existingContent, instruction);
    }
}

window.lorebookGenerator = new LorebookGenerator();
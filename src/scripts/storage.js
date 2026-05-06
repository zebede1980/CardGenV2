// Server-side storage via proxy for prompts and generated cards
class CharacterStorage {
  constructor() {
    this.baseUrl = "";
  }

  async init() {
    return true; // Keep API consistent
  }

  async blobToBase64(blob) {
    if (!blob) return null;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async base64ToBlob(base64) {
    if (!base64) return null;
    try {
      const res = await fetch(base64);
      return await res.blob();
    } catch (e) {
      console.error("Failed to convert base64 to blob", e);
      return null;
    }
  }

  withTimestamps(record) {
    const now = new Date().toISOString();
    const createdAt = record.createdAt || now;
    return {
      ...record,
      createdAt,
      updatedAt: now,
    };
  }

  async savePrompt(promptRecord) {
    const record = this.withTimestamps(promptRecord);
    const res = await fetch(`${this.baseUrl}/api/storage/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    });
    if (!res.ok) throw new Error("Failed to save prompt to server");
    return await res.json();
  }

  async listPrompts() {
    try {
      const res = await fetch(`${this.baseUrl}/api/storage/prompts`);
      if (!res.ok) return [];
      const rows = await res.json();
      return rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (e) {
      console.error("Failed to list prompts from server:", e);
      return [];
    }
  }

  async getPrompt(id) {
    const res = await fetch(`${this.baseUrl}/api/storage/prompts/${id}`);
    if (!res.ok) return null;
    return await res.json();
  }

  async deletePrompt(id) {
    await fetch(`${this.baseUrl}/api/storage/prompts/${id}`, { method: "DELETE" });
  }

  async saveCard(cardRecord) {
    const recordToSave = this.withTimestamps(cardRecord);
    
    // Extract image blob to transport it over JSON via base64 safely
    if (recordToSave.imageBlob instanceof Blob) {
      recordToSave.imageBase64 = await this.blobToBase64(recordToSave.imageBlob);
      delete recordToSave.imageBlob;
    }

    const res = await fetch(`${this.baseUrl}/api/storage/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recordToSave)
    });
    if (!res.ok) throw new Error("Failed to save card to server");
    return await res.json();
  }

  async listCards() {
    try {
      const res = await fetch(`${this.baseUrl}/api/storage/cards`);
      if (!res.ok) return [];
      const rows = await res.json();
      return rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (e) {
      console.error("Failed to list cards from server:", e);
      return [];
    }
  }

  async getCard(id) {
    const res = await fetch(`${this.baseUrl}/api/storage/cards/${id}`);
    if (!res.ok) return null;
    const card = await res.json();
    
    // Repopulate as blob so the PNG encoder understands it seamlessly
    if (card && card.imageBase64) {
      card.imageBlob = await this.base64ToBlob(card.imageBase64);
    }
    return card;
  }

  async deleteCard(id) {
    await fetch(`${this.baseUrl}/api/storage/cards/${id}`, { method: "DELETE" });
  }
}

window.characterStorage = new CharacterStorage();

// Configuration file for SillyTavern Character Generator
const LOCAL_STORAGE_KEY = "charGeneratorConfig";

class Config {
  constructor() {
    this.config = this.getDefaultConfig();
    this.debugMode = false; // Toggle for verbose logging
    this.loadPromise = this.loadConfig().catch(console.error);
  }

  getDefaultConfig() {
    return {
      api: {
        text: {
          baseUrl: "",
          apiKey: "",
          model: "",
          visionModel: "",
          timeout: 180000,
        },
        image: {
          baseUrl: "",
          apiKey: "",
          model: "",
          models: [],
          size: "",
          style: "",
          timeout: 180000,
        },
      },
      app: {
        maxRetries: 3,
        retryDelay: 1000,
        debugMode: false,
        enableImageGeneration: true,
      },
      st: {
        baseUrl: "",
        username: "",
        password: "",
      },
    };
  }

  // Toggle debug mode for verbose logging
  setDebugMode(enabled) {
    this.debugMode = enabled;
    this.config.app.debugMode = enabled;
    this.saveConfig();
    console.log(`Debug mode ${enabled ? "enabled" : "disabled"}`);
  }

  getDebugMode() {
    return this.debugMode || this.config.app.debugMode || false;
  }

  log(...args) {
    if (this.getDebugMode()) {
      console.log(...args);
    }
  }

  async loadConfig() {
    // Load from local storage first so it's available immediately
    const savedConfig = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedConfig) {
      try {
        const saved = JSON.parse(savedConfig);
        this.config = this.deepMerge(this.config, saved);
        this.logRedacted("Loaded config from storage:", saved);
      } catch (error) {
        console.warn("Failed to load saved config:", error);
      }
    }

    // Then sync/override with server config if available
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const serverConfig = await res.json();
        if (Object.keys(serverConfig).length > 0) {
          this.config = this.deepMerge(this.config, serverConfig);
          this.logRedacted("Loaded config from server:", serverConfig);
        }
      }
    } catch (error) {
      console.warn("Failed to load config from server:", error);
    }

    // Load debug mode setting
    this.debugMode = this.config.app.debugMode || false;

    this.logRedacted("Final config:", this.config);
  }

  loadFromForm() {
    // Load text API settings from form
    const textBaseUrl = document.getElementById("text-api-base")?.value?.trim();
    const textApiKey = document.getElementById("text-api-key")?.value?.trim();
    const textModel = document.getElementById("text-model")?.value?.trim();
    const visionModel = document.getElementById("vision-model")?.value?.trim();

    if (textBaseUrl !== undefined) this.config.api.text.baseUrl = textBaseUrl;
    if (textApiKey !== undefined) this.config.api.text.apiKey = textApiKey;
    if (textModel !== undefined) this.config.api.text.model = textModel;
    if (visionModel !== undefined)
      this.config.api.text.visionModel = visionModel;

    // No special handling needed when using proxy server

    // Load image API settings from form
    const imageBaseUrl = document
      .getElementById("image-api-base")
      ?.value?.trim();
    const imageApiKey = document.getElementById("image-api-key")?.value?.trim();
    const imageSize = document.getElementById("image-size")?.value?.trim();
    const imageStyle = document.getElementById("image-style")?.value;
    
    const imageModelCheckboxes = document.querySelectorAll(".image-model-checkbox:checked");
    this.config.api.image.models = Array.from(imageModelCheckboxes).map(cb => cb.value);

    if (imageBaseUrl !== undefined)
      this.config.api.image.baseUrl = imageBaseUrl;
    if (imageApiKey !== undefined) this.config.api.image.apiKey = imageApiKey;
    if (imageSize !== undefined) this.config.api.image.size = imageSize;
    if (imageStyle !== undefined) this.config.api.image.style = imageStyle;

    // Load toggle states
    const enableImageGeneration = document.getElementById(
      "enable-image-generation",
    )?.checked;
    if (enableImageGeneration !== undefined)
      this.config.app.enableImageGeneration = enableImageGeneration;

    // Load SillyTavern settings
    const stBaseUrl = document.getElementById("st-base-url")?.value?.trim();
    const stUsername = document.getElementById("st-username")?.value?.trim();
    const stPassword = document.getElementById("st-password")?.value;
    if (stBaseUrl !== undefined || stUsername !== undefined || stPassword !== undefined) {
      if (!this.config.st) this.config.st = {};
      if (stBaseUrl !== undefined) this.config.st.baseUrl = stBaseUrl;
      if (stUsername !== undefined) this.config.st.username = stUsername;
      if (stPassword !== undefined) this.config.st.password = stPassword;
    }
  }

  get(path) {
    return path.split(".").reduce((obj, key) => obj && obj[key], this.config);
  }

  set(path, value) {
    const keys = path.split(".");
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => {
      if (!obj[key]) obj[key] = {};
      return obj[key];
    }, this.config);
    target[lastKey] = value;
    this.saveConfig();
  }

  saveConfig() {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this.config));

    // Also save to server for persistence across devices/sessions
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.config)
    }).catch(e => console.error("Failed to sync config to server", e));
  }

  saveToForm() {
    // Wait for DOM to be ready
    setTimeout(() => {
      // Save text API to form
      const textBaseUrl = document.getElementById("text-api-base");
      const textApiKey = document.getElementById("text-api-key");
      const textModel = document.getElementById("text-model");
      const visionModel = document.getElementById("vision-model");

      if (textBaseUrl) textBaseUrl.value = this.config.api.text.baseUrl || "";
      if (textApiKey) textApiKey.value = this.config.api.text.apiKey || "";
      if (textModel) textModel.value = this.config.api.text.model || "";
      if (visionModel)
        visionModel.value = this.config.api.text.visionModel || "";

      // Save image API to form
      const imageBaseUrl = document.getElementById("image-api-base");
      const imageApiKey = document.getElementById("image-api-key");
      const imageSize = document.getElementById("image-size");
      const imageStyle = document.getElementById("image-style");

      if (imageBaseUrl)
        imageBaseUrl.value = this.config.api.image.baseUrl || "";
      if (imageApiKey) imageApiKey.value = this.config.api.image.apiKey || "";
      if (imageSize) imageSize.value = this.config.api.image.size || "";
      if (imageStyle) imageStyle.value = this.config.api.image.style || "";

      // Save SillyTavern settings to form
      const stBaseUrl = document.getElementById("st-base-url");
      if (stBaseUrl) stBaseUrl.value = this.config.st?.baseUrl || "";
      const stUsername = document.getElementById("st-username");
      if (stUsername) stUsername.value = this.config.st?.username || "";
      const stPassword = document.getElementById("st-password");
      if (stPassword) stPassword.value = this.config.st?.password || "";
      
      const imageModelsContainer = document.getElementById("image-models-container");
      if (imageModelsContainer) {
          if (this.config.api.image.models && this.config.api.image.models.length > 0) {
              imageModelsContainer.innerHTML = this.config.api.image.models.map(model => `
                  <div class="image-model-row" style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;">
                    <label style="display:flex;align-items:center;gap:0.5rem;flex:1;cursor:pointer;">
                      <input type="checkbox" class="image-model-checkbox" value="${escapeHtml(model)}" checked>
                      ${escapeHtml(model)}
                    </label>
                    <button type="button" class="image-model-delete-btn" data-model="${escapeHtml(model)}" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>
                  </div>
              `).join('');
          } else {
              imageModelsContainer.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0;">Click \'Fetch Models\' to load available models.</p>';
          }
      }
      
      // Update main UI dropdown
      if (window.app && typeof window.app.updateActiveModelsDropdown === 'function') {
          window.app.updateActiveModelsDropdown();
      }

      // Save toggle states
      const enableImageGeneration = document.getElementById(
        "enable-image-generation",
      );
      if (enableImageGeneration)
        enableImageGeneration.checked =
          this.config.app.enableImageGeneration !== false;
    }, 100);
  }

  deepMerge(target, source) {
    const output = { ...target };
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  isObject(item) {
    return item && typeof item === "object" && !Array.isArray(item);
  }

  async waitForConfig() {
    if (this.loadPromise) {
      await this.loadPromise;
    }
    return this.config;
  }

  validateConfig() {
    const errors = [];

    // Text API validation
    if (!this.config.api.text.baseUrl) {
      errors.push("Text API base URL is required");
    }
    if (!this.config.api.text.apiKey) {
      errors.push("Text API key is required");
    }
    if (!this.config.api.text.model) {
      errors.push("Text model is required");
    }

    return errors;
  }

  clearStoredConfig() {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }

  redactSensitiveData(data) {
    if (Array.isArray(data)) {
      return data.map((item) => this.redactSensitiveData(item));
    }

    if (!this.isObject(data)) {
      return data;
    }

    const redacted = {};
    Object.keys(data).forEach((key) => {
      if (key.toLowerCase().includes("apikey")) {
        redacted[key] = data[key] ? "[REDACTED]" : "";
      } else {
        redacted[key] = this.redactSensitiveData(data[key]);
      }
    });
    return redacted;
  }

  logRedacted(message, data) {
    if (this.getDebugMode()) {
      console.log(message, this.redactSensitiveData(data));
    }
  }

  updateStorageMethod() {
    // When changing persistence setting, migrate keys between storage methods
    if (this.config.app.persistApiKeys) {
      // Move from sessionStorage to localStorage
      const textKey = this.getSessionValue(SESSION_STORAGE_KEYS.textApiKey);
      const imageKey = this.getSessionValue(SESSION_STORAGE_KEYS.imageApiKey);

      if (textKey) {
        this.persistLocalStorageValue(SESSION_STORAGE_KEYS.textApiKey, textKey);
        sessionStorage.removeItem(SESSION_STORAGE_KEYS.textApiKey);
      }
      if (imageKey) {
        this.persistLocalStorageValue(
          SESSION_STORAGE_KEYS.imageApiKey,
          imageKey,
        );
        sessionStorage.removeItem(SESSION_STORAGE_KEYS.imageApiKey);
      }
    } else {
      // Move from localStorage to sessionStorage
      const textKey = this.getLocalStorageValue(
        SESSION_STORAGE_KEYS.textApiKey,
      );
      const imageKey = this.getLocalStorageValue(
        SESSION_STORAGE_KEYS.imageApiKey,
      );

      if (textKey) {
        this.persistSessionValue(SESSION_STORAGE_KEYS.textApiKey, textKey);
        localStorage.removeItem(SESSION_STORAGE_KEYS.textApiKey);
      }
      if (imageKey) {
        this.persistSessionValue(SESSION_STORAGE_KEYS.imageApiKey, imageKey);
        localStorage.removeItem(SESSION_STORAGE_KEYS.imageApiKey);
      }
    }
  }
}

// Export singleton instance
window.config = new Config();

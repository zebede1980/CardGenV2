// API Handler for OpenAI-compatible endpoints with streaming support
class APIHandler {
  constructor() {
    this.config = window.config;
    this.lastGeneratedImagePrompt = null; // Store the last generated prompt for display
    this.currentAbortController = null; // Store current abort controller for stopping generation
    this.currentReader = null; // Store current stream reader for cancellation
    this.userStopRequested = false;
    this.requestLogs = []; // Rolling log of recent API interactions
  }

  addBackendLog(logData) {
      if (!logData.id) {
          logData.id = Date.now() + Math.random().toString(36).substr(2, 5);
      }
      
      let existingLog = this.requestLogs.find(l => l.id === logData.id);
      if (!existingLog) {
          existingLog = {
              id: logData.id,
              timestamp: new Date().toISOString(),
              endpoint: logData.endpoint || "Backend Stream",
              model: logData.model || (logData.request && logData.request.model ? logData.request.model : "Unknown"),
              request: null,
              response: null,
              status: "pending",
              duration: 0,
              usage: null,
              _startTime: performance.now()
          };
          this.requestLogs.unshift(existingLog);
          if (this.requestLogs.length > 30) this.requestLogs.pop();
      }
      
      if (logData.request) existingLog.request = logData.request;
      if (logData.model) existingLog.model = logData.model;
      else if (logData.request && logData.request.model) existingLog.model = logData.request.model;
      
      if (logData.response !== undefined) {
          existingLog.response = logData.response;
          existingLog.status = 200;
          if (existingLog._startTime && !logData.duration) {
              existingLog.duration = performance.now() - existingLog._startTime;
          } else if (logData.duration) {
              existingLog.duration = logData.duration;
          }
      }
      if (logData.usage) existingLog.usage = logData.usage;
  }

  async makeRequest(endpoint, data, isImageRequest = false, stream = false) {
    let lastError;
    let delay = this.config.get("app.retryDelay") || 1000;
    const maxRetries = this.config.get("app.maxRetries") || 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._doMakeRequest(endpoint, data, isImageRequest, stream);
      } catch (error) {
        lastError = error;

        // Do not retry if the user explicitly requested to stop, auth failed, or bad request
        if (
          this.userStopRequested ||
          error.message.includes("Generation stopped by user") ||
          error.message.includes("Authorization Error") ||
          error.message.includes("401") ||
          error.message.includes("400")
        ) {
          throw error;
        }

        console.warn(`[API] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        }
      }
    }
    throw lastError;
  }

  async _doMakeRequest(endpoint, data, isImageRequest = false, stream = false) {
    // Use proxy server to bypass browser API restrictions
    // Both Nginx (prod/docker) and http-server (dev) are configured to proxy /api to the backend
    const baseUrl = "";
    const proxyEndpoint = isImageRequest
      ? "/api/image/generations"
      : "/api/text/chat/completions";
    endpoint = proxyEndpoint;

    const apiKey = isImageRequest
      ? this.config.get("api.image.apiKey")
      : this.config.get("api.text.apiKey");
    const apiUrl = isImageRequest
      ? this.config.get("api.image.baseUrl")
      : this.config.get("api.text.baseUrl");
    const timeout = isImageRequest
      ? this.config.get("api.image.timeout")
      : this.config.get("api.text.timeout");

    if (!apiKey) {
      throw new Error(
        "API key is required. Please configure your API settings.",
      );
    }

    if (!apiUrl) {
      throw new Error(
        "API URL is required. Please configure your API Base URL in settings.",
      );
    }

    const url = `${baseUrl}${endpoint}`;
    // Proxy server handles authentication, pass API key and actual API URL in headers
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "X-API-URL": apiUrl,
    };

    // Add streaming headers if needed
    if (stream) {
      headers.Accept = "text/event-stream";
    }

    const controller = new AbortController();
    this.userStopRequested = false;
    this.currentAbortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    this.config.log(`Making request to: ${url}`);
    this.config.log(`Request data:`, data);
    this.config.log(`Headers:`, headers);
    this.config.log(`Using proxy server: ${baseUrl}`);
    this.config.log(`API Key (first 10 chars): ${apiKey.substring(0, 10)}...`);
    this.config.log(`API Key length: ${apiKey.length}`);

    this.config.log("API Request:", {
      url,
      method: "POST",
      headers: {
        ...headers,
        Authorization: headers.Authorization
          ? "[REDACTED]"
          : headers["X-API-Key"]
            ? "[REDACTED]"
            : "NO AUTH",
      },
      dataKeys: Object.keys(data),
    });

    // Safely truncate large base64 images to prevent the log from crashing the browser
    let logRequestData = data;
    try {
        logRequestData = JSON.parse(JSON.stringify(data));
        if (logRequestData.messages) {
            logRequestData.messages.forEach(m => {
                if (Array.isArray(m.content)) {
                    m.content.forEach(c => {
                        if (c.type === 'image_url' && c.image_url?.url?.length > 200) {
                            c.image_url.url = c.image_url.url.substring(0, 50) + "... [BASE64 TRUNCATED]";
                        }
                    });
                }
            });
        }
    } catch(e) {}

    const logEntry = {
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toISOString(),
        endpoint: endpoint,
        model: data.model,
        request: logRequestData,
        response: null,
        status: "pending",
        duration: 0,
        usage: null
    };
    this.requestLogs.unshift(logEntry);
    if (this.requestLogs.length > 30) this.requestLogs.pop();
    const startTime = performance.now();

    try {
      const authToken = window.cardgenAuth?.getToken() || "";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      this.config.log(`Response status: ${response.status}`);
      this.config.log(`Response headers:`, [...response.headers.entries()]);

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorData = {};
        try {
          const responseText = await response.text();
          console.error("API Error Response (raw):", responseText);
          errorData = JSON.parse(responseText);
          console.error("API Error Response (parsed):", errorData);
        } catch (e) {
          console.error("Failed to parse error response as JSON:", e);
        }
        
        logEntry.status = response.status;
        logEntry.duration = performance.now() - startTime;
        logEntry.response = errorData;

        const errorMessage =
          errorData.error?.message ||
          errorData.message ||
          errorData.detail ||
          errorData.error ||
          response.statusText;

        // Special handling for 401 errors
        if (response.status === 401) {
          throw new Error(`Authorization Error: ${errorMessage}

    Possible solutions:
    1. Check if API key is correct
    2. API key may be expired - generate a new one
    3. Try different authorization method (some APIs use X-API-Key header instead of Bearer)
    4. Ensure you're using the correct API endpoint`);
        }

        throw new Error(`API Error: ${response.status} - ${errorMessage}`);
      }

      if (stream) {
        response._logEntry = logEntry;
        response._startTime = startTime;
        return response;
      } else if (isImageRequest) {
        response.clone().json().then(res => {
           logEntry.status = response.status;
           logEntry.duration = performance.now() - startTime;
           logEntry.response = res;
        }).catch(() => {});
        return response;
      } else {
        const result = await response.json();
        logEntry.status = response.status;
        logEntry.duration = performance.now() - startTime;
        logEntry.response = result;
        if (result.usage) logEntry.usage = result.usage;
        this.config.log("API Response:", result);
        return result;
      }
    } catch (error) {
      clearTimeout(timeoutId);

      logEntry.status = error.name === "AbortError" ? "aborted" : "error";
      logEntry.duration = performance.now() - startTime;
      logEntry.response = error.message;

      if (error.name === "AbortError") {
        if (this.userStopRequested) {
          throw new Error("Generation stopped by user.");
        }
        throw new Error(
          "Request timed out or was interrupted. Consider increasing API timeout in settings.",
        );
      }

      console.error("API Request Failed:", error);
      throw error;
    } finally {
      this.currentAbortController = null;
    }
  }

  async handleStreamResponse(response, onStream) {
    const reader = response.body.getReader();
    this.currentReader = reader; // Store reader reference for cancellation
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    const logEntry = response._logEntry;
    const startTime = response._startTime || performance.now();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          if (trimmed.startsWith("data: ")) {
            let data = trimmed.slice(6).trim();

            if (data === "[DONE]") continue;

            // Some proxies double-wrap: "data: data: {...}" — unwrap once
            if (data.startsWith("data: ")) data = data.slice(6).trim();

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || "";

              if (content) {
                fullContent += content;
                onStream(content, fullContent);
              }
            
            // Capture usage stats occasionally sent at the end of streams
            if (parsed.usage && logEntry) {
              logEntry.usage = parsed.usage;
            }
            } catch (e) {
              // Log only when debug mode is on, and truncate long data
              if (window.config?.getDebugMode?.()) {
                console.debug("Failed to parse streaming data:", data.length > 120 ? data.slice(0, 120) + "…" : data);
              }
            }
          }
        }
      }

      if (logEntry) {
        logEntry.status = 200;
        logEntry.duration = performance.now() - startTime;
        logEntry.response = fullContent;
      }

      return fullContent;
    } catch (error) {
      console.error("Stream processing error:", error);
      throw error;
    } finally {
      this.currentReader = null;
    }
  }

  async fetchModels(type = 'image') {
    const baseUrl = this.config.get(`api.${type}.baseUrl`);
    const apiKey = this.config.get(`api.${type}.apiKey`);

    if (!baseUrl) throw new Error("API Base URL is required to fetch models");

    let endpoint = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    if (!endpoint.endsWith('/v1') && !endpoint.includes('/models')) {
        // Attempt to guess correct endpoint if it doesn't seem explicitly provided
    }
    const url = `${endpoint}/models`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            }
        });
        
        if (!response.ok) {
            let errorMsg = response.statusText;
            try {
                const errData = await response.json();
                errorMsg = errData.error?.message || errData.message || errorMsg;
            } catch (e) {}
            throw new Error(`HTTP ${response.status}: ${errorMsg}`);
        }
        
        const data = await response.json();
        let models = data.data || [];
        if (Array.isArray(models)) {
            models.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
        }
        return models;
    } catch (error) {
        console.error("Failed to fetch models:", error);
        throw error;
    }
  }

  async tryAlternativeAuth(endpoint, data) {
    const altAuthMethods = [
      () => this.makeRequestWithAuth(endpoint, data, "X-API-Key"),
      () => this.makeRequestWithAuth(endpoint, data, "api-key"),
      () => this.makeRequestWithAuth(endpoint, data, "Authorization", ""), // No Bearer prefix
      () => this.makeRequestWithAuth(endpoint, data, "Authorization", "Token "),
    ];

    for (const [index, tryAuth] of altAuthMethods.entries()) {
      try {
        this.config.log(`Trying auth method ${index + 1}...`);
        const response = await tryAuth();
        return this.processNormalResponse(response);
      } catch (error) {
        this.config.log(`Auth method ${index + 1} failed: `, error.message);
        if (index < altAuthMethods.length - 1) {
          continue; // Try next method
        }
        throw error; // All methods failed
      }
    }
  }

  async makeRequestWithAuth(endpoint, data, authHeader, prefix = "Bearer ") {
    const baseUrl = this.config.get("api.text.baseUrl");
    const apiKey = this.config.get("api.text.apiKey");
    const timeout = this.config.get("api.text.timeout");

    const headers = {
      "Content-Type": "application/json",
      [authHeader]: prefix ? `${prefix}${apiKey} ` : apiKey,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}${endpoint} `, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText} `);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  processNormalResponse(response) {
    // Handle different response formats
    if (
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
    ) {
      const message = response.choices[0].message;
      // Some models (like GLM) use reasoning_content instead of content
      return message.content || message.reasoning_content || "";
    } else if (
      response.data &&
      response.data.choices &&
      response.data.choices[0]
    ) {
      return (
        response.data.choices[0].message?.content ||
        response.data.choices[0].text
      );
    } else if (response.content) {
      return response.content;
    } else {
      console.error("Unexpected response format:", response);
      throw new Error("Unexpected API response format");
    }
  }

  async testConnection() {
    try {
      const apiKey = this.config.get("api.text.apiKey");
      if (!apiKey) {
        return { success: false, error: "No API key configured" };
      }

      // Test with exact same format as working curl command
      const data = {
        model: this.config.get("api.text.model"),
        messages: [
          {
            role: "user",
            content: 'Respond with just "OK"',
          },
        ],
        max_tokens: 100,
      };

      // Try with default auth first, then alternatives
      try {
        await this.makeRequest("/chat/completions", data);
        return { success: true };
      } catch (error) {
        if (error.message.includes("401")) {
          await this.tryAlternativeAuth("/chat/completions", data);
          return { success: true, authMethod: "alternative" };
        }
        throw error;
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  stopGeneration() {
    this.userStopRequested = true;
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    if (this.currentReader) {
      this.currentReader.cancel();
      this.currentReader = null;
    }
  }
}

// Export singleton instance
window.apiHandler = new APIHandler();

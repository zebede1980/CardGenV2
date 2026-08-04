// API Handler for OpenAI-compatible endpoints with streaming support
class APIHandler {
  constructor() {
    this.config = window.config;
    this.lastGeneratedImagePrompt = null; // Store the last generated prompt for display
    this.currentAbortController = null; // Store current abort controller for stopping generation
    this.currentReader = null; // Store current stream reader for cancellation
    this.userStopRequested = false;
    this.requestLogs = []; // Rolling log of recent API interactions
    this.lastFinishReason = null; // Why the last generation stopped ("length" = truncated)
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

    // Resumable requests carry a client-generated reference, created *before*
    // the request goes out. Without it, a socket that dies during the initial
    // upstream wait leaves a generation running server-side that the browser
    // cannot name — and the retry below would silently start a second one.
    const resumable = !!data.resumable && !!window.ResumableJobs;
    let clientRef = null;
    if (resumable) {
      clientRef = window.ResumableJobs.newRef();
      data = { ...data, clientRef };
      window.ResumableJobs.add({ clientRef, label: data.__jobLabel || "Generation" });
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this._doMakeRequest(endpoint, data, isImageRequest, stream);
        if (resumable) {
          if (stream && response) {
            // handleStreamResponse owns the entry from here — it clears it once
            // the stream terminates, having used it to reconnect if needed.
            response._clientRef = clientRef;
          } else {
            window.ResumableJobs.remove(clientRef);
          }
        }
        return response;
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
          if (resumable) window.ResumableJobs.remove(clientRef);
          throw error;
        }

        // Before retrying, check whether the generation is already running on
        // the server. Retrying blind here is what made a dropped connection
        // silently produce a *different* character at double the token cost.
        if (resumable) {
          if (stream) {
            const resumed = await this._tryResumeByClientRef(clientRef);
            if (resumed) {
              console.warn(`[API] Attempt ${attempt} failed (${error.message}) — resuming existing generation instead of regenerating`);
              return resumed;
            }
          } else {
            // Nothing to resume mid-flight, but the finished result may be
            // waiting on the server. Collecting it is free; regenerating is not.
            const collected = await this._tryCollectResult(clientRef);
            if (collected) {
              console.warn(`[API] Attempt ${attempt} failed (${error.message}) — collected the completed result instead of regenerating`);
              window.ResumableJobs.remove(clientRef);
              return collected;
            }
          }
        }

        console.warn(`[API] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        }
      }
    }
    if (resumable) window.ResumableJobs.remove(clientRef);
    throw lastError;
  }

  /**
   * Look for a server-side job matching this client reference and, if one
   * exists, open a resume stream for the part not yet seen. Returns a Response
   * that handleStreamResponse can consume exactly like an original stream, or
   * null when there is nothing to resume.
   */
  async _tryResumeByClientRef(clientRef) {
    if (!clientRef) return null;
    try {
      const jobId = await this._findJobId(clientRef);
      if (!jobId) return null;
      const offset = window.ResumableJobs.get(clientRef)?.offset || 0;
      return await this._openResumeStream(jobId, offset, clientRef);
    } catch (err) {
      console.warn("[API] resume lookup failed:", err?.message || err);
      return null;
    }
  }

  /**
   * Find this request's job and wait for its result. Used when a non-streaming
   * call's connection dies: the generation is still running (or finished) on
   * the server, so paying for a second one would be pure waste.
   *
   * Returns the provider response object, or null if there is nothing to collect.
   */
  async _tryCollectResult(clientRef, { maxWaitMs = 120000 } = {}) {
    if (!clientRef) return null;
    try {
      const jobId = await this._findJobId(clientRef);
      if (!jobId) return null;

      const deadline = Date.now() + maxWaitMs;
      let delay = 750;

      while (Date.now() < deadline) {
        await this._waitUntilVisible();

        let res;
        try {
          res = await (window.authFetch || fetch)(
            `/api/text/jobs/${encodeURIComponent(jobId)}/result`,
            { headers: this._authHeaders() },
          );
        } catch (err) {
          // Still offline. Keep waiting rather than abandoning a paid-for job.
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 1.5, 5000);
          continue;
        }

        if (res.status === 404 || res.status === 403) return null;

        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 1.5, 5000);
          continue;
        }

        if (!res.ok) return null;

        const payload = await res.json();
        if (payload.status === "error") {
          throw new Error(payload.error || "Generation failed on the server");
        }
        return payload.result || null;
      }
      console.warn("[API] gave up waiting for job result after", maxWaitMs, "ms");
      return null;
    } catch (err) {
      console.warn("[API] result collection failed:", err?.message || err);
      return null;
    }
  }

  /** Resolve a client reference to a server job id, via the store or the list endpoint. */
  async _findJobId(clientRef) {
    const entry = window.ResumableJobs.get(clientRef);
    if (entry?.jobId) return entry.jobId;

    const res = await (window.authFetch || fetch)(
      `/api/text/jobs?clientRef=${encodeURIComponent(clientRef)}`,
      { headers: this._authHeaders() },
    );
    if (!res.ok) return null;
    const { jobs } = await res.json();
    if (!jobs?.length) return null;
    window.ResumableJobs.update(clientRef, { jobId: jobs[0].id });
    return jobs[0].id;
  }

  _authHeaders() {
    const authToken = window.cardgenAuth?.getToken() || "";
    return authToken ? { Authorization: `Bearer ${authToken}` } : {};
  }

  /** Open the SSE resume stream for a job, starting after `offset` characters. */
  async _openResumeStream(jobId, offset, clientRef) {
    const res = await (window.authFetch || fetch)(
      `/api/text/jobs/${encodeURIComponent(jobId)}/stream?from=${offset}`,
      { headers: { ...this._authHeaders(), Accept: "text/event-stream" } },
    );

    if (res.status === 404) {
      // Evicted or the proxy restarted. Say so rather than silently starting a
      // brand-new generation the user did not ask for.
      console.warn(`[API] job ${jobId} expired before it could be resumed`);
      if (clientRef) window.ResumableJobs.remove(clientRef);
      return null;
    }
    if (!res.ok) return null;

    res._clientRef = clientRef;
    res._resumedJobId = jobId;
    res._resumeOffset = offset;
    return res;
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

    // Hold the screen awake for the duration of the call. For streaming
    // requests ownership passes to handleStreamResponse, which releases when
    // the stream ends — the work is not over just because fetch() resolved.
    let wakeLockHeld = false;
    if (window.wakeLockManager) {
      window.wakeLockManager.acquire();
      wakeLockHeld = true;
    }

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
        // Hand the wake lock to the stream consumer.
        response._wakeLockHeld = wakeLockHeld;
        wakeLockHeld = false;
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
      // Released here for non-streaming calls and for any failure before the
      // stream was handed over. Streaming successes cleared the flag above.
      if (wakeLockHeld) window.wakeLockManager?.release();
    }
  }

  /**
   * Consume one SSE stream into `state`, which accumulates across resumes.
   * Returns normally when the socket ends for any reason; `state.complete`
   * distinguishes a finished generation from a severed connection.
   */
  async _consumeStream(body, state, onStream, logEntry) {
    const reader = body.getReader();
    this.currentReader = reader; // Store reader reference for cancellation
    const decoder = new TextDecoder();
    let buffer = "";

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

              // The proxy announces a resumable job before any content, so the
              // reference can be recorded while there is still time to use it.
              if (parsed.type === "job" && parsed.jobId) {
                state.jobId = parsed.jobId;
                if (state.clientRef) {
                  window.ResumableJobs?.update(state.clientRef, { jobId: parsed.jobId });
                }
                continue;
              }

              if (parsed.error) {
                state.error = parsed.error.message || String(parsed.error);
                state.complete = true;
                continue;
              }

              const content = parsed.choices?.[0]?.delta?.content || "";

              if (content) {
                state.fullContent += content;
                if (state.clientRef) {
                  window.ResumableJobs?.update(state.clientRef, {
                    offset: state.fullContent.length,
                  });
                }
                onStream(content, state.fullContent);
              }

            // The terminating chunk carries why generation stopped; remember it
            // so we can warn about truncation once the stream completes. It is
            // also how a finished generation is told apart from a dropped one.
            if (parsed.choices?.[0]?.finish_reason) {
              state.finishReason = parsed.choices[0].finish_reason;
              state.complete = true;
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
    } catch (error) {
      // A severed socket is not fatal for a resumable job — the caller decides
      // whether to reconnect. Record it and let the resume loop take over.
      state.interrupted = error;
      if (window.config?.getDebugMode?.()) {
        console.debug("Stream read ended:", error?.message || error);
      }
    } finally {
      this.currentReader = null;
    }
  }

  /** Resolve once the page is visible again, so we do not reconnect while locked. */
  _waitUntilVisible() {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onChange = () => {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", onChange);
          resolve();
        }
      };
      document.addEventListener("visibilitychange", onChange);
    });
  }

  async handleStreamResponse(response, onStream) {
    const logEntry = response._logEntry;
    const startTime = response._startTime || performance.now();

    const state = {
      fullContent: "",
      clientRef: response._clientRef || null,
      jobId: response._resumedJobId || null,
      finishReason: null,
      complete: false,
      interrupted: null,
      error: null,
    };

    // A resume handed over by makeRequest always starts at offset 0: the
    // original attempt never reached this method, so `onStream` has been shown
    // nothing yet and the whole buffer must be replayed.

    try {
      await this._consumeStream(response.body, state, onStream, logEntry);

      // Reconnect loop. Only resumable generations get here: without a job the
      // stream is gone for good and the error must surface to the caller.
      // Bounded so a persistently failing resume cannot spin forever.
      let attempts = 0;
      while (
        !state.complete &&
        state.clientRef &&
        !this.userStopRequested &&
        attempts < 20
      ) {
        attempts++;
        await this._waitUntilVisible();

        // Connectivity usually comes back a moment after the screen does, so a
        // failed reconnect is retried with backoff rather than giving up and
        // handing the caller a half-finished character.
        let resumeRes = null;
        try {
          resumeRes = state.jobId
            ? await this._openResumeStream(state.jobId, state.fullContent.length, state.clientRef)
            : await this._tryResumeByClientRef(state.clientRef);
        } catch (err) {
          console.warn("[API] reconnect attempt failed:", err?.message || err);
        }

        if (!resumeRes) {
          // A null result from an expired job is terminal; a thrown network
          // error is not. _openResumeStream clears the store on eviction, so
          // a missing entry means there is genuinely nothing left to resume.
          if (!window.ResumableJobs?.get(state.clientRef)) break;
          await new Promise((r) => setTimeout(r, Math.min(500 * attempts, 5000)));
          continue;
        }

        state.interrupted = null;
        await this._consumeStream(resumeRes.body, state, onStream, logEntry);
      }

      if (state.clientRef && (state.complete || !state.interrupted)) {
        window.ResumableJobs?.remove(state.clientRef);
      }

      if (state.error) throw new Error(state.error);

      // Nothing recoverable and the socket died — surface the original failure
      // rather than handing back a half-built character as if it were whole.
      if (!state.complete && state.interrupted) {
        if (this.userStopRequested) throw new Error("Generation stopped by user.");
        throw state.interrupted;
      }

      if (logEntry) {
        logEntry.status = 200;
        logEntry.duration = performance.now() - startTime;
        logEntry.response = state.fullContent;
      }

      this.noteFinishReason(state.finishReason);

      return state.fullContent;
    } catch (error) {
      console.error("Stream processing error:", error);
      throw error;
    } finally {
      this.currentReader = null;
      // Ownership was passed from _doMakeRequest when the stream began.
      if (response._wakeLockHeld) {
        response._wakeLockHeld = false;
        window.wakeLockManager?.release();
      }
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

  /**
   * Record why generation stopped and warn the user if the model was cut off
   * at the token cap. Truncated output was previously accepted silently: a card
   * would simply end mid-field, and for the JSON-producing calls the cut-off
   * text surfaced only as a confusing parse error.
   */
  noteFinishReason(finishReason, context = "The response") {
    this.lastFinishReason = finishReason || null;
    if (finishReason !== "length") return;

    const msg = `${context} hit the token limit and was cut off. Increase Max Tokens in API Settings, or shorten the input.`;
    console.warn("[api] truncated generation:", context);
    try {
      window.app?.showNotification?.(msg, "warning");
    } catch (_) {
      /* notification layer not ready — the console warning still stands */
    }
  }

  processNormalResponse(response) {
    // Handle different response formats
    if (
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
    ) {
      this.noteFinishReason(response.choices[0].finish_reason);
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

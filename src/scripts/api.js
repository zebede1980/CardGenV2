// API Handler for OpenAI-compatible endpoints with streaming support

// Prepended to the system prompt of every text call that goes through
// makeRequest, which is all of the card tooling: card writing, finishing
// fields, revisions, lorebooks, image prompts, Inspire Me. It sits here rather
// than in each prompt so no new prompt can miss it. Reasoning models without
// this spent their whole token budget weighing explicit concepts and wrote
// nothing (GLM 5.3, 2026-10-15). The adult-only line is what makes the rest
// credible: it gives the model a clear boundary instead of leaving it to
// invent one, and it is a line the app means.
const CARD_CONTENT_CONTEXT = `**CONTENT CONTEXT:** This is a private creative-writing tool. An adult author uses it to build characters for interactive fiction. Everything you write is fiction: invented characters in an invented story, read only by the adult who asked for it. Mature themes are in scope when the concept calls for them: horror, violence, dark romance, explicit sex, and monster or non-human characters. Write them with the same craft and directness as any other genre. Don't add disclaimers or warnings, don't moralise, and don't water the concept down.
**The one firm line:** every character in a sexual context is an adult (18+), and the card states this plainly. Never sexualise minors or characters given childlike traits. If a concept implies that, make the characters adults rather than refusing.`;

/** Return `messages` with the content context leading the system prompt. */
function withContentContext(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const [first, ...rest] = messages;
  if (first.role === "system") {
    // Multimodal system content is left alone rather than reshaped.
    if (typeof first.content !== "string") return messages;
    if (first.content.includes("**CONTENT CONTEXT:**")) return messages;
    return [{ ...first, content: `${CARD_CONTENT_CONTEXT}\n\n${first.content}` }, ...rest];
  }
  return [{ role: "system", content: CARD_CONTENT_CONTEXT }, ...messages];
}

// How long a stream may go completely silent before it is treated as stalled.
// The proxy sends a heartbeat every 15s, so this is three missed beats. A
// stalled connection never errors or closes on its own: without this a card
// stream that stopped arriving 15% in left the page waiting forever
// (2026-10-18). A stall is handled like a dropped connection: resumable jobs
// reconnect from where they got to, anything else surfaces an error.
const STREAM_STALL_MS = 45 * 1000;

class APIHandler {
  constructor() {
    this.config = window.config;
    this.lastGeneratedImagePrompt = null; // Store the last generated prompt for display
    this.currentAbortController = null; // Store current abort controller for stopping generation
    this.currentReader = null; // Store current stream reader for cancellation
    this.userStopRequested = false;
    // Bumped on every Stop. Unlike userStopRequested, nothing resets it, so a
    // multi-step generation can tell a Stop happened even if it landed between
    // two requests (each new request clears userStopRequested).
    this.stopSerial = 0;
    // Client refs of resumable text generations in flight, so Stop can cancel
    // them server-side as well as dropping the connection.
    this.activeClientRefs = new Set();
    this.lastStreamStats = null;
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
    let delay = this.config.get("app.retryDelay") || 1000;
    const maxRetries = this.config.get("app.maxRetries") || 3;

    // Resumable requests carry a client-generated reference, created *before*
    // the request goes out. Without it, a socket that dies during the initial
    // upstream wait leaves a generation running server-side that the browser
    // cannot name — and the retry below would silently start a second one.
    if (!isImageRequest && Array.isArray(data.messages)) {
      data = { ...data, messages: withContentContext(data.messages) };
    }

    const resumable = !!data.resumable && !!window.ResumableJobs;
    let clientRef = null;
    if (resumable) {
      clientRef = window.ResumableJobs.newRef();
      data = { ...data, clientRef };
      window.ResumableJobs.add({ clientRef, label: data.__jobLabel || "Generation" });
      if (!isImageRequest) this.activeClientRefs.add(clientRef);
    }
    // Streams hand the ref to handleStreamResponse, which releases it there.
    let handedOff = false;
    try {
      return await this._makeRequestAttempts(endpoint, data, isImageRequest, stream, {
        resumable, clientRef, maxRetries, delay, onHandOff: () => { handedOff = true; },
      });
    } finally {
      if (clientRef && !handedOff) this.activeClientRefs.delete(clientRef);
    }
  }

  async _makeRequestAttempts(endpoint, data, isImageRequest, stream, { resumable, clientRef, maxRetries, delay, onHandOff }) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this._doMakeRequest(endpoint, data, isImageRequest, stream);
        if (resumable) {
          if (stream && response) {
            // handleStreamResponse owns the entry from here — it clears it once
            // the stream terminates, having used it to reconnect if needed.
            response._clientRef = clientRef;
            onHandOff();
          } else {
            window.ResumableJobs.remove(clientRef);
          }
        }
        return response;
      } catch (error) {
        lastError = error;

        // Do not retry if the user explicitly requested to stop, auth failed, or bad request.
        // Nor when the local GPU is unavailable: the proxy has already waited on its
        // own health check, and a retry only delays the hosted-model fallback.
        if (
          this.userStopRequested ||
          error.message.includes("Generation stopped by user") ||
          error.message.includes("Authorization Error") ||
          error.message.includes("401") ||
          error.message.includes("400") ||
          error.message.includes("Local GPU")
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
              onHandOff();
              return resumed;
            }
          } else {
            // Nothing to resume mid-flight, but the finished result may be
            // waiting on the server. Collecting it is free; regenerating is not.
            const collected = await this._tryCollectResult(clientRef, isImageRequest);
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
   * Text and image jobs share the same server-side registry (see
   * `/api/jobs` in proxy/server.js) — `isImageRequest` only changes what
   * gets *returned* here, since the two callers expect different shapes:
   * text callers (processNormalResponse) want the raw parsed provider JSON,
   * while image callers (editImage/generateImage) call `.json()` on a
   * fetch-like Response themselves.
   *
   * Returns the provider response (or a Response-shaped shim for images), or
   * null if there is nothing to collect.
   */
  async _tryCollectResult(clientRef, isImageRequest = false, { maxWaitMs = 120000 } = {}) {
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
            `/api/jobs/${encodeURIComponent(jobId)}/result`,
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
        if (isImageRequest) {
          // _doMakeRequest's image branch returns the raw fetch Response for
          // callers to .json() themselves — match that shape here rather than
          // handing back an already-parsed object they'd double-unwrap.
          return { ok: true, status: 200, json: async () => payload.result };
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
      `/api/jobs?clientRef=${encodeURIComponent(clientRef)}`,
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
      `/api/jobs/${encodeURIComponent(jobId)}/stream?from=${offset}`,
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
    // Callers have always passed upstream-shaped paths ("/chat/completions")
    // that this method ignored in favour of the proxy route above — keep that.
    // But a caller naming one of *our own* proxy routes is asking for that
    // route specifically, and honouring it is what lets combineImages() go
    // through makeRequest (and so inherit the resumable-job plumbing) instead
    // of doing its own bare fetch() with no protection against a dropped
    // mobile connection. Every pre-existing call site passes either an
    // upstream path or exactly the route it would have been given anyway, so
    // this changes nothing for them.
    endpoint = (typeof endpoint === "string" && endpoint.startsWith("/api/"))
      ? endpoint
      : proxyEndpoint;

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

    // Cancelling makes the pending read() resolve as `done`, which would look
    // like a clean end, so the stall is recorded first for the caller to see.
    //
    // Only silence the page actually sat through counts. iOS freezes timers
    // while the phone is locked or another app is in front, and an overdue
    // timer fires the moment the page wakes, before the socket has had a
    // chance to deliver or fail. So a hidden page, or a timer that fired well
    // late (the page was asleep), just starts a fresh wait; the lock-screen
    // recovery (socket error, then resume) runs exactly as it did before.
    let stalled = null;
    let watchdog = null;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      const armedAt = Date.now();
      watchdog = setTimeout(() => {
        const asleep = Date.now() - armedAt > STREAM_STALL_MS + 5000;
        if (asleep || (typeof document !== "undefined" && document.visibilityState !== "visible")) {
          armWatchdog();
          return;
        }
        stalled = new Error(`Connection stalled (nothing received for ${STREAM_STALL_MS / 1000}s)`);
        console.warn("[API]", stalled.message, "- reconnecting");
        reader.cancel().catch(() => {});
      }, STREAM_STALL_MS);
    };

    try {
      armWatchdog();
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        armWatchdog();

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

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content || "";
              const reasoning = delta?.reasoning || delta?.reasoning_content;
              if (reasoning) state.reasoningChars += reasoning.length;

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
      clearTimeout(watchdog);
      if (stalled && !state.complete) state.interrupted = stalled;
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

  /**
   * `warnOnTruncation: false` lets a caller that checks the outcome itself
   * (see lastStreamStats) give a more specific message than the generic one.
   */
  async handleStreamResponse(response, onStream, { warnOnTruncation = true } = {}) {
    const logEntry = response._logEntry;
    const startTime = response._startTime || performance.now();
    const stopMark = this.stopSerial;
    const stopped = () => this.stopSerial !== stopMark;

    const state = {
      fullContent: "",
      reasoningChars: 0,
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
        !stopped() &&
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

      // Checked before anything else: Stop cancels the reader, which ends the
      // stream cleanly, and a half-written reply must not then pass as whole.
      if (stopped() && !state.complete) throw new Error("Generation stopped by user.");

      if (state.error) throw new Error(state.error);

      // Nothing recoverable and the socket died — surface the original failure
      // rather than handing back a half-built character as if it were whole.
      if (!state.complete && state.interrupted) throw state.interrupted;

      if (logEntry) {
        logEntry.status = 200;
        logEntry.duration = performance.now() - startTime;
        logEntry.response = state.fullContent;
      }

      this.lastStreamStats = {
        finishReason: state.finishReason,
        contentChars: state.fullContent.length,
        reasoningChars: state.reasoningChars,
      };
      if (warnOnTruncation) this.noteFinishReason(state.finishReason);
      else this.lastFinishReason = state.finishReason || null;

      return state.fullContent;
    } catch (error) {
      console.error("Stream processing error:", error);
      throw error;
    } finally {
      this.currentReader = null;
      if (state.clientRef) this.activeClientRefs.delete(state.clientRef);
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

    const endpoint = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
    };

    try {
        // nano-gpt's /models is its text catalogue; image models are listed
        // separately at /image-models. Providers without that endpoint (OpenAI
        // and friends) 404 it and fall through to plain /models.
        let response = null;
        if (type === 'image') {
            try {
                response = await fetch(`${endpoint}/image-models`, { method: 'GET', headers });
                if (!response.ok) response = null;
            } catch (e) {
                response = null;
            }
        }
        if (!response) {
            response = await fetch(`${endpoint}/models`, { method: 'GET', headers });
        }

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

    // Character Gen budgets are fixed per call (there is no setting for them),
    // so do not send the user looking for one.
    const msg = `${context} hit the token limit and was cut off. Try again, or shorten the input.`;
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

  // Free check for the status badge. It lists models instead of generating,
  // because the badge refreshes on every page load and every settings save
  // (including each keystroke in the custom style box), and used to send a
  // paid "Respond with just OK" model call each time. It proves the endpoint is
  // up but not that the key works; Settings → Test Connection still makes a
  // real call for that. Results are reused until the URL or key changes.
  async checkTextApiReachable() {
    const baseUrl = (this.config.get("api.text.baseUrl") || "").replace(/\/$/, "");
    const apiKey = this.config.get("api.text.apiKey");
    if (!apiKey) return { success: false, error: "No API key configured" };
    if (!baseUrl) return { success: false, error: "No API base URL configured" };

    const cacheKey = `${baseUrl}|${apiKey}`;
    const cached = this._reachableCache;
    if (cached && cached.key === cacheKey && Date.now() - cached.at < 5 * 60 * 1000) return cached.result;
    if (cached?.pending && cached.key === cacheKey) return cached.pending;

    const pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        return res.ok ? { success: true } : { success: false, error: `HTTP ${res.status}` };
      } catch (error) {
        return { success: false, error: error.name === "AbortError" ? "Timed out" : error.message };
      } finally {
        clearTimeout(timer);
      }
    })();
    this._reachableCache = { key: cacheKey, pending };
    const result = await pending;
    // Only a success is reused; a failure is re-checked next time.
    this._reachableCache = result.success ? { key: cacheKey, at: Date.now(), result } : null;
    return result;
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

  /** Snapshot to compare against later with throwIfStopped(). */
  stopMark() {
    return this.stopSerial;
  }

  /**
   * For multi-step flows: throw if Stop was pressed since `mark` was taken.
   * Needed because a Stop between two requests has nothing in flight to abort,
   * and the next request would otherwise carry on as if it never happened.
   */
  throwIfStopped(mark) {
    if (this.stopSerial !== mark) throw new Error("Generation stopped by user.");
  }

  /** Abort resumable jobs on the server; dropping the socket leaves them running. */
  _cancelServerJobs() {
    const refs = Array.from(this.activeClientRefs);
    if (!refs.length) return;
    for (const ref of refs) window.ResumableJobs?.remove(ref);
    (window.authFetch || fetch)("/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this._authHeaders() },
      body: JSON.stringify({ clientRefs: refs }),
    }).catch((err) => console.warn("[API] job cancel failed:", err?.message || err));
  }

  stopGeneration() {
    this.userStopRequested = true;
    this.stopSerial++;
    this._cancelServerJobs();
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

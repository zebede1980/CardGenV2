// Evaluated INSIDE the prompt-host sandbox (see prompt-host.js), not required
// by Node. It is the server's stand-in for the browser's APIHandler class
// (src/scripts/api.js): the same method names with server-side bodies, so the
// prompt files that extend APIHandler.prototype (api-character.js and friends)
// run here unchanged. `__host` is the bridge the proxy injects.

class APIHandler {
  constructor() {
    this.config = window.config;
    this.lastFinishReason = null;
    this.lastStreamStats = null;
    this.lastGeneratedImagePrompt = null;
    this.userStopRequested = false;
    this.stopSerial = 0;
  }

  /**
   * Same contract as the page's makeRequest. A streamed call returns a handle
   * that handleStreamResponse runs; a non-streamed one returns the provider's
   * JSON shape. The page-only fields (resumable, clientRef, __jobLabel) are
   * dropped: nothing here needs a job buffer, the run itself is the buffer.
   */
  async makeRequest(endpoint, data, isImageRequest = false, stream = false) {
    const { resumable, clientRef, __jobLabel, ...body } = data;
    if (isImageRequest) {
      // The page gets a fetch Response here and calls .ok / .json() on it.
      const result = await __host.callImage(body);
      return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
    }
    if (Array.isArray(body.messages)) body.messages = withContentContext(body.messages);
    if (stream) return { __serverCall: { body: { ...body, stream: true }, label: __jobLabel || "" } };

    const result = await __host.callText({ ...body, stream: false }, { label: __jobLabel || "" });
    return {
      choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: result.finishReason }],
      usage: result.usage || undefined,
    };
  }

  async handleStreamResponse(response, onStream, { warnOnTruncation = true } = {}) {
    const call = response && response.__serverCall;
    if (!call) throw new Error("handleStreamResponse was given something that is not a server call");
    let fullContent = "";
    const result = await __host.callText(call.body, {
      label: call.label,
      onContent: (delta) => {
        fullContent += delta;
        if (onStream) onStream(delta, fullContent);
      },
    });
    this.lastStreamStats = {
      finishReason: result.finishReason,
      contentChars: fullContent.length,
      reasoningChars: result.reasoningChars || 0,
    };
    if (warnOnTruncation) this.noteFinishReason(result.finishReason);
    else this.lastFinishReason = result.finishReason || null;
    return fullContent;
  }

  async streamedText(data, label, { onStream = null, endpoint = "/chat/completions", warnOnTruncation = true } = {}) {
    const request = { ...data, stream: true, resumable: true, __jobLabel: label };
    const response = await this.makeRequest(endpoint, request, false, true);
    return this.handleStreamResponse(response, onStream || (() => {}), { warnOnTruncation });
  }

  noteFinishReason(finishReason, context = "The response") {
    this.lastFinishReason = finishReason || null;
    if (finishReason === "length") __host.warn(`${context} hit the token limit and was cut off.`);
  }

  processNormalResponse(response) {
    const choice = response && response.choices && response.choices[0];
    if (!choice || !choice.message) return "";
    this.noteFinishReason(choice.finish_reason);
    return choice.message.content || "";
  }

  // The page retries a 401 with other auth headers; the proxy has already done that.
  async tryAlternativeAuth() {
    throw new Error("Authorization Error: the text API rejected the key");
  }

  _authHeaders() {
    return {};
  }

  stopMark() {
    return this.stopSerial;
  }

  throwIfStopped(mark) {
    if (this.stopSerial !== mark) throw new Error("Generation stopped by user");
  }
}

window.apiHandler = new APIHandler();

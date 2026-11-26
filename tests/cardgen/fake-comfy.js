// A fake ComfyUI for the local-GPU tests: /system_stats, /upload/image,
// /prompt (records each workflow), /history, /view. Every job succeeds unless
// `state.failNext` names an error; `state.holdNext()` keeps the next job
// running until released; `state.png` is the picture /view returns.
const http = require("http");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function startComfy({ apiKey = "comfy-key" } = {}) {
  const state = { prompts: [], uploads: [], hold: null, failNext: null, png: Buffer.from(PNG_B64, "base64") };
  state.holdNext = () => {
    let release;
    const gate = new Promise((r) => (release = r));
    state.hold = { gate, release, reached: false };
    return state.hold;
  };
  const done = new Map();
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-api-key"] !== apiKey) return json(401, {});
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === "/system_stats") return json(200, { system: {} });
    if (req.url === "/upload/image") {
      state.uploads.push(body);
      return json(200, { name: `up${state.uploads.length}.png`, subfolder: "cardgen" });
    }
    if (req.url === "/prompt") {
      const id = `p${state.prompts.length + 1}`;
      state.prompts.push({ id, graph: JSON.parse(body.toString()).prompt });
      const hold = state.hold;
      state.hold = null;
      const fail = state.failNext;
      state.failNext = null;
      if (hold) { hold.reached = true; hold.gate.then(() => done.set(id, fail)); }
      else done.set(id, fail);
      return json(200, { prompt_id: id });
    }
    const history = req.url.match(/^\/history\/(.+)$/);
    if (history) {
      const id = decodeURIComponent(history[1]);
      if (!done.has(id)) return json(200, {});
      const fail = done.get(id);
      if (fail) return json(200, { [id]: { status: { completed: false, status_str: "error", messages: [["execution_error", { exception_message: fail }]] } } });
      return json(200, { [id]: { status: { completed: true, status_str: "success" }, outputs: { 56: { images: [{ filename: "out.png", subfolder: "cardgen", type: "output" }] } } } });
    }
    if (req.url.startsWith("/view")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(state.png); }
    if (req.url === "/queue" || req.url === "/interrupt") return json(200, {});
    json(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state, apiKey })));
}

module.exports = { startComfy, PNG_B64 };

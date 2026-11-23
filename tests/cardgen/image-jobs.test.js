// Image requests sent again under the same clientRef, through the real proxy,
// no browser: see README.md for how to run. A page that gives up on a slow
// edit and retries must join the job already drawing it (one paid call), and
// a lookup by clientRef must hand back the finished job, not a newer duplicate.
const os = require("os");
const path = require("path");
const { start, sleep } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 500) : "")); }
};
const until = async (fn, { timeout = 15000, step = 40, what = "condition" } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(step);
  }
};

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage-imagejobs") });
  const { api, token, model, url } = stack;
  const IMG = { "X-API-Key": "fake-image-key", "X-API-URL": stack.modelUrl };
  const body = (clientRef) => ({ model: "fake-image", prompt: "make it night", image: model.imageDataUrl, resumable: true, clientRef });
  const edit = (clientRef, t = token) => api("POST", "/api/image/generations", body(clientRef), t, IMG);
  // A request the page gives up on: sent, then its connection closed.
  const abandoned = (clientRef) => {
    const controller = new AbortController();
    const sent = fetch(url + "/api/image/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...IMG },
      body: JSON.stringify(body(clientRef)),
      signal: controller.signal,
    }).catch(() => null);
    return { abort: () => controller.abort(), sent };
  };
  const jobsFor = async (ref) => (await api("GET", `/api/jobs?clientRef=${ref}`, undefined, token)).json.jobs;

  try {
    // 1. Retry while the first is still drawing: joins it, one model call.
    let hold = model.hold("image");
    const first = abandoned("ref-a");
    await until(() => hold.reached, { what: "first edit at the model" });
    first.abort();
    await first.sent;
    await sleep(100);
    const retry = edit("ref-a");
    await sleep(300);
    check("a retry while drawing makes no second model call", model.count("image") === 1, model.count("image"));
    hold.release();
    let r = await retry;
    check("the retry gets the first job's picture", r.status === 200 && r.json?.data?.[0]?.url === model.imageDataUrl, r.text.slice(0, 200));
    check("one job for the ref", (await jobsFor("ref-a")).length === 1);
    check("the proxy says it joined", stack.proxyLogs.join("").includes("repeat request joined running image job"));

    // 2. Retry after it finished: the held result, no model call.
    r = await edit("ref-a");
    check("a retry after it finished gets the picture without a model call", r.status === 200 && r.json?.data?.[0]?.url === model.imageDataUrl && model.count("image") === 1, model.count("image"));

    // 3. A ref whose job failed starts afresh, and the lookup prefers the
    //    finished job over the failed one, then the running one over the failed.
    model.failNext.image = 500;
    r = await edit("ref-b");
    check("a failed edit fails", r.status === 500, r.status);
    hold = model.hold("image");
    const again = edit("ref-b");
    await until(() => hold.reached, { what: "second edit at the model" });
    check("a retry after a failure draws again", model.count("image") === 3, model.count("image"));
    let jobs = await jobsFor("ref-b");
    check("lookup: running before failed", jobs.length === 2 && jobs[0].status === "running" && jobs[1].status === "error", JSON.stringify(jobs));
    hold.release();
    r = await again;
    check("the fresh attempt lands", r.status === 200);
    jobs = await jobsFor("ref-b");
    check("lookup: done before failed", jobs[0].status === "done" && jobs[1].status === "error", JSON.stringify(jobs));

    // 4. A joined request hears about a failure too.
    hold = model.hold("image");
    const doomed = abandoned("ref-c");
    await until(() => hold.reached, { what: "third edit at the model" });
    doomed.abort();
    await doomed.sent;
    const joined = edit("ref-c");
    await sleep(200);
    model.failNext.image = 500;
    hold.release();
    r = await joined;
    check("a joined request gets the job's error", r.status === 502 && /Image API Error: 500/.test(r.json?.error?.message || ""), r.text.slice(0, 200));
    check("still no extra model call", model.count("image") === 4, model.count("image"));

    // 5. Another user's request with the same ref is its own job.
    const other = await stack.register();
    r = await edit("ref-a", other.token);
    check("another user with the same ref is not joined to it", r.status === 200 && model.count("image") === 5, model.count("image"));

    // 6. Not resumable: never joined.
    r = await api("POST", "/api/image/generations", { ...body("ref-a"), resumable: false }, token, IMG);
    check("a non-resumable request always draws", r.status === 200 && model.count("image") === 6, model.count("image"));
  } catch (err) {
    failed++;
    console.log("FAIL (threw) " + err.stack);
  } finally {
    await stack.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

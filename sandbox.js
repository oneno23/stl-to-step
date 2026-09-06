// Runs inside the sandboxed iframe (see manifest.json "sandbox.pages" and
// the comment in sandbox.html). This file no longer does the OpenCASCADE
// work itself -- it just relays messages between the parent page and a
// dedicated Worker (sandbox-worker.js), which now runs the actual
// conversion. All the OC logic lives there unchanged; only its thread
// changed.
//
// Why: sewing.Perform() (inside sandbox-worker.js) is a single, fully
// synchronous WASM call that can run for many minutes on dense meshes,
// with no way to yield mid-call. This iframe is same-origin with the
// parent page, and same-origin same-site frames share ONE renderer
// process and one main JS thread in Chrome -- so when that call used to
// run directly in this iframe, it blocked the parent page's thread too.
// That's exactly what real user testing surfaced with a 234,826-triangle
// mesh: Chrome's "page isn't responding" dialog popping up mid-conversion,
// and the parent's own "still working..." heartbeat log going silent
// during the block (queued on the same blocked thread, unable to run)
// even though the conversion was proceeding normally underneath.
//
// A Worker is a genuine separate thread, so running the heavy work there
// keeps this shared main thread free for the whole conversion: no hang
// dialog, and the parent's heartbeat keeps ticking on schedule.
let worker = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker("sandbox-worker.js", { type: "module" });
  const sources = new Map(); // requestId -> the window to relay each response to
  worker.sources = sources;
  worker.addEventListener("message", (event) => {
    const payload = event.data;
    if (!payload || !payload.requestId) return;
    const source = sources.get(payload.requestId);
    if (!source) return;
    const transfer = payload.buffer ? [payload.buffer] : [];
    source.postMessage(payload, "*", transfer);
    if (payload.type === "done" || payload.type === "error") {
      sources.delete(payload.requestId);
    }
  });
  return worker;
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "convert") {
    const w = getWorker();
    w.sources.set(msg.requestId, event.source);
    w.postMessage(msg, [msg.vertices.buffer, msg.faces.buffer]);
  }
});

if (window.parent) {
  window.parent.postMessage({ type: "sandbox-ready" }, "*");
}

// Runs inside the sandboxed iframe (see manifest.json "sandbox.pages" and
// the comment in sandbox.html). Receives a mesh from the parent page via
// postMessage, builds a sewn BREP solid with OpenCASCADE-WASM, writes it to
// STEP, and posts the resulting bytes back.

const OCJS_BASE = "./vendor/opencascade/";
// El .wasm de OpenCASCADE pesa ~50 MB, muy por encima de lo que el subidor
// web de GitHub acepta de una vez (necesario para poder alojar este sitio
// sin usar git por línea de comandos -- con archivos de ~20 MB seguía
// fallando con "file too large", así que se ha bajado el tamaño de cada
// trozo a 5 MB para tener margen de sobra). Se divide en partes pequeñas al
// empaquetar, y aquí se descargan todas en orden y se unen en un único
// ArrayBuffer antes de pasarlo como wasmBinary -- el resultado final es
// exactamente el mismo binario, solo cambia cómo se transporta.
const WASM_PART_COUNT = 11;
const WASM_PARTS = Array.from({ length: WASM_PART_COUNT }, (_, i) =>
  "opencascade.full.wasm.part" + String(i).padStart(2, "0")
);
let ocPromise = null;

async function loadWasmBinary(onLog) {
  const buffers = [];
  let total = 0;
  for (let i = 0; i < WASM_PARTS.length; i++) {
    onLog(`Descargando OpenCASCADE (parte ${i + 1}/${WASM_PARTS.length})...`);
    const resp = await fetch(OCJS_BASE + WASM_PARTS[i]);
    if (!resp.ok) throw new Error(`No se pudo descargar ${WASM_PARTS[i]} (HTTP ${resp.status})`);
    const buf = await resp.arrayBuffer();
    buffers.push(buf);
    total += buf.byteLength;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return combined.buffer;
}

async function loadOC(onLog) {
  if (ocPromise) return ocPromise;
  ocPromise = (async () => {
    onLog("Cargando OpenCASCADE (WebAssembly)...");
    const mod = await import(OCJS_BASE + "opencascade.full.js");
    const ocFullJS = mod.default;
    const wasmBinary = await loadWasmBinary(onLog);
    const oc = await new ocFullJS({ wasmBinary });
    onLog("OpenCASCADE listo.", "ok");
    return oc;
  })();
  return ocPromise;
}

function yieldFrame() {
  return new Promise((r) => setTimeout(r, 0));
}

async function handleConvert(msg, respond) {
  const { requestId, vertices, faces, outName } = msg;
  const post = (type, extra) => respond({ type, requestId, ...extra });
  const log = (text, cls) => post("log", { text, cls });
  const progress = (pct) => post("progress", { pct });

  try {
    const oc = await loadOC(log);
    progress(10);

    const nVerts = vertices.length / 3;
    const gpPnts = new Array(nVerts);
    for (let i = 0; i < nVerts; i++) {
      gpPnts[i] = new oc.gp_Pnt_3(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
    }

    const nFaces = faces.length / 3;
    log(`Construyendo ${nFaces} caras...`);
    const sewing = new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
    let built = 0;
    for (let fi = 0; fi < nFaces; fi++) {
      const a = faces[fi * 3], b = faces[fi * 3 + 1], c = faces[fi * 3 + 2];
      const poly = new oc.BRepBuilderAPI_MakePolygon_1();
      poly.Add_1(gpPnts[a]); poly.Add_1(gpPnts[b]); poly.Add_1(gpPnts[c]); poly.Close();
      if (poly.IsDone()) {
        const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true);
        if (faceMaker.IsDone()) sewing.Add(faceMaker.Face());
      }
      built++;
      if (built % 1500 === 0) {
        progress(10 + 40 * built / nFaces);
        log(`  ${built}/${nFaces} caras...`);
        await yieldFrame();
      }
    }
    log(`Caras listas: ${built}.`);
    progress(50);
    await yieldFrame();

    // sewing.Perform() below is a single synchronous WASM call: it blocks this whole
    // page (no progress events, no way to yield mid-call) until it finishes, which can
    // take several minutes for meshes with tens of thousands of triangles -- each
    // triangle becomes its own independently-built face, and stitching them all back
    // together is expensive at that scale. Measured on a real 22944-triangle model:
    // ~5 minutes just for this step. Without a warning the page just looks frozen at
    // 50%, which is exactly what got reported as "se queda a la mitad" -- it wasn't
    // actually stuck, it just needed several more minutes with no visible sign of life.
    // ~13.8 ms/face is the empirical rate from that test; used here as a rough estimate,
    // not a precise ETA (real time depends on mesh shape, not just triangle count).
    const estSeconds = Math.round(built * 0.0138);
    const estText = estSeconds < 20
      ? ""
      : estSeconds < 90
        ? ` (estimado ~${estSeconds}s, no cierres esta pestaña)`
        : ` (estimado ~${Math.round(estSeconds / 60)} min, no cierres esta pestaña)`;
    log(`Cosiendo superficie${estText}...`);
    sewing.Perform(new oc.Message_ProgressRange_1());
    const sewed = sewing.SewedShape();
    progress(75);
    await yieldFrame();

    let shapeToWrite = sewed;
    const explorer = new oc.TopExp_Explorer_2(sewed, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    if (explorer.More()) {
      const shell = oc.TopoDS.Shell_1(explorer.Current());
      const solidMaker = new oc.BRepBuilderAPI_MakeSolid_3(shell);
      if (solidMaker.IsDone()) {
        shapeToWrite = solidMaker.Solid();
        log("Solido cerrado construido.", "ok");
      } else {
        log("No se pudo cerrar como solido; se exporta como superficie cosida.", "warn");
      }
    } else {
      log("No se detecto una superficie cerrada; se exporta tal cual.", "warn");
    }
    progress(85);
    await yieldFrame();

    log("Exportando a STEP...");
    const writer = new oc.STEPControl_Writer_1();
    writer.Transfer(shapeToWrite, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange_1());
    const virtualName = "output.step";
    writer.Write(virtualName);
    const data = oc.FS.readFile(virtualName);
    progress(100);
    log(`STEP generado: ${(data.length / 1024 / 1024).toFixed(1)} MB.`, "ok");

    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    respond({ type: "done", requestId, buffer: buf, byteLength: data.length, outName }, [buf]);
  } catch (err) {
    respond({
      type: "error",
      requestId,
      message: err && err.stack ? err.stack : String((err && err.message) || err),
    });
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  const respond = (payload, transfer) => {
    // event.source is the parent window that sent us the message.
    event.source.postMessage(payload, "*", transfer || []);
  };
  if (msg.type === "convert") {
    handleConvert(msg, respond);
  }
});

if (window.parent) {
  window.parent.postMessage({ type: "sandbox-ready" }, "*");
}

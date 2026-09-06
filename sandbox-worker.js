// Runs inside a dedicated Worker spawned by sandbox.js (see the comment
// there for why: this is the actual OpenCASCADE/WASM engine, moved out of
// the sandboxed iframe's own thread and into a real background thread).
//
// Nothing in this file is new logic -- it's the same conversion pipeline
// that used to run directly in sandbox.js, unchanged. Only *where* it runs
// changed. See sandbox.js for the message-relay side of this split.

// Todos los archivos viven en el mismo directorio plano (sin subcarpetas
// vendor/...): el subidor web de GitHub aplana la estructura de carpetas al
// arrastrar archivos sueltos (solo la conserva arrastrando carpetas reales
// desde el explorador, poco fiable en la práctica), así que este sitio se
// empaqueta ya así a propósito para no depender de eso.
const OCJS_BASE = "./";
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
    onLog(`Downloading OpenCASCADE (part ${i + 1}/${WASM_PARTS.length})...`);
    const resp = await fetch(OCJS_BASE + WASM_PARTS[i]);
    if (!resp.ok) throw new Error(`Could not download ${WASM_PARTS[i]} (HTTP ${resp.status})`);
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
    onLog("Loading OpenCASCADE (WebAssembly)...");
    const mod = await import(OCJS_BASE + "opencascade.full.js");
    const ocFullJS = mod.default;
    const wasmBinary = await loadWasmBinary(onLog);
    const oc = await new ocFullJS({ wasmBinary });
    onLog("OpenCASCADE ready.", "ok");
    return oc;
  })();
  return ocPromise;
}

function yieldFrame() {
  return new Promise((r) => setTimeout(r, 0));
}

function countFaces(oc, shape) {
  const explorer = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  while (explorer.More()) { n++; explorer.Next(); }
  return n;
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
    log(`Building ${nFaces} faces...`);
    const sewing = new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
    let built = 0;
    // These three counters exist because, before this fix, a triangle that failed to become
    // a valid OpenCASCADE face was silently dropped here with zero visibility: the old log
    // line ("Faces ready: N.") just reported how many triangles were *attempted*, not how many
    // actually made it into the surface. A real 234826-triangle model hit this -- most of its
    // faces failed silently, sewing had almost nothing to work with, and the exported STEP
    // came out at 10 KB while every log line still read as a normal success. Counting and
    // reporting failures here is what would have caught that immediately instead of shipping
    // a near-empty file that looked fine.
    let addedCount = 0;
    let polyFailCount = 0;
    let faceFailCount = 0;
    for (let fi = 0; fi < nFaces; fi++) {
      const a = faces[fi * 3], b = faces[fi * 3 + 1], c = faces[fi * 3 + 2];
      const poly = new oc.BRepBuilderAPI_MakePolygon_1();
      poly.Add_1(gpPnts[a]); poly.Add_1(gpPnts[b]); poly.Add_1(gpPnts[c]); poly.Close();
      if (poly.IsDone()) {
        const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true);
        if (faceMaker.IsDone()) { sewing.Add(faceMaker.Face()); addedCount++; }
        else faceFailCount++;
      } else {
        polyFailCount++;
      }
      built++;
      if (built % 1500 === 0) {
        progress(10 + 40 * built / nFaces);
        log(`  ${built}/${nFaces} faces...`);
        await yieldFrame();
      }
    }
    const failedCount = polyFailCount + faceFailCount;
    if (failedCount > 0) {
      const failPct = ((failedCount / nFaces) * 100).toFixed(1);
      log(
        `Faces ready: ${addedCount}/${nFaces} added to the surface (${failedCount} triangle${failedCount === 1 ? "" : "s"} skipped, ~${failPct}% -- ${polyFailCount} invalid polygon, ${faceFailCount} invalid face; usually near-zero-area or duplicate-vertex triangles). Continuing with the rest of the mesh.`,
        "warn"
      );
    } else {
      log(`Faces ready: ${built}.`);
    }
    progress(50);
    await yieldFrame();

    // sewing.Perform() below is a single synchronous WASM call: it never returns control
    // to this worker's own event loop until it finishes, which can take several minutes
    // for meshes with tens of thousands of triangles -- each triangle becomes its own
    // independently-built face, and stitching them all back together is expensive at that
    // scale. Measured on a real 22944-triangle model: ~5 minutes just for this step.
    // Running inside a dedicated Worker (rather than directly in the sandboxed iframe, as
    // before) is exactly what keeps this block from freezing anything visible: the iframe
    // and the parent page share one main thread and would both stall for the whole call,
    // which is what produced Chrome's "page isn't responding" dialog during real user
    // tests with a 234,826-triangle mesh -- this worker thread is separate, so that shared
    // main thread stays free the entire time and the parent page's own "still working..."
    // heartbeat log keeps ticking normally instead of queuing up behind a blocked thread.
    // ~13.8 ms/face is the empirical rate from that earlier test; used here as a rough
    // estimate, not a precise ETA (real time depends on mesh shape, not just triangle count).
    const estSeconds = Math.round(built * 0.0138);
    const estText = estSeconds < 20
      ? ""
      : estSeconds < 90
        ? ` (estimated ~${estSeconds}s, don't close this tab)`
        : ` (estimated ~${Math.round(estSeconds / 60)} min, don't close this tab)`;
    log(`Sewing surface${estText}...`);
    sewing.Perform(new oc.Message_ProgressRange_1());
    const sewed = sewing.SewedShape();
    progress(75);
    await yieldFrame();

    // Sewing can legitimately split into more than one separate shell -- most often because
    // some faces above got skipped (a gap in the mesh disconnects what would otherwise be one
    // continuous surface), occasionally because the mesh genuinely has more than one physical
    // piece. The old code just took whichever shell TopExp_Explorer happened to return first
    // and silently discarded every other one -- if that first shell was a small leftover
    // fragment, the exported STEP was tiny even though "Closed solid built." still logged as
    // a normal success. This now looks at every shell, keeps the largest (by face count), and
    // says so out loud when anything got left out, instead of failing the whole conversion --
    // a mesh that's 99% fine shouldn't be blocked over a handful of bad triangles.
    let shapeToWrite = sewed;
    const shellExplorer = new oc.TopExp_Explorer_2(sewed, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let shellCount = 0;
    let bestShell = null;
    let bestFaceCount = -1;
    let totalFacesInShells = 0;
    while (shellExplorer.More()) {
      shellCount++;
      const shell = oc.TopoDS.Shell_1(shellExplorer.Current());
      let faceCountInShell = 0;
      const faceExplorer = new oc.TopExp_Explorer_2(shell, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      while (faceExplorer.More()) { faceCountInShell++; faceExplorer.Next(); }
      totalFacesInShells += faceCountInShell;
      if (faceCountInShell > bestFaceCount) { bestFaceCount = faceCountInShell; bestShell = shell; }
      shellExplorer.Next();
    }
    if (shellCount === 0) {
      log("No closed surface detected; exporting as-is.", "warn");
    } else {
      if (shellCount > 1) {
        const keptPct = totalFacesInShells > 0 ? Math.round((100 * bestFaceCount) / totalFacesInShells) : 0;
        log(
          `The sewn surface split into ${shellCount} separate pieces instead of one -- keeping only the largest (${bestFaceCount} of ${totalFacesInShells} sewn faces, ~${keptPct}%). This usually happens when a gap from skipped/bad triangles disconnects part of the mesh. The smaller, discarded piece(s) are NOT in the exported STEP.`,
          "warn"
        );
      }
      const solidMaker = new oc.BRepBuilderAPI_MakeSolid_3(bestShell);
      if (solidMaker.IsDone()) {
        shapeToWrite = solidMaker.Solid();
        log("Closed solid built.", "ok");
      } else {
        shapeToWrite = bestShell;
        log("Could not close as a solid; exporting as a sewn surface.", "warn");
      }
    }
    progress(85);
    await yieldFrame();

    // Every triangle became its own independent planar face above, each with its own local
    // plane placement -- so even a mesh with large flat areas (extremely common in printed
    // parts) exports one ADVANCED_FACE, one plane, and one set of axis entities *per triangle*
    // in the STEP text, none of which is shared between faces even though the underlying
    // geometry is identical. That's what made a real 50,000-triangle model export as a 125.5 MB
    // STEP that Shapr3D couldn't open: the file size scales with triangle count, not with the
    // actual shape complexity. ShapeUpgrade_UnifySameDomain finds adjacent faces that lie on the
    // exact same surface (a flat region built from many coplanar triangles) and merges them into
    // a single face with a single boundary -- on a 10x10 flat grid (200 triangles, one big flat
    // square) this took the STEP from 429 KB down to 4.6 KB (99% smaller, 200 faces to 1),
    // verified against this exact build before shipping. It leaves genuinely curved/faceted
    // regions alone (adjacent triangles at different angles are not "the same domain"), and
    // preserves the shape exactly -- verified on a unit cube (12 faces -> 6, one per side,
    // volume unchanged) and a faceted sphere (800 faces -> 440, surface area unchanged to 12
    // significant digits). If it fails for any reason, the un-merged shape is exported instead
    // (larger file, but never a blocked conversion) rather than the whole thing failing.
    log("Merging coplanar faces to reduce file size...");
    try {
      const facesBeforeUnify = countFaces(oc, shapeToWrite);
      const unify = new oc.ShapeUpgrade_UnifySameDomain_1();
      unify.Initialize(shapeToWrite, true, true, false);
      unify.Build();
      const unifiedShape = unify.Shape();
      const facesAfterUnify = countFaces(oc, unifiedShape);
      shapeToWrite = unifiedShape;
      if (facesAfterUnify < facesBeforeUnify) {
        const mergedPct = Math.round(100 * (1 - facesAfterUnify / facesBeforeUnify));
        log(`Faces merged: ${facesBeforeUnify} -> ${facesAfterUnify} (~${mergedPct}% fewer faces, smaller STEP file).`, "ok");
      } else {
        log("No coplanar faces to merge (shape is fully curved/faceted).");
      }
    } catch (err) {
      log("Could not merge coplanar faces, exporting the unmerged shape instead (larger file).", "warn");
    }
    progress(90);
    await yieldFrame();

    log("Exporting to STEP...");
    const writer = new oc.STEPControl_Writer_1();
    writer.Transfer(shapeToWrite, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange_1());
    const virtualName = "output.step";
    writer.Write(virtualName);
    const data = oc.FS.readFile(virtualName);
    progress(100);
    log(`STEP generated: ${(data.length / 1024 / 1024).toFixed(1)} MB.`, "ok");

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

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "convert") {
    const respond = (payload, transfer) => self.postMessage(payload, transfer || []);
    handleConvert(msg, respond);
  }
});

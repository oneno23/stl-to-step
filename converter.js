import * as THREE from "./three.module.js";
import { OrbitControls } from "./OrbitControls.js";

// ---------------------------------------------------------------------
// STL parsing
// ---------------------------------------------------------------------
function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const byteLength = buffer.byteLength;

  function isBinary() {
    if (byteLength < 84) return false;
    const triCount = dv.getUint32(80, true);
    const expected = 84 + triCount * 50;
    if (expected === byteLength) return true;
    const head = new TextDecoder().decode(buffer.slice(0, Math.min(512, byteLength)));
    return !/^\s*solid/i.test(head);
  }

  const rawTris = [];

  if (isBinary()) {
    const triCount = dv.getUint32(80, true);
    let offset = 84;
    for (let i = 0; i < triCount; i++) {
      offset += 12;
      const tri = [];
      for (let v = 0; v < 3; v++) {
        const x = dv.getFloat32(offset, true); offset += 4;
        const y = dv.getFloat32(offset, true); offset += 4;
        const z = dv.getFloat32(offset, true); offset += 4;
        tri.push([x, y, z]);
      }
      offset += 2;
      rawTris.push(tri);
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const vertRe = /vertex\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)/g;
    let m, cur = [];
    while ((m = vertRe.exec(text)) !== null) {
      cur.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
      if (cur.length === 3) { rawTris.push(cur); cur = []; }
    }
  }
  return rawTris;
}

// ---------------------------------------------------------------------
// 3MF parsing (ZIP + XML). Handles both the simple case (an <object> with
// an inline <mesh>, referenced directly by a <build><item>) and the
// "Production Extension" pattern used by Bambu Studio / MakerWorld
// exports for multi-part models: the root 3D/3dmodel.model has no inline
// mesh at all, just <build> items and/or <components> that point (via a
// p:path attribute) at separate per-part files under 3D/Objects/*.model,
// possibly nested (a component whose own object is itself just more
// components). Each level can carry its own <transform>, which must be
// composed and applied to the leaf mesh's vertices. Missing this pattern
// is why a naive single-file mesh scan finds zero triangles for these
// files ("no contiene triangulos reconocibles").
// ---------------------------------------------------------------------
function getAttrLocal(el, localName) {
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    if (attr.localName === localName || attr.name === localName || attr.name.endsWith(":" + localName)) {
      return attr.value;
    }
  }
  return null;
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// 3MF transform attribute: 12 space-separated values
// "M00 M01 M02 M10 M11 M12 M20 M21 M22 M30 M31 M32" representing the 4x4
//   | M00 M01 M02 0 |
//   | M10 M11 M12 0 |
//   | M20 M21 M22 0 |
//   | M30 M31 M32 1 |
// applied to a row-vector: v' = v * M.
function parseTransform(str) {
  if (!str) return identityMatrix();
  const n = str.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(Number.isNaN)) return identityMatrix();
  return [n[0], n[1], n[2], 0, n[3], n[4], n[5], 0, n[6], n[7], n[8], 0, n[9], n[10], n[11], 1];
}

// Row-vector convention (v' = v*A), so chaining child-then-parent is
// v' = (v*Achild)*Aparent = v*(Achild*Aparent) -> combined = Achild*Aparent.
function multiplyMatrices(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = s;
    }
  }
  return r;
}

function applyMatrix(p, m) {
  const x = p[0], y = p[1], z = p[2];
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ];
}

async function parse3MF(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const normalizePath = (p) => (p ? p.replace(/^\/+/, "") : null);

  const docCache = new Map();
  async function loadModelDoc(path) {
    const key = path || "3D/3dmodel.model";
    if (docCache.has(key)) return docCache.get(key);
    let entry = zip.file(key);
    if (!entry) {
      const found = Object.keys(zip.files).find((n) => n.toLowerCase() === key.toLowerCase());
      if (found) entry = zip.file(found);
    }
    if (!entry) { docCache.set(key, null); return null; }
    const xmlText = await entry.async("text");
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) { docCache.set(key, null); return null; }
    docCache.set(key, xml);
    return xml;
  }

  function findObject(xml, id) {
    const objects = xml.getElementsByTagName("object");
    for (let i = 0; i < objects.length; i++) {
      if (objects[i].getAttribute("id") === id) return objects[i];
    }
    return null;
  }

  const rawTris = [];
  const visiting = new Set(); // guards against pathological circular component refs

  async function resolveObject(docPath, xml, objectId, matrix) {
    const guardKey = docPath + "#" + objectId;
    if (visiting.has(guardKey)) return;
    visiting.add(guardKey);
    try {
      const obj = findObject(xml, objectId);
      if (!obj) return;

      const meshEl = obj.getElementsByTagName("mesh")[0];
      if (meshEl) {
        const verticesEl = meshEl.getElementsByTagName("vertices")[0];
        const trianglesEl = meshEl.getElementsByTagName("triangles")[0];
        if (verticesEl && trianglesEl) {
          const vertexNodes = verticesEl.getElementsByTagName("vertex");
          const verts = new Array(vertexNodes.length);
          for (let i = 0; i < vertexNodes.length; i++) {
            const v = vertexNodes[i];
            const p = [parseFloat(v.getAttribute("x")), parseFloat(v.getAttribute("y")), parseFloat(v.getAttribute("z"))];
            verts[i] = applyMatrix(p, matrix);
          }
          const triNodes = trianglesEl.getElementsByTagName("triangle");
          for (let i = 0; i < triNodes.length; i++) {
            const t = triNodes[i];
            const i1 = parseInt(t.getAttribute("v1"), 10);
            const i2 = parseInt(t.getAttribute("v2"), 10);
            const i3 = parseInt(t.getAttribute("v3"), 10);
            if (verts[i1] && verts[i2] && verts[i3]) rawTris.push([verts[i1], verts[i2], verts[i3]]);
          }
        }
      }

      const componentsEl = obj.getElementsByTagName("components")[0];
      if (componentsEl) {
        const comps = componentsEl.getElementsByTagName("component");
        for (let i = 0; i < comps.length; i++) {
          const comp = comps[i];
          const compId = comp.getAttribute("objectid");
          if (!compId) continue;
          const compPathRaw = getAttrLocal(comp, "path");
          const compMatrix = multiplyMatrices(parseTransform(comp.getAttribute("transform")), matrix);
          if (compPathRaw) {
            const compPath = normalizePath(compPathRaw);
            const compDoc = await loadModelDoc(compPath);
            if (compDoc) await resolveObject(compPath, compDoc, compId, compMatrix);
          } else {
            await resolveObject(docPath, xml, compId, compMatrix);
          }
        }
      }
    } finally {
      visiting.delete(guardKey);
    }
  }

  const rootDoc = await loadModelDoc("3D/3dmodel.model");
  if (!rootDoc) throw new Error("3D/3dmodel.model not found dentro del .3mf.");

  const buildEls = rootDoc.getElementsByTagName("build");
  const itemEls = buildEls.length ? buildEls[0].getElementsByTagName("item") : [];

  if (itemEls.length) {
    for (let i = 0; i < itemEls.length; i++) {
      const item = itemEls[i];
      const objectId = item.getAttribute("objectid");
      if (!objectId) continue;
      const itemPathRaw = getAttrLocal(item, "path");
      const itemMatrix = parseTransform(item.getAttribute("transform"));
      if (itemPathRaw) {
        const itemPath = normalizePath(itemPathRaw);
        const itemDoc = await loadModelDoc(itemPath);
        if (itemDoc) await resolveObject(itemPath, itemDoc, objectId, itemMatrix);
      } else {
        await resolveObject("3D/3dmodel.model", rootDoc, objectId, itemMatrix);
      }
    }
  } else {
    // No <build> section (unusual) -- fall back to resolving every root object directly.
    const objects = rootDoc.getElementsByTagName("object");
    for (let i = 0; i < objects.length; i++) {
      const id = objects[i].getAttribute("id");
      if (id) await resolveObject("3D/3dmodel.model", rootDoc, id, identityMatrix());
    }
  }

  if (!rawTris.length) {
    throw new Error(
      "The .3mf doesn't contain triangles de malla reconocibles tras seguir <build>/<components> " +
      "(incluyendo archivos externos en 3D/Objects/). Puede que use una variante del formato no soportada."
    );
  }
  return rawTris;
}

// ---------------------------------------------------------------------
// mesh utilities
// ---------------------------------------------------------------------
function buildMesh(rawTris, epsilon = 1e-5) {
  const vertMap = new Map();
  const vertices = [];
  const faces = [];
  const inv = 1 / epsilon;

  function indexOf(p) {
    const k = Math.round(p[0]*inv) + "_" + Math.round(p[1]*inv) + "_" + Math.round(p[2]*inv);
    let idx = vertMap.get(k);
    if (idx === undefined) { idx = vertices.length; vertices.push(p); vertMap.set(k, idx); }
    return idx;
  }

  for (const tri of rawTris) {
    const a = indexOf(tri[0]), b = indexOf(tri[1]), c = indexOf(tri[2]);
    if (a === b || b === c || a === c) continue;
    faces.push([a, b, c]);
  }
  return { vertices, faces };
}

function computeAdjacency(vertices, faces) {
  const adjacency = Array.from({ length: vertices.length }, () => new Set());
  const edgeSet = new Set();
  const edges = [];
  function addEdge(i, j) {
    const key = i < j ? i + "_" + j : j + "_" + i;
    if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([i, j]); }
    adjacency[i].add(j); adjacency[j].add(i);
  }
  for (const [a, b, c] of faces) { addEdge(a, b); addEdge(b, c); addEdge(c, a); }
  const degrees = adjacency.map(s => s.size);
  const edgeLengths = edges.map(([i, j]) => {
    const vi = vertices[i], vj = vertices[j];
    const dx = vi[0]-vj[0], dy = vi[1]-vj[1], dz = vi[2]-vj[2];
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  });
  return { adjacency, degrees, edges, edgeLengths };
}

function median(arr) {
  const s = [...arr].sort((a,b) => a-b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n-1)/2] : (s[n/2-1] + s[n/2]) / 2;
}
function mad(arr, med) { return median(arr.map(x => Math.abs(x - med))); }

function computeFrozenSet(vertices, degrees, edges, edgeLengths) {
  const medEdge = median(edgeLengths);
  const madEdge = mad(edgeLengths, medEdge) || medEdge * 0.5 || 1e-6;
  const edgeThreshold = medEdge + 6 * madEdge * 1.4826;
  const medDeg = median(degrees);
  const degreeThreshold = Math.max(10, medDeg * 1.8 + 4);

  const frozen = new Uint8Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) if (degrees[i] > degreeThreshold) frozen[i] = 1;
  edges.forEach(([i, j], idx) => { if (edgeLengths[idx] > edgeThreshold) { frozen[i]=1; frozen[j]=1; } });
  return { frozen, edgeThreshold, degreeThreshold };
}

function smoothMesh(vertices, adjacency, frozen, { lambda = 0.25, iterations = 30, maxDisp = 0.1 } = {}) {
  const n = vertices.length;
  const orig = vertices.map(p => p.slice());
  let verts = vertices.map(p => p.slice());
  const neighborArrays = adjacency.map(s => Array.from(s));

  if (maxDisp > 0) {
    for (let it = 0; it < iterations; it++) {
      const next = verts.map(p => p.slice());
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue;
        const nbrs = neighborArrays[i];
        if (nbrs.length === 0) continue;
        let ax=0, ay=0, az=0;
        for (const j of nbrs) { ax+=verts[j][0]; ay+=verts[j][1]; az+=verts[j][2]; }
        ax/=nbrs.length; ay/=nbrs.length; az/=nbrs.length;
        next[i][0] = verts[i][0] + lambda*(ax-verts[i][0]);
        next[i][1] = verts[i][1] + lambda*(ay-verts[i][1]);
        next[i][2] = verts[i][2] + lambda*(az-verts[i][2]);
      }
      verts = next;
    }
  }

  let maxD = 0, sumD = 0, clampedCount = 0;
  for (let i = 0; i < n; i++) {
    const dx = verts[i][0]-orig[i][0], dy = verts[i][1]-orig[i][1], dz = verts[i][2]-orig[i][2];
    let d = Math.sqrt(dx*dx+dy*dy+dz*dz);
    if (maxDisp > 0 && d > maxDisp && d > 0) {
      const scale = maxDisp/d;
      verts[i][0]=orig[i][0]+dx*scale; verts[i][1]=orig[i][1]+dy*scale; verts[i][2]=orig[i][2]+dz*scale;
      d = maxDisp; clampedCount++;
    }
    maxD = Math.max(maxD, d); sumD += d;
  }
  return { vertices: verts, stats: { maxDisp: maxD, meanDisp: sumD/n, clampedCount } };
}

function meshVolumeAndBBox(vertices, faces) {
  let vol = 0;
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  for (const p of vertices) for (let k=0;k<3;k++){ if(p[k]<min[k])min[k]=p[k]; if(p[k]>max[k])max[k]=p[k]; }
  for (const [a,b,c] of faces) {
    const va=vertices[a], vb=vertices[b], vc=vertices[c];
    vol += (va[0]*(vb[1]*vc[2]-vb[2]*vc[1]) - va[1]*(vb[0]*vc[2]-vb[2]*vc[0]) + va[2]*(vb[0]*vc[1]-vb[1]*vc[0]))/6;
  }
  return { volume: Math.abs(vol), extents: [max[0]-min[0], max[1]-min[1], max[2]-min[2]] };
}

// ---------------------------------------------------------------------
// 3D viewer (three.js)
// ---------------------------------------------------------------------
const Viewer = (() => {
  let scene, camera, renderer, controls, mesh, wireMesh, container;
  let dataSets = { original: null, smoothed: null };
  let ready = false;

  function init(containerEl) {
    container = containerEl;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight || 1, 0.01, 10000);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1.4, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);

    const material = new THREE.MeshStandardMaterial({
      color: 0x5b8def, metalness: 0.15, roughness: 0.55, flatShading: true, side: THREE.DoubleSide
    });
    const geometry = new THREE.BufferGeometry();
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const wireGeom = new THREE.BufferGeometry();
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x0b0d11, wireframe: true, transparent: true, opacity: 0.35 });
    wireMesh = new THREE.Mesh(wireGeom, wireMat);
    wireMesh.visible = false;
    scene.add(wireMesh);

    new ResizeObserver(onResize).observe(container);

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    ready = true;
  }

  function onResize() {
    if (!container || !renderer) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function buildPositions(vertices, faces) {
    const pos = new Float32Array(faces.length * 9);
    let p = 0;
    for (const [a, b, c] of faces) {
      const va = vertices[a], vb = vertices[b], vc = vertices[c];
      pos[p++] = va[0]; pos[p++] = va[1]; pos[p++] = va[2];
      pos[p++] = vb[0]; pos[p++] = vb[1]; pos[p++] = vb[2];
      pos[p++] = vc[0]; pos[p++] = vc[1]; pos[p++] = vc[2];
    }
    return pos;
  }

  function setData(faces, originalVertices, smoothedVertices) {
    dataSets.original = buildPositions(originalVertices, faces);
    dataSets.smoothed = buildPositions(smoothedVertices, faces);
    showDataset("smoothed");
    fitCameraToObject();
  }

  function showDataset(which) {
    if (!ready || !dataSets[which]) return;
    const posArray = dataSets[which];
    [mesh.geometry, wireMesh.geometry].forEach(g => {
      g.setAttribute("position", new THREE.BufferAttribute(posArray.slice(), 3));
      g.computeVertexNormals();
    });
  }

  function setWireframeVisible(v) { if (wireMesh) wireMesh.visible = v; }
  function setFlatShading(v) {
    if (!mesh) return;
    mesh.material.flatShading = v;
    mesh.material.needsUpdate = true;
  }

  function fitCameraToObject() {
    mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere;
    if (!sphere) return;
    const dist = sphere.radius / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.35;
    camera.position.copy(sphere.center).add(new THREE.Vector3(0.6, 0.5, 1).normalize().multiplyScalar(dist));
    camera.near = Math.max(dist / 100, 0.001);
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.update();
  }

  return { init, setData, showDataset, setWireframeVisible, setFlatShading, isReady: () => ready };
})();

// ---------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fnameEl = document.getElementById("fname");
const convertBtn = document.getElementById("convertBtn");
const maxDispSlider = document.getElementById("maxDisp");
const maxDispVal = document.getElementById("maxDispVal");
const progressPanel = document.getElementById("progressPanel");
const progressBar = document.getElementById("progressBar");
const logEl = document.getElementById("log");
const resultsPanel = document.getElementById("resultsPanel");
const statsTable = document.getElementById("statsTable");
const downloadBtn = document.getElementById("downloadBtn");
const viewerPanel = document.getElementById("viewerPanel");
const viewerToolbar = document.getElementById("viewerToolbar");
const viewerCanvasWrap = document.getElementById("viewerCanvasWrap");
const viewerLoading = document.getElementById("viewerLoading");
const viewerHint = document.getElementById("viewerHint");
const viewerTooLarge = document.getElementById("viewerTooLarge");
const viewOptSmoothed = document.getElementById("viewOptSmoothed");
const viewOptOriginal = document.getElementById("viewOptOriginal");
const viewWireframe = document.getElementById("viewWireframe");
const viewFlatShading = document.getElementById("viewFlatShading");
const zipPickerPanel = document.getElementById("zipPickerPanel");
const zipPickerList = document.getElementById("zipPickerList");

viewOptSmoothed.addEventListener("change", () => { if (viewOptSmoothed.checked) Viewer.showDataset("smoothed"); });
viewOptOriginal.addEventListener("change", () => { if (viewOptOriginal.checked) Viewer.showDataset("original"); });
viewWireframe.addEventListener("change", () => Viewer.setWireframeVisible(viewWireframe.checked));
viewFlatShading.addEventListener("change", () => Viewer.setFlatShading(viewFlatShading.checked));

// pendingFile = { name, getBuffer: () => Promise<ArrayBuffer> }
let pendingFile = null;

maxDispSlider.addEventListener("input", () => {
  const v = parseFloat(maxDispSlider.value);
  maxDispVal.textContent = v === 0 ? "no smoothing" : v.toFixed(2) + " mm";
});

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  if (e.dataTransfer.files.length) setFileFromFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files.length) setFileFromFile(fileInput.files[0]); });

function setFileFromFile(f) {
  handleIncomingFile(f.name, () => f.arrayBuffer(), f.size);
}

// ---------------------------------------------------------------------
// ZIP handling: many 3D-model sites (MakerWorld included) package the
// download as a .zip containing the actual .stl/.3mf plus print settings,
// renders, license text, etc. This opens the zip locally, finds every
// .stl/.3mf inside, and either auto-selects the only one or lets the user
// pick when there are several (e.g. left/right parts).
// ---------------------------------------------------------------------
async function handleIncomingFile(name, getBuffer, sizeHint) {
  zipPickerPanel.style.display = "none";
  zipPickerList.innerHTML = "";

  if (!/\.zip$/i.test(name)) {
    setPendingFile({ name, size: sizeHint, getBuffer });
    return;
  }

  fnameEl.textContent = name + " (reading ZIP...)";
  convertBtn.style.display = "none";

  try {
    const buf = await getBuffer();
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.keys(zip.files).filter(
      (n) => !zip.files[n].dir && /\.(stl|3mf)$/i.test(n)
    );

    if (entries.length === 0) {
      throw new Error("This ZIP doesn't contain any recognizable .stl or .3mf file.");
    }

    if (entries.length === 1) {
      const innerPath = entries[0];
      const innerBuf = await zip.files[innerPath].async("arraybuffer");
      const innerName = innerPath.split("/").pop();
      setPendingFile({ name: innerName, size: innerBuf.byteLength, getBuffer: async () => innerBuf });
      fnameEl.textContent = `${name} -> ${innerName} (${(innerBuf.byteLength / 1024).toFixed(0)} KB)`;
      return;
    }

    // Multiple candidates: let the user choose which one to convert.
    fnameEl.textContent = `${name} (${entries.length} files found, choose one below)`;
    zipPickerPanel.style.display = "block";
    for (const entryPath of entries) {
      const item = document.createElement("div");
      item.className = "zip-item";
      const nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.textContent = entryPath;
      const sizeSpan = document.createElement("span");
      sizeSpan.className = "size";
      sizeSpan.textContent = "";
      item.appendChild(nameSpan);
      item.appendChild(sizeSpan);
      item.addEventListener("click", async () => {
        Array.from(zipPickerList.children).forEach((c) => c.classList.remove("selected"));
        item.classList.add("selected");
        sizeSpan.textContent = "loading...";
        const innerBuf = await zip.files[entryPath].async("arraybuffer");
        const innerName = entryPath.split("/").pop();
        setPendingFile({ name: innerName, size: innerBuf.byteLength, getBuffer: async () => innerBuf });
        sizeSpan.textContent = (innerBuf.byteLength / 1024).toFixed(0) + " KB";
      });
      zipPickerList.appendChild(item);
    }
  } catch (err) {
    fnameEl.textContent = "";
    zipPickerPanel.style.display = "block";
    zipPickerList.innerHTML = "";
    const errBox = document.createElement("div");
    errBox.style.color = "var(--warn)";
    errBox.style.fontSize = "13px";
    errBox.textContent = "Error: " + (err && err.message ? err.message : String(err));
    zipPickerList.appendChild(errBox);
  }
}

function setPendingFile(pf) { pendingFile = pf; fnameEl.textContent = pf.name + (pf.size ? " (" + (pf.size/1024).toFixed(0) + " KB)" : ""); convertBtn.style.display = "block"; convertBtn.disabled = false; convertBtn.textContent = "Convert to STEP";
  resultsPanel.style.display = "none";
}

function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
function setProgress(pct) { progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%"; }
function yieldFrame() { return new Promise(r => setTimeout(r, 0)); }

// Same empirical rate sandbox.js uses for its own "Sewing surface (estimated...)"
// log line (~13.8 ms/face, measured on a real 22,944-triangle model) -- mirrored
// here so we can warn *before* sending the mesh to the sandbox, not just after
// it's already built every face. It's a rough guess, not a precise ETA: real
// time depends on mesh shape, not just triangle count.
function estimateSewSeconds(nFaces) { return Math.round(nFaces * 0.0138); }
function formatDuration(totalSeconds) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)} min`;
}

// Building the interactive Three.js preview (two full position buffers, per-vertex
// normals, a live WebGL render loop) is separate work from the OpenCASCADE/WASM
// conversion, running on the *parent* page's own main thread -- not covered by the
// sandbox watchdog above. On a real 290,076-triangle model the conversion itself
// finished fine (confirmed via OpenCASCADE's own console output: the STEP file was
// written successfully), but the tab still became unresponsive for a long stretch
// afterward, consistent with this preview-building step being the actual bottleneck
// at that size, not the conversion. Skipping the interactive preview above this
// threshold avoids that second failure mode; the STEP file itself is unaffected.
const VIEWER_MAX_FACES = 150000;

// ---------------------------------------------------------------------
// Sandbox bridge: the actual OpenCASCADE/WASM work runs inside
// sandbox.html, a page declared under manifest.json's "sandbox.pages".
// Normal extension pages (this one included) are locked to a CSP of
// script-src 'self' with NO eval/new Function allowed at all -- but
// opencascade.js's Emscripten/embind glue code calls `new Function(...)`
// during startup (to build named Error subclasses), which throws under
// that CSP. Sandboxed pages get a relaxed default CSP that permits
// 'unsafe-eval', so we hand the mesh off to that iframe over postMessage
// and get STEP bytes back. See sandbox.html for details.
// ---------------------------------------------------------------------
let sandboxFrame = null;
let sandboxReadyPromise = null;
let reqCounter = 0;
const pendingRequests = new Map();

function ensureSandbox() {
  if (sandboxReadyPromise) return sandboxReadyPromise;
  sandboxReadyPromise = new Promise((resolve) => {
    sandboxFrame = document.createElement("iframe");
    sandboxFrame.src = "sandbox.html";
    sandboxFrame.style.display = "none";
    const onReady = (event) => {
      if (event.data && event.data.type === "sandbox-ready") {
        window.removeEventListener("message", onReady);
        resolve();
      }
    };
    window.addEventListener("message", onReady);
    document.body.appendChild(sandboxFrame);
  });
  return sandboxReadyPromise;
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || !msg.requestId) return;
  const pending = pendingRequests.get(msg.requestId);
  if (!pending) return;
  if (msg.type === "log") pending.onLog(msg.text, msg.cls);
  else if (msg.type === "progress") pending.onProgress(msg.pct);
  else if (msg.type === "done") {
    pendingRequests.delete(msg.requestId);
    pending.resolve({ buffer: msg.buffer, byteLength: msg.byteLength });
  } else if (msg.type === "error") {
    pendingRequests.delete(msg.requestId);
    pending.reject(new Error(msg.message));
  }
});

async function convertInSandbox(vertices, faces, { onLog, onProgress }) {
  await ensureSandbox();
  const requestId = ++reqCounter;

  const flatVerts = new Float64Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    flatVerts[i * 3] = vertices[i][0];
    flatVerts[i * 3 + 1] = vertices[i][1];
    flatVerts[i * 3 + 2] = vertices[i][2];
  }
  const flatFaces = new Int32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    flatFaces[i * 3] = faces[i][0];
    flatFaces[i * 3 + 1] = faces[i][1];
    flatFaces[i * 3 + 2] = faces[i][2];
  }

  // The sandboxed iframe runs the whole OpenCASCADE/WASM conversion, including one long,
  // fully synchronous "sewing" call that reports no progress until it's done. If that iframe
  // silently dies mid-conversion (running out of the browser's memory is the usual cause on
  // very dense meshes), no "done" or "error" message ever arrives, and without a watchdog this
  // Promise -- and the whole UI -- would hang forever with the tab sitting at 0% CPU and no
  // way to recover short of reloading the whole page. This ties a generous, size-scaled
  // timeout to the same estimate shown to the user, and on timeout tears down the (presumed
  // dead) sandbox iframe so the *next* attempt gets a fresh one instead of posting into a
  // frame that will never answer.
  const estSeconds = estimateSewSeconds(faces.length);
  const timeoutMs = Math.max(3 * 60 * 1000, estSeconds * 1000 * 2.5);
  const heartbeatMs = Math.min(5 * 60 * 1000, Math.max(45 * 1000, (estSeconds * 1000) / 8));
  const startTime = performance.now();

  return new Promise((resolve, reject) => {
    const heartbeat = setInterval(() => {
      const elapsedMin = Math.round((performance.now() - startTime) / 60000);
      onLog(
        `Still working... ~${elapsedMin} min elapsed (estimate was ~${formatDuration(estSeconds)}). The sewing step reports no progress until it finishes -- this is normal for dense meshes, the tab isn't frozen.`
      );
    }, heartbeatMs);

    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      if (sandboxFrame && sandboxFrame.parentNode) sandboxFrame.parentNode.removeChild(sandboxFrame);
      sandboxFrame = null;
      sandboxReadyPromise = null;
      reject(new Error(`TIMEOUT: no response from the conversion engine after ~${Math.round(timeoutMs / 60000)} min (estimate was ~${formatDuration(estSeconds)}).`));
    }, timeoutMs);

    const cleanup = () => { clearInterval(heartbeat); clearTimeout(timeoutId); };
    pendingRequests.set(requestId, {
      resolve: (v) => { cleanup(); resolve(v); },
      reject: (e) => { cleanup(); reject(e); },
      onLog,
      onProgress,
    });
    sandboxFrame.contentWindow.postMessage(
      { type: "convert", requestId, vertices: flatVerts, faces: flatFaces },
      "*",
      [flatVerts.buffer, flatFaces.buffer]
    );
  });
}

convertBtn.addEventListener("click", async () => {
  if (!pendingFile) return;
  convertBtn.disabled = true;
  progressPanel.style.display = "block";
  resultsPanel.style.display = "none";
  logEl.innerHTML = "";
  setProgress(0);

  try {
    const maxDisp = parseFloat(maxDispSlider.value);
    const t0 = performance.now();

    const isThreeMF = /\.3mf$/i.test(pendingFile.name);
    log(isThreeMF ? "Reading 3MF..." : "Reading STL...");
    const buf = await pendingFile.getBuffer();
    const rawTris = isThreeMF ? await parse3MF(buf) : parseSTL(buf);
    const { vertices, faces } = buildMesh(rawTris);
    log(`Mesh: ${vertices.length} vertices, ${faces.length} triangles.`);
    const estSecondsPreflight = estimateSewSeconds(faces.length);
    const VERY_LARGE_FACE_THRESHOLD = 300000;
    if (faces.length > VERY_LARGE_FACE_THRESHOLD) {
      const proceed = confirm(
        `This model has ${faces.length.toLocaleString()} triangles — extremely dense.\n\n` +
        `The "sewing" step alone is estimated at around ${formatDuration(estSecondsPreflight)} (rough guess -- real mesh shape can move this a lot), and meshes this large often exhaust the browser's memory during that step and fail after the long wait instead of completing, sometimes without even showing an error.\n\n` +
        `Recommended: cancel and simplify/decimate the mesh first (in your slicer, Meshmixer, Blender's Decimate modifier, etc.) down to a few hundred thousand triangles or fewer, then convert again.\n\n` +
        `Try anyway?`
      );
      if (!proceed) {
        log(`Cancelled: ${faces.length.toLocaleString()} triangles is above the safe threshold (${VERY_LARGE_FACE_THRESHOLD.toLocaleString()}). Simplify the mesh and try again.`, "warn");
        return;
      }
      log(`Continuing with an extremely dense mesh (${faces.length.toLocaleString()} triangles, estimated ~${formatDuration(estSecondsPreflight)} for sewing alone) at the user's request — this may take a very long time and may still fail due to memory limits.`, "warn");
    } else if (faces.length > 20000) {
      log(`Large model (${faces.length.toLocaleString()} triangles): converting to STEP is estimated at around ${formatDuration(estSecondsPreflight)}, mostly spent in the "sewing" step, which reports no progress at all while it runs -- a long silence here is normal, not a sign the tab is stuck. Don't close this tab. If your system's task manager still shows 0% CPU for this tab after roughly double that estimate, it likely crashed silently; reload the page and try again with a simpler mesh.`, "warn");
    } else if (faces.length > 8000) {
      log(`Medium-sized model (${faces.length.toLocaleString()} triangles): conversion is estimated at around ${formatDuration(estSecondsPreflight)}.`, "warn");
    }
    const orig = meshVolumeAndBBox(vertices, faces);

    await yieldFrame();
    const { adjacency, degrees, edges, edgeLengths } = computeAdjacency(vertices, faces);
    const { frozen } = computeFrozenSet(vertices, degrees, edges, edgeLengths);
    const frozenCount = frozen.reduce((a,b)=>a+b,0);

    let smoothed = vertices, stats = { maxDisp: 0, meanDisp: 0, clampedCount: 0 };
    if (maxDisp > 0) {
      log(`Smoothing (limit ${maxDisp.toFixed(2)} mm, ${frozenCount} of ${vertices.length} vertices protected)...`);
      const r = smoothMesh(vertices, adjacency, frozen, { lambda: 0.25, iterations: 30, maxDisp });
      smoothed = r.vertices; stats = r.stats;
    } else {
      log("No smoothing (direct conversion).");
    }
    const after = meshVolumeAndBBox(smoothed, faces);
    setProgress(5);

    setProgress(10);
    const outName = (pendingFile.name.replace(/\.(stl|3mf)$/i, "") || "modelo") + (maxDisp > 0 ? "_smoothed" : "") + ".step";

    const { buffer, byteLength } = await convertInSandbox(smoothed, faces, {
      onLog: (text, cls) => log(text, cls),
      onProgress: (pct) => setProgress(pct),
    });
    const data = new Uint8Array(buffer, 0, byteLength);

    log(`Total time: ${((performance.now()-t0)/1000).toFixed(1)} s.`);

    const blob = new Blob([data], { type: "application/step" });
    const url = URL.createObjectURL(blob);
    downloadBtn.href = url;
    downloadBtn.download = outName;

    statsTable.innerHTML = `
      <tr><td>Original volume</td><td>${orig.volume.toFixed(2)} mm&sup3;</td></tr>
      <tr><td>Result volume</td><td>${after.volume.toFixed(2)} mm&sup3; (${(after.volume-orig.volume>=0?"+":"")}${(after.volume-orig.volume).toFixed(2)})</td></tr>
      <tr><td>Original bounding box</td><td>${orig.extents.map(x=>x.toFixed(2)).join(" x ")} mm</td></tr>
      <tr><td>Result bounding box</td><td>${after.extents.map(x=>x.toFixed(2)).join(" x ")} mm</td></tr>
      <tr><td>Max displacement</td><td>${stats.maxDisp.toFixed(3)} mm</td></tr>
      <tr><td>Mean displacement</td><td>${stats.meanDisp.toFixed(3)} mm</td></tr>
      <tr><td>Protected vertices (sin tocar)</td><td>${frozenCount} / ${vertices.length}</td></tr>
      <tr><td>STEP file size</td><td>${(data.length/1024/1024).toFixed(1)} MB</td></tr>
    `;
    resultsPanel.style.display = "block";
    const inlineSupportEl = document.getElementById("inlineSupport");
    if (inlineSupportEl) inlineSupportEl.style.display = "block";

    fetch("/api/increment", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        const counterEl = document.getElementById("conversionCounter");
        if (counterEl && typeof d.count === "number") {
          counterEl.textContent = d.count === 1 ? "1 file converted so far" : d.count.toLocaleString() + " files converted so far";
        }
      })
      .catch(() => {
        // Decorative counter only, never block or disrupt the conversion flow.
      });

    viewerPanel.style.display = "block";
    if (faces.length > VIEWER_MAX_FACES) {
      // Too dense to preview safely -- skip building/rendering it entirely. The STEP
      // file above is already generated and downloadable regardless of this.
      viewerToolbar.style.display = "none";
      viewerCanvasWrap.style.display = "none";
      viewerHint.style.display = "none";
      viewerTooLarge.style.display = "block";
    } else {
      viewerToolbar.style.display = "";
      viewerCanvasWrap.style.display = "";
      viewerHint.style.display = "";
      viewerTooLarge.style.display = "none";
      if (!Viewer.isReady()) {
        viewerLoading.style.display = "none";
        Viewer.init(viewerCanvasWrap);
      }
      Viewer.setData(faces, vertices, smoothed);
      viewOptSmoothed.checked = maxDisp > 0;
      viewOptOriginal.checked = maxDisp === 0;
      Viewer.showDataset(maxDisp > 0 ? "smoothed" : "original");
      Viewer.setWireframeVisible(viewWireframe.checked);
      Viewer.setFlatShading(viewFlatShading.checked);
    }
  } catch (err) {
    console.error(err);
    const rawMsg = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
    const bareMessage = (err && err.message != null) ? String(err.message) : String(err);
    const looksLikeEngineAbort = /^\d+$/.test(bareMessage.trim());
    const looksLikeTimeout = /^TIMEOUT:/.test(bareMessage.trim());
    if (looksLikeTimeout) {
      log(
        `ERROR: ${bareMessage} The conversion tab most likely ran out of memory and crashed silently while processing this mesh -- this can happen even below the "extremely dense" warning threshold. ` +
        `You can try converting again in this same tab (a fresh conversion engine will start automatically); if that doesn't work, reload the page. Consider simplifying/decimating the mesh to fewer triangles first.`,
        "warn"
      );
    } else if (looksLikeEngineAbort) {
      log(
        `ERROR: The conversion engine crashed internally (raw code: ${bareMessage}). ` +
        `This is not a normal error message — it almost always means the browser ran out of memory while processing the mesh, usually because the model is extremely dense. ` +
        `Try simplifying/decimating the mesh to far fewer triangles (a few hundred thousand or less) and convert again.`,
        "warn"
      );
    } else {
      log("ERROR: " + rawMsg, "warn");
    }
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = "Convert to STEP";
  }
});


// Conversion counter (footer): fetch the current total on page load and display it.
(async () => {
  try {
    const res = await fetch("/api/count");
    const data = await res.json();
    const el = document.getElementById("conversionCounter");
    if (el && typeof data.count === "number") {
      el.textContent = data.count === 1 ? "1 file converted so far" : data.count.toLocaleString() + " files converted so far";
    }
  } catch (e) {
    // Decorative counter only, silently ignore failures.
  }
})();

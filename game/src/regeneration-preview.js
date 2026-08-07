import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const list = document.getElementById("list");
const stage = document.getElementById("stage");
const statusNode = document.getElementById("status");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
renderer.shadowMap.enabled = true;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x131720);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
camera.position.set(3.2, 2.3, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1.1, 0);

scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x443735, 2.2));
const key = new THREE.DirectionalLight(0xffefd2, 3);
key.position.set(4, 7, 5);
key.castShadow = true;
scene.add(key);
const gridHelper = new THREE.GridHelper(8, 16, 0x66707d, 0x303743);
scene.add(gridHelper);

const root = new THREE.Group();
scene.add(root);
const loader = new GLTFLoader();
const clock = new THREE.Clock();
let mixer;
let current;
let activeUrl = "";
let activeKey = "";
let lastSignature = "";
let loadRequest = 0;

// Isolated turntable audit mode (orientation Gate 1): pure background, no
// auto-rotation, the same model rendered at labeled 45-degree yaw steps.
// Camera at yaw 0 sits on +Z, so: front seen at yaw 0 => native forward +Z,
// 90 => +X, 180 => -Z, 270 => -X. Record the picked yaw with
// scripts/record-orientation.mjs, which writes asset.orientation.
const pageQuery = new URLSearchParams(location.search);
const auditAssetId = pageQuery.get("audit");
const auditGlbUrl = pageQuery.get("glb");
const AUDIT_YAWS = [0, 45, 90, 135, 180, 225, 270, 315];
const auditCamera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
let auditActive = false;

resize();
window.addEventListener("resize", resize);
requestAnimationFrame(tick);
if (auditAssetId || auditGlbUrl) {
  runAuditMode().catch((error) => {
    statusNode.textContent = `转台审计加载失败：${error.message || error}`;
    document.title = "audit-failed";
  });
} else {
  poll();
  setInterval(poll, 2000);
}

async function runAuditMode() {
  document.title = `audit-loading:${auditAssetId || auditGlbUrl}`;
  scene.background = new THREE.Color(0xdfe3ea);
  scene.remove(gridHelper);
  let url = auditGlbUrl;
  if (!url) {
    const response = await fetch(`./regeneration-status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = await response.json();
    const item = (data.items || []).find((entry) => entry.id === auditAssetId);
    if (!item?.runtimeUrl) throw new Error(`状态文件中没有 ${auditAssetId} 的 runtimeUrl`);
    url = item.runtimeUrl;
  }
  const gltf = await loader.loadAsync(url);
  current = gltf.scene;
  prepareScene(current);
  normalize(current);
  root.add(current);
  auditActive = true;
  buildAuditOverlay();
  statusNode.innerHTML =
    `<b>转台审计（隔离/纯背景）</b><br>${escapeHtml(url)}<br>` +
    "正面所在 yaw ⇒ 原生前向轴：0°=+Z · 90°=+X · 180°=−Z · 270°=−X。" +
    "选定后运行 scripts/record-orientation.mjs --asset &lt;id&gt; --front-yaw &lt;deg&gt; 写入 manifest（AXIS_AUDITED）。";
  document.title = `audit-ready:${auditGlbUrl ? fileNameFromUrl(url) : auditAssetId}`;
}

function buildAuditOverlay() {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;inset:0;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(2,1fr);pointer-events:none;";
  for (const yaw of AUDIT_YAWS) {
    const cell = document.createElement("div");
    cell.style.cssText = "border:1px solid rgba(20,28,40,.35);color:#1c2430;font:600 14px system-ui;padding:6px;";
    cell.textContent = `yaw ${yaw}°`;
    overlay.appendChild(cell);
  }
  stage.appendChild(overlay);
}

function renderAuditFrame() {
  const box = stage.getBoundingClientRect();
  const cols = 4;
  const rows = 2;
  const cellWidth = Math.floor(box.width / cols);
  const cellHeight = Math.floor(box.height / rows);
  renderer.setScissorTest(true);
  AUDIT_YAWS.forEach((yaw, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * cellWidth;
    const y = (rows - 1 - row) * cellHeight;
    renderer.setViewport(x, y, cellWidth, cellHeight);
    renderer.setScissor(x, y, cellWidth, cellHeight);
    auditCamera.aspect = cellWidth / Math.max(1, cellHeight);
    auditCamera.updateProjectionMatrix();
    const radians = (yaw * Math.PI) / 180;
    const distance = 4.4;
    auditCamera.position.set(distance * Math.sin(radians), 1.55, distance * Math.cos(radians));
    auditCamera.lookAt(0, 1.05, 0);
    renderer.render(scene, auditCamera);
  });
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, box.width, box.height);
}

async function poll() {
  try {
    const response = await fetch(`./regeneration-status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${response.status}`);
    renderStatus(await response.json());
  } catch (error) {
    if (!activeUrl) statusNode.textContent = `等待状态文件：${error.message}`;
  }
}

function renderStatus(data) {
  if (!activeUrl) statusNode.innerHTML = `<b>${escapeHtml(data.status || "unknown")}</b><br>${escapeHtml(data.message || "")}`;
  const items = Array.isArray(data.items) ? data.items : [];
  const signature = JSON.stringify([
    data.runId,
    data.updatedAt,
    items.map((item) => [
      item.id,
      item.status,
      item.progress,
      item.runtimeUrl,
      item.error,
      (item.clips || []).map((clip) => [clip.name, clip.status, clip.progress, clip.runtimeUrl, clip.error])
    ])
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  list.innerHTML = "";
  for (const item of items) {
    list.appendChild(createPreviewButton({
      key: `${item.id}:base`,
      name: item.name || item.id,
      kindLabel: "基础模型 GLB",
      status: item.status,
      progress: item.progress,
      runtimeUrl: item.runtimeUrl,
      error: item.error,
      onClick: () => loadPreview(item, undefined, data.updatedAt)
    }));
    for (const clip of item.clips || []) {
      list.appendChild(createPreviewButton({
        key: `${item.id}:${clip.name}`,
        name: actionLabel(clip.name),
        kindLabel: "动作模型 GLB",
        status: clip.status,
        progress: clip.progress,
        runtimeUrl: clip.runtimeUrl,
        error: clip.error,
        isClip: true,
        onClick: () => loadPreview(item, clip, data.updatedAt)
      }));
    }
  }
  const firstReady = items.find((item) => item.runtimeUrl);
  if (!activeUrl && firstReady) {
    const firstReadyClip = (firstReady.clips || []).find((clip) => clip.runtimeUrl);
    loadPreview(firstReady, firstReadyClip, data.updatedAt);
  }
}

function createPreviewButton({ key: previewKey, name, kindLabel, status, progress, runtimeUrl, error, isClip = false, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.previewKey = previewKey;
  button.className = `item${isClip ? " clip-item" : ""}${runtimeUrl ? " ready" : ""}${previewKey === activeKey ? " active" : ""}${status === "failed" ? " failed" : ""}`;
  const detail = error || (runtimeUrl ? fileNameFromUrl(runtimeUrl) : "等待 GLB 文件");
  button.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(kindLabel)} · ${escapeHtml(status || "pending")} · ${Math.round(progress || 0)}%</span><code>${escapeHtml(detail)}</code><progress max="100" value="${Number(progress || 0)}"></progress>`;
  button.disabled = !runtimeUrl;
  button.addEventListener("click", onClick);
  return button;
}

function loadPreview(item, clip, version) {
  if (!item.runtimeUrl || (clip && !clip.runtimeUrl)) return;
  const request = ++loadRequest;
  const label = clip ? `${item.name || item.id} · ${actionLabel(clip.name)}` : item.name || item.id;
  activeUrl = clip?.runtimeUrl || item.runtimeUrl;
  activeKey = `${item.id}:${clip?.name || "base"}`;
  updateActiveButtons();
  clearCurrent();
  statusNode.innerHTML = `<b>${escapeHtml(label)}</b><br>${escapeHtml(activeUrl)}`;
  loader.load(
    versionedUrl(item.runtimeUrl, version),
    (gltf) => {
      if (request !== loadRequest) return;
      current = gltf.scene;
      prepareScene(current);
      normalize(current);
      root.add(current);
      if (clip) loadActionClip(clip, current, request, label, version);
      else if (gltf.animations.length) playClip(current, gltf.animations[0]);
    },
    undefined,
    (error) => {
      if (request === loadRequest) statusNode.innerHTML = `基础模型加载失败：${escapeHtml(error.message || String(error))}`;
    }
  );
}

function loadActionClip(clip, mainRoot, request, label, version) {
  loader.load(
    versionedUrl(clip.runtimeUrl, version),
    (actionGltf) => {
      if (request !== loadRequest || mainRoot !== current) return;
      const animation = actionGltf.animations[0];
      if (!animation) {
        statusNode.innerHTML = `<b>${escapeHtml(label)}</b><br>动作 GLB 中没有可播放的 AnimationClip`;
        return;
      }
      if (!clipCanBind(animation, mainRoot)) {
        showActionSceneFallback(actionGltf, animation, request, label);
        return;
      }
      playClip(mainRoot, animation);
      statusNode.innerHTML = `<b>${escapeHtml(label)}</b><br>动作 GLB 已绑定基础模型 · ${animation.duration.toFixed(2)} 秒循环`;
    },
    undefined,
    (error) => {
      if (request === loadRequest) statusNode.innerHTML = `动作模型加载失败：${escapeHtml(error.message || String(error))}`;
    }
  );
}

function clipCanBind(animation, target) {
  if (!animation.tracks.length) return false;
  return animation.tracks.some((track) => {
    try {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      return !parsed.nodeName || Boolean(THREE.PropertyBinding.findNode(target, parsed.nodeName));
    } catch {
      return false;
    }
  });
}

function showActionSceneFallback(actionGltf, animation, request, label) {
  if (request !== loadRequest) return;
  let meshCount = 0;
  actionGltf.scene.traverse((child) => {
    if (child.isMesh || child.isSkinnedMesh) meshCount += 1;
  });
  if (meshCount === 0) {
    // Animation-only clip files carry no displayable scene.
    statusNode.innerHTML = `<b>${escapeHtml(label)}</b><br>动作骨架未绑定基础模型；该动作文件为纯动画 GLB（无网格），请使用程序化/整组动画兜底`;
    return;
  }
  clearCurrent();
  current = actionGltf.scene;
  prepareScene(current);
  normalize(current);
  root.add(current);
  playClip(current, animation);
  statusNode.innerHTML = `<b>${escapeHtml(label)}</b><br>动作骨架未绑定基础模型，正在直接显示动作 GLB 场景`;
}

function playClip(target, animation) {
  mixer?.stopAllAction?.();
  mixer = new THREE.AnimationMixer(target);
  mixer.clipAction(animation, target).reset().play();
}

function prepareScene(object) {
  object.traverse((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function updateActiveButtons() {
  for (const button of list.querySelectorAll("[data-preview-key]")) button.classList.toggle("active", button.dataset.previewKey === activeKey);
}

function actionLabel(name) {
  return ({ idle: "待机 Idle", walk: "行走 Walk", run: "奔跑 Run", jump: "跳跃 Jump" })[String(name).toLowerCase()] || name;
}

function fileNameFromUrl(url) {
  return String(url).split(/[?#]/, 1)[0].split("/").filter(Boolean).at(-1) || url;
}

function versionedUrl(url, version) {
  if (!version) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

function clearCurrent() {
  mixer?.stopAllAction?.();
  mixer = undefined;
  if (!current) return;
  root.remove(current);
  current.traverse((obj) => {
    obj.geometry?.dispose?.();
    if (Array.isArray(obj.material)) obj.material.forEach((material) => material.dispose?.());
    else obj.material?.dispose?.();
  });
  current = undefined;
}

function normalize(object) {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  object.scale.setScalar(2.6 / Math.max(size.x, size.y, size.z, 0.001));
  object.updateWorldMatrix(true, true);
  const nextBox = new THREE.Box3().setFromObject(object);
  const center = nextBox.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= nextBox.min.y;
  root.rotation.y = 0;
  controls.target.set(0, 1.2, 0);
  controls.update();
}

function resize() {
  const box = stage.getBoundingClientRect();
  renderer.setSize(box.width, box.height, false);
  camera.aspect = box.width / Math.max(1, box.height);
  camera.updateProjectionMatrix();
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  mixer?.update(dt);
  if (auditActive) {
    renderAuditFrame();
    return;
  }
  if (current) root.rotation.y += dt * 0.28;
  controls.update();
  renderer.render(scene, camera);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

"use strict";

/* ================= 状态 ================= */
const state = {
  cues: [],            // 当前工作副本
  original: [],        // 解析时的原始值（对照用）
  issues: [],
  settings: null,
  selectedId: null,
  undoStack: [],       // [{label, data}]
  redoStack: [],
  view: { pxPerSec: 80, offsetSec: 0 },
  filter: "all",       // 异常过滤：all | error | warning
  tab: "issues",
  hasVideo: false,
};

const FALLBACK_SETTINGS = {
  cpsMax: 20, minDuration: 1.0, maxDuration: 7.0, minGap: 0.08,
  maxCharsPerLine: 20, breakShortLine: 3, checkPunctuation: true,
};

const $ = (id) => document.getElementById(id);
const player = $("player");
const canvas = $("timeline");
const ctx = canvas.getContext("2d");

// 旧浏览器无 roundRect 时的降级
if (!ctx.roundRect) {
  ctx.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); };
}

const RULER_H = 22, MARK_H = 16, LANE_Y = RULER_H + MARK_H;
const MIN_CUE_DUR = 0.04;

/* ================= 工具函数 ================= */
function secToTc(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
        s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

function parseTc(str) {
  str = String(str).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const m = str.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (!m) return null;
  const ms = m[4] ? parseInt(m[4].padEnd(3, "0").slice(0, 3)) : 0;
  return (parseInt(m[1] || "0") * 3600 + parseInt(m[2]) * 60 +
          parseInt(m[3]) + ms / 1000);
}

function visibleText(t) {
  return t.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "");
}
function charCount(t) {
  return [...visibleText(t)].filter((ch) => !/\s/.test(ch)).length;
}
function cueById(id) { return state.cues.find((c) => c.id === id); }
function origById(id) { return state.original.find((c) => c.id === id); }
function sortedCues() {
  return [...state.cues].sort((a, b) => a.start - b.start || a.id - b.id);
}
function isModified(c) {
  const o = origById(c.id);
  return o && (o.start !== c.start || o.end !== c.end || o.text !== c.text);
}

let toastTimer = null;
function toast(msg, ms = 4500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}

/* ================= 撤销 / 重做 ================= */
function snapshot() { return JSON.stringify(state.cues); }

function pushUndo(label, data) {
  state.undoStack.push({ label, data: data ?? snapshot() });
  if (state.undoStack.length > 100) state.undoStack.shift();
  state.redoStack = [];
  updateHistoryButtons();
}

function undo() {
  const item = state.undoStack.pop();
  if (!item) return;
  state.redoStack.push({ label: item.label, data: snapshot() });
  state.cues = JSON.parse(item.data);
  afterHistoryChange(`已撤销：${item.label}`);
}

function redo() {
  const item = state.redoStack.pop();
  if (!item) return;
  state.undoStack.push({ label: item.label, data: snapshot() });
  state.cues = JSON.parse(item.data);
  afterHistoryChange(`已重做：${item.label}`);
}

function afterHistoryChange(msg) {
  if (state.selectedId && !cueById(state.selectedId)) state.selectedId = null;
  updateHistoryButtons();
  scheduleValidate();
  renderAll();
  toast(msg, 2000);
}

function updateHistoryButtons() {
  $("btnUndo").disabled = !state.undoStack.length;
  $("btnRedo").disabled = !state.redoStack.length;
}

/* 以一次可撤销操作修改字幕 */
function commit(label, fn) {
  pushUndo(label);
  fn();
  scheduleValidate();
  renderAll();
}

/* ================= 校验 ================= */
let validateTimer = null;
function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(doValidate, 150);
}

async function doValidate() {
  if (!state.cues.length) { state.issues = []; renderAll(); return; }
  try {
    const res = await api("/api/validate", {
      cues: state.cues, settings: state.settings,
    });
    state.issues = res.issues;
  } catch (e) {
    toast(e.message);
  }
  renderAll();
}

/* 每条字幕的最严重级别：error > warning */
function cueSeverityMap() {
  const map = new Map();
  for (const iss of state.issues) {
    for (const cid of iss.cues) {
      if (iss.severity === "error" || !map.has(cid)) map.set(cid, iss.severity);
    }
  }
  return map;
}

/* ================= 渲染 ================= */
function renderAll() {
  renderStats();
  renderIssues();
  renderCueList();
  renderEditor();
  requestDraw();
}

function renderStats() {
  const el = $("statsBar");
  if (!state.cues.length) { el.textContent = "未载入字幕"; return; }
  const errs = state.issues.filter((i) => i.severity === "error").length;
  const warns = state.issues.filter((i) => i.severity === "warning").length;
  const mods = state.cues.filter(isModified).length;
  el.innerHTML = `共 ${state.cues.length} 条 ｜ 错误 <b class="e">${errs}</b> ｜ ` +
                 `提示 <b class="w">${warns}</b> ｜ 已修改 <b class="m">${mods}</b> 条`;
}

function renderIssues() {
  $("issueCount").textContent = state.issues.length;
  const list = $("issueList");
  list.innerHTML = "";
  const items = state.issues.filter(
    (i) => state.filter === "all" || i.severity === state.filter);
  if (!items.length) {
    list.innerHTML = `<div class="empty-tip">${
      state.cues.length ? "当前阈值下没有异常 🎉" : "请先打开或粘贴字幕文件"}</div>`;
    return;
  }
  for (const iss of items) {
    const div = document.createElement("div");
    div.className = `issue ${iss.severity}`;
    const refs = iss.cues.map((cid) => `#${cid}`).join(" ");
    div.innerHTML =
      `<div class="head"><span class="sev">${iss.severity === "error" ? "⛔ 错误" : "⚠️ 提示"}</span>` +
      `<span class="typ">[${iss.label}]</span><span class="refs">${refs}</span></div>` +
      `<div class="msg"></div>` +
      (iss.detail ? `<div class="detail"></div>` : "");
    div.querySelector(".msg").textContent = iss.message;
    if (iss.detail) div.querySelector(".detail").textContent = iss.detail;
    div.onclick = () => jumpToCue(iss.cues[0]);
    list.appendChild(div);
  }
}

function renderCueList() {
  $("cueCount").textContent = state.cues.length;
  const list = $("cueList");
  list.innerHTML = "";
  if (!state.cues.length) return;
  const sevMap = cueSeverityMap();
  for (const c of sortedCues()) {
    const div = document.createElement("div");
    div.className = "cue" + (c.id === state.selectedId ? " selected" : "");
    div.dataset.cid = c.id;
    const sev = sevMap.get(c.id);
    div.innerHTML =
      `<span class="cid">${c.id}</span>` +
      `<span class="tc-range">${secToTc(c.start)}→${secToTc(c.end)}</span>` +
      (sev ? `<span class="dot ${sev}"></span>` : "") +
      (c.locked ? `<span class="tag lock">🔒</span>` : "") +
      (isModified(c) ? `<span class="tag mod">改</span>` : "") +
      `<span class="txt"></span>`;
    div.querySelector(".txt").textContent = visibleText(c.text).replace(/\n/g, " ⏎ ");
    div.onclick = () => jumpToCue(c.id);
    list.appendChild(div);
  }
}

function renderEditor() {
  const ed = $("editor");
  const c = state.selectedId ? cueById(state.selectedId) : null;
  ed.classList.toggle("disabled", !c);
  for (const el of ed.querySelectorAll("input, textarea, button"))
    el.disabled = !c;
  if (!c) {
    $("edTitle").textContent = "未选择字幕";
    $("edStart").value = ""; $("edEnd").value = "";
    $("edText").value = ""; $("edMeta").textContent = "";
    $("edOriginal").textContent = "";
    $("btnRevertCue").classList.add("hidden");
    return;
  }
  $("edTitle").textContent = `字幕 #${c.id}`;
  const startEl = $("edStart"), endEl = $("edEnd");
  if (document.activeElement !== startEl) startEl.value = secToTc(c.start);
  if (document.activeElement !== endEl) endEl.value = secToTc(c.end);
  if (document.activeElement !== $("edText")) $("edText").value = c.text;
  $("edLock").checked = !!c.locked;

  const dur = c.end - c.start;
  const cps = dur > 0 ? (charCount(c.text) / dur) : 0;
  const maxLine = Math.max(0, ...visibleText(c.text).split("\n").map(charCount));
  const st = state.settings;
  $("edMeta").innerHTML =
    `时长 <b class="${dur < st.minDuration ? "bad" : ""}">${dur.toFixed(3)}s</b> ｜ ` +
    `CPS <b class="${cps > st.cpsMax ? "bad" : ""}">${cps.toFixed(1)}</b> ｜ ` +
    `最长行 <b class="${maxLine > st.maxCharsPerLine ? "bad" : ""}">${maxLine}</b> 字`;

  const o = origById(c.id);
  const changed = o && isModified(c);
  startEl.classList.toggle("changed", !!o && o.start !== c.start);
  endEl.classList.toggle("changed", !!o && o.end !== c.end);
  $("edOriginal").textContent = o
    ? (changed ? `原始：${secToTc(o.start)} → ${secToTc(o.end)}` : "与原始一致")
    : "";
  $("btnRevertCue").classList.toggle("hidden", !changed);
}

/* ================= 选择与跳转 ================= */
function selectCue(id, seek = false) {
  state.selectedId = id;
  const c = cueById(id);
  if (seek && c && state.hasVideo) player.currentTime = c.start + 0.001;
  if (c) ensureVisible(c.start, c.end);
  renderAll();
  const row = document.querySelector(`.cue[data-cid="${id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

function jumpToCue(id) { selectCue(id, true); }

function stepCue(dir) {
  const arr = sortedCues();
  if (!arr.length) return;
  const idx = arr.findIndex((c) => c.id === state.selectedId);
  const next = arr[(idx + dir + arr.length) % arr.length] ?? arr[0];
  jumpToCue(next.id);
}

/* ================= 载入字幕 / 视频 ================= */
async function loadSubtitleText(text, sourceName) {
  try {
    const res = await api("/api/parse", { text });
    state.cues = res.cues;
    state.original = JSON.parse(JSON.stringify(res.cues));
    state.undoStack = [];
    state.redoStack = [];
    state.selectedId = null;
    updateHistoryButtons();
    for (const id of ["btnBatchFix", "btnRevertAll", "btnExportSrt",
                      "btnExportVtt", "btnSummary"])
      $(id).disabled = false;
    fitTimeline();
    toast(`已解析 ${res.count} 条字幕（${res.format.toUpperCase()}）— ${sourceName}`);
    await doValidate();
  } catch (e) {
    toast(e.message);
  }
}

$("btnOpenSub").onclick = () => $("fileSub").click();
$("fileSub").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => loadSubtitleText(reader.result, f.name);
  reader.readAsText(f);
  e.target.value = "";
};

$("btnPaste").onclick = () => $("pastePanel").classList.toggle("hidden");
$("btnClosePaste").onclick = () => $("pastePanel").classList.add("hidden");
$("btnParsePaste").onclick = () => {
  const text = $("pasteArea").value;
  if (text.trim()) {
    $("pastePanel").classList.add("hidden");
    loadSubtitleText(text, "粘贴内容");
  }
};

$("btnSample").onclick = async () => {
  const res = await fetch("static/sample/demo.srt");
  loadSubtitleText(await res.text(), "内置示例");
};

$("btnOpenVideo").onclick = () => $("fileVideo").click();
$("fileVideo").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(f);
  state.hasVideo = true;
  $("noVideo").classList.add("hidden");
  e.target.value = "";
  requestDraw();
};

/* ================= 编辑器事件 ================= */
function commitTimecode(inputEl, field) {
  const c = cueById(state.selectedId);
  if (!c) return;
  const v = parseTc(inputEl.value);
  if (v === null) {
    toast("时间码格式无效，应为 HH:MM:SS,mmm");
    inputEl.value = secToTc(c[field]);
    return;
  }
  let [s, e] = field === "start" ? [v, c.end] : [c.start, v];
  if (e - s < MIN_CUE_DUR) {
    toast("开始必须早于结束（至少 0.04s）");
    inputEl.value = secToTc(c[field]);
    return;
  }
  if (Math.abs(v - c[field]) < 1e-9) { inputEl.value = secToTc(c[field]); return; }
  commit(`修改 #${c.id} 时间码`, () => { c[field] = Math.round(v * 1000) / 1000; });
}

$("edStart").addEventListener("change", (e) => commitTimecode(e.target, "start"));
$("edEnd").addEventListener("change", (e) => commitTimecode(e.target, "end"));

$("edText").addEventListener("change", (e) => {
  const c = cueById(state.selectedId);
  if (!c || e.target.value === c.text) return;
  commit(`修改 #${c.id} 文字`, () => { c.text = e.target.value; });
});

$("edLock").addEventListener("change", (e) => {
  const c = cueById(state.selectedId);
  if (!c) return;
  commit(`${e.target.checked ? "锁定" : "解锁"} #${c.id}`,
         () => { c.locked = e.target.checked; });
});

$("btnRevertCue").onclick = () => {
  const c = cueById(state.selectedId);
  const o = c && origById(c.id);
  if (!o) return;
  commit(`恢复 #${c.id} 原始值`, () => {
    c.start = o.start; c.end = o.end; c.text = o.text;
  });
};

$("btnPrevCue").onclick = () => stepCue(-1);
$("btnNextCue").onclick = () => stepCue(1);

/* ================= 工具栏 ================= */
$("btnUndo").onclick = undo;
$("btnRedo").onclick = redo;

$("btnBatchFix").onclick = async () => {
  try {
    const res = await api("/api/batch_fix", {
      cues: state.cues, settings: state.settings,
    });
    pushUndo("批量修复");
    state.cues = res.cues;
    state.issues = res.issues;
    renderAll();
    const applied = res.changes.filter((c) => c.before);
    const skipped = res.changes.filter((c) => !c.before);
    let msg = `批量修复完成：${applied.length} 处调整` +
      `，剩余 错误 ${res.stats.errors} / 提示 ${res.stats.warnings}`;
    const lines = res.changes.slice(0, 10).map(
      (c) => `· #${c.cue} ${c.reason}`);
    if (res.changes.length > 10) lines.push(`… 共 ${res.changes.length} 条记录`);
    if (res.changes.length) msg += "\n" + lines.join("\n");
    if (skipped.length) msg += `\n（${skipped.length} 条因锁定或空间不足未完全修复）`;
    toast(msg, 8000);
  } catch (e) {
    toast(e.message);
  }
};

$("btnRevertAll").onclick = () => {
  if (!state.original.length) return;
  if (!confirm("将全部字幕恢复到解析时的原始值？（可撤销）")) return;
  commit("全部恢复原始", () => {
    state.cues = JSON.parse(JSON.stringify(state.original));
  });
};

$("btnSettings").onclick = () => $("settingsPanel").classList.toggle("hidden");

async function download(path, body, fallback) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { toast("导出失败"); return; }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = m ? decodeURIComponent(m[1]) : fallback;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$("btnExportSrt").onclick = () =>
  download("/api/export", { cues: state.cues, format: "srt" }, "corrected.srt");
$("btnExportVtt").onclick = () =>
  download("/api/export", { cues: state.cues, format: "vtt" }, "corrected.vtt");
$("btnSummary").onclick = () =>
  download("/api/summary", { cues: state.cues, settings: state.settings },
           "subtitle_issues.md");

/* ================= 设置 ================= */
function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function readSettingsFromUI() {
  state.settings = {
    cpsMax: num("setCps", FALLBACK_SETTINGS.cpsMax),
    minDuration: num("setMinDur", FALLBACK_SETTINGS.minDuration),
    maxDuration: num("setMaxDur", FALLBACK_SETTINGS.maxDuration),
    minGap: num("setMinGap", FALLBACK_SETTINGS.minGap),
    maxCharsPerLine: num("setMaxChars", FALLBACK_SETTINGS.maxCharsPerLine),
    breakShortLine: num("setBreakShort", FALLBACK_SETTINGS.breakShortLine),
    checkPunctuation: $("setPunct").checked,
  };
  scheduleValidate();
}

function fillSettingsUI(s) {
  $("setCps").value = s.cpsMax;
  $("setMinDur").value = s.minDuration;
  $("setMaxDur").value = s.maxDuration;
  $("setMinGap").value = s.minGap;
  $("setMaxChars").value = s.maxCharsPerLine;
  $("setBreakShort").value = s.breakShortLine;
  $("setPunct").checked = !!s.checkPunctuation;
}

for (const id of ["setCps", "setMinDur", "setMaxDur", "setMinGap",
                  "setMaxChars", "setBreakShort", "setPunct"])
  $(id).addEventListener("change", readSettingsFromUI);

/* ================= 标签页与过滤 ================= */
$("tabIssues").onclick = () => {
  state.tab = "issues";
  $("tabIssues").classList.add("active");
  $("tabCues").classList.remove("active");
  $("issueList").classList.remove("hidden");
  $("cueList").classList.add("hidden");
};
$("tabCues").onclick = () => {
  state.tab = "cues";
  $("tabCues").classList.add("active");
  $("tabIssues").classList.remove("active");
  $("cueList").classList.remove("hidden");
  $("issueList").classList.add("hidden");
};
document.querySelectorAll("#issueFilters .fbtn").forEach((btn) => {
  btn.onclick = () => {
    state.filter = btn.dataset.f;
    document.querySelectorAll("#issueFilters .fbtn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderIssues();
  };
});

/* ================= 时间轴 ================= */
let cueRects = [];   // [{c, x, y, w, h}]
let markers = [];    // [{x, issue}]
let drawQueued = false;

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawTimeline(); });
}

function viewSpan() { return canvas.clientWidth / state.view.pxPerSec; }
function secToX(s) { return (s - state.view.offsetSec) * state.view.pxPerSec; }
function xToSec(x) { return state.view.offsetSec + x / state.view.pxPerSec; }

function ensureVisible(start, end) {
  const span = viewSpan();
  if (end - start > span * 0.8) {
    state.view.offsetSec = Math.max(0, start - span * 0.1);
  } else if (start < state.view.offsetSec + span * 0.05 ||
             end > state.view.offsetSec + span * 0.95) {
    state.view.offsetSec = Math.max(0, start - span * 0.3);
  }
  requestDraw();
}

function fitTimeline() {
  const end = Math.max(1, ...state.cues.map((c) => c.end));
  state.view.pxPerSec = Math.max(2, (canvas.clientWidth - 20) / (end * 1.05));
  state.view.offsetSec = 0;
  requestDraw();
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}
window.addEventListener("resize", resizeCanvas);

function tickStep() {
  const pps = state.view.pxPerSec;
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600])
    if (s * pps >= 70) return s;
  return 900;
}

function drawTimeline() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const { pxPerSec, offsetSec } = state.view;

  // 标尺
  ctx.fillStyle = "#1c2129";
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.fillStyle = "#161a20";
  ctx.fillRect(0, RULER_H, W, MARK_H);
  const step = tickStep();
  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "alphabetic";
  for (let t = Math.floor(offsetSec / step) * step; t <= offsetSec + viewSpan() + step; t += step) {
    if (t < 0) continue;
    const x = secToX(t);
    ctx.strokeStyle = "#303a48";
    ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H); ctx.stroke();
    ctx.fillStyle = "#8b96a5";
    ctx.fillText(secToTc(t).slice(0, -4), x + 3, RULER_H - 8);
  }

  cueRects = [];
  markers = [];
  if (!state.cues.length) {
    ctx.fillStyle = "#8b96a5";
    ctx.font = "13px sans-serif";
    ctx.fillText("载入字幕后，这里会显示可缩放的字幕时间轴", 16, LANE_Y + 30);
    drawPlayhead();
    return;
  }

  const sevMap = cueSeverityMap();
  const laneH = H - LANE_Y - 8;
  const ordered = sortedCues();

  // 叠轴区域高亮
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], cur = ordered[i];
    if (cur.start < prev.end - 1e-4) {
      const x = secToX(cur.start), w = (prev.end - cur.start) * pxPerSec;
      ctx.fillStyle = "rgba(255,93,93,0.25)";
      ctx.fillRect(x, LANE_Y + 2, Math.max(2, w), laneH);
    }
  }

  // 字幕块
  for (const c of ordered) {
    const x = secToX(c.start);
    const w = Math.max(2, (c.end - c.start) * pxPerSec);
    const y = LANE_Y + 2, h = laneH;
    cueRects.push({ c, x, y, w, h });
    const sev = sevMap.get(c.id);
    ctx.fillStyle = c.locked ? "#3a3325" : "#2f5d8a";
    if (c.id === state.selectedId) ctx.fillStyle = c.locked ? "#57491f" : "#3f7ab5";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    ctx.fill();
    if (sev) {
      ctx.strokeStyle = sev === "error" ? "#ff5d5d" : "#f5b942";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (c.id === state.selectedId) {
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
    if (w > 30) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "10px sans-serif";
      ctx.save();
      ctx.beginPath(); ctx.rect(x + 2, y, w - 4, h); ctx.clip();
      ctx.fillText((c.locked ? "🔒" : "") + `#${c.id} ` +
        visibleText(c.text).replace(/\n/g, " "), x + 4, y + 13);
      ctx.restore();
    }
  }

  // 异常标记
  for (const iss of state.issues) {
    const c = cueById(iss.cues[0]);
    if (!c) continue;
    const x = secToX(c.start);
    markers.push({ x, issue: iss });
    ctx.fillStyle = iss.severity === "error" ? "#ff5d5d" : "#f5b942";
    ctx.beginPath();
    ctx.moveTo(x, RULER_H + 2);
    ctx.lineTo(x - 5, RULER_H + MARK_H - 3);
    ctx.lineTo(x + 5, RULER_H + MARK_H - 3);
    ctx.closePath();
    ctx.fill();
  }

  drawPlayhead();

  // 视图信息
  $("tlInfo").textContent =
    `${secToTc(offsetSec)} — ${secToTc(offsetSec + viewSpan())} ｜ ` +
    `${Math.round(pxPerSec)} px/s`;
}

function drawPlayhead() {
  if (!state.hasVideo) return;
  const x = secToX(player.currentTime);
  if (x < -2 || x > canvas.clientWidth + 2) return;
  ctx.strokeStyle = "#ff4040";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.clientHeight);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = "#ff4040";
  ctx.beginPath();
  ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8);
  ctx.closePath(); ctx.fill();
}

/* ---------- 时间轴交互 ---------- */
let drag = null;

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function hitCue(x, y) {
  for (let i = cueRects.length - 1; i >= 0; i--) {
    const r = cueRects[i];
    if (y >= r.y && y <= r.y + r.h && x >= r.x - 2 && x <= r.x + r.w + 2) {
      if (Math.abs(x - r.x) <= 5) return { rect: r, edge: "left" };
      if (Math.abs(x - (r.x + r.w)) <= 5) return { rect: r, edge: "right" };
      if (x >= r.x && x <= r.x + r.w) return { rect: r, edge: "body" };
    }
  }
  return null;
}

canvas.addEventListener("mousedown", (e) => {
  if (!state.cues.length) return;
  const { x, y } = canvasPos(e);

  if (y <= RULER_H) {                       // 标尺：拖动定位播放头
    drag = { mode: "scrub", moved: false };
    scrubTo(x);
    return;
  }
  if (y <= LANE_Y) {                        // 异常标记：点击跳转
    const mk = markers.find((m) => Math.abs(m.x - x) <= 6);
    if (mk) { jumpToCue(mk.issue.cues[0]); return; }
    drag = { mode: "pan", startX: x, startOffset: state.view.offsetSec };
    return;
  }
  const hit = hitCue(x, y);
  if (hit && !hit.rect.c.locked) {
    drag = {
      mode: hit.edge === "body" ? "move" : hit.edge,
      cue: hit.rect.c,
      startX: x,
      origStart: hit.rect.c.start,
      origEnd: hit.rect.c.end,
      snapshot: snapshot(),
      moved: false,
    };
  } else if (hit) {
    selectCue(hit.rect.c.id);               // 锁定的只能选中
  } else {
    drag = { mode: "pan", startX: x, startOffset: state.view.offsetSec };
  }
});

window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const { x } = canvasPos(e);
  const pps = state.view.pxPerSec;

  if (drag.mode === "scrub") { scrubTo(x); return; }
  if (drag.mode === "pan") {
    state.view.offsetSec = Math.max(0, drag.startOffset - (x - drag.startX) / pps);
    requestDraw();
    return;
  }
  const dt = (x - drag.startX) / pps;
  const c = drag.cue;
  if (Math.abs(dt) > 0.0005) drag.moved = true;
  if (drag.mode === "move") {
    const dur = drag.origEnd - drag.origStart;
    c.start = Math.max(0, Math.round((drag.origStart + dt) * 1000) / 1000);
    c.end = Math.round((c.start + dur) * 1000) / 1000;
  } else if (drag.mode === "left") {
    c.start = Math.min(Math.max(0, Math.round((drag.origStart + dt) * 1000) / 1000),
                       c.end - MIN_CUE_DUR);
  } else if (drag.mode === "right") {
    c.end = Math.max(Math.round((drag.origEnd + dt) * 1000) / 1000,
                     c.start + MIN_CUE_DUR);
  }
  renderEditor();
  requestDraw();
});

window.addEventListener("mouseup", () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if ((d.mode === "move" || d.mode === "left" || d.mode === "right")) {
    if (d.moved) {
      state.undoStack.push({ label: `拖动 #${d.cue.id} 时间轴`, data: d.snapshot });
      if (state.undoStack.length > 100) state.undoStack.shift();
      state.redoStack = [];
      updateHistoryButtons();
      state.selectedId = d.cue.id;
      scheduleValidate();
      renderAll();
    } else {
      selectCue(d.cue.id);
    }
  }
});

function scrubTo(x) {
  if (!state.hasVideo) return;
  player.currentTime = Math.max(0, xToSec(x));
  requestDraw();
}

canvas.addEventListener("wheel", (e) => {
  if (!state.cues.length) return;
  e.preventDefault();
  const { x } = canvasPos(e);
  const t = xToSec(x);
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  state.view.pxPerSec = Math.min(2000, Math.max(2, state.view.pxPerSec * factor));
  state.view.offsetSec = Math.max(0, t - x / state.view.pxPerSec);
  requestDraw();
}, { passive: false });

canvas.addEventListener("mousemove", (e) => {
  if (drag) { canvas.style.cursor = "grabbing"; return; }
  const { x, y } = canvasPos(e);
  const hit = y > LANE_Y && hitCue(x, y);
  canvas.style.cursor =
    !hit ? "crosshair" :
    hit.edge === "body" ? (hit.rect.c.locked ? "not-allowed" : "move") :
    hit.rect.c.locked ? "not-allowed" : "ew-resize";
});

$("btnZoomIn").onclick = () => zoomBy(1.5);
$("btnZoomOut").onclick = () => zoomBy(1 / 1.5);
$("btnFit").onclick = fitTimeline;

function zoomBy(f) {
  const center = state.view.offsetSec + viewSpan() / 2;
  state.view.pxPerSec = Math.min(2000, Math.max(2, state.view.pxPerSec * f));
  state.view.offsetSec = Math.max(0, center - viewSpan() / 2);
  requestDraw();
}

/* ================= 播放器联动 ================= */
function currentCue() {
  const t = player.currentTime;
  return state.cues.find((c) => t >= c.start && t < c.end);
}

player.addEventListener("timeupdate", () => {
  const c = currentCue();
  const ov = $("overlay");
  if (c && state.hasVideo) {
    ov.textContent = visibleText(c.text);
    ov.classList.remove("hidden");
  } else {
    ov.classList.add("hidden");
  }
  if ($("chkFollow").checked && !player.paused && state.cues.length) {
    const t = player.currentTime;
    const span = viewSpan();
    if (t < state.view.offsetSec || t > state.view.offsetSec + span * 0.9)
      state.view.offsetSec = Math.max(0, t - span * 0.15);
  }
  requestDraw();
});

player.addEventListener("play", tickLoop);
player.addEventListener("pause", requestDraw);
player.addEventListener("seeked", requestDraw);

function tickLoop() {
  if (player.paused) return;
  player.dispatchEvent(new Event("timeupdate"));
  requestAnimationFrame(tickLoop);
}

/* ================= 快捷键 ================= */
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea";
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    if (!typing) { e.preventDefault(); undo(); }
  } else if ((e.ctrlKey || e.metaKey) &&
             (e.key.toLowerCase() === "y" ||
              (e.shiftKey && e.key.toLowerCase() === "z"))) {
    if (!typing) { e.preventDefault(); redo(); }
  } else if (e.key === " " && !typing && state.hasVideo) {
    e.preventDefault();
    player.paused ? player.play() : player.pause();
  }
});

/* ================= 初始化 ================= */
(async function init() {
  try {
    const res = await fetch("/api/settings");
    state.settings = await res.json();
  } catch {
    state.settings = { ...FALLBACK_SETTINGS };
  }
  fillSettingsUI(state.settings);
  resizeCanvas();
  renderAll();
})();

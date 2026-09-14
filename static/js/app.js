"use strict";

/* ================= 状态 ================= */
const state = {
  cues: [],            // 当前工作副本
  original: [],        // 解析时的原始值（对照用）
  issues: [],
  cutIssues: [],       // 切点校对结果（跨切 / 未对齐，含建议）
  cuts: [],            // 切点（秒，升序），保存在浏览器本地
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
  cutTolerance: 0.12,
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
/* 快照同时覆盖字幕与切点，切点操作同样可撤销 */
function snapshot() {
  return JSON.stringify({ cues: state.cues, cuts: state.cuts });
}

function restoreSnapshot(data) {
  const d = JSON.parse(data);
  state.cues = d.cues;
  state.cuts = (d.cuts || []).slice().sort((a, b) => a - b);
}

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
  restoreSnapshot(item.data);
  afterHistoryChange(`已撤销：${item.label}`);
}

function redo() {
  const item = state.redoStack.pop();
  if (!item) return;
  state.undoStack.push({ label: item.label, data: snapshot() });
  restoreSnapshot(item.data);
  afterHistoryChange(`已重做：${item.label}`);
}

function afterHistoryChange(msg) {
  if (state.selectedId && !cueById(state.selectedId)) state.selectedId = null;
  updateHistoryButtons();
  saveCuts();
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
  if (!state.cues.length) {
    state.issues = [];
    state.cutIssues = [];
    renderAll();
    return;
  }
  try {
    const res = await api("/api/validate", {
      cues: state.cues, settings: state.settings, cuts: state.cuts,
    });
    state.issues = res.issues;
    state.cutIssues = res.cutIssues || [];
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
  renderCutIssues();
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
  let html = `共 ${state.cues.length} 条 ｜ 错误 <b class="e">${errs}</b> ｜ ` +
             `提示 <b class="w">${warns}</b> ｜ 已修改 <b class="m">${mods}</b> 条`;
  if (state.cuts.length) {
    const cross = state.cutIssues.filter((i) => i.type === "cross_cut").length;
    const snap = state.cutIssues.length - cross;
    html += ` ｜ 切点 ${state.cuts.length}（跨切 <b class="e">${cross}</b>` +
            ` / 未对齐 <b class="w">${snap}</b>）`;
  }
  el.innerHTML = html;
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

/* ================= 切点校对 ================= */
const CUTS_KEY = "subtitleCutPoints.v1";

function saveCuts() {
  try {
    localStorage.setItem(CUTS_KEY, JSON.stringify({
      cuts: state.cuts,
      tolerance: state.settings ? state.settings.cutTolerance : undefined,
    }));
  } catch { /* 隐私模式等场景下静默失败 */ }
}

function loadCuts() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(CUTS_KEY)); } catch { /* 忽略 */ }
  if (!d) return;
  if (Array.isArray(d.cuts)) {
    state.cuts = [...new Set(d.cuts
      .map((t) => Math.round(parseFloat(t) * 1000) / 1000)
      .filter((t) => Number.isFinite(t) && t >= 0))]
      .sort((a, b) => a - b);
  }
  if (Number.isFinite(d.tolerance) && state.settings)
    state.settings.cutTolerance = Math.max(0, d.tolerance);
}

/* 以一次可撤销操作修改切点 */
function mutateCuts(label, fn) {
  pushUndo(label);
  fn();
  state.cuts.sort((a, b) => a - b);
  saveCuts();
  scheduleValidate();
  renderAll();
}

function addCutAt(t) {
  t = Math.max(0, Math.round(t * 1000) / 1000);
  if (state.cuts.some((c) => Math.abs(c - t) < 0.0015)) {
    toast(`切点 ${secToTc(t)} 已存在`);
    return;
  }
  mutateCuts(`添加切点 ${secToTc(t)}`, () => { state.cuts.push(t); });
  toast(`已添加切点 ${secToTc(t)}`, 2000);
}

function deleteCut(t) {
  mutateCuts(`删除切点 ${secToTc(t)}`, () => {
    state.cuts = state.cuts.filter((c) => Math.abs(c - t) > 0.0005);
  });
}

function importCuts(text) {
  const found = [], bad = [];
  for (const part of text.split(/[\s,;，；]+/)) {
    if (!part) continue;
    const v = parseTc(part);
    if (v === null || v < 0) { bad.push(part); continue; }
    found.push(Math.round(v * 1000) / 1000);
  }
  const fresh = [...new Set(found)].filter(
    (t) => !state.cuts.some((c) => Math.abs(c - t) < 0.0015));
  if (fresh.length)
    mutateCuts(`导入 ${fresh.length} 个切点`, () => { state.cuts.push(...fresh); });
  let msg = `导入 ${fresh.length} 个切点`;
  if (found.length - fresh.length > 0)
    msg += `，${found.length - fresh.length} 个重复已跳过`;
  if (bad.length) msg += `，${bad.length} 处无法识别（${bad.slice(0, 3).join("、")}…）`;
  toast(msg, 6000);
}

/* 点击建议：选中字幕并把视频定位到切点处 */
function jumpToCutIssue(iss) {
  state.selectedId = iss.cues[0];
  const c = cueById(iss.cues[0]);
  if (state.hasVideo) player.currentTime = Math.max(0, iss.cut - 0.04);
  if (c) ensureVisible(Math.min(c.start, iss.cut) - 0.5,
                       Math.max(c.end, iss.cut) + 0.5);
  renderAll();
  const row = document.querySelector(`.cue[data-cid="${iss.cues[0]}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

/* 应用切点建议：targets 为 null 时批量应用全部 */
async function applyCutTargets(targets, label) {
  if (!state.cues.length) return;
  try {
    const body = { cues: state.cues, cuts: state.cuts, settings: state.settings };
    if (targets) body.targets = targets;
    const res = await api("/api/cuts/apply", body);
    pushUndo(label);
    state.cues = res.cues;
    state.issues = res.issues;
    state.cutIssues = res.cutIssues || [];
    renderAll();
    const skipped = res.changes.filter((c) => c.status === "skipped");
    let msg = `${label}：应用 ${res.stats.applied} 处`;
    if (skipped.length) {
      msg += `，${skipped.length} 处冲突保留原值\n` +
        skipped.slice(0, 8).map((c) => `· #${c.cue} ${c.reason}`).join("\n");
      if (skipped.length > 8) msg += `\n… 共 ${skipped.length} 处`;
    }
    toast(msg, skipped.length ? 8000 : 3000);
  } catch (e) {
    toast(e.message);
  }
}

function fmtPairs(pairs) {
  return pairs.map((p) => `${secToTc(p[0])}→${secToTc(p[1])}`).join(" ＋ ");
}

function renderCutIssues() {
  $("cutCount").textContent = state.cutIssues.length;
  const cross = state.cutIssues.filter((i) => i.type === "cross_cut").length;
  const snap = state.cutIssues.length - cross;
  $("cutStats").textContent = state.cuts.length
    ? `切点 ${state.cuts.length} 个 ｜ 跨切 ${cross} ｜ 未对齐 ${snap}`
    : "尚未设置切点";
  $("btnApplyAllCuts").disabled =
    !state.cutIssues.length || !state.cues.length;
  $("btnClearCuts").disabled = !state.cuts.length;

  const list = $("cutList");
  list.innerHTML = "";
  if (!state.cuts.length) {
    list.innerHTML = `<div class="empty-tip">还没有切点：播放视频时按 C 或点“✂ 当前帧切点”添加，<br>` +
      `也可以在“切点校对”面板批量导入秒数 / 时间码</div>`;
    return;
  }
  if (!state.cues.length) {
    list.innerHTML = `<div class="empty-tip">已记录 ${state.cuts.length} 个切点，载入字幕后开始校对</div>`;
    return;
  }
  if (!state.cutIssues.length) {
    list.innerHTML = `<div class="empty-tip">所有字幕均已避开或对齐 ${state.cuts.length} 个切点 🎉</div>`;
    return;
  }
  for (const iss of state.cutIssues) {
    const sug = iss.suggestion;
    const div = document.createElement("div");
    div.className = `issue ${iss.severity}`;
    div.innerHTML =
      `<div class="head"><span class="sev">${iss.severity === "error" ? "⛔ 错误" : "⚠️ 提示"}</span>` +
      `<span class="typ">[${iss.label}]</span>` +
      `<span class="refs">#${iss.cues[0]} ✂${secToTc(iss.cut)}</span></div>` +
      `<div class="msg"></div>` +
      `<div class="preview"><span class="pv-label">调整前</span> ${fmtPairs(sug.before)}\n` +
      `<span class="pv-label">调整后</span> ${fmtPairs(sug.after)}</div>` +
      (sug.feasible
        ? ""
        : `<div class="detail bad">冲突：${sug.reason}（应用时将保留原值）</div>`) +
      `<div class="actions"><button class="btn small primary" ` +
      `${sug.feasible ? "" : "disabled"}>应用此建议</button></div>`;
    div.querySelector(".msg").textContent = iss.message;
    div.onclick = (e) => {
      if (e.target.tagName !== "BUTTON") jumpToCutIssue(iss);
    };
    div.querySelector("button").onclick = (e) => {
      e.stopPropagation();
      applyCutTargets(
        [{ cue: sug.cue, action: sug.action, cut: sug.cut }],
        `应用切点建议 #${sug.cue}`);
    };
    list.appendChild(div);
  }
}

function renderCueList() {
  $("cueCount").textContent = state.cues.length;  const list = $("cueList");
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
  $("btnAddCut").disabled = false;
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
  download("/api/summary",
           { cues: state.cues, settings: state.settings, cuts: state.cuts },
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
    // 容差由切点面板维护，这里保留当前值
    cutTolerance: state.settings?.cutTolerance ?? FALLBACK_SETTINGS.cutTolerance,
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
  $("cutTol").value = s.cutTolerance;
}

for (const id of ["setCps", "setMinDur", "setMaxDur", "setMinGap",
                  "setMaxChars", "setBreakShort", "setPunct"])
  $(id).addEventListener("change", readSettingsFromUI);

/* ================= 切点面板 ================= */
$("btnCuts").onclick = () => $("cutPanel").classList.toggle("hidden");

$("btnAddCut").onclick = () => {
  if (state.hasVideo) addCutAt(player.currentTime);
};

$("btnImportCuts").onclick = () =>
  $("cutImportBox").classList.toggle("hidden");
$("btnCancelImportCuts").onclick = () =>
  $("cutImportBox").classList.add("hidden");
$("btnDoImportCuts").onclick = () => {
  const text = $("cutImportArea").value;
  if (!text.trim()) return;
  $("cutImportBox").classList.add("hidden");
  $("cutImportArea").value = "";
  importCuts(text);
};

$("btnClearCuts").onclick = () => {
  if (!state.cuts.length) return;
  if (!confirm(`清空全部 ${state.cuts.length} 个切点？（可撤销）`)) return;
  mutateCuts("清空切点", () => { state.cuts = []; });
};

$("cutTol").addEventListener("change", () => {
  const v = parseFloat($("cutTol").value);
  state.settings.cutTolerance =
    Number.isFinite(v) ? Math.max(0, v) : FALLBACK_SETTINGS.cutTolerance;
  $("cutTol").value = state.settings.cutTolerance;
  saveCuts();
  scheduleValidate();
});

$("btnApplyAllCuts").onclick = () =>
  applyCutTargets(null, "批量应用切点建议");

/* ================= 标签页与过滤 ================= */
const TABS = [
  ["issues", "tabIssues", "issueList"],
  ["cuts", "tabCuts", "cutList"],
  ["cues", "tabCues", "cueList"],
];

function switchTab(name) {
  state.tab = name;
  for (const [n, btnId, listId] of TABS) {
    $(btnId).classList.toggle("active", n === name);
    $(listId).classList.toggle("hidden", n !== name);
  }
}

$("tabIssues").onclick = () => switchTab("issues");
$("tabCuts").onclick = () => switchTab("cuts");
$("tabCues").onclick = () => switchTab("cues");
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
let cutLines = [];   // [{x, t}] 视口内的切点线
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
  const end = Math.max(1, ...state.cues.map((c) => c.end), ...state.cuts);
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
  cutLines = [];
  if (!state.cues.length) {
    drawCuts(W, H);
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

  drawCuts(W, H);
  drawPlayhead();

  // 视图信息
  $("tlInfo").textContent =
    `${secToTc(offsetSec)} — ${secToTc(offsetSec + viewSpan())} ｜ ` +
    `${Math.round(pxPerSec)} px/s`;
}

/* 切点线：贯穿整个时间轴的紫色虚线 + 顶部小旗，任何缩放级别都可见 */
function drawCuts(W, H) {
  for (const t of state.cuts) {
    const x = secToX(t);
    if (x < -2 || x > W + 2) continue;
    cutLines.push({ x, t });
    ctx.strokeStyle = "rgba(192,132,252,0.85)";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#c084fc";
    ctx.beginPath();
    ctx.moveTo(x, RULER_H + 1);
    ctx.lineTo(x - 5, RULER_H + 8);
    ctx.lineTo(x + 5, RULER_H + 8);
    ctx.closePath();
    ctx.fill();
  }
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
  if (!state.cues.length && !state.cuts.length) return;
  const { x, y } = canvasPos(e);

  if (y <= RULER_H) {                       // 标尺：拖动定位播放头
    drag = { mode: "scrub", moved: false };
    scrubTo(x);
    return;
  }
  // 切点线优先于字幕块命中（线很细，给 4px 宽容度）
  const cutHit = cutLines.find((cl) => Math.abs(cl.x - x) <= 4);
  if (cutHit) {
    drag = {
      mode: "cut", t: cutHit.t, startX: x, origT: cutHit.t,
      snapshot: snapshot(), moved: false,
    };
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
  if (drag.mode === "cut") {
    const dt = (x - drag.startX) / pps;
    if (Math.abs(dt) > 0.0005) drag.moved = true;
    const nt = Math.max(0, Math.round((drag.origT + dt) * 1000) / 1000);
    const idx = state.cuts.findIndex((c) => Math.abs(c - drag.t) < 0.0005);
    if (idx >= 0) { state.cuts[idx] = nt; drag.t = nt; }
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
  if (d.mode === "cut") {
    if (!d.moved) return;
    state.cuts.sort((a, b) => a - b);
    // 拖到已有切点附近（1.5ms 内）视为重复，放弃本次移动
    const dup = state.cuts.some(
      (c, i, arr) => i > 0 && Math.abs(c - arr[i - 1]) < 0.0015);
    if (dup) {
      state.cuts = JSON.parse(d.snapshot).cuts;
      toast("目标位置已有切点，未移动", 2500);
    } else {
      state.undoStack.push({ label: `拖动切点到 ${secToTc(d.t)}`, data: d.snapshot });
      if (state.undoStack.length > 100) state.undoStack.shift();
      state.redoStack = [];
      updateHistoryButtons();
      saveCuts();
      scheduleValidate();
    }
    renderAll();
    return;
  }
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
  if (!state.cues.length && !state.cuts.length) return;
  e.preventDefault();
  const { x } = canvasPos(e);
  const t = xToSec(x);
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  state.view.pxPerSec = Math.min(2000, Math.max(2, state.view.pxPerSec * factor));
  state.view.offsetSec = Math.max(0, t - x / state.view.pxPerSec);
  requestDraw();
}, { passive: false });

/* 右键点击切点线：删除该切点 */
canvas.addEventListener("contextmenu", (e) => {
  const { x, y } = canvasPos(e);
  if (y <= RULER_H) return;
  const cutHit = cutLines.find((cl) => Math.abs(cl.x - x) <= 4);
  if (cutHit) {
    e.preventDefault();
    deleteCut(cutHit.t);
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (drag) { canvas.style.cursor = "grabbing"; return; }
  const { x, y } = canvasPos(e);
  if (y > RULER_H && cutLines.some((cl) => Math.abs(cl.x - x) <= 4)) {
    canvas.style.cursor = "ew-resize";
    return;
  }
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
  } else if (e.key.toLowerCase() === "c" && !typing && state.hasVideo &&
             !e.ctrlKey && !e.metaKey && !e.altKey) {
    addCutAt(player.currentTime);
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
  loadCuts();          // 恢复浏览器本地保存的切点与容差
  fillSettingsUI(state.settings);
  resizeCanvas();
  renderAll();
})();

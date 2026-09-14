"""字幕节奏校对核心逻辑：SRT/VTT 解析、节奏校验、批量修复与导出。

纯 Python 实现，不依赖第三方库，方便单独测试。
时间单位统一为秒（float，毫秒精度），字幕用 dict 表示：
    {"id": int, "start": float, "end": float, "text": str, "locked": bool}
"""

from __future__ import annotations

import copy
import re
from datetime import datetime

EPS = 1e-4  # 时间比较容差（秒）
MIN_CUE_DUR = 0.04  # 自动调整保留的最短时长（秒，约一帧）
MAX_FIX_PASSES = 50  # 消重叠迭代上限（保险用，正常远早于此收敛）

# 行尾出现这些标点视为自然断句位置
BREAK_OK_CHARS = "，。！？；：、…—–,.!?;:）》」』%”’\"'"
# 句尾出现这些连接标点视为悬置（话被切断）
DANGLING_CHARS = "，、：—–～,;"
# 引号/括号配对（值为 None 表示自配对，按出现次数判断）
PAIRS = {"“": "”", "「": "」", "『": "』", "《": "》",
         "（": "）", "【": "】", "(": ")", "“": "”"}
SELF_PAIRED = {'"', "'"}

DEFAULT_SETTINGS = {
    "cpsMax": 20.0,           # 阅读速度上限：每秒字符数
    "minDuration": 1.0,       # 最短持续时间（秒），低于视为闪帧
    "maxDuration": 7.0,       # 最长持续时间（秒）
    "minGap": 0.08,           # 相邻字幕最小间隔（秒）
    "maxCharsPerLine": 20,    # 单行最大字数
    "breakShortLine": 3,      # 断句短行阈值：行字数 <= 该值视为碎行
    "checkPunctuation": True, # 是否启用标点断句检查
    "cutTolerance": 0.12,     # 切点吸附容差（秒）：首尾距切点在该范围内视为未对齐
}

TYPE_LABELS = {
    "overlap": "叠轴",
    "too_short": "闪帧",
    "too_long": "超长",
    "cps": "阅读过快",
    "gap": "间隔过小",
    "line_length": "单行过长",
    "line_break": "断句不当",
    "order": "时间倒置",
    "cross_cut": "跨切字幕",
    "cut_snap": "切点未对齐",
}

_TIMING_RE = re.compile(
    r"(?:(?P<h>\d{1,2}):)?(?P<m>\d{1,2}):(?P<s>\d{2})[,.](?P<ms>\d{1,3})"
)
_TAG_RE = re.compile(r"<[^>]+>")
_ASS_RE = re.compile(r"\{[^}]*\}")


# ---------------------------------------------------------------- 时间码

def parse_timecode(text: str) -> float | None:
    """解析 'HH:MM:SS,mmm' / 'MM:SS.mmm' 等形式，失败返回 None。"""
    m = _TIMING_RE.search(text.strip())
    if not m:
        return None
    h = int(m.group("h") or 0)
    ms = int(m.group("ms").ljust(3, "0")[:3])
    return h * 3600 + int(m.group("m")) * 60 + int(m.group("s")) + ms / 1000.0


def _fmt(sec: float, sep: str) -> str:
    total_ms = max(0, int(round(sec * 1000)))
    h, rem = divmod(total_ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def fmt_srt(sec: float) -> str:
    return _fmt(sec, ",")


def fmt_vtt(sec: float) -> str:
    return _fmt(sec, ".")


# ---------------------------------------------------------------- 解析

def _new_cue(cid: int, start: float, end: float, text: str) -> dict:
    return {"id": cid, "start": round(start, 3), "end": round(end, 3),
            "text": text.strip("\n"), "locked": False}


def _split_blocks(text: str) -> list[list[str]]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks, cur = [], []
    for line in text.split("\n"):
        if line.strip() == "":
            if cur:
                blocks.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        blocks.append(cur)
    return blocks


def parse_srt(text: str) -> list[dict]:
    cues = []
    for block in _split_blocks(text.lstrip("﻿")):
        t_idx = next((i for i, ln in enumerate(block) if "-->" in ln), None)
        if t_idx is None:
            continue
        parts = block[t_idx].split("-->")
        start, end = parse_timecode(parts[0]), parse_timecode(parts[1])
        if start is None or end is None:
            continue
        cues.append(_new_cue(len(cues) + 1, start, end,
                             "\n".join(block[t_idx + 1:])))
    return cues


def parse_vtt(text: str) -> list[dict]:
    cues = []
    for block in _split_blocks(text.lstrip("﻿")):
        head = block[0].strip()
        if head.startswith("WEBVTT") or head.startswith(("NOTE", "STYLE", "REGION")):
            continue
        t_idx = next((i for i, ln in enumerate(block) if "-->" in ln), None)
        if t_idx is None:
            continue
        parts = block[t_idx].split("-->")
        start, end = parse_timecode(parts[0]), parse_timecode(parts[1])
        if start is None or end is None:
            continue
        cues.append(_new_cue(len(cues) + 1, start, end,
                             "\n".join(block[t_idx + 1:])))
    return cues


def parse_subtitles(text: str) -> tuple[list[dict], str]:
    """自动识别格式，返回 (cues, 'srt'|'vtt')。"""
    fmt = "vtt" if text.lstrip("﻿ \t").startswith("WEBVTT") else "srt"
    cues = parse_vtt(text) if fmt == "vtt" else parse_srt(text)
    if not cues:
        raise ValueError("未能从文本中解析出任何字幕，请检查格式")
    return cues, fmt


# ---------------------------------------------------------------- 文本度量

def visible_text(text: str) -> str:
    """去掉 HTML/ASS 标签后的可见文本。"""
    return _ASS_RE.sub("", _TAG_RE.sub("", text))


def char_count(text: str) -> int:
    """可见非空白字符数（用于 CPS 与单行字数）。"""
    return sum(1 for ch in visible_text(text) if not ch.isspace())


def text_lines(text: str) -> list[str]:
    return [ln.strip() for ln in visible_text(text).split("\n")]


# ---------------------------------------------------------------- 校验

def merge_settings(settings: dict | None) -> dict:
    merged = dict(DEFAULT_SETTINGS)
    if settings:
        for key in DEFAULT_SETTINGS:
            if key in settings and settings[key] is not None:
                merged[key] = settings[key]
    for key in ("cpsMax", "minDuration", "maxDuration"):
        merged[key] = max(0.01, float(merged[key]))
    merged["minGap"] = max(0.0, float(merged["minGap"]))
    merged["cutTolerance"] = max(0.0, float(merged["cutTolerance"]))
    merged["maxCharsPerLine"] = max(1, int(merged["maxCharsPerLine"]))
    merged["breakShortLine"] = max(1, int(merged["breakShortLine"]))
    merged["checkPunctuation"] = bool(merged["checkPunctuation"])
    return merged


def _check_pairs(text: str) -> str | None:
    """检查引号/括号配对，返回问题描述或 None。"""
    for op, cl in PAIRS.items():
        if text.count(op) != text.count(cl):
            return f"「{op}{cl}」数量不匹配（{text.count(op)} 对 {text.count(cl)}）"
    for ch in SELF_PAIRED:
        if text.count(ch) % 2 != 0:
            return f"引号 {ch} 未闭合"
    return None


def validate(cues: list[dict], settings: dict | None = None) -> list[dict]:
    """按阈值校验字幕节奏，返回问题列表。

    每个问题：{"id", "type", "severity"("error"|"warning"), "cues":[id...],
               "message", "detail"}
    """
    st = merge_settings(settings)
    issues: list[dict] = []

    def add(itype, severity, cue_ids, message, detail=""):
        issues.append({
            "id": f"i{len(issues) + 1}",
            "type": itype,
            "label": TYPE_LABELS[itype],
            "severity": severity,
            "cues": list(cue_ids),
            "message": message,
            "detail": detail,
        })

    ordered = sorted(cues, key=lambda c: (c["start"], c["id"]))

    for c in ordered:
        cid = c["id"]
        dur = c["end"] - c["start"]
        vis = visible_text(c["text"])
        nchars = char_count(c["text"])

        # 时间倒置
        if dur <= EPS:
            add("order", "error", [cid],
                "开始时间晚于或等于结束时间",
                f"时长 {dur:.3f}s，时间轴倒置")
            continue  # 时长无效，其余基于时长的检查无意义

        # 闪帧 / 过短
        if dur < st["minDuration"] - EPS:
            add("too_short", "error", [cid],
                f"持续 {dur:.2f}s，低于最短时长 {st['minDuration']:.2f}s",
                "停留时间过短，观众来不及阅读（闪帧）")
        elif dur < st["minDuration"] * 1.25 - EPS:
            add("too_short", "warning", [cid],
                f"持续 {dur:.2f}s，接近最短时长 {st['minDuration']:.2f}s",
                "略长于闪帧阈值，仍可能阅读仓促")

        # 超长
        if dur > st["maxDuration"] * 1.5 + EPS:
            add("too_long", "error", [cid],
                f"持续 {dur:.2f}s，远超最长时长 {st['maxDuration']:.2f}s",
                "字幕长时间挂屏，容易与画面脱节")
        elif dur > st["maxDuration"] + EPS:
            add("too_long", "warning", [cid],
                f"持续 {dur:.2f}s，超过最长时长 {st['maxDuration']:.2f}s",
                "建议拆分或收紧时间码")

        # 阅读速度 CPS
        cps = nchars / dur
        if cps > st["cpsMax"] * 1.5 + EPS:
            add("cps", "error", [cid],
                f"阅读速度 {cps:.1f} 字/秒，远超上限 {st['cpsMax']:.0f}",
                f"共 {nchars} 字 / {dur:.2f}s，观众无法读完")
        elif cps > st["cpsMax"] + EPS:
            add("cps", "warning", [cid],
                f"阅读速度 {cps:.1f} 字/秒，超过上限 {st['cpsMax']:.0f}",
                f"共 {nchars} 字 / {dur:.2f}s，建议延长时间或精简文字")

        # 单行字数
        lines = text_lines(c["text"])
        max_len = max((char_count(ln) for ln in lines), default=0)
        if max_len > st["maxCharsPerLine"] * 1.5:
            add("line_length", "error", [cid],
                f"单行 {max_len} 字，远超上限 {st['maxCharsPerLine']} 字",
                "单行过长会超出安全框，必须换行")
        elif max_len > st["maxCharsPerLine"]:
            add("line_length", "warning", [cid],
                f"单行 {max_len} 字，超过上限 {st['maxCharsPerLine']} 字",
                "建议在标点处换行")

        # 标点断句
        if st["checkPunctuation"]:
            if len(lines) > 1:
                for idx, ln in enumerate(lines):
                    n = char_count(ln)
                    if n == 0:
                        add("line_break", "warning", [cid],
                            f"第 {idx + 1} 行为空行", "多余空行会导致显示闪烁")
                    elif n <= st["breakShortLine"]:
                        add("line_break", "error", [cid],
                            f"第 {idx + 1} 行仅 {n} 字，断行过碎",
                            f"短行阈值 {st['breakShortLine']} 字，应并入相邻行")
                for idx, ln in enumerate(lines[:-1]):
                    core = ln.rstrip()
                    if core and core[-1] not in BREAK_OK_CHARS:
                        add("line_break", "warning", [cid],
                            f"第 {idx + 1} 行结尾「{core[-1]}」不是标点，疑似硬断行",
                            "应在标点处断行，避免割裂词组")
            tail = vis.rstrip()
            if tail and tail[-1] in DANGLING_CHARS:
                add("line_break", "warning", [cid],
                    f"句尾连接标点「{tail[-1]}」悬置",
                    "句尾逗号/顿号/破折号表示话被切断，建议调整断句位置")
            pair_msg = _check_pairs(vis)
            if pair_msg:
                add("line_break", "error", [cid],
                    f"引号或括号未闭合：{pair_msg}",
                    "改稿时可能删掉了配对的另一半")

    # 相邻关系：叠轴与间隔
    for prev, cur in zip(ordered, ordered[1:]):
        gap = cur["start"] - prev["end"]
        if gap < -EPS:
            overlap = -gap
            sev = "error" if overlap >= 0.1 else "warning"
            add("overlap", sev, [prev["id"], cur["id"]],
                f"第 {prev['id']} 条与第 {cur['id']} 条重叠 {overlap:.3f}s",
                "两条字幕同时挂屏（叠轴），需错开时间码")
        elif gap < st["minGap"] - EPS:
            sev = "error" if gap < st["minGap"] * 0.5 - EPS else "warning"
            add("gap", sev, [prev["id"], cur["id"]],
                f"第 {prev['id']} 条与第 {cur['id']} 条间隔仅 {max(gap, 0):.3f}s",
                f"小于最小间隔 {st['minGap']:.2f}s，切换时会产生闪烁感")

    return issues


# ---------------------------------------------------------------- 批量修复

def _r3(x: float) -> float:
    return round(x + 0.0, 3)


def batch_fix(cues: list[dict], settings: dict | None = None):
    """批量修复：消除相邻重叠，并利用前后空档重新分配过短字幕的时长。

    不改动字幕文字与顺序；locked=True 的字幕不参与自动调整。
    返回 (fixed_cues, changes)，changes 记录每条改动或无法修复的原因。
    """
    st = merge_settings(settings)
    fixed = copy.deepcopy(cues)
    ordered = sorted(fixed, key=lambda c: (c["start"], c["id"]))
    changes: list[dict] = []

    def log(cue, before, reason):
        changes.append({
            "cue": cue["id"],
            "before": [before[0], before[1]],
            "after": [cue["start"], cue["end"]],
            "reason": reason,
        })

    # ---- 第一遍：消除相邻重叠 ----
    # 分割会把后一条的起点后移，可能越过再后面字幕的起点，使列表顺序
    # 与时间顺序暂时不符、并产生跨越多条的重叠；因此每轮重排并扫描，
    # 迭代至一整轮没有任何调整为止（分割单调收缩，必然收敛）。
    #
    # 顺序保持：以输入时的 (start, id) 顺序为准，每条字幕的起点最多
    # 移到其输入顺序后继的当前起点处，不会越过，保证字幕先后次序不变。
    successors: dict[int, dict] = {}
    seq = sorted(fixed, key=lambda c: (c["start"], c["id"]))
    for a, b in zip(seq, seq[1:]):
        successors[a["id"]] = b

    def succ_limit(c: dict) -> float:
        """c 的起点允许到达的上限（其输入顺序后继的当前起点）。"""
        s = successors.get(c["id"])
        if s is None:
            return float("inf")
        lim = s["start"]
        if c["id"] > s["id"]:
            # 起点相同按 id 排序：id 更大时必须严格更小（1ms）
            lim -= 0.001
        return lim

    def shift_chain_forward(first: dict, delta: float) -> bool:
        """将 first 及被级联顶到的后继整体后移 delta（时长不变）。

        只移动相互衔接的连续段，遇大空档即停；若链上有必须移动但已
        锁定的字幕，则不移动任何字幕并返回 False。
        """
        moves = []
        d = delta
        c = first
        while d > EPS:
            if c["locked"]:
                return False
            moves.append((c, d))
            succ = successors.get(c["id"])
            if succ is None:
                break
            need = c["end"] + d + st["minGap"]  # c 后移后的 end + 间隔
            if succ["start"] >= need - EPS:
                break
            d = need - succ["start"]
            c = succ
        for c, d in moves:
            before = (c["start"], c["end"])
            c["start"] = _r3(c["start"] + d)
            c["end"] = _r3(c["end"] + d)
            log(c, before, "为消除前序重叠，利用后方空档整体后移")
        return True

    for _ in range(MAX_FIX_PASSES):
        ordered.sort(key=lambda c: (c["start"], c["id"]))
        mutated = False
        for i in range(1, len(ordered)):
            prev, cur = ordered[i - 1], ordered[i]
            # 只有真正相交才处理（顺序暂时错乱但互不相交的跳过即可，
            # 下一轮重排后自然恢复）
            if cur["start"] >= prev["end"] - EPS or \
                    prev["start"] >= cur["end"] - EPS:
                continue
            if prev["locked"] and cur["locked"]:
                continue
            if prev["locked"]:
                # 后移本条，但不越过后继起点
                new_start = min(prev["end"] + st["minGap"], succ_limit(cur))
                if new_start > cur["start"] + EPS:
                    before = (cur["start"], cur["end"])
                    shift = new_start - cur["start"]
                    cur["start"] = _r3(cur["start"] + shift)
                    cur["end"] = _r3(cur["end"] + shift)
                    log(cur, before,
                        f"第 {prev['id']} 条已锁定，将本条整体后移以消除重叠")
                    mutated = True
            elif cur["locked"]:
                before = (prev["start"], prev["end"])
                prev["end"] = _r3(cur["start"] - st["minGap"])
                if prev["end"] <= prev["start"] + EPS:
                    prev["end"] = _r3(prev["start"] + MIN_CUE_DUR)
                if abs(prev["end"] - before[1]) > EPS:
                    log(prev, before,
                        f"第 {cur['id']} 条已锁定，提前本条结束点以消除重叠")
                    mutated = True
            else:
                before_p = (prev["start"], prev["end"])
                before_c = (cur["start"], cur["end"])
                # 真实重叠区间：两区间的交集。一条包含另一条（嵌套）时，
                # 交集等于被包含条的整个范围，而不是 [cur.start, prev.end]。
                lo = max(prev["start"], cur["start"])
                hi = min(prev["end"], cur["end"])
                mid = (lo + hi) / 2
                # 中点分割的可行边界区间：两条都至少保留 MIN_CUE_DUR，
                # 即 prev.end >= prev.start + MIN_CUE_DUR 且
                #   cur.start <= cur.end - MIN_CUE_DUR
                lo_b = prev["start"] + MIN_CUE_DUR
                hi_b_own = cur["end"] - MIN_CUE_DUR
                done = False
                if hi_b_own - lo_b >= -EPS:
                    # 自身跨度够分割；若后继挡住边界，先把后继链整体
                    # 后移腾位（密集嵌套链会逐级把尾部推向空档）
                    gap0 = min(st["minGap"], hi_b_own - lo_b)
                    b_ideal = min(max(mid, lo_b + gap0 / 2),
                                  hi_b_own - gap0 / 2)
                    need = b_ideal + gap0 / 2
                    lim = succ_limit(cur)
                    if need > lim + EPS:
                        succ = successors.get(cur["id"])
                        if succ is not None and \
                                shift_chain_forward(succ, need - lim):
                            lim = succ_limit(cur)
                    hi_b = min(hi_b_own, lim)
                    if hi_b - lo_b >= -EPS:
                        gap = min(st["minGap"], max(0.0, hi_b - lo_b))
                        b = min(max(mid, lo_b + gap / 2), hi_b - gap / 2)
                        prev["end"] = _r3(b - gap / 2)
                        cur["start"] = _r3(b + gap / 2)
                        log(prev, before_p,
                            "与后一条重叠，按重叠区间中点重新划分边界")
                        log(cur, before_c,
                            "与前一条重叠，按重叠区间中点重新划分边界")
                        mutated = True
                        done = True
                if not done:
                    # 中点分割不可行（窗口不足两条最短时长，或后继被
                    # 锁定挡住）：prev 压缩到最短时长（如需要），cur 及
                    # 其衔接链整体移到 prev 之后，利用后方空档保持时长
                    if hi_b_own - lo_b < -EPS and \
                            prev["end"] > lo_b + EPS:
                        prev["end"] = _r3(lo_b)
                        log(prev, before_p,
                            "重叠区间跨度过小，本条压缩到最短时长")
                        mutated = True
                    target = prev["end"] + st["minGap"]
                    if target > cur["start"] + EPS and \
                            shift_chain_forward(cur, target - cur["start"]):
                        mutated = True
        if not mutated:
            break

    # ---- 统一报告未能消除的重叠 ----
    ordered.sort(key=lambda c: (c["start"], c["id"]))
    for prev, cur in zip(ordered, ordered[1:]):
        if cur["start"] >= prev["end"] - EPS or \
                prev["start"] >= cur["end"] - EPS:
            continue
        if prev["locked"] and cur["locked"]:
            reason = f"第 {prev['id']}、{cur['id']} 条均已锁定，重叠未处理"
        elif prev["locked"] or cur["locked"]:
            lid = prev["id"] if prev["locked"] else cur["id"]
            reason = f"第 {lid} 条已锁定且空间不足，重叠未能完全消除"
        else:
            reason = ("重叠区间跨度不足或受相邻字幕阻挡，"
                      "无法自动分割，请手动处理")
        changes.append({"cue": cur["id"], "before": None, "after": None,
                        "reason": reason})

    # ---- 第二遍：利用前后空档补足过短时长 ----
    for i, cur in enumerate(ordered):
        if cur["locked"]:
            continue
        dur = cur["end"] - cur["start"]
        if dur <= EPS:
            continue
        need = max(st["minDuration"], char_count(cur["text"]) / st["cpsMax"])
        need = min(need, st["maxDuration"])  # 不追求超过最长时长
        if dur >= need - EPS:
            continue
        deficit = need - dur
        before = (cur["start"], cur["end"])

        next_start = ordered[i + 1]["start"] if i + 1 < len(ordered) else float("inf")
        room_after = max(0.0, next_start - st["minGap"] - cur["end"])
        grow = min(deficit, room_after)
        if grow > EPS:
            cur["end"] = _r3(cur["end"] + grow)
            deficit -= grow

        if deficit > EPS:
            prev_end = ordered[i - 1]["end"] if i > 0 else 0.0
            room_before = max(0.0, cur["start"] - (prev_end + st["minGap"]))
            grow = min(deficit, room_before)
            if grow > EPS:
                cur["start"] = _r3(cur["start"] - grow)
                deficit -= grow

        if deficit > EPS:
            log(cur, before, f"时长不足 {need:.2f}s，已利用空档延长，仍差 {deficit:.2f}s（空间不足）")
        else:
            log(cur, before, f"时长不足 {need:.2f}s，利用前后空档补足")

    return ordered, changes


# ---------------------------------------------------------------- 切点校对

def _coerce_cuts(cuts) -> list[float]:
    """整理成升序、去重、非负的切点秒数列表。"""
    out = set()
    for t in cuts or []:
        try:
            v = round(float(t), 3)
        except (TypeError, ValueError):
            continue
        if v >= 0:
            out.add(v)
    return sorted(out)


def _snap_start_ok(cue: dict, t: float, prev: dict | None,
                   min_gap: float) -> tuple[bool, str]:
    """片头吸附到 t 的约束检查：有效时长 + 与前一条的最小间隔。"""
    if t < -EPS:
        return False, "切点时间小于 0"
    if cue["end"] - t < MIN_CUE_DUR - EPS:
        return False, f"吸附后时长不足最短有效时长 {MIN_CUE_DUR:.2f}s"
    if prev is not None and prev["end"] + min_gap > t + EPS:
        return False, f"吸附后与第 {prev['id']} 条间隔不足 {min_gap:.2f}s"
    return True, ""


def _snap_end_ok(cue: dict, t: float, nxt: dict | None,
                 min_gap: float) -> tuple[bool, str]:
    """片尾吸附到 t 的约束检查：有效时长 + 与后一条的最小间隔。"""
    if t - cue["start"] < MIN_CUE_DUR - EPS:
        return False, f"吸附后时长不足最短有效时长 {MIN_CUE_DUR:.2f}s"
    if nxt is not None and nxt["start"] - min_gap < t - EPS:
        return False, f"吸附后与第 {nxt['id']} 条间隔不足 {min_gap:.2f}s"
    return True, ""


def _split_ok(cue: dict, t: float, min_gap: float) -> tuple[bool, str]:
    """切点处拆分的约束检查：两半都至少保留最短有效时长。"""
    half = min_gap / 2
    if t - half - cue["start"] < MIN_CUE_DUR - EPS or \
            cue["end"] - (t + half) < MIN_CUE_DUR - EPS:
        return False, (f"切点距片头/片尾过近，拆分后片段不足最短有效时长 "
                       f"{MIN_CUE_DUR:.2f}s")
    return True, ""


def check_cuts(cues: list[dict], cuts,
               settings: dict | None = None) -> list[dict]:
    """切点校对：找出跨切字幕，以及首尾距切点一个容差内却未对齐的字幕。

    每条问题附带 suggestion：跨切 → 拆分建议；未对齐 → 吸附建议。
    suggestion.feasible 是约束预检（锁定/最小间隔/有效时长），冲突时
    应用会保留原值并在改动记录中写明原因。
    """
    st = merge_settings(settings)
    cut_list = _coerce_cuts(cuts)
    if not cut_list:
        return []
    tol = st["cutTolerance"]
    half = st["minGap"] / 2
    ordered = sorted(cues, key=lambda c: (c["start"], c["id"]))

    issues: list[dict] = []

    def add(itype, severity, cue, t, edge, message, detail, suggestion):
        issues.append({
            "id": f"cut{len(issues) + 1}",
            "type": itype,
            "label": TYPE_LABELS[itype],
            "severity": severity,
            "cues": [cue["id"]],
            "cut": t,
            "edge": edge,
            "message": message,
            "detail": detail,
            "suggestion": suggestion,
        })

    for i, c in enumerate(ordered):
        if c["end"] - c["start"] <= EPS:
            continue  # 时间倒置的条目不参与切点判定
        prev = ordered[i - 1] if i > 0 else None
        nxt = ordered[i + 1] if i + 1 < len(ordered) else None
        s, e = c["start"], c["end"]
        # 已与任一切点对齐的边界不再给吸附建议：切点间距可能小于容差，
        # 对齐到其中一个后不应再被另一个拉走（保证批量应用幂等）
        aligned_start = any(abs(t - s) <= EPS for t in cut_list)
        aligned_end = any(abs(t - e) <= EPS for t in cut_list)
        win = [t for t in cut_list if s - tol - EPS <= t <= e + tol + EPS]
        # 每端只吸附到最近的切点
        snap_start_cut = None if aligned_start else min(
            (t for t in win if EPS < abs(t - s) <= tol + EPS),
            key=lambda t: abs(t - s), default=None)
        snap_end_cut = None if aligned_end else min(
            (t for t in win if EPS < abs(t - e) <= tol + EPS),
            key=lambda t: abs(t - e), default=None)
        for t in win:
            d_start = t - s
            d_end = e - t
            if t == snap_start_cut and \
                    (t != snap_end_cut or abs(d_start) <= abs(d_end)):
                ok, reason = _snap_start_ok(c, t, prev, st["minGap"])
                if not ok and prev is not None and \
                        prev["end"] + st["minGap"] > t + EPS and \
                        abs(prev["end"] - t) <= tol + EPS:
                    # 相邻对已在容差内夹住切点（如前一条终于切点、或已按
                    # ±半个最小间隔拆好），吸附必然被邻居挡住且无可达成的
                    # 改进，不重复报
                    continue
                if c.get("locked"):
                    ok, reason = False, "字幕已锁定"
                add("cut_snap", "warning", c, t, "start",
                    f"片头距切点 {fmt_srt(t)} 仅 {abs(d_start) * 1000:.0f}ms，未对齐",
                    "建议把片头吸附到切点，避免字幕出现与画面切换错位",
                    {"action": "snap_start", "cue": c["id"], "cut": t,
                     "before": [[s, e]],
                     "after": [[t, e]],
                     "feasible": ok, "reason": reason})
            elif t == snap_end_cut:
                ok, reason = _snap_end_ok(c, t, nxt, st["minGap"])
                if not ok and nxt is not None and \
                        nxt["start"] - st["minGap"] < t - EPS and \
                        abs(nxt["start"] - t) <= tol + EPS:
                    continue  # 同上：相邻对已夹住切点
                if c.get("locked"):
                    ok, reason = False, "字幕已锁定"
                add("cut_snap", "warning", c, t, "end",
                    f"片尾距切点 {fmt_srt(t)} 仅 {abs(d_end) * 1000:.0f}ms，未对齐",
                    "建议把片尾吸附到切点，避免画面切换后字幕残留",
                    {"action": "snap_end", "cue": c["id"], "cut": t,
                     "before": [[s, e]],
                     "after": [[s, t]],
                     "feasible": ok, "reason": reason})
            elif d_start > tol + EPS and d_end > tol + EPS:
                ok, reason = _split_ok(c, t, st["minGap"])
                if c.get("locked"):
                    ok, reason = False, "字幕已锁定"
                add("cross_cut", "error", c, t, None,
                    f"字幕横跨切点 {fmt_srt(t)}（切点位于片内 {d_start:.2f}s 处）",
                    "画面已切换但字幕未更换，建议在切点处拆分",
                    {"action": "split", "cue": c["id"], "cut": t,
                     "before": [[s, e]],
                     "after": [[s, _r3(t - half)],
                               [_r3(t + half), e]],
                     "feasible": ok, "reason": reason})
    return issues


def _visible_char_indices(text: str) -> list[int]:
    """可见字符在原文中的索引（跳过 HTML/ASS 标签与空白）。"""
    idxs = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "<":
            j = text.find(">", i + 1)
            if j != -1:
                i = j + 1
                continue
        elif ch == "{":
            j = text.find("}", i + 1)
            if j != -1:
                i = j + 1
                continue
        if not ch.isspace():
            idxs.append(i)
        i += 1
    return idxs


def split_text(text: str, ratio: float) -> tuple[str, str]:
    """按时间比例把字幕文本拆成两段（供切点拆分使用）。

    优先落在附近的换行处，其次落在断句标点之后，否则按可见字符比例
    直切；可见字符不足两个时无法拆分，两段均保留原文。
    """
    idxs = _visible_char_indices(text)
    total = len(idxs)
    if total <= 1:
        return text, text
    target = min(total - 1, max(1, round(total * ratio)))
    cut = idxs[target]  # 在第 target+1 个可见字符之前断开
    window = max(3, total // 3)
    best = None  # (距离, 优先级, 位置)，换行优先于标点
    for j, ch in enumerate(text):
        if ch == "\n":
            cand = (abs(j - cut), 0, j)
        elif j > 0 and text[j - 1] in BREAK_OK_CHARS:
            cand = (abs(j - cut), 1, j)
        else:
            continue
        if cand[0] > window:
            continue
        # 断点后两段都必须还有可见字符
        if not any(i < cand[2] for i in idxs) or \
                not any(i >= cand[2] for i in idxs):
            continue
        if best is None or cand < best:
            best = cand
    if best is not None:
        cut = best[2]
    return text[:cut].strip("\n"), text[cut:].strip("\n")


def _apply_cut_suggestion(work: list[dict], sugg: dict,
                          st: dict) -> tuple[bool, dict]:
    """尝试应用单条切点建议；返回 (是否应用, 改动记录)。

    冲突（锁定/最小间隔/有效时长/建议过期）时不修改 work，记录保留原值
    及原因。
    """
    cue = next((c for c in work if c["id"] == sugg["cue"]), None)
    base = {"cue": sugg["cue"], "action": sugg["action"], "cut": sugg["cut"]}
    if cue is None:
        return False, {**base, "status": "skipped", "before": None,
                       "after": None, "reason": "字幕已不存在，未改动"}
    before = [[cue["start"], cue["end"]]]
    t = sugg["cut"]
    g = st["minGap"]

    def skip(reason):
        return False, {**base, "status": "skipped", "before": before,
                       "after": before, "reason": reason}

    if cue.get("locked"):
        return skip("字幕已锁定，保留原值")

    ordered = sorted(work, key=lambda c: (c["start"], c["id"]))
    idx = ordered.index(cue)
    prev = ordered[idx - 1] if idx > 0 else None
    nxt = ordered[idx + 1] if idx + 1 < len(ordered) else None
    action = sugg["action"]

    if action == "snap_start":
        if abs(cue["start"] - t) <= EPS:
            return skip("片头已与切点对齐")
        ok, reason = _snap_start_ok(cue, t, prev, g)
        if not ok:
            return skip(reason + "，保留原值")
        cue["start"] = _r3(t)
        return True, {**base, "status": "applied", "before": before,
                      "after": [[cue["start"], cue["end"]]],
                      "reason": f"片头吸附到切点 {fmt_srt(t)}"}

    if action == "snap_end":
        if abs(cue["end"] - t) <= EPS:
            return skip("片尾已与切点对齐")
        ok, reason = _snap_end_ok(cue, t, nxt, g)
        if not ok:
            return skip(reason + "，保留原值")
        cue["end"] = _r3(t)
        return True, {**base, "status": "applied", "before": before,
                      "after": [[cue["start"], cue["end"]]],
                      "reason": f"片尾吸附到切点 {fmt_srt(t)}"}

    # split：在切点处拆分，两半之间留出最小间隔
    if not (cue["start"] + EPS < t < cue["end"] - EPS):
        return skip("切点已不在字幕范围内，未拆分")
    ok, reason = _split_ok(cue, t, g)
    if not ok:
        return skip(reason + "，保留原值")
    half = g / 2
    lo, hi = _r3(t - half), _r3(t + half)
    ratio = (t - cue["start"]) / (cue["end"] - cue["start"])
    text_a, text_b = split_text(cue["text"], ratio)
    new_id = max(c["id"] for c in work) + 1
    end0 = cue["end"]
    note = ""
    if cue["text"].strip() and text_a == cue["text"] and text_b == cue["text"]:
        note = "；文本过短无法拆分，两段均保留原文，请手动调整"
    cue["end"] = lo
    cue["text"] = text_a
    work.append({"id": new_id, "start": hi, "end": end0,
                 "text": text_b, "locked": False})
    return True, {**base, "status": "applied", "before": before,
                  "after": [[cue["start"], lo], [hi, end0]],
                  "reason": f"在切点 {fmt_srt(t)} 处拆分（新字幕 #{new_id}）{note}"}


def apply_cut_suggestions(cues: list[dict], cuts,
                          settings: dict | None = None,
                          targets: list[dict] | None = None):
    """应用切点建议（拆分/吸附）。

    targets 为 None 时批量应用当前全部建议；否则只应用指定项（每项
    {"cue": id, "action": "split"|"snap_start"|"snap_end", "cut": 秒}）。
    返回 (new_cues, changes)；冲突项保留原值并在 changes 中写明原因。
    """
    st = merge_settings(settings)
    work = copy.deepcopy(cues)
    changes: list[dict] = []

    def suggestions_now():
        return [iss["suggestion"] for iss in check_cuts(work, cuts, st)]

    if targets is None:
        # 批量：每应用一条就重算建议（几何已变化）；同一字幕的同一端只
        # 吸附一次，避免相邻两个切点之间来回吸附；一轮全部不可应用时
        # 记录冲突原因后结束
        done_edges: set[tuple[str, int]] = set()
        cap = 4 * (len(work) + len(_coerce_cuts(cuts))) + 50
        for _ in range(cap):
            todo = [s for s in suggestions_now()
                    if not (s["action"] in ("snap_start", "snap_end") and
                            (s["action"], s["cue"]) in done_edges)]
            if not todo:
                break
            progress = False
            for s in todo:
                ok, rec = _apply_cut_suggestion(work, s, st)
                if ok:
                    changes.append(rec)
                    if s["action"] in ("snap_start", "snap_end"):
                        done_edges.add((s["action"], s["cue"]))
                    progress = True
                    break
            if not progress:
                for s in todo:
                    _, rec = _apply_cut_suggestion(work, s, st)
                    changes.append(rec)
                break
    else:
        for t in targets:
            sugg = next(
                (s for s in suggestions_now()
                 if s["cue"] == t.get("cue") and s["action"] == t.get("action")
                 and abs(s["cut"] - float(t.get("cut", -1))) < 0.002),
                None)
            if sugg is None:
                changes.append({
                    "cue": t.get("cue"), "action": t.get("action"),
                    "cut": t.get("cut"), "status": "skipped",
                    "before": None, "after": None,
                    "reason": "建议已过期（字幕或切点已变化），未改动",
                })
                continue
            _, rec = _apply_cut_suggestion(work, sugg, st)
            changes.append(rec)

    work.sort(key=lambda c: (c["start"], c["id"]))
    return work, changes


# ---------------------------------------------------------------- 导出

def export_srt(cues: list[dict]) -> str:
    blocks = []
    for i, c in enumerate(sorted(cues, key=lambda x: (x["start"], x["id"])), 1):
        blocks.append(f"{i}\n{fmt_srt(c['start'])} --> {fmt_srt(c['end'])}\n"
                      f"{c['text'].strip()}")
    return "\n\n".join(blocks) + "\n"


def export_vtt(cues: list[dict]) -> str:
    blocks = []
    for c in sorted(cues, key=lambda x: (x["start"], x["id"])):
        blocks.append(f"{fmt_vtt(c['start'])} --> {fmt_vtt(c['end'])}\n"
                      f"{c['text'].strip()}")
    return "WEBVTT\n\n" + "\n\n".join(blocks) + "\n"


def build_summary(cues: list[dict], issues: list[dict],
                  settings: dict | None = None,
                  cut_issues: list[dict] | None = None,
                  cuts=None) -> str:
    """生成问题摘要（Markdown），含切点校对结果。"""
    st = merge_settings(settings)
    by_id = {c["id"]: c for c in cues}
    all_issues = list(issues) + list(cut_issues or [])
    errors = [i for i in all_issues if i["severity"] == "error"]
    warnings = [i for i in all_issues if i["severity"] == "warning"]

    lines = [
        "# 字幕节奏校对问题摘要",
        "",
        f"- 生成时间：{datetime.now():%Y-%m-%d %H:%M:%S}",
        f"- 字幕条数：{len(cues)}（锁定 {sum(1 for c in cues if c.get('locked'))} 条）",
        f"- 错误：{len(errors)} 项 ｜ 提示：{len(warnings)} 项",
        "",
        "## 阈值设置",
        "",
        f"- CPS 上限：{st['cpsMax']:g} 字/秒",
        f"- 最短时长：{st['minDuration']:g}s ｜ 最长时长：{st['maxDuration']:g}s",
        f"- 最小间隔：{st['minGap']:g}s ｜ 单行字数：{st['maxCharsPerLine']} 字",
        f"- 断句短行阈值：{st['breakShortLine']} 字 ｜ "
        f"标点断句检查：{'开' if st['checkPunctuation'] else '关'}",
        f"- 切点吸附容差：{st['cutTolerance']:g}s",
        "",
        "## 按类型统计",
        "",
        "| 类型 | 错误 | 提示 |",
        "| --- | ---: | ---: |",
    ]
    for itype, label in TYPE_LABELS.items():
        e = sum(1 for i in errors if i["type"] == itype)
        w = sum(1 for i in warnings if i["type"] == itype)
        if e or w:
            lines.append(f"| {label} | {e} | {w} |")

    lines += ["", "## 问题明细", ""]
    if not issues:
        lines.append("未发现异常。")
    for n, iss in enumerate(issues, 1):
        sev = "错误" if iss["severity"] == "error" else "提示"
        refs = "、".join(
            f"第{cid}条 {fmt_srt(by_id[cid]['start'])}→{fmt_srt(by_id[cid]['end'])}"
            if cid in by_id else f"第{cid}条"
            for cid in iss["cues"]
        )
        lines.append(f"{n}. **[{sev}] {iss['label']}**（{refs}）  ")
        lines.append(f"   {iss['message']}" +
                     (f"——{iss['detail']}" if iss.get("detail") else ""))

    # 切点校对结果
    if cut_issues or cuts:
        lines += ["", "## 切点校对", ""]
        lines.append(f"- 切点数：{len(cuts or [])} ｜ "
                     f"吸附容差：{st['cutTolerance']:g}s")
        cross = [i for i in (cut_issues or []) if i["type"] == "cross_cut"]
        snap = [i for i in (cut_issues or []) if i["type"] == "cut_snap"]
        lines.append(f"- 跨切字幕：{len(cross)} 处 ｜ "
                     f"切点未对齐：{len(snap)} 处")
        lines.append("")
        if not cut_issues:
            lines.append("所有字幕均已避开或对齐切点。")
        action_labels = {"split": "拆分", "snap_start": "吸附片头",
                         "snap_end": "吸附片尾"}
        for n, iss in enumerate(cut_issues or [], 1):
            sev = "错误" if iss["severity"] == "error" else "提示"
            cid = iss["cues"][0]
            ref = (f"第{cid}条 {fmt_srt(by_id[cid]['start'])}"
                   f"→{fmt_srt(by_id[cid]['end'])}"
                   if cid in by_id else f"第{cid}条")
            sug = iss.get("suggestion") or {}
            tail = ""
            if sug:
                tail = f"——建议{action_labels.get(sug.get('action'), '调整')}"
                if not sug.get("feasible", True):
                    tail += (f"（冲突：{sug.get('reason', '')}，"
                             f"应用时将保留原值）")
            lines.append(
                f"{n}. **[{sev}] {iss['label']}**"
                f"（{ref} ｜ 切点 {fmt_srt(iss['cut'])}）  ")
            lines.append(f"   {iss['message']}{tail}")
    lines.append("")
    return "\n".join(lines)

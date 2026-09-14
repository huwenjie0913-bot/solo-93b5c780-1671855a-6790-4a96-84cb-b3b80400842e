"""subtitle_core 与 Flask 接口的测试。"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import subtitle_core as core  # noqa: E402
from app import app  # noqa: E402


# ---------------------------------------------------------------- 解析

SRT_SAMPLE = """﻿1
00:00:01,000 --> 00:00:03,000
第一句

2
00:00:04,000 --> 00:00:06,500
第二句
有两行
"""

VTT_SAMPLE = """WEBVTT

NOTE 这是一段注释

00:01.000 --> 00:03.000 align:start position:0%
第一句

2
00:00:04.000 --> 00:00:06.500
<i>第二句</i>
"""


def test_parse_srt_basic():
    cues, fmt = core.parse_subtitles(SRT_SAMPLE)
    assert fmt == "srt"
    assert len(cues) == 2
    assert cues[0]["start"] == 1.0 and cues[0]["end"] == 3.0
    assert cues[1]["text"] == "第二句\n有两行"
    assert cues[0]["locked"] is False


def test_parse_vtt_basic():
    cues, fmt = core.parse_subtitles(VTT_SAMPLE)
    assert fmt == "vtt"
    assert len(cues) == 2
    assert cues[0]["start"] == 1.0  # MM:SS.mmm 无小时形式
    assert cues[1]["id"] == 2


def test_parse_rejects_garbage():
    with pytest.raises(ValueError):
        core.parse_subtitles("这不是字幕\n随便的文字")


def test_export_roundtrip_srt():
    cues, _ = core.parse_subtitles(SRT_SAMPLE)
    text = core.export_srt(cues)
    cues2, fmt = core.parse_subtitles(text)
    assert fmt == "srt"
    assert [(c["start"], c["end"], c["text"]) for c in cues2] == \
           [(c["start"], c["end"], c["text"]) for c in cues]


def test_export_roundtrip_vtt():
    cues, _ = core.parse_subtitles(VTT_SAMPLE)
    text = core.export_vtt(cues)
    assert text.startswith("WEBVTT")
    cues2, fmt = core.parse_subtitles(text)
    assert fmt == "vtt"
    assert len(cues2) == 2
    assert cues2[0]["start"] == 1.0


def test_timecode_format():
    assert core.fmt_srt(3723.5) == "01:02:03,500"
    assert core.fmt_vtt(0.04) == "00:00:00.040"
    assert core.parse_timecode("01:02:03,500") == 3723.5
    assert core.parse_timecode("02:03.500") == 123.5


# ---------------------------------------------------------------- 校验

def cue(cid, s, e, text="字幕内容", locked=False):
    return {"id": cid, "start": s, "end": e, "text": text, "locked": locked}


def types(issues, severity=None):
    return sorted(i["type"] for i in issues
                  if severity is None or i["severity"] == severity)


def test_validate_clean():
    issues = core.validate([cue(1, 1.0, 3.0, "正常的一句。"),
                            cue(2, 3.5, 6.0, "也正常。")])
    assert issues == []


def test_validate_overlap_error_and_warning():
    # 大重叠 -> 错误；帧级微重叠 -> 提示
    issues = core.validate([cue(1, 1.0, 3.0), cue(2, 2.5, 4.0)])
    assert ("overlap", "error") in [(i["type"], i["severity"]) for i in issues]
    issues = core.validate([cue(1, 1.0, 3.0), cue(2, 2.95, 5.0)])
    assert ("overlap", "warning") in [(i["type"], i["severity"]) for i in issues]


def test_validate_too_short():
    issues = core.validate([cue(1, 1.0, 1.3, "短。")])
    assert "too_short" in types(issues, "error")


def test_validate_cps():
    fast = cue(1, 1.0, 2.0, "这一句话实在是太长了根本不可能在一秒钟之内读完它所以必须算成错误级别")
    issues = core.validate([fast])
    assert "cps" in types(issues, "error")
    # 放宽 CPS 上限后应消失
    issues = core.validate([fast], {"cpsMax": 100})
    assert "cps" not in types(issues)


def test_validate_gap():
    issues = core.validate([cue(1, 1.0, 2.0), cue(2, 2.01, 3.5)])
    assert "gap" in types(issues)
    issues = core.validate([cue(1, 1.0, 2.0), cue(2, 2.5, 3.5)])
    assert "gap" not in types(issues)


def test_validate_line_length():
    long_line = cue(1, 1.0, 8.0, "这" * 25)
    issues = core.validate([long_line])
    assert "line_length" in types(issues, "warning")
    issues = core.validate([long_line], {"maxCharsPerLine": 30})
    assert "line_length" not in types(issues)


def test_validate_line_break_rules():
    hard_break = cue(1, 1.0, 4.0, "山顶的风比山下\n大得多，吹得人站不稳。")
    issues = core.validate([hard_break])
    assert "line_break" in types(issues, "warning")

    dangling = cue(1, 1.0, 4.0, "话还没说完，")
    assert "line_break" in types(core.validate([dangling]), "warning")

    unbalanced = cue(1, 1.0, 4.0, "“这里的云，一天一个样。")
    assert "line_break" in types(core.validate([unbalanced]), "error")

    broken = cue(1, 1.0, 4.0, "他按下快门，\n嗯。")
    assert "line_break" in types(core.validate([broken]), "error")

    # 关闭标点断句检查后全部消失
    all_bad = cue(1, 1.0, 4.0, "“山顶的风比山下\n嗯。")
    issues = core.validate([all_bad], {"checkPunctuation": False})
    assert "line_break" not in types(issues)


def test_validate_order_error():
    issues = core.validate([cue(1, 3.0, 2.0)])
    assert "order" in types(issues, "error")


def test_validate_too_long():
    issues = core.validate([cue(1, 1.0, 9.0, "挂屏太久。")])
    assert "too_long" in types(issues, "warning")
    issues = core.validate([cue(1, 1.0, 12.0, "挂屏太久。")])
    assert "too_long" in types(issues, "error")


# ---------------------------------------------------------------- 批量修复

def test_batch_fix_overlap_split():
    cues = [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5)]
    fixed, changes = core.batch_fix(cues)
    assert fixed[0]["end"] <= fixed[1]["start"]
    assert fixed[0]["start"] == 1.0 and fixed[1]["end"] == 4.5  # 总跨度不变
    assert not [i for i in core.validate(fixed) if i["type"] == "overlap"]
    assert changes


def test_batch_fix_respects_lock():
    cues = [cue(1, 1.0, 3.0, locked=True), cue(2, 2.5, 4.5)]
    fixed, _ = core.batch_fix(cues)
    assert fixed[0]["end"] == 3.0          # 锁定条不动
    assert fixed[1]["start"] >= 3.0        # 未锁定条后移

    cues = [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5, locked=True)]
    fixed, _ = core.batch_fix(cues)
    assert fixed[1]["start"] == 2.5        # 锁定条不动
    assert fixed[0]["end"] <= 2.5


def test_batch_fix_extends_into_gaps():
    # 第 2 条太短且 CPS 超标，后面有大空档 -> 向后延长
    cues = [cue(1, 0.0, 1.5, "第一句。"),
            cue(2, 2.0, 2.4, "这一句其实不短只是时间给得太少了"),
            cue(3, 10.0, 12.0, "第三句。")]
    fixed, _ = core.batch_fix(cues)
    c2 = next(c for c in fixed if c["id"] == 2)
    assert c2["end"] > 2.4
    assert c2["end"] <= 10.0  # 不超过下一条


def test_batch_fix_uses_previous_gap():
    cues = [cue(1, 0.0, 0.5, "短。"),
            cue(2, 5.0, 5.3, "快点。"),
            cue(3, 5.4, 6.4, "紧跟其后。")]
    fixed, _ = core.batch_fix(cues, {"minGap": 0.05})
    c2 = next(c for c in fixed if c["id"] == 2)
    assert c2["start"] < 5.0               # 向前面的空档借时间
    assert c2["start"] >= 0.5              # 不与第 1 条重叠


def test_batch_fix_keeps_text_and_order():
    cues = [cue(1, 1.0, 3.0, "甲"), cue(2, 2.5, 3.2, "乙"), cue(3, 4.0, 4.3, "丙")]
    fixed, _ = core.batch_fix(cues)
    assert [c["text"] for c in fixed] == ["甲", "乙", "丙"]
    assert [c["id"] for c in fixed] == [1, 2, 3]


def test_batch_fix_locked_not_extended():
    cues = [cue(1, 0.0, 0.3, "闪。", locked=True), cue(2, 5.0, 6.5, "正常。")]
    fixed, _ = core.batch_fix(cues)
    c1 = next(c for c in fixed if c["id"] == 1)
    assert (c1["start"], c1["end"]) == (0.0, 0.3)  # 锁定条不参与调整


def test_batch_fix_nested_overlap():
    """回归：第二条完全嵌套在第一条内（0-10 与 1-2），不得产出倒置时间。"""
    cues = [cue(1, 0.0, 10.0, "外层长字幕。"), cue(2, 1.0, 2.0, "内层短字幕。")]
    fixed, changes = core.batch_fix(cues)
    by_id = {c["id"]: c for c in fixed}
    assert all(c["start"] < c["end"] for c in fixed)        # 时间必须有效
    assert by_id[1]["end"] <= by_id[2]["start"]             # 重叠已消除
    assert [c["text"] for c in fixed] == ["外层长字幕。", "内层短字幕。"]
    assert [c["id"] for c in fixed] == [1, 2]               # 顺序不变
    assert changes                                          # 有改动记录
    # 修复结果在默认阈值下不再有叠轴
    assert not [i for i in core.validate(fixed) if i["type"] == "overlap"]


def test_batch_fix_nested_same_start():
    """起点相同的嵌套字幕也要能分开且保持有效。"""
    cues = [cue(1, 1.0, 2.0, "甲"), cue(2, 1.0, 5.0, "乙")]
    fixed, _ = core.batch_fix(cues)
    assert all(c["start"] < c["end"] for c in fixed)
    assert fixed[0]["end"] <= fixed[1]["start"]


def test_batch_fix_identical_cues():
    """完全重合的两条字幕。"""
    cues = [cue(1, 1.0, 2.0, "甲"), cue(2, 1.0, 2.0, "乙")]
    fixed, _ = core.batch_fix(cues)
    assert all(c["start"] < c["end"] for c in fixed)
    assert fixed[0]["end"] <= fixed[1]["start"]


def test_batch_fix_infeasible_left_untouched():
    """总跨度不足两条最短时长时：不强行分割、不产出非法时间，记录未处理。"""
    cues = [cue(1, 0.0, 0.05, "甲"), cue(2, 0.02, 0.06, "乙")]
    fixed, changes = core.batch_fix(cues)
    assert all(c["start"] < c["end"] for c in fixed)        # 不破坏原有有效性
    assert any(c["before"] is None for c in changes)        # 有未处理记录


def test_batch_fix_output_always_valid():
    """性质测试：随机重叠场景下输出时间始终有效、无重叠且顺序不变。"""
    import random
    rng = random.Random(42)
    for _ in range(200):
        n = rng.randint(2, 6)
        cues = []
        for i in range(n):
            s = round(rng.uniform(0, 20), 3)
            e = round(s + rng.uniform(0.05, 8), 3)
            cues.append(cue(i + 1, s, e, f"第{i + 1}条字幕。"))
        fixed, _ = core.batch_fix(cues)
        assert all(c["start"] < c["end"] for c in fixed), cues
        ordered = sorted(fixed, key=lambda c: c["start"])
        assert all(a["end"] <= b["start"] + 1e-4
                   for a, b in zip(ordered, ordered[1:])), cues
        # 输出时间顺序必须与输入 (start, id) 顺序一致
        in_seq = [c["id"] for c in sorted(cues, key=lambda c: (c["start"], c["id"]))]
        out_seq = [c["id"] for c in sorted(fixed, key=lambda c: (c["start"], c["id"]))]
        assert out_seq == in_seq, cues
        # 文字不变
        by_id = {c["id"]: c for c in cues}
        assert all(c["text"] == by_id[c["id"]]["text"] for c in fixed)


# ---------------------------------------------------------------- 摘要

def test_summary_contains_counts_and_reasons():
    cues = [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5)]
    issues = core.validate(cues)
    md = core.build_summary(cues, issues)
    assert "叠轴" in md and "错误" in md
    assert "第1条" in md and "阈值设置" in md


# ---------------------------------------------------------------- Flask 接口

@pytest.fixture()
def client():
    app.config["TESTING"] = True
    return app.test_client()


def test_api_parse(client):
    res = client.post("/api/parse", json={"text": SRT_SAMPLE})
    assert res.status_code == 200
    data = res.get_json()
    assert data["count"] == 2 and data["format"] == "srt"
    res = client.post("/api/parse", json={"text": "垃圾内容"})
    assert res.status_code == 400


def test_api_validate(client):
    res = client.post("/api/validate", json={
        "cues": [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5)], "settings": {}})
    data = res.get_json()
    assert data["stats"]["errors"] >= 1
    assert any(i["type"] == "overlap" for i in data["issues"])


def test_api_batch_fix(client):
    res = client.post("/api/batch_fix", json={
        "cues": [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5)], "settings": {}})
    data = res.get_json()
    fixed = data["cues"]
    assert fixed[0]["end"] <= fixed[1]["start"]
    assert data["changes"]


def test_api_batch_fix_nested(client):
    """接口回归：完全嵌套的两条未锁定字幕不得返回倒置时间。"""
    res = client.post("/api/batch_fix", json={
        "cues": [cue(1, 0.0, 10.0, "外层长字幕。"),
                 cue(2, 1.0, 2.0, "内层短字幕。")],
        "settings": {}})
    assert res.status_code == 200
    fixed = res.get_json()["cues"]
    assert all(c["start"] < c["end"] for c in fixed)
    ordered = sorted(fixed, key=lambda c: c["start"])
    assert ordered[0]["end"] <= ordered[1]["start"]
    assert [c["text"] for c in ordered] == ["外层长字幕。", "内层短字幕。"]


def test_api_export_srt_vtt(client):
    for fmt, head in (("srt", "1\n00:00:01,000"), ("vtt", "WEBVTT")):
        res = client.post("/api/export", json={
            "cues": [cue(1, 1.0, 3.0, "内容")], "format": fmt})
        assert res.status_code == 200
        assert res.data.decode("utf-8-sig").startswith(head)
        assert "attachment" in res.headers["Content-Disposition"]


def test_api_summary(client):
    res = client.post("/api/summary", json={
        "cues": [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5)], "settings": {}})
    assert res.status_code == 200
    assert "叠轴" in res.data.decode("utf-8-sig")


def test_index_page(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "字幕节奏校对台" in res.data.decode()

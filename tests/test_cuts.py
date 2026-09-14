"""切点校对功能测试：check_cuts / apply_cut_suggestions / split_text / 接口。"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import subtitle_core as core  # noqa: E402
from app import app  # noqa: E402


def cue(cid, s, e, text="字幕内容", locked=False):
    return {"id": cid, "start": s, "end": e, "text": text, "locked": locked}


def types(issues):
    return sorted(i["type"] for i in issues)


# ---------------------------------------------------------------- 检测

def test_check_cuts_detects_cross_cut():
    issues = core.check_cuts([cue(1, 10.0, 14.0)], [12.5])
    assert types(issues) == ["cross_cut"]
    iss = issues[0]
    assert iss["severity"] == "error"
    assert iss["cut"] == 12.5
    sug = iss["suggestion"]
    assert sug["action"] == "split"
    assert sug["feasible"] is True
    # 默认最小间隔 0.08：两半各让出 0.04
    assert sug["after"] == [[10.0, 12.46], [12.54, 14.0]]


def test_check_cuts_aligned_boundary_not_flagged():
    cues = [cue(1, 10.0, 12.0), cue(2, 12.08, 15.0)]
    assert core.check_cuts(cues, [12.0]) == []


def test_check_cuts_near_miss_start_and_end():
    issues = core.check_cuts([cue(1, 10.05, 14.0)], [10.0])
    assert types(issues) == ["cut_snap"]
    assert issues[0]["severity"] == "warning"
    assert issues[0]["suggestion"]["action"] == "snap_start"
    assert issues[0]["suggestion"]["after"] == [[10.0, 14.0]]

    issues = core.check_cuts([cue(1, 10.0, 11.95)], [12.0])
    assert types(issues) == ["cut_snap"]
    assert issues[0]["suggestion"]["action"] == "snap_end"
    assert issues[0]["suggestion"]["after"] == [[10.0, 12.0]]


def test_check_cuts_respects_tolerance():
    # 默认容差 0.12：0.2 的偏差不报
    assert core.check_cuts([cue(1, 10.2, 14.0)], [10.0]) == []
    # 调大容差后报出
    issues = core.check_cuts([cue(1, 10.2, 14.0)], [10.0],
                             {"cutTolerance": 0.25})
    assert types(issues) == ["cut_snap"]


def test_check_cuts_cut_inside_near_edge_is_snap_not_split():
    # 切点在片内但距片头 0.05（容差内）→ 吸附片头而非拆分
    issues = core.check_cuts([cue(1, 10.0, 14.0)], [10.05])
    assert types(issues) == ["cut_snap"]
    assert issues[0]["suggestion"]["action"] == "snap_start"


def test_check_cuts_short_cue_picks_nearer_edge():
    # 整条字幕落在切点容差内：只报更近的一端
    issues = core.check_cuts([cue(1, 9.98, 10.06, "短。")], [10.0])
    assert len(issues) == 1
    assert issues[0]["suggestion"]["action"] == "snap_start"  # 0.02 < 0.06


def test_check_cuts_split_pair_not_flagged_again():
    # 已按“切点 ± 半个最小间隔”拆好的相邻对不再产生建议
    cues = [cue(1, 10.0, 11.96), cue(2, 12.04, 14.0)]
    assert core.check_cuts(cues, [12.0]) == []


def test_check_cuts_infeasible_preview():
    # 容差极小 → 判定为跨切，但切点距片头过近，拆分不可行
    issues = core.check_cuts([cue(1, 10.0, 14.0)], [10.05],
                             {"cutTolerance": 0.01})
    assert types(issues) == ["cross_cut"]
    assert issues[0]["suggestion"]["feasible"] is False
    assert "最短有效时长" in issues[0]["suggestion"]["reason"]


def test_check_cuts_locked_suggestion_infeasible():
    issues = core.check_cuts([cue(1, 10.0, 14.0, locked=True)], [12.5])
    assert issues[0]["suggestion"]["feasible"] is False
    assert "锁定" in issues[0]["suggestion"]["reason"]


def test_check_cuts_ignores_garbage():
    assert core.check_cuts([cue(1, 1.0, 2.0)], None) == []
    # 非法值与负值被丢弃，剩下的切点不与任何字幕相交
    assert core.check_cuts([cue(1, 1.0, 2.0)], ["abc", -1, 5.0]) == []


def test_check_cuts_bracketed_pair_not_flagged():
    # 前一条终于切点、后一条隔一个最小间隔开始：切点已被相邻对夹住，
    # 两侧边界虽在容差内但无可达成的改进，不报
    cues = [cue(1, 10.0, 12.0), cue(2, 12.08, 15.0)]
    assert core.check_cuts(cues, [12.0]) == []
    # 同样：前一条差一点到切点、后一条紧跟，间隙已小于等于最小间隔
    cues = [cue(1, 10.0, 11.98), cue(2, 12.04, 15.0)]
    assert core.check_cuts(cues, [12.0]) == []


# ---------------------------------------------------------------- 应用

def test_apply_snap_start():
    cues = [cue(1, 10.05, 14.0)]
    fixed, changes = core.apply_cut_suggestions(cues, [10.0])
    assert fixed[0]["start"] == 10.0
    assert changes[0]["status"] == "applied"
    assert core.check_cuts(fixed, [10.0]) == []


def test_apply_snap_respects_lock():
    cues = [cue(1, 10.05, 14.0, locked=True)]
    fixed, changes = core.apply_cut_suggestions(cues, [10.0])
    assert fixed[0]["start"] == 10.05          # 保留原值
    assert changes[0]["status"] == "skipped"
    assert "锁定" in changes[0]["reason"]


def test_apply_snap_respects_min_gap():
    # 第 1 条跨过切点且与第 2 条重叠：第 2 条片头吸附被远处的重叠邻居
    # 挡住 → 保留原值并写明原因（先拆分第 1 条后仍不够位）
    cues = [cue(1, 9.0, 10.5), cue(2, 10.05, 12.0)]
    fixed, changes = core.apply_cut_suggestions(cues, [10.0])
    c2 = next(c for c in fixed if c["id"] == 2)
    assert c2["start"] == 10.05
    skipped = [c for c in changes if c["status"] == "skipped" and c["cue"] == 2]
    assert skipped and "间隔" in skipped[0]["reason"]


def test_apply_snap_end_respects_next_cue():
    # 后一条起点远在切点之前（重叠），片尾吸附被挡 → 保留原值
    cues = [cue(1, 8.0, 9.9), cue(2, 9.5, 12.0)]
    fixed, changes = core.apply_cut_suggestions(cues, [9.95])
    c1 = next(c for c in fixed if c["id"] == 1)
    assert c1["end"] == 9.9
    skipped = [c for c in changes if c["status"] == "skipped" and c["cue"] == 1]
    assert skipped and "间隔" in skipped[0]["reason"]


def test_apply_split_creates_two_valid_cues():
    cues = [cue(1, 10.0, 14.0, "前一半内容在这里，后一半内容在那里。")]
    fixed, changes = core.apply_cut_suggestions(cues, [12.0])
    assert len(fixed) == 2
    a, b = sorted(fixed, key=lambda c: c["start"])
    assert a["end"] == 11.96 and b["start"] == 12.04   # 最小间隔 0.08
    assert b["id"] != a["id"]
    assert a["text"] and b["text"]
    assert a["text"] + b["text"] == cues[0]["text"]
    assert changes[0]["status"] == "applied"
    # 拆分结果不再产生切点问题，也不引入叠轴
    assert core.check_cuts(fixed, [12.0]) == []
    assert not [i for i in core.validate(fixed) if i["type"] == "overlap"]


def test_apply_split_too_close_to_edge_keeps_original():
    cues = [cue(1, 10.0, 14.0)]
    fixed, changes = core.apply_cut_suggestions(cues, [10.05],
                                                {"cutTolerance": 0.01})
    assert len(fixed) == 1 and fixed[0]["end"] == 14.0   # 保留原值
    assert changes[0]["status"] == "skipped"
    assert "最短有效时长" in changes[0]["reason"]


def test_apply_targets_single_and_stale():
    cues = [cue(1, 10.05, 14.0), cue(2, 20.0, 21.9)]
    # 只应用第 1 条的吸附建议
    fixed, changes = core.apply_cut_suggestions(
        cues, [10.0, 22.0],
        targets=[{"cue": 1, "action": "snap_start", "cut": 10.0}])
    assert fixed[0]["start"] == 10.0
    assert next(c for c in fixed if c["id"] == 2)["end"] == 21.9  # 未动
    assert changes[0]["status"] == "applied"
    # 过期建议（当前不存在该动作/切点组合）→ 跳过并说明
    _, changes2 = core.apply_cut_suggestions(
        cues, [10.0],
        targets=[{"cue": 1, "action": "snap_end", "cut": 13.0}])
    assert changes2[0]["status"] == "skipped"
    assert "过期" in changes2[0]["reason"]


def test_apply_batch_mixed_and_idempotent():
    cues = [cue(1, 10.05, 14.0, "第一段字幕。"),
            cue(2, 16.0, 20.0, "第二段字幕需要拆开来看。"),
            cue(3, 22.0, 23.9, "第三段。")]
    cuts = [10.0, 18.0, 24.0]
    fixed, changes = core.apply_cut_suggestions(cues, cuts)
    by_id = {c["id"]: c for c in fixed}
    assert by_id[1]["start"] == 10.0            # 片头吸附
    assert by_id[3]["end"] == 24.0              # 片尾吸附
    assert len(fixed) == 4                      # 第 2 条被拆成两条
    assert all(c["start"] < c["end"] for c in fixed)
    ordered = sorted(fixed, key=lambda c: c["start"])
    assert all(a["end"] <= b["start"] + 1e-4
               for a, b in zip(ordered, ordered[1:]))
    assert core.check_cuts(fixed, cuts) == []
    # 再次批量应用：无可应用项（幂等，不会来回吸附）
    _, changes2 = core.apply_cut_suggestions(fixed, cuts)
    assert not [c for c in changes2 if c["status"] == "applied"]


def test_apply_batch_no_flip_flop_between_close_cuts():
    # 两个相近切点：片头吸附到其中一个后不再被另一个拉走
    cues = [cue(1, 10.05, 14.0)]
    fixed, changes = core.apply_cut_suggestions(cues, [10.0, 10.1])
    applied = [c for c in changes if c["status"] == "applied"]
    assert len(applied) == 1
    assert fixed[0]["start"] in (10.0, 10.1)


# ---------------------------------------------------------------- 文本拆分

def test_split_text_proportional_and_punctuation():
    a, b = core.split_text("前一半内容在这里，后一半内容在那里。", 0.5)
    assert a and b
    assert a + b == "前一半内容在这里，后一半内容在那里。"
    assert a.endswith("，")          # 优先在标点处断开


def test_split_text_prefers_newline():
    a, b = core.split_text("第一行文字\n第二行文字", 0.5)
    assert a == "第一行文字" and b == "第二行文字"


def test_split_text_too_short_duplicates():
    assert core.split_text("嗯", 0.5) == ("嗯", "嗯")
    assert core.split_text("", 0.5) == ("", "")


# ---------------------------------------------------------------- 摘要

def test_summary_includes_cut_section():
    cues = [cue(1, 10.0, 14.0)]
    cut_issues = core.check_cuts(cues, [12.5])
    md = core.build_summary(cues, core.validate(cues), None,
                            cut_issues=cut_issues, cuts=[12.5])
    assert "切点校对" in md
    assert "跨切字幕" in md
    assert "00:00:12,500" in md
    assert "拆分" in md


def test_summary_without_cuts_unchanged():
    cues = [cue(1, 1.0, 3.0), cue(2, 2.5, 4.5)]
    md = core.build_summary(cues, core.validate(cues))
    assert "切点校对" not in md


# ---------------------------------------------------------------- Flask 接口

@pytest.fixture()
def client():
    app.config["TESTING"] = True
    return app.test_client()


def test_api_validate_includes_cut_issues(client):
    res = client.post("/api/validate", json={
        "cues": [cue(1, 10.0, 14.0)], "cuts": [12.5], "settings": {}})
    data = res.get_json()
    assert data["cutIssues"][0]["type"] == "cross_cut"
    assert data["cutIssues"][0]["suggestion"]["action"] == "split"
    assert data["stats"]["cutErrors"] == 1
    # 不传 cuts → 无切点问题
    res = client.post("/api/validate", json={"cues": [cue(1, 10.0, 14.0)]})
    assert res.get_json()["cutIssues"] == []


def test_api_cuts_apply_batch(client):
    res = client.post("/api/cuts/apply", json={
        "cues": [cue(1, 10.05, 14.0)], "cuts": [10.0], "settings": {}})
    data = res.get_json()
    assert data["cues"][0]["start"] == 10.0
    assert data["stats"]["applied"] == 1
    assert data["cutIssues"] == []


def test_api_cuts_apply_single_target(client):
    res = client.post("/api/cuts/apply", json={
        "cues": [cue(1, 10.0, 14.0, "前半句，后半句。")],
        "cuts": [12.0],
        "targets": [{"cue": 1, "action": "split", "cut": 12.0}]})
    data = res.get_json()
    assert len(data["cues"]) == 2
    assert data["stats"]["applied"] == 1
    a, b = data["cues"]
    assert a["end"] == 11.96 and b["start"] == 12.04


def test_api_summary_lists_cut_results(client):
    res = client.post("/api/summary", json={
        "cues": [cue(1, 10.0, 14.0)], "cuts": [12.5], "settings": {}})
    text = res.data.decode("utf-8-sig")
    assert "切点校对" in text
    assert "跨切字幕" in text
    assert "00:00:12,500" in text

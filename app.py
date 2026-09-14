"""字幕节奏校对 Web 应用 —— Flask 后端。

职责：解析、校验、批量修复、切点校对、导出 SRT/VTT 与问题摘要。
视频与字幕文件均在浏览器本地读取，服务器只处理文本。
"""

from __future__ import annotations

from urllib.parse import quote

from flask import Flask, jsonify, render_template, request, Response

import subtitle_core as core

app = Flask(__name__)


def _json() -> dict:
    return request.get_json(force=True, silent=True) or {}


def _attachment(content: str, filename: str):
    """以附件形式返回文本内容（文件名按 RFC 5987 编码）。"""
    return Response(
        content.encode("utf-8-sig"),
        mimetype="text/plain; charset=utf-8",
        headers={
            "Content-Disposition":
                f"attachment; filename*=UTF-8''{quote(filename)}"
        },
    )


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/settings")
def api_settings():
    return jsonify(core.DEFAULT_SETTINGS)


@app.post("/api/parse")
def api_parse():
    text = _json().get("text", "")
    if not text.strip():
        return jsonify({"error": "字幕内容为空"}), 400
    try:
        cues, fmt = core.parse_subtitles(text)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"cues": cues, "format": fmt, "count": len(cues)})


@app.post("/api/validate")
def api_validate():
    data = _json()
    cues = data.get("cues") or []
    settings = data.get("settings")
    issues = core.validate(cues, settings)
    cut_issues = core.check_cuts(cues, data.get("cuts"), settings)
    return jsonify({
        "issues": issues,
        "cutIssues": cut_issues,
        "stats": {
            "cues": len(cues),
            "errors": sum(1 for i in issues if i["severity"] == "error"),
            "warnings": sum(1 for i in issues if i["severity"] == "warning"),
            "cutErrors": sum(1 for i in cut_issues
                             if i["severity"] == "error"),
            "cutWarnings": sum(1 for i in cut_issues
                               if i["severity"] == "warning"),
        },
    })


@app.post("/api/cuts/apply")
def api_cuts_apply():
    """应用切点建议：targets 缺省时批量应用全部，否则只应用指定项。"""
    data = _json()
    cues = data.get("cues") or []
    settings = data.get("settings")
    cuts = data.get("cuts") or []
    new_cues, changes = core.apply_cut_suggestions(
        cues, cuts, settings, data.get("targets"))
    issues = core.validate(new_cues, settings)
    cut_issues = core.check_cuts(new_cues, cuts, settings)
    return jsonify({
        "cues": new_cues,
        "changes": changes,
        "issues": issues,
        "cutIssues": cut_issues,
        "stats": {
            "applied": sum(1 for c in changes if c["status"] == "applied"),
            "skipped": sum(1 for c in changes if c["status"] == "skipped"),
        },
    })


@app.post("/api/batch_fix")
def api_batch_fix():
    data = _json()
    cues = data.get("cues") or []
    fixed, changes = core.batch_fix(cues, data.get("settings"))
    issues = core.validate(fixed, data.get("settings"))
    return jsonify({
        "cues": fixed,
        "changes": changes,
        "issues": issues,
        "stats": {
            "errors": sum(1 for i in issues if i["severity"] == "error"),
            "warnings": sum(1 for i in issues if i["severity"] == "warning"),
        },
    })


@app.post("/api/export")
def api_export():
    data = _json()
    cues = data.get("cues") or []
    fmt = (data.get("format") or "srt").lower()
    if fmt == "vtt":
        return _attachment(core.export_vtt(cues), "corrected.vtt")
    return _attachment(core.export_srt(cues), "corrected.srt")


@app.post("/api/summary")
def api_summary():
    data = _json()
    cues = data.get("cues") or []
    settings = data.get("settings")
    cuts = data.get("cuts")
    issues = core.validate(cues, settings)
    cut_issues = core.check_cuts(cues, cuts, settings)
    return _attachment(
        core.build_summary(cues, issues, settings,
                           cut_issues=cut_issues, cuts=cuts),
        "subtitle_issues.md")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)

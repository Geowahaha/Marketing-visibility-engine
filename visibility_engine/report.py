"""
report.py
---------
Turns AuditResult objects into (a) a colored console summary via rich and
(b) a portable Markdown report written to disk.
"""

from __future__ import annotations

import datetime as _dt

from rich.console import Console
from rich.table import Table

from .audits.social import FACEBOOK_PLAYBOOK
from .types import AuditResult, Status

console = Console()

_ICON = {Status.PASS: "✅", Status.WARN: "⚠️ ", Status.FAIL: "❌", Status.INFO: "ℹ️ "}
_GRADE = [(90, "A"), (80, "B"), (70, "C"), (55, "D"), (0, "F")]


def grade(score: int) -> str:
    return next(g for threshold, g in _GRADE if score >= threshold)


def overall(results: list[AuditResult]) -> int:
    return round(sum(r.score() for r in results) / len(results)) if results else 0


def to_console(url: str, results: list[AuditResult]) -> None:
    total = overall(results)
    console.rule(f"[bold]Visibility Audit — {url}")
    console.print(f"[bold]Overall score: {total}/100  (grade {grade(total)})\n")

    summary = Table(title="Category scores", show_lines=False)
    summary.add_column("Category"); summary.add_column("Score", justify="right"); summary.add_column("Grade")
    for r in results:
        s = r.score()
        summary.add_row(r.category, str(s), grade(s))
    console.print(summary)

    for r in results:
        t = Table(title=f"\n{r.category} — {r.score()}/100", show_lines=False, expand=True)
        t.add_column("", width=3); t.add_column("Check", width=30); t.add_column("Detail / Fix")
        for f in sorted(r.findings, key=lambda x: x.status != Status.FAIL):
            note = f.detail
            if not f.passed and f.fix:
                note = f"{f.detail}  →  [italic]{f.fix}[/italic]" if f.detail else f"[italic]{f.fix}[/italic]"
            t.add_row(_ICON[f.status], f.check, note)
        console.print(t)


def to_markdown(url: str, results: list[AuditResult], path: str) -> None:
    total = overall(results)
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"# Visibility Audit — {url}",
        f"_Generated {now} by visibility-engine_",
        "",
        f"**Overall score: {total}/100 (grade {grade(total)})**",
        "",
        "| Category | Score | Grade |",
        "|---|---|---|",
    ]
    for r in results:
        s = r.score()
        lines.append(f"| {r.category} | {s}/100 | {grade(s)} |")
    lines.append("")

    for r in results:
        lines.append(f"## {r.category} — {r.score()}/100\n")
        lines.append("| | Check | Detail | Fix |")
        lines.append("|---|---|---|---|")
        for f in sorted(r.findings, key=lambda x: x.status != Status.FAIL):
            icon = {"pass": "✅", "warn": "⚠️", "fail": "❌", "info": "ℹ️"}[f.status.value]
            lines.append(f"| {icon} | {f.check} | {f.detail} | {f.fix} |")
        lines.append("")

    # Action plan: every failing/warning item, ordered by severity
    lines.append("## Prioritized action plan\n")
    actionable = []
    for r in results:
        for f in r.findings:
            if not f.passed and f.fix:
                actionable.append((f.severity.value, f.check, f.fix))
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    for sev, check, fix in sorted(actionable, key=lambda x: order[x[0]]):
        lines.append(f"- **[{sev.upper()}] {check}** — {fix}")
    lines.append("")

    # Facebook playbook (manual)
    lines.append("## Facebook / Meta 2026 organic-reach playbook\n")
    for tip in FACEBOOK_PLAYBOOK:
        lines.append(f"- [ ] {tip}")
    lines.append("")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    console.print(f"\n[green]Markdown report written to[/green] {path}")

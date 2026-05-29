"""
types.py
--------
Shared result types. Every audit returns an AuditResult containing a list of
Finding objects. A Finding is one checked item with a status and (when failing)
a concrete fix. Severity drives both the score weighting and the report ordering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Status(str, Enum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    INFO = "info"


class Severity(str, Enum):
    CRITICAL = "critical"  # blocks visibility / indexing
    HIGH = "high"          # strong ranking or reach impact
    MEDIUM = "medium"      # meaningful, fix soon
    LOW = "low"            # polish


# weight a failed/warned check subtracts from its category's 100-point budget
SEVERITY_WEIGHT = {
    Severity.CRITICAL: 30,
    Severity.HIGH: 18,
    Severity.MEDIUM: 9,
    Severity.LOW: 4,
}


@dataclass
class Finding:
    check: str
    status: Status
    severity: Severity
    detail: str = ""
    fix: str = ""

    @property
    def passed(self) -> bool:
        return self.status in (Status.PASS, Status.INFO)


@dataclass
class AuditResult:
    category: str
    findings: list[Finding] = field(default_factory=list)

    def add(self, *args, **kwargs) -> None:
        self.findings.append(Finding(*args, **kwargs))

    def score(self) -> int:
        """100 minus weighted penalties, floored at 0. INFO never penalizes."""
        penalty = 0
        for f in self.findings:
            if f.status == Status.FAIL:
                penalty += SEVERITY_WEIGHT[f.severity]
            elif f.status == Status.WARN:
                penalty += SEVERITY_WEIGHT[f.severity] // 2
        return max(0, 100 - penalty)

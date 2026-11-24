"""An authoring MR's description: its files, what moves, and what each destination gets."""

from __future__ import annotations

from collections.abc import Sequence

from wingman_core.domain.mr_conventions import Repo
from wingman_day2.application.authoring.plan import AuthoringPlan, Effect, KeyChange
from wingman_day2.domain import layout


def _change_words(changes: Sequence[KeyChange]) -> str:
    return "; ".join(
        f"{c.stack} `{c.key}`: {c.before!r} → "
        + ("null (deletes the chart's default)" if c.after_null else repr(c.after))
        for c in changes
    )


def describe(plan: AuthoringPlan, message: str | None) -> str:
    """The MR description's human part: files, what moves, what each destination gets."""
    lines = [
        f"{plan.title.removeprefix(f'[Wingman/{Repo.DAY2}] ')} (team **{plan.team}**).",
        "",
        "Files:",
        *(f"- {c.kind} `{c.path}`" for c in plan.changes),
    ]
    if plan.adopted:
        lines += [
            "",
            "Clusters whose own folder moves into the default (same Application names: nothing "
            "is deleted, re-created or orphaned):",
        ]
        for adoption in plan.adopted:
            what = _change_words(adoption.changes) if adoption.changes else "nothing changes"
            if adoption.exclusion_removed:
                what += (
                    f"; its entry in {layout.exclusions_file(adoption.ref.defaults_scope)} goes, "
                    "or its app would be deleted"
                )
            lines.append(f"- **{adoption.ref.name}** (`{adoption.ref.id}`): {what}")
    removed = [i for i in plan.impact if i.effect is Effect.REMOVED]
    changed = [i for i in plan.impact if i.effect is Effect.CHANGED]
    added = [i for i in plan.impact if i.effect is Effect.ADDED]
    if removed:
        lines += [
            "",
            "**Applications this deletes. ArgoCD orphans their workloads (`prune: false`): they "
            "keep running, unmanaged, until someone tears them down (runbook R10):**",
            *(f"- **{i.ref.name}** (`{i.ref.id}`): {i.app_name}" for i in removed),
        ]
    if changed:
        lines += [
            "",
            "Destinations whose deploy config or values change:",
            *(f"- **{i.ref.name}** (`{i.ref.id}`): {_change_words(i.changes)}" for i in changed),
        ]
    if added:
        lines += [
            "",
            "Applications this generates:",
            *(f"- **{i.ref.name}** (`{i.ref.id}`): {i.app_name}" for i in added),
        ]
    if plan.findings:
        lines += ["", "Warnings:", *(f"- {f.message}" for f in plan.findings)]
    lines += ["", *plan.notes]
    if message:
        lines += ["", "Notes from the requester:", message]
    return "\n".join(lines)

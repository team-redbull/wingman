"""A change's merge request: one commit on a new branch of the team's repo (ADR-0007)."""

from __future__ import annotations

from collections.abc import Sequence

from wingman_core.domain.git import FileChange, commit_author
from wingman_core.domain.merge_request import MergeRequest, NewMergeRequest
from wingman_core.domain.mr_conventions import (
    WINGMAN_LABEL,
    MRMetadata,
    Repo,
    ResourceType,
    Verb,
    branch_name,
    mr_description,
    mr_title,
)
from wingman_core.domain.users import User
from wingman_core.ports.clock import Clock
from wingman_core.ports.gitlab import GitLabPort
from wingman_day2.application.changes.plan import ChangePlan, ChangeResult, sync_note
from wingman_day2.domain.teams import Team
from wingman_day2.ports import SigsRepository


async def open_change(
    gitlab: GitLabPort,
    sigs: SigsRepository,
    clock: Clock,
    plan: ChangePlan,
    user: User,
    verb: Verb,
    message: str | None,
    *,
    sync_notes: bool = True,
) -> ChangeResult:
    """Open ``plan``'s MR, named and described as ADR-0007 has it."""
    team, ref = plan.state.team, plan.summary.ref
    charts = plan.charts
    resource = f"{team.name}/{','.join(charts)}"
    action = verb.value.lower()
    branch = branch_name(
        username=user.username,
        action=f"{action}-{charts[0]}" if len(charts) == 1 else f"{action}-{len(charts)}-charts",
        resource=ref.name,
        at=clock(),
    )
    notes = [*plan.notes, *(sync_note(leaf) for leaf in plan.leaves if sync_notes)]
    title = mr_title(
        Repo.DAY2,
        verb,
        ResourceType.ADDON,
        resource,
        f"from {ref.name}" if verb is Verb.REMOVE else f"on {ref.name}",
    )
    human = _description(plan, verb, notes, message)
    metadata = MRMetadata(user.username, action, ResourceType.ADDON, resource, Repo.DAY2)
    commit_message = (
        f"{verb} {', '.join(charts)} {'from' if verb is Verb.REMOVE else 'on'} {ref.name}\n\n"
        f"Team: {team.name}\nCluster: {ref.id}\nRequested by {user.username} via Wingman"
    )
    merge_request = await open_team_mr(
        gitlab,
        sigs,
        team,
        user,
        branch=branch,
        action=action,
        message=commit_message,
        changes=plan.changes,
        title=title,
        description=mr_description(human, metadata),
    )
    return ChangeResult(
        team.name,
        plan.summary,
        merge_request,
        tuple(plan.changes),
        tuple(leaf.name for leaf in plan.leaves),
        tuple(plan.findings),
        tuple(notes),
    )


async def open_team_mr(
    gitlab: GitLabPort,
    sigs: SigsRepository,
    team: Team,
    user: User,
    *,
    branch: str,
    action: str,
    message: str,
    changes: Sequence[FileChange],
    title: str,
    description: str,
) -> MergeRequest:
    """One commit of ``changes`` on a new ``branch`` of ``team``'s repo, and its MR.

    The team's reads are dropped whatever happens: a write that failed may still have landed.
    """
    try:
        await gitlab.commit(
            team.project.id,
            branch=branch,
            start_branch=sigs.branch,
            message=message,
            changes=changes,
            author=commit_author(user),
        )
        return await gitlab.create_merge_request(
            team.project.id,
            NewMergeRequest(
                source_branch=branch,
                target_branch=sigs.branch,
                title=title,
                description=description,
                labels=(WINGMAN_LABEL, "day2", action),
            ),
        )
    finally:
        sigs.invalidate(team)


def _description(plan: ChangePlan, verb: Verb, notes: Sequence[str], message: str | None) -> str:
    ref = plan.summary.ref
    where = "from" if verb is Verb.REMOVE else "on"
    lines = [
        f"{verb} **{', '.join(plan.charts)}** (team **{plan.state.team.name}**) "
        f"{where} {ref.kind} cluster **{ref.name}** (`{ref.id}`).",
        "",
        "Files:",
        *(f"- {c.kind} `{c.path}`" for c in plan.changes),
    ]
    if plan.findings:
        lines += ["", "Warnings:", *(f"- {f.message}" for f in plan.findings)]
    lines += ["", *notes]
    if message:
        lines += ["", "Notes from the requester:", message]
    return "\n".join(lines)

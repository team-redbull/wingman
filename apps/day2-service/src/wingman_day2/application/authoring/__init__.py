"""Authoring operators: a new one, its team default, and fleet defaults; one MR each (ADR-0043).

An *operator* is a chart in a team's catalog (``operators/<chart>/``) and the
fleet defaults built from it; the API keeps calling it an add-on. What
Wingman writes, on the team's own repo only:

- **create**: ``operators/<chart>/<chart>.yaml`` (the deploy config: lowercase
  ``repourl``, and ``targetRevision``, ``path``, ``projectNamespace``,
  ``syncPolicy``, ``ignoreDifferences`` only when set) and
  ``operators/<chart>/values.yaml``; optionally a fleet default in the same MR.
- **update the team default**: the deploy config edited in place (comments
  and untouched lines kept, ``domain.yaml_text``), and the values file.
- **make default**: ``defaults/<scope>/<chart>/values.yaml`` (always: the file
  is what makes the folder exist) and ``<chart>.yaml`` only for a sync
  override. A cluster that already has the chart in its own folder would get
  the same app twice (the XOR rule); its folder moves into the default in the
  same commit. Both folders generate the same Application names, so ArgoCD
  keeps those Applications: nothing is deleted, re-created or orphaned. An
  old entry of the scope's ``exclusions.yaml`` naming such a cluster would
  delete its app once the default exists: it goes in the same commit
  (ADR-0053).
- **update a fleet default**: its values file and its sync override.

Every change is refused first for a team that has not given Wingman write
access (``AccessService``), then checked as the platform would render it, and
measured on every app of the chart (``PlanWriter.validate``): whatever it
deletes or changes must be confirmed against the preview's digest. A dry run
plans everything and opens nothing.

``service.AuthoringService`` is what the API calls. A use case's rules are in
its own module (``reads``, ``create``, ``team_default``, ``fleet_default``);
``plan`` is what an authoring MR records, ``writer.PlanWriter`` reads, checks
and opens it (``FleetTargetService`` writes through it too), ``describe`` is
its description and ``chart_repo`` checks the chart repo a deploy config names.
"""

from wingman_day2.application.authoring.create import NewAddon, new_deploy_config
from wingman_day2.application.authoring.fleet_default import UNSET, Unset
from wingman_day2.application.authoring.plan import (
    SCOPE_LABELS,
    SCOPE_NOUNS,
    Action,
    Adoption,
    AuthoringPlan,
    AuthoringResult,
    DestinationImpact,
    Effect,
    KeyChange,
    fleet_apps,
)
from wingman_day2.application.authoring.reads import AddonTemplate, FleetDefault, ScopeReach
from wingman_day2.application.authoring.service import AuthoringService
from wingman_day2.application.authoring.team_default import TeamDefaultEdit

__all__ = [
    "SCOPE_LABELS",
    "SCOPE_NOUNS",
    "UNSET",
    "Action",
    "AddonTemplate",
    "Adoption",
    "AuthoringPlan",
    "AuthoringResult",
    "AuthoringService",
    "DestinationImpact",
    "Effect",
    "FleetDefault",
    "KeyChange",
    "NewAddon",
    "ScopeReach",
    "TeamDefaultEdit",
    "Unset",
    "fleet_apps",
    "new_deploy_config",
]

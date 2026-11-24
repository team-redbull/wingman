"""Install, update and remove: one MR on the team's repo per change (ADR-0022).

What Wingman writes:

- **install**: ``<cluster folder>/<chart>/values.yaml``, and ``<chart>.yaml``
  only when needed (a ``repourl`` the team default lacks, a namespace, or an
  explicitly requested emergency pin). Never a per-cluster ``targetRevision``
  by default: that detaches the cluster from fleet and OCP-version upgrades.
  Refused when the chart is a fleet default there (XOR rule).
- **update**: the values file, guarded by the ``last_commit_id`` the caller
  read; the pin only when asked. A fleet default is tweaked through
  ``defaults/<scope>/<chart>/values-<cluster>.yaml``.
- **remove**: every file of the chart folder. ArgoCD then deletes the wrapper
  Application but orphans the workload: it keeps running. If the folder was
  the cluster's last, a ``.gitkeep`` keeps the cluster registered so the
  team's fleet defaults on it are not orphaned too.
- **deploy on specific MCEs** (ADR-0053's amendment): the install above on
  each chosen MCE hub's own ``in-cluster/<chart>/``, one MR per MCE, opened a
  few at a time; each MCE is checked, refused or failed on its own, and
  nothing is retried. An add-on that is an MCE default is refused (XOR).

Before any MR, the team repo as it would be after the change is linted with
the platform's rules; a change that adds an error is refused. Nothing is
synced: leaf apps are manual-sync and Wingman has no ArgoCD access yet.
Every write is refused first for a team that has not given Wingman write
access to its project (ADR-0043).

``service.ChangeService`` is what the API calls. A use case's rules are in its
own module (``install``, ``mces``, ``update``); ``plan`` holds what they share
and ``opening`` opens the MR.
"""

from wingman_day2.application.changes.install import BulkResult, InstallSpec
from wingman_day2.application.changes.mces import MceInstall, MceInstalls
from wingman_day2.application.changes.plan import ChangeResult
from wingman_day2.application.changes.service import ChangeService

__all__ = [
    "BulkResult",
    "ChangeResult",
    "ChangeService",
    "InstallSpec",
    "MceInstall",
    "MceInstalls",
]

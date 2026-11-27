"""A NodePool's name, ``<InfraEnv>[-<suffix>]`` (ADR-0071): a create, a flavor, an edit."""

from __future__ import annotations

from typing import Any, cast

import pytest
import yaml

from wingman_day1.domain.cluster_file import edit_problems as file_edit_problems
from wingman_day1.domain.nodepool_names import (
    GUIDE,
    MAX_NAME,
    NAME_INPUT,
    SUFFIX_INPUT,
    compose,
    edit_problems,
    entry_key,
    follows_rule,
    form_schema,
    input_problems,
    name_of,
    rendered_name,
    rendered_problems,
    suffix_problems,
    with_names,
)
from wingman_day1.domain.template import FieldType, TemplateField

ZONE_A, ZONE_B = "c200-mtl-az1", "c200-mtl-az2"
CLUSTER = "prod-eck-site1"


def pool(infra_env: str | None = ZONE_A, **keys: object) -> dict[str, object]:
    return {**({"infra_env": infra_env} if infra_env else {}), "replicas": 2, **keys}


def inputs(*pools: dict[str, object], **top: object) -> dict[str, object]:
    return {"nodepools": list(pools), **top}


# ── The rule ─────────────────────────────────────────────────────────────────


def test_a_name_is_the_infraenv_and_an_optional_suffix() -> None:
    assert compose(ZONE_A) == ZONE_A
    assert compose(ZONE_A, "") == ZONE_A
    assert compose(ZONE_A, "gpu") == f"{ZONE_A}-gpu"
    assert follows_rule(ZONE_A, ZONE_A)
    assert follows_rule(f"{ZONE_A}-2", ZONE_A)
    assert not follows_rule(f"{CLUSTER}-{ZONE_A}", ZONE_A), "the chart's derived name"
    assert not follows_rule(f"{ZONE_A}-", ZONE_A)
    assert not follows_rule(f"{ZONE_A}-GPU", ZONE_A)
    assert not follows_rule(f"{ZONE_A}x", ZONE_A), "the InfraEnv, then a dash"


@pytest.mark.parametrize("suffix", ["-b", "b-", "B", "b_c", "b.c", "zone a"])
def test_a_suffix_is_the_end_of_a_dns_label(suffix: str) -> None:
    (problem,) = suffix_problems("nodepools[0].name_suffix", suffix)
    assert problem.startswith(f"nodepools[0].name_suffix: {suffix!r} must be lowercase letters")


def test_no_suffix_and_a_good_one_are_fine() -> None:
    assert suffix_problems("x", None) == suffix_problems("x", "") == []
    assert suffix_problems("x", "b") == suffix_problems("x", "zone-b-2") == []
    assert suffix_problems("x", 3) == ["x: must be text"]


# ── Both shapes ──────────────────────────────────────────────────────────────


def test_the_rendered_name_reads_both_shapes() -> None:
    assert rendered_name({"name": ZONE_A, "infraEnvName": ZONE_A}, cluster_name=CLUSTER) == ZONE_A
    assert rendered_name({"infraEnvName": ZONE_A}, cluster_name=CLUSTER) == f"{CLUSTER}-{ZONE_A}"
    selector = {"agentLabelSelector": {"nodeLabelValue": ZONE_B}}
    assert rendered_name(selector, cluster_name=CLUSTER) == f"{CLUSTER}-{ZONE_B}", "as the chart"
    assert rendered_name({"replicas": 2}, cluster_name=CLUSTER) is None


def test_a_name_that_is_the_infraenv_is_not_the_derived_one() -> None:
    named, derived = {"name": ZONE_A, "infraEnvName": ZONE_A}, {"infraEnvName": ZONE_A}
    assert entry_key(0, named) != entry_key(0, derived)
    assert entry_key(0, derived) == f"<clusterName>-{ZONE_A}"
    assert entry_key(3, {"replicas": 1}) == "#3"
    explicit = {"name": f"{CLUSTER}-{ZONE_A}", "infraEnvName": ZONE_A}
    assert entry_key(0, explicit, CLUSTER) == entry_key(0, derived, CLUSTER), "the same NodePool"


# ── The form ─────────────────────────────────────────────────────────────────


def test_the_form_offers_a_suffix_for_the_templates_whole_name() -> None:
    name = TemplateField(NAME_INPUT, FieldType.STRING, False, "", has_default=True)
    infra_env = TemplateField("infra_env", FieldType.STRING, True)
    owner = TemplateField("owner_mador", FieldType.STRING, True)
    pools = TemplateField("nodepools", FieldType.LIST, True, fields=(infra_env, name))
    owner_out, pools_out = form_schema([owner, pools])
    assert owner_out == owner
    assert [f.to_dict() for f in pools_out.fields] == [
        {"name": "infra_env", "type": "string", "required": True},
        {"name": SUFFIX_INPUT, "type": "string", "required": False, "default": ""},
    ]
    bare = TemplateField("nodepools", FieldType.LIST, True, fields=(infra_env,))
    assert form_schema([bare]) == [bare], "a template that reads no name offers no suffix"


# ── A create ─────────────────────────────────────────────────────────────────


def test_each_nodepool_is_named_after_its_infraenv_and_suffix() -> None:
    ready = with_names(inputs(pool(), pool(name_suffix="b"), pool(ZONE_B), platform="agent"))
    pools = cast("list[dict[str, object]]", ready["nodepools"])
    assert [p[NAME_INPUT] for p in pools] == [ZONE_A, f"{ZONE_A}-b", ZONE_B]
    assert all(SUFFIX_INPUT not in p for p in pools), "never rendered"
    assert ready["platform"] == "agent"
    assert input_problems(inputs(pool(), pool(name_suffix="b"), pool(ZONE_B))) == []


def test_two_nodepools_on_one_infraenv_need_different_suffixes() -> None:
    assert input_problems(inputs(pool(), pool())) == [
        f"nodepools[1].{SUFFIX_INPUT}: NodePool {ZONE_A} is nodepools[0]'s already; nodepools "
        "on one InfraEnv need different suffixes, and at most one may have none"
    ]
    (clash,) = input_problems(inputs(pool(name_suffix="b"), pool(), pool(name_suffix="b")))
    assert clash.startswith(f"nodepools[2].{SUFFIX_INPUT}: NodePool {ZONE_A}-b is nodepools[0]'s")


def test_a_bad_suffix_is_refused_at_its_field() -> None:
    (problem,) = input_problems(inputs(pool(name_suffix="Zone_B")))
    assert problem.startswith(f"nodepools[0].{SUFFIX_INPUT}: 'Zone_B' must be lowercase")


def test_a_name_is_at_most_a_label_values_63_characters() -> None:
    long = "x" * (MAX_NAME - len(ZONE_A))  # one over with its dash
    (problem,) = input_problems(inputs(pool(name_suffix=long)))
    assert problem == (
        f"nodepools[0].{SUFFIX_INPUT}: NodePool name '{ZONE_A}-{long}' is longer than "
        f"{MAX_NAME} characters"
    )
    assert input_problems(inputs(pool(name_suffix=long[1:]))) == [], "63 is the limit"


def test_a_whole_name_sent_must_follow_the_rule() -> None:
    assert input_problems(inputs(pool(nodepool_name=f"{ZONE_A}-b"))) == []
    assert name_of(pool(nodepool_name=f"{ZONE_A}-b")) == f"{ZONE_A}-b"
    (problem,) = input_problems(inputs(pool(nodepool_name="eck-zone-a")))
    assert problem == (
        f"nodepools[0].{NAME_INPUT}: 'eck-zone-a' is not <InfraEnv> or <InfraEnv>-<suffix> for "
        f"InfraEnv {ZONE_A}: a new NodePool is named after the InfraEnv it draws from (ADR-0071)"
    )
    (other,) = input_problems(inputs(pool(name_suffix="b", nodepool_name=f"{ZONE_A}-c")))
    assert (
        other
        == f"nodepools[0].{NAME_INPUT}: '{ZONE_A}-c' is not '{ZONE_A}-b', its InfraEnv and suffix"
    )


def test_a_nodepool_without_an_infraenv_keeps_the_templates_name() -> None:
    kubevirt = pool(None, nodepool_name="eck-zone-a")
    assert input_problems(inputs(kubevirt, platform="kubevirt")) == []
    assert with_names(inputs(kubevirt))["nodepools"] == [kubevirt]
    (problem,) = input_problems(inputs(pool(None, name_suffix="b")))
    assert (
        problem
        == f"nodepools[0].{SUFFIX_INPUT}: a suffix follows the nodepool's InfraEnv, and it has none"
    )


def test_a_template_that_does_not_write_the_name_refuses_the_create() -> None:
    ready = with_names(inputs(pool(), pool(name_suffix="b")))
    written = {"nodepool": [{"infraEnvName": ZONE_A, "name": ZONE_A}, {"infraEnvName": ZONE_A}]}
    assert rendered_problems(ready, written) == [
        f"nodepool[1].name: the template wrote None for '{ZONE_A}-b'; the specs project's "
        f"cluster-template.j2 must render {NAME_INPUT} as the nodepool's name ({GUIDE})"
    ]
    written["nodepool"][1]["name"] = f"{ZONE_A}-b"
    assert rendered_problems(ready, written) == []


# ── A flavor ─────────────────────────────────────────────────────────────────


def test_a_flavor_presets_a_suffix_never_a_whole_name() -> None:
    assert input_problems(inputs({"name_suffix": "gpu"}), preset=True) == [], "no InfraEnv yet"
    (problem,) = input_problems(inputs({NAME_INPUT: "falcon-zone-a"}), preset=True)
    assert problem == (
        f"nodepools[0].{NAME_INPUT}: a NodePool is named after the cluster's InfraEnv "
        f"(<InfraEnv> or <InfraEnv>-<suffix>, ADR-0071); preset {SUFFIX_INPUT} instead"
    )
    (bad,) = input_problems(inputs({SUFFIX_INPUT: "-gpu"}), preset=True)
    assert bad.startswith(f"nodepools[0].{SUFFIX_INPUT}: '-gpu' must be lowercase")
    clash = input_problems(inputs(pool(), pool()), preset=True)
    assert len(clash) == 1, "two preset nodepools on one InfraEnv clash too"


# ── An edit ──────────────────────────────────────────────────────────────────

LARK = """\
nodepool:
- infraEnvName: c200-mtl-az1
  replicas: 2
- infraEnvName: c200-mtl-az2
  name: prod-lark-site1-workers
  replicas: 2
"""


def values(text: str) -> dict[str, Any]:
    return yaml.safe_load(text)


def test_an_edit_keeps_every_existing_name_whatever_its_shape() -> None:
    edited = LARK.replace("replicas: 2", "replicas: 3")
    assert edit_problems(values(LARK), values(edited)) == []


def test_a_nodepool_an_edit_adds_is_named_by_the_rule() -> None:
    added = LARK + "- infraEnvName: c200-mtl-az3\n  replicas: 1\n"
    assert edit_problems(values(LARK), values(added)) == [
        "nodepool[2]: a new NodePool is named <InfraEnv> or <InfraEnv>-<suffix> (ADR-0071); "
        "write name: c200-mtl-az3, or c200-mtl-az3-<suffix>"
    ]
    named = added.replace("az3\n  replicas", "az3\n  name: c200-mtl-az3-gpu\n  replicas")
    assert edit_problems(values(LARK), values(named)) == []
    beside = LARK + "- infraEnvName: c200-mtl-az1\n  name: c200-mtl-az1\n  replicas: 1\n"
    assert edit_problems(values(LARK), values(beside)) == [], "beside the derived one"
    wrong = added.replace("az3\n  replicas", "az3\n  name: lark-az3\n  replicas")
    (problem,) = edit_problems(values(LARK), values(wrong))
    assert problem.startswith("nodepool[2].name: 'lark-az3' is not <InfraEnv> or")


def test_an_edit_that_renames_one_adds_a_new_nodepool_named_by_the_rule() -> None:
    renamed = LARK.replace("prod-lark-site1-workers", "lark-az2")
    (problem,) = edit_problems(values(LARK), values(renamed))
    assert problem.startswith("nodepool[1].name: 'lark-az2' is not")
    by_rule = LARK.replace("prod-lark-site1-workers", "c200-mtl-az2")
    assert edit_problems(values(LARK), values(by_rule)) == [], "a person's choice, in the review"


def test_the_clusters_name_matches_an_explicit_derived_name_with_the_derived_one() -> None:
    explicit = LARK.replace(
        "- infraEnvName: c200-mtl-az1\n",
        "- infraEnvName: c200-mtl-az1\n  name: lark-c200-mtl-az1\n",
    )
    assert edit_problems(values(LARK), values(explicit), cluster_name="lark") == []
    assert edit_problems(values(LARK), values(explicit)), "unknown cluster name: a new NodePool"


def test_a_kubevirt_nodepool_an_edit_adds_draws_from_no_infraenv() -> None:
    added = LARK + "- name: lark-vms\n  replicas: 1\n"
    assert edit_problems(values(LARK), values(added)) == []


def test_every_edit_of_a_file_checks_the_names_unless_the_file_did_not_parse() -> None:
    head = 'owner: {merkaz: "1", anaf: "2", mador: "3"}\nmastertag: 4.18.22\n'
    zoned = "  nodeLabels: {topology.kubernetes.io/zone: az3}\n"  # the zone label's check is apart
    added = head + LARK + "- infraEnvName: c200-mtl-az3\n  replicas: 1\n" + zoned
    (problem,) = file_edit_problems(head + LARK, added)
    assert problem.startswith("nodepool[2]: a new NodePool is named")
    assert file_edit_problems("a: [\n", added) == [], "nothing to tell the new ones from"

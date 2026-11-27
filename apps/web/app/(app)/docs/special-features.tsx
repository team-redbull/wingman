import { AlertTriangle, ExternalLink, Eye, FileCode2, GitBranch, Layers, Network, RefreshCw, Settings2, Tag, Zap } from "lucide-react";
import { Callout, CodeBlock, InlineCode, SectionHeader } from "./docs-parts";

/** A titled card in the "Special features" list. */
function FeaturePanel({ icon: Icon, tint, title, where, children }: {
  icon: React.ElementType;
  tint: string;
  title: string;
  where: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b bg-muted/30">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg shrink-0 ${tint}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{where}</p>
        </div>
      </div>
      <div className="px-5 py-4 text-sm text-muted-foreground leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

/** The docs page's "Special Features" section, `#special-features`. */
export function SpecialFeaturesSection() {
  return (
    <section>
      <SectionHeader id="special-features" icon={Zap} title="Special Features" subtitle="Capabilities that are easy to miss" />
      <p className="text-sm text-muted-foreground leading-relaxed mb-6">
        These features exist throughout the UI but are not always obvious at first glance.
      </p>

      <div className="space-y-5">

        <FeaturePanel icon={RefreshCw} tint="bg-emerald-500/10 text-emerald-500" title="Live cluster status" where="Cluster page, Clusters list, Overview — only when the deployment turns it on">
          <p>
            When the deployment reads HostedClusters from the MCE hubs (<InlineCode>CLUSTER_STATUS_ENABLED</InlineCode>),
            the cluster page&apos;s <strong>Live Status</strong> card shows the HostedCluster&apos;s phase, OCP
            version and problems, and each node pool&apos;s ready replicas. It updates itself (every 30 seconds
            by default) and reconnects after a network blip, up to 5 times. The Clusters list shows each
            cluster&apos;s health, and the Overview counts them.
          </p>
          <p>
            The HostedCluster of <InlineCode>ocp4-prod-herzi-site1</InlineCode> is{" "}
            <InlineCode>openshift-prod-herzi-site1</InlineCode> in <InlineCode>hcp-prod-herzi-site1</InlineCode>:
            the file name minus the deployment&apos;s <InlineCode>DAY1_CLUSTER_NAME_STRIP_PREFIX</InlineCode>{" "}
            (<InlineCode>ocp4-</InlineCode> by default).
          </p>
          <Callout type="tip">
            When live status is off, the Overview says <strong>Live status is off</strong>, the list shows a dash
            (&quot;Live status is off in this deployment&quot;), and the cluster page has no Live Status card.
            That is a deployment choice, not an error.
          </Callout>
        </FeaturePanel>

        <FeaturePanel icon={Eye} tint="bg-blue-500/10 text-blue-500" title="Preview the cluster file a flavor produces" where="A flavor's edit page → Review">
          <p>
            The <strong>Review</strong> part of a saved flavor&apos;s edit page renders the cluster file the
            flavor produces, as you edit, on an MCE, release and example name you choose: the same render a
            create runs, through day1. A new flavor has no preview until it is merged.
          </p>
        </FeaturePanel>

        <FeaturePanel icon={GitBranch} tint="bg-purple-500/10 text-purple-500" title="Flavor history & time travel" where="Flavor page → History tab">
          <p>
            Every flavor has a <strong>History</strong> tab listing every commit that touched it. Selecting a commit
            shows the flavor <em>at that exact commit</em>, without affecting the current one. This is useful for:
          </p>
          <ul className="space-y-1 pl-4 list-disc marker:text-muted-foreground/40">
            <li>Auditing what changed between two flavor versions</li>
            <li>Recovering a previous value that was overwritten</li>
            <li>Understanding what a cluster created at a particular time got</li>
          </ul>
        </FeaturePanel>

        <FeaturePanel icon={FileCode2} tint="bg-amber-500/10 text-amber-500" title="Form ↔ YAML toggle for chart values" where="A chart's values editor">
          <p>A chart&apos;s values editor has two views:</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-2">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-1">Form</p>
              <p className="text-xs leading-relaxed">
                Every merged value with the layer that set it. Numbers stay numbers, booleans are switches, lists
                and maps are YAML. It edits keys the merge already has.
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-1">YAML</p>
              <p className="text-xs leading-relaxed">
                The values the change writes into the file, and nothing inherited. Needed for new keys or a{" "}
                <InlineCode>null</InlineCode> that deletes a default. Comments in the file are not kept.
              </p>
            </div>
          </div>
          <p>
            Edits in one view show in the other. While the YAML does not parse, the Form view is unavailable.
          </p>
        </FeaturePanel>

        <FeaturePanel icon={Layers} tint="bg-pink-500/10 text-pink-500" title="Chart value layers view" where="A destination's charts page → a chart → Layers tab">
          <p>Every value in a chart&apos;s values table carries the layer that set it:</p>
          <CodeBlock language="Value provenance example">
{`replicas:   2              ← cluster    (this cluster's values.yaml)
retention:  30d            ← team       (operators/{chart}/values.yaml)
namespace:  cert-manager   ← chart      (the chart's own values.yaml)`}
          </CodeBlock>
          <p>
            The <strong>Layers</strong> tab lists the whole stack in merge order, starting with the chart&apos;s own
            defaults. Files that do not exist are dimmed (<strong>no file</strong>), and the file an edit writes is
            tagged. The stack (which files, in which order) is the platform&apos;s own, checked against the
            platform&apos;s <InlineCode>render_chain.py</InlineCode> simulation.
          </p>
        </FeaturePanel>

        <FeaturePanel icon={AlertTriangle} tint="bg-red-500/10 text-red-500" title="MR conflict detection" where="Approvals page">
          <p>
            The Approvals page shows a <strong>Conflicted</strong> badge on any MR whose branch conflicts with its
            target. This happens when two changes touch the same file, for example two edits of one cluster.
          </p>
          <p>A conflicted MR cannot be merged until the conflict is resolved. Options:</p>
          <ul className="space-y-1 pl-4 list-disc marker:text-muted-foreground/40">
            <li>Reject the conflicted MR and make the change again from the Wingman UI (recommended)</li>
            <li>Resolve the conflict directly in GitLab if you are comfortable with the raw YAML</li>
          </ul>
        </FeaturePanel>

        <FeaturePanel icon={ExternalLink} tint="bg-primary/10 text-primary" title="Open in GitLab — everywhere" where="Clusters, specs, charts, approvals and the audit log">
          <p className="mb-1">These links open in a new tab and are available to all users, including Viewers:</p>
          <div className="space-y-2">
            {[
              { where: "Cluster page → GitLab", what: "The cluster's values file in the day1 repo" },
              { where: "Spec page → History", what: "Each commit of the spec in the specs repo" },
              { where: "Chart → ⋮ menu", what: "Open folder in GitLab: the chart's folder in the team repo" },
              { where: "Approvals → MR", what: "The MR in GitLab" },
              { where: "Audit Log → row", what: "The exact commit or MR in GitLab" },
            ].map(({ where, what }) => (
              <div key={where} className="flex flex-col sm:flex-row gap-1 sm:gap-3 rounded-lg bg-muted/30 px-3 py-2.5">
                <p className="text-xs font-medium text-foreground sm:w-44 sm:shrink-0">{where}</p>
                <p className="text-xs text-muted-foreground min-w-0">{what}</p>
              </div>
            ))}
          </div>
        </FeaturePanel>

        <FeaturePanel icon={Settings2} tint="bg-indigo-500/10 text-indigo-500" title="OpenShift versions come from the upgrade ladder, per MCE" where="New Cluster → OpenShift Version">
          <p>
            Not every MCE can host every OpenShift release, so the list depends on the site and the environment
            you choose, and the picker stays disabled until you choose both. It offers every release some MCE of
            that site and environment can host: the releases in the day1 repo&apos;s{" "}
            <InlineCode>upgrade/ladder.yaml</InlineCode> whose minor is in the MCE&apos;s{" "}
            <InlineCode>upgrade/mces/&lt;mce&gt;.yaml</InlineCode>, newest first. Wingman then picks an MCE that
            hosts the one you chose. These are the same files the cluster-upgrade workflow reads. The release goes
            into the cluster file&apos;s <InlineCode>mastertag</InlineCode>, and the chart adds{" "}
            <InlineCode>-x86_64</InlineCode> to it.
          </p>
          <CodeBlock language="upgrade/mces/ocp4-prod-mce-site1-a.yaml">
{`mce:
  version: 2.8.2
  supportedHostedVersions: ["4.18", "4.17", "4.16"]   # quoted: 4.20 unquoted is a number
maxConcurrentControlPlanes: 1`}
          </CodeBlock>
          <p>
            An MCE with no file, or every MCE while the ladder is missing or broken, hosts no version: it is not
            offered for any, and its version check says why. Wingman never falls back to every release. A
            flavor&apos;s preset version prefills only when some MCE of the site and environment hosts it. Create
            refuses a release the chosen MCE can&apos;t host. To offer
            another release, add a rung to the ladder or a minor to the MCE&apos;s file, through a merge request
            in the day1 repo.
          </p>
        </FeaturePanel>

        <FeaturePanel icon={Network} tint="bg-emerald-500/10 text-emerald-500" title="Node type dropdown" where="New Cluster → nodepool fields">
          <p>
            A template input named <InlineCode>infra_env</InlineCode> becomes the <strong>Node type</strong>{" "}
            dropdown: the kinds of server on the chosen MCE, each in the zones it has there. Under the platform&apos;s
            naming convention an InfraEnv is a node type in one zone (<InlineCode>r760-mtl-az1</InlineCode> is{" "}
            <InlineCode>r760-mtl</InlineCode> in <InlineCode>az1</InlineCode>); the zone is the InfraEnv&apos;s{" "}
            <InlineCode>topology.kubernetes.io/zone</InlineCode> label, else its name&apos;s, and a name off the
            convention is a node type of its own. The pick decides which bare-metal hosts the nodepool gets:
          </p>
          <CodeBlock language="cluster-template.j2 snippet">
{`nodepool:
{% for np in nodepools %}
  - infraEnvName: {{ np.infra_env }}   # picked from the dropdown`}
          </CodeBlock>
          <p>
            It needs live status to be on and the MCE to have a hub token configured. Otherwise the field is plain
            text, a node type and its zone as one name; if listing fails, the form says why and you type them.
          </p>
          <Callout type="tip" title="Which namespace is listed">
            By default, InfraEnvs are listed across the whole hub. The day1 service&apos;s{" "}
            <InlineCode>MCE_INFRAENV_NAMESPACE</InlineCode> restricts the list to one namespace; the Helm chart does
            not set it yet.
          </Callout>
        </FeaturePanel>

        <FeaturePanel icon={Tag} tint="bg-sky-500/10 text-sky-500" title="NodePool names" where="New Cluster → nodepool fields, a flavor's nodepools, Edit cluster">
          <p>
            A new NodePool is named after the node type and zone it draws from:{" "}
            <InlineCode>{"<node type>-<zone>"}</InlineCode>, or <InlineCode>{"<node type>-<zone>-<suffix>"}</InlineCode>. That part
            is fixed; the <strong>Name suffix</strong> beside it is yours, and lets several NodePools draw from one
            node type in one zone. The form shows the whole
            name as you type. There is no cluster prefix: each cluster&apos;s NodePools sit in its own namespace,{" "}
            <InlineCode>{"hcp-<clusterName>"}</InlineCode>.
          </p>
          <CodeBlock language="Three NodePools of one node type in one zone">
{`nodepool:
  - infraEnvName: c200-mtl-az1
    name: c200-mtl-az1          # no suffix
  - infraEnvName: c200-mtl-az1
    name: c200-mtl-az1-gpu      # suffix gpu
  - infraEnvName: c200-mtl-az1
    name: c200-mtl-az1-b        # suffix b`}
          </CodeBlock>
          <p>
            A suffix is lowercase letters, digits and <InlineCode>-</InlineCode>, not starting or ending with one; the
            whole name is at most 63 characters (it labels each of the NodePool&apos;s nodes), and no two NodePools of a
            cluster share one. A flavor may preset the suffix, never a whole name.
          </p>
          <Callout type="tip" title="Existing NodePools keep their names">
            Renaming a NodePool deletes it and creates a new one with new nodes, so Wingman never renames one. Edit
            cluster lists every NodePool: an existing one read-only, by the name it has (the chart&apos;s{" "}
            <InlineCode>{"<clusterName>-<infraEnvName>"}</InlineCode>, or one written in the file, marked{" "}
            <strong>older name</strong> when it does not follow the rule), and one you add with its own suffix.
          </Callout>
        </FeaturePanel>

      </div>
    </section>
  );
}

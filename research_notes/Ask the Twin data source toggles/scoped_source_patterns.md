# Scoped data-source patterns for AI answers (product + architecture survey for Ask the Twin source toggles)

Research date: 2026-10-12. About 19 tool calls. Two primary doc hosts (support.atlassian.com, learn.microsoft.com) failed DNS from this sandbox, so for those products I have search-result summaries of the official pages, not full-page reads. Those are marked "(search summary of official doc)".

## Which products let users choose the sources an AI answer uses, and how is it shown?

### Takeaway
The shipped patterns fall into three tiers:
- **(a) per-question pickers** that end users touch: Gemini Deep Research's source picker, Perplexity's Web/Academic/Social setting, Notion AI's source picker, and M365 Copilot's Work/Web toggle, which is now being replaced.
- **(b) builder-time scopes** baked into an agent or space: Rovo "Only reference these sources", M365 Agent Builder knowledge sources, Databricks Genie spaces, Palantir AIP Agent Studio retrieval context, and Snowflake semantic views.
- **(c) map-scoped assistants**, where the loaded map is the scope: Esri Data Explorer and the ArcGIS AI components.

Admin permissions always override user toggles. At least one vendor (Microsoft) ships a known UI bug in which the toggle shows "on" while policy blocks it.

### Cited Findings
**Per-question / end-user pickers (shipped)**
- **Gemini Deep Research:** you open the Tools menu, pick Deep Research, then choose sources: Search, Gmail, Drive (Docs, Sheets, Slides, PDFs) and Chat. Google Search is on by default, and the user adds or removes personal sources before research starts. Reports differ on rollout order (Workspace/Advanced first vs. all users) — [TechRadar](https://www.techradar.com/pro/gemini-deep-research-can-now-connect-to-your-gmail-docs-drive-and-even-chat); [Coderhouse](https://www.coderhouse.com/en/coderlibrary/articles/google-geminis-deep-research-can-access-gmail-drive-chat-as-sources-to-generate-reports); [MacMyths](https://macmyths.com/gemini-ai-can-read-your-gmail-now-but-its-not-reading-every-inbox/) (secondary press, 2025)
- **Gemini, inclusion ≠ use:** selecting Gmail does not mean every request reads it. The source is made available, not forced. — [MacMyths](https://macmyths.com/gemini-ai-can-read-your-gmail-now-but-its-not-reading-every-inbox/)
- **Perplexity:** search settings include Web, Academic and Social (plus organisation files on paid tiers). The aim is a more targeted answer. Sources disagree on what "Academic" actually retrieves (journals/arXiv vs. merely "credible web results") — [TechTarget](https://www.techtarget.com/ai/definition/What-is-Perplexity-AI); [Peru State libguide](https://peru.libguides.com/empower-module-9/genai-tools)
- **Notion AI:** search spans Notion, Slack, Google Drive and other connectors, with a source picker that narrows the scope — [Notion Help: Everything you can do with Notion AI](https://www.notion.com/help/guides/everything-you-can-do-with-notion-ai)
- **M365 Copilot Chat (classic):** "Work" and "Web" tabs at top centre let users force work-only or web-only answers. They were available in early 2025, and one license took ~2 days to show them — [Chris Menard](https://chrismenardtraining.com/post/copilot-chat-how-to-toggle-between-work-iq-and-the-work-and-web-view/); [MS Tech Community](https://techcommunity.microsoft.com/discussions/microsoft365copilot/copilot-chat-missing-webwork-toggle-bar-%E2%80%93-how-to-enable-it/4391812/replies/4392297)
- **M365 Copilot (2026 redesign):** Message Center MC1325422 describes a "New Copilot" toggle as a temporary opt-out, removed on July 15 for standard release. A blog says a single "Work IQ" control replaces the Work/Web toggle. Dates conflict between sources — [MC1325422 via merill.net](https://mc.merill.net/message/MC1325422); [Chris Menard](https://chrismenardtraining.com/post/microsoft-365-copilot-chat-work-iq-new-interface/)
- **M365 Copilot provenance:** when web search is used, a Sources button under the reply shows the exact Bing query and the sources used. The query is a few words derived from the prompt, not the full prompt — [Microsoft Support: How web search works in M365 Copilot Chat and agents](https://support.microsoft.com/en-us/microsoft-365-copilot/how-web-search-works-in-microsoft-365-copilot-chat-and-agents)

**Builder-time scopes (agents / spaces)**
- **M365 Agent Builder:** an agent's knowledge can be scoped to SharePoint content, Copilot connectors and web content. If the tenant policy "Allow web search in Copilot" is off, web content is blocked, but the Web content toggle in the Knowledge pane still appears enabled. Microsoft calls this "a UI limitation", and the policy takes precedence — [Microsoft Learn: Agent Builder](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agent-builder) (search summary of official doc)
- **Atlassian Rovo:** by default an agent's knowledge is everything the interacting user can access. A custom scope ("Only reference these sources") restricts it to the checked sources, with granular choice of Jira projects and Confluence spaces/pages. The agent is always subject to the user's permissions — [Atlassian Support: Knowledge sources for Rovo agents](https://support.atlassian.com/rovo/docs/knowledge-sources-for-agents) (search summary of official doc)
- **Rovo conflict:** a Community reply claims agents keep default knowledge even when limited, which contradicts the official page's statement that the agent won't use other sources. A community post also describes three options: All org knowledge / Custom / No org knowledge — [Atlassian Community](https://community.atlassian.com/forums/Confluence-questions/Rovo-agents/qaa-p/3079592) vs. [official doc](https://support.atlassian.com/rovo/docs/knowledge-sources-for-agents)
- **Rovo connector gap:** the connectors selectable as agent knowledge sources are "significantly smaller" than those in Rovo Search/Chat. An open request asks to expand them — [JIRA ROVO-846](https://jira.atlassian.com/browse/ROVO-846). Studio filters only "by source", not by document type — [Atlassian dev community](https://community.developer.atlassian.com/t/can-a-rovo-agent-be-scoped-to-teamwork-graph-connector-objects-only/101031)
- **Databricks Genie space:** a curated set of tables plus plain-text instructions plus "trusted assets" (parameterised example queries and UC functions). Answers produced from a trusted asset are labelled as such, and parameter values are shown and editable. Databricks advises keeping the table set small because "unnecessary tables or columns can cause Genie to provide confusing or incorrect answers". It also recommends declaring PK/FK relationships — [Databricks: Trusted assets](https://docs.databricks.com/genie/trusted-assets); [Databricks: Genie set up](https://docs.databricks.com/aws/en/genie/set-up); [Genie concepts](https://docs.databricks.com/gcp/en/genie/concepts)
- **Palantir AIP Agent Studio:** "Ontology context" retrieval works over an object type. You choose either a fixed N objects or semantic top-K (which needs an embedding property). The starting set is static (the whole object type) or variable (a filtered object set passed in as an application state variable). A property allow-list controls which properties are printed to the LLM. The default K is 5 — [Palantir docs: Retrieval context](https://palantir.com/docs/foundry/agent-studio/retrieval-context); [Palantir Community](https://community.palantir.com/t/aip-agent-studio-ontology-context/2833)
- **Palantir stale-scope pitfall:** a community report says Workshop agents did not refresh object-set context after the initial load, and the suggested fix was adding the Object Query tool — [Palantir Community](https://community.palantir.com/t/aip-agent-studio-doesnt-update-object-set-context/1545)
- **Snowflake Cortex Analyst:** since GA on 2025-03-26, a request can pass a *list* of semantic models and let Cortex Analyst choose the best one. This is positioned as one search UI over multiple data sources — [Snowflake release note 2025-03-26](https://docs.snowflake.com/release-notes/2025/other/2025-03-26-multiple-models-cortex-analyst)
- **Snowflake Routing Mode (Preview, 2025-11-14):** prioritises semantic SQL and falls back to standard SQL. It is used automatically with semantic views. Semantic views are the recommended path over legacy YAML, and they are ordinary privileged Snowflake objects — [Release note](https://docs.snowflake.com/release-notes/2025/other/2025-11-14-cortex-analyst-routing-mode); [Routing Mode docs](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/cortex-analyst-routing-mode); [Best practices: semantic views](https://www.snowflake.com/en/developers/guides/best-practices-semantic-views-cortex-analyst/)
- **Glean Apps:** custom apps "can be limited to data from specified knowledge sources" (press release). Glean search supports `app:` filters (e.g. `app:slack,app:drive`). I found no doc confirming a per-chat source selector in Glean Assistant — [Glean press](https://www.glean.com/fr/press/glean-launches-glean-apps-and-glean-apis-empowering-businesses-to-build-custom-generative-ai-apps-and-agents-securely-at-scale); [GitLab handbook Glean tips](https://handbook.gitlab.com/handbook/eta/ai/tools/glean/tips/)

**Map/GIS and digital-twin assistants**
- **Esri Data Explorer (beta):** three agents (data exploration, navigation, help) answer questions about "the data in the map", with no external data sources and no user location. Only feature layers are supported, and quality depends on layer names, field names and field descriptions — [Esri blog: Introducing Data Explorer](https://www.esri.com/arcgis-blog/products/instant-apps/geoai/introducing-data-explorer)
- **ArcGIS Maps SDK for JS AI components (v5.0, beta):** the `arcgis-assistant-data-exploration-agent` takes a reference to an `arcgis-map` "which provides map context to agents". It answers attribute, statistics, proximity and filter questions, in text only — [ArcGIS developers: data exploration agent](https://developers.arcgis.com/javascript/latest/references/ai-components/components/arcgis-assistant-data-exploration-agent/); [help agent](https://developers.arcgis.com/javascript/latest/references/ai-components/components/arcgis-assistant-help-agent/); [What's new in AI assistants, Oct 2025](https://www.esri.com/arcgis-blog/products/arcgis-online/geoai/whats-new-in-ai-assistants-october-2025)
- **Bentley (announced Oct 2025):** Bentley Copilot is a context-aware assistant to be integrated into OpenRoads/OpenRail Designer in early 2026. ProjectWise gets AI search, with early access Dec 2025 and full release in 2026. These are announcements; I found no source-scoping UI described — [Bentley press release](https://www.bentley.com/en/news/bentley-systems-advances-infrastructure-ai-with-new-applications-and-industry-collaboration/); [Cadalyst](https://blog.cadalyst.com/architecture-infrastructure-construction-solutions/bentley-pushes-boundaries-with-infrastructure-ai-and-cloud-connect)
- **Willow Copilot:** the only source found is a marketing listing describing it as conversational AI for operations — [parse.gl listing](https://parse.gl/brands/willowinc-com) (low-quality source)

### Inferences
- The closest analogue to "toggle data sources like layers" is Esri's choice of **the map as the scope**. Ask the Twin already has `mapLayerStore` as the single source of truth for visibility, so "visible layers = default answer scope" maps directly onto an existing design. Esri does not, however, give an explicit per-question override, so Ask the Twin would be going beyond it.
- Gemini's picker is the best end-user model: a sensible default (Search on), additive chips, and a choice made before the run. Its "available ≠ used" semantics argues for showing which selected sources were *actually consulted*, not just which were enabled.
- The builder-time scopes (Genie, Rovo, Palantir, M365 agents) map onto **persona presets**. An operator/TMC preset, a maintenance preset and an executive preset would each be a stored source set, like a Genie space or Rovo agent, which the user can then tweak per question.
- Microsoft's "toggle shows on but policy blocks" bug is a direct warning. The chip state must reflect the *effective* scope (preference ∩ permission), never the preference alone.

### Gaps
- I could not reach support.atlassian.com or learn.microsoft.com directly, so exact UI labels are from search summaries.
- I did not research ChatGPT connectors/projects, Salesforce Agentforce data scoping, IBM Maximo AI assistant, Hexagon, Cesium, or Autodesk Tandem (out of tool budget, or no results for Tandem). No claims are made about them.
- Glean Assistant's per-chat source controls are unconfirmed.

## Design patterns: chips, scopes/spaces, persona presets, map-linked scope, with/without comparisons, per-source provenance

### Takeaway
Shipped products show provenance as a "Sources" disclosure (M365) or labelled trusted answers (Genie). Labelled, parameter-visible answers are the strongest pattern for consistent definitions. I found no shipped product that offers an explicit "compare with vs. without source X" answer, so that would be novel.

### Cited Findings
- **M365 provenance:** a Sources button shows the exact web query sent and the sources used — [Microsoft Support](https://support.microsoft.com/en-us/microsoft-365-copilot/how-web-search-works-in-microsoft-365-copilot-chat-and-agents)
- **Genie provenance:** an answer that came from a trusted asset is labelled as trusted, and its parameter values are shown and editable in the response — [Databricks trusted assets](https://docs.databricks.com/genie/trusted-assets)
- **Practitioner citation-UX guidance:** use progressive depth (inline chip → claim preview → full source list). Evidence should be "legible at the claim level, auditable at the answer level, and correctable when retrieval is wrong". Give users a feedback taxonomy of wrong source / weak source / missing source — [AI UX Playground: How to design AI citations](https://aiuxplayground.com/guides/how-to-design-ai-citations) (practitioner blog, not research)
- **Citations raise trust even when wrong:** in a large randomized experiment (MIT-led, arXiv 2025), reference links increased trust in GenAI search even when they were incorrect or hallucinated. Uncertainty highlighting reduced willingness to trust and share — [Human Trust in AI Search, arXiv 2504.06435](https://arxiv.org/abs/2504.06435)
- **Persona/space presets:** Rovo agents (custom knowledge per agent), Genie spaces (curated tables per domain) and Snowflake semantic views organised "by business domain" are all stored scope presets — [Atlassian](https://support.atlassian.com/rovo/docs/knowledge-sources-for-agents); [Databricks](https://docs.databricks.com/aws/en/genie/set-up); [Snowflake best practices](https://www.snowflake.com/en/developers/guides/best-practices-semantic-views-cortex-analyst/)
- **Variable scope from app state:** Palantir passes a filtered object set as an application state variable into the agent's retrieval context. This is the closest documented analogue to "current map selection / visible layers drive the scope" — [Palantir Retrieval context](https://palantir.com/docs/foundry/agent-studio/retrieval-context)

### Inferences
- **Recommended presentation for Ask the Twin:**
  - Source chips above the input, mirroring the map's layer list: Live events, Tickets/Work orders, Inspections/Asset status, Historical crashes, Weather, Corridor geometry.
  - A persona preset dropdown that sets the chips.
  - Per answer, an "Used: X, Y · Excluded by you: Z · Not relevant: W" line, with each evidence chip tagged by source.
- **Because citations inflate trust even when wrong,** the exclusion line matters more than the inclusion line. It is the only cue that a de-selected source could have changed the answer.
- **"Compare with/without X"** can be implemented as two runs with different tool sets and a diff of their conclusions. No surveyed product ships this, so it should be labelled as an experimental feature.

### Gaps
- I did not find any NN/g (or comparable) published usability research specifically on AI source-scoping toggles. The search returned no NN/g articles.
- I found no product evidence for counterfactual "with/without source" answers.

## Architecture patterns: per-request tool filtering, shared semantic layers, permissions vs. focus, not silently ignoring de-selected sources

### Takeaway
Implement **focus as per-request tool/data filtering on top of permissions, never instead of them**. Expose only the tools, and the table/class allow-lists inside them, that match the selected sources. Keep metric definitions in one shared semantic layer (Ask the Twin's `dataDictionary` / `dataGuide.json` already plays this role). Put the effective scope in the prompt and in the reply so exclusions are stated, not silent.

### Cited Findings
- **Permissions vs. focus are separate layers.** Rovo's custom scope narrows sources, but "the agent is always subject to the user's permissions". In M365, admin policy overrides the user/builder web toggle — [Atlassian](https://support.atlassian.com/rovo/docs/knowledge-sources-for-agents); [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agent-builder)
- **Snowflake semantic views** are governed Snowflake objects with standard privileges. Access control rides on the object, while the semantic definition gives consistent metrics across domains, and multiple views can be routed in a single request — [Snowflake Routing Mode](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/cortex-analyst-routing-mode); [Multi-model GA](https://docs.snowflake.com/release-notes/2025/other/2025-03-26-multiple-models-cortex-analyst)
- **Smaller exposed schema → better answers:** Databricks warns that extra tables/columns cause confusing or incorrect answers — [Databricks Genie set up](https://docs.databricks.com/aws/en/genie/set-up)
- **Column-level context filter:** Palantir lets builders pick which object properties are printed to the LLM, defaulting to all printable properties — [Palantir Retrieval context](https://palantir.com/docs/foundry/agent-studio/retrieval-context)
- **Esri ties answer quality to schema metadata** (layer/field names and descriptions). This is the GIS equivalent of a data dictionary — [Esri Data Explorer](https://www.esri.com/arcgis-blog/products/instant-apps/geoai/introducing-data-explorer)

### Inferences
- **Concrete mapping for `askTwin.mjs` / `askTools.mjs`:**
  - Build the `tools` array per request from the selected sources. Either drop `get_weather` when Weather is off, or keep the tool and pass a `sources` allow-list into `query_records` / `find_corridor_features` that the server enforces against the data dictionary. Enforce it server-side so the model cannot query a de-selected class even by name.
  - `describe_data` should report only in-scope classes, plus a list of "excluded by user" classes, so the model can say what it lacks.
- **Avoiding silent omission:**
  1. Add a system-prompt block: "Sources in scope: … Sources excluded by the user: … If the question needs an excluded source, say so and name it; do not infer its contents."
  2. A reply-contract field such as `scope: {used:[], excluded:[], needed_but_excluded:[]}`, which the client renders as a banner.
  3. A cheap deterministic check that flags `needed_but_excluded` when the question mentions keywords tied to an excluded class (the data dictionary already has class/field names).

  Example phrasing: "This answer excludes revenue data (turned off). Including it could change the ranking."
- **Macro/executive view:** cross-silo trade-off questions need joins across sources. Keep the "All sources" preset as the default for an executive persona, and keep shared definitions (one `dataGuide.json` entry per class) so an operator-scoped answer and an executive answer use the same metric names. This matches the Snowflake/Genie "one semantic layer, many scoped spaces" model.

### Gaps
- I found no published quantitative study measuring the precision gain from narrower retrieval scope in enterprise assistants. The evidence is vendor guidance only: Databricks' "keep it small", and Anthropic's tool-selection accuracy note below.
- I found no source on the "stale toggles" problem beyond the Palantir stale object-set report and Microsoft's UI-shows-on bug.

## Evidence on benefits and pitfalls

### Takeaway
The documented benefits are better tool/table selection and less context bloat. The documented pitfalls are toggles that misreport the effective state, scopes that don't refresh, scope boundaries that leak (the disputed Rovo case), and "academic/focus" labels whose actual coverage is unclear to users.

### Cited Findings
- **Benefit, tool accuracy:** Anthropic says Claude's tool-selection accuracy "degrades once you exceed 30–50 available tools". A typical multi-server setup costs ~55k tokens of definitions, and tool search cuts this by >85% — [Anthropic docs: Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- **Benefit, focused schema:** fewer tables means fewer confusing or incorrect answers — [Databricks](https://docs.databricks.com/aws/en/genie/set-up)
- **Pitfall, misleading toggle:** the M365 web toggle appears on while policy blocks it — [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agent-builder)
- **Pitfall, stale scope:** the Palantir agent didn't refresh its object-set context after the initial load — [Palantir Community](https://community.palantir.com/t/aip-agent-studio-doesnt-update-object-set-context/1545)
- **Pitfall, leaky or unclear boundary:** users report Rovo agents still using default knowledge despite a custom scope (disputed by the official doc) — [Atlassian Community](https://community.atlassian.com/forums/Confluence-questions/Rovo-agents/qaa-p/3079592)
- **Pitfall, unclear label semantics:** what Perplexity's "Academic" focus actually retrieves is described inconsistently — [Peru State libguide](https://peru.libguides.com/empower-module-9/genai-tools) vs. [TechTarget](https://www.techtarget.com/ai/definition/What-is-Perplexity-AI)
- **Pitfall, UI churn:** Microsoft removed the Work/Web toggle in a 2026 redesign in favour of "Work IQ", with conflicting rollout dates — [MC1325422](https://mc.merill.net/message/MC1325422)
- **Pitfall, over-trust in citations** — [arXiv 2504.06435](https://arxiv.org/abs/2504.06435)

### Inferences
- For Ask the Twin, the main risk is not too many tools: there are only 6 today, below Anthropic's 10-tool threshold for tool search. The main risks are **scope mis-reporting** and **silent omission**. Invest in effective-scope display and in `needed_but_excluded` flags.
- Chip state should reset to the persona default per session, or at least be visibly persistent, to avoid stale toggles. It should also be echoed in each answer, since the answer may be read later.

### Gaps
- I found no hard user-research numbers on confusion rates with source toggles.

## Anthropic / OpenAI guidance on dynamic tool sets, tool search and prompt caching

### Takeaway
On Anthropic, changing the `tools` array invalidates the *entire* prompt cache (tools → system → messages). Per-question tool filtering therefore costs a cache miss each time the set changes, unless you use one of two approaches:
- **(a) keep a stable full tool list and enforce scope in tool inputs/server**, or
- **(b) use `defer_loading` with tool search,** or the new inline `tool_addition` beta, which keeps the prefix intact.

`tool_choice` changes only invalidate message blocks. With ~6 small tools, approach (a) is simplest. Put the scope in a message block, not in the system prompt, if you want the system cache kept.

### Cited Findings
- **Cache invalidation:** the cache hierarchy is `tools` → `system` → `messages`. "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache." Changes to `tool_choice` "only affect message blocks". Toggling web search or citations modifies the system prompt — [Anthropic docs: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **Cache mechanics:** up to 4 breakpoints. Default TTL is 5 min, with a 1 h TTL at 2x write cost. The minimum cacheable prefix is 512 tokens on the 5.x-generation models (1,024–4,096 on older ones) — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **Inline tools beta:** with the `inline-tools-2026-09-15` beta header, a tool can be added or changed mid-conversation via a `tool_addition` block in a mid-conversation system message, leaving `tools` unchanged so the cached prefix still matches. The exception: if `tools` has no non-deferred tool, the first such addition costs one full miss — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (beta)
- **Tool search:** you send every tool definition each request and mark rarely-used ones `defer_loading: true`. "The API excludes deferred tools from the system-prompt prefix … The prefix is untouched, so prompt caching is preserved." Up to 10,000 deferred tools are allowed. Keep the 3–5 most-used tools non-deferred. A deferred tool can't carry `cache_control`. Regex and BM25 variants are available, plus custom search returning `tool_reference` blocks — [Anthropic docs: Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- **When to use tool search:** 10+ tools, more than 10k tokens of definitions, or falling accuracy. Standard tool calling fits better with fewer than 10 tools — [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- **Tool naming:** namespace tool names by service (e.g. `github_`, `slack_`) and describe tool categories in the system prompt — [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool). Background: [Anthropic Engineering: Advanced tool use](https://anthropic.com/engineering/advanced-tool-use); [Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) (not read in full)
- **OpenAI:** the Responses API has `tool_choice: {type: "allowed_tools", mode: auto|required, tools:[…]}` to restrict the model to a subset of the declared tools — [LangChain type reference for OpenAI ToolChoiceAllowed](https://v03.api.js.langchain.com/interfaces/_langchain_openai.OpenAIClient.Responses.ToolChoiceAllowed.html) (secondary; the OpenAI page was not reached)
- **OpenAI caching:** the tool list is cacheable and counts toward the 1,024-token minimum — [Portkey mirror of OpenAI prompt caching](https://portkey.ai/docs/integrations/llms/openai/prompt-caching-openai) (secondary)
- **No official OpenAI statement found** on whether `allowed_tools` preserves the cache. A community thread asks without an answer — [OpenAI community](https://community.openai.com/t/prompt-caching-with-tools/1357440)

### Inferences
- **Cheapest correct design for Ask the Twin (Anthropic, 6 tools):**
  - Keep the `tools` array constant.
  - Pass the per-question scope as a message-level block, e.g. a `<scope>` preamble in the user turn.
  - Enforce it server-side in each tool handler: reject or blank out-of-scope classes, and return "excluded by user scope" so the model can cite the exclusion.
  - This keeps both the tools and system caches warm, and the server-side enforcement makes it robust against the model ignoring the prompt.
- **Alternative:** narrow which tools may be called via `tool_choice`, which only invalidates message blocks. Anthropic's `tool_choice` forces a specific tool or "any", though; it is not an allow-list like OpenAI's `allowed_tools`, so this is weaker.
- **If sources grow into many per-source tools** (e.g. one tool per DataConnect class or per stakeholder dataset), adopt `defer_loading` with namespaced tool names (`live_`, `hist_`, `asset_`) and a category list in the system prompt.

### Gaps
- I didn't read the full "Tool use with prompt caching" page or the OpenAI first-party docs on `allowed_tools` and caching interplay.

# Seagirt IFC Spatial Twin — Context-Aware Intelligence, Multi-Tool Reasoning and Maintenance Diagnostics

## 1. Background and current problem

We have already implemented the following capabilities in the Seagirt IFC Spatial Twin:

- Cesium 3D visualization.
- IFC asset inventory and geometry.
- Autodesk Construction Cloud (ACC) integration.
- IFC version management and comparison.
- Electrical connectivity and directional supply paths.
- Operational power status.
- Asset highlighting and camera focus.
- Outage simulation and alternate supply analysis.
- ACC document retrieval.
- Inspection history and technical specification analysis.
- PDF and Excel report generation.
- Email drafting and Gmail integration.
- Ask the Twin with default and expanded width modes.
- Spatial area selection and area-aware questions.

However, Ask the Twin is currently failing to understand the actual intent of certain questions.

### Actual issue

I selected a geographical area in Seagirt and asked:

"For degraded asset, what needs to be fixed?"

The system returned:

"In the selected area, 1 is degraded."

TX-M2 — Degraded

- 0 No power
- 1 Degraded
- 21 Powered

It also displayed the number of assets without an operational status.

This is not the correct answer.

The system correctly identified the degraded asset but failed to investigate what needs to be fixed.

The user is asking for maintenance findings, documented defects and corrective actions, not an operational status summary.

The system should identify TX-M2, retrieve its linked ACC documents, analyse its inspection history, identify outstanding defects and explain what needs to be repaired or investigated.

Fix the underlying architecture so that similar problems do not occur for other questions, assets or geographical scopes.

Do not implement a hardcoded solution specifically for TX-M2 or the word "degraded".

---

## 2. Objective

Transform Ask the Twin into a context-aware intelligence assistant that can:

1. Understand the actual objective of a question.
2. Resolve geographical and conversational context.
3. Identify relevant assets.
4. Select the appropriate data sources.
5. Execute multiple tools for a single question.
6. Combine operational, spatial, electrical and documentary evidence.
7. Provide a concise, actionable and evidence-backed answer.
8. Visualize relevant findings on the Cesium map.
9. Support follow-up investigations, simulations, reports and communication.

The selected area must be treated as a query scope, not as an intent.

The same intelligence framework must work for:

- Individual assets.
- Multiple selected assets.
- Previously returned asset collections.
- Selected geographical areas.
- Named operational zones.
- Assets near another asset.
- The entire terminal.
- Electrical dependencies outside a geographical boundary.

---

## 3. Audit the existing architecture

Before modifying the application, inspect the existing Ask the Twin implementation.

Identify:

- Current intent detection logic.
- Keyword-based routing rules.
- Deterministic question handlers.
- LLM-based question handlers.
- Area-specific query handlers.
- Conversation context management.
- Selected asset context.
- Previous response context.
- Spatial selection context.
- Operational status services.
- ACC document retrieval and extraction.
- Inspection analysis services.
- Electrical graph and supply path services.
- Outage simulation engine.
- Report generation services.
- Gmail integration.
- Existing structured response types.
- Frontend response rendering components.
- Map action execution.

Trace the exact execution path for:

"For degraded asset, what needs to be fixed?"

Determine why the question was routed to an area power status response instead of a maintenance investigation.

Specifically investigate whether:

- The word "degraded" triggers an early operational status handler.
- The selected area handler intercepts the question before intent analysis.
- The deterministic handler returns before document intelligence can execute.
- The system supports only one tool per question.
- The existing LLM does not receive sufficient conversational or spatial context.
- Follow-up questions lose the previous asset collection.
- Existing document intelligence is limited to explicitly named assets.

Do not assume these are the actual causes. Verify them from the code.

Provide the confirmed root cause in the implementation summary.

---

## 4. Introduce a common intent and context resolution framework

Separate every user question into independent dimensions.

### A. User objective

What does the user actually want to know or accomplish?

Examples:

- Locate assets.
- Count assets.
- Check operational status.
- Investigate degradation.
- Identify defects.
- Identify corrective actions.
- Review inspection history.
- Compare condition over time.
- Review operating restrictions.
- Understand electrical dependencies.
- Evaluate alternate supply.
- Simulate an outage.
- Prepare a replacement assessment.
- Generate a report.
- Draft an email.

### B. Asset target

Which assets is the user referring to?

Examples:

- TX-M2.
- All transformers.
- All degraded assets.
- Assets without power.
- Lighting assets.
- Circuit breakers.
- Previously highlighted assets.
- The assets returned in the previous answer.
- Assets supplying the selected area.

### C. Spatial scope

Where should the investigation apply?

Examples:

- Selected geographical area.
- Entire terminal.
- Selected asset.
- Named substation.
- Named container yard.
- Within a specified distance.
- Upstream dependencies.
- Downstream dependencies.

### D. Temporal scope

Which time or version should be used?

Examples:

- Current operational status.
- Latest inspection.
- Historical inspections.
- Previous inspection.
- Active IFC version.
- Specific IFC version.
- Baseline electrical topology.
- Active simulated scenario.

### E. Requested output

What form of response does the user expect?

Examples:

- Direct answer.
- Asset collection.
- Diagnostic assessment.
- Corrective action summary.
- Inspection comparison.
- Electrical supply path.
- Outage simulation.
- PDF report.
- Excel register.
- Email draft.

Do not treat these dimensions as mutually exclusive.

A single question can contain multiple objectives, filters and requested outputs.

---

## 5. Implement reusable intent categories

Introduce or extend the existing intent taxonomy.

Use names consistent with the existing codebase.

Suggested intents:

| Intent | Purpose |
|---|---|
| ASSET_INVENTORY | Count and categorize assets |
| ASSET_LOCATION | Locate assets geographically |
| ASSET_STATUS | Retrieve operational status |
| ASSET_DIAGNOSIS | Investigate documented causes and symptoms |
| CORRECTIVE_ACTIONS | Identify documented repairs and required investigations |
| INSPECTION_HISTORY | Retrieve inspection records |
| CONDITION_TREND | Compare historical condition |
| RECURRING_DEFECTS | Identify repeated inspection findings |
| OUTSTANDING_ACTIONS | Identify actions without verified closure |
| OPERATING_RESTRICTIONS | Retrieve documented operational limitations |
| TECHNICAL_SPECIFICATIONS | Retrieve equipment specifications |
| REPLACEMENT_ASSESSMENT | Review replacement requirements |
| SUPPLY_DEPENDENCY | Analyse upstream electrical supply |
| DOWNSTREAM_IMPACT | Identify dependent consumers |
| ALTERNATE_SUPPLY | Evaluate modeled redundancy |
| OUTAGE_IMPACT | Execute outage simulation |
| VERSION_COMPARISON | Analyse IFC version changes |
| CONSTRUCTION_SCREENING | Identify potentially affected infrastructure |
| REPORT_GENERATION | Generate PDF and Excel artifacts |
| EMAIL_DRAFT | Prepare an email from investigation results |

The architecture must allow multiple intents or dependent execution steps when necessary.

Do not create a separate copy of each intent for selected-area questions.

For example:

CORRECTIVE_ACTIONS should work for:

- TX-M2.
- All transformers.
- All degraded assets.
- Degraded assets within the selected area.
- Assets returned by a previous question.
- Assets supplying a particular crane.

The intent remains the same. Only the target and scope change.

---

## 6. Fix intent priority and semantic understanding

The presence of an asset category, status keyword or selected area must not override the actual question objective.

Examples:

"Which assets are degraded?"

Primary intent: ASSET_STATUS.

"Why are these assets degraded?"

Primary intent: ASSET_DIAGNOSIS.

"What needs to be fixed?"

Primary intent: CORRECTIVE_ACTIONS.

"Since when has this asset been degraded?"

Primary intent: Historical operational status investigation.

"Is its condition getting worse?"

Primary intent: CONDITION_TREND.

"Has this issue occurred before?"

Primary intent: RECURRING_DEFECTS.

"Can we continue operating this asset?"

Primary intent: OPERATING_RESTRICTIONS.

"What happens if we shut it down?"

Primary intent: OUTAGE_IMPACT.

"Is there an alternate supply?"

Primary intent: ALTERNATE_SUPPLY.

"What needs to be done before replacement?"

Primary intent: REPLACEMENT_ASSESSMENT.

"Prepare a report of these issues."

Primary intent: REPORT_GENERATION using the existing investigation context.

"Inform the maintenance team."

Primary intent: EMAIL_DRAFT.

For the question:

"For degraded asset, what needs to be fixed?"

The correct interpretation is:

- Primary intent: CORRECTIVE_ACTIONS.
- Asset filter: Degraded.
- Spatial scope: Active selected area.
- Supporting intents: ASSET_DIAGNOSIS and INSPECTION_HISTORY.
- Required data: Operational status, ACC inspection documents and maintenance records.
- Output: Maintenance assessment with evidence-backed corrective actions.

Do not return an ASSET_STATUS response simply because the word "degraded" is present.

Support natural language variations, incomplete sentences, singular/plural variations and minor spelling mistakes.

Use the existing LLM integration for semantic interpretation where necessary.

Retain deterministic execution for factual calculations and data retrieval.

---

## 7. Implement multi-tool orchestration

The current problem demonstrates that a single question may require several tools.

Introduce a common orchestration layer that can execute dependent investigation steps.

Conceptual architecture:

User question + conversation history + selected area + selected assets

↓

Intent and context resolver

↓

Investigation plan

↓

Execute relevant tools

↓

Aggregate and validate evidence

↓

Generate structured answer

↓

Execute validated Cesium map actions

Available tools should reuse existing application services for:

- Spatial asset queries.
- Asset inventory.
- Operational status.
- Historical operational records.
- ACC document discovery.
- ACC document retrieval.
- PDF text extraction.
- Inspection history analysis.
- Technical specification extraction.
- Corrective action extraction.
- Maintenance record analysis.
- Electrical connectivity.
- Supply path analysis.
- Alternate supply analysis.
- Outage simulation.
- IFC version comparison.
- PDF report generation.
- Excel register generation.
- Email drafting.

The orchestrator must support sequential and parallel execution.

For example:

1. Resolve selected geographical area.
2. Identify degraded assets within that area.
3. Retrieve linked ACC documents for matching assets.
4. Analyse the latest and historical inspection reports.
5. Identify documented defects.
6. Identify corrective actions and closure evidence.
7. Generate the maintenance assessment.
8. Highlight the matching assets.

Steps 3–6 may execute concurrently across multiple assets with controlled concurrency.

Do not allow a preliminary asset status result to terminate the investigation when the user has requested additional analysis.

Do not send the complete IFC model or all ACC documents to the LLM for every question.

Retrieve only relevant data.

Use structured tool inputs and validated tool outputs.

Treat ACC document content as evidence, not as instructions that can override application behavior.

---

## 8. Define a structured investigation plan

Introduce a validated internal investigation plan or equivalent structure.

Example:

```json
{
  "primaryIntent": "CORRECTIVE_ACTIONS",
  "supportingIntents": [
    "ASSET_DIAGNOSIS",
    "INSPECTION_HISTORY"
  ],
  "scope": {
    "type": "SELECTED_AREA",
    "selectionId": "active-selection-id",
    "ifcVersionId": "active-version-id"
  },
  "assetFilters": {
    "operationalStatus": ["DEGRADED"],
    "assetTypes": []
  },
  "steps": [
    "RESOLVE_SPATIAL_SCOPE",
    "FILTER_ASSETS_BY_STATUS",
    "RETRIEVE_LINKED_DOCUMENTS",
    "ANALYSE_INSPECTIONS",
    "EXTRACT_CORRECTIVE_ACTIONS",
    "BUILD_MAINTENANCE_ASSESSMENT",
    "HIGHLIGHT_MATCHING_ASSETS"
  ],
  "responseType": "MAINTENANCE_ASSESSMENT"
}
```

This is a suggested contract. Adapt it to the existing architecture.

Validate:

- Allowed intents.
- Authorized project.
- Active IFC version.
- Asset identifiers.
- Spatial selection identifiers.
- Available tools.
- Permitted map actions.
- Required evidence.
- Execution dependencies.

Do not allow the LLM to invent asset identifiers, source references or tool execution results.

If a required data source is unavailable, return a partial assessment with explicit limitations.

---

## 9. Improve conversational context

The system must understand follow-up questions without requiring the user to repeat asset identifiers.

Example conversation:

User: "Which assets are degraded in this area?"

Assistant: "TX-M2 is the only degraded asset in the selected area."

User: "What needs to be fixed?"

The second question must refer to TX-M2.

User: "Has this issue occurred before?"

The system must compare relevant historical inspection findings for TX-M2.

User: "What happens if we shut it down?"

The system must resolve TX-M2 and invoke the outage simulation engine.

User: "Prepare a report of these findings."

The report must use the accumulated maintenance investigation, not generate a generic asset inventory.

User: "Draft an email to the maintenance team."

The system must prepare an email based on the investigation and generated artifacts.

Maintain structured conversational context containing:

- Active project.
- Active IFC version.
- Active geographical selection.
- Selected asset.
- Previously returned asset collection.
- Last investigation.
- Referenced defects.
- Referenced corrective actions.
- Last electrical analysis.
- Active simulation.
- Generated reports.
- Email draft references.

Do not rely exclusively on unstructured conversation text.

If multiple assets are possible targets and the question requires a single asset, ask a concise clarification.

Do not arbitrarily choose one.

If the user changes the geographical selection, preserve the historical context of previous responses while using the new selection for subsequent area-scoped questions.

---

## 10. Correct execution workflow for maintenance investigations

For questions such as:

- What needs to be fixed?
- Why is this asset degraded?
- What is wrong with this transformer?
- What repairs are required?
- What maintenance is needed?
- Which defects are still outstanding?
- What should the maintenance team investigate?

Execute the following workflow.

### Step 1 — Resolve target assets

Use explicit asset references, previous response context, spatial scope and operational filters.

### Step 2 — Retrieve current operational status

Retrieve the actual status from the existing operational status engine.

Distinguish powered, degraded, no power, offline, unknown and simulated status.

### Step 3 — Retrieve relevant ACC documents

Discover linked:

- Latest inspection reports.
- Historical inspection reports.
- Technical specification sheets.
- Maintenance records.
- Repair records.
- Work orders, if available.
- Test reports.
- Documented operating restrictions.

Use the existing ACC integration.

Do not invent documents that do not exist.

### Step 4 — Analyse inspection history

Identify:

- Latest inspection date.
- Latest condition rating.
- Historical condition ratings.
- Documented defects.
- Items requiring attention.
- Recurring defects.
- Worsening defects.
- Newly identified defects.
- Previously resolved issues.
- Recommended actions.
- Actions without verified closure.

### Step 5 — Extract corrective actions

Distinguish between:

1. Explicitly documented corrective actions.
2. Documented findings requiring investigation.
3. Additional engineering checks inferred from available evidence.
4. Actions with verified completion.
5. Actions without verified closure.

Do not present an inferred engineering recommendation as a documented instruction.

### Step 6 — Assess evidence quality

Determine whether the available records are sufficient to explain the current degradation.

A historical inspection finding may be relevant but may not establish the cause of the current operational status.

Do not claim a causal relationship unless supported by evidence.

### Step 7 — Build a concise maintenance assessment

Return:

- Asset identity.
- Current operational status.
- Latest documented condition.
- Main defects.
- Corrective actions or required investigations.
- Relevant operating restrictions.
- Evidence limitations.
- Source references.
- Map actions.
- Relevant follow-up actions.

---

## 11. Single-asset maintenance assessment UI

Use the supplied single-asset design reference as the visual direction.

Maintain the existing premium dark navy Ask the Twin appearance.

Do not display the full replacement readiness report or the entire inspection document in the conversation.

### Header

Display:

- Existing Ask the Twin title and AI indicator.
- Select Area button.
- Expand/Restore Width button.
- Collapse button.

### Selected area context

Display a compact context card:

Selected area

Custom selected area · 1 degraded asset

The actual count must be dynamically calculated.

### Direct conversational answer

Example:

"I found one degraded transformer, TX-M2, in your selected area. Its latest inspection identifies several issues requiring corrective action."

If the cause of degradation cannot be established, explicitly distinguish that from the documented inspection findings.

### Asset summary card

Display:

- Asset icon.
- Asset ID.
- Asset type.
- Asset name.
- Operational status.
- Show on map action.

Example:

TX-M2

Main transformer

Degraded · Still powered

Only display the powered state when supported by the operational data.

### Condition trend

Display a compact inspection condition trend chart when historical ratings are available.

For the currently available TX-M2 illustrative records:

- March 2024: Good — 4/5.
- April 2025: Fair — 3/5.
- October 2026: Poor — 2/5.

Use green, amber and red markers to communicate the documented condition.

Do not confuse inspection condition ratings with live operational status.

Use actual inspection dates and values.

Do not fabricate missing historical points.

Do not interpolate unknown condition ratings.

Hide the chart if there is insufficient comparable data.

### Main section

Title:

"What needs to be fixed or investigated"

Display concise finding rows.

Each row should contain:

- Finding title.
- Plain-language explanation.
- Documented action or investigation requirement.
- Source reference.
- Severity, only where supported.
- Optional expandable evidence.

Do not use multiple large badges on every finding.

Prioritize the most important documented findings.

Display approximately three to five findings initially.

Provide "View all findings" when additional findings exist.

### TX-M2 example

The previously reviewed illustrative ACC inspection records contain the following findings:

1. Internal overheating concern.

Latest dissolved gas analysis indicates a possible high-temperature thermal fault. Specialist investigation is required.

2. Oil leakage.

Oil leakage was reported at radiator 3 isolation valve. Assess the documented leakage and required corrective action.

3. Cooling fan failure.

Fan 4 was reported failed. Review the documented recommendation for restoring cooling functionality.

4. Bushing connection.

Discolouration was reported on the LV X2 connector. Investigate the connection condition.

5. Low oil level.

The inspection reported an oil level 30 mm below normal. Review the cause and documented corrective actions.

These examples are based on previously displayed illustrative inspection findings.

Do not hardcode these findings into the application.

Retrieve the actual linked ACC documents and dynamically generate the assessment.

Do not assume that these findings establish the current cause of the degraded status.

### Engineering review

Display a concise statement when appropriate:

"The documented inspection findings indicate deteriorating condition. Engineering review is required to confirm the appropriate corrective actions."

Do not provide an unverified instruction to repair, isolate, replace or continue operating electrical equipment.

### Sources

Display a compact source row:

Latest inspection · 28 Oct 2026

ACC inspection report · Page 1

The source must be clickable and open the relevant document or existing document preview.

Provide additional page-level references where corrective actions are documented elsewhere.

### Primary actions

- Show on map.
- View inspection.

### Secondary action

- Generate maintenance report.

### Suggested follow-up questions

Display a maximum of three relevant suggestions:

- What happens if TX-M2 is taken out of service?
- Are there any outstanding inspection actions?
- Draft an email to the maintenance team.

These suggestions must be dynamically generated from the investigation context.

---

## 12. Multi-asset maintenance assessment UI

Use the supplied multi-asset design reference as the visual direction.

The same investigation must work when multiple degraded assets are identified.

Do not render a complete inspection assessment for every asset in one long conversation response.

Instead, display a compact collection summary.

Example:

"Maintenance assessment"

"I found 5 degraded assets within your selected area. Inspection evidence is available for 3 of them."

Summary metrics:

- Degraded: 5.
- With findings: 3.
- Cause unknown: 2.

These counts are illustrative and must be calculated dynamically.

Define these metrics carefully.

An asset with documented inspection findings may still have an unknown current degradation cause. Do not present overlapping metrics as mutually exclusive categories.

Where appropriate, use clearer labels such as:

- Degraded assets.
- With documented findings.
- Without documented findings.

Track verified degradation cause separately.

### Asset rows

Each row should display:

- Asset ID.
- Asset type.
- Operational status, if useful.
- Concise summary of main documented findings.
- Evidence availability.
- Chevron or expand action.

Example layout:

TX-M2 — Transformer

Oil leakage, cooling failure and thermal fault concern.

Findings available.

TX-3 — Transformer

Inspection findings require review.

Findings available.

CB-STS-06 — Circuit breaker

Documented findings require review.

Findings available.

STS-02 — Crane

Cause of degradation not documented.

Investigation required.

STS-11 — Crane

Cause of degradation not documented.

Investigation required.

These are illustrative layout examples.

Do not assume that inspection records exist for TX-3, CB-STS-06, STS-02 or STS-11.

Determine actual evidence availability and findings from the current ACC and operational records.

### Asset selection

When the user clicks an asset row:

- Focus the Cesium camera on that asset.
- Highlight the selected asset.
- Open the individual maintenance assessment.
- Preserve the original multi-asset result.
- Provide a Back to Results action.

Do not create another overlapping popup.

Use the existing Ask the Twin response area and asset inspector.

### Multi-asset actions

Provide:

- Show all on map.
- Generate maintenance report.

For large collections, show a limited number of rows initially.

Support pagination, search or expandable results using existing components.

Do not render hundreds of detailed asset cards simultaneously.

---

## 13. Evidence and source attribution

Every factual inspection finding must be traceable to an actual source.

Store source references containing:

- ACC document identifier.
- ACC document version.
- Filename.
- Asset identifier.
- Inspection date.
- Page number, where available.
- Relevant section.
- Supporting extracted evidence.
- Document retrieval timestamp.

Do not generate source references using guessed filenames or page numbers.

Use the existing ACC preview, download and Open in ACC functionality.

Group repeated references to avoid clutter.

For example, several findings from the same inspection page may share a compact source reference.

Allow users to expand individual findings to inspect the supporting evidence.

Distinguish evidence provenance:

- Operational record.
- ACC inspection document.
- Technical specification.
- Maintenance record.
- Electrical connectivity model.
- Derived engineering consideration.
- Simulated result.

Preserve the existing illustrative demo-data disclaimer.

Use a compact visible disclaimer rather than repeating a large warning under every finding.

---

## 14. Handle missing or insufficient evidence

This is mandatory.

If an asset is degraded but has no linked inspection or maintenance documents, do not invent a reason.

Correct response:

"TX-M2 is currently reported as degraded, but the available records do not establish the cause. No supporting inspection or maintenance findings were found."

If documents exist but do not explain the current degradation:

"The inspection reports identify the following historical defects. However, the available evidence does not establish whether these defects are responsible for the current degraded status."

If ACC retrieval fails:

"I identified the degraded assets, but some linked inspection documents could not be retrieved. The maintenance assessment is incomplete."

Distinguish:

- No linked documents.
- Documents exist but could not be retrieved.
- Documents retrieved but could not be parsed.
- Documents contain no relevant findings.
- Findings exist but are historical.
- Current cause is not established.
- Documented corrective actions exist.
- Closure evidence is unavailable.
- Verified repair completion exists.

Do not interpret missing closure evidence as proof that a repair was never completed.

Do not interpret missing inspection history as proof that an asset is overdue for inspection.

Do not interpret degraded operational status as proof that replacement is necessary.

---

## 15. Historical condition and recurring defects

Support questions such as:

- Is this transformer getting worse?
- Has this problem occurred before?
- When was this defect first reported?
- What changed since the previous inspection?
- Which issues have become more serious?
- Which actions are still outstanding?

Use existing inspection comparison functionality.

Identify:

- First documented occurrence.
- Latest documented occurrence.
- Changes in severity.
- Changes in condition rating.
- Repeated findings.
- Newly documented findings.
- Verified closure.
- Unknown closure status.

Do not infer that an asset has been continuously degraded between two inspections.

Historical inspection condition is not equivalent to historical operational status.

For example:

"Since when has TX-M2 been degraded?"

Use historical operational status records if available.

If unavailable, explain:

"The latest inspection recorded Poor condition on 28 October 2026, but the available operational records do not establish when the degraded status began."

Do not use the inspection date as an invented operational degradation start date.

---

## 16. Operating restrictions and maintenance safety

Support questions such as:

- Can we continue operating this transformer?
- Are there any operating restrictions?
- Does it need immediate replacement?
- Can maintenance be deferred?
- Can the asset remain in service?

Retrieve documented operating restrictions from the relevant inspection reports.

Clearly distinguish:

- What the report recommends.
- Whether the restriction is still applicable or its applicability is unknown.
- What has been verified operationally.
- What requires engineering approval.

Do not issue a definitive safety clearance.

Do not declare equipment safe to operate based only on its energized status.

Do not convert a condition rating into an automatic shutdown instruction.

Do not provide an approved switching or isolation procedure based solely on the IFC connectivity model.

The application is a decision-support tool, not an authorized electrical control system.

---

## 17. Integrate with electrical network intelligence

Maintenance investigations must support natural follow-up questions.

Example:

"What happens if TX-M2 is taken out of service to fix these issues?"

Reuse the existing outage simulation engine.

Resolve the referenced asset from conversation context.

Evaluate the full relevant electrical network.

If an area is selected, partition affected consumers into:

- Inside selected area.
- Outside selected area.
- Unknown geographical location.

Display:

- Total affected consumers.
- Affected consumers inside the area.
- Affected consumers outside the area.
- Modeled alternate supply availability.
- Capacity constraints, where supported.
- Relevant limitations.

Do not restrict electrical graph traversal to the geographical selection.

Do not infer connectivity from geographical proximity.

Do not present a modeled alternate route as a verified, safe switching plan.

Do not automatically reset an active simulation to answer another question.

If baseline topology is required, evaluate it separately and label the analysis clearly.

Preserve the existing outage simulation state unless the user explicitly resets it.

Use the existing Outage Simulation panel instead of duplicating the entire simulation inside Ask the Twin.

---

## 18. Replacement assessment integration

For questions such as:

"What needs to be done before replacing TX-M2?"

Reuse existing document intelligence and electrical network services.

Retrieve:

- Latest documented condition.
- Inspection history.
- Outstanding findings.
- Technical specifications.
- Missing replacement-critical specifications.
- Relevant physical dimensions.
- Documented operating restrictions.
- Electrical supply dependencies.
- Potential outage impact.
- Modeled alternate supply options.

Do not automatically include a full replacement assessment in every maintenance response.

Only execute replacement-specific analysis when the question requires it.

Do not introduce a separate mandatory Replacement tab solely for this implementation.

Use progressive disclosure and existing detailed document intelligence components.

---

## 19. Map visualization

All asset-related maintenance investigations should support visual interaction with Cesium.

### Single asset

- Focus the camera on the relevant asset.
- Use the existing cyan locator beam, ring and pulse.
- Display a readable asset label.
- Preserve the actual amber degraded or red no-power indicator.
- Keep the selected geographical boundary visible.

### Multiple assets

- Highlight all matching assets.
- Frame the camera around the matching collection.
- Use existing decluttering and clustering rules.
- Avoid excessive beams for large collections.
- Preserve operational status indicators.
- Allow individual asset focus.

### Context preservation

Do not clear the selected area when highlighting an asset.

Do not clear unrelated operational overlays.

Do not confuse selection highlighting with electrical status.

Do not automatically highlight the entire network for a maintenance investigation.

Only show electrical paths when requested or directly relevant.

Use existing map action contracts and validate every referenced asset ID.

---

## 20. Report generation from maintenance investigations

Support questions such as:

- Prepare a report of these defects.
- Generate a maintenance report.
- Prepare a report of all degraded assets in this area.
- Create an Excel register of outstanding corrective actions.
- Generate a report of these inspection findings.

Reuse the existing PDF and Excel generation pipeline.

The generated report must use the actual maintenance investigation result.

Do not generate a generic asset inventory when the user requests corrective actions.

### PDF report content

Include:

- Report title.
- Project name.
- IFC version.
- Selected area or asset scope.
- Report generation date.
- Operational status timestamp.
- Executive summary.
- Matching assets.
- Relevant asset locations.
- Selected area map, where applicable.
- Latest inspection condition.
- Historical condition trends.
- Documented defects.
- Documented corrective actions.
- Additional engineering investigations.
- Outstanding actions.
- Closure evidence.
- Operating restrictions.
- Source references.
- Data completeness.
- Limitations and assumptions.
- Illustrative demo-data disclaimer.

### Excel maintenance register

Include appropriate columns such as:

- Asset ID.
- Asset type.
- Asset name.
- Location.
- Operational status.
- Latest inspection date.
- Latest condition rating.
- Finding.
- Documented severity.
- First reported date.
- Latest reported date.
- Recurring or new finding.
- Documented corrective action.
- Additional investigation required.
- Closure status.
- Source document.
- Source page.
- Evidence availability.
- Notes.

Use separate worksheets where necessary for asset summaries, findings, corrective actions and sources.

Avoid duplicate rows and misleading counts.

Generate meaningful filenames.

Example:

Seagirt_Selected_Area_Maintenance_Report.pdf

Seagirt_Corrective_Action_Register.xlsx

Store an immutable snapshot of the investigation context with the generated artifacts.

---

## 21. Email drafting and Gmail integration

Support follow-up questions such as:

- Draft an email to the maintenance team.
- Send these findings to the electrical maintenance team.
- Prepare an email with the maintenance report attached.

Reuse the existing email composer and Gmail OAuth integration.

The email should summarize:

- Investigation scope.
- Identified assets.
- Main documented findings.
- Requested review or follow-up.
- Relevant limitations.
- Attached PDF and Excel files.

Do not repeat the entire report in the email body.

Use the existing redesigned email composer in both default and expanded Ask the Twin modes.

Preserve:

- Draft text.
- Recipients.
- CC/BCC.
- Generated attachments.
- Gmail connection state.
- Selected geographical area.
- Investigation context.

Never automatically send an email.

Require explicit user review and confirmation.

Do not invent recipient email addresses.

Preserve illustrative-data warnings and existing approved test-recipient restrictions.

Do not send real emails during automated tests.

---

## 22. Structured maintenance response contract

Introduce or extend a structured response type such as:

```json
{
  "responseType": "MAINTENANCE_ASSESSMENT",
  "scope": {
    "type": "SELECTED_AREA",
    "selectionId": "selection-id",
    "ifcVersionId": "version-id"
  },
  "summary": {
    "matchingAssets": 0,
    "assetsWithDocumentedFindings": 0,
    "assetsWithoutDocumentedFindings": 0,
    "assetsWithVerifiedDegradationCause": 0,
    "assetsWithUnknownDegradationCause": 0,
    "partialEvidence": false
  },
  "assets": [
    {
      "assetId": "resolved-asset-id",
      "assetType": "resolved-asset-type",
      "operationalStatus": "DEGRADED",
      "powerState": "POWERED",
      "latestInspection": null,
      "conditionTrend": [],
      "findings": [],
      "documentedCorrectiveActions": [],
      "additionalInvestigations": [],
      "operatingRestrictions": [],
      "closureEvidence": [],
      "degradationCause": {
        "status": "NOT_ESTABLISHED",
        "sourceRefs": []
      },
      "evidenceAvailability": "AVAILABLE",
      "sourceRefs": [],
      "limitations": []
    }
  ],
  "mapActions": [],
  "availableActions": [],
  "suggestedQuestions": [],
  "limitations": []
}
```

This is a suggested contract, not a requirement to duplicate existing schemas.

Adapt and extend the existing structured response architecture.

Use a common maintenance assessment contract for both single-asset and multi-asset results.

The frontend should select the appropriate presentation based on the number of matching assets.

---

## 23. UI and UX design requirements

Maintain the existing Seagirt design language.

Use:

- Dark navy backgrounds.
- Subtle blue borders.
- Cyan interactive accents.
- Purple AI icon.
- Clear white primary typography.
- Muted secondary typography.
- Amber degraded indicators.
- Red no-power indicators.
- Green energized indicators.

Avoid:

- Long text-heavy responses.
- Repeated summaries.
- Excessive badges.
- Multiple warning boxes.
- Full inspection reports inside chat.
- Repeated source chips.
- Large empty spaces.
- Nested scrollbars.
- Unnecessary tabs.
- Duplicate asset inspectors.
- Multiple overlapping popups.

Use progressive disclosure.

The initial response should answer the question immediately.

Supporting details should be accessible without overwhelming the user.

Keep the conversation input anchored at the bottom.

Use one primary vertical scroll container.

Do not hide overflowing content merely to remove scrollbars.

Use accessible keyboard navigation and focus management.

Support the existing light theme if available.

---

## 24. Default and expanded Ask the Twin modes

The entire implementation must work in both existing width modes.

### Default-width mode

- Compact selected area context.
- Single-column asset cards.
- Compact condition trend.
- Three to five visible findings.
- Stacked action buttons where necessary.
- Expandable source references.
- Compact multi-asset rows.

### Expanded-width mode

- Wider summary cards.
- Horizontal metrics.
- More readable condition trend.
- Wider finding descriptions.
- Optional structured maintenance tables.
- Side-by-side actions where space permits.
- Existing expanded report and email layouts.

Use responsive container-based layouts.

Do not create two separate implementations with duplicated business logic.

Switching width must preserve:

- Conversation.
- Selected geographical area.
- Current investigation.
- Expanded findings.
- Selected asset.
- Scroll context where practical.
- Map highlights.
- Simulation state.
- Generated reports.
- Email draft.
- Gmail connection.

Do not automatically expand the panel when a maintenance question is asked.

---

## 25. Performance and loading states

Document intelligence may require multiple ACC requests.

Display meaningful progress for longer investigations.

Example:

"Identifying degraded assets..."

"Retrieving linked inspection records..."

"Analysing inspection findings..."

"Preparing maintenance assessment..."

Do not expose internal chain-of-thought or hidden reasoning.

Only display factual execution progress.

Use:

- Controlled concurrency.
- Document extraction caching.
- Version-aware cache keys.
- Request cancellation.
- Timeouts.
- Retry handling.
- Partial-result support.
- Stale response protection.

Do not repeatedly download unchanged ACC documents.

Do not associate a completed investigation with a newer geographical selection.

Snapshot the active scope at the beginning of execution.

Preserve operational status timestamps.

---

## 26. Mandatory question and response validation

Test all the following questions.

### Operational status

"Which assets are degraded in this area?"

Expected: Matching degraded asset collection.

### Corrective actions

"For degraded asset, what needs to be fixed?"

Expected: Document-backed maintenance assessment, not a status summary.

### Follow-up corrective actions

"What needs to be fixed?"

Expected: Resolve the previously identified asset or asset collection.

### Diagnosis

"Why is this asset degraded?"

Expected: Verified cause if available; otherwise documented findings with an explicit causal limitation.

### Historical status

"Since when has this asset been degraded?"

Expected: Historical operational evidence or a clear statement that the start date cannot be established.

### Condition trend

"Is its condition getting worse?"

Expected: Historical inspection comparison.

### Recurring defects

"Has this issue occurred before?"

Expected: Relevant historical findings and source references.

### Outstanding actions

"Which repairs are still outstanding?"

Expected: Documented actions and closure evidence, with unknown closure clearly distinguished.

### Operating restrictions

"Can we continue operating this asset?"

Expected: Documented restrictions and engineering-review limitations.

### Outage impact

"What happens if we shut it down?"

Expected: Existing outage simulation using the resolved asset.

### Alternate supply

"Is there an alternate supply?"

Expected: Modeled redundancy assessment with capacity and engineering limitations.

### Replacement

"What needs to be done before replacement?"

Expected: Replacement-specific document and network assessment.

### Report

"Prepare a report of these issues."

Expected: PDF and Excel maintenance artifacts based on the current investigation.

### Email

"Inform the maintenance team."

Expected: Reviewable email draft based on the current investigation.

### Scope override

"Show what needs to be fixed for all degraded assets across Seagirt."

Expected: Full-terminal investigation, without silently clearing the selected geographical area.

### Generic asset support

Repeat relevant investigations for:

- Transformers.
- Circuit breakers.
- Cranes.
- Lighting circuits.
- Switchgear.
- Substations.
- Feeders.
- Other supported asset categories.

Do not limit the implementation to transformer maintenance.

---

## 27. Automated testing

Add unit tests covering:

- Semantic intent resolution.
- Intent priority.
- Status keywords inside maintenance questions.
- Multi-intent investigation planning.
- Spatial scope resolution.
- Previous asset collection resolution.
- Follow-up pronoun resolution.
- Ambiguous asset references.
- Multiple tool execution.
- Dependent tool execution.
- ACC document retrieval.
- Inspection finding extraction.
- Corrective action extraction.
- Historical condition comparison.
- Recurring defect detection.
- Closure evidence handling.
- Missing document handling.
- Failed document retrieval.
- Unsupported causal claims.
- Historical condition versus operational status.
- Source reference validation.
- Single-asset response contracts.
- Multi-asset response contracts.
- Summary count consistency.
- Report generation from investigation results.
- Email draft generation.
- Stale asynchronous response prevention.

Add browser tests covering:

- Select an area.
- Ask for degraded assets.
- Ask what needs to be fixed.
- Verify document intelligence executes.
- Verify single-asset maintenance assessment.
- Verify multi-asset maintenance assessment.
- Open a finding source.
- Preview an ACC inspection report.
- Highlight an individual asset.
- Highlight all matching assets.
- Return to multi-asset results.
- Expand and restore Ask the Twin width.
- Preserve selected area context.
- Execute a follow-up outage simulation.
- Generate actual PDF and Excel artifacts.
- Open the existing email composer.
- Preserve the draft during Gmail authentication.
- Clear the selected area.
- Ask a full-terminal maintenance question.

Run existing Seagirt regression tests.

Run relevant ACS and I-595 regression tests if shared components are modified.

Do not modify unrelated applications.

---

## 28. Mandatory end-to-end demonstration

Using actual available Seagirt IFC and ACC data, demonstrate the following workflow.

### Scenario A — Single degraded asset

1. Select an area containing TX-M2 or another actual degraded asset.
2. Ask: "Which assets are degraded in this area?"
3. Verify the correct operational status response.
4. Ask: "What needs to be fixed?"
5. Verify the system resolves the previous asset.
6. Verify linked ACC documents are retrieved.
7. Display the single-asset maintenance assessment.
8. Display actual historical condition ratings, if available.
9. Display documented defects and corrective actions.
10. Open a source document.
11. Highlight the asset on the map.
12. Ask: "Has this issue occurred before?"
13. Verify historical inspection comparison.
14. Ask: "What happens if we shut it down?"
15. Verify existing outage simulation.
16. Generate a maintenance report.
17. Draft an email to the maintenance team.

### Scenario B — Multiple degraded assets

1. Select a larger area containing multiple degraded assets, or use the full-terminal scope.
2. Ask: "For all degraded assets, what needs to be fixed?"
3. Identify actual matching assets.
4. Retrieve available ACC records.
5. Display the multi-asset maintenance assessment.
6. Distinguish assets with documented findings from assets without findings.
7. Distinguish verified causes from unknown causes.
8. Select an individual asset.
9. Display its detailed maintenance assessment.
10. Return to the multi-asset results.
11. Highlight all matching assets.
12. Generate a combined PDF report and Excel register.
13. Draft an email with both files attached.

### Scenario C — Missing evidence

1. Identify an actual asset with insufficient maintenance evidence.
2. Ask what needs to be fixed.
3. Verify the system does not invent defects.
4. Verify it clearly explains the evidence limitation.
5. Verify appropriate investigation follow-up actions are offered.

### Scenario D — Scope and UI preservation

1. Select an area.
2. Execute a maintenance investigation.
3. Expand Ask the Twin.
4. Restore its original width.
5. Open an asset inspector.
6. Verify the geographical boundary remains visible.
7. Ask a full-terminal question.
8. Verify the scope override.
9. Clear the area.
10. Verify subsequent questions use the appropriate scope.

---

## 29. Implementation sequence

Implement in controlled phases.

### Phase 1 — Root cause and intelligence foundation

- Audit existing intent routing.
- Confirm root cause.
- Separate intent, asset target and geographical scope.
- Implement structured context resolution.
- Introduce multi-tool orchestration.
- Fix premature status-only responses.

### Phase 2 — Maintenance intelligence

- ACC document retrieval.
- Inspection analysis.
- Corrective action extraction.
- Evidence quality assessment.
- Historical condition trends.
- Missing evidence handling.
- Single-asset maintenance assessment.

### Phase 3 — Multi-asset intelligence and UI

- Multi-asset maintenance investigations.
- Compact collection response.
- Individual asset drill-down.
- Back to Results.
- Map visualization.
- Default and expanded panel modes.

### Phase 4 — Follow-up workflows

- Historical defect investigation.
- Operating restrictions.
- Electrical dependencies.
- Outage simulation.
- Replacement assessment.
- PDF and Excel generation.
- Email drafting and Gmail integration.

### Phase 5 — Validation

- Automated unit tests.
- Browser tests.
- Actual IFC and ACC verification.
- Regression tests.
- UI refinement.
- Screenshot delivery.

Complete and validate each phase before proceeding.

Reuse existing capabilities rather than rebuilding them.

---

## 30. Final deliverables

After implementation, provide:

1. Confirmed root cause of the original incorrect response.
2. Previous versus new intent routing architecture.
3. New investigation orchestration architecture.
4. Existing services reused.
5. New components introduced.
6. Files modified.
7. Structured response contracts.
8. Context resolution methodology.
9. Evidence validation methodology.
10. Single-asset maintenance assessment screenshots.
11. Multi-asset maintenance assessment screenshots.
12. Default-width Ask the Twin screenshots.
13. Expanded-width Ask the Twin screenshots.
14. Source document preview screenshots.
15. Map highlighting screenshots.
16. Maintenance report and Excel register examples.
17. Email composer screenshot.
18. Automated test results.
19. Browser test results.
20. Existing regression test results.
21. Known limitations and incomplete data sources.

Use actual available data for final implementation screenshots.

Do not present illustrative mockups as completed functionality.

---

## 31. Critical constraints

- Do not hardcode TX-M2 or any other asset.
- Do not hardcode asset counts.
- Do not implement a one-off fix for the exact question.
- Do not allow status keywords to override semantic intent.
- Do not treat selected area as an intent.
- Do not stop execution after a preliminary asset status query.
- Do not invent defects or maintenance actions.
- Do not invent ACC documents or source references.
- Do not claim that historical findings establish current degradation causes without evidence.
- Do not treat unknown repair closure as confirmed outstanding work.
- Do not confuse inspection condition with operational status.
- Do not confuse energized status with safe operating condition.
- Do not fabricate electrical connectivity.
- Do not restrict electrical graph traversal to the selected geographical area.
- Do not present modeled alternate supply as an approved switching plan.
- Do not automatically execute electrical switching.
- Do not automatically send emails.
- Do not introduce duplicate electrical, document or reporting engines.
- Do not create unnecessary application screens.
- Do not break existing Ask the Twin functionality.
- Do not break default or expanded width modes.
- Do not break spatial area selection.
- Do not break IFC version comparison.
- Do not break existing outage simulation.
- Do not break ACS, I-595 or PortMiami functionality.

The final objective is to make Ask the Twin capable of understanding what the user actually wants to know, investigating the relevant evidence across multiple systems, and presenting concise, actionable and trustworthy electrical infrastructure intelligence.

The user should be able to progress naturally from:

Which asset has a problem?

↓

What is wrong with it?

↓

What needs to be fixed or investigated?

↓

Has this happened before?

↓

What happens if we take it out of service?

↓

Prepare a report.

↓

Inform the maintenance team.

All of this should happen within the existing Ask the Twin experience, with continuous conversational and spatial context.
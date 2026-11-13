# API integration readiness — Construction Integration Demo

**What this document is.** An assessment of what would be needed to replace each mock adapter with
a real client, written from the code that exists. **No external system was contacted** while
writing it, and nothing here is a confirmed vendor capability.

**How to read the classifications.**

| Class | Meaning |
|---|---|
| **Implemented in mock** | The behaviour exists in this application against synthetic data. It tells you what the integration *needs*, not that the vendor offers it. |
| **Documented but not connected** | The operation is specified by the proposal or by this build, and no client has been written. |
| **Requires verification** | We believe a capability exists but have not seen it in this tenancy, or the shape is unknown. |
| **Blocked by missing access** | Cannot proceed without credentials, an endpoint or a licence we do not have. |

**No endpoint path, authentication scheme, scope name or licence entitlement is stated anywhere in
this document.** Where one would go, the text says what must be obtained and from whom. Inventing
them would make an unverified assumption look like a finding.

---

## What is replaceable without touching the UI

The adapters are the seam, and they are narrow on purpose.

```
inbound   { system, interfaceId, direction, origin, describe(), fetch() -> batch[] }
          batch = { entity, records[{ source_id, source_rev, ...fields }] }

outbound  { system, interfaceId, direction, approver, writeBack, describe(), post() }
          posting runs through destinations.mjs, never through an adapter
```

Everything above the adapter — the mapping layer, the eleven validation rules, exceptions,
reconciliation, progress, approvals, the write-back gate and all six workspaces — reads the
normalized tables and knows nothing about P6, ACC or SAP. **Replacing an adapter is a change to
one file.** What it must preserve:

- a stable `source_id` per record, which is the key every mapping, observation and proposal hangs
  off;
- a `source_rev` that changes when the record changes, which is what the conflict check compares;
- `entity` names that match the normalized tables (`wbs`, `activity`, `model_version`, `element`,
  `boq_item`, `cost`).

If a real system gives no stable identifier or no revision, that is a design problem to solve
before any code is written — not something an adapter can paper over.

---

## 1. Bentley SYNCHRO 4D

**Mock implemented:** none. SYNCHRO is the *target* in this build — the normalized SQLite tables
stand in for what SYNCHRO 4D would hold, and the 3D viewer is Cesium drawing those records, not
SYNCHRO.

| Operation | Class | Note |
|---|---|---|
| Read the 4D project, its tasks and its resources | Requires verification | Whether the Bentley API exposes the 4D model, and in what shape, is the first question for the product specialist. |
| Write element→task links | Documented but not connected | The proposal says SYNCHRO holds the links; this build holds them in `mapping`. Which system owns them is a decision, not a detail. |
| Read captured field progress | Documented but not connected | `progress_observation` stands in. Whether SYNCHRO captures progress or receives it needs confirming. |
| Native connector vs custom API | **Blocked by missing access** | The proposal's own first discovery item. We cannot assess a connector we have not been shown. |

**Maps to:** `activity`, `element`, `mapping`, `progress_observation`.
**Open questions:** Does SYNCHRO 4D own the element-to-activity mapping, or does the integration
layer? If SYNCHRO owns it, `mapping` becomes a cache and the approval workflow moves. Which native
connectors exist, and what do they cover? Is there an API environment we can be given?

---

## 2. Oracle Primavera P6 — INT-01 inbound, INT-02 outbound

**Mock implemented:** `createMockP6Adapter` reads `src_p6_wbs` and `src_p6_activity`; `mockP6`
writes four columns and bumps a revision.

| Operation | Class | Note |
|---|---|---|
| Read WBS | Implemented in mock | 21 nodes with parent and level. |
| Read activities with dates, baseline, calendar, % complete, remaining duration, data date | Implemented in mock | 150 rows. The baseline travels in its own columns and is never overwritten. |
| Read activity codes, relationships, UDFs | **Documented but not connected** | The proposal lists them; this build does not model them. |
| Write % complete, remaining duration, actual start/finish | Implemented in mock | The four permitted fields, enforced in `PERMITTED_FIELDS`. |
| Detect that a record changed since we read it | Implemented in mock | `rev` + a field digest. **Requires verification**: whether P6 exposes a usable row version, or whether we must compare fields. |
| Write agreed quantities and UDFs | Documented but not connected | In the proposal's INT-02 scope, not built. |

**Authentication to verify:** deployment type first — P6 EPPM versus P6 Professional changes what
exists. We have not been told which. A least-privilege service account is listed in the proposal's
own assumptions and has not been issued.

**Permissions and licensing:** **Blocked by missing access.** Whether the API is licensed in this
tenancy, and whether a service account may write progress to a live schedule, are both for ANDPL
and Oracle. Do not assume.

**Error and retry:** the gate already models it — an attempt row is written before the call and
closed with the answer; a failure is retryable, an acknowledgment is final, and a changed source
holds the write. What is unknown is whether P6 writes are idempotent on retry. **Requires
verification** — if they are not, the idempotency key must become a token the destination honours.

**Maps to:** `wbs(P6)`, `activity`, `outbound_proposal`, `outbound_attempt`.

---

## 3. Autodesk ACC / Revit — INT-03 inbound only

**Mock implemented:** `createMockAccAdapter` returns published model versions and, per element,
the newest published version that still contains it.

| Operation | Class | Note |
|---|---|---|
| List model versions and their information state | Implemented in mock | Only `PUBLISHED` syncs — ISO 19650. |
| Read element ids and agreed properties (level, zone, discipline, work package) | Implemented in mock | 500 elements. |
| Read element quantities | Implemented in mock | **Requires verification**: whether quantities come from the model, a schedule or a takeoff is a real question, and the answer changes the BOQ comparison. |
| Read geometry | **Documented but not connected** | The viewer uses synthetic boxes from `element_geometry`. Real geometry means a translated derivative, which is a different piece of work. |
| Write anything | **Not applicable — forbidden** | The proposal is explicit: no writes to ACC or Revit. The adapter has no `post`. |

**Authentication to verify:** ACC is a per-account, per-project authorisation model; which account
owns the project and who can grant access is unknown to us.

**Licensing:** **Blocked by missing access.** Which ACC modules ANDPL holds is an assumption in the
proposal, not a fact we have.

**Maps to:** `model_version`, `element`, `element_geometry`.
**Open questions:** does an element id survive a model revision? This build assumes yes and flags
elements dropped by a newer version (rule R10). If ids are regenerated, the mapping layer needs a
different key and R10 becomes meaningless.

---

## 4. SAP — INT-04 inbound, INT-05 outbound

**Mock implemented:** `createMockSapAdapter` reads WBS, cost and BOQ; `mockSap` writes earned
value to its own table.

| Operation | Class | Note |
|---|---|---|
| Read WBS elements | Implemented in mock | 22 nodes, one with no P6 counterpart (rule R04). |
| Read budget, planned and actual cost | Implemented in mock | Read-only. SAP stays the only cost ledger. |
| Read approved BOQ quantities and unit rates | Implemented in mock | 50 items. |
| Write earned value by WBS | Implemented in mock | Its own table so a slip cannot reach a cost ledger. |
| Write a budget, a cost posting, a rate or master data | **Not applicable — forbidden** | Enforced by `PERMITTED_FIELDS['INT-05']`. |
| Post into the SAP quality client | **Blocked by missing access** | The proposal makes this a pilot deliverable. We have no client, no interface and no posting method. |

**Authentication to verify:** SAP release and modules are an assumption in the proposal. Whether
integration is through an API layer, an IDoc/BAPI route or a middleware tier is unknown, and it
changes the adapter completely.

**The posting method is the open question.** The proposal already says Finance must confirm it
during design. Until then, "write earned value to SAP" is a sentence, not a design: it could be a
statistical key figure, a custom field or a document, and each has different permissions and a
different reversal story.

**Maps to:** `wbs(SAP)`, `cost`, `boq_item`, `src_sap_earned_value`.

### 4a. SAP Business Accelerator Hub sandbox — real, and unrelated to INT-04

**Implemented against a live endpoint (Phase 7A).** `createSapSandboxAdapter` performs a real
HTTPS GET to `sandbox.api.sap.com`, authenticated with a server-side `APIKey` header, and parses
the OData v2 `d.results` collection. Verified: HTTP 200, 2 records.

What it proves, exactly: that we can hold an SAP credential server-side, reach an SAP-hosted API
over the network, authenticate, and parse an SAP OData v2 response. That is a real and useful
result, and it is the whole of the result.

What it does **not** prove:

| Claim | Status |
|---|---|
| We can read S/4HANA WBS elements | **No.** The endpoint is SAP SuccessFactors Public Sector Management. `ProjectControllingObject` is a SuccessFactors MDF cost object for attributing HR cost, not a PS WBS element. |
| We can read budget, planned or actual cost | **No.** The entity carries none of these fields. |
| INT-04 is connected to SAP | **No.** INT-04 reads `src_sap_*` and is unchanged. The sandbox adapter has no `interfaceId`, implements no `fetch()`, and is not in the map `runInboundSync` iterates. A browser probe confirms Run Demo Sync issues zero requests to `sap.com`. |
| We have access to a customer SAP system | **No.** This is a public, shared sandbox tenant whose records hold placeholder values (`"string"`). It is not anyone's data. |
| The posting method for earned value is settled | **No.** Unchanged — still Finance's decision. |

**What would still be needed for a real SAP integration:** everything in section 4 above. A
customer or quality-client tenant, its release and module set, a least-privilege service account,
the chosen integration route, and the posting method. A sandbox API key obtained from a public
developer portal grants none of these and implies no licensing entitlement.

**Maps to:** nothing. The sandbox records are displayed in the Integration Overview and are not
written to the database.

---

## 5. OpenProject Cloud — real, and a separate schedule source from P6

**Implemented against a live endpoint (Phase 8A).** `createOpenProjectAdapter` performs real HTTPS
GETs to an OpenProject Cloud instance, authenticated with HTTP Basic (`apikey` + a server-side
token), and parses API v3 HAL+JSON. It reads a project, its work packages across pages, and one
work package with its relations.

This is the first live connection in this build that returns **construction-shaped schedule data**:
activity names, planned dates, a reported percentage complete, work estimates, and a source
revision. That makes it materially more useful than section 4a — and it still answers none of the
questions in sections 1 to 4.

| Operation | Class | Note |
|---|---|---|
| Authenticate and reach the instance | **Connected (real)** | Basic `apikey:<token>`, server-side only. |
| Read project metadata | **Connected (real)** | `/api/v3/projects/:id`. |
| Read work packages, project-scoped, all statuses | **Connected (real)** | `filters=[]` sent explicitly; the default collection is filtered to open statuses. |
| Read one work package with relations | **Connected (real)** | Dependencies from the relations API, or reported as unknown. |
| Detect that a record changed since we read it | **Connected (real)** | `lockVersion` + a field-by-field diff against a stored snapshot. Compared for inequality, never by arithmetic. |
| Read hierarchy | **Connected (real)** | From `_links.parent` only. |
| Read the instance's duration settings | **Connected (real)** | `/api/v3/configuration` returns `durationFormat: "hours_only"`, `hoursPerDay: 8`. That setting is a DISPLAY convention for the scheduling `duration` field and is deliberately **not** applied to work, which is a plain ISO 8601 duration at 24 h/day — confirmed by the instance's own estimate/remaining arithmetic. |
| Write anything | **Not attempted** | No POST, PATCH or DELETE is issued. Out of scope for this phase. |

What it does **not** prove:

| Claim | Status |
|---|---|
| Primavera P6 is connected | **No.** INT-01 and INT-02 read and write `src_p6_*` and are unchanged. The OpenProject adapter has no `interfaceId`, implements no `fetch()`, and is not in the map `runInboundSync` iterates. A test asserts Run Demo Sync issues zero requests to the instance. |
| OpenProject progress has been synchronised into the demo | **No.** Reads land in `live_schedule_*` and nowhere else. Approving the candidate link to `A-1020` unlocks a read-only comparison; a test asserts `/progress/activities` is byte-identical before and after. |
| The two "Cast Level 2 Columns" activities are the same work | **No.** They are separate records with a matching name. The name match is offered as weak evidence and requires a planner's approval before the two may even be compared. |
| This is verified construction progress | **No.** It is a percentage a planner typed, with no quantity, unit, BOQ item or field observation behind it. The demo's own planned-versus-verified distinction applies, and this is the planned side. |
| P6 could be replaced by OpenProject | **Not assessed.** Different product, different scheduling model. Nothing here speaks to ANDPL's P6 estate. |

**What a real P6 integration would still need:** everything in section 2. This connection shows
that the *shape* of the pipeline works end to end against a real scheduling tool — credential held
server-side, paginated read, normalization, change detection, audit, reviewed mapping — which is a
genuine reduction in risk for section 2's unknowns about change detection and field mapping. It
grants no P6 access, licence or deployment detail.

**Maps to:** `live_schedule_snapshot`, `live_schedule_change`, `live_schedule_fetch`,
`live_schedule_link`. None of these is in `ALL_TABLES`, so no OpenProject record reaches the
normalized SYNCHRO layer or the demo's own figures.

See `docs/openproject-integration.md` for the field mapping, duration rules, change-detection rules
and security boundaries.

---

## Summary

| System | Inbound | Outbound | Biggest unknown |
|---|---|---|---|
| SYNCHRO 4D | Requires verification | Requires verification | Native connector coverage, and who owns the mapping |
| Primavera P6 | Implemented in mock | Implemented in mock | Deployment type; whether write is licensed and permitted |
| ACC / Revit | Implemented in mock | Forbidden by design | Element id stability across versions |
| SAP | Implemented in mock | Implemented in mock | The posting method for earned value |
| SAP Business Accelerator Hub sandbox | **Connected (real)** | Not attempted | It is SuccessFactors, not S/4HANA — it answers no question in the row above |
| SAP S/4HANA sandbox (project cost) | **Connected (real)** | Not attempted | RNG002 is professional services, not construction — no quantities, units or BOQ |
| OpenProject Cloud (schedule) | **Connected (real)** | Not attempted | Whether it says anything about ANDPL's P6 estate — it does not |
| OpenProject Cloud, polled every 60 s (Phase 8B) | **Connected (real), unattended** | Not attempted | Whether an automatic read is any more authoritative than a manual one — it is not |

**Three real external reads exist, and none of them feeds a pilot interface.** The SAP Business
Accelerator Hub sandbox (section 4a), the SAP S/4HANA sandbox cost read, and the OpenProject Cloud
schedule read (section 5) are all called live from the backend and displayed read-only. Every
*pilot interface* — INT-01 to INT-05 — still reads or writes only the local SQLite file, every
acknowledgment is simulated, and the application says so on every screen that shows a figure.

Since Phase 8B the OpenProject read also happens **on a timer** (60 s) rather than only on a click.
That changes the freshness of the figure and nothing else about its standing: it is still a
percentage a planner typed, still read-only, still stored only in `live_schedule_*`, and still not
connected to any pilot interface. An unattended reader is not a more authoritative one, and the
worker is single-process — it is not distributed scheduling and makes no claim to be.

No record from any of the three enters the normalized SYNCHRO layer. The two SAP reads store
nothing at all; the OpenProject read stores snapshots and change events in its own
`live_schedule_*` tables, which are excluded from `ALL_TABLES` so they appear in neither the demo's
figures nor its reset. The one place a live value and a synthetic value meet is the OpenProject-to-P6
comparison, which is read-only, gated on a planner's approval, and carries a standing note that the
difference between two sources is not a measurement of the work.

**What we would need before writing a single real client:** the deployment and release details for
each system; least-privilege service accounts in a non-production environment; a statement of which
native SYNCHRO connectors exist and what they cover; and Finance's decision on the SAP posting
method. The first three are already listed as assumptions in the integration proposal and have not
yet been provided.

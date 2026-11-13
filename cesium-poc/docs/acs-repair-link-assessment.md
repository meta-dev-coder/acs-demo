# ACS General Accident and Repair Form — can it be linked to our historical accidents?

A data assessment, not a design. No code was changed and nothing was built.

**Short answer: not to the historical incident register, and the reason is not a missing key — the
two datasets are not about the same events.** The ACS form is real operational data. The register
the application currently reads bears every mark of a generated demo set. There is a real and
useful link available in this file, but it is to the **asset registry**, not to the incidents.

---

## 1. The file

`~/Downloads/ACS - General Accident and Repair Form.csv.xlsx` — despite the name it is an **xlsx**,
not a CSV. One sheet, 58 columns, **43 rows: 1 header and 42 data rows**.

**42 rows are not 42 accidents.** `Task_Number` holds 23 distinct values across the 40 rows that
carry one, because a row is one *form submission stage*, not one task:

| Stage (`Please_select_the_corresponding_section`) | Rows |
|---|---:|
| Section 1: Initial Inspection | 24 |
| Section 2: REPAIR / MAINTENANCE | 17 |
| Section 3: QC/QA | 1 |

Thirteen tasks have more than one row; six of those are one row per distinct stage, the other seven
repeat a stage (two Initial Inspections, three Repairs). **So the grain is ambiguous and ACS has to
confirm it** — it is either "one row per stage" with duplicates to clean, or "one row per site
visit". `Task_Number` and `Task_No.` are the same value wherever both are present (40 of 40), so
they are one field duplicated by the form, not two keys.

### What the columns are

| Group | Columns | State |
|---|---|---|
| Task identity | `Task_Number`, `Task_No.`, `Task_type` (always "Accident"), `Entry_type` | 40/42 have a number |
| When | `Date` (submission timestamp), `Date:` (form date) | both 42/42, **agree on only 23 of 42** |
| Where | `Site_Location:`, `Lane_Direction:`, `SR:_` | free text, 27 distinct values |
| Who | `Employee`, `Inspected_by:` ×2, `ACS_employee_Responding`, `Prepared_by:`, `QC_by:` | names, no ids |
| Who responded | `TMC` 12, `Road_Ranger` 10, `ACS_Maint` 33, `Other` 2 | tick marks |
| External ids | `Police_case_#`, `HSMV_#`, `Event_#:` | **see §2 — sparse** |
| Vehicle/driver | `Officer's_name`, `Driver's_name`, `License_Plate`, `Model_of_Vehicle`, `Insurance_Carrier` | 3–6 real values each |
| Work | `Description_of_work_to_be_performed`, `Repair_by`, `Description_of_items_repair_or_maintained` | 37, 20, 21 of 42 |
| Money | `Total_Cost:_$_`, `3rd_Party_Name/Cost` | **see §2 — effectively absent** |
| Attachments | `Section_1:INSPECTION`, `Section_2:REPAIR` | "N Pictures" — counts only, no files |
| Cost sub-tables | `LABOR`, `EQUIPMENT_`, `MOT`, `MATERIAL_SECTION_2` | **"9 Records", "18 Records", "9 Records" — identical on every row** |

The nine unlabelled `Yes`/`No` column pairs (AA–AJ) are the form's checkbox questions with their
question text lost in export. They are unusable until ACS supplies the form template.

---

## 2. The numbers asked for

| Measure | Value |
|---|---:|
| Total rows | 42 data rows (+1 header) |
| Distinct tasks | **23** |
| Rows with a task number | 40 of 42 (2 rows have none) |
| Duplicate task numbers | **13 tasks appear on more than one row** (1164, 1200, 1206, 1222 ×3 each; 1163, 1182, 1231, 1235, 1248, 1255, 1283, 1319, 1343 ×2) |
| Date range | Feb 2025 – Dec 2025, concentrated Jul–Dec |
| **Geographic coordinates** | **13 rows / 7 tasks** — not a column, embedded in free text inside `Site_Location:` |
| **Event numbers** | **10 rows / 7 tasks** carry a real value; 17 more say "N/A" |
| **Police case numbers** | **8 rows / 7 tasks** real; 20 say "N/A" |
| HSMV numbers | 3 rows / 3 tasks real |
| **Repair costs** | **`Total_Cost:_$_` is empty on all 42 rows.** Only `3rd_Party_Cost` has values — **3 rows** ($2,700.00, $1,162.02, one other) |

Two of these deserve emphasis.

**There is no coordinate column.** Seven tasks happen to have coordinates typed into the location
text — `(26.0861701, -80.2140285)`, `+26.114874,-80.313249` — and sixteen do not, carrying prose
instead: `EB 595 at marina mile`, `T-9`, `Attenuator #1319`, `Turnpike South on ramp to 595 & SR-84`.

**There is no repair cost.** The labour, equipment, MOT and material figures live in form sub-tables
that this export did not flatten — every row shows the same placeholder text. Any cost analysis is
impossible from this file alone.

---

## 3. The DataConnect side

The register the application reads is the `incidentRecord` class: **178 historical records,
2024-05-27 to 2026-04-03**, plus live FL511 events merged separately.

Fields available to match on:

| Field | Coverage | Example |
|---|---|---|
| `code` | 178/178 | `INC-200174` |
| `incident_date` + `incident_time` | 178/178 | `30/03/2026 00:00`, `19:32` |
| `damaged_asset_id` | 178/178, 96 distinct | `S-33015A` |
| `police_report_number` | 88/178 | `PR-779672` |
| `incident_type` | 178/178, 15 distinct | `Vehicle fire` |
| `lane_closure_y_n` / `_duration_hours` | 178 / 177 | `No` / `3.5` |
| `project` | 178/178, **1 distinct** | `2222FL` |
| `root_cause` | **0/178 — empty corpus-wide** | |

**Positions are asset-derived.** A register record has no coordinates of its own; it is plotted at
its `damaged_asset_id`'s position. 178 records resolve to 77 distinct points.

### The finding that decides this assessment

The register is almost certainly **not a record of real I-595 crashes**:

- `code` runs as a dense sequence, `INC-200025` … `INC-200174`.
- `police_report_number` is a uniform synthetic pattern, `PR-` plus six digits, on exactly 88 of 178.
- `project` is the single constant `2222FL`; `notes` has one distinct value across 90 records,
  *"Included in V3 safety analytics enrichment set"*.
- `scenario_name`, `scenario_category` and `location_notes` are populated on exactly 88 records with
  demo-scenario text such as *"Executive"* and *"Assets with repeated spend but persistent…"*.
- `root_cause` is empty on every record.

The ACS file, by contrast, is unmistakably real: named inspectors, FHP and BSO case numbers,
licence plates, insurers, a $2,700 third-party invoice.

**This should be confirmed with ACS or Bentley before it is acted on**, but it explains every
negative result below, and no amount of matching logic can fix it.

---

## 4. Every join, attempted

Not reasoned about — run against the live data.

| Candidate join | Result |
|---|---|
| `Police_case_#` → `police_report_number` | **0 matches.** Formats are from different worlds: `FHP480583`, `CS#25-063057`, `FWC25ON0087447` against `PR-779672`. Not a formatting problem. |
| `Event_#:` → any register or live id | **0 matches.** ACS event numbers are `27390`, `278182`, `278278`, `278360`, `278594`, `278974`. Our live ids are `FL511-917622`, `FL511-876573` — six digits but a different range, and the source system of the ACS number is not stated anywhere in the file. |
| `HSMV_#` → anything | No counterpart field exists on our side. |
| Same calendar day | **3 of 42 rows**, all three pointing at the same record, `INC-200046`. Within the ACS window the register occupies 44 of 334 days, so chance alone predicts **5.5** hits. The observed count is *below* chance — there is no temporal relationship to find. |
| Coordinates → nearest register record | Nearest is **26 m to 395 m away and months apart in time.** Task 1222 (2025-10-26) is closest to `INC-200072` — dated **2026-01-12**, 395 m away. Coincidence, not correspondence. |
| **Coordinates → nearest FDOT asset** | **This one works.** See below. |

### The one real link

The seven tasks with coordinates land essentially *on* assets in the 5,015-row registry:

| Task | ACS date | Nearest asset | Distance | Category |
|---|---|---|---|---|
| 1222 | 2025-10-26 | `S-8A143B` | **1 m** | Drainage |
| 1164 | 2025-12-10 | `ABC255` | **7 m** | Accidents |
| 1163 | 2025-08-10 | `S-8A175A` | **16 m** | Drainage |
| 1231 | 2025-10-28 | `S-8A501` | **16 m** | Drainage |
| 1191 | 2025-12-10 | `11096` | **18 m** | Lighting |

One to eighteen metres is a positive identification, not a proximity guess. **The ACS repair task
links to the asset it repaired.** That is a genuine relationship the application can hold today.

---

## 5. Classification

| Class | Count | What it is |
|---|---:|---|
| **Verified** | **0** | No shared identifier matches any record. Nothing can be called a confirmed link. |
| **Candidate (asset)** | **7 tasks** | Coordinates within 20 m of a registry asset. Strong, and verifiable by asking ACS to confirm the asset id. |
| **Candidate (incident)** | **0** | Deliberately zero. Nearest-in-space-and-time produced 26–395 m gaps across month-wide date differences. Calling those candidates would be inventing a relationship. |
| **Unmatched** | **16 tasks** | No coordinates, no matching identifier — prose locations only. |

Per the brief: nearby records are **not** treated as the same incident. The five rows in the table
above are offered as *asset* candidates, and even they need ACS confirmation.

---

## 6. What we need from ACS

In priority order. The first three are the difference between zero links and a working join.

1. **What system issues `Event_#`?** SunGuide, FL511, the TMC log, something else — and can ACS
   export that number for *every* task rather than 7 of 23? This is the single highest-value ask:
   if it is the TMC's event id, it is a true foreign key and everything else becomes unnecessary.
2. **Is the historical incident register real or generated?** If generated, no link to it exists at
   any price, and we need the real crash source instead — FDOT CARS/S4, or the TMC's own event log
   for the same period.
3. **Latitude and longitude as their own columns, for every task.** Seven of 23 having coordinates
   buried in a text field is the difference between a map layer and a spreadsheet.
4. **The cost sub-tables** — labour, equipment, MOT, material — flattened into the export. They are
   referenced but absent, so no repair cost exists in this file beyond three third-party invoices.
5. **The form template**, so the nine unlabelled Yes/No pairs get their questions back.
6. **The asset id ACS repaired**, if their system holds one. This would convert all seven coordinate
   candidates into verified links and cover the other sixteen tasks as well.
7. **Confirmation of the row grain** — one row per stage, or per visit — and why seven tasks repeat
   a stage.
8. **A larger extract.** 23 tasks over eleven months cannot support any rate, cost or trend claim.

---

## 7. Recommended data model

Deliberately minimal, and shaped so that nothing has to be rebuilt when the identifiers arrive.

**Store the ACS task as its own record. Do not merge it into the incident register, and do not
write a link we cannot evidence.**

```
acsRepairTask
  taskNumber          "1222"            the natural key
  stage               INITIAL_INSPECTION | REPAIR | QC   one row per stage
  formDate            2025-10-26
  submittedAt         2025-10-26T14:31
  siteLocationText    "(26.0861701, -80.2140285)"        verbatim, always kept
  longitude/latitude  parsed from the text, or null
  laneDirection       "EB"
  respondedBy         [TMC, ROAD_RANGER, ACS_MAINT]
  policeCaseNumber    "CS#25-063057" | null
  hsmvNumber          | null
  eventNumber         "278182" | null    ← the future foreign key
  workDescription     …
  thirdPartyCostUSD   2700.00 | null
  sourceRow           the original row, untouched
```

Relationships go in **one separate table**, never as a column on either side:

```
recordLink
  fromType/fromId     acsRepairTask / "1222"
  toType/toId         asset / "S-8A143B"
  basis               COORDINATE_PROXIMITY | EVENT_NUMBER | POLICE_CASE | ASSET_ID | MANUAL
  confidence          VERIFIED | CANDIDATE
  evidence            "1 m from the asset's registered position"
  establishedBy       automatic | <person>
```

Three properties matter more than the shape:

- **A link states its basis and its evidence.** A reader can always see *why* two records are
  joined, and a coordinate-proximity link can never be mistaken for a confirmed one.
- **`VERIFIED` is reserved for a shared identifier.** Proximity never promotes itself with time.
- **It is additive.** When ACS supplies event numbers, new rows appear with
  `basis: EVENT_NUMBER, confidence: VERIFIED` beside the existing ones. Nothing migrates, and the
  weaker link stays visible as the thing the stronger one replaced.

---

## 8. What to say to the client

> "Your repair form is good operational data and it ties cleanly to the asset registry — we can
> show a repair task on the exact drainage structure or attenuator it fixed, to within a metre or
> two. What it does not yet tie to is an accident, because nothing in the form carries an
> identifier that our incident records also carry. The Event number is the field that would fix
> that, and it is filled on seven of twenty-three tasks. Give us that number for every task and
> tell us which system issues it, and the two halves join properly rather than by guesswork."

Do not promise an accident-to-repair link, a repair cost figure, or a cost-per-incident in a demo
built on this file. None of the three is supportable by what it contains.

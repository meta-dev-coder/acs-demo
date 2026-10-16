# I-595 Safety Intelligence — client demo script

A tab-by-tab walkthrough of the Safety Intelligence screen. Figures are the live ones at the time
of writing; check them on the day, because the register and the maintenance classes are read from
DataConnect at load.

---

## Before the client joins

**Open the screen and leave it open.** It takes about 25 seconds to become usable — the asset
registry pages 5,015 rows, and every other class waits for it, because a record's position *is* its
damaged asset's position. Switch to the Safety Intelligence role, wait for the badges, then go back
to whatever you are sharing.

**Do not use free-form chat.** The Anthropic key on the deployed Ask the Twin service is returning
401. The five *suggested* questions on each screen are answered deterministically in the browser and
work regardless; anything else goes to the model and fails.

**Know the two numbers you will be asked about:** 178 incident records, 24 months (2024-05 to
2026-04).

---

## Opening line — 30 seconds

> "This reads the corridor's actual operational records — 178 incidents over 24 months, 5,000
> assets, 854 work orders, 1,548 inspections. The thing I want you to notice is what it *refuses*
> to say. Every number names the records behind it, and where the data cannot support a number, it
> says so instead of estimating."

That framing is the product. Lead with it, and every caveat you hit later reads as rigour rather
than as a gap.

---

## The KPI row

Seven cards across the top. They change with the open tab — that is deliberate, so the header always
answers the same question the panel below it is answering.

Point at **Recorded incidents per 100M VMT — 13.4**.

> "That is a real exposure-adjusted rate, from FDOT's published AADT for each milepost range. But
> the numerator counts *register records*, not reported crashes — so it is a recorded-incident rate,
> and we never compare it with an FDOT crash rate."

---

## Tab 1 — Accidents

**What it shows:** 178 records · 111 with injury or fatality · severity index 1.7 · 145 closed a
lane · 423.5 hours of recorded closure · 19 concentrations · 13.4 per 100M VMT.

**Scroll to “Sections, against the traffic each carries.”** Eight FDOT milepost ranges ranked by
rate, each with its own AADT.

> "Counts alone rank the busiest stretch first every time. Against exposure, a short or quiet
> section with the same count moves up to where it belongs."

**Click a section.** Three things happen at once:

1. The road lights up for **exactly the stretch the findings occupy** — not the whole four-mile
   range. It is derived by projecting the findings onto the section centreline.
2. The KPI row narrows to that section.
3. The right panel opens a cross-domain investigation for it.

**Caveat to say out loud:** positions are asset-derived. A record is plotted at the asset it
damaged, not at a surveyed crash point — so a concentration can be one asset struck repeatedly
rather than a dangerous stretch of road.

---

## Tab 2 — Secondary

**What it shows:** 40 of 178 carry a secondary-collision category · 29 per 100 other records · 31 of
the 40 closed a lane · median closure 2 h.

> "Here is the distinction most tools get wrong. That 40 is a *label somebody assigned to a row*.
> Nothing in the register links a secondary record to the primary that caused it — so we report zero
> *verified* pairs, not as a finding but as a missing field. And the TMC's live risk model is kept
> completely separate: it is a prediction about incidents running now, never added to this count."

Three KPIs are unavailable here — detection and verification time, clearance time, vehicle-hours of
delay. The register holds one incident time and a closure duration, nothing else.

---

## Tab 3 — Assets

**What it shows:** 113 open work orders on safety-relevant assets · 28 past the published target ·
MTTR 10.8 days · 97% repaired within target · 3,435 safety-relevant assets.

Two things worth calling out:

- **"Past target" is measured against FDOT's own published repair time per asset category**, not an
  SLA we invented. Only 159 of 598 work orders are on a category that publishes one; the rest are
  reported by age alone.
- **Two categories publish conflicting targets** (Fence at both 10 and 37 days). Those are treated
  as having no usable target. *"We would rather show nothing than pick one."*

---

## Tab 4 — Hazards

**What it shows:** 170 hazard findings across 36 locations — and five KPIs greyed out.

> "This is the honest one. There is no Road Ranger dataset on this instance, so response times,
> patrol coverage, hazards per patrol-hour and cost per hazard are not shown at all. The TMC's
> patrol module is explicitly simulated and we do not treat simulation as evidence. The tab is
> called Hazards, not Road Rangers, for exactly that reason."

Do not rush past this. Clients respect a stated gap more than a confident number with nothing
behind it.

---

## The map

**Badges count whatever the open tab counts.** Switch tabs and watch the colour and the total
change. The badge total always equals the tab's leading KPI:

| Tab | Badges | Total | Matching KPI |
|---|---|---|---|
| Accidents | 24 | 178 | Incident records |
| Secondary | 17 | 40 | Recorded as secondary |
| Assets | 33 | 113 | Open safety-related defects |
| Hazards | 16 | 170 | Hazard observations |

**Click a count.** The badge disappears — it was the invitation to look, and you have taken it — the
camera frames the place, and every finding inside appears as its own pin.

**Click a pin.** It takes a white ring and halo, and the Simulation Lab opens on that record. The
panels stay scoped to the place you opened, not the whole milepost range.

---

## The priority queue — the strip on the right edge

It starts folded. Click the strip to open it.

**191 findings — 45 to inspect · 5 overdue · 52 to assess · 94 to validate.**

> "Note what it does *not* do: there is no single safety score. The four domains share no unit and
> no validated weighting exists for combining them, so one number would be invented. Each finding
> states the rule that put it there, what it counts, and who should act on it."

The 94 "to validate" are work orders open more than a year.

> "Age alone does not prove the fault is still on the road. Sending a crew on that basis wastes a
> crew, and ignoring it might miss a real one — so it asks to be checked, not fixed."

Filter chips: by domain, by kind of attention, and "two domains" for the 164 findings another domain
also points at within 300 m. *"Two domains agreeing on a location is a reason to inspect it — not
evidence that one caused the other."*

---

## Simulation Lab — the centrepiece

Budget half your time here. Five sub-tabs.

### Overview

The incident's facts, then the calibration line: **"Recorded closure 120 min · modelled reopening
101 min · −19 min (−16%)."** Expand it.

> "We do not close that gap. They are not the same measurement — the recorded duration has no stated
> start or end on the record. If it ends at *first* reopening, the comparable modelled number is 64,
> not 101. We report the difference and say what calibration would actually need."

Also open **Data quality — 13 observed, 5 derived, 2 assumed, 10 unavailable.** It lists the nine
operational inputs the register simply does not hold: detection, dispatch, arrival, tow arrival,
reopening, blocked lane count, measured volume.

### Response Analysis — the money tab

0. **Start at the top, before running anything.** "Top 5 ways to open the lanes sooner" is already
   ranked from the baseline: vehicle removal **−15 min**, more Road Rangers **−11**, more tow trucks
   **−11**, debris clearance **−9**, scene protection **−5**.

   > "Nothing has been run yet. Each row moves one input on its own and re-runs the engine, so this
   > is the shortlist before you spend any time in the tool. They do not add up — two of them often
   > relieve the same gate, which is what the optimisation below is for."

1. **Run the standard response.** Show the 14-stage timeline, parallel stages in teal.
2. **Critical path.**
   > "Reopening is 101 minutes because vehicle removal could not begin until the investigation hold
   > finished at 64 minutes, and removal plus debris then took 37. The next gate in line was ready
   > 25 minutes earlier."
3. **Expand Sensitivity.** Every lever is swept through a range and the engine re-run:
   - Vehicle removal moves reopening up to **50 min**
   - Debris clearance **27 min**, ranger travel **20 min**, detection **13 min**
   - **Tow travel: costs $80, moves reopening zero minutes.**

   > "That is the point of the whole engine. Pre-positioning a tow sounds obviously good. For *this*
   > incident it is money for nothing, because the tow was never the constraint."

4. **Run the optimisation.** 3,456 strategies generated, **2,592 excluded as unavailable** with
   reasons given, 864 ranked. The recommendation states what it would take and splits the benefit by
   who bears it — road users, agency, toll operator.

   **"What the search changed"** is the table to point at — only the inputs it actually moved,
   against the standard response: detection 6→2 min, dispatch 3→1, ranger travel 12→5, tow travel
   22→16, Road Rangers 1→2, partial reopening 15→5, warning activation 10→3.

   > "Seven of the searched inputs moved. Everything else was left exactly where it was, because the
   > search found no reason to touch it — that is as much of the answer as the seven that changed."


### Traffic Impact

Demand 5,346 veh/h · 4 lanes · v/c 0.7 · capacity while blocked 3,268 veh/h.

These are the *inputs*, and they do not change when a scenario is run — the results moved to
Response Analysis beside the response that produced them.

**Hover the queue chart** (on Response Analysis): *"85–90 min · 299 queued · 0 lanes blocked · 633
crossed · 633 capacity."* While a queue exists, crossed always equals capacity — that is what a
bottleneck means. It drops below capacity only in the final bucket, when the queue runs out.

### Patrols

Six simulated Road Rangers, with at least two or three always available. Each one is on the map with
a grey plate above it giving the drive time; the recommended unit's plate is green and reads
**· BEST**.

**SIM-RR-01 out of service · SIM-RR-02 2.7 min · SIM-RR-03 2.2 min · BEST · SIM-RR-04 3.2 min ·
SIM-RR-05 13 min · SIM-RR-06 busy.**

The recommendation line states the pick and the rule behind it:

> "Recommended SIM-RR-03 — on scene in 2.2 min, lanes open at 71 min, $18,121 total modelled cost.
> Lowest total modelled cost, then soonest reopening."

**Point at the comparison table's last column** — what each unit changes against the loaded
scenario: **−5.7k · −5 min** for the two nearest, **−3.5k · −5 min** for the next, and **0k · +1
min** for the far one.

> "Five minutes of lane closure and about six thousand dollars separate the nearest patrol from the
> default response. That is the whole case for pre-positioning — and it is this incident's number,
> not a corridor average."

**Caveat to say out loud, and do not soften it:** the fleet is simulated. These are modelled
positions and modelled drive times, not a dispatch recommendation. Where a patrol actually was, and
how long it actually took, is recorded nowhere in this twin.

### Economics

Three accounts, by who bears them:

- Road-user delay **$37,431**
- Agency response **$728**
- Toll unrecovered **$917**
- **Total modelled cost $39,076**, with a reconciliation line proving it equals its parts.

> "Deferred toll is shown separately and deliberately excluded from the total. A vehicle sitting in
> a queue pays the same toll fifteen minutes later. That is not lost revenue, and adding it would
> overstate the loss by most of its value."

---

## Ask the Twin

Use only the suggested questions. Good one to demo:

**"What if the tow truck arrived 10 minutes earlier?"**

It clones the run under discussion, changes one field, and reports — including, for this incident:

> "No change to clearance. Vehicle removal could not begin until the investigation hold was
> complete."

> "The assistant never calculates. Every figure comes from the same engine the screen is showing."

---

## Closing

> "No crash rate we cannot support. No economic cost we cannot trace to its components. No claim
> that any intervention prevents a specific number of accidents — because no calibrated model exists
> for this corridor. What it does give you is: where to look, what is binding, what would actually
> help, and what it would cost."

---

## If they ask

**"How accurate is the simulation?"**
The response timings are assumptions, and the screen says so on every panel. What is solid is the
*structure* — which lever is binding, and which spend buys nothing. That is arithmetic, not a guess.

**"Why is the lane count an assumption?"**
Nothing in the twin publishes lanes per section. It is the weakest input in the model and the first
thing we would want corrected from your side. Change it in the Traffic Impact tab and everything
downstream recomputes.

**"Can it predict crashes?"**
No, and it says so. That needs crash-modification factors nobody has for this corridor. The exposure
index is ordinal — for ranking scenarios against each other — and is explicitly not a probability.

**"Why do some sections show no rate?"**
Only records within 400 m of a mainline centreline are assigned to a section. Thirteen of 178 sit
further out — a ramp, a frontage road, an asset set back from the road — and are left out of the
rates rather than pulled onto the nearest one.

**"Why is the queue still there after the lanes reopen?"**
Lanes open and traffic normal are different times. Queue dissipation is measured from the last lane
reopening, and for this incident it is 29 minutes after it.

---

## Known limitations to volunteer rather than be caught by

- Positions are asset-derived. 77 distinct positions hold 178 records; the largest stack is 6
  records on one asset.
- Carriageway is never verified — both directions of a milepost range are treated as one section.
- No patrol dataset, no intervention record, no historical toll schedule. The Outcomes tab is
  hidden for that reason: measuring whether an intervention worked needs a record of the
  intervention, so every one of its KPIs was unavailable. If asked whether the twin can show
  before-and-after, say that plainly rather than reaching for the two-window comparison. The Patrols tab's fleet is
  simulated — the same simulated fleet the TMC screen uses — and is labelled as such on the panel.
- Value of time, crew costs, toll rates, peak-hour factor, directional split and lane count are all
  stated assumptions, not measurements of this corridor.
- The objective selector was removed from the optimiser: exposure *is* vehicle-hours queued and both
  follow clearance, so three of the five objectives always returned the same strategy.

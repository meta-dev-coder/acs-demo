# Multi-criteria prioritization of ITS / toll asset maintenance (operations vs. business criteria)

> Research method note (2026-10-12): WebSearch worked, but WebFetch could not reach any primary document in this
> environment (DNS failures on rosap.ntl.bts.gov, fhwa.dot.gov, ops.fhwa.dot.gov, mobilityauthority.com,
> connect.ncdot.gov, libraetd.lib.virginia.edu). Every finding below therefore comes from search-result
> summaries of the cited pages, not from reading the full documents. Specific numeric values (SLA hours, LD
> amounts, matrix scores) should be re-checked against the PDFs before they are quoted in a customer-facing claim.
> 15 tool calls used.

## 1. How DOTs and toll agencies prioritize ITS maintenance (FHWA/TAMP, risk, FDOT, toll SLAs)

### Takeaway
US practice is **risk-based**: FHWA's TAMP rules and guidance tell agencies to rank by likelihood × consequence and
to fund higher-risk assets first. ITS-specific practice reduces this to a risk matrix by device criticality to
traffic operations (TxDOT 0-6773), with safety and traffic-control devices above traveler-information devices (Oregon).
Toll agencies make the priority **contractual**: vendor maintenance agreements set KPIs for availability and response
time per maintenance-event category, enforced by liquidated damages, on the stated basis that the agency's real losses
(revenue) are hard to compute. The FDOT/SunGuide district ITS contracts I found measure **system uptime** (a 95%
benchmark) rather than revenue.

### Cited Findings
**Federal requirement and guidance (these are requirements, plus a recommendation on how to meet them)**
- MAP-21 requires states to develop and implement **risk-based** Transportation Asset Management Plans (TAMPs) for the National Highway System. This is a statutory and regulatory **requirement**. — [Adaptation Clearinghouse: FHWA Risk-Based Asset Management Planning Rule](https://www.adaptationclearinghouse.org/resources/fhwa-s-risk-based-asset-management-planning-rule.html)
- FHWA's 2017 guidance on incorporating risk management into TAMPs says the goal is to acknowledge risks, assess and prioritize them, and allocate resources according to the agency's risk tolerance. It also says a risk-based plan **could let a low-risk asset fall below its target in order to address a higher-risk structure or traffic-control device**, which is explicit permission to trade off across assets by consequence. This is a **recommendation**. — [FHWA, Incorporating Risk Management into TAMPs (2017)](https://www.fhwa.dot.gov/asset/pubs/incorporating_rm.pdf)
- FHWA's Risk-Based Transportation Asset Management series (2013), Report 4, covers "managing risks to critical assets". — [Report 4 listing](https://www.transportationmanagement.net/erm-dev/document/risk-based-transportation-asset-management-managing-risks-to-networks-corridors-and-critical-structures-report-4-managing-risks-to-critical-assets/)
- FHWA material on TSMO / ancillary assets, referencing NCHRP 08-36 Task 114 (TAM for Ancillary Assets), lists asset-level needs: inspection and condition assessment, performance metrics, lifecycle plans, **asset priorities**, and decision support. — [FHWA Office of Operations, FHWA-HOP-20-047 ch.3](https://ops.fhwa.dot.gov/publications/fhwahop20047/chap3.htm)
- NCHRP Report 806 (*Guide to Cross-Asset Resource Allocation*) provides guidance and a spreadsheet tool for data-driven project prioritization, **scenario analysis** and target setting across asset classes. — [TransportationOps summary of NCHRP 806](https://dev.transportationops.org/news/research/guide-cross-asset-resource-allocation-and-impact-transportation-system-performance)
- NCHRP Research Report 1076 (Project 23-08) is a guide to incorporating maintenance costs into a TAMP. — [NCHRP 1076 memo](https://onlinepubs.trb.org/onlinepubs/nchrp/nchrp_rpt_1076Memo.pdf)

**ITS-specific practice**
- TxDOT project 0-6773 (*Warrants and Sunset Requirements for ITS Equipment Installations on Texas Highways*, Texas A&M Transportation Institute, completed August 2013) built a risk-management framework that uses a **risk matrix to group ITS assets into priority categories**, so districts can rank devices by how critical each is to traffic management. It also set sunset criteria for when TxDOT should stop supporting deployed devices. The search summaries do not include the matrix scoring values. — [ROSAP dot/37629](https://rosap.ntl.bts.gov/view/dot/37629); [PDF](https://rosap.ntl.bts.gov/view/dot/37629/dot_37629_DS1.pdf)
- TxDOT's earlier project 0-6390 (*Asset Management for Safety and Operations*) produced a decision screening tool for asset management. — [CTR library 0-6390](https://library.ctr.utexas.edu/hostedPDFs/txdot/psr/6390.pdf)
- Oregon practice, as summarized by the USDOT ITS Knowledge Resources: devices are prioritized by "relative importance to the daily operation or integrity of the system", with **safety-related or traffic-control devices ranked above traveler-information devices**. — [ITS KRS 2006-L00308](https://www.itskrs.its.dot.gov/2006-l00308)
- A University of Virginia thesis, *Prioritizing the Maintenance and Replacement of Aging or Obsolete ITS Infrastructure*, proposes a method meant to be practical and applicable across disparate ITS technologies. It ranks **variable message signs using maintenance work-order history and traffic volume**, i.e. condition/failure history × exposure. — [UVA LibraETD](https://libraetd.lib.virginia.edu/public_view/cj82k742g)

**FDOT / SunGuide (Florida)**
- The FDOT District Four RTMC operations ITN (ITN-DOT-14/15-4019LW, Exhibit A) covers the SunGuide-controlled ITS devices, including DMS and CCTV. The response-time terms were not visible in the search excerpt. — [MyFlorida VBS: Exhibit A scope](https://www.myflorida.com/apps/vbs/adoc/F1636_4EXHIBITASCOPEOFSERVICESV5.pdf)
- TransCore's FDOT District 3 ITS maintenance contract reported **≥99.8% total system uptime against FDOT's 95% benchmark**. The contract metric is uptime, not revenue. — [Traffic Technology Today](https://traffictechnologytoday.com/news/its/transcore-awarded-two-its-maintenance-contracts-in-florida.html)
- FDOT District 6 awarded TransCore a five-year contract to maintain all SunGuide ITS infrastructure in Miami-Dade and Monroe counties. Those terms ran to about June 2022 with renewal options, so they may since have been replaced. — [Traffic Technology Today](https://www.traffictechnologytoday.com/?p=2620)
- FDOT's stated rationale for using an ITS maintenance contractor: it "helps to avoid/minimize system downtime, reduces total cost of operation, improves effectiveness, and extends the life of ITS assets". — [FDOT Monthly ITS News, Feb 2010](https://www.fdot.gov/docs/default-source/traffic/Newsletters/2010/2010-002-Feb.pdf)
- Florida's Turnpike Enterprise (FTE): its TMC monitors nearly 900 CCTV cameras and targets clearing incidents **within 90 minutes**. That is a roadway incident-clearance goal, not an equipment-repair SLA. — [Florida's Turnpike: Traffic Management](https://floridasturnpike.com/traveler-resources/traffic-management/)

**Toll agency maintenance SLAs (contract requirements)**
- Central Texas Regional Mobility Authority (Kapsch restated maintenance agreement, Amendment No. 2, Resolution 22-030, June 29, 2022) revised the KPIs for **system availability and response time per maintenance event category**. The scope covers roadside lane equipment, the host, ITS, wrong-way detection and communications. The original contract was about $30.8M over 67 months, with scope dating from 2007. — [CTRMA Resolution 22-030](https://www.mobilityauthority.com/upload/files/Board_Resolution_Search/2022/June%2029,%202022/Resolution_No._22-030_(Amendment_No.%202%20Kapsch%20Restated%20Agreement%20KPIs).pdf); [CTRMA AIS, Dec 2023](https://mobilityauthority.com/wp-content/uploads/2023/12/12_1_FINAL_AIS_Kapsch_Restated_Maint_Agreement.pdf)
- In December 2023 the CTRMA board considered settling **liquidated damages tied to Kapsch maintenance KPIs**, which shows the KPIs are enforced financially. The settlement figures were not in the excerpt. — [CTRMA AIS Kapsch Settlement](https://mobilityauthority.com/wp-content/uploads/2023/12/13_1_FINAL_AIS_Kapsch_Settlement.pdf)
- The North Carolina Turnpike Authority RTCS RFP sets **repair response time (on site after notification) ≤ 2 hours** for non-routine or emergency repairs, and requires a temporary unit if an item is not working within 24 hours. A 2026 addendum (Monroe Expressway RFP) asks about pre-approved windows for lane-closure preventive maintenance. — [NCTA RTCS RFP Attachment 19](https://connect.ncdot.gov/business/Turnpike/ProcurementsLibrary/RTCS_RFP_Attach19.pdf); [Monroe EXP RFP Addendum 02, 2026-07-28](https://connect.ncdot.gov/business/Turnpike/ProcurementsLibrary/Monroe%20EXP_RFP_Addendum02_2026-07-28.pdf)
- The Richmond Metropolitan Transportation Authority ETC RFP (2021): response and repair SLAs are measured and reported during acceptance testing and monthly thereafter. — [RMTA ETC 2021 Addendum 3](https://www.rmtaonline.org/wp-content/uploads/2021/10/ETC-2021-Addendum-3.pdf)
- RCTC I-15 Express Lanes toll services: the provider pays performance liquidated damages and stipulated damages when KPIs are missed. The recitals say the agencies "would suffer substantial losses" from inadequate O&M. — [RCTC April 2026 TPOC agenda](https://www.rctc.org/wp-content/uploads/2026/04/April-TPOC-Agenda.pdf)
- A TxDOT toll CDA sets liquidated damages because actual losses are "impracticable and extremely difficult to ascertain". This is the standard justification for using a fixed LD as a proxy for revenue loss. — [FHWA P3 toolkit: TxDOT toll application](https://www.fhwa.dot.gov/ipd/p3/toolkit/usdot/sep15/sep15_txtoll/application_17.aspx)
- Academic framing from tolling: system availability covers both the ability to provide all functions and **the revenues those functions generate**. Other KPIs include MTBF, throughput and queue length. — [Kasprzyk, Archives of Transport System Telematics, 2014](https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-fa726ae0-29b8-41eb-8246-f3f39d6f405c/c/ATST2014_1_Kasprzyk.pdf)

### Inferences
- Two regimes exist side by side. (a) **DOT ITS (SunGuide CCTV/DMS)** prioritizes by operational criticality and safety, and contracts measure uptime. (b) **Toll roadside systems (lane controllers, ALPR/image capture, AVI readers)** prioritize through contract event categories, in which revenue risk is implicit: a lane-down or image-capture failure falls in the top category because it loses transactions. The feature can honestly present FIFO/distance as the field crew's default and revenue/transactions as the toll business owner's lens, because both regimes are real.
- "Consequence of failure" in the FHWA risk framing is the natural slot for revenue and transactions. Business criteria do not replace the risk model; they are a further consequence dimension next to safety and mobility.
- Contract SLAs are hard constraints, not weights. A ticket close to breaching a response/repair window (for example NCTA's 2-hour response) should be pinned or flagged regardless of preset, otherwise an executive preset could rank an SLA-breaching ticket low.

### Gaps
- I could not open the actual priority-category tables (event categories, response/repair hours, LD $ amounts) for CTRMA/Kapsch, NCTA, RCTC or RMTA. Only the summaries were visible.
- No FTE, NTTA, E-470 or MDX roadside maintenance SLA document surfaced. Their public procurement libraries would have to be searched directly.
- No FDOT district ITS maintenance contract response-time values (for example "CCTV failure respond within X hours") surfaced. FDOT's ITS maintenance specifications and district contract exhibits are the place to look.
- The TxDOT 0-6773 matrix values, the UVA thesis author/year and its weights were not visible.
- No AASHTO TAM Guide text was retrieved.

## 2. Standard methods: weighted scoring, AHP, TOPSIS, risk matrices, cost of downtime, and FIFO vs. travel-optimized dispatch in FSM tools

### Takeaway
The dominant methods are (1) **risk matrix / likelihood × consequence**, which DOTs use, (2) **weighted-sum scoring**, with weights often derived by **AHP**, and (3) **TOPSIS** for ranking. Studies find AHP and TOPSIS usually agree on the top items but differ in the middle of the list. Commercial EAM/FSM tools follow the same pattern. Maximo computes a configurable **calculated priority** from asset/location priority and work-order priority (for example `PRIORITY + 2*EQPRIORITY`, or a priority matrix), which then sets a respond-by date. Salesforce Field Service separates hard **work rules** (filters) from **weighted service objectives** (for example minimize travel), and scores candidates by a weighted sum.

### Cited Findings
- In maintenance-prioritization literature, TOPSIS, PROMETHEE, ANP and AHP are all used. **AHP is by far the most frequently used**, partly because it derives criteria weights instead of requiring them to be set by hand. — [IGI Global: Using AHP to identify priority equipment for maintenance](https://igi-global.com/article/using-ahp-to-identify-the-priority-equipment-for-maintenance-actions/258561)
- Road damage repair: AHP-TOPSIS and Entropy-TOPSIS produced the **same top-ranked section** but different overall accuracy against PCI (Entropy-TOPSIS 27.5% vs. AHP-TOPSIS 21.25%). — [Jurnal Jalan-Jembatan (Indonesia MPW)](https://binamarga.pu.go.id/jurnal/index.php/jurnaljalanjembatan/article/view/1331)
- Kurukshetra road prioritization: TOPSIS matched the Indian Roads Congress benchmark better than AHP (Spearman 0.78). — [Civil Engineering Infrastructures Journal](https://civiljournal.semnan.ac.ir/article_9114.html)
- Fuzzy AHP and fuzzy TOPSIS gave nearly the same pavement-maintenance ranking (2015). — [Structurae listing](https://structurae.info/fr/litterature/article-de-revue/comparison-of-fuzzy-ahp-and-fuzzy-topsis-for-road-pavement-maintenance-prioritization-methodological-exposition-and-case-study)
- Railway switch maintenance (Istanbul, 2025): AHP for criteria weights, plus TOPSIS and PROMETHEE for ranking. — [Applied Sciences 16(13) 6605](https://www.citedrive.com/en/discovery/a-multi-criteria-decision-framework-for-railway-switch-maintenance-prioritization-in-urban-rail-systems/)
- **IBM Maximo**: the location priority on the work order is combined with the work order's own priority to give `WORKORDER.CALCPRIORITY`, using rules chosen in Assignment Manager > Set Priority Preferences. CALCPRIORITY then determines `RESPONDBY`. — [IBM Support node 881486](https://www.ibm.com/support/pages/node/881486)
- Maximo's priority formula is configurable. An IBM APAR test case uses `PRIORITY + 2 * EQPRIORITY`. — [IBM APAR IZ85044](https://www.ibm.com/support/pages/apar/IZ85044)
- Maximo industry solutions (Oil and Gas) calculate priority with a **priority matrix** that combines reason-for-work with asset/location priority and function. — [IBM Support node 6987735](https://www.ibm.com/support/pages/node/6987735)
- **Salesforce Field Service**: a scheduling policy is made of work rules and service objectives. Work rules are pass/fail (skills, territory, availability). Service objectives are "weighted from most to least important". Each candidate gets a score per objective, the scores are tallied, and the highest total is recommended. Example given: if the top priority is to minimize travel, the nearest qualified technician wins. — [Trailhead: Examine Scheduling Policies](https://trailhead.salesforce.com/content/learn/modules/field-service-lightning-scheduling-basics/examine-scheduling-policies)

### Inferences
- A defensible feature design maps directly onto these precedents:
  - **Hard filters / pins** (the Salesforce "work rules" analog): SLA breach imminent, safety-critical failure, active incident coverage.
  - **Weighted sum over normalized criteria** (the Salesforce "service objectives" / Maximo calculated-priority analog): age in queue (FIFO), travel time from crew, condition/failure severity, safety exposure (AADT, crash history), revenue at risk, transactions affected, customer impact.
  - **Presets** are just weight vectors. "Maintenance crew" weights FIFO and travel heavily; "Executive" weights revenue and transactions.
- FIFO and nearest-site are not opposed to MCDA. FIFO is one criterion (queue age, often with a nonlinear SLA ramp), and travel time is another. Route batching (visiting nearby sites in one trip) is a dispatch optimization layer applied after ranking, and should be described that way rather than mixed into the ranking score.
- Weighted sum is the most explainable option: each criterion's contribution can be shown as a bar. TOPSIS/AHP add rigor but are harder to explain in an assistant. AHP is useful for deriving preset weights offline (pairwise comparisons with stakeholders), not for runtime.
- Revenue enters as **consequence of failure × expected downtime**: revenue-at-risk ≈ (transactions/hour through the affected lane or gantry) × (leakage rate when the device is down, for example the share of unreadable plates without a working ALPR) × (avg toll) × (expected hours until repair). The leakage-rate and average-toll inputs must come from the agency. Per the repo's "state the gap" convention, if they are absent the criterion should show "NA", not be estimated.

### Gaps
- No ServiceNow FSM or Maximo Scheduler optimization docs were retrieved (travel-time optimization, route batching objectives).
- I found no published paper applying AHP/TOPSIS specifically to ITS devices (CCTV/DMS/toll). The closest are pavement, rail-switch and generic equipment studies.
- No published cost-of-downtime figures for ALPR or gantry outages in tolling (for example $ lost per lane-hour) were found.

## 3. Presenting trade-offs to stakeholders, and published revenue-weighted examples

### Takeaway
The MCDA literature supports the core UX idea: **same data, stakeholder-specific weight vectors, plus sensitivity analysis** that varies weights to test whether the ranking is stable. Studies explicitly use stakeholder-weighted criteria and "rank variation" to test robustness. I found **no published example of revenue-weighted maintenance prioritization in tolling or ITS**. The closest real-world evidence is toll vendor contracts, which encode revenue risk indirectly through availability KPIs and liquidated damages.

### Cited Findings
- AHP+TOPSIS infrastructure studies confirm that TOPSIS results are stable by running a sensitivity analysis that changes the relative criteria weights. An FMECA study varied the criteria-weight vector obtained from the group decision process. — [Frontiers in Built Environment 2019](https://www.frontiersin.org/journals/built-environment/articles/10.3389/fbuil.2019.00006/epub); [Reliability Eng. & System Safety v169 (2018)](https://ideas.repec.org/a/eee/reensy/v169y2018icp394-402.html)
- A two-phase AHP-TOPSIS approach is designed to respect the opinions and interests of all stakeholders while the key decision-maker keeps responsibility for the final decision. Another study proposes **rank variation under stakeholder prioritization of criteria** to test robustness. — [MDPI Sustainability 15(20) 14953](https://www.mdpi.com/2071-1050/15/20/14953); [UPV RiuNet](https://riunet.upv.es/handle/10251/121791?show=full)
- NCHRP 806 frames cross-asset allocation around **scenario analysis**, comparing outcomes under different priorities. — [TransportationOps summary](https://dev.transportationops.org/news/research/guide-cross-asset-resource-allocation-and-impact-transportation-system-performance)
- Tolling academic framing ties availability directly to revenue generated. — [Kasprzyk 2014](https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-fa726ae0-29b8-41eb-8246-f3f39d6f405c/c/ATST2014_1_Kasprzyk.pdf)
- Toll contracts justify liquidated damages because real losses are hard to quantify, so revenue risk is priced through fixed LDs rather than computed per event. — [FHWA P3 toolkit TxDOT](https://www.fhwa.dot.gov/ipd/p3/toolkit/usdot/sep15/sep15_txtoll/application_17.aspx); [RCTC TPOC 2026](https://www.rctc.org/wp-content/uploads/2026/04/April-TPOC-Agenda.pdf)

### Inferences
- UX pattern justified by the above:
  1. **Role presets** (Maintenance / Operations-Safety / Executive-Revenue) as named weight vectors, with weights visible and editable.
  2. **Rank-delta view** on switching preset: "Site X moved from #9 to #2 (+7)", plus a per-criterion contribution breakdown explaining why (for example "revenue at risk contributed 41% of score; 2,300 transactions/day through gantry G12").
  3. **Stability / sensitivity indicator**: flag items whose rank changes by more than N positions within ±10–20% weight perturbation, and say plainly "top 3 are the same under all presets" when that is true. That is the literature's robustness check made into a UI feature.
  4. **Constraints shown separately from scores**: SLA-breach and safety pins sit above the weighted list in every preset, so the executive view cannot bury a contractual or safety obligation.
  5. **Data-gap honesty**: if revenue or transaction data is missing for a site, show "NA" and either exclude that criterion for the site (renormalizing weights) or rank it with a visible caveat. Never impute.
- Because no published revenue-weighted tolling prioritization was found, the feature should be described as **applying established MCDA / risk-based TAM practice to toll revenue consequence**, not as replicating a known agency practice.

### Gaps
- No IBTTA material on maintenance prioritization or revenue leakage from roadside equipment failure was retrieved.
- No published case (agency or vendor) of a stakeholder-toggle ranking UI for ITS or toll maintenance was found.
- Rank reversal (AHP/TOPSIS orderings changing when alternatives are added or removed) was not covered by the sources found. It is relevant if TOPSIS is used with a changing ticket queue, and is another reason to prefer weighted sum.

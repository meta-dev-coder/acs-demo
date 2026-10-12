# Toll camera / sensor outages and revenue impact per site: I-595 Express and open-road tolling (US, Florida first)

Research date: 2026-10-12. Method note: the agent proxy blocked direct page fetches for most .gov hosts (fhwa.dot.gov, codot.gov returned CONNECT 403), so the findings below come from search-result extracts of the cited pages rather than full-document reads. Figures quoted are as reported in those extracts; where a figure could not be verified in a second source it is flagged. **[ASSUMPTION]** marks values I made up for a demo, not published values.

## 1. How a gantry collects tolls, and what is lost when a plate camera fails

### Takeaway
An open-road / all-electronic tolling (AET) gantry combines (a) transponder readers (antennas), (b) vehicle detection and classification (laser scanners/loops), and (c) front/rear license-plate cameras with illuminators feeding ALPR/OCR and human image review. When a plate camera fails, transponder transactions keep posting, but every transaction that depends on an image is put at risk: non-transponder (toll-by-plate / violation) trips, transponder trips where the tag misreads, and enforcement evidence. Published "leakage" (unbillable or uncollected) figures vary widely, from about 2-4% of image transactions to more than 10%, depending on definition. One Pennsylvania figure is near 50% of non-E-ZPass trips going unpaid.

### Cited Findings
**Gantry architecture**
- In ETC gantry designs, a transponder-based system may be "augmented with or replaced by" ALPR. Plate cameras capture images that are processed for entry/exit matching and paired with transponder reads to assess tolls — [USPTO patent 10019640, Intelligent ALPR for electronic tolling](https://patents.justia.com/patent/10019640); [US6140941 open-road cashless toll collection using transponders and cameras](https://patents.google.com/patent/US6140941)
- Classification lasers project a "curtain of laser light" that measures approximate vehicle size, which a controller maps to a class (car, motorcycle, semi). Dual fan-beam scanning lasers measure speed, height, length and profile at the toll point — [USPTO 10019640](https://patents.justia.com/patent/10019640); [EP3624067B1 tolling station for vehicles of different classes](https://patents.google.com/patent/EP3624067B1/en)
- Cameras are paired with illuminators that auto-adjust intensity for low light. OCR returns the plate string with per-character confidence. When confidence is insufficient, "a human operator has to look at the pictures", which is the manual image review step. The plate is then matched to registered-owner records — [USPTO 10019640](https://patents.justia.com/patent/10019640); [McGill 407 ETR use-case handout](https://www.cs.mcgill.ca/~joerg/SEL/COMP-533_Handouts_files/407-ETR-uc_em_cm.pdf)
- On Florida express lanes (95 Express, Miami), drivers without a transponder "will have their license plates photographed" and receive an Unpaid Toll Notice. That is the toll plus a **$25.00 daily violation charge**, then a toll enforcement invoice with a **$2.50 administrative fee**, escalating to a Uniform Traffic Citation. Gantry-mounted enforcement beacons alert FHP troopers when a vehicle without a transponder passes — [95 Express Violations & Enforcement](https://95express.com/?p=908)
- For I-4 Express, FDOT clarified that the $25 is per day, not per violation, plus $2.50 per mailing — [ClickOrlando, May 10 2022](https://clickorlando.com/news/local/2022/05/10/new-i-4-express-lanes-bring-in-14-million-in-one-month)
- Florida HSMV acknowledges that the high violation volume "combined with the speed of vehicles passing cameras can lead to inaccurate plate readings", which results in some customers being billed in error. No rate is given — [FLHSMV Toll-by-Plate information](https://www.flhsmv.gov/toll-by-plate-information/)
- SunPass customers save on average about 25% versus Toll-by-Plate rates. This is a secondary site quoting SunPass, so treat it as indicative — [sunpass.it.com](https://www.sunpass.it.com/?p=31)

**Published leakage / loss figures**
- NY MTA TBTA audit: "leakage" or "rejected images" are defined as unbillable transactions, with technical and business reason codes. **340,851 rejected images Jan 2013–Aug 2017, about $2.4M potential lost revenue** — [NY OSC audit 2022-21F15 / TBTA](https://www.osc.ny.gov/files/state-agencies/audits/pdf/sga-2022-21f15.pdf)
- NY Thruway audit (2018): sampled 161 rejected plate images, of which **11% should not have been rejected**. Estimated **$7.2M** in unbilled tolls in one year from rejects that were within the Authority's ability to fix — [NY OSC press release, July 2018](https://www.osc.ny.gov/press/releases/2018/07/dinapoli-state-missing-nearly-24-million-uncollected-tolls)
- E-470 (Colorado) briefing to HPTE, Sept 2015: an illustrative waterfall in which **17% of image transactions are unbillable (leakage)**. The document says this is for illustration only and that rates vary by roadway — [E-470 briefing on License Plate Tolling, CDOT/HPTE 2015-09-16](https://www.codot.gov/programs/ctio/agenda-item-documents/2015-agenda-documents/september-2015-meeting/e470-briefing-on-lpt-to-hpte-bod-09162015.pdf/@@download/file/E470%20Briefing%20on%20LPT%20to%20HPTE%20BOD%20-%2009162015.pdf)
- Pennsylvania Turnpike: an internal report found that non-E-ZPass motorists have "nearly 1 in 2" chance of riding without paying under toll-by-plate. The CEO cited a **93% overall collection rate** on all rides — [WHYY](https://whyy.org/articles/pa-turnpikes-104m-in-unpaid-tolls-draws-senators-scrutiny/). The 2022 audit found uncollected tolls of **$155M, about 6.5% of all transactions**, and cited "obscured or faded plates, camera system failures" among the causes — [WHYY Sept 2022](https://whyy.org/articles/pa-turnpike-audit-uncollected-tolls/). The 2025 PA Auditor General audit (June 2022–May 2025) reported **$229M** uncollected/unbillable for June 2024–May 2025 — [PA Auditor General](https://www.paauditor.gov/auditor-general-defoor-releases-pennsylvania-turnpike-audit-sees-improvement-from-2022-audit-and-renews-call-for-solutions-to-control-debt-obligations/); [MyChesCo](https://www.mychesco.com/?p=676662)
- Maine Turnpike rate-case testimony (Apr 2017): a consultant argued that vendor claims of 99.9% image capture reflect controlled settings. Field experience showed **3.7% image loss at one agency and 4.0–10.0% at four others** — [MTA rebuttal testimony, Maine DEP](https://www.maine.gov/dep/ftp/projects/mta-toll/rebuttal-testimony/mta/17-04-28%20MTA%20Rebuttal%20Testimony%20and%20Exhibits.pdf)
- CFX (Orlando): clerks' Pay-by-Plate collection accuracy is about **98%**, which a media outlet framed as about 1 in 50 PBP tolls possibly wrong. The figure is a media calculation, not an audit. E-PASS logged more than 2.4M Pay-by-Plate tolls in one (unspecified) year — [WFTV](https://www.wftv.com/news/local/sunpass-saga-why-are-e-pass-drivers-still-getting-pay-by-plate-notices-in-the-mail-/838900133)

### Inferences
- A plate-camera outage does not stop transponder revenue, so the revenue at risk is concentrated in the image-dependent share. On a SunPass-only express lane (see section 2), that share is small, but it carries high per-event value: the toll plus a $25/day violation charge, and the deterrence effect on non-payers.
- If a camera is down, image transactions at that site are not "leakage at the usual rate". They are close to 100% unrecoverable for the outage window unless a redundant camera covers the lane (front and rear) or a downstream gantry can re-identify the vehicle. Normal-operation leakage of 3-17% is therefore a floor for the comparison, not a ceiling.
- Transponder trips also lean on cameras: when a tag misreads, agencies post the toll to the account by plate. A camera outage turns those trips from "recoverable by plate" into "lost". The size of this effect depends on the tag read rate (target ≥99.95%, section 3).

### Gaps
- I found no published Florida figure for the percentage of unbillable images or the image-review rate (FTE, CFX or FDOT D4). FTE Traffic Engineer reports did not break this out in the extracts I saw.
- I found no published figure isolating revenue lost specifically to camera downtime, as opposed to plate-quality or collection failures, for any US agency.

## 2. I-595 Express specifics

### Takeaway
I-595 Express consists of 3 reversible express lanes on about 10 miles of I-595 in Broward County (FDOT District 4), built as a 35-year DBFOM availability-payment P3 with I-595 Express, LLC (ACS Infrastructure). Tolling began April 9, 2014. **FDOT, not the concessionaire, installed, tests, operates and maintains the tolling equipment, sets the toll rates and keeps the toll revenue.** Tolls are dynamic or time-of-day based, from a $0.50 minimum. Published sources say the lanes are SunPass/transponder-only (two-axle vehicles, no cash, no toll-by-plate), with violations pursued by plate image. I found no published I-595-only revenue or transaction figure for recent years.

### Cited Findings
- Structure: a 35-year design-build-finance-operate-maintain concession. FDOT "installed, tested, operates and maintains all tolling equipment for the express lanes; and sets the toll rates and retains the toll revenue." The concessionaire is paid by availability payments, receiving nothing until the facility is fully operational — [FHWA project profile: I-595](https://www.fhwa.dot.gov/ipd/project_profiles/fl_i595.aspx); [USDOT Build America: I-595 Corridor Roadway Improvements](https://www.transportation.gov/buildamerica/projects/i-595-corridor-roadway-improvements)
- The maximum availability payment is **$65.9M (2009 dollars), starting 2014, escalating annually**. Payments are performance-based and paid **monthly** during operations. FDOT funds them from toll receipts, federal aid and state fuel tax — [FHWA profile](https://www.fhwa.dot.gov/ipd/project_profiles/fl_i595.aspx); [Build America project highlight](https://www.transportation.gov/buildamerica/projects/project-highlights/i-595-corridor-roadway-improvements-fort-lauderdale-fl)
- The TIFIA loan is reported as **$603M** by USDOT/FHWA and as $680M by Bond Buyer (2009). The sources conflict — [FHWA press release](https://highways.fhwa.dot.gov/newsroom/usdot-approves-603-million-loan-build-new-express-lanes-florida); [Bond Buyer](https://www.bondbuyer.com/news/florida-dot-closes-on-i-595-p3-in-broward-county)
- The project cost is about **$1.8B** — [Bond Buyer, "Florida, ACS Open $1.8B I-595 Express Lanes"](https://www.bondbuyer.com/news/florida-acs-open-18b-i-595-express-lanes)
- Reversible operation runs eastbound in the AM peak and westbound in the PM peak. Tolling opened April 9, 2014 — [Wikipedia: I-595 (FL)](https://en.wikipedia.org/wiki/Interstate_595_(Florida)); [SunGuide newsletter, May 2014 "I-595 Express Lanes Open!"](https://sunguide.info/news-files/articles/2014-May_SGD_6.pdf)
- The pre-opening schedule (2013) was eastbound Mon–Fri 4 a.m.–1 p.m. plus weekends, and westbound Mon–Fri 2 p.m.–2 a.m. The planned toll range was **about $0.50–$2.00** per two-axle vehicle depending on traffic. This is a 2013 source and may be outdated — [Seminole Tribune, 2013](https://seminoletribune.org/express-lanes-to-put-drivers-on-fast-track-for-a-price/); [CBS Miami "I-595 Express Lanes Set To Open"](https://www.cbsnews.com/miami/news/i-595-express-lanes-set-to-open/)
- The 595 Express FAQ (undated) lists **$0.50 for two-axle registered SunPass users**, says tolls vary with traffic volumes and time of day, permits only two-axle vehicles, and states "the Express Lanes will not use the Toll-by-Plate method", with no cash. A March 2026 article implies Toll-By-Plate billing, so a policy change is possible but unconfirmed — [595 Express FAQ](https://www.595express.info/faq.shtm); [1-800-234-RIDE I-595](https://www.1800234ride.com/interstate-595/)
- The FHWA Interstate toll-roads table lists I-595 Express as dynamic, with a **$0.50 minimum** and a $0.05/mile figure. The extract was garbled and the maximum was not visible — [FHWA "Interstate System Toll Roads in the United States"](https://highways.dot.gov/media/134761)
- The FY2015 FTE Enterprise Toll Operations summary notes that 595 Express was excluded from standard toll-rate indexing and revenue forecasts. The I-595 figures in its table were unreadable in the extract — [FTE FY2015 Annual Report Executive Summary](https://floridasturnpike.com/wp-content/uploads/2020/04/2015_Executive-Summary.pdf)
- Broward-wide (not I-595-only): FDOT reported about **125M toll transactions and about $71M toll revenue in FY2025** for Broward. The article does not say whether this is express lanes only (I-95 + I-595). This is a single source — [Local10, Mar 17 2026](https://www.local10.com/traffic/2026/03/17/new-i-95-express-lanes-draw-complaints-as-fdot-defends-long-term-plan/)
- Volumes (FHWA National Bridge Inventory structure ADT, not corridor AADT): the I-595 Express Lanes over Pine Island Rd had **about 9,731 vehicles/day (2022)**, and the same value appears for the express lanes over University Dr. Mainline I-595 structures carry **about 58,500–74,452/day** per structure record (2022–2023) — [bridgelookup: I-595 Express over Pine Island Rd](https://bridgelookup.com/bridge/90050); [I-595 Exp over University Dr](https://bridgelookup.com/bridge/89836); [I-595 WB/EXP over Davie Rd](https://bridgelookup.com/bridge/89822)

### Inferences
- **Key point for the scenario's credibility:** because FDOT owns and operates the I-595 tolling equipment and keeps the revenue, a tolling camera outage is mainly **FDOT's revenue and enforcement loss**, not an availability-payment deduction against the concessionaire. If the scenario says "3 sites need camera replacement", it should name who owns the cost and who loses the revenue (FDOT D4 / FTE toll operations). Alternatively, it can treat the cameras as concessionaire-maintained ITS/CCTV, but whether the contract allocates any ITS to the concessionaire was not verified.
- Because the lanes are SunPass-only (per the FAQ), the image-dependent revenue per site is (i) unpaid-toll and violation recovery from non-transponder users, and (ii) plate-posting for tag misreads. This is a minority of trips but high value per event ($25/day charges).
- Order of magnitude **[ASSUMPTION]**: about 10,000 express-lane trips/day (NBI structure ADT) × about $1.00 average toll gives about $10k/day, or roughly $3–4M/yr of I-595 express toll revenue. This is not a published figure. It is consistent with the Broward-wide $71M only if most of that total is I-95 express or other facilities. The demo should label it as an estimate.

### Gaps
- I found no recent official I-595 Express toll revenue, transaction count, current max toll, number of tolling gantries or toll points, or SunPass vs. image/violation share. The FTE Traffic Engineer's Annual Reports and the FDOT D4 express-lanes performance reports are the likely sources, but they could not be fetched.
- I found no corridor AADT from FDOT Florida Traffic Online in the results.

## 3. Toll-system availability requirements and how P3 availability payments handle outages

### Takeaway
Toll-system contracts use KPIs in the 99.0-99.95% range (image capture, tag read, detection, availability), with per-gantry liquidated damages. Availability-payment P3s such as I-595 reduce payments for unavailable lanes or failed performance requirements, with heavier deductions in peak periods. I found no published deduction schedule for I-595, and the I-595 tolling equipment is FDOT's anyway.

### Cited Findings
- Central Texas Regional Mobility Authority / Kapsch maintenance KPIs: a readable plate image is required for **99.50% of detected vehicles**. Amendment No. 2 (June 2022) proposed lowering this to **99.0%**, with a penalty of **$200 per gantry location per each 0.1% below threshold** — [CTRMA Resolution 22-030](https://www.mobilityauthority.com/upload/files/Board_Resolution_Search/2022/June%2029,%202022/Resolution_No._22-030_(Amendment_No.%202%20Kapsch%20Restated%20Agreement%20KPIs).pdf)
- CTRMA 2019 board presentation: detection 99.9%, transponder reads 99.9%, and image-to-vehicle association 99.9%, each tested annually. System availability is 99.5% with a penalty per 0.1% shortfall. The extract was fragmentary — [CTRMA May 29 2019 Board Presentation](https://mobilityauthority.com/wp-content/uploads/2023/12/May_29_2019_Board_Presentation.pdf)
- TxDOT triple-protocol reader RFI: tag read success **≥99.95%**, incorrect violation image capture **≤0.2%**, and reader MTBF **≥30,000 hours** — [TxDOT RFI](https://ftp.txdot.gov/pub/txdot-info/tod/rfi-triple-protocol-reader.pdf)
- Vendor claims: Q-Free's Miami-Dade (MDX/GMX) ALPR contract cites a guaranteed 99.95% accuracy. A state turnpike image-review contractor reports 99.96% verifier accuracy against a 99.9% target. Both are vendor-reported — [Q-Free via MFN](https://mfn.se/ob/a/q-free/q-free-alpr-contract-in-the-us-20-mnok-7ae35e5f); [CAI case study](https://www.cai.io/resources/success-stories/state-turnpike-moves-faster)
- I-595: if contract quality and performance requirements "as well as availability of the roadways to traffic are not met, then the availability payments will be subject to downward adjustment" — [USDOT Build America](https://www.transportation.gov/buildamerica/projects/i-595-corridor-roadway-improvements)
- Florida AP model generally: payments can be reduced for unpermitted lane closures or failure to provide a safe facility, with bigger deductions in peak periods — [World Highways, "How Florida paved way for availability payments"](https://worldhighways.com/wh8/wh10/feature/how-florida-paved-way-availability-payments-us); FHWA AP primer — [FHWA DBFOM Availability Payment Concessions](https://www.fhwa.dot.gov/ipd/p3/defined/new_build_facilities/dbfom_availability_payment_concessions.aspx)
- FDOT I-4 Ultimate (an AP P3) issues **noncompliance points** when the concessionaire fails to operate and maintain assets to contract. Flood-related lane closures in 2019 led to points that the concessionaire disputed — [Construction Dive](https://www.constructiondive.com/news/fdot-p3-nix-deadline-for-i-4-100m-overrun-delay-claims/542908/)

### Inferences
- For the demo, two separate "cost of outage" lenses are defensible. (a) The **toll revenue lens** applies to FDOT: lost or unbillable image transactions. (b) The **contract lens** applies to the concessionaire: availability deductions and noncompliance points if the failed asset is in the concessionaire's O&M scope (for example CCTV or ITS used for incident management) or if it causes lane closures. Neither is published for I-595, so both must be labeled as assumptions.
- A KPI of 99.5% image capture with $200 per 0.1% per gantry gives a ready-made, cited template for a "contract penalty" field.

### Gaps
- I-595 availability-payment deduction mechanics (lane-closure charges, peak multipliers, equipment categories) are in the concession agreement and technical provisions, which were not found online.
- I found no Florida (FTE/FDOT) toll-system availability KPI.

## 4. Transaction data available per gantry (fields, granularity)

### Takeaway
Agencies hold transaction-level records internally: timestamp, gantry/lane, tag ID or plate, class, toll, and disposition (posted, image-review, billed, unbillable with reason code). Public releases are aggregated. The closest public analogue to "per site, per hour, by payment type including unbillable" is the NY MTA Bridges & Tunnels hourly datasets. Florida agencies publish only annual or monthly aggregates (FTE Traffic Engineer reports, CFX ACFR).

### Cited Findings
- MTA B&T **Hourly Crossings (2019–)**: by facility, direction, vehicle class and payment method, counting all traffic "regardless of whether the driver ultimately pays." **Hourly Reconciled Crossings (2019–2024)**: by payment method including **E-ZPass, Tolls by Mail, and unbillable**, about 21.7M rows × 13 columns — [data.gov: Hourly Crossings](https://catalog.data.gov/dataset/mta-bridges-and-tunnels-hourly-crossings-beginning-2019); [data.gov: Hourly Reconciled Crossings](https://catalog.data.gov/dataset/mta-bridges-tunnels-hourly-reconciled-crossings-2019-2024); [Baselight mirror row count](https://baselight.app/u/usgov/dataset/state_of_new_york_mta_bridges_tunnels_hourly_reconcile_235aee5b)
- NY Thruway: E-ZPass and cash vehicle counts **by hour, by plaza, by direction** since 2006 (CSV) — [data.gov: Thruway E-ZPass/Cash Hourly Usage by Plaza](https://catalog-beta.data.gov/dataset/thruway-e-zpass-cash-hourly-usage-by-plaza-beginning-2006)
- Maryland Transportation Authority: toll transaction counts at its 8 facilities. Granularity and video split were not confirmed — [data.gov toll transactions](https://catalog.data.gov/dataset/toll-transactions)
- TBTA classifies rejected images by **technical vs. business reason codes**, a natural "disposition" field — [NY OSC TBTA audit](https://www.osc.ny.gov/files/state-agencies/audits/pdf/sga-2022-21f15.pdf)
- Payment-mix magnitudes:
  - Florida's Turnpike FY2023: ETC is **82% of toll revenue ($922M)** — [FTE 2023 Traffic Engineer's Report Overview](https://floridasturnpike.com/wp-content/uploads/2024/01/02_Overview_2023.pdf)
  - Florida's Turnpike FY2024: system revenue **$1.29B**, transactions up 4.1% — [FTE FY2024 Executive Summary](https://floridasturnpike.com/wp-content/uploads/2025/02/0_Executive_Summary_2024_F.pdf)
  - CFX: more than 98% of transactions are cashless — [CFX cashless tolling](https://www.cfxway.com/cashlesstolling/)
  - NTTA 2015: **79.3%** of transactions by TollTag — [NTTA 2015 Annual Report](https://texashistory.unt.edu/ark:/67531/metapth1435545/m2/1/high_res_d/2015_Annual_Report.pdf)
  - NTTA 2012–13: ZipCash (image) at **about 22.7–23.9%** of transactions — [NTTA Feb 2013 Monthly Financial Report](https://www.ntta.org/Documents/financial_info/Item%2014%20Board%20Item%20February%202013%20Monthly%20Financial%20Report.pdf)
- A comparable Florida express-lane data point: I-4 Express brought in about **$14M in its first month** (2022) — [ClickOrlando](https://clickorlando.com/news/local/2022/05/10/new-i-4-express-lanes-bring-in-14-million-in-one-month)

### Inferences: proposed demo data model (all field values synthetic; magnitudes anchored above)
`toll_site_hourly` (one row per site × hour × direction):
- `site_id`, `gantry_name`, `direction` (EB/WB, plus `reversible_mode` for I-595), `hour_start` (ISO)
- `tx_total`, `tx_transponder`, `tx_image` (image-dependent: violation or no-tag), `tx_tag_misread_plate_posted`
- `tx_unbillable`, `unbillable_reason` (technical: camera_down / no_image / unreadable; business: no_owner / out_of_state), modeled on TBTA reason codes
- `avg_toll_usd`, `revenue_posted_usd`, `revenue_at_risk_usd`
- `vehicle_class` (I-595 express: 2-axle only)
- `image_capture_rate`, `ocr_auto_read_rate`, `manual_review_rate`
- `camera_status` (ok / degraded / down), `outage_minutes`
- `kpi_threshold` (e.g. 0.995 per CTRMA), `kpi_penalty_usd`

Typical magnitudes for I-595 express **[ASSUMPTION]**: about 400–1,000 express trips/hour in peak direction per site, consistent with about 10k/day structure ADT; toll $0.50–$2.00 (2013/FAQ range); image-dependent share 2–8% for a SunPass-only lane. For a general AET road, use 15–25% image share per NTTA's history.

### Gaps
- I found no Florida open dataset with per-gantry hourly transactions or image counts. FDOT/FTE data would have to come via public-records request.

## 5. Estimating revenue impact of a camera outage per site

### Takeaway
A defensible per-site estimate is:
`lost_revenue = tx_per_hour × image_dependent_share × (avg_toll + expected_fee_recovery) × outage_hours × unrecoverable_fraction`, plus any contract penalty.
The demo point ("adding transaction data changes which site goes first") follows naturally. A site with the oldest or worst camera but low volume or low image share can rank below a healthier camera at a high-volume, high-toll, peak-direction gantry.

### Cited Findings (inputs)
- Normal-operation image loss: 3.7% to 4–10% field experience (Maine testimony); 17% illustrative unbillable (E-470); 6.5% of all transactions uncollected (PA 2022) — sources in section 1
- Toll level on I-595 express: $0.50 minimum, about $0.50–$2.00 range — [595 Express FAQ](https://www.595express.info/faq.shtm); [CBS Miami](https://www.cbsnews.com/miami/news/i-595-express-lanes-set-to-open/)
- Violation economics in Florida express lanes: $25/day plus $2.50 admin fee — [95 Express](https://95express.com/?p=908)
- Contract penalty template: $200 per gantry per 0.1% below the 99.0–99.5% image-capture KPI — [CTRMA Res. 22-030](https://www.mobilityauthority.com/upload/files/Board_Resolution_Search/2022/June%2029,%202022/Resolution_No._22-030_(Amendment_No.%202%20Kapsch%20Restated%20Agreement%20KPIs).pdf)

### Inferences: worked example (all [ASSUMPTION], for the demo only)
- Site A (peak-direction main gantry): 800 tx/h × 5% image-dependent × $1.50 × 120 outage h/month × 0.9 unrecoverable ≈ **$6,480/month**, before violation fees
- Site B (off-peak / ramp gantry, older camera): 150 tx/h × 5% × $0.75 × 200 h × 0.9 ≈ **$1,013/month**
- Site C (mid-corridor, degraded rather than down): 500 tx/h × 5% × $1.00 × 720 h × 0.25 (partial loss) ≈ **$4,500/month**
- Ranking by camera condition alone might put B first. Ranking by revenue at risk gives A > C > B. This is the "transaction data changes the order" story.
- Reasonable range bands for the UI: image-dependent share 2–25% (SunPass-only express lane at the low end, general AET at the high end), unrecoverable fraction during a full outage 0.7–1.0 (lower if a redundant rear camera or downstream gantry exists), and 0.03–0.17 baseline leakage when healthy.

### Gaps
- No published I-595 per-gantry volume, image share or outage history exists to calibrate against. All per-site numbers in a demo must be synthetic and labeled.
- Whether violation fees ($25/day) should count as "revenue" is a policy choice. They are often uncollected; see PA's collection problems.

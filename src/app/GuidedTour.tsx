/*---------------------------------------------------------------------------------------------
 * Guided tour / onboarding coach-marks for the demo. Auto-starts on first visit (localStorage),
 * and can be re-launched from the "Tour" button in the top bar. Walks through the scenarios,
 * the asset list, the twin, the inspector, the KPIs, and the before/after countermeasure toggle.
 *--------------------------------------------------------------------------------------------*/
import "./tour.css";
import { useEffect, useState, type CSSProperties } from "react";
import { store } from "../scenarioA/store";

interface Step {
  title: string;
  body: string;
  pos: CSSProperties;
  scenario?: "A" | "B";
}

const STEPS: Step[] = [
  {
    title: "I-595 Express — Operational Twin",
    body: "A live digital twin of the I-595 Express corridor. It predicts which roadside ITS assets are about to fail and where crashes cluster — so lane closures and lost toll revenue are prevented, not reacted to.",
    pos: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
    scenario: "A",
  },
  {
    title: "Two operational views",
    body: "Switch between Asset Reliability (predictive maintenance) and Safety Hotspots (crash prediction) up here.",
    pos: { top: "62px", left: "16px" },
    scenario: "A",
  },
  {
    title: "Your corridor inventory",
    body: "Every ITS asset, risk-sorted. Search, filter by status, and click any row to fly to it on the model.",
    pos: { top: "120px", left: "324px" },
    scenario: "A",
  },
  {
    title: "The twin itself",
    body: "The photoreal corridor. Assets are colored green / amber / red by failure risk — click a red pin to inspect it.",
    pos: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
    scenario: "A",
  },
  {
    title: "The inspector",
    body: "Failure risk, the drivers behind it, full history, and the recommended action. Add several at-risk assets into one proactive work package.",
    pos: { top: "120px", right: "372px" },
    scenario: "A",
  },
  {
    title: "What it's worth",
    body: "Lane closures avoided and toll revenue protected — the operator's bottom line, always in view.",
    pos: { bottom: "76px", left: "50%", transform: "translateX(-50%)" },
    scenario: "A",
  },
  {
    title: "Test a fix before you build it",
    body: "On Safety Hotspots, click a red segment at the Express↔Turnpike connector, then toggle a countermeasure Before / After to watch crashes and closures drop.",
    pos: { top: "120px", right: "372px" },
    scenario: "B",
  },
];

const SEEN_KEY = "acs_tour_seen_v1";

export function shouldAutoStartTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

export function GuidedTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];

  useEffect(() => {
    if (step.scenario) store.setScenario(step.scenario);
  }, [step]);

  const finish = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    store.setScenario("A");
    onClose();
  };

  return (
    <div className="tour-overlay">
      <div className="tour-card" style={step.pos}>
        <div className="tour-step">
          Step {i + 1} of {STEPS.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button onClick={finish}>Skip</button>
          <div className="spacer" />
          {i > 0 && <button onClick={() => setI(i - 1)}>Back</button>}
          <button
            className="primary"
            onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : finish())}
          >
            {i < STEPS.length - 1 ? "Next" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}

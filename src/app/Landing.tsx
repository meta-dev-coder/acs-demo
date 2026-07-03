/*---------------------------------------------------------------------------------------------
 * Public, pre-auth landing page. Shown on first load instead of firing the Bentley IMS sign-in
 * automatically — the "Operational Twin" card opts into that flow; the "Toll-Plaza Physics
 * Twin" card is a plain link to the co-hosted SUMO x Cesium build (no auth at all).
 *
 * Deliberately a single self-contained file (inline styles): this is a one-screen landing, not
 * part of the scenario/dashboard chrome, so it doesn't need its own stylesheet or to share
 * shell.css's grid layout. Colors mirror the shell's --sd-* dark palette for brand consistency.
 *--------------------------------------------------------------------------------------------*/
import type { CSSProperties } from "react";

const COLORS = {
  bg: "#0e141b",
  panel: "#161e28",
  panel2: "#1d2733",
  line: "#2a3543",
  text: "#eef3f8",
  dim: "#a9b7c6",
  accent: "#2f8fe0",
};

const styles: Record<string, CSSProperties> = {
  page: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 40,
    background: COLORS.bg,
    color: COLORS.text,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    padding: 24,
  },
  header: {
    textAlign: "center",
  },
  brand: {
    fontWeight: 800,
    fontSize: 28,
    letterSpacing: "0.02em",
  },
  tagline: {
    marginTop: 8,
    color: COLORS.dim,
    fontSize: 15,
  },
  cards: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 24,
    maxWidth: 900,
  },
  card: {
    width: 340,
    minHeight: 190,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "24px 22px",
    borderRadius: 12,
    border: `1px solid ${COLORS.line}`,
    background: COLORS.panel,
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    textDecoration: "none",
    font: "inherit",
  },
  cardEyebrow: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: COLORS.accent,
  },
  cardTitle: {
    fontSize: 19,
    fontWeight: 700,
  },
  cardSubtitle: {
    color: COLORS.dim,
    fontSize: 13,
    lineHeight: 1.5,
  },
  cardCta: {
    marginTop: "auto",
    paddingTop: 14,
    fontSize: 13,
    fontWeight: 600,
    color: COLORS.accent,
  },
  footer: {
    color: COLORS.dim,
    fontSize: 12,
  },
};

function Card({
  eyebrow,
  title,
  subtitle,
  cta,
  ...rest
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
} & (
  | { as: "button"; onClick: () => void }
  | { as: "a"; href: string }
)) {
  const cardStyle: CSSProperties = { ...styles.card };
  const body = (
    <>
      <span style={styles.cardEyebrow}>{eyebrow}</span>
      <span style={styles.cardTitle}>{title}</span>
      <span style={styles.cardSubtitle}>{subtitle}</span>
      <span style={styles.cardCta}>{cta} &rarr;</span>
    </>
  );

  if (rest.as === "a") {
    return (
      <a href={rest.href} style={cardStyle} className="landing-card">
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={rest.onClick} style={cardStyle} className="landing-card">
      {body}
    </button>
  );
}

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div style={styles.page}>
      <style>{`
        .landing-card { transition: border-color 120ms ease, transform 120ms ease; }
        .landing-card:hover, .landing-card:focus-visible {
          border-color: ${COLORS.accent};
          transform: translateY(-2px);
        }
        .landing-card:focus-visible { outline: 2px solid ${COLORS.accent}; outline-offset: 2px; }
      `}</style>
      <div style={styles.header}>
        <div style={styles.brand}>ACS I-595 Express — Operational Twin</div>
        <div style={styles.tagline}>Choose a digital twin to explore.</div>
      </div>
      <div style={styles.cards}>
        <Card
          as="button"
          eyebrow="iTwin · Bentley"
          title="Operational Twin (iTwin)"
          subtitle="I-595 Express corridor · 4 decision scenarios · Bentley sign-in required"
          cta="Sign in and open"
          onClick={onSignIn}
        />
        <Card
          as="a"
          href="./twin/"
          eyebrow="SUMO × Cesium"
          title="Toll-Plaza Physics Twin (SUMO × Cesium)"
          subtitle="Live traffic physics · lane-closure planning · no sign-in"
          cta="Open"
        />
      </div>
      <div style={styles.footer}>SuperDNA · Advanced Corridor Solutions demo</div>
    </div>
  );
}

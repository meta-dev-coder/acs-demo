/*---------------------------------------------------------------------------------------------
 * "Bring your own data" UI: a compact per-scenario data-source switcher that lives in the
 * top-right of the shell header, plus a scrollable data-table panel that overlays the viewer.
 *
 * Design intent: native to the existing industrial control-room dark theme, but a touch more
 * refined — a segmented control with a sliding accent underline, tabular-numeral data, sticky
 * table header, keyboard-accessible controls, and clear empty/error states. Additive only: the
 * default source renders the built-in data exactly as today.
 *--------------------------------------------------------------------------------------------*/
import { useEffect, useRef, useState } from "react";
import { store, useScenarioState } from "../scenarioA/store";
import {
  ASSET_SOURCES,
  assetTemplateCsv,
  SEGMENT_SOURCES,
  segmentTemplateCsv,
} from "../data/sources";
import { toCsv } from "../data/csv";
import {
  applyAssetSource,
  applyAssetUpload,
  applySegmentSource,
  applySegmentUpload,
} from "../data/loader";

/** Trigger a client-side download of `text` as a .csv file. */
function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ----------------------------- switcher ----------------------------- */
export function DataSourceSwitcher({
  scenario,
  dataOpen,
  onToggleData,
}: {
  scenario: "A" | "B";
  dataOpen: boolean;
  onToggleData: () => void;
}) {
  const s = useScenarioState();
  const fileRef = useRef<HTMLInputElement>(null);
  const sources = scenario === "A" ? ASSET_SOURCES : SEGMENT_SOURCES;
  const activeId = scenario === "A" ? s.sourceA : s.sourceB;
  const error = scenario === "A" ? s.sourceErrorA : s.sourceErrorB;

  const selectSource = (id: string) => {
    if (id === "upload") {
      fileRef.current?.click();
      return;
    }
    if (scenario === "A") applyAssetSource(id);
    else applySegmentSource(id);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (scenario === "A") applyAssetUpload(text);
      else applySegmentUpload(text);
    };
    reader.onerror = () =>
      store.setSourceError(scenario, "Could not read the file. Please try another CSV.");
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    if (scenario === "A") downloadCsv("its-assets-template.csv", assetTemplateCsv());
    else downloadCsv("corridor-segments-template.csv", segmentTemplateCsv());
  };

  const downloadCurrent = () => {
    const table = scenario === "A" ? s.tableA : s.tableB;
    if (table.rows.length === 0) return downloadTemplate();
    downloadCsv(
      scenario === "A" ? "its-assets-current.csv" : "corridor-segments-current.csv",
      toCsv(table.columns, table.rows)
    );
  };

  const uploadActive = activeId === "upload";

  return (
    <div className="sd-ds">
      <div className="sd-ds-row">
        <span className="sd-ds-label" id={`ds-label-${scenario}`}>
          Data source
        </span>
        <div
          className="sd-seg"
          role="radiogroup"
          aria-labelledby={`ds-label-${scenario}`}
        >
          {sources.map((src) => {
            const on = activeId === src.id;
            return (
              <button
                key={src.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={`sd-seg-btn ${on ? "on" : ""} ${src.kind === "upload" ? "upload" : ""}`}
                title={
                  src.kind === "upload"
                    ? "Upload your own CSV"
                    : src.kind === "builtin"
                    ? "Built-in sample data"
                    : "Sample CSV dataset"
                }
                onClick={() => selectSource(src.id)}
              >
                {src.kind === "upload" && <span aria-hidden className="sd-seg-ico">⬆</span>}
                {src.label}
              </button>
            );
          })}
        </div>

        <div className="sd-ds-actions">
          <button
            type="button"
            className={`sd-ds-act ${dataOpen ? "on" : ""}`}
            aria-pressed={dataOpen}
            onClick={onToggleData}
            title="View the active dataset as a table"
          >
            <span aria-hidden>▦</span> Data
          </button>
          <button
            type="button"
            className="sd-ds-act"
            onClick={downloadTemplate}
            title="Download an empty CSV with the expected columns"
          >
            <span aria-hidden>⤓</span> Template
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sd-visually-hidden"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = ""; // allow re-uploading the same file
          }}
        />
      </div>

      {error && (
        <div className="sd-ds-error" role="alert">
          <span aria-hidden>⚠</span> {error}{" "}
          <button type="button" className="sd-ds-dismiss" onClick={() => store.setSourceError(scenario, null)}>
            Dismiss
          </button>
        </div>
      )}
      {uploadActive && !error && (
        <div className="sd-ds-note">
          Showing your uploaded CSV · {(scenario === "A" ? s.tableA : s.tableB).rows.length} rows ·{" "}
          <button type="button" className="sd-ds-link" onClick={downloadCurrent}>
            download as CSV
          </button>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- table panel ----------------------------- */
export function DataTablePanel({
  scenario,
  onClose,
}: {
  scenario: "A" | "B";
  onClose: () => void;
}) {
  const s = useScenarioState();
  const table = scenario === "A" ? s.tableA : s.tableB;
  const activeId = scenario === "A" ? s.sourceA : s.sourceB;
  const sources = scenario === "A" ? ASSET_SOURCES : SEGMENT_SOURCES;
  const activeLabel = sources.find((src) => src.id === activeId)?.label ?? activeId;
  const [q, setQ] = useState("");

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ql = q.trim().toLowerCase();
  const rows =
    ql === ""
      ? table.rows
      : table.rows.filter((r) =>
          table.columns.some((c) => String(r[c] ?? "").toLowerCase().includes(ql))
        );

  const downloadCurrent = () => {
    if (table.rows.length === 0) return;
    downloadCsv(
      scenario === "A" ? "its-assets-current.csv" : "corridor-segments-current.csv",
      toCsv(table.columns, table.rows)
    );
  };

  return (
    <div className="sd-table-overlay" role="dialog" aria-modal="false" aria-label="Dataset table">
      <div className="sd-table-head">
        <div className="sd-table-title">
          <span className="sd-table-kicker">{scenario === "A" ? "ITS assets" : "Corridor segments"}</span>
          <span className="sd-table-name">{activeLabel}</span>
          <span className="sd-table-count">{table.rows.length} rows · {table.columns.length} columns</span>
        </div>
        <div className="sd-table-tools">
          <input
            className="sd-table-search"
            placeholder="Filter rows…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter table rows"
          />
          <button
            type="button"
            className="sd-ds-act"
            onClick={downloadCurrent}
            disabled={table.rows.length === 0}
            title="Download this dataset as CSV"
          >
            <span aria-hidden>⤓</span> Export
          </button>
          <button type="button" className="sd-table-close" onClick={onClose} aria-label="Close table">
            ✕
          </button>
        </div>
      </div>

      <div className="sd-table-scroll">
        {table.columns.length === 0 ? (
          <div className="sd-table-empty">No dataset loaded yet.</div>
        ) : rows.length === 0 ? (
          <div className="sd-table-empty">No rows match “{q}”.</div>
        ) : (
          <table className="sd-table">
            <thead>
              <tr>
                <th className="sd-th-idx">#</th>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="sd-td-idx">{i + 1}</td>
                  {table.columns.map((c) => (
                    <td key={c}>{r[c]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * Ask the Twin, wired to the application's own state.
 *
 * The hook owns the conversation and nothing else. It reads the live hooks to assemble the data
 * view and the twin context AT ASK TIME — not on every render, and never into a stored copy — so
 * an answer always describes the data and the selection that exist at the moment it is asked.
 *
 * Map actions are not performed here either. `ask()` returns validated actions; App.jsx owns the
 * one dispatcher that turns them into calls on the existing layers, which is what keeps this
 * assistant from becoming a second selection engine.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { answerQuestion } from '../ask/askTwin.js';
import { createDataView, viewReady } from '../ask/dataView.js';
import { buildTwinContext } from '../ask/twinContext.js';
import { createSession } from '../ask/session.js';
import { ASK_API } from '../config/askTwin.js';
import { INTENT } from '../ask/intents.js';

/**
 * Ask the optional server-side model to classify a question the deterministic router did not
 * recognise. It returns an INTENT, never an answer: the tools still produce every fact.
 * Any failure — no key, unreachable, a reply outside the contract — resolves to null, and the
 * unsupported message stands.
 */
async function interpret(question) {
  try {
    const response = await fetch(ASK_API.interpret, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const payload = await response.json();
    return response.ok && payload?.ok && payload.intent !== INTENT.UNSUPPORTED ? payload : null;
  } catch {
    return null;
  }
}

let turnId = 0;
const nextId = () => { turnId += 1; return `turn-${turnId}`; };

export function useAskTwin({
  selection, infra, roads, buildings, traffic, explorer, viewerRef, buildingsById, planner,
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  /** Conversation memory: subjects and result ids only. Cleared with the conversation. */
  const memoryRef = useRef(createSession());

  /**
   * The planner's LIVE scenarios and runs, not a copy read back from storage.
   *
   * `createDataView` falls back to `loadScenarios()` when no planner is supplied, and that stopped
   * working the day scenario state became session-only: nothing is written to that key any more,
   * so every scenario question answered "the scenario planner has no scenarios yet" while three
   * of them sat on screen. Passing the live state keeps an answer and the Compare tab looking at
   * the same runs by construction.
   */
  const plannerView = useMemo(
    () => ({ scenarios: planner?.scenarios ?? [], runs: planner?.runs ?? [] }),
    [planner?.scenarios, planner?.runs]);

  const view = useMemo(() => createDataView({
    assets: infra.assets,
    segments: roads.segments,
    buildings: buildings.buildings,
    buildingsById,
    linksFor: id => infra.linksFor(id),
    traffic,
    planner: plannerView,
  }), [infra, roads.segments, buildings.buildings, buildingsById, traffic, plannerView]);

  const ready = viewReady(view);

  /** The context as it is right now — rebuilt per question, including the live camera. */
  const readContext = useCallback(() => buildTwinContext({
    selection, infra, roads, buildings, traffic, explorer,
    viewer: viewerRef.current, buildingsById,
  }), [selection, infra, roads, buildings, traffic, explorer, viewerRef, buildingsById]);

  const ask = useCallback(question => {
    const text = String(question ?? '').trim();
    if (!text || busy) return;
    setError(null);
    setBusy(true);
    const asked = { id: nextId(), role: 'user', text };
    setTurns(current => [...current, asked]);

    // Deterministic and synchronous — but routed through a frame so the question paints first and
    // the panel shows its loading state rather than freezing on a 6,000-polygon sweep.
    const run = async () => {
      try {
        if (!ready) {
          setTurns(current => [...current, {
            id: nextId(), role: 'assistant',
            response: {
              intent: 'NOT_LOADED', message: 'The road network, building extract and registry are still loading. Ask again in a moment.',
              sources: [], actions: [], warnings: [], confidence: null,
            },
          }]);
          return;
        }
        const context = readContext();
        let { response, memory } = answerQuestion({
          question: text, context, view, memory: memoryRef.current,
        });

        // Only now, and only for a question nothing understood, is the model consulted.
        if (response.unsupported) {
          const route = await interpret(text);
          if (route) {
            const second = answerQuestion({ question: text, context, view, memory: memoryRef.current, route });
            response = {
              ...second.response,
              interpretedByModel: true,
              warnings: [...second.response.warnings,
                'A language model chose how to read this question; every figure in the answer still comes from this twin’s own data.'],
            };
            memory = second.memory;
          }
        }

        memoryRef.current = memory;
        setTurns(current => [...current, { id: nextId(), role: 'assistant', response }]);
      } catch (failure) {
        // An answer that throws must not look like an answer.
        setError(`Something went wrong answering that: ${failure.message}`);
      } finally {
        setBusy(false);
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { void run(); });
    else void run();
  }, [busy, ready, readContext, view]);

  const clear = useCallback(() => {
    setTurns([]);
    setError(null);
    memoryRef.current = createSession();
  }, []);

  return {
    open, setOpen, toggle: () => setOpen(current => !current),
    turns, busy, error, ready, ask, clear,
    /** For the panel's "this refers to…" line. Read fresh, like the answers. */
    readContext,
  };
}

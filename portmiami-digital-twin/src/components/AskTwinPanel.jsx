/**
 * Ask the Twin: a compact panel beside the map, not a chatbot that takes the screen.
 *
 * The map stays the workspace. The panel is the same 330–360px column every other panel in this
 * app uses, on the same surfaces and borders, and it closes without disturbing anything.
 *
 * What it shows, and why each part is there:
 *   - the subject line, so the operator can see what "this" would resolve to BEFORE asking;
 *   - the answer, in one paragraph of operational prose rather than a stack of cards;
 *   - the source chips and their age, because an answer from a feed is only as good as its data;
 *   - the warnings, which carry the caveats that make a number honest;
 *   - one button per validated map action.
 * A confidence chip appears only with the reason behind it, as its tooltip.
 */
import { useEffect, useRef, useState } from 'react';
import { SUGGESTED_QUESTIONS } from '../config/askTwin.js';
import { actionLabel } from '../ask/actions.js';
import { describeContext } from '../ask/twinContext.js';
import { formatAge } from '../liveTraffic/liveTrafficModel.js';

const KIND_LABEL = Object.freeze({
  asset: 'Selected asset', road: 'Selected road', building: 'Selected building',
  camera: 'Selected camera', event: 'Selected event', sign: 'Selected sign',
});

function Sources({ sources }) {
  if (!sources?.length) return null;
  return (
    <ul className="ask-sources">
      {sources.map((source, i) => (
        <li key={`${source.name}-${i}`}>
          <span className="ask-source-name">{source.name}</span>
          {Number.isFinite(source.ageSeconds) && (
            <span className="ask-source-age"> · read {formatAge(source.ageSeconds)} ago</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Answer({ response, onRunAction }) {
  return (
    <div className="ask-answer">
      <p className="ask-message">{response.message}</p>

      {response.actions?.length > 0 && (
        <div className="ask-actions">
          {response.actions.map((action, i) => (
            <button key={`${action.type}-${i}`} type="button" className="ask-action"
              onClick={() => onRunAction(action)}>
              {actionLabel(action)}
            </button>
          ))}
        </div>
      )}

      <Sources sources={response.sources} />

      {response.warnings?.length > 0 && (
        <ul className="ask-warnings">
          {response.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
        </ul>
      )}

      {response.confidence && (
        /* The reason is the title, so a label can never travel without its basis. */
        <p className={`ask-confidence is-${response.confidence.toLowerCase()}`}
          title={response.confidenceBasis ?? undefined}>
          Confidence {response.confidence}
          {response.confidenceBasis ? <span className="ask-confidence-why">{response.confidenceBasis}</span> : null}
        </p>
      )}
    </div>
  );
}

export function AskTwinPanel({ ask, onRunAction, onClose }) {
  const [draft, setDraft] = useState('');
  const endRef = useRef(null);
  const context = ask.readContext();
  const selected = describeContext(context);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [ask.turns.length, ask.busy]);

  const submit = event => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    ask.ask(text);
  };

  return (
    <section className="ask-panel" aria-label="Ask the Twin">
      <header className="road-details-head">
        <div>
          <h2>Ask the Twin</h2>
          <p>{ask.ready ? 'Reads this twin’s own data — nothing is invented.' : 'Loading the twin’s data…'}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClose} aria-label="Close Ask the Twin">×</button>
      </header>

      {/* What a pronoun in the next question will resolve to. Shown before asking, not after. */}
      {/* Every current selection, because "this road" and "this terminal" can resolve to
          different records when both are selected. */}
      <p className="ask-context">
        {selected.length > 0
          ? <>
            {selected.map((item, i) => (
              <span key={item.kind}>
                {i > 0 ? ' · ' : ''}
                {KIND_LABEL[item.kind] ?? 'Selected'}: <strong>{item.label}</strong>
              </span>
            ))}
            {selected.length === 1 ? ' — “this” refers to it.' : ' — name the kind you mean (“this road”).'}
          </>
          : <>Nothing is selected. Name a terminal or garage, or select one on the map, for questions about “this”.</>}
      </p>

      <div className="ask-thread">
        {ask.turns.length === 0 && (
          <div className="ask-suggestions">
            <p className="ask-suggest-head">Try one of these</p>
            {SUGGESTED_QUESTIONS.map(suggestion => (
              <button key={suggestion.text} type="button" className="ask-suggestion"
                disabled={ask.busy}
                onClick={() => ask.ask(suggestion.text)}>
                {suggestion.text}
                {suggestion.needs === 'road' && <span className="ask-suggest-note">needs a road selected</span>}
              </button>
            ))}
          </div>
        )}

        {ask.turns.map(turn => (turn.role === 'user'
          ? <p key={turn.id} className="ask-question">{turn.text}</p>
          : <Answer key={turn.id} response={turn.response} onRunAction={onRunAction} />
        ))}

        {ask.busy && <p className="ask-busy" role="status">Reading the twin’s data…</p>}
        {ask.error && <p className="ask-error" role="alert">{ask.error}</p>}
        <div ref={endRef} />
      </div>

      <form className="ask-input" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="Ask about terminals, roads, buildings or traffic"
          aria-label="Ask the Twin a question"
          disabled={ask.busy}
        />
        <button type="submit" disabled={ask.busy || draft.trim().length === 0}>Send</button>
      </form>

      {ask.turns.length > 0 && (
        <button type="button" className="ask-clear" onClick={ask.clear}>Clear conversation</button>
      )}
    </section>
  );
}

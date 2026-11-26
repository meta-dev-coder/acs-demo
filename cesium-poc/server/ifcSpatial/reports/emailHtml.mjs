/**
 * The email body as rich text: a small allowlist sanitizer (no dependency) for what the composer's toolbar can
 * make — paragraphs, a heading, bold, italic, underline, lists, links — and the plain-text alternative.
 * Everything else is dropped: other tags, every attribute except a link's http(s)/mailto href, scripts, styles,
 * comments. Text is escaped. Used when a draft is saved, sent through Gmail and exported as .eml.
 */
const KEEP = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'h3', 'blockquote']);
const RENAME = { div: 'p', h1: 'h3', h2: 'h3', h4: 'h3', span: null };
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'head', 'title', 'noscript', 'textarea', 'select']);
const VOID = new Set(['br']);
const escText = s => String(s).replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = s => String(s).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

export function sanitizeEmailHtml(input, { maxLength = 60_000 } = {}) {
  const html = String(input ?? '').slice(0, maxLength).replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const open = [];
  let skip = null;
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)|(<)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [whole, rawTag, attrs, text, lone] = m;
    if (text !== undefined || lone !== undefined) { if (!skip) out.push(escText(decode(text ?? '<'))); continue; }
    let tag = rawTag.toLowerCase();
    const closing = whole.startsWith('</');
    if (skip) { if (closing && tag === skip) skip = null; continue; }
    if (DROP_WITH_CONTENT.has(tag)) { if (!closing && !/\/>$/.test(whole)) skip = tag; continue; }
    if (tag in RENAME) tag = RENAME[tag];
    if (!tag || !KEEP.has(tag)) continue;
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (VOID.has(tag)) { out.push('<br>'); continue; }
    if (tag === 'a') {
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = decode(href ? href[2] ?? href[3] ?? href[4] : '').trim();
      if (!/^(https?:\/\/|mailto:)[^\s]+$/i.test(url)) { open.push('span-dropped'); continue; }
      out.push(`<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">`);
      open.push('a');
      continue;
    }
    // An open <li> or <p> ends where the next one starts (as browsers read it).
    if ((tag === 'li' || tag === 'p') && open.at(-1) === tag) out.push(`</${open.pop()}>`);
    out.push(`<${tag}>`);
    open.push(tag);
  }
  while (open.length) { const t = open.pop(); if (t !== 'span-dropped') out.push(`</${t}>`); }
  return out.join('').replace(/<span-dropped>|<\/span-dropped>/g, '').trim();
}

/** The plain-text alternative: paragraphs and list items on their own lines, links as "text (url)". */
export function emailHtmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => { const l = label.replace(/<[^>]+>/g, ''); return decode(l) === decode(url) ? l : `${l} (${url})`; });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<li>/gi, '\n- ').replace(/<\/(p|h3|blockquote|ul|ol)>/gi, '\n\n').replace(/<[^>]+>/g, '');
  return decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain text (as generated) → simple HTML paragraphs, list lines ("- x") as a list. */
export function textToEmailHtml(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n');
    if (lines.length > 1 && lines.slice(1).every(l => /^- /.test(l)) && !/^- /.test(lines[0])) return `<p>${escText(lines[0])}</p><ul>${lines.slice(1).map(l => `<li>${escText(l.slice(2))}</li>`).join('')}</ul>`;
    if (lines.every(l => /^- /.test(l))) return `<ul>${lines.map(l => `<li>${escText(l.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(escText).join('<br>')}</p>`;
  }).join('');
}

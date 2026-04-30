// Minimal markdown renderer covering exactly what CHANGELOG.md uses:
// h1/h2/h3, paragraphs, unordered lists, **bold**, *italic*, `inline code`,
// and [link text](url). Deliberately not a full markdown engine — keeps the
// bundle small and the behavior predictable.

function renderInline(text, keyPrefix) {
  // Order matters: links → code → bold → italic. We tokenize sequentially.
  const out = [];
  let i = 0;
  let cursor = 0;
  let key = 0;
  const push = (node) => out.push(<span key={`${keyPrefix}-${key++}`}>{node}</span>);

  const tryMatch = (re) => {
    re.lastIndex = i;
    const m = re.exec(text);
    return m && m.index === i ? m : null;
  };

  while (i < text.length) {
    const linkM = tryMatch(/\[([^\]]+)\]\(([^)]+)\)/y);
    if (linkM) {
      if (cursor < i) push(text.slice(cursor, i));
      const [, label, url] = linkM;
      out.push(<a href={url} key={`${keyPrefix}-${key++}`} target="_blank" rel="noopener noreferrer">{label}</a>);
      i += linkM[0].length; cursor = i; continue;
    }
    const codeM = tryMatch(/`([^`]+)`/y);
    if (codeM) {
      if (cursor < i) push(text.slice(cursor, i));
      out.push(<code key={`${keyPrefix}-${key++}`}>{codeM[1]}</code>);
      i += codeM[0].length; cursor = i; continue;
    }
    const boldM = tryMatch(/\*\*([^*]+)\*\*/y);
    if (boldM) {
      if (cursor < i) push(text.slice(cursor, i));
      out.push(<strong key={`${keyPrefix}-${key++}`}>{boldM[1]}</strong>);
      i += boldM[0].length; cursor = i; continue;
    }
    const italM = tryMatch(/\*([^*]+)\*/y);
    if (italM) {
      if (cursor < i) push(text.slice(cursor, i));
      out.push(<em key={`${keyPrefix}-${key++}`}>{italM[1]}</em>);
      i += italM[0].length; cursor = i; continue;
    }
    i++;
  }
  if (cursor < text.length) push(text.slice(cursor));
  return out;
}

export default function Markdown({ source }) {
  const lines = (source ?? '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    let m;
    if ((m = /^# (.+)$/.exec(line))) { blocks.push(<h1 key={key++}>{renderInline(m[1], `h1-${key}`)}</h1>); i++; continue; }
    if ((m = /^## (.+)$/.exec(line))) { blocks.push(<h2 key={key++}>{renderInline(m[1], `h2-${key}`)}</h2>); i++; continue; }
    if ((m = /^### (.+)$/.exec(line))) { blocks.push(<h3 key={key++}>{renderInline(m[1], `h3-${key}`)}</h3>); i++; continue; }

    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        items.push(<li key={`li-${key}-${items.length}`}>{renderInline(lines[i].slice(2), `li-${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    // Paragraph: gather contiguous non-empty, non-special lines.
    const paragraphLines = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,3} |- )/.test(lines[i])) {
      paragraphLines.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(paragraphLines.join(' '), `p-${key}`)}</p>);
  }

  return <div className="markdown">{blocks}</div>;
}

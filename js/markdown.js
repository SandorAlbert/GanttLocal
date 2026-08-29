// Small safe Markdown subset → HTML for chat assistant bubbles.
// Escapes all input first; only emits tags we control. Links limited to http(s).

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return escapeHtml(u);
  return '';
}

function inlineMarkdown(text) {
  let s = escapeHtml(text);
  // Code spans first (protect contents from further markup)
  s = s.replace(/`([^`]+)`/g, function (_, code) {
    return '<code>' + code + '</code>';
  });
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, url) {
    const href = safeHref(url);
    if (!href) return label;
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // Bold **...** or __...__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic *...* or _..._ (avoid matching inside words for _)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  return s;
}

/**
 * @param {string} src
 * @returns {string} HTML
 */
export function renderMarkdown(src) {
  const text = String(src || '').replace(/\r\n/g, '\n');
  if (!text) return '';

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let para = [];

  function flushPara() {
    if (!para.length) return;
    out.push('<p>' + inlineMarkdown(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      i += 1;
      const codeLines = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
      continue;
    }

    // Blank line ends paragraph
    if (/^\s*$/.test(line)) {
      flushPara();
      i += 1;
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push('<h' + level + '>' + inlineMarkdown(heading[2].trim()) + '</h' + level + '>');
      i += 1;
      continue;
    }

    // Blockquote (single-line / consecutive)
    if (/^>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + inlineMarkdown(quote.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      out.push('<ul>');
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        out.push('<li>' + inlineMarkdown(lines[i].replace(/^[-*]\s+/, '')) + '</li>');
        i += 1;
      }
      out.push('</ul>');
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      out.push('<ol>');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        out.push('<li>' + inlineMarkdown(lines[i].replace(/^\d+\.\s+/, '')) + '</li>');
        i += 1;
      }
      out.push('</ol>');
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return out.join('');
}

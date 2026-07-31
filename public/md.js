// 极简 Markdown 渲染器
// 项目是零依赖的，不为了预览引一个 marked 进来。只覆盖写作场景真正会用到的语法：
// 标题、粗斜体、行内码、代码块、引用、有序/无序列表、分割线、链接、图片、表格。
// 一切输出都先转义再拼，杜绝 XSS。
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 行内语法。顺序有讲究：先把行内码抠出来占位，免得码里的星号被当成加粗。
  function inline(s) {
    const codes = [];
    let t = esc(s).replace(/`([^`]+)`/g, function (m, c) {
      codes.push(c);
      return '@@CODE' + (codes.length - 1) + '@@';
    });
    t = t
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (m, alt, src) {
        return '<img alt="' + alt + '" src="' + src + '">';
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (m, txt, href) {
        return /^(https?:|#|\/)/.test(href)
          ? '<a href="' + href + '" target="_blank" rel="noopener">' + txt + '</a>'
          : txt;
      })
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t.replace(/@@CODE(\d+)@@/g, function (m, i) {
      return '<code>' + codes[+i] + '</code>';
    });
  }

  function tableRow(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
  }

  window.renderMarkdown = function (src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    function flush() {
      if (para.length) {
        out.push('<p>' + para.map(inline).join('<br>') + '</p>');
        para = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      // frontmatter：折起来，不当正文
      if (i === 0 && /^---\s*$/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^---\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        if (buf.length) {
          out.push('<details class="md-fm"><summary>frontmatter</summary><pre>' + esc(buf.join('\n')) + '</pre></details>');
        }
        continue;
      }

      // 代码块
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        flush();
        out.push('<pre class="md-code"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 表格：本行有竖线，且下一行是分隔行
      if (/\|/.test(line) && i + 1 < lines.length &&
          /\|/.test(lines[i + 1]) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const head = tableRow(line);
        i += 2;
        const body = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) body.push(tableRow(lines[i++]));
        out.push(
          '<div class="md-tablewrap"><table><thead><tr>' +
          head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          body.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') +
          '</tbody></table></div>'
        );
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }

      if (/^>\s?/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
        out.push('<ul>' + buf.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push('<ol>' + buf.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ol>');
        continue;
      }

      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return out.join('\n');
  };
})();

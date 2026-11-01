import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,       // Disable HTML tags in source
  xhtmlOut: false,   // Use '/' to close single tags (<br />).
  breaks: true,      // Convert '\n' in paragraphs into <br>
  linkify: true,     // Autoconvert URL-like text to links
  typographer: true,
});

// 中文紧邻书名号/引号时，补足 strong 的边界判断；仍交给原解析器配对，
// 不预先改写源文，转义、代码块、行内代码和链接地址继续由原规则处理。
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const punctuation = /\p{P}/u;
md.inline.ruler.before('emphasis', 'cjk_strong', (state, silent) => {
  if (silent || state.src.slice(state.pos, state.pos + 2) !== '**') return false;
  const scanned = state.scanDelims(state.pos, true);
  if (scanned.length !== 2) return false;
  const before = state.src[state.pos - 1] || '';
  const after = state.src[state.pos + 2] || '';
  const open = scanned.can_open || (cjk.test(before) && punctuation.test(after));
  const close = scanned.can_close || (punctuation.test(before) && cjk.test(after));
  for (let i = 0; i < 2; i++) {
    state.push('text', '', 0).content = '*';
    state.delimiters.push({ marker: 42, length: 2, token: state.tokens.length - 1, end: -1, open, close });
  }
  state.pos += 2;
  return true;
});

// 对话中的普通方向箭头不需要加载数学渲染器；只识别完整、独立的箭头表达式。
const arrows: Record<string, string> = { rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', to: '→' };
md.inline.ruler.before('emphasis', 'plain_math_arrow', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos - 1] === '$') return false;
  const match = /^\$\s*\\(rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|Leftrightarrow|to)\s*\$(?!\$)/.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push('text', '', 0).content = arrows[match[1]];
  state.pos += match[0].length;
  return true;
});

type MarkdownTokenLike = {
  type: string;
  content: string;
  children: MarkdownTokenLike[] | null;
}

const inlineTokenToText = (token: MarkdownTokenLike): string => {
  if (token.children?.length) {
    return token.children.map(inlineTokenToText).join('');
  }
  if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
  if (token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline' || token.type === 'image') {
    return token.content;
  }
  return '';
}

export function renderMarkdown(content: string): string {
  if (!content) return '';
  return md.render(content);
}

export function markdownToPlainText(content: string): string {
  if (!content) return '';

  const blocks: string[] = [];
  const tokens = md.parse(content, {}) as MarkdownTokenLike[];

  for (const token of tokens) {
    if (token.type === 'inline') {
      const text = inlineTokenToText(token);
      if (text) blocks.push(text);
    } else if (token.type === 'fence' || token.type === 'code_block' || token.type === 'html_block') {
      if (token.content) blocks.push(token.content);
    }
  }

  // 正文粘贴只取 Markdown 的可见文本，纯标记内容保留原文避免整段丢失。
  return blocks.join('\n\n').trim() || content.trim();
}

/**
 * @description 文本清洗函数：规范化文本中的空格和标点符号
 * @param {String} text 需要清洗的文本
 * @returns {String} 清洗后的文本
 */
// ProseMirror 文档与节点在此当最小结构使用，避免引入完整类型链
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canSplitDoc(doc: any, pos: number, depth = 1, typesAfter?: any) {
  const $pos = doc.resolve(pos);
  const base = $pos.depth - depth;
  const innerType = (typesAfter && typesAfter[typesAfter.length - 1]) || $pos.parent;
  if (
    base < 0 ||
    $pos.parent.type.spec.isolating ||
    !$pos.parent.canReplace($pos.index(), $pos.parent.childCount) ||
    !innerType.type.validContent($pos.parent.content.cutByIndex($pos.index(), $pos.parent.childCount))
  ) {
    return false;
  }

  for (let d = $pos.depth - 1, i = depth - 2; d > base; d--, i--) {
    const node = $pos.node(d);
    const index = $pos.index(d);
    if (node.type.spec.isolating) return false;

    let rest = node.content.cutByIndex(index, node.childCount);
    const overrideChild = typesAfter && typesAfter[i + 1];
    if (overrideChild) rest = rest.replaceChild(0, overrideChild.type.create(overrideChild.attrs));

    const after = (typesAfter && typesAfter[i]) || node;
    if (!node.canReplace(index + 1, node.childCount) || !after.type.validContent(rest)) return false;
  }

  const index = $pos.indexAfter(base);
  const baseType = typesAfter && typesAfter[0];
  return $pos.node(base).canReplaceWith(index, index, baseType ? baseType.type : $pos.node(base + 1).type);
}

export function normalizeText(text: string): string {
  let s = text;

  // 1. 统一换行符（避免 Windows \r\n 造成位置/匹配异常）
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. 统一将全角空格、制表符转为普通空格；段内不换行空格保留。
  s = s.replace(/[\u3000\t]/g, ' ');

  // 3. 将连续的多个空格合并为一个（针对英文单词间）
  s = s.replace(/[ ]{2,}/g, ' ');

  // 4. 去除中文标点前后的“普通空格”（不要误删换行/段落分隔）
  s = s.replace(/[ \t]+([，。！？；：、)】》"''])/g, '$1'); // 标点前
  s = s.replace(/([（【《"''])[ \t]+/g, '$1');           // 标点后

  // 5. 去除两个中文字符之间的“普通空格” (防止"你 好"这种情况)
  // [^\x00-\xff] 匹配非ASCII字符（通常是中文/日文等）——控制符区间是刻意的
  // eslint-disable-next-line no-control-regex
  s = s.replace(/([^\x00-\xff])[ \t]+([^\x00-\xff])/g, '$1$2');

  return s;
}

/**
 * @description 格式化编辑器内容：删除空行并规范化文本格式
 * @param {Object} editor ProseMirror 编辑器实例
 * @returns {void}
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Editor 实例，见文件头说明
export function formatEditorContent(editor: any): void {
  if (!editor) return;

  const { state, view } = editor;
  const tr = state.tr;

  // 存储所有变更操作，最后统一从后往前应用
  const changes: { type: 'delete' | 'insert'; from: number; to: number; text?: string }[] = [];

  // 0) 先把“软换行/回车”规范成真正的段落，避免一键排版把换行吃掉导致段落合并
  const breakOps: { kind: 'hardBreak' | 'newline'; from: number; to?: number }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Node
  state.doc.descendants((node: any, pos: number) => {
    // TipTap StarterKit: HardBreak 的节点名为 hardBreak
    if (node.type?.name === 'hardBreak') {
      breakOps.push({ kind: 'hardBreak', from: pos });
      return;
    }

    if (node.isText) {
      const t: string = node.text || '';
      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === '\r') {
          if (t[i + 1] === '\n') {
            breakOps.push({ kind: 'newline', from: pos + i, to: pos + i + 2 });
            i += 1;
          } else {
            breakOps.push({ kind: 'newline', from: pos + i, to: pos + i + 1 });
          }
        } else if (ch === '\n') {
          breakOps.push({ kind: 'newline', from: pos + i, to: pos + i + 1 });
        }
      }
    }
  });

  if (breakOps.length) {
    breakOps.sort((a, b) => b.from - a.from);
    for (const op of breakOps) {
      if (op.kind === 'hardBreak') {
        // 先判断是否能 split；不能 split 就保留 <br>，避免误删换行
        if (!canSplitDoc(tr.doc, op.from)) continue;
        tr.delete(op.from, op.from + 1);
        tr.split(op.from);
      } else {
        const to = op.to ?? op.from + 1;
        if (!canSplitDoc(tr.doc, op.from)) continue;
        tr.delete(op.from, to);
        tr.split(op.from);
      }
    }
  }

  // 首行缩进由显示设置控制，排版只清理段首空白，避免与 CSS 缩进叠加。
  let atParagraphStart = false;

  // 使用 descendants 遍历所有节点（基于已转换后的 doc）
  // 返回 false 可以跳过该节点的子节点遍历
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Node
  tr.doc.descendants((node: any, pos: number, parent: any) => {
    // --- 1. 处理空行 (段落节点) ---
    if (node.type.name === 'paragraph') {
      // 获取段落的纯文本内容并去除空白（包含 \u00A0 缩进空格）
      const textContent = node.textContent || '';
      const meaningful = textContent.replace(/[\s\u00A0\u3000]/g, '');

      // 如果段落为空，或者只包含不可见字符
      if (!meaningful.length) {
        // 记录删除操作：删除整个段落节点
        changes.push({
          type: 'delete',
          from: pos,
          to: pos + node.nodeSize
        });
        // 已决定删除该段落，无需遍历其子节点(text)
        return false;
      }

      atParagraphStart = true;
    } else if (parent?.type.name === 'paragraph' && !node.isText) {
      // 不跨过行内节点清理空白，保留其后的正文间隔。
      atParagraphStart = false;
    }

    // --- 2. 处理文本内容 (文本节点) ---
    if (node.isText) {
      const before = node.text || '';
      const source = parent?.type.name === 'paragraph' && atParagraphStart
        ? before.replace(/^[\u00A0\u3000\t ]+/, '')
        : before;
      if (source.length) atParagraphStart = false;
      const after = normalizeText(source);

      // 如果清洗后的文本与原文本不同，记录修改
      if (after !== before) {
        changes.push({
          type: 'insert',
          from: pos,
          to: pos + before.length,
          text: after
        });
      }
    }
  });

  if (!breakOps.length && !changes.length) return;

  // 【关键】按照位置从后往前排序，防止前面的修改导致后面的坐标偏移
  changes.sort((a, b) => b.from - a.from);

  // 应用修改
  changes.forEach((change) => {
    if (change.type === 'delete') {
      tr.delete(change.from, change.to);
    } else if (change.type === 'insert' && change.text !== undefined) {
      // 使用 insertText 替换原有范围的文本
      tr.insertText(change.text, change.from, change.to);
    }
  });

  if (tr.docChanged) {
    view.dispatch(tr);
  }
}

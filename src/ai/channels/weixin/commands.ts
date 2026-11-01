/**
 * 微信里的斜杠命令：不经过模型，直接由通道层处理。
 * 「确认 / 取消」不带斜杠也认，因为它们是写操作握手的一部分。
 */

export type WeixinCommandName = 'help' | 'books' | 'book' | 'status' | 'clear' | 'confirm' | 'cancel' | 'stop'

export interface WeixinCommand {
  name: WeixinCommandName
  /** 命令参数，如「/作品 2」里的 2 */
  arg: string
}

/** 「保存」也算确认：续写、改稿的第二步就是把预览过的稿子存进去 */
const CONFIRM_WORDS = new Set(['确认', '确定', '是', '好', '好的', '保存', '存', 'ok', 'OK', 'yes', 'y'])
const CANCEL_WORDS = new Set(['取消', '算了', '不', '不用', '丢弃', '不要了', 'no', 'n'])

const SLASH_COMMANDS: Array<{ name: WeixinCommandName; aliases: string[] }> = [
  { name:'stop', aliases:['停止','stop'] },
  { name: 'help', aliases: ['帮助', 'help', '?', '？'] },
  { name: 'books', aliases: ['作品列表', '书单'] },
  { name: 'book', aliases: ['作品', '切换作品', '书', 'book'] },
  { name: 'status', aliases: ['状态', 'status'] },
  { name: 'clear', aliases: ['新对话', '新会话', '清空', '重置', 'new', 'clear', 'reset'] },
  { name: 'confirm', aliases: ['确认', 'confirm'] },
  { name: 'cancel', aliases: ['取消', 'cancel'] },
]

export const parseWeixinCommand = (input: string): WeixinCommand | null => {
  const text = String(input || '').trim()
  if (!text) return null
  if (CONFIRM_WORDS.has(text)) return { name: 'confirm', arg: '' }
  if (CANCEL_WORDS.has(text)) return { name: 'cancel', arg: '' }
  if (!text.startsWith('/') && !text.startsWith('／')) return null

  const body = text.slice(1).trim()
  const [head = '', ...rest] = body.split(/\s+/)
  const arg = rest.join(' ').trim()
  for (const command of SLASH_COMMANDS) {
    if (command.aliases.includes(head)) {
      // 「/作品」不带参数等同列出作品
      if (command.name === 'book' && !arg) return { name: 'books', arg: '' }
      return { name: command.name, arg }
    }
  }
  return { name: 'help', arg: body }
}

export const WEIXIN_HELP_TEXT = [
  '我是易创的微信助手，可以直接用自然语言问我，例如：',
  '· 看看番茄男频榜单现在什么题材热',
  '· 给我三个都市脑洞方向',
  '· 这本书里主角现在到哪一步了',
  '· 帮我新建一本都市高武的书，叫《××》',
  '· 在第二卷下新建一章「夜袭」，章纲是……',
  '· 给第 12 章续写 2000 字，写主角进城后的冲突',
  '· 记住：我更喜欢简洁直接的叙述',
  '',
  '常用命令：',
  '/作品 查看作品列表，/作品 2 切换到第 2 本',
  '/状态 查看当前作品与连接状态',
  '/停止 停止当前微信对话的执行',
  '/新对话 开始新的对话（之前的对话在电脑端还能看）',
  '/帮助 显示本说明',
  '',
  '通过 Agent 处理消息。问题与确认会转为编号选项；候选稿会发送预览和全文文件，确认采用后才保存。应用需保持运行，关闭应用后不会继续执行。',
].join('\n')

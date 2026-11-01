/**
 * 旧版（2026-08 批Z 简版）默认提示词的文本指纹。
 *
 * 2026-08-30 老服务端提示词全量回迁后，默认值整体换代。用户目录里可能躺着
 * 按旧默认值生成、但从未被用户修改过的 md 段落——装载时命中这些指纹的段落
 * 视为"未修改"，自动升级为新默认值；用户真正改过的文本不受影响。
 * 指纹由旧 defaults 文件的每个 defaultText.trim() 经 djb2 哈希生成。
 * 之后每次修改某个默认文本，都要把它改前的指纹补进来，否则已生成的 md 文件不会升级。
 * 这里只登记"已经不是现行默认值"的文本：现行默认值的指纹不该出现（tests/prompt-default-upgrade 有守卫），
 * 否则一段没改过的默认值会被按"旧版"原样"升级"一遍，掩盖登记遗漏。
 */
export const LEGACY_PROMPT_TEXT_HASHES = new Set<string>([
  'lxx9v6', '9vqtvy', '1x78phq', '1s3c6eh', 'dkkcfu', 'rj7t7', '1lauauv', 'qra2qa',
  '18cdp5s', '521rsf', '1eurlzn', '3qhfsc',
  'wz7ctp', 'jg35hw', 'c37lg9', '1v3zaq7', '1vv7umc', 'ts9cyw', 'woul96', '1kvwkm8',
  'x6cmu',
  '39usig', 'q3pc5g', '1k65k1y', '156xp6h', '1tgmjhi',
  'guy0c', '7gyh2a', '1tbf2lw',
  'ju5e2k', '1dkwklb', 'zzxvyw', 'xm8lat', '1136fi0', '76sl14', '1n76ufq', '1lrim6n', 'x748ra', '23exfd', '3j7yfm',
  'il0e6v',
  // 2026-10-26 蒸馏第三版：system、章卡三段、书级归纳形状（去 voice）
  'sg1de2', '1gwo144', '1h0loyt', '77xlj9', '6rufd7',
  // 2026-10-31 逐章生文按目标字数定拍数和篇幅上限：细纲补充、正文系统设定、从头生成任务
  'nr3rrn', '1md348m', '1k0xfvp',
])

/** djb2 字符串哈希（与指纹生成脚本一致） */
export const hashPromptText = (text: string): string => {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

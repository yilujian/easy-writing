/** 发往聊天通道的文件与图片：base64 与文件名的通用处理，微信适配器与网页桥执行器共用。 */

export const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  // 分块拼：一次 fromCharCode 展开几 MB 会把参数表撑爆
  const CHUNK = 0x8000
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

export const textToBase64 = (value: string) => bytesToBase64(new TextEncoder().encode(value))

/** 文件名里去掉系统不认的字符（路径分隔符、通配符、控制字符） */
export const safeFileName = (name: string, fallback = 'export') =>
  String(name || '')
    .trim()
    .replace(/\p{Cc}/gu, '')
    .replace(/[\\/:*?"<>|]/g, '_') || fallback

/**
 * 与宿主 `writing_review::fingerprint` 同口径：sha256 的前 16 个十六进制字符。
 * 前端用它判断体检报告是否还对应面板里的正文；算法必须与 Rust 侧一致。
 * WebCrypto 只在安全上下文可用，不可用时返回空串，调用方按“无法判断”处理。
 */
export const fingerprintText = async (text: string): Promise<string> => {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16)
  } catch {
    return ''
  }
}

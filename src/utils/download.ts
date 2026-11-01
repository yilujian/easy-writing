import { notifyPetActivity } from '@/desktop-pet/events'
const isTauriRuntime = () => {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ || (window as unknown as Record<string, unknown>).__TAURI__)
}

const getFileExtension = (filename: string) => {
  const match = String(filename || '').match(/\.([a-z0-9]+)$/i)
  return match?.[1]?.toLowerCase() || ''
}

const getFilterName = (extension: string) => {
  const value = extension.toLowerCase()
  if (value === 'txt') return 'TXT 文本'
  if (value === 'doc' || value === 'docx') return 'Word 文档'
  if (value === 'zip') return 'ZIP 压缩包'
  if (value === 'xlsx') return 'Excel 文件'
  if (value === 'json') return 'JSON 文件'
  if (value === 'png' || value === 'jpg' || value === 'jpeg' || value === 'webp') return '图片'
  return '文件'
}

const saveBlobInBrowser = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const saveBlobFile = async (blob: Blob, filename: string) => {
  if (!isTauriRuntime()) {
    saveBlobInBrowser(blob, filename)
    return true
  }

  const extension = getFileExtension(filename)
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { invoke } = await import('@tauri-apps/api/core')
  const filePath = await save({
    title: '保存导出文件',
    defaultPath: filename,
    filters: extension
      ? [{ name: getFilterName(extension), extensions: [extension] }]
      : undefined,
  })

  if (!filePath) return false

  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  try {
    await invoke('write_export_file', { filePath, bytes })
    notifyPetActivity({ id: 'export', phase: 'done', message: '文件已导出。', target: 'current' })
  } catch (error) {
    notifyPetActivity({ id: 'export', phase: 'error', message: '文件导出失败，请回到平台重试。', target: 'current' })
    throw error
  }
  return true
}

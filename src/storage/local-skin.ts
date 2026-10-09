import { withRecordStore } from './desktop-records'
/**
 * 自定义背景图本地存储：图片以 dataURL 存 IndexedDB。
 * 不用 localStorage 是因为 10MB 级的图会撞它的容量上限。
 */

const DB_NAME = 'ew-skin-store'
const STORE_NAME = 'kv'
const CUSTOM_SKIN_KEY = 'customSkinImage'

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, undefined, mode, run)

export const saveCustomSkinImage = async (dataUrl: string) => {
  await withStore('readwrite', store => store.put(dataUrl, CUSTOM_SKIN_KEY))
}

/**
 * 没有自定义背景记录时返回 null；读取失败（附件缺失、库暂时不可用）抛错。
 * 两者必须分开：前者可以回落默认皮肤并写回设置，后者只能本次先用默认图，不能改写用户的选择。
 */
export const loadCustomSkinImage = async (): Promise<string | null> => {
  const value = await withStore<unknown>('readonly', store => store.get(CUSTOM_SKIN_KEY))
  return typeof value === 'string' && value ? value : null
}

export const clearCustomSkinImage = async () => {
  try {
    await withStore('readwrite', store => store.delete(CUSTOM_SKIN_KEY))
  } catch (error) {
    console.warn('清除自定义背景失败', error)
  }
}

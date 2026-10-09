/** 取消等待时丢弃迟到结果；底层支持 AbortSignal 的传输同时终止请求。 */
export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError')
}

export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('操作已取消', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

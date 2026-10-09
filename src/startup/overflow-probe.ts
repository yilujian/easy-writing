import type { Router } from 'vue-router'

/**
 * 开发态横向溢出探针：页面内容比内容区宽就在控制台报出来，越界当场发现，不等用户截图。
 * 只在 import.meta.env.DEV 下挂载；生产构建不含这段代码。
 */
export function installOverflowProbe(router: Router, selector = '.content-wrapper') {
  let timer = 0
  const check = (reason: string) => {
    const wrapper = document.querySelector<HTMLElement>(selector)
    if (!wrapper) return
    const overflow = wrapper.scrollWidth - wrapper.clientWidth
    if (overflow <= 0) return
    const widest = Array.from(wrapper.querySelectorAll<HTMLElement>('*'))
      .filter(el => el.getBoundingClientRect().right > wrapper.getBoundingClientRect().right + 1)
      .slice(0, 5)
    console.warn(
      `[overflow-probe] ${router.currentRoute.value.path} 内容区横向溢出 ${overflow}px（${reason}，内容区宽 ${wrapper.clientWidth}px）`,
      widest
    )
  }
  const schedule = (reason: string) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => requestAnimationFrame(() => check(reason)), 300)
  }
  router.afterEach(() => schedule('路由切换'))
  window.addEventListener('resize', () => schedule('窗口尺寸变化'))
  schedule('初次挂载')
}

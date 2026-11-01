import { createApp } from 'vue'
import '@/styles/themes.scss'
import PetWindow from './PetWindow.vue'

// 桌宠不走书库初始化、Pinia 业务 Store、全局备份或 Agent 执行器。
document.getElementById('ew-boot')?.remove()
document.documentElement.classList.add('desktop-pet-root', 'theme-new')
createApp(PetWindow).mount('#app')

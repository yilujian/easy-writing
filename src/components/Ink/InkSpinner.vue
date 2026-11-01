<template>
  <div class="ink-spinner-container" :style="{ width: size, height: size }">
    <!-- 动态绑定 Filter ID -->
    <div class="ink-spinner" :style="{ filter: `url(#${filterId})` }">
      <div class="ink-dot" :style="{ backgroundColor: color }"></div>
      <div class="ink-dot" :style="{ backgroundColor: color }"></div>
    </div>

    <!-- SVG 滤镜定义 (隐藏) -->
    <svg style="position: absolute; width: 0; height: 0; visibility: hidden;">
      <defs>
        <filter :id="filterId">
          <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>

    <!-- 可选：下方文字 -->
    <div v-if="text" class="loading-text">{{ text }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

defineProps({
  size: { type: String, default: '80px' },
  color: { type: String, default: '#1a1a1a' }, // 墨色
  text: { type: String, default: '' }
});

// 生成唯一ID，防止页面多个组件时滤镜失效
const filterId = computed(() => `ink-goo-${Math.random().toString(36).substr(2, 9)}`);
</script>

<style scoped lang="scss">
.ink-spinner-container {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.ink-spinner {
  width: 100%;
  height: 100%;
  position: relative;
  animation: rotate 3s linear infinite;
}

.ink-dot {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  margin: auto;
  border-radius: 50%;
  filter: blur(6px);
  /* 配合 SVG 滤镜实现融合 */
}

.ink-dot:nth-child(1) {
  width: 50%;
  height: 50%;
  transform: translateY(-25%);
  animation: pulse-ink 2s ease-in-out infinite alternate;
}

.ink-dot:nth-child(2) {
  width: 30%;
  height: 30%;
  transform: translateY(30%);
  opacity: 0.8;
  animation: pulse-ink 2s ease-in-out infinite alternate-reverse;
}

.loading-text {
  position: absolute;
  top: 100%;
  margin-top: 10px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  color: v-bind(color);
  opacity: 0.8;
  white-space: nowrap;
}

@keyframes rotate {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

@keyframes pulse-ink {
  0% {
    transform: translateY(-20px) scale(1);
    border-radius: 50%;
  }

  50% {
    transform: translateY(-5px) scale(1.2);
    border-radius: 40% 60% 70% 30% / 40% 50% 60% 50%;
  }

  100% {
    transform: translateY(-20px) scale(1);
    border-radius: 50%;
  }
}
</style>

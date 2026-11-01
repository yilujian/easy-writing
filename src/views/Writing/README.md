# 写作页面 (Writing Page)

## 功能概述

沉浸式写作页面，完美还原设计稿，支持多主题切换。

妙笔使用独立的本地对话存储与文本辅助模型，支持章节关联、编辑器选区、相关角色资料和四种顾问模式。续写与划词处理各自直接调用文本辅助模型；这些功能不创建 Agent 会话，也不触发 Agent 任务或生成后的自动改稿。

## 页面结构

```
src/views/Writing/
├── index.vue                    # 主页面
├── components/
│   ├── WritingHeader.vue       # 顶部导航栏
│   ├── WritingSidebar.vue      # 左侧目录边栏（支持收起/展开）
│   ├── WritingEditor.vue       # 中间编辑器
│   └── WritingRightPanel.vue   # 右侧面板
└── README.md
```

## 主题支持

项目支持 4 种主题，样式定义在 `src/styles/themes.scss`（统一管理全局和写作页主题）：

1. **无界通透版 (new)** - 默认主题，简洁现代
2. **古韵信笺版 (yellow)** - 暖色调，类似羊皮纸效果
3. **森系护眼版 (green)** - 绿色护眼，豆沙绿编辑区
4. **暗夜水墨版 (dark)** - 深色主题，适合夜间使用

### 主题切换

#### 使用主题 Store
页面使用 `useThemeStore()` 统一管理主题，支持：
- 右下角主题切换器实时切换
- 主题自动保存到 localStorage
- 全平台统一样式变量

```typescript
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
themeStore.switchTheme('dark') // 切换到暗夜主题
```

### 自定义主题

#### 1. 在 `src/styles/themes.scss` 中添加新主题类：

```scss
.theme-custom {
  /* 基础颜色 */
  --ink-main: #your-main-color;
  --ink-sec: #your-secondary-color;
  --ink-accent: #your-accent-color;
  --bg-main: #your-bg-color;

  /* 按钮变量 */
  --btn-primary-bg: var(--ink-main);
  --btn-primary-hover-bg: #your-hover-color;

  /* 输入框变量 */
  --input-bg: rgba(255, 255, 255, 0.3);
  --input-focus-bg: rgba(255, 255, 255, 0.7);

  /* 面板变量 */
  --panel-header-bg: rgba(255, 255, 255, 0.1);
  --toolbar-bg: rgba(255, 255, 255, 0.1);

  // ... 参考其他主题定义完整变量
}
```

#### 2. 在 `src/stores/theme.ts` 中注册主题：

```typescript
const themeConfigs: Record<string, ThemeConfig> = {
  // ... 现有主题
  custom: {
    value: 'custom',
    label: '自定义主题',
    icon: 'fa-solid fa-palette',
    colors: {
      main: '#your-main-color',
      secondary: '#your-secondary-color',
      accent: '#your-accent-color',
      bg: '#your-bg-color'
    },
    backgroundImage: 'your-image-url',
    filter: 'your-filter',
    opacity: 0.15
  }
}
```

### 主题变量说明

所有组件都使用 CSS 变量，无需单独定义主题样式：

- `--ink-main` - 主要文字颜色
- `--ink-sec` - 次要文字颜色
- `--ink-accent` - 强调色
- `--btn-primary-bg` - 主按钮背景
- `--btn-ghost-bg` - 幽灵按钮背景
- `--input-bg` - 输入框背景
- `--panel-header-bg` - 面板头部背景
- `--toolbar-bg` - 工具栏背景
- 等等... 详见 `themes.scss`

## 路由配置

```typescript
{
  path: '/writing/:bookId',
  name: 'Writing',
  component: () => import('@/views/Writing/index.vue'),
  meta: { title: '写作', requiresAuth: true }
}
```

### 从其他页面跳转

```typescript
import { useRouter } from 'vue-router'

const router = useRouter()

// 跳转到写作页面
router.push({
  name: 'Writing',
  params: { bookId: '1' }
})
```

## 组件功能

### WritingHeader
- 显示书籍标题、标签
- 显示字数统计
- 工具按钮（查找、取名、画师、历史）
- 发布按钮

### WritingSidebar
- 全书搜索
- 新建章节/卷
- 目录树展示
- **支持收起/展开**（点击右侧按钮）
- 卷的折叠状态按书记在本地设置（`composables/catalog-folds.ts`）：改名、新建、删除后重载目录不改变折叠；重新进书按上次离开时恢复，没记录的书只展开当前章所在的卷；新建章、新建卷只展开目标卷
- 目录里的"导入章节"追加到当前书：新建书自带的壳（一个卷、只有空章）由 txt 的第一卷直接住进去（改卷名、清空章），不另开卷；有内容的书按卷名追加、其余新建卷
- 章、卷的序号由本地库在新建时接在同级末尾（`nextSortNo`）；进书时 `repairLocalChapterOrder` 把旧数据里序号为 0 的章按创建时间归位一次，不改修改时间
- 章节选择

### WritingEditor
- 富文本编辑器
- 工具栏（字体、背景、撤销/重做、排版、插入）
- 全屏/闭关模式
- 底部状态栏（字数统计、计划等）

### WritingRightPanel
- 多功能面板（大纲、角色、设定等）
- 目录树导航
- 字数统计

## 样式特点

1. **背景层**：使用固定背景图 + 纸张纹理叠加
2. **渐变分割线**：边框采用渐变效果，由浓到淡
3. **玻璃拟态**：部分区域使用 backdrop-filter 实现毛玻璃效果
4. **响应式**：所有组件自适应主题色彩
5. **滚动条美化**：自定义滚动条样式，融入整体设计

## 注意事项

1. **背景图片**：当前使用云端图片，生产环境建议本地化
2. **主题切换器**：生产环境应删除右下角的主题切换器
3. **字体**：需要引入 "Noto Serif SC" 字体以获得最佳效果
4. **Font Awesome**：需要在项目中引入 Font Awesome 图标库

## TODO

- [ ] 实现编辑器的撤销/重做功能
- [ ] 实现全屏/闭关模式
- [ ] 连接后端 API 保存内容
- [ ] 实现章节切换
- [ ] 实现右侧面板的功能切换
- [ ] 添加自动保存功能
- [ ] 实现查找替换功能

<template>
  <EwModal
v-model:visible="visible" title="快速取名" width="800px" custom-class="name-generator-modal fusion-card"
    :close-on-click-modal="false" append-to-body draggable :modal="false">
    <div class="generator-container">
      <!-- 左侧：类型与配置 -->
      <div class="config-panel">
        <!-- 侧边导航 (垂直 Tabs) -->
        <div class="category-sidebar">
          <div
v-for="cat in categories" :key="cat.value" class="category-item"
            :class="{ active: currentCategory === cat.value }" @click="currentCategory = cat.value">
            {{ cat.label }}
          </div>
        </div>

        <!-- 配置表单 -->
        <div class="config-form">
          <!-- 动态表单项 -->
          <template v-if="currentCategory === 'person'">
            <div class="form-item">
              <el-select
v-model="config.person.region" placeholder="选择地区" class="ink-select"
                popper-class="ink-select-popper">
                <el-option label="中国" value="cn" />
                <el-option label="西方" value="en" />
                <el-option label="日本" value="jp" />
              </el-select>
            </div>

            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.person.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="现代" value="modern" />
                  <el-option label="古代" value="ancient" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.person.reference" placeholder="参考" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="不参考" value="none" />
                  <el-option label="诗词" value="poem" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">性别</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.person.gender === 'male' }"
                  @click="config.person.gender = 'male'">男</div>
                <div
class="radio-item" :class="{ active: config.person.gender === 'female' }"
                  @click="config.person.gender = 'female'">女</div>
                <div
class="radio-item" :class="{ active: config.person.gender === 'unknown' }"
                  @click="config.person.gender = 'unknown'">中性</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数 (不含姓氏)</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.person.wordCount === 0 }"
                  @click="config.person.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.person.wordCount === 1 }"
                  @click="config.person.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.person.wordCount === 2 }"
                  @click="config.person.wordCount = 2">2字</div>
              </div>
            </div>

            <div class="form-item">
              <div class="label-row">
                <label class="form-label">姓氏 (选填)</label>
                <div class="helper-links">
                  <span @click="setRandomSurname('single')">单姓</span>
                  <span @click="setRandomSurname('double')">复姓</span>
                </div>
              </div>
              <input type="text" class="input-ink" v-model="config.person.surname" placeholder="仅支持汉字" maxlength="8">
            </div>

            <div class="form-item">
              <div class="label-row">
                <label class="form-label">具体要求</label>
                <!-- <span class="limit-hint">剩余 {{ 666 }} 次机会</span> -->
              </div>
              <textarea
class="input-ink textarea-ink" v-model="config.person.requirement"
                placeholder="输入具体要求，如：性格冷酷，五行属火..." rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.person.requirement.length }}/150</div>
            </div>

            <!-- <div class="hint-text">* 输入内容仅用于即时响应，无任何AI训练</div> -->
          </template>

          <!-- 其他类型占位 -->
          <template v-else-if="currentCategory === 'location'">
            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.location.style" placeholder="风格" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="中国风格" value="cn" />
                  <el-option label="西方奇幻" value="western" />
                  <el-option label="日式和风" value="jp" />
                  <el-option label="克苏鲁" value="cthulhu" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.location.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="古代/玄幻" value="ancient" />
                  <el-option label="现代/都市" value="modern" />
                  <el-option label="未来/科幻" value="future" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">地点类型</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.location.type === 'city' }"
                  @click="config.location.type = 'city'">城镇</div>
                <div
class="radio-item" :class="{ active: config.location.type === 'nature' }"
                  @click="config.location.type = 'nature'">自然</div>
                <div
class="radio-item" :class="{ active: config.location.type === 'sect' }"
                  @click="config.location.type = 'sect'">宗门</div>
                <div
class="radio-item" :class="{ active: config.location.type === 'dungeon' }"
                  @click="config.location.type = 'dungeon'">秘境</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数限制</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.location.wordCount === 0 }"
                  @click="config.location.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.location.wordCount === 1 }"
                  @click="config.location.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.location.wordCount === 2 }"
                  @click="config.location.wordCount = 2">2字</div>
                <div
class="radio-item" :class="{ active: config.location.wordCount === 3 }"
                  @click="config.location.wordCount = 3">3字</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">包含字/后缀 (选填)</label>
              <input
type="text" class="input-ink" v-model="config.location.suffix" placeholder="如：城、谷、峰、神域"
                maxlength="10">
            </div>

            <div class="form-item">
              <label class="form-label">具体要求</label>
              <textarea
class="input-ink textarea-ink" v-model="config.location.requirement"
                placeholder="输入具体描述，如：环境恶劣，终年积雪..." rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.location.requirement.length }}/150</div>
            </div>
          </template>

          <template v-else-if="currentCategory === 'faction'">
            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.faction.style" placeholder="风格" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="中国风格" value="cn" />
                  <el-option label="西方奇幻" value="western" />
                  <el-option label="日式和风" value="jp" />
                  <el-option label="克苏鲁" value="cthulhu" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.faction.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="古代/玄幻" value="ancient" />
                  <el-option label="现代/都市" value="modern" />
                  <el-option label="未来/科幻" value="future" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">势力性质</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.faction.nature === 'good' }"
                  @click="config.faction.nature = 'good'">正道</div>
                <div
class="radio-item" :class="{ active: config.faction.nature === 'evil' }"
                  @click="config.faction.nature = 'evil'">魔道</div>
                <div
class="radio-item" :class="{ active: config.faction.nature === 'court' }"
                  @click="config.faction.nature = 'court'">朝廷</div>
                <div
class="radio-item" :class="{ active: config.faction.nature === 'family' }"
                  @click="config.faction.nature = 'family'">家族</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数限制</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.faction.wordCount === 0 }"
                  @click="config.faction.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.faction.wordCount === 1 }"
                  @click="config.faction.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.faction.wordCount === 2 }"
                  @click="config.faction.wordCount = 2">2字</div>
                <div
class="radio-item" :class="{ active: config.faction.wordCount === 3 }"
                  @click="config.faction.wordCount = 3">3字</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">势力后缀 (选填)</label>
              <input
type="text" class="input-ink" v-model="config.faction.suffix" placeholder="如：宗、派、盟、世家"
                maxlength="10">
            </div>

            <div class="form-item">
              <label class="form-label">具体要求</label>
              <textarea
class="input-ink textarea-ink" v-model="config.faction.requirement"
                placeholder="输入具体描述，如：性格冷酷，五行属火..." rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.faction.requirement.length }}/150</div>
            </div>
          </template>

          <template v-else-if="currentCategory === 'skill'">
            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.skill.style" placeholder="风格" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="中国风格" value="cn" />
                  <el-option label="西方奇幻" value="western" />
                  <el-option label="日式和风" value="jp" />
                  <el-option label="克苏鲁" value="cthulhu" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.skill.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="古代/玄幻" value="ancient" />
                  <el-option label="现代/都市" value="modern" />
                  <el-option label="未来/科幻" value="future" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">功法类别</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.skill.type === 'sword' }"
                  @click="config.skill.type = 'sword'">剑法</div>
                <div
class="radio-item" :class="{ active: config.skill.type === 'blade' }"
                  @click="config.skill.type = 'blade'">刀法</div>
                <div
class="radio-item" :class="{ active: config.skill.type === 'fist' }"
                  @click="config.skill.type = 'fist'">拳掌</div>
                <div
class="radio-item" :class="{ active: config.skill.type === 'inner' }"
                  @click="config.skill.type = 'inner'">内功</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数限制</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.skill.wordCount === 0 }"
                  @click="config.skill.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.skill.wordCount === 1 }"
                  @click="config.skill.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.skill.wordCount === 2 }"
                  @click="config.skill.wordCount = 2">2字</div>
                <div
class="radio-item" :class="{ active: config.skill.wordCount === 3 }"
                  @click="config.skill.wordCount = 3">3字</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">核心属性 (选填)</label>
              <input
type="text" class="input-ink" v-model="config.skill.attribute" placeholder="如：火、雷、快、霸道"
                maxlength="10">
            </div>

            <div class="form-item">
              <label class="form-label">具体要求</label>
              <textarea
class="input-ink textarea-ink" v-model="config.skill.requirement"
                placeholder="输入具体描述，如：性格冷酷，五行属火..." rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.skill.requirement.length }}/150</div>
            </div>
          </template>

          <template v-else-if="currentCategory === 'equipment'">
            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.equipment.style" placeholder="风格" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="中国风格" value="cn" />
                  <el-option label="西方奇幻" value="western" />
                  <el-option label="日式和风" value="jp" />
                  <el-option label="克苏鲁" value="cthulhu" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.equipment.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="古代/玄幻" value="ancient" />
                  <el-option label="现代/都市" value="modern" />
                  <el-option label="未来/科幻" value="future" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">装备部位</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.equipment.slot === 'weapon' }"
                  @click="config.equipment.slot = 'weapon'">武器</div>
                <div
class="radio-item" :class="{ active: config.equipment.slot === 'armor' }"
                  @click="config.equipment.slot = 'armor'">防具</div>
                <div
class="radio-item" :class="{ active: config.equipment.slot === 'accessory' }"
                  @click="config.equipment.slot = 'accessory'">饰品</div>
                <div
class="radio-item" :class="{ active: config.equipment.slot === 'artifact' }"
                  @click="config.equipment.slot = 'artifact'">法宝</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数限制</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.equipment.wordCount === 0 }"
                  @click="config.equipment.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.equipment.wordCount === 1 }"
                  @click="config.equipment.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.equipment.wordCount === 2 }"
                  @click="config.equipment.wordCount = 2">2字</div>
                <div
class="radio-item" :class="{ active: config.equipment.wordCount === 3 }"
                  @click="config.equipment.wordCount = 3">3字</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">材质/品阶 (选填)</label>
              <input
type="text" class="input-ink" v-model="config.equipment.material" placeholder="如：玄铁、神级、上古"
                maxlength="10">
            </div>

            <div class="form-item">
              <label class="form-label">具体要求</label>
              <textarea
class="input-ink textarea-ink" v-model="config.equipment.requirement"
                placeholder="输入具体描述，如：性格冷酷，五行属火..." rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.equipment.requirement.length }}/150</div>
            </div>
          </template>

          <template v-else-if="currentCategory === 'monster'">
            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.monster.style" placeholder="风格" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="中国风格" value="cn" />
                  <el-option label="西方奇幻" value="western" />
                  <el-option label="日式和风" value="jp" />
                  <el-option label="克苏鲁" value="cthulhu" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.monster.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="古代/玄幻" value="ancient" />
                  <el-option label="现代/都市" value="modern" />
                  <el-option label="未来/科幻" value="future" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">种族分类</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.monster.species === 'beast' }"
                  @click="config.monster.species = 'beast'">走兽</div>
                <div
class="radio-item" :class="{ active: config.monster.species === 'bird' }"
                  @click="config.monster.species = 'bird'">飞禽</div>
                <div
class="radio-item" :class="{ active: config.monster.species === 'aquatic' }"
                  @click="config.monster.species = 'aquatic'">水族</div>
                <div
class="radio-item" :class="{ active: config.monster.species === 'undead' }"
                  @click="config.monster.species = 'undead'">亡灵</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数限制</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.monster.wordCount === 0 }"
                  @click="config.monster.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.monster.wordCount === 1 }"
                  @click="config.monster.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.monster.wordCount === 2 }"
                  @click="config.monster.wordCount = 2">2字</div>
                <div
class="radio-item" :class="{ active: config.monster.wordCount === 3 }"
                  @click="config.monster.wordCount = 3">3字</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">特殊特征 (选填)</label>
              <input
type="text" class="input-ink" v-model="config.monster.trait" placeholder="如：九头、变异、剧毒"
                maxlength="10">
            </div>

            <div class="form-item">
              <label class="form-label">具体要求</label>
              <textarea
class="input-ink textarea-ink" v-model="config.monster.requirement"
                placeholder="输入具体描述，如：性格冷酷，五行属火..." rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.monster.requirement.length }}/150</div>
            </div>
          </template>

          <template v-else-if="currentCategory === 'item'">
            <div class="form-item row">
              <div class="ink-select" style="flex: 1; margin-right: 10px;">
                <el-select
v-model="config.item.style" placeholder="风格" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="中国风格" value="cn" />
                  <el-option label="西方奇幻" value="western" />
                  <el-option label="日式和风" value="jp" />
                  <el-option label="克苏鲁" value="cthulhu" />
                </el-select>
              </div>
              <div class="ink-select" style="flex: 1;">
                <el-select
v-model="config.item.era" placeholder="时代" class="ink-select"
                  popper-class="ink-select-popper">
                  <el-option label="古代/玄幻" value="ancient" />
                  <el-option label="现代/都市" value="modern" />
                  <el-option label="未来/科幻" value="future" />
                </el-select>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">物品类别</label>
              <div class="gender-radio-group">
                <div
class="radio-item" :class="{ active: config.item.type === 'elixir' }"
                  @click="config.item.type = 'elixir'">丹药</div>
                <div
class="radio-item" :class="{ active: config.item.type === 'talisman' }"
                  @click="config.item.type = 'talisman'">符篆</div>
                <div
class="radio-item" :class="{ active: config.item.type === 'material' }"
                  @click="config.item.type = 'material'">材料</div>
                <div
class="radio-item" :class="{ active: config.item.type === 'curio' }"
                  @click="config.item.type = 'curio'">奇物</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">字数限制</label>
              <div class="count-radio-group">
                <div
class="radio-item" :class="{ active: config.item.wordCount === 0 }"
                  @click="config.item.wordCount = 0">不限</div>
                <div
class="radio-item" :class="{ active: config.item.wordCount === 1 }"
                  @click="config.item.wordCount = 1">1字</div>
                <div
class="radio-item" :class="{ active: config.item.wordCount === 2 }"
                  @click="config.item.wordCount = 2">2字</div>
                <div
class="radio-item" :class="{ active: config.item.wordCount === 3 }"
                  @click="config.item.wordCount = 3">3字</div>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">功效/用途 (选填)</label>
              <input
type="text" class="input-ink" v-model="config.item.effect" placeholder="如：疗伤、隐身、提升修为"
                maxlength="20">
            </div>

            <div class="form-item">
              <label class="form-label">具体要求</label>
              <textarea
class="input-ink textarea-ink" v-model="config.item.requirement" placeholder="输入具体要求..."
                rows="3" maxlength="150"></textarea>
              <div class="char-count">{{ config.item.requirement.length }}/150</div>
            </div>
          </template>

          <div class="action-area">
            <button class="ink-btn ink-btn-primary" @click="handleGenerate" :disabled="loading">
              <i class="fa-solid fa-wand-magic-sparkles" :class="{ 'fa-spin': loading }"></i>
              {{ loading ? '生成中...' : '开始生成' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 右侧：结果展示 -->
      <div class="result-panel">
        <div class="result-grid" v-if="results.length > 0">
          <div v-for="(name, index) in results" :key="index" class="name-card" @click="handleSelectName(name)" title="点击插入正文">
            <span class="name-text">{{ name }}</span>
            <button type="button" class="name-copy" title="复制" @click="handleCopyName(name, $event)">
              <i class="fa-regular fa-copy"></i>
            </button>
          </div>
        </div>
        <div class="empty-result" v-else>
          <i class="fa-regular fa-paper-plane"></i>
          <p>点击生成获取灵感</p>
        </div>

        <!-- 装饰印章 -->
        <div class="stamp-decoration">
          <i class="fa-solid fa-stamp"></i>
        </div>
      </div>
    </div>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
// 开源版：命名走本地 BYOK 直连（文本默认偏好模型）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildNamingMessages } from '@/config/ai-prompts'
import { promptTemperature } from '@/storage/local-prompts'
import { useAiModelStore } from '@/stores/ai-model'

const aiModelStore = useAiModelStore()

const visible = defineModel<boolean>('visible')
defineProps<{ bookId?: string | number }>()
const emit = defineEmits(['insert'])

type Category = 'person' | 'location' | 'faction' | 'skill' | 'equipment' | 'monster' | 'item'

const categories: { label: string, value: Category }[] = [
  { label: '人物', value: 'person' },
  { label: '地点', value: 'location' },
  { label: '势力', value: 'faction' },
  { label: '招式', value: 'skill' },
  { label: '装备', value: 'equipment' },
  { label: '怪物', value: 'monster' },
  { label: '道具', value: 'item' }
]

const currentCategory = ref<Category>('person')
const loading = ref(false)

const config = reactive({
  person: {
    region: 'cn',
    era: 'modern',
    reference: 'none',
    gender: 'male',
    wordCount: 2,
    surname: '',
    requirement: ''
  },
  location: {
    style: 'cn',
    era: 'ancient',
    type: 'city',
    wordCount: 2,
    suffix: '',
    requirement: ''
  },
  faction: {
    style: 'cn',
    era: 'ancient',
    nature: 'good',
    wordCount: 2,
    suffix: '',
    requirement: ''
  },
  skill: {
    style: 'cn',
    era: 'ancient',
    type: 'sword',
    wordCount: 2,
    attribute: '',
    requirement: ''
  },
  equipment: {
    style: 'cn',
    era: 'ancient',
    slot: 'weapon',
    wordCount: 2,
    material: '',
    requirement: ''
  },
  monster: {
    style: 'cn',
    era: 'ancient',
    species: 'beast',
    wordCount: 2,
    trait: '',
    requirement: ''
  },
  item: {
    style: 'cn',
    era: 'ancient',
    type: 'elixir',
    wordCount: 2,
    effect: '',
    requirement: ''
  }
})

const categoryResults = reactive<Record<string, string[]>>({
  person: [],
  location: [],
  faction: [],
  skill: [],
  equipment: [],
  monster: [],
  item: []
})

const results = computed(() => categoryResults[currentCategory.value] || [])

const getCategoryLabel = (val: string) => {
  return categories.find(c => c.value === val)?.label || ''
}

const setRandomSurname = (type: 'single' | 'double') => {
  const singles = ['赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈', '褚', '卫', '蒋', '沈', '韩', '杨']
  const doubles = ['欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人', '夏侯', '诸葛']

  if (type === 'single') {
    config.person.surname = singles[Math.floor(Math.random() * singles.length)]
  } else {
    config.person.surname = doubles[Math.floor(Math.random() * doubles.length)]
  }
}

const regionLabelMap: Record<string, string> = {
  cn: '中国',
  en: '西方',
  jp: '日本'
}

const styleLabelMap: Record<string, string> = {
  cn: '中国风',
  western: '西方奇幻',
  jp: '日式和风',
  cthulhu: '克苏鲁'
}

const personEraLabelMap: Record<string, string> = {
  modern: '现代',
  ancient: '古代'
}

const generalEraLabelMap: Record<string, string> = {
  ancient: '古代/玄幻',
  modern: '现代/都市',
  future: '未来/科幻'
}

const referenceLabelMap: Record<string, string> = {
  none: '不参考',
  poem: '参考诗词'
}

const genderLabelMap: Record<string, string> = {
  male: '男性',
  female: '女性',
  unknown: '中性'
}

const locationTypeMap: Record<string, string> = {
  city: '城镇/都市',
  nature: '自然景观',
  sect: '宗门/氏族',
  dungeon: '秘境/副本'
}

const factionNatureMap: Record<string, string> = {
  good: '正道',
  evil: '魔道',
  court: '朝廷',
  family: '家族'
}

const skillTypeMap: Record<string, string> = {
  sword: '剑法',
  blade: '刀法',
  fist: '拳掌',
  inner: '内功心法'
}

const equipmentSlotMap: Record<string, string> = {
  weapon: '武器',
  armor: '防具',
  accessory: '饰品',
  artifact: '法宝'
}

const monsterSpeciesMap: Record<string, string> = {
  beast: '走兽',
  bird: '飞禽',
  aquatic: '水族',
  undead: '亡灵'
}

const itemTypeMap: Record<string, string> = {
  elixir: '丹药',
  talisman: '符篆',
  material: '材料',
  curio: '奇物'
}


const formatWordCount = (count: number) => count === 0 ? '不限' : `${count}字`
const normalizeText = (text?: string, fallback = '无特殊要求') => {
  const trimmed = (text || '').trim()
  return trimmed || fallback
}

const buildVariables = (category: Category) => {
  switch (category) {
    case 'person': {
      const person = config.person
      const region = regionLabelMap[person.region] || '通用'
      const era = personEraLabelMap[person.era] || '现代'
      const reference = referenceLabelMap[person.reference] || '不参考'
      return {
        category: getCategoryLabel('person'),
        style: `${region} · ${era}（${reference}）`,
        genderOrProp: genderLabelMap[person.gender] || '不限',
        wordCount: formatWordCount(person.wordCount),
        fixedSurname: normalizeText(person.surname, '无'),
        requirements: normalizeText(person.requirement)
      }
    }
    case 'location': {
      const location = config.location
      return {
        category: getCategoryLabel('location'),
        style: `${styleLabelMap[location.style] || '通用风格'} · ${generalEraLabelMap[location.era] || '时代不限'}`,
        locationType: locationTypeMap[location.type] || '自定义地点',
        wordCount: formatWordCount(location.wordCount),
        suffix: normalizeText(location.suffix, '无'),
        requirements: normalizeText(location.requirement)
      }
    }
    case 'faction': {
      const faction = config.faction
      return {
        category: getCategoryLabel('faction'),
        style: `${styleLabelMap[faction.style] || '通用风格'} · ${generalEraLabelMap[faction.era] || '时代不限'}`,
        nature: factionNatureMap[faction.nature] || '其他阵营',
        wordCount: formatWordCount(faction.wordCount),
        suffix: normalizeText(faction.suffix, '无'),
        requirements: normalizeText(faction.requirement)
      }
    }
    case 'skill': {
      const skill = config.skill
      return {
        category: getCategoryLabel('skill'),
        style: `${styleLabelMap[skill.style] || '通用风格'} · ${generalEraLabelMap[skill.era] || '时代不限'}`,
        skillType: skillTypeMap[skill.type] || '综合功法',
        wordCount: formatWordCount(skill.wordCount),
        attribute: normalizeText(skill.attribute, '无'),
        requirements: normalizeText(skill.requirement)
      }
    }
    case 'equipment': {
      const equipment = config.equipment
      return {
        category: getCategoryLabel('equipment'),
        style: `${styleLabelMap[equipment.style] || '通用风格'} · ${generalEraLabelMap[equipment.era] || '时代不限'}`,
        slot: equipmentSlotMap[equipment.slot] || '特殊装备',
        wordCount: formatWordCount(equipment.wordCount),
        material: normalizeText(equipment.material, '无'),
        requirements: normalizeText(equipment.requirement)
      }
    }
    case 'monster': {
      const monster = config.monster
      return {
        category: getCategoryLabel('monster'),
        style: `${styleLabelMap[monster.style] || '通用风格'} · ${generalEraLabelMap[monster.era] || '时代不限'}`,
        species: monsterSpeciesMap[monster.species] || '未知种族',
        wordCount: formatWordCount(monster.wordCount),
        trait: normalizeText(monster.trait, '无'),
        requirements: normalizeText(monster.requirement)
      }
    }
    case 'item': {
      const item = config.item
      return {
        category: getCategoryLabel('item'),
        style: `${styleLabelMap[item.style] || '通用风格'} · ${generalEraLabelMap[item.era] || '时代不限'}`,
        itemType: itemTypeMap[item.type] || '奇物',
        wordCount: formatWordCount(item.wordCount),
        effect: normalizeText(item.effect, '无'),
        requirements: normalizeText(item.requirement)
      }
    }
    default:
      return null
  }
}

const parseNameList = (text: string) => {
  return text
    .replace(/\n+/g, ' ')
    .split(' ')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

const handleGenerate = async () => {
  const category = currentCategory.value
  const variables = buildVariables(category)
  if (!variables) {
    ElMessage.warning('当前配置暂不可生成，请检查参数')
    return
  }
  if (loading.value) {
    ElMessage.warning('AI 正在生成中，请稍候...')
    return
  }
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  loading.value = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'name_generator',
      sceneLabel: '取名器',
      temperature: promptTemperature('naming', 'system'),
      modelCode,
      messages: buildNamingMessages({
        categoryLabel: getCategoryLabel(category),
        fields: variables
      }),
    })
    const raw = (data || '').trim()
    if (!raw) {
      throw new Error('AI 暂无返回内容')
    }
    const nameList = parseNameList(raw)
    const deduped = Array.from(new Set(nameList))
    if (!deduped.length) {
      throw new Error('未解析到可用的名字')
    }
    categoryResults[currentCategory.value] = deduped.slice(0, 12)
    ElMessage.success(`已生成 ${categoryResults[currentCategory.value].length} 个${getCategoryLabel(category)}名称`)
  } catch (error) {
    console.error('AI命名失败:', error)
    ElMessage.error(String(error?.message || '生成失败，请稍后重试'))
  } finally {
    loading.value = false
  }
}

const handleSelectName = (name: string) => {
  // 一键插入编辑器当前光标；父组件未接线时回退为复制到剪贴板
  emit('insert', name)
}

const handleCopyName = (name: string, event: Event) => {
  event.stopPropagation()
  navigator.clipboard.writeText(name).then(() => {
    ElMessage.success(`已复制：${name}`)
  })
}
</script>

<style lang="scss">
.name-generator-modal {
  .ew-modal-body {
    padding: 0 !important;
    overflow: hidden !important;
  }
}
</style>

<style scoped lang="scss">
:deep(.ew-modal-body) {
  padding: 0 !important;
  overflow: hidden;
}

.generator-container {
  display: flex;
  height: 560px;
}

/* 左侧配置面板 */
.config-panel {
  width: 400px;
  display: flex;
  border-right: 1px solid var(--ui-border);
  background: var(--panel-bg);
}

.category-sidebar {
  width: 80px;
  background: var(--tree-bg);
  border-right: 1px solid var(--ui-border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;

  .category-item {
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--ink-sec);
    transition: all 0.3s;
    font-size: calc(14px * var(--ui-font-scale, 1));
    position: relative;

    &:hover {
      color: var(--ink-main);
      background: var(--nav-hover-bg);
    }

    &.active {
      color: var(--ink-main);
      font-weight: bold;
      background: var(--bg-main);

      &::before {
        content: '';
        position: absolute;
        left: 0;
        top: 12px;
        bottom: 12px;
        width: 3px;
        background: var(--ink-main);
        border-radius: 0 2px 2px 0;
      }
    }
  }
}

.config-form {
  flex: 1;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;

  .form-item {
    margin-bottom: 16px;

    &.row {
      display: flex;
    }

    .form-label {
      display: block;
      font-size: calc(12px * var(--ui-font-scale, 1));
      color: var(--ink-sec);
      margin-bottom: 8px;
    }

    .label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;

      .form-label {
        margin-bottom: 0;
      }
    }
  }
}

/* 自定义单选组 */
.gender-radio-group,
.count-radio-group {
  display: flex;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  overflow: hidden;

  .radio-item {
    flex: 1;
    text-align: center;
    padding: 6px 0;
    cursor: pointer;
    font-size: calc(13px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    transition: all 0.3s;
    background: var(--btn-ghost-border);

    &:not(:last-child) {
      border-right: 1px solid var(--btn-outline-border);
    }

    &:hover {
      background: var(--btn-outline-hover-bg);
      color: var(--ink-main);
    }

    &.active {
      background: var(--ink-main);
      color: var(--btn-primary-color);
    }
  }
}

.helper-links {
  font-size: calc(12px * var(--ui-font-scale, 1));

  span {
    color: var(--ink-accent);
    cursor: pointer;
    margin-left: 10px;
    opacity: 0.8;

    &:hover {
      opacity: 1;
      text-decoration: underline;
    }
  }
}

.textarea-ink {
  resize: none;
  border-radius: 4px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  padding: 8px;
  color: var(--ink-main);

  &:focus {
    background: var(--input-focus-bg);
    border-color: var(--ink-main);
  }
}

.char-count {
  text-align: right;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  margin-top: 4px;
}

// .limit-hint {
//   font-size: calc(12px * var(--ui-font-scale, 1));
//   color: #9ca3af;
// }

.hint-text {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  margin-top: auto;
  margin-bottom: 16px;
}

.action-area {
  margin-top: 10px;

  .ink-btn {
    width: 100%;
    justify-content: center;
  }
}

.empty-config {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--ink-sec);
  opacity: 0.5;

  i {
    font-size: calc(32px * var(--ui-font-scale, 1));
    margin-bottom: 16px;
  }
}

/* 右侧结果面板 */
.result-panel {
  flex: 1;
  background: var(--ui-glass-bg);
  padding: 30px;
  position: relative;
  display: flex;
  flex-direction: column;

  .result-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    align-content: start;
    height: 100%;
    overflow-y: auto;
  }

  .name-card {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 60px;
    cursor: pointer;
    transition: all 0.3s;
    border-radius: 8px;
    position: relative;

    .name-text {
      font-size: calc(18px * var(--ui-font-scale, 1));
      font-family: var(--editor-font-family, 'KaiTi', 'STKaiti', serif);
      color: var(--ink-main);
      font-weight: 500;
      letter-spacing: 2px;
    }

    &:hover {
      background: var(--nav-hover-bg);
      transform: translateY(-2px);

      .name-text {
        color: var(--ink-accent);
        font-weight: bold;
      }
    }
  }

  .empty-result {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--ink-sec);
    opacity: 0.3;

    i {
      font-size: calc(48px * var(--ui-font-scale, 1));
      margin-bottom: 16px;
    }
  }

  .stamp-decoration {
    position: absolute;
    top: 20px;
    right: 20px;
    font-size: calc(80px * var(--ui-font-scale, 1));
    opacity: 0.05;
    transform: rotate(-15deg);
    pointer-events: none;
    color: var(--ink-main);
  }
}
</style>

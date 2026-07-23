<template>
  <main class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">◌</span><div><b>Disk Sense</b><small>文件功能解释器</small></div></div>
      <nav>
        <button :class="{ active: view === 'overview' }" @click="view = 'overview'">空间概览</button>
        <button :class="{ active: view === 'inspect' }" @click="openInspect">目录与文件</button>
        <button :class="{ active: view === 'cleaner' }" @click="view = 'cleaner'">常规清理</button>
        <button :class="{ active: view === 'changes' }" @click="view = 'changes'">变化记录</button>
      </nav>
      <div class="aside-foot">核心目标<br><span>解释内容，再决定是否处理</span></div>
    </aside>

    <section v-if="view === 'overview'" class="content">
      <header class="overview-hero"><div><p class="kicker">SPACE EXPLANATION</p><h1>先理解空间，<br>再决定处理什么</h1><p class="subtitle">Disk Sense 关注的不只是“占了多少”，还要说明“为什么在这里”。</p></div><button class="scan" @click="openInspect">开始探查 C 盘</button></header>
      <div class="notice"><span>◈</span><div><b>本地优先分析</b><p>路径、名称、上下文和内容摘要在本机分析；未知内容保持谨慎，不会自动删除。</p></div></div>
      <div class="cards"><article><span>第一步</span><strong>定位空间</strong><small>从 C:\ 开始，按目录结构查看真实占用。</small></article><article><span>第二步</span><strong>解释对象</strong><small>结合文件名、内容、上级目录和应用来源判断作用。</small></article><article><span>第三步</span><strong>再做决定</strong><small>保留、移动、归档或清理都由证据和用户确认决定。</small></article></div>
    </section>

    <section v-else-if="view === 'inspect'" class="content">
      <header><p class="kicker">EXPLAINER EXPLORER</p><h1>目录与文件</h1><p class="subtitle">像资源管理器一样浏览，但每个对象都展示功能、来源、上下文和风险。</p></header>
      <div class="path-search"><input v-model="pathInput" @keyup.enter="loadDirectory(pathInput)" placeholder="输入 Windows 路径，例如 C:\\Users" /><button class="scan" @click="loadDirectory(pathInput)">打开路径</button><button class="quiet" @click="showAiSettings = true">AI 设置</button></div>
      <p v-if="inspectError" class="error-message">{{ inspectError }}</p>
      <div class="explorer-toolbar"><button title="返回" @click="goBack" :disabled="history.length < 2">←</button><button title="上级目录" @click="goUp">↑</button><button @click="loadDirectory(browsePath)">刷新</button><div class="breadcrumbs"><button v-for="crumb in crumbs" :key="crumb.path" @click="loadDirectory(crumb.path)">{{ crumb.name }}</button></div></div>
      <div class="explorer-path">{{ browsePath || '尚未打开目录' }}</div>
      <div class="explorer-layout">
        <div class="file-list"><div class="list-head"><span>名称</span><span>初步判断</span><span>大小</span></div><button v-for="item in inspectItems" :key="item.path" class="file-row" :class="{ selected: selected?.path === item.path }" @click="selectItem(item)" @dblclick="item.isDirectory && loadDirectory(item.path)"><span class="file-name"><i>{{ item.isDirectory ? '▰' : '□' }}</i>{{ item.name }}</span><span class="row-classification">{{ item.source }}</span><span>{{ item.isDirectory ? format(item.size) + (item.sizeEstimated ? ' 估算' : '') : format(item.size) }}</span></button><div v-if="!inspectItems.length" class="list-empty">输入路径后打开，开始理解目录内容</div></div>
        <aside class="explain-panel">
          <div v-if="explanation">
            <div class="explain-icon">{{ explanation.icon }}</div><p class="kicker">{{ explanation.kind }}</p><h2>{{ explanation.title }}</h2><p>{{ explanation.description }}</p>
            <div class="explain-facts"><span>来源：{{ explanation.source || '待确认' }}</span><span>风险：{{ explanation.risk }}</span><span>置信度：{{ Math.round((explanation.confidence || 0) * 100) }}%</span><span>建议：{{ explanation.action }}</span></div>
            <button class="ai-review" :disabled="aiBusy" @click="aiConfigured ? reviewWithAi() : (showAiSettings = true)">{{ aiBusy ? '分析中…' : (aiConfigured ? '请求 AI 深入解释' : '配置 AI 深入分析') }}</button>
            <div v-if="aiError" class="error-message">{{ aiError }}</div><pre v-if="aiResult" class="ai-result">{{ aiResult }}</pre>
            <div class="evidence"><b>判断依据</b><p>路径：{{ selected?.path }}</p><p>上级目录：{{ explanation.parent || '根目录' }}</p><p v-if="selected?.modifiedAt">修改：{{ new Date(selected.modifiedAt).toLocaleString() }}</p><p v-if="explanation.evidence?.siblingNames?.length">同级上下文：{{ explanation.evidence.siblingNames.join('、') }}</p><p v-if="explanation.relatedLocations?.length">关联位置：</p><ul v-if="explanation.relatedLocations?.length" class="related-list"><li v-for="location in explanation.relatedLocations" :key="location.path">{{ location.path }}<small>{{ location.reason }}</small></li></ul><details v-if="explanation.contentPreview"><summary>查看内容摘要</summary><pre>{{ explanation.contentPreview }}</pre></details></div>
          </div>
          <div v-else class="panel-empty"><span>◇</span><b>选择一个目录或文件</b><p>这里会结合路径、名称、内容和上下文解释它的作用。</p></div>
        </aside>
      </div>
    </section>

    <section v-else-if="view === 'cleaner'" class="content"><CleanerPanel /></section>
    <section v-else-if="view === 'changes'" class="content"><ChangesPanel /></section>
    <section v-else class="content"><header><p class="kicker">CHANGE HISTORY</p><h1>变化记录</h1><p class="subtitle">记录扫描发现的新增和修改内容。</p></header><div class="empty small"><h2>暂无变化记录</h2><p>完成至少两次扫描后，这里会显示空间变化。</p></div></section>
    <AiSettingsModal v-if="showAiSettings" @close="showAiSettings = false" @saved="status => { aiConfigured = status.configured }" />
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CleanerPanel from './CleanerPanel.vue'
import ChangesPanel from './ChangesPanel.vue'
import AiSettingsModal from './AiSettingsModal.vue'
import { desktopApi } from '../platform/api'

const view = ref('overview')
const pathInput = ref('C:\\')
const browsePath = ref('')
const history = ref<string[]>([])
const inspectItems = ref<any[]>([])
const selected = ref<any>(null)
const explanation = ref<any>(null)
const inspectError = ref('')
const aiConfigured = ref(false)
const aiBusy = ref(false)
const aiError = ref('')
const aiResult = ref('')
const showAiSettings = ref(false)

const crumbs = computed(() => { const parts = browsePath.value.split('\\').filter(Boolean); return parts.map((name, index) => ({ name: name + (index === 0 ? ':' : ''), path: index === 0 ? `${name}\\` : parts.slice(0, index + 1).join('\\') + '\\' })) })
function format(bytes: number) { if (!bytes) return '0 B'; if (bytes < 1024) return `${bytes} B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes; let index = -1; do { value /= 1024; index++ } while (value >= 1024 && index < units.length - 1); return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}` }
function openInspect() { view.value = 'inspect'; if (!browsePath.value) loadDirectory(pathInput.value); loadAiStatus() }
async function loadAiStatus() { const api = desktopApi(); if (api) aiConfigured.value = Boolean((await api.aiStatus()).configured) }
async function loadDirectory(dir?: string) { const api = desktopApi(); if (!api) { inspectError.value = '请使用 Electron 开发模式打开项目'; return } try { inspectError.value = ''; const result = await api.inspectList(dir || 'C:\\'); browsePath.value = result.path; pathInput.value = result.path; history.value = [...history.value.filter(item => item !== result.path), result.path]; inspectItems.value = result.items; selected.value = null; explanation.value = null; aiResult.value = '' } catch (error) { inspectError.value = error instanceof Error ? error.message : String(error); inspectItems.value = [] } }
async function selectItem(item: any) { selected.value = item; aiResult.value = ''; aiError.value = ''; const api = desktopApi(); if (!api) return; try { const result = await api.inspectExplain(item.path); explanation.value = { ...result, icon: result.isDirectory ? '▰' : '□', kind: result.source || '功能说明', title: `${result.isDirectory ? '目录：' : '文件：'}${item.name}`, description: result.reason || '暂时没有足够证据解释其用途。', action: result.risk === 'low' ? '可在确认后处理' : '建议保留并进一步确认' } } catch (error) { inspectError.value = error instanceof Error ? error.message : String(error) } }
async function reviewWithAi() { const api = desktopApi(); if (!api || !explanation.value) return; aiBusy.value = true; aiError.value = ''; try { const result = await api.aiReview(explanation.value); if (!result.ok) { aiError.value = result.reason; return } const parsed = result.parsed; if (parsed) { explanation.value = { ...explanation.value, kind: 'AI 深入分析', source: parsed.belongsTo || explanation.value.source, description: `它是${parsed.what || '暂未确定的对象'}。用途：${parsed.purpose || '证据不足'}${parsed.whyHere ? `为什么在这里：${parsed.whyHere}` : ''}`, risk: parsed.risk || explanation.value.risk, confidence: Number(parsed.confidence) || explanation.value.confidence, action: parsed.handling || explanation.value.action, aiAnalyzed: true }; aiResult.value = Array.isArray(parsed.reasons) ? parsed.reasons.join('\n') : '' } else aiResult.value = result.result } catch (error) { aiError.value = error instanceof Error ? error.message : String(error) } finally { aiBusy.value = false } }
function goBack() { if (history.value.length < 2) return; history.value.pop(); loadDirectory(history.value[history.value.length - 1]) }
function goUp() { const clean = browsePath.value.replace(/[\\/]$/, ''); const parent = clean.split(/[\\/]/).slice(0, -1).join('\\') + '\\'; if (parent && parent !== browsePath.value) loadDirectory(parent) }
onMounted(loadAiStatus)
</script>

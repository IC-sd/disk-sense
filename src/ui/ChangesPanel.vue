<template>
  <div>
    <header><div><p class="kicker">CHANGE HISTORY</p><h1>变化记录</h1><p class="subtitle">建立一次基线后，比较之后新增、删除、修改和移动的文件。</p></div><div class="head-actions"><button class="quiet" :disabled="busy" @click="createBaseline">{{ baseline ? '重新建立基线' : '建立第一次基线' }}</button><button class="scan" :disabled="busy || !baseline" @click="scanChanges">扫描变化</button></div></header>
    <div class="notice"><span>◈</span><div><b>{{ baseline ? `基线：${new Date(baseline.createdAt).toLocaleString()}` : '还没有变化基线' }}</b><p>{{ baseline ? '基线会保留在本机，扫描后只返回差异，不会自动处理文件。' : '先建立基线，再下载软件、创建文件或安装应用，之后回来扫描变化。' }}</p></div></div>
    <div v-if="busy" class="scan-progress"><b>{{ progressText }}</b><span>{{ progress.entries || 0 }} 项已记录，当前：{{ progress.current || '准备中' }}</span><button class="quiet" @click="cancel">取消扫描</button></div>
    <div v-if="error" class="error-message">{{ error }}</div>
    <div v-if="last?.result" class="change-summary"><article><b>{{ last.result.summary.added }}</b><span>新增</span></article><article><b>{{ last.result.summary.modified }}</b><span>修改</span></article><article><b>{{ last.result.summary.removed }}</b><span>删除</span></article><article><b>{{ last.result.summary.moved }}</b><span>移动</span></article><article><b>{{ format(last.result.summary.addedBytes) }}</b><span>新增空间</span></article><article><b>{{ format(last.result.summary.removedBytes) }}</b><span>减少空间</span></article></div>
    <div v-if="last?.result" class="change-groups"><section v-for="group in groups" :key="group.id" class="change-group"><h2>{{ group.title }} <small>{{ group.items.length }}</small></h2><div v-for="item in group.items.slice(0, 100)" :key="item.key" class="change-item"><span class="change-kind">{{ group.label }}</span><div><b>{{ item.title }}</b><small>{{ item.detail }}</small></div></div><p v-if="group.items.length > 100" class="muted">还有 {{ group.items.length - 100 }} 项未展开</p></section></div>
    <div v-else class="empty small"><h2>{{ baseline ? '等待下一次变化扫描' : '先建立变化基线' }}</h2><p>{{ baseline ? '完成软件安装、下载或文件整理后，点击“扫描变化”。' : '基线记录的是文件路径、类型、大小和修改时间，不会上传文件内容。' }}</p></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { desktopApi } from '../platform/api'
const baseline = ref<any>(null); const last = ref<any>(null); const busy = ref(false); const error = ref(''); const progress = ref<any>({})
const progressText = computed(() => progress.value.current ? '正在扫描磁盘变化…' : '正在准备扫描…')
function format(bytes: number) { if (!bytes) return '0 B'; if (bytes < 1024) return `${bytes} B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes; let index = -1; do { value /= 1024; index++ } while (value >= 1024 && index < units.length - 1); return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}` }
const groups = computed(() => { const result = last.value?.result; if (!result) return []; return [{ id: 'added', title: '新增内容', label: '新增', items: result.added.map((x: any) => ({ key: x.path, title: x.path, detail: `${x.kind} · ${format(x.size)}` })) }, { id: 'modified', title: '发生修改', label: '修改', items: result.modified.map((x: any) => ({ key: x.path, title: x.path, detail: `${x.kind} · ${format(x.beforeSize)} → ${format(x.size)}` })) }, { id: 'removed', title: '已不存在', label: '删除', items: result.removed.map((x: any) => ({ key: x.path, title: x.path, detail: `${x.kind} · ${format(x.size)}` })) }, { id: 'moved', title: '位置变化', label: '移动', items: result.moved.map((x: any) => ({ key: `${x.from}-${x.to}`, title: x.to, detail: `从 ${x.from} 移动 · ${format(x.size)}` })) }].filter(group => group.items.length) })
async function refresh() { const api = desktopApi(); if (!api) return; const state = await api.changesState(); baseline.value = state.baseline; last.value = state.last }
async function createBaseline() { const api = desktopApi(); if (!api) return; busy.value = true; error.value = ''; try { const result = await api.changesBaseline(); if (result.snapshot?.cancelled) error.value = '基线扫描已取消'; await refresh() } catch (e) { error.value = e instanceof Error ? e.message : String(e) } finally { busy.value = false } }
async function scanChanges() { const api = desktopApi(); if (!api) return; busy.value = true; error.value = ''; try { const result = await api.changesScan(); if (!result.ok) error.value = result.reason; else last.value = { result } } catch (e) { error.value = e instanceof Error ? e.message : String(e) } finally { busy.value = false } }
async function cancel() { const api = desktopApi(); if (api) await api.changesCancel() }
onMounted(() => { refresh(); const api = desktopApi(); api?.onChangesProgress(data => { progress.value = data }) })
</script>

<template>
  <div
    v-if="explanation"
    class="explanation-content"
    :class="{ 'ai-result': explanation.aiAnalyzed }"
  >
    <div class="object-heading">
      <div class="object-icon"><AppIcon :name="selected?.isDirectory ? 'folder' : 'file'" /></div>
      <div>
        <span>{{ explanation.kind }}</span>
        <h2>{{ displayName }}</h2>
        <small class="explained-path" :title="selected?.path">{{ selected?.path }}</small>
      </div>
    </div>

    <div v-if="selected && mode === 'browse'" class="object-file-actions">
      <button v-if="mode === 'browse'" class="quiet" @click="emit('action', selected, 'open')">打开</button>
      <button v-if="mode === 'browse'" class="quiet" @click="emit('action', selected, 'reveal')">定位</button>
      <button v-if="mode === 'browse'" class="quiet" @click="emit('action', selected, 'copy')">复制路径</button>
    </div>

    <dl v-if="selected" class="object-facts">
      <div><dt>类型</dt><dd>{{ selected.isDirectory ? '文件夹' : fileTypeLabel(selected.extension) }}</dd></div>
      <div><dt>大小</dt><dd>{{ selected.metadataPending ? '读取中…' : selected.size === null ? '尚未估算' : `${selected.sizeEstimated ? '≥ ' : ''}${formatBytes(selected.size)}` }}</dd></div>
      <div><dt>最近修改</dt><dd>{{ formatModified(selected.modifiedAt) }}</dd></div>
    </dl>

    <PathSpacePanel v-if="selected" :key="selected.path" :path="selected.path" />

    <div class="explanation-summary">
      <span class="risk-chip" :class="riskClass(explanation.risk)">{{ riskLabel(explanation.risk) }}</span>
      <span>{{ ['install-path', 'package-install-path', 'package-data-path'].includes(explanation.relationship?.basis || '') ? '安装登记证据' : explanation.relationship?.basis === 'portable-manifest' ? '便携应用清单证据' : explanation.relationship?.basis === 'project-markers' ? '项目结构证据' : explanation.relationship?.basis === 'known-signature' ? '已知路径特征' : explanation.relationship?.basis ? '归属仍需核实' : '本地特征判断' }}</span>
      <span>{{ explanation.aiAnalyzed ? 'AI 分析' : '本地证据分析' }}</span>
    </div>

    <div class="ai-actions">
      <button class="ai-review" :class="{ completed: explanation.aiAnalyzed }" :disabled="aiBusy || refreshingExplanation" @click="emit('review')">
        <AppIcon name="spark" />
        <span>
          <b>{{ aiBusy ? '分析中…' : explanation.aiAnalyzed ? '重新分析' : 'AI 分析' }}</b>
          <small>{{ aiConfigured ? '结合本地证据，解释用途与处理建议' : '配置模型后，补充文件用途与处理建议' }}</small>
        </span>
      </button>
      <button class="ai-config-link secondary-button" @click="emit('settings')"><AppIcon name="settings" />设置</button>
    </div>
    <div v-if="aiBusy" class="analysis-progress" role="status">
      <i></i><span>正在结合本地证据分析</span>
      <button class="quiet ai-cancel" @click="emit('cancel')">取消本次分析</button>
    </div>
    <p v-if="aiError" class="inline-message error-message">{{ aiError }}</p>

    <p v-if="refreshingExplanation" class="inline-message" role="status">正在核实最新证据…</p>

    <div v-if="explanation.aiAnalyzed" class="ai-result-banner" role="status">
      <div>
        <b>AI 分析完成</b>
        <small>已根据本地证据更新结论与处理建议</small>
      </div>
      <strong>{{ explanation.aiPersisted ? '已本地保存' : '已更新' }}</strong>
    </div>

    <div class="meaning-list">
      <section v-for="detail in objectDetails" :key="detail.label">
        <span>{{ detail.label }}</span>
        <p>{{ detail.value }}</p>
      </section>
    </div>

    <details v-if="explanation.evidence?.fileType" class="reason-details">
      <summary>文件格式依据</summary>
      <p>{{ explanation.evidence.fileType.format }} · {{ explanation.evidence.fileType.status }}</p>
      <p v-if="explanation.evidence.fileType.extensionConflict" class="error-message">文件头与扩展名不一致，请核实来源后再打开。</p>
      <ul><li v-for="detail in explanation.evidence.fileType.details" :key="detail">{{ detail }}</li></ul>
      <small>读取了 {{ explanation.evidence.fileType.bytesRead }} 字节前缀；格式线索不代表文件安全性。</small>
    </details>

    <details v-if="explanation.relationship?.evidence?.length" class="reason-details relationship-details">
      <summary>空间关联依据 · {{ explanation.relationship.entityKind || '本地关系分析' }}</summary>
      <p v-if="explanation.relationship.role">
        当前对象在关联实体中属于：<b>{{ explanation.relationship.role.label }}</b>
      </p>
      <ul><li v-for="reason in explanation.relationship.evidence" :key="reason">{{ reason }}</li></ul>
      <p v-if="explanation.relationship.components?.length">包含的组件：{{ explanation.relationship.components.map(component => component.entityName).join('、') }}。仅有组件清单不能证明它是独立的软件或项目。</p>
      <p v-if="explanation.relationship.limited">目录标记采用有限采样，可能仍有未识别的其他内容。</p>
    </details>

    <details v-if="explanation.aiReasons?.length" class="reason-details">
      <summary>为什么这样判断</summary>
      <ul><li v-for="reason in explanation.aiReasons" :key="reason">{{ reason }}</li></ul>
    </details>

    <div v-if="explanation.relatedLocations?.length" class="related-locations">
      <b>相关位置</b>
      <div v-for="location in explanation.relatedLocations" :key="location.path">
        <AppIcon name="database" />
        <span>{{ location.path }}<small>{{ location.reason }}</small></span>
      </div>
    </div>
  </div>

  <div v-else-if="refreshingExplanation" class="panel-empty analysis-loading" role="status">
    <div class="empty-graphic"><AppIcon name="scan" /></div>
    <b>正在读取文件信息</b><p>核对本地特征与归属证据…</p>
  </div>
  <div v-else class="panel-empty">
    <div class="empty-graphic"><AppIcon name="scan" /></div>
    <b>选择一个文件或目录</b>
    <p>点击左侧条目，查看文件用途和处理建议。双击目录可以进入。</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DirectoryItem, FileExplanation } from '../domain/desktop'
import { riskClass, riskLabel } from '../domain/risk'
import { formatBytes } from '../shared/format'
import { formatModified, fileTypeLabel } from '../application/explorer-format'
import AppIcon from './AppIcon.vue'
import PathSpacePanel from './PathSpacePanel.vue'
const props = defineProps<{
  explanation: FileExplanation | null; selected: DirectoryItem | null; mode: 'browse' | 'search'; displayName: string
  aiBusy: boolean; refreshingExplanation: boolean; aiConfigured: boolean; aiError: string
}>()
const emit = defineEmits<{
  action: [item: DirectoryItem, action: 'open' | 'reveal' | 'copy']
  review: []; cancel: []; settings: []
}>()
const objectDetails = computed(() => {
  if (!props.explanation) return []
  const item = props.explanation
  const ai = item.aiDetails
  const conclusion = [
    ai?.what || item.what || item.description || item.reason || '当前证据还不足以明确识别这个对象。',
    ai?.purpose || item.purpose
  ].filter(Boolean).join(' ')
  const relationship = [
    ai?.belongsTo || item.belongsTo || item.source,
    ai?.whyHere || item.whyHere
  ].filter(Boolean).join('。') || `当前只能确认它位于 ${item.parent || '磁盘根目录'}，所属来源仍需进一步确认。`
  return [
    { label: '识别结论', value: conclusion },
    { label: '与系统的关系', value: relationship },
    { label: '处理建议', value: ai?.handling || item.handling || item.action || '当前不建议直接处理；确认来源和影响后再决定。' }
  ]
})

</script>

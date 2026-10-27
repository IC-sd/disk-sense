<template>
  <section class="page settings-page">
    <header class="page-header settings-header">
      <div>
        <div class="eyebrow"><span></span> 应用偏好</div>
        <h1>设置与关于</h1>
        <p>让 Disk Sense 按你的习惯工作。</p>
      </div>
      <div v-if="info" class="version-badge">
        <span>当前版本</span>
        <b>v{{ info.version }}</b>
        <small>{{ info.packaged ? '正式构建' : '开发版本' }}</small>
      </div>
    </header>

    <p v-if="error" class="inline-message error-message" role="alert">{{ error }}</p>
    <p v-if="notice" class="inline-message settings-notice" role="status">{{ notice }}</p>

    <template v-if="info">
      <nav class="settings-tabs" role="tablist" aria-label="设置分类" @keydown="handleRovingKeydown">
        <button id="settings-general-tab" role="tab" aria-controls="settings-general" :tabindex="tab === 'general' ? 0 : -1" :aria-selected="tab === 'general'" :class="{ active: tab === 'general' }" @click="tab = 'general'">
          <AppIcon name="settings" />
          <span><b>通用</b><small>外观、隐私与安全</small></span>
        </button>
        <button id="settings-storage-tab" role="tab" aria-controls="settings-storage" :tabindex="tab === 'storage' ? 0 : -1" :aria-selected="tab === 'storage'" :class="{ active: tab === 'storage' }" @click="openStorage">
          <AppIcon name="database" />
          <span><b>存储位置</b><small>程序与本地数据</small></span>
        </button>
        <button id="settings-about-tab" role="tab" aria-controls="settings-about" :tabindex="tab === 'about' ? 0 : -1" :aria-selected="tab === 'about'" :class="{ active: tab === 'about' }" @click="openAbout">
          <AppIcon name="overview" />
          <span><b>关于</b><small>版本与设备信息</small></span>
        </button>
      </nav>

      <div v-if="tab === 'general'" id="settings-general" class="settings-sections" role="tabpanel" aria-labelledby="settings-general-tab">
        <div class="settings-content-heading"><h2>通用偏好</h2><p>外观与分析方式，随时可以调整。</p></div>
        <section class="preference-panel appearance-setting-panel">
          <header class="setting-section-heading">
            <span class="setting-heading-icon"><AppIcon name="spark" /></span>
            <div><h2>界面主题</h2><p>切换后立即应用，并在下次启动时保持。</p></div>
          </header>
          <div class="theme-options" role="radiogroup" aria-label="界面主题" @keydown="handleRovingKeydown">
            <button
              :class="{ active: theme === 'dark' }"
              role="radio"
              :aria-checked="theme === 'dark'"
              :tabindex="theme === 'dark' ? 0 : -1"
              @click="setTheme('dark')"
            >
              <span class="theme-preview dark-preview"><i></i><i></i><i></i></span>
              <span><b>深色</b><small>石墨色工作界面</small></span>
              <i class="theme-check"></i>
            </button>
            <button
              :class="{ active: theme === 'light' }"
              role="radio"
              :aria-checked="theme === 'light'"
              :tabindex="theme === 'light' ? 0 : -1"
              @click="setTheme('light')"
            >
              <span class="theme-preview light-preview"><i></i><i></i><i></i></span>
              <span><b>浅色</b><small>明亮清晰的阅读界面</small></span>
              <i class="theme-check"></i>
            </button>
          </div>
        </section>

        <div class="settings-two-column">
          <section class="preference-panel privacy-setting-panel">
            <header class="setting-section-heading">
              <span class="setting-heading-icon"><AppIcon name="shield" /></span>
              <div><h2>隐私与 AI</h2><p>本地分析默认不联网，AI 分析由你主动发起。</p></div>
              <span :class="['settings-state-chip', { configured: info.aiConfigured }]">{{ info.aiConfigured ? '已配置' : '未配置' }}</span>
            </header>
            <div class="settings-detail-row">
              <div class="settings-status-list">
                <span><i class="on"></i>API 密钥加密保存在本机</span>
                <span><i class="on"></i>远程服务使用加密连接</span>
              </div>
              <button class="quiet settings-ai-entry" @click="showAiSettings = true"><AppIcon name="settings" />配置 AI 分析<AppIcon name="arrow" /></button>
            </div>
          </section>

          <section class="preference-panel safety-setting-panel">
            <header class="setting-section-heading">
              <span class="setting-heading-icon"><AppIcon name="clean" /></span>
              <div><h2>清理安全边界</h2><p>每一步都保留你的决定权。</p></div>
            </header>
            <div class="safety-points">
              <span><i aria-hidden="true"></i>不提供永久删除</span>
              <span><i aria-hidden="true"></i>未知内容不自动选择</span>
              <span><i aria-hidden="true"></i>执行前重新校验文件</span>
              <span><i aria-hidden="true"></i>系统操作单独确认</span>
            </div>
          </section>
        </div>
      </div>

      <div v-else-if="tab === 'storage'" id="settings-storage" class="settings-sections" role="tabpanel" aria-labelledby="settings-storage-tab">
        <div class="settings-content-heading"><h2>存储位置</h2><p>查看程序目录，管理本地数据的存放位置。</p></div>
        <section class="storage-summary-panel">
          <div>
            <span class="storage-summary-icon"><AppIcon name="database" /></span>
            <div>
              <small>当前本地数据</small>
              <strong aria-live="polite">{{ dataUsageLoading ? '读取中…' : formatBytes(info.dataUsage.bytes) }}</strong>
              <p>{{ dataUsageLoading ? '正在统计本地数据占用' : `${info.dataUsage.files.toLocaleString()} 个文件 · ${locationSummary}` }}</p>
            </div>
          </div>
          <span :class="['location-badge', dataDrive === 'C:' ? 'system-drive' : 'other-drive']">
            {{ dataDrive || '未知磁盘' }}
          </span>
        </section>

        <aside v-if="shouldSuggestDataMove" class="storage-system-drive-warning">
          <AppIcon name="database" />
          <div>
            <b>本地索引正在占用系统盘空间</b>
            <p>
              已使用 {{ formatBytes(info.dataUsage.bytes) }}，可迁移到其他磁盘释放系统盘空间。迁移会先复制并校验，原目录会保留。
            </p>
          </div>
        </aside>

        <section class="location-panel">
          <article>
            <span class="location-icon"><AppIcon name="spark" /></span>
            <div class="location-copy">
              <small>程序安装位置</small>
              <h2>Disk Sense 程序文件</h2>
              <code :title="info.installPath">{{ info.installPath }}</code>
              <p>程序文件存放在这里；安装时可以选择其他磁盘。</p>
            </div>
            <div class="location-actions">
              <span>{{ installDrive || '未知磁盘' }}</span>
              <button class="secondary-button" @click="openInstallDirectory"><AppIcon name="folder" />打开位置</button>
            </div>
          </article>

          <article>
            <span class="location-icon data"><AppIcon name="database" /></span>
            <div class="location-copy">
              <small>本地数据目录</small>
              <h2>配置、分析与操作记录</h2>
              <code :title="info.userDataPath">{{ info.userDataPath }}</code>
              <p>{{ info.dataExternallyManaged ? '当前数据位置由启动配置管理，无法在应用内更改。' : '包含文件索引、配置和操作记录。更改位置后重启生效，原目录会保留。' }}</p>
            </div>
            <div class="location-actions">
              <button class="secondary-button" @click="openDataDirectory"><AppIcon name="folder" />打开目录</button>
              <button
                class="primary-button"
                :disabled="movingData || info.dataExternallyManaged"
                @click="moveDataDirectory"
              >
                <AppIcon name="arrow" />{{ movingData ? '正在校验…' : '更改位置' }}
              </button>
            </div>
          </article>
        </section>

        <aside class="storage-explanation">
          <AppIcon name="shield" />
          <div>
            <b>迁移前后，数据都有保留</b>
            <p>选择新目录后，Disk Sense 会复制并校验数据。重启确认新位置正常后，你可以自行处理原目录的备份。</p>
          </div>
        </aside>

        <section v-if="migration?.restartRequired" class="migration-result" role="status">
          <div>
            <b>数据已复制并通过校验</b>
            <p>新位置：{{ migration.target }}。已复制 {{ formatBytes(migration.copiedBytes) }}，旧数据仍保留。</p>
          </div>
          <button class="primary-button" @click="restartApp">立即重启并切换</button>
        </section>
      </div>

      <div v-else id="settings-about" class="settings-sections" role="tabpanel" aria-labelledby="settings-about-tab">
        <div class="settings-content-heading"><h2>关于 Disk Sense</h2><p>应用版本与当前设备信息。</p></div>
        <section class="about-hero">
          <span class="about-logo"><AppIcon name="database" /></span>
          <div>
            <small>本地磁盘空间工具</small>
            <h2>Disk Sense {{ info.version }}</h2>
            <p>看清空间去向，安心整理文件。</p>
          </div>
          <span class="mode-chip">{{ info.packaged ? '正式版本' : '开发版本' }}</span>
        </section>

        <div v-if="deviceLoading" class="settings-loading compact">正在读取设备信息…</div>
        <template v-else-if="device">
          <section class="device-panel">
            <header class="setting-section-heading">
              <span class="setting-heading-icon"><AppIcon name="overview" /></span>
              <div><h2>设备信息</h2><p>仅在本机读取，不会上传。</p></div>
            </header>
            <dl class="device-grid">
              <div><dt>设备名称</dt><dd>{{ device.deviceName }}</dd></div>
              <div><dt>设备型号</dt><dd>{{ deviceModel }}</dd></div>
              <div><dt>操作系统</dt><dd>{{ device.operatingSystem }}{{ device.osBuild ? `（${device.osBuild}）` : '' }}</dd></div>
              <div><dt>系统类型</dt><dd>{{ device.architecture }}</dd></div>
              <div><dt>处理器</dt><dd>{{ device.processor }}</dd></div>
              <div><dt>逻辑处理器</dt><dd>{{ device.logicalProcessors }} 个</dd></div>
              <div><dt>内存</dt><dd>{{ formatBytes(device.freeMemoryBytes) }} 可用 / {{ formatBytes(device.totalMemoryBytes) }} 总计</dd></div>
              <div><dt>图形设备</dt><dd>{{ graphicsSummary }}</dd></div>
              <div><dt>系统运行时间</dt><dd>{{ formatUptime(device.uptimeSeconds) }}</dd></div>
            </dl>
          </section>

        </template>

        <section class="project-panel">
          <div><span>版本</span><b>{{ info.version }}</b></div>
          <div><span>本地数据版本</span><b>v{{ info.stateVersion }}</b></div>
          <div><span>作者</span><b>IC-sd</b></div>
          <div><span>许可证</span><b>MIT</b></div>
          <p>开源项目：github.com/IC-sd/disk-sense</p>
        </section>
        <details class="settings-diagnostics" @toggle="loadDiagnostics">
          <summary>诊断与故障排查</summary>
          <p>在本机生成最近的运行记录，自动遮盖密钥和文件路径。复制后可自行核对再分享。</p>
          <button class="secondary-button" :disabled="diagnosticLoading" @click="copyDiagnostics">复制脱敏诊断</button>
          <pre v-if="diagnosticPreview">{{ diagnosticPreview }}</pre>
        </details>
      </div>
    </template>

    <div v-else-if="!error" class="settings-loading">正在读取应用信息…</div>
    <AiSettingsModal v-if="showAiSettings" @close="showAiSettings = false" @saved="status => { if (info) info.aiConfigured = status.configured }" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { applyTheme } from '../application/appearance'
import { handleRovingKeydown } from '../application/accessibility'
import AiSettingsModal from './AiSettingsModal.vue'
import { desktopApi } from '../platform/api'
import { formatBytes } from '../shared/format'
import type {
  AppInfo,
  AppTheme,
  DataMigrationResult,
  DeviceInfo,
  DirectoryUsage
} from '../domain/desktop'
import AppIcon from './AppIcon.vue'

type SettingsTab = 'general' | 'storage' | 'about'

const tab = ref<SettingsTab>('general')
const showAiSettings = ref(false)
const info = ref<AppInfo | null>(null)
const device = ref<DeviceInfo | null>(null)
const theme = ref<AppTheme>('dark')
const error = ref('')
const notice = ref('')
const movingData = ref(false)
const diagnosticPreview = ref('')
const diagnosticLoading = ref(false)

async function loadDiagnostics(event: Event) {
  if (!(event.target as HTMLDetailsElement).open || diagnosticLoading.value) return
  const api = desktopApi()
  if (!api?.appDiagnostics) return
  diagnosticLoading.value = true
  try { diagnosticPreview.value = JSON.stringify(await api.appDiagnostics(), null, 2) }
  catch (cause) { error.value = String(cause) }
  finally { diagnosticLoading.value = false }
}
async function copyDiagnostics() {
  const api = desktopApi()
  if (!api?.appDiagnosticsCopy) return
  try { await api.appDiagnosticsCopy(); notice.value = '脱敏诊断已复制，请核对后再分享。' }
  catch (cause) { error.value = String(cause) }
}
const deviceLoading = ref(false)
const migration = ref<DataMigrationResult | null>(null)
const dataUsageLoading = ref(false)

const dataDrive = computed(() => driveOf(info.value?.userDataPath))
const installDrive = computed(() => driveOf(info.value?.installPath))
const shouldSuggestDataMove = computed(() => (
  dataDrive.value === 'C:' &&
  Number(info.value?.dataUsage.bytes || 0) >= 128 * 1024 * 1024
))
const locationSummary = computed(() => {
  if (!dataDrive.value) return '位置未知'
  return dataDrive.value === 'C:' ? '当前位于系统盘' : `当前位于 ${dataDrive.value} 非系统盘`
})
const deviceModel = computed(() => {
  const value = [device.value?.manufacturer, device.value?.model].filter(Boolean).join(' ')
  return value || '未读取到型号'
})
const graphicsSummary = computed(() => {
  const names = device.value?.graphics.map(item => item.name).filter(Boolean) || []
  return names.length ? names.join(' / ') : '未读取到图形设备名称'
})

function driveOf(value?: string) {
  const matched = String(value || '').match(/^[A-Za-z]:/)
  return matched ? matched[0].toUpperCase() : ''
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatUptime(seconds: number) {
  const totalHours = Math.max(0, Math.floor(Number(seconds || 0) / 3600))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`
}

async function load() {
  const api = desktopApi()
  if (!api) {
    error.value = '请使用 Electron 桌面模式打开项目。'
    return
  }
  try {
    info.value = await api.appInfo()
    theme.value = info.value.appearance.theme
    applyTheme(theme.value)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function loadDataUsage() {
  const api = desktopApi()
  if (!api || !info.value || dataUsageLoading.value) return
  dataUsageLoading.value = true
  try {
    const usage: DirectoryUsage = await api.appDataUsage()
    if (info.value) info.value = { ...info.value, dataUsage: usage }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    dataUsageLoading.value = false
  }
}

async function openStorage() {
  tab.value = 'storage'
  await loadDataUsage()
}

async function setTheme(next: AppTheme) {
  const api = desktopApi()
  if (!api || next === theme.value) return
  const previous = theme.value
  theme.value = next
  applyTheme(next)
  error.value = ''
  try {
    const saved = await api.appAppearanceSet({ theme: next })
    theme.value = saved.theme
  } catch (cause) {
    theme.value = previous
    applyTheme(previous)
    error.value = messageOf(cause)
  }
}

async function openDataDirectory() {
  try {
    await desktopApi()?.appOpenDataDirectory()
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function openInstallDirectory() {
  try {
    await desktopApi()?.appOpenInstallDirectory()
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function moveDataDirectory() {
  const api = desktopApi()
  if (!api || movingData.value) return
  movingData.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.appMoveDataDirectory()
    if (result.cancelled) return
    migration.value = result
    if (!result.changed) notice.value = '选择的位置就是当前数据目录，无需迁移。'
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    movingData.value = false
  }
}

async function restartApp() {
  try {
    await desktopApi()?.appRestart()
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function openAbout() {
  tab.value = 'about'
  if (device.value || deviceLoading.value) return
  const api = desktopApi()
  if (!api) return
  deviceLoading.value = true
  error.value = ''
  try {
    device.value = await api.appDeviceInfo()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    deviceLoading.value = false
  }
}

onMounted(() => void load())
</script>

<style src="./settings.css"></style>

<template>
  <section class="page settings-page">
    <header class="page-header settings-header">
      <div>
        <div class="eyebrow"><span></span> SETTINGS &amp; ABOUT</div>
        <h1>设置与关于</h1>
        <p>管理界面主题与本地数据位置，并查看这台设备和当前应用的真实信息。</p>
      </div>
      <div v-if="info" class="version-badge">
        <span>DISK SENSE</span>
        <b>v{{ info.version }}</b>
        <small>{{ info.packaged ? '正式构建' : '桌面热开发' }}</small>
      </div>
    </header>

    <p v-if="error" class="inline-message error-message">{{ error }}</p>
    <p v-if="notice" class="inline-message settings-notice">{{ notice }}</p>

    <template v-if="info">
      <nav class="settings-tabs" aria-label="设置分类">
        <button :class="{ active: tab === 'about' }" @click="openAbout">
          <AppIcon name="overview" />
          <span><b>关于</b><small>版本与设备信息</small></span>
        </button>
        <button :class="{ active: tab === 'storage' }" @click="tab = 'storage'">
          <AppIcon name="database" />
          <span><b>存储位置</b><small>程序与本地数据</small></span>
        </button>
        <button :class="{ active: tab === 'general' }" @click="tab = 'general'">
          <AppIcon name="settings" />
          <span><b>通用</b><small>外观、隐私与安全</small></span>
        </button>
      </nav>

      <div v-if="tab === 'general'" class="settings-sections">
        <section class="preference-panel">
          <header class="setting-section-heading">
            <span class="setting-heading-icon"><AppIcon name="spark" /></span>
            <div><h2>界面主题</h2><p>切换后立即应用，并在下次启动时保持。</p></div>
          </header>
          <div class="theme-options" role="radiogroup" aria-label="界面主题">
            <button
              :class="{ active: theme === 'dark' }"
              role="radio"
              :aria-checked="theme === 'dark'"
              @click="setTheme('dark')"
            >
              <span class="theme-preview dark-preview"><i></i><i></i><i></i></span>
              <span><b>深色</b><small>降低暗光环境的视觉刺激</small></span>
              <i class="theme-check"></i>
            </button>
            <button
              :class="{ active: theme === 'light' }"
              role="radio"
              :aria-checked="theme === 'light'"
              @click="setTheme('light')"
            >
              <span class="theme-preview light-preview"><i></i><i></i><i></i></span>
              <span><b>浅色</b><small>适合明亮环境与高对比阅读</small></span>
              <i class="theme-check"></i>
            </button>
          </div>
        </section>

        <section class="preference-panel search-maintenance-panel">
          <header class="setting-section-heading">
            <span class="setting-heading-icon"><AppIcon name="search" /></span>
            <div>
              <h2>文件搜索</h2>
              <p>启动后自动准备搜索数据库，并在后台同步文件新增、改名和删除。</p>
            </div>
          </header>
          <div class="search-maintenance-content">
            <div class="search-maintenance-status">
              <span :class="['search-health-dot', { active: searchIndex?.watching || searchIndex?.building }]"></span>
              <div>
                <b>{{ searchIndexLabel }}</b>
                <p>{{ searchIndexDescription }}</p>
              </div>
            </div>
            <button
              class="secondary-button"
              :disabled="!searchIndex?.available || searchIndex?.building || rebuildingSearch"
              @click="rebuildSearchIndex"
            >
              <AppIcon name="scan" />
              {{ searchIndex?.building ? '正在后台准备' : '重新建立搜索数据库' }}
            </button>
          </div>
        </section>

        <div class="settings-two-column">
          <section class="preference-panel">
            <header class="setting-section-heading">
              <span class="setting-heading-icon"><AppIcon name="shield" /></span>
              <div><h2>隐私与 AI</h2><p>本地分析默认不联网。</p></div>
            </header>
            <div class="settings-status-list">
              <span><i :class="{ on: info.aiConfigured }"></i>AI 辅助：{{ info.aiConfigured ? '已配置' : '未配置' }}</span>
              <span><i class="on"></i>远程接口只允许 HTTPS</span>
              <span><i class="on"></i>API 密钥使用 Windows 安全存储加密</span>
            </div>
          </section>

          <section class="preference-panel">
            <header class="setting-section-heading">
              <span class="setting-heading-icon"><AppIcon name="clean" /></span>
              <div><h2>清理安全边界</h2><p>限制位于执行层，不依赖界面选择。</p></div>
            </header>
            <div class="safety-points">
              <span>不提供永久删除</span>
              <span>未知内容不自动选择</span>
              <span>执行前重新校验文件状态</span>
              <span>系统维护仅调用固定白名单</span>
            </div>
          </section>
        </div>
      </div>

      <div v-else-if="tab === 'storage'" class="settings-sections">
        <section class="storage-summary-panel">
          <div>
            <span class="storage-summary-icon"><AppIcon name="database" /></span>
            <div>
              <small>当前本地数据</small>
              <strong>{{ formatBytes(info.dataUsage.bytes) }}</strong>
              <p>{{ info.dataUsage.files.toLocaleString() }} 个文件 · {{ locationSummary }}</p>
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
              当前 Disk Sense 数据已达到 {{ formatBytes(info.dataUsage.bytes) }}，其中通常以全盘文件搜索索引为主。
              建议把数据目录迁移到 D 盘等非系统盘；迁移会先复制并校验，原数据不会自动删除。
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
              <p>安装版在安装过程中可选择目录；便携版保存在下载时选择的位置。</p>
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
              <h2>配置、扫描基线与操作记录</h2>
              <code :title="info.userDataPath">{{ info.userDataPath }}</code>
              <p>更改后，新位置将在重启后生效；原目录会保留作为安全备份，不会自动删除。</p>
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
            <b>Disk Sense 如何减少 C 盘占用</b>
            <p>程序安装目录由用户在安装时选择；应用内可将状态、变化基线、历史记录和后续运行数据迁移到 D 盘。确认新位置正常并自行处理旧备份后，C 盘长期只需保留一个很小的定位文件。</p>
          </div>
        </aside>

        <section v-if="migration?.restartRequired" class="migration-result">
          <div>
            <b>数据已复制并通过校验</b>
            <p>新位置：{{ migration.target }}。已复制 {{ formatBytes(migration.copiedBytes) }}，旧数据仍保留。</p>
          </div>
          <button class="primary-button" @click="restartApp">立即重启并切换</button>
        </section>
      </div>

      <div v-else class="settings-sections">
        <section class="about-hero">
          <span class="about-logo"><AppIcon name="spark" /></span>
          <div>
            <small>PERSONAL STORAGE EXPLAINER</small>
            <h2>Disk Sense {{ info.version }}</h2>
            <p>可靠地清理已知空间，谨慎地解释未知空间。</p>
          </div>
          <span class="mode-chip">{{ info.packaged ? '正式版本' : '热开发模式' }}</span>
        </section>

        <div v-if="deviceLoading" class="settings-loading compact">正在读取设备信息…</div>
        <template v-else-if="device">
          <section class="device-panel">
            <header class="setting-section-heading">
              <span class="setting-heading-icon"><AppIcon name="overview" /></span>
              <div><h2>设备信息</h2><p>信息直接从当前 Windows 设备读取，不会上传。</p></div>
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
          <div><span>状态格式</span><b>v{{ info.stateVersion }}</b></div>
          <div><span>作者</span><b>IC-sd</b></div>
          <div><span>许可证</span><b>MIT</b></div>
          <p>开源项目：github.com/IC-sd/disk-sense</p>
        </section>
      </div>
    </template>

    <div v-else-if="!error" class="settings-loading">正在读取应用信息…</div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { applyTheme } from '../application/appearance'
import { desktopApi } from '../platform/api'
import { formatBytes } from '../shared/format'
import type {
  AppInfo,
  AppTheme,
  DataMigrationResult,
  DeviceInfo,
  DirectoryUsage,
  FileSearchIndexStatus
} from '../domain/desktop'
import AppIcon from './AppIcon.vue'

type SettingsTab = 'general' | 'storage' | 'about'

const tab = ref<SettingsTab>('about')
const info = ref<AppInfo | null>(null)
const device = ref<DeviceInfo | null>(null)
const theme = ref<AppTheme>('dark')
const error = ref('')
const notice = ref('')
const movingData = ref(false)
const deviceLoading = ref(false)
const migration = ref<DataMigrationResult | null>(null)
const searchIndex = ref<FileSearchIndexStatus | null>(null)
const rebuildingSearch = ref(false)
const dataUsageLoading = ref(false)
let stopIndexProgress: (() => void) | null = null

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
const searchIndexLabel = computed(() => {
  if (!searchIndex.value?.available) return '文件搜索暂时不可用'
  if (searchIndex.value.building) return `正在准备 · ${searchIndex.value.entries.toLocaleString()} 项可搜索`
  if (searchIndex.value.watching) return '自动维护中'
  if (searchIndex.value.indexed) return '搜索数据库可用'
  return '等待后台启动'
})
const searchIndexDescription = computed(() => {
  const state = searchIndex.value
  if (!state) return '正在读取搜索状态。'
  if (state.lastError) return `最近一次后台同步未完成：${state.lastError}`
  if (state.building) {
    return `${state.entries.toLocaleString()} 项已可用；其余内容会继续在后台准备。`
  }
  if (state.indexed) {
    const mode = state.watching ? '文件变化会自动同步' : '后台会定期校对'
    return `${state.entries.toLocaleString()} 项可搜索 · ${mode} · 不读取文件正文。`
  }
  return '应用会自动建立搜索数据库，不需要在搜索页手动操作。'
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

async function loadSearchIndexStatus() {
  const api = desktopApi()
  if (!api) return
  try {
    searchIndex.value = await api.inspectIndexStatus()
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

async function rebuildSearchIndex() {
  const api = desktopApi()
  if (!api || rebuildingSearch.value || searchIndex.value?.building) return
  rebuildingSearch.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.inspectIndexStart({ scope: 'all' })
    searchIndex.value = result.status
    notice.value = result.started
      ? '搜索数据库正在后台重新建立，你可以继续使用其他功能。'
      : result.reason || '搜索数据库已经在维护中。'
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    rebuildingSearch.value = false
  }
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

onMounted(() => {
  stopIndexProgress = desktopApi()?.onInspectIndexProgress((status) => {
    searchIndex.value = status
  }) || null
  void (async () => {
    await load()
    await Promise.allSettled([
      loadDataUsage(),
      loadSearchIndexStatus(),
      openAbout()
    ])
  })()
})

onBeforeUnmount(() => {
  stopIndexProgress?.()
  stopIndexProgress = null
})
</script>

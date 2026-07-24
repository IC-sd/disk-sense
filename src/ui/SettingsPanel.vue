<template>
  <section class="page settings-page">
    <header class="page-header">
      <div>
        <div class="eyebrow"><span></span> SETTINGS &amp; ABOUT</div>
        <h1>设置与关于</h1>
        <p>查看当前版本、数据保存位置，以及 Disk Sense 始终遵守的安全边界。</p>
      </div>
      <div v-if="info" class="version-badge">
        <span>DISK SENSE</span>
        <b>v{{ info.version }}</b>
        <small>{{ info.packaged ? '正式构建' : '桌面开发模式' }}</small>
      </div>
    </header>

    <p v-if="error" class="inline-message error-message">{{ error }}</p>

    <div v-if="info" class="settings-grid">
      <section class="settings-card about-card">
        <div class="settings-card-icon"><AppIcon name="spark" /></div>
        <div>
          <span>当前运行环境</span>
          <h2>{{ info.name }} {{ info.version }}</h2>
          <p>Windows {{ info.architecture }} · 状态格式 v{{ info.stateVersion }}</p>
        </div>
        <span class="mode-chip">{{ info.packaged ? 'PACKAGED' : 'HOT DEV' }}</span>
      </section>

      <section class="settings-card data-card">
        <header><AppIcon name="database" /><div><h2>本地数据</h2><p>配置、变化基线和清理记录保存在这里。</p></div></header>
        <code>{{ info.userDataPath }}</code>
        <button class="secondary-button" @click="openDataDirectory"><AppIcon name="folder" />打开数据目录</button>
      </section>

      <section class="settings-card privacy-card">
        <header><AppIcon name="shield" /><div><h2>隐私与 AI</h2><p>本地分析默认不联网，只有主动请求 AI 时才发送当前对象的有限证据。</p></div></header>
        <div class="settings-status-list">
          <span><i :class="{ on: info.aiConfigured }"></i>AI 辅助：{{ info.aiConfigured ? '已配置' : '未配置' }}</span>
          <span><i class="on"></i>远程接口：只允许 HTTPS</span>
          <span><i class="on"></i>API 密钥：Windows 安全存储加密</span>
        </div>
      </section>

      <section class="settings-card safety-card">
        <header><AppIcon name="clean" /><div><h2>清理安全边界</h2><p>这些限制写在执行层，不依赖界面是否正确。</p></div></header>
        <div class="safety-points">
          <span>不提供永久删除</span>
          <span>未知内容不自动选择</span>
          <span>执行前重新校验路径与文件身份</span>
          <span>高风险系统能力只检测、不执行</span>
        </div>
      </section>
    </div>

    <div v-else-if="!error" class="settings-loading">正在读取应用信息…</div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { desktopApi } from '../platform/api'
import type { AppInfo } from '../domain/desktop'
import AppIcon from './AppIcon.vue'

const info = ref<AppInfo | null>(null)
const error = ref('')

async function load() {
  const api = desktopApi()
  if (!api) {
    error.value = '请使用 Electron 桌面模式打开项目。'
    return
  }
  try {
    info.value = await api.appInfo()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function openDataDirectory() {
  const api = desktopApi()
  if (!api) return
  try {
    await api.appOpenDataDirectory()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

onMounted(() => void load())
</script>

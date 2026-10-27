<template>
  <section class="page explorer-page" :class="{ 'browse-mode': mode === 'browse' }">
    <header class="page-header explorer-header">
      <div>
        <div class="eyebrow"><span></span> 文件工作区</div>
        <h1>目录与文件</h1>
        <p>找到文件，了解用途，再决定如何处理。</p>
      </div>
      <div class="explorer-header-actions">
        <div class="explorer-mode-switch" role="tablist" aria-label="目录工作模式">
          <button role="tab" :aria-selected="mode === 'browse'" :class="{ active: mode === 'browse' }" @click="setMode('browse')">
            <AppIcon name="folder" />目录浏览
          </button>
          <button role="tab" :aria-selected="mode === 'search'" :class="{ active: mode === 'search' }" @click="setMode('search')">
            <AppIcon name="search" />文件搜索
          </button>
        </div>
        <div class="header-status">
          <span :class="{ online: aiConfigured }"></span>
          {{ aiConfigured ? 'AI 辅助已就绪' : '本地分析模式' }}
        </div>
      </div>
    </header>

    <div v-if="mode === 'browse'" class="path-bar">
      <div class="toolbar-actions">
        <button class="icon-button" title="返回 · Alt+←" aria-label="返回" :disabled="historyIndex <= 0 || loading" @click="goBack"><AppIcon name="arrow" class="back-arrow" /></button>
        <button class="icon-button" title="前进 · Alt+→" aria-label="前进" :disabled="historyIndex >= history.length - 1 || loading" @click="goForward"><AppIcon name="arrow" /></button>
        <button class="icon-button" title="上级目录 · Alt+↑" aria-label="上级目录" :disabled="loading" @click="goUp"><AppIcon name="arrow" class="up-arrow" /></button>
      </div>
      <div class="path-input-wrap">
        <AppIcon name="folder" />
        <input
          ref="pathInputElement"
          v-model="pathInput"
          aria-label="目录路径"
          @keyup.enter="loadDirectory(pathInput)"
          placeholder="输入 Windows 路径，例如 C:\Users"
        />
      </div>
      <button class="primary-button compact" :disabled="loading" @click="loadDirectory(pathInput)">
        <AppIcon name="arrow" />
        {{ loading ? '正在前往' : '前往' }}
      </button>
      <button class="icon-button" title="刷新 · F5" aria-label="刷新目录" :disabled="loading" @click="loadDirectory(browsePath, false)"><AppIcon name="refresh" /></button>
    </div>

    <div v-else class="search-workspace">
      <div class="search-commandbar">
        <div class="search-input-wrap">
          <AppIcon name="search" />
          <input
            ref="searchInputElement"
            v-model="searchQuery"
            aria-label="搜索文件或文件夹"
            placeholder="搜索文件名、路径、拼音或缩写…"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-controls="explorer-items"
            :aria-expanded="searchItems.length > 0"
            :aria-activedescendant="selected ? `file-result-${activeItems.findIndex(item => item.path === selected?.path)}` : undefined"
            @input="scheduleSearch"
            @compositionstart="searchComposing = true"
            @compositionend="searchComposing = false; scheduleSearch()"
            @keydown="handleSearchInputKeydown"
          />
          <button v-if="searchQuery" class="search-clear" aria-label="清空搜索" @click="clearSearch"><AppIcon name="close" /></button>
          <label class="search-scope-control">
            <AppIcon name="database" />
            <select v-model="searchScope" aria-label="搜索范围" @change="performSearch({ resetPosition: true })"><option value="all">整台电脑</option><option value="directory">当前目录</option></select>
          </label>
          <kbd>Ctrl K</kbd>
        </div>
      </div>

      <div class="search-filterbar">
        <div class="search-kind-filters" role="group" aria-label="文件类型">
          <button
            v-for="filter in kindFilters"
            :key="filter.value"
            :class="{ active: searchKind === filter.value }"
            :aria-pressed="searchKind === filter.value"
            @click="searchKind = filter.value; performSearch({ resetPosition: true })"
          >
            {{ filter.label }}
          </button>
        </div>
        <label>
          <span>修改时间</span>
          <select v-model="searchModified" aria-label="修改时间" @change="performSearch({ resetPosition: true })">
            <option value="any">不限</option>
            <option value="day">最近 1 天</option>
            <option value="week">最近 7 天</option>
            <option value="month">最近 30 天</option>
            <option value="year">最近 1 年</option>
          </select>
        </label>
        <label>
          <span>排序</span>
          <select v-model="searchSort" aria-label="搜索排序" @change="performSearch({ resetPosition: true, reuseSession: true })">
            <option value="relevance">相关度</option>
            <option value="modified">修改时间</option>
            <option value="size">大小</option>
            <option value="name">名称</option>
          </select>
        </label>
      </div>

      <div class="index-status" :class="{ building: searchIndex?.building, warning: !searchIndex?.indexed }">
        <div class="search-result-summary" role="status" aria-live="polite" aria-atomic="true">
          <span class="index-status-dot"></span>
          <span v-if="searching">正在搜索…</span>
          <template v-else-if="searchResultMeta">
            <b>找到 {{ (searchResultMeta.total ?? searchItems.length).toLocaleString() }} 项</b>
            <span v-if="searchResultMeta.truncated">已加载 {{ searchItems.length }} 项</span>
          </template>
          <span v-else-if="searchIndex?.indexed">可搜索 {{ searchIndex.entries.toLocaleString() }} 项</span>
          <span v-else-if="searchIndex && !searchIndex.available">文件索引暂时不可用</span>
          <span v-else>正在收录文件，结果将自动出现</span>
        </div>
        <details class="search-index-details">
          <summary><AppIcon name="database" />搜索状态<AppIcon name="arrow" /></summary>
          <div class="search-index-popover">
            <b>本机文件索引</b>
            <p v-if="searchIndex && !searchIndex.available">{{ searchIndex.error || '文件索引暂时不可用，请稍后重试。' }}</p>
            <template v-else-if="searchIndex?.indexed">
              <p>已收录 {{ searchIndex.entries.toLocaleString() }} 项，{{ searchIndex.watching || searchIndex.ntfs?.active ? '文件变化自动同步。' : '后台定期校对。' }}</p>
              <p v-if="searchIndex.building">正在扩展搜索范围，现有结果可立即使用。</p>
              <p v-if="searchIndex.completedAt">上次校对 {{ formatRelativeTime(searchIndex.completedAt) }}</p>
              <p v-if="searchIndex.ntfs?.active">{{ searchIndex.ntfs.persistent ? '开机加速已启用' : '全盘加速已启用' }}</p>
              <p v-if="searchIndex.phase === 'partial'">已达到性能保护上限，部分位置尚未收录。</p>
            </template>
            <p v-else>正在收录文件。已收录的内容可立即搜索，无需等到全部完成。</p>
            <p v-if="searchResultMeta">本次搜索用时 {{ searchResultMeta.tookMs }} ms</p>
            <p v-if="searchIndex?.nativeStage === 'publishing'">正在发布已校验的文件索引。</p>
            <p v-if="searchIndex?.ntfs?.pendingReplays?.length">正在继续同步上次未完成的文件变更。</p>
            <button v-if="searchIndex?.ntfs?.requiresElevation || (searchIndex?.ntfs?.active && !searchIndex.ntfs.persistent)" class="quiet" :disabled="ntfsEnabling" title="安装开机自动运行的只读搜索服务，首次需要 Windows 管理员确认" @click="enableNtfsSearch()">{{ ntfsEnabling ? '正在启用…' : '启用开机加速' }}</button>
            <button v-else-if="searchIndex?.ntfs?.persistent" class="quiet" :disabled="ntfsEnabling" title="卸载搜索服务并保留已有索引，需要 Windows 管理员确认" @click="enableNtfsSearch(true)">{{ ntfsEnabling ? '正在关闭…' : '关闭开机加速' }}</button>
          </div>
        </details>
      </div>
    </div>

    <nav v-if="mode === 'browse'" class="explorer-locations" aria-label="常用位置">
      <button v-for="location in quickLocations" :key="location.path" :title="location.path" :class="{ active: browsePath.toLowerCase() === location.path.toLowerCase() }" @click="loadDirectory(location.path)"><AppIcon name="folder" />{{ location.name }}</button>
      <button v-for="location in favoritePaths" :key="`favorite-${location}`" :title="location" @click="loadDirectory(location)">★ {{ pathName(location) }}</button>
      <button class="favorite-location" :aria-pressed="isFavorite" @click="toggleFavorite">{{ isFavorite ? '★ 已收藏' : '☆ 收藏当前位置' }}</button>
    </nav>

    <p v-if="activeError" class="inline-message error-message">{{ activeError }}</p>
    <p v-if="fileActionNotice" class="file-action-notice" role="status">{{ fileActionNotice }}</p>

    <div
      class="explorer-layout"
      :class="{ 'search-awaiting-selection': mode === 'search' && !searchAnalysisOpen }"
    >
      <section class="file-list" :class="{ 'search-results': mode === 'search' }" aria-label="文件和目录列表">
        <div v-if="mode === 'browse'" class="explorer-toolbar file-list-toolbar">
          <div class="breadcrumbs">
            <button v-for="crumb in visibleCrumbs" :key="crumb.path" @click="loadDirectory(crumb.path)">
              {{ crumb.name }}
            </button>
          </div>
          <div class="directory-meta">
            <span>{{ inspectItems.length.toLocaleString() }} 项</span>
            <span v-if="estimatingCount">{{ estimatingCount }} 个目录正在估算</span>
            <span v-if="directoryLoadingMore" role="status">正在继续读取目录…</span>
            <button v-else-if="directoryTruncated && directorySessionId" class="text-button" @click="continueDirectoryListing()">继续读取目录</button>
            <span v-else-if="directoryTruncated">目录尚未完整读取，请刷新重试</span>
          </div>
        </div>

        <div v-if="mode === 'browse'" class="browse-controls">
          <label><AppIcon name="search" /><input v-model="browseFilter" aria-label="筛选当前目录" placeholder="筛选当前目录" @input="resetListScroll" /><button v-if="browseFilter" class="browse-filter-clear" aria-label="清空目录筛选" @click="browseFilter = ''; resetListScroll()"><AppIcon name="close" /></button></label>
          <select v-model="browseSort" aria-label="目录排序" @change="resetListScroll"><option value="name">名称</option><option value="size">大小 ↓</option><option value="modified">修改时间 ↓</option></select>
          <small>{{ browseFilter ? `${activeItems.length} 项匹配` : '文件夹优先' }}</small>
        </div>

        <div class="list-head">
          <template v-if="mode === 'browse'">
            <span>名称</span><span>初步判断</span><span>大小</span>
          </template>
          <template v-else>
            <span>名称与位置</span><span>匹配类型</span><span>最近修改</span>
          </template>
        </div>

        <div v-if="showListLoading" class="list-loading">
          <div v-for="index in 8" :key="index" class="skeleton-row"><i></i><span></span><small></small></div>
        </div>

        <div v-else id="explorer-items" ref="fileScroller" class="file-scroll" :role="activeItems.length ? 'listbox' : undefined" aria-label="文件列表" :tabindex="activeItems.length ? 0 : -1" @scroll="onListScroll" @keydown="handleListKeydown">
          <div class="file-spacer" :style="{ height: `${activeItems.length * activeRowHeight}px` }">
            <button
              v-for="row in visibleRows"
              :key="row.item.path"
              class="file-row"
              :id="`file-result-${row.index}`"
              role="option"
              :aria-selected="selected?.path === row.item.path"
              tabindex="-1"
              :class="[
                {
                  selected: selected?.path === row.item.path,
                  'search-result-row': mode === 'search',
                  'top-result': mode === 'search' && row.index === 0 && !selected
                },
                mode === 'search' ? `priority-${searchPriority(row.item)}` : ''
              ]"
              :style="{ height: `${activeRowHeight}px`, transform: `translateY(${row.index * activeRowHeight}px)` }"
              @click="handleRowClick(row.item)"
              @dblclick="handleRowDoubleClick(row.item)"
            >
              <span class="file-name">
                <i
                  :class="[
                    {
                      directory: row.item.isDirectory,
                      native: mode === 'search' && Boolean(nativeIcon(row.item.path))
                    },
                    mode === 'search' ? `kind-${searchItemKind(row.item)}` : ''
                  ]"
                >
                  <img
                    v-if="mode === 'search' && nativeIcon(row.item.path)"
                    class="native-result-icon"
                    :src="nativeIcon(row.item.path)"
                    alt=""
                  />
                  <AppIcon v-else :name="mode === 'search' ? searchIconName(row.item) : (row.item.isDirectory ? 'folder' : 'file')" />
                </i>
                <span>
                  <b v-if="mode === 'browse'">{{ row.item.name }}</b>
                  <b v-else class="search-result-name">
                    <template v-for="(segment, segmentIndex) in searchNameSegments(displayItemName(row.item), row.item)" :key="`${row.item.path}-${segmentIndex}`">
                      <mark v-if="segment.match">{{ segment.text }}</mark>
                      <span v-else>{{ segment.text }}</span>
                    </template>
                  </b>
                  <small v-if="mode === 'browse' && row.item.fileCount && row.item.isDirectory">
                    已抽样 {{ row.item.fileCount.toLocaleString() }} 个文件
                  </small>
                  <small v-else-if="mode === 'search'" class="row-path" :title="row.item.path">
                    {{ parentPath(row.item.path) }}
                  </small>
                </span>
              </span>
              <span v-if="mode === 'browse'" class="row-classification">{{ row.item.source || '待分析' }}</span>
              <span v-else class="row-result-type">
                <b>{{ searchResultReason(row.item) }}</b>
                <small>
                  {{ row.item.isDirectory ? '文件夹' : fileTypeLabel(row.item.extension) }}
                  <template v-if="!row.item.isDirectory"> · {{ formatBytes(row.item.size) }}</template>
                </small>
              </span>
              <span v-if="mode === 'browse'" class="row-size">
                {{
                  row.item.metadataPending
                    ? '读取中…'
                    : row.item.isDirectory && row.item.size === null
                      ? (estimatingPaths.has(row.item.path) ? '估算中…' : '待估算')
                      : row.item.size === null
                        ? '大小未知'
                        : `${row.item.isDirectory && row.item.sizeEstimated ? '≥ ' : ''}${formatBytes(row.item.size)}`
                }}
                <small v-if="row.item.isDirectory && row.item.sizeEstimated && row.item.size !== null">抽样估算</small>
              </span>
              <span v-else class="row-modified">
                <b>{{ formatRelativeModified(row.item.modifiedAt) }}</b>
                <small>{{ formatModified(row.item.modifiedAt) }}</small>
              </span>
            </button>
          </div>
          <div v-if="!activeItems.length" class="list-empty" :class="{ 'search-welcome': mode === 'search' && !searchQuery.trim() }">
            <div class="list-empty-icon"><AppIcon :name="mode === 'search' ? 'search' : 'folder'" /></div>
            <b>{{ emptyTitle }}</b>
            <span>{{ emptyDescription }}</span>
            <div v-if="mode === 'search' && !searchQuery.trim()" class="search-examples" aria-label="搜索示例">
              <button @click="applySearchExample('report')"><code>report</code><span>文件名称</span><AppIcon name="arrow" /></button>
              <button @click="applySearchExample('baogao')"><code>baogao</code><span>中文拼音</span><AppIcon name="arrow" /></button>
              <button @click="applySearchExample('ext:pdf')"><code>ext:pdf</code><span>文件类型</span><AppIcon name="arrow" /></button>
            </div>
            <button v-else-if="mode === 'search' && (searchKind !== 'all' || searchModified !== 'any')" class="text-button" @click="searchKind = 'all'; searchModified = 'any'; performSearch({ resetPosition: true })">清除类型和时间筛选</button>
          </div>
        </div>
      </section>

      <div v-if="mode === 'search'" class="search-actionbar">
        <span class="search-keyboard-hints"><span><kbd>↑ ↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Ctrl Enter</kbd> 定位</span><span><kbd>Alt Enter</kbd> 分析</span></span>
        <button v-if="searchResultMeta?.nextOffset != null" class="quiet" :disabled="searching" @click="performSearch({ append: true })">{{ searching ? '加载中…' : '加载更多' }}</button>
        <div v-if="searchTarget">
          <button class="quiet" @click="runFileAction(searchTarget, 'open')"><AppIcon name="arrow" />打开</button>
          <button class="quiet" @click="runFileAction(searchTarget, 'reveal')"><AppIcon name="folder" />定位</button>
          <button class="quiet" @click="runFileAction(searchTarget, 'copy')">复制路径</button>
          <button class="quiet" @click="searchAnalysisOpen ? (searchAnalysisOpen = false) : analyzeSearchTarget()"><AppIcon name="scan" />{{ searchAnalysisOpen ? '收起分析' : '查看分析' }}</button>
        </div>
      </div>

      <aside ref="explainPanel" class="explain-panel">
        <header class="analysis-panel-heading">
          <span><AppIcon name="scan" />文件分析</span>
          <button v-if="mode === 'search'" class="analysis-panel-close" aria-label="收起文件分析" @click="searchAnalysisOpen = false"><AppIcon name="close" /></button>
          <small v-else>本地证据优先</small>
        </header>
        <div
          v-if="explanation"
          class="explanation-content"
          :class="{ 'ai-result': explanation.aiAnalyzed }"
        >
          <div class="object-heading">
            <div class="object-icon"><AppIcon :name="selected?.isDirectory ? 'folder' : 'file'" /></div>
            <div>
              <span>{{ explanation.kind }}</span>
              <h2>{{ selected ? (mode === 'search' ? displayItemName(selected) : selected.name) : '' }}</h2>
              <small class="explained-path" :title="selected?.path">{{ selected?.path }}</small>
            </div>
          </div>

          <div v-if="selected && mode === 'browse'" class="object-file-actions">
            <button v-if="mode === 'browse'" class="quiet" @click="runFileAction(selected, 'open')">打开</button>
            <button v-if="mode === 'browse'" class="quiet" @click="runFileAction(selected, 'reveal')">定位</button>
            <button v-if="mode === 'browse'" class="quiet" @click="runFileAction(selected, 'copy')">复制路径</button>
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
            <button class="ai-review" :class="{ completed: explanation.aiAnalyzed }" :disabled="aiBusy || refreshingExplanation" @click="requestAi">
              <AppIcon name="spark" />
              <span>
                <b>{{ aiBusy ? '分析中…' : explanation.aiAnalyzed ? '重新分析' : 'AI 分析' }}</b>
                <small>{{ aiConfigured ? '结合本地证据，解释用途与处理建议' : '配置模型后，补充文件用途与处理建议' }}</small>
              </span>
            </button>
            <button class="ai-config-link secondary-button" @click="showAiSettings = true"><AppIcon name="settings" />设置</button>
          </div>
          <div v-if="aiBusy" class="analysis-progress" role="status">
            <i></i><span>正在结合本地证据分析</span>
            <button class="quiet ai-cancel" @click="cancelAi">取消本次分析</button>
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
      </aside>
    </div>

    <AiSettingsModal
      v-if="showAiSettings"
      @close="showAiSettings = false"
      @saved="status => { aiConfigured = status.configured }"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import { createAiEvidence } from '../application/ai-evidence'
import { appAiAnalysisSession, applyAiRecord } from '../application/ai-session'
import type { AiSessionRecord } from '../application/ai-session'
import type {
  DirectoryItem,
  FileExplanation,
  FileSearchIndexStatus,
  FileSearchItem,
  FileSearchKind,
  FileSearchModified,
  FileSearchResult,
  FileSearchSort,
  NativeFilePresentation,
  StoredAiAnalysis
} from '../domain/desktop'
import { riskClass, riskLabel } from '../domain/risk'
import { formatBytes } from '../shared/format'
import { browseItems, highlightSearchName, readFavoritePaths, searchEnterAction, type BrowseSort } from '../application/explorer'
import AiSettingsModal from './AiSettingsModal.vue'
import AppIcon from './AppIcon.vue'
import PathSpacePanel from './PathSpacePanel.vue'

const props = defineProps<{ requestedPath?: { path: string; id: number } | null; requestedSearch?: number }>()
let appliedPathRequest = 0
async function applyPathRequest() {
  const request = props.requestedPath
  if (!request || appliedPathRequest === request.id) return false
  appliedPathRequest = request.id
  mode.value = 'browse'
  searchAnalysisOpen.value = false
  searchRequestId += 1
  searching.value = false
  await loadDirectory(request.path)
  return true
}
watch(() => props.requestedPath, () => { if (workspaceActive) void applyPathRequest() })

type ExplorerMode = 'browse' | 'search'

const mode = ref<ExplorerMode>('browse')
const pathInput = ref('C:\\')
const browsePath = ref('')
const browseFilter = ref('')
const browseSort = ref<BrowseSort>('name')
const quickLocations = ref<Array<{ name: string; path: string }>>([])
const favoritePaths = ref<string[]>([])
const isFavorite = computed(() => favoritePaths.value.some(location => location.toLowerCase() === browsePath.value.toLowerCase()))
const pathInputElement = ref<HTMLInputElement | null>(null)
const history = ref<string[]>([])
const historyIndex = ref(-1)
const inspectItems = ref<DirectoryItem[]>([])
const searchItems = ref<FileSearchItem[]>([])
const selected = ref<DirectoryItem | null>(null)
const explanation = ref<FileExplanation | null>(null)
const inspectError = ref('')
const searchError = ref('')
const loading = ref(false)
const searching = ref(false)
const ntfsEnabling = ref(false)
const fileActionNotice = ref('')
const fileActionBusy = ref(false)
let fileActionNoticeTimer: ReturnType<typeof setTimeout> | null = null
const directoryTruncated = ref(false)
const directoryLoadingMore = ref(false)
const directorySessionId = ref('')
let directoryNextOffset: number | null = null
const estimatingCount = ref(0)
const estimatingPaths = ref(new Set<string>())
const aiConfigured = ref(false)
const aiBusy = ref(false)
const refreshingExplanation = ref(false)
const aiError = ref('')
const showAiSettings = ref(false)
const fileScroller = ref<HTMLElement | null>(null)
const explainPanel = ref<HTMLElement | null>(null)
const searchInputElement = ref<HTMLInputElement | null>(null)
const nativePresentations = ref<Record<string, NativeFilePresentation>>({})
const scrollTop = ref(0)
const viewportHeight = ref(600)
const aiSession = appAiAnalysisSession

const searchQuery = ref('')
const searchComposing = ref(false)
const searchAnalysisOpen = ref(false)
const searchScope = ref<'all' | 'directory'>('all')
const searchTarget = computed(() => searchItems.value.find(item => item.path === selected.value?.path) || searchItems.value[0] || null)
const searchKind = ref<FileSearchKind>('all')
const searchModified = ref<FileSearchModified>('any')
const searchSort = ref<FileSearchSort>('relevance')
const searchIndex = ref<FileSearchIndexStatus | null>(null)
const searchResultMeta = ref<Pick<FileSearchResult, 'tookMs' | 'truncated' | 'sessionId' | 'total' | 'nextOffset' | 'diagnostics'> | null>(null)
// The candidate session survives a sort change while the displayed page does not.
let searchCandidateSession: { id: string; key: string } | null = null

let navigationRequestId = 0
let selectionRequestId = 0
let searchRequestId = 0
let rowClickTimer: ReturnType<typeof setTimeout> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let lastObservedChangedAt = ''
let backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null
let nativeIconTimer: ReturnType<typeof setTimeout> | null = null
let visibleMetadataTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let unsubscribeIndex: (() => void) | null = null
let workspaceActive = false
let initialized = false
const pendingNativeIcons = new Set<string>()
const hydratingPaths = new Set<string>()
const maximumNativePresentations = 600
const localExplanationCache = new Map<string, FileExplanation>()
const maximumLocalExplanations = 240

const kindFilters: Array<{ value: FileSearchKind; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'folder', label: '文件夹' },
  { value: 'file', label: '文件' },
  { value: 'application', label: '应用' },
  { value: 'document', label: '文档' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'archive', label: '压缩包' },
  { value: 'installer', label: '安装包' },
  { value: 'code', label: '代码' }
]

const activeItems = computed(() => mode.value === 'search' ? searchItems.value : browseItems(inspectItems.value, browseFilter.value, browseSort.value))
const showListLoading = computed(() => mode.value === 'search'
  ? searching.value && searchItems.value.length === 0
  : loading.value)
const activeError = computed(() => mode.value === 'search' ? searchError.value : inspectError.value)
const activeRowHeight = computed(() => mode.value === 'search' ? 62 : 56)

const crumbs = computed(() => {
  const normalized = browsePath.value.replaceAll('/', '\\')
  const parts = normalized.split('\\').filter(Boolean)
  return parts.map((part, index) => ({
    name: part,
    path: index === 0 ? `${part}\\` : `${parts.slice(0, index + 1).join('\\')}\\`
  }))
})
const visibleCrumbs = computed(() => crumbs.value.length > 4 ? [crumbs.value[0], ...crumbs.value.slice(-3)] : crumbs.value)

const visibleRows = computed(() => {
  const overscan = 8
  const start = Math.max(0, Math.floor(scrollTop.value / activeRowHeight.value) - overscan)
  const count = Math.ceil(viewportHeight.value / activeRowHeight.value) + overscan * 2
  return activeItems.value.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }))
})

const objectDetails = computed(() => {
  if (!explanation.value) return []
  const item = explanation.value
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

const emptyTitle = computed(() => {
  if (mode.value === 'browse') return browseFilter.value ? '没有匹配的名称' : '这个位置没有可显示的内容'
  if (!searchQuery.value.trim()) return '搜索本机文件'
  if (searchIndex.value?.building) return '这个名称还未收录，结果会自动更新'
  if (!searchIndex.value?.indexed) return '正在收录文件'
  return '没有找到匹配内容'
})

const emptyDescription = computed(() => {
  if (mode.value === 'browse') return browseFilter.value ? '缩短关键词或清空当前目录筛选。' : '也可能是当前权限无法读取。'
  if (!searchQuery.value.trim()) return '输入名称、路径或拼音，搜索这台电脑中的文件与文件夹。'
  if (!searchIndex.value?.indexed) return '结果会随着索引建立逐步出现，索引不会读取文件正文。'
  return '尝试缩短关键词、使用通配符，或清除类型和时间筛选条件。'
})

async function loadAiStatus() {
  const api = desktopApi()
  if (!api) return
  try { aiConfigured.value = Boolean((await api.aiStatus()).configured) } catch { aiConfigured.value = false }
}

async function applySearchExample(query: string) {
  searchQuery.value = query
  await performSearch({ resetPosition: true })
  searchInputElement.value?.focus()
}

async function loadIndexStatus() {
  const api = desktopApi()
  if (!api) return
  try {
    searchIndex.value = await api.inspectIndexStatus()
    lastObservedChangedAt = searchIndex.value.lastChangedAt || ''
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error)
  }
}

async function enableNtfsSearch(disable = false) {
  const api = desktopApi()
  if (!api || ntfsEnabling.value) return
  ntfsEnabling.value = true
  searchError.value = ''
  try {
    const result = await (disable ? api.inspectNtfsDisable() : api.inspectNtfsEnable())
    searchIndex.value = result.status
    if (searchQuery.value.trim()) void performSearch({ background: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/cancel|取消/iu.test(message)) searchError.value = message
  } finally { ntfsEnabling.value = false }
}

async function loadDirectory(dir?: string, addHistory = true, targetHistoryIndex?: number) {
  const api = desktopApi()
  if (!api) {
    inspectError.value = '请使用 Electron 桌面开发模式打开项目'
    return
  }
  const currentRequest = ++navigationRequestId
  closeDirectorySession()
  invalidateSelection()
  loading.value = true
  inspectError.value = ''
  estimatingCount.value = 0
  estimatingPaths.value = new Set()
  try {
    const result = await api.inspectList(dir || 'C:\\')
    if (currentRequest !== navigationRequestId) {
      if (result.sessionId) void api.inspectListClose?.({ sessionId: result.sessionId }).catch(() => {})
      return
    }
    browsePath.value = result.path
    pathInput.value = result.path
    browseFilter.value = ''
    inspectItems.value = result.items
    directoryTruncated.value = result.truncated
    directorySessionId.value = result.nextOffset != null ? result.sessionId || '' : ''
    directoryNextOffset = result.nextOffset ?? null
    if (mode.value === 'browse') {
      selected.value = null
      explanation.value = null
      resetListScroll()
    }
    if (addHistory) {
      const nextHistory = history.value.slice(0, historyIndex.value + 1)
      if (nextHistory.at(-1)?.toLowerCase() !== result.path.toLowerCase()) nextHistory.push(result.path)
      history.value = nextHistory
      historyIndex.value = nextHistory.length - 1
    }
    if (targetHistoryIndex !== undefined) historyIndex.value = targetHistoryIndex
    loading.value = false
    await nextTick()
    attachScrollerObserver()
    await refreshVisibleBrowseRows(currentRequest)
    if (directoryNextOffset !== null) void continueDirectoryListing(currentRequest)
  } catch (error) {
    if (currentRequest !== navigationRequestId) return
    inspectError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (currentRequest === navigationRequestId) loading.value = false
  }
}

function closeDirectorySession() {
  const id = directorySessionId.value
  directorySessionId.value = ''
  directoryNextOffset = null
  directoryLoadingMore.value = false
  if (id) void desktopApi()?.inspectListClose?.({ sessionId: id }).catch(() => {})
}

async function continueDirectoryListing(currentRequest = navigationRequestId) {
  const api = desktopApi()
  const sessionId = directorySessionId.value
  if (!api?.inspectListPage || !sessionId || directoryLoadingMore.value) return
  directoryLoadingMore.value = true
  const automaticLimit = inspectItems.value.length + 100000
  try {
    while (workspaceActive && mode.value === 'browse' && currentRequest === navigationRequestId && sessionId === directorySessionId.value && directoryNextOffset !== null && inspectItems.value.length < automaticLimit) {
      const page = await api.inspectListPage({ sessionId, offset: directoryNextOffset })
      if (currentRequest !== navigationRequestId || sessionId !== directorySessionId.value) return
      inspectItems.value = inspectItems.value.concat(page.items)
      directoryNextOffset = page.nextOffset ?? null
      directoryTruncated.value = page.truncated
      if (directoryNextOffset === null) directorySessionId.value = ''
      await nextTick()
    }
  } catch (error) {
    if (currentRequest === navigationRequestId) {
      inspectError.value = error instanceof Error ? error.message : String(error)
      closeDirectorySession()
    }
  } finally { if (currentRequest === navigationRequestId) directoryLoadingMore.value = false }
}

async function estimateVisibleDirectories(currentRequest: number) {
  if (mode.value !== 'browse') return
  const api = desktopApi()
  if (!api) return
  const queue = visibleRows.value
    .map(row => row.item)
    .filter(item => item.isDirectory && !item.metadataPending && item.size === null && !estimatingPaths.value.has(item.path))
    .slice(0, 16)
  if (!queue.length) return
  const nextEstimating = new Set(estimatingPaths.value)
  queue.forEach(item => nextEstimating.add(item.path))
  estimatingPaths.value = nextEstimating
  estimatingCount.value = nextEstimating.size

  const worker = async () => {
    while (queue.length && currentRequest === navigationRequestId) {
      const item = queue.shift()
      if (!item) return
      try {
        const estimate = await api.inspectEstimate(item.path)
        if (currentRequest !== navigationRequestId) return
        const index = inspectItems.value.findIndex(candidate => candidate.path === item.path)
        if (index >= 0) {
          inspectItems.value[index] = {
            ...inspectItems.value[index],
            size: estimate.bytes,
            fileCount: estimate.fileCount,
            sizeEstimated: !estimate.complete
          }
        }
      } catch {
        // Protected directories remain unknown and do not block the visible list.
      } finally {
        const remaining = new Set(estimatingPaths.value)
        remaining.delete(item.path)
        estimatingPaths.value = remaining
        estimatingCount.value = remaining.size
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker))
}

async function hydrateVisibleItems(currentRequest: number) {
  if (mode.value !== 'browse') return
  const api = desktopApi()
  if (!api?.inspectHydrate) return
  const queue = visibleRows.value
    .map(row => row.item)
    .filter(item => item.metadataPending && !hydratingPaths.has(item.path.toLowerCase()))
    .slice(0, 64)
  if (!queue.length) return
  queue.forEach(item => hydratingPaths.add(item.path.toLowerCase()))
  try {
    const hydrated = await api.inspectHydrate(queue.map(item => item.path))
    if (currentRequest !== navigationRequestId || mode.value !== 'browse') return
    const byPath = new Map(hydrated.map(item => [item.path.toLowerCase(), item]))
    const nextItems = [...inspectItems.value]
    for (const requested of queue) {
      const index = nextItems.findIndex(item => item.path.toLowerCase() === requested.path.toLowerCase())
      if (index < 0) continue
      const existing = nextItems[index]
      const metadata = byPath.get(requested.path.toLowerCase())
      if (!metadata) {
        nextItems[index] = { ...existing, metadataPending: false }
        continue
      }
      const updated = { ...existing, ...metadata }
      if (existing.isDirectory && existing.size !== null) {
        updated.size = existing.size
        updated.fileCount = existing.fileCount
        updated.sizeEstimated = existing.sizeEstimated
      }
      nextItems[index] = updated
      if (selected.value?.path.toLowerCase() === updated.path.toLowerCase()) selected.value = updated
    }
    inspectItems.value = nextItems
  } catch {
    // Metadata is an optional enhancement; names and paths remain usable.
  } finally {
    queue.forEach(item => hydratingPaths.delete(item.path.toLowerCase()))
  }
}

async function refreshVisibleBrowseRows(currentRequest: number) {
  if (!workspaceActive) return
  await hydrateVisibleItems(currentRequest)
  if (workspaceActive && currentRequest === navigationRequestId) await estimateVisibleDirectories(currentRequest)
}

function scheduleVisibleBrowseRefresh() {
  if (!workspaceActive) return
  if (visibleMetadataTimer) clearTimeout(visibleMetadataTimer)
  visibleMetadataTimer = setTimeout(() => {
    visibleMetadataTimer = null
    void refreshVisibleBrowseRows(navigationRequestId)
  }, 35)
}

function setMode(next: ExplorerMode) {
  if (mode.value === next) return
  if (next === 'search') { navigationRequestId += 1; closeDirectorySession(); loading.value = false }
  invalidateSelection()
  searchRequestId += 1
  searching.value = false
  mode.value = next
  selected.value = null
  explanation.value = null
  searchAnalysisOpen.value = false
  inspectError.value = ''
  searchError.value = ''
  resetListScroll()
  nextTick(() => {
    attachScrollerObserver()
    if (next === 'browse') {
      if (directoryTruncated.value || !browsePath.value) void loadDirectory(browsePath.value || 'C:\\', false)
      else scheduleVisibleBrowseRefresh()
    }
    if (next === 'search') {
      searchInputElement.value?.focus()
      void loadIndexStatus()
      if (searchQuery.value.trim()) void performSearch()
    }
  })
}

function scheduleSearch() {
  if (searchComposing.value) return
  invalidateSelection()
  if (searchTimer) clearTimeout(searchTimer)
  searchRequestId += 1
  searchCandidateSession = null
  searching.value = Boolean(searchQuery.value.trim())
  selected.value = null
  explanation.value = null
  searchAnalysisOpen.value = false
  searchTimer = setTimeout(() => void performSearch({ resetPosition: true }), 65)
}

interface SearchRequestOptions {
  resetPosition?: boolean
  background?: boolean
  append?: boolean
  reuseSession?: boolean
}

function sameSearchItems(current: FileSearchItem[], incoming: FileSearchItem[]) {
  if (current.length !== incoming.length) return false
  return current.every((item, index) => {
    const next = incoming[index]
    return item.path === next?.path
      && item.modifiedAt === next.modifiedAt
      && item.size === next.size
      && item.relevanceReason === next.relevanceReason
      && item.displayName === next.displayName
      && JSON.stringify(item.matchPositions) === JSON.stringify(next.matchPositions)
  })
}

async function performSearch(options: SearchRequestOptions = {}) {
  if (options.background && (searching.value || searchComposing.value || scrollTop.value > 0)) return
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  const query = searchQuery.value
  const currentRequest = ++searchRequestId
  const candidateKey = JSON.stringify([query, searchScope.value, browsePath.value || 'C:\\', searchKind.value, searchModified.value])
  const reusable = searchCandidateSession?.key === candidateKey ? searchCandidateSession : null
  const append = Boolean(options.append && reusable && searchResultMeta.value?.sessionId === reusable.id)
  const sessionId = (append || options.reuseSession) ? reusable?.id : undefined
  const offset = append ? searchResultMeta.value?.nextOffset ?? 0 : 0
  if (!sessionId) searchCandidateSession = null
  if (options.reuseSession) {
    invalidateSelection()
    searchItems.value = []
    searchResultMeta.value = null
    selected.value = null
    explanation.value = null
    searchAnalysisOpen.value = false
    resetListScroll()
  }
  if (!options.background) searchError.value = ''
  if (!query.trim()) {
    searchItems.value = []
    searchResultMeta.value = null
    searching.value = false
    return
  }
  const api = desktopApi()
  if (!api) {
    searchError.value = '请使用 Electron 桌面开发模式执行文件搜索'
    return
  }
  searching.value = true
  const requestStarted = performance.now()
  try {
    const result = await api.inspectSearch({
      query,
      scope: searchScope.value,
      root: browsePath.value || 'C:\\',
      kind: searchKind.value,
      modified: searchModified.value,
      sort: searchSort.value,
      limit: 100,
      ...(sessionId ? { sessionId, offset } : {})
    })
    if (currentRequest !== searchRequestId) return
    const receivedAt = performance.now()
    if (append) {
      const known = new Set(searchItems.value.map(item => item.path))
      searchItems.value = [...searchItems.value, ...result.items.filter(item => !known.has(item.path))]
    } else if (!sameSearchItems(searchItems.value, result.items)) {
      searchItems.value = result.items
    }
    searchIndex.value = result.index
    searchResultMeta.value = { tookMs: result.tookMs, truncated: result.truncated, sessionId: result.sessionId, total: result.total, nextOffset: result.nextOffset,
      diagnostics: { ...result.diagnostics, renderer: { requestMs: receivedAt - requestStarted, publishMs: performance.now() - receivedAt } } }
    searchCandidateSession = result.sessionId ? { id: result.sessionId, key: candidateKey } : null
    if (options.resetPosition) resetListScroll()
    await nextTick()
    requestAnimationFrame(() => {
      if (currentRequest === searchRequestId && searchResultMeta.value?.diagnostics?.renderer) searchResultMeta.value.diagnostics.renderer.frameMs = performance.now() - requestStarted
    })
    scheduleNativeIconLoad()
    if (selected.value && !searchItems.value.some(item => item.path === selected.value?.path)) {
      selected.value = null
      explanation.value = null
    }
  } catch (error) {
    if (currentRequest === searchRequestId) {
      searchError.value = error instanceof Error ? error.message : String(error)
      searchItems.value = []
      searchResultMeta.value = null
      searchCandidateSession = null
    }
  } finally {
    if (currentRequest === searchRequestId) searching.value = false
  }
}

function clearSearch() {
  invalidateSelection()
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = null
  searchRequestId += 1
  searchQuery.value = ''
  searchItems.value = []
  searchError.value = ''
  searchResultMeta.value = null
  searchCandidateSession = null
  searching.value = false
  selected.value = null
  explanation.value = null
  searchAnalysisOpen.value = false
  resetListScroll()
}

function moveSearchSelection(direction: 1 | -1) {
  if (searchComposing.value || searching.value || !activeItems.value.length) return
  const currentIndex = selected.value
    ? activeItems.value.findIndex(item => item.path === selected.value?.path)
    : -1
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : activeItems.value.length - 1)
    : Math.max(0, Math.min(activeItems.value.length - 1, currentIndex + direction))
  const item = activeItems.value[nextIndex]
  if (!item) return
  if (mode.value === 'search' && !searchAnalysisOpen.value) selected.value = item
  else void selectItem(item)

  const scroller = fileScroller.value
  if (!scroller) return
  const rowTop = nextIndex * activeRowHeight.value
  const rowBottom = rowTop + activeRowHeight.value
  if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop
  else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = rowBottom - scroller.clientHeight
  }
}

async function handleSearchEnter(event: KeyboardEvent) {
  if (event.isComposing || searchComposing.value) return
  const intent = [searchQuery.value, searchKind.value, searchScope.value, searchModified.value, searchSort.value].join('|')
  if (searching.value || searchTimer) await performSearch({ resetPosition: true })
  if (mode.value !== 'search' || searching.value || intent !== [searchQuery.value, searchKind.value, searchScope.value, searchModified.value, searchSort.value].join('|')) return
  const target = searchTarget.value
  if (!target) return
  const action = searchEnterAction(event)
  if (action === 'analyze') await analyzeSearchTarget()
  else await runFileAction(target, action)
}

function handleSearchInputKeydown(event: KeyboardEvent) {
  if (event.isComposing || searchComposing.value) return
  if (event.key === 'Enter') { event.preventDefault(); void handleSearchEnter(event) }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSearchSelection(event.key === 'ArrowDown' ? 1 : -1) }
  else if (event.key === 'Escape') { event.preventDefault(); clearSearch() }
}

function scheduleBackgroundSearchRefresh() {
  if (!workspaceActive) return
  if (backgroundRefreshTimer) return
  backgroundRefreshTimer = setTimeout(() => {
    backgroundRefreshTimer = null
    if (workspaceActive && mode.value === 'search' && searchQuery.value.trim()) {
      void performSearch({ background: true })
    }
  }, 750)
}

function fingerprint(item: DirectoryItem, result: FileExplanation) {
  return result.evidenceFingerprint || `${result.modifiedAt || item.modifiedAt || 0}:${result.size ?? item.size ?? 0}`
}

function localExplanationKey(item: DirectoryItem) {
  return `${item.path.toLocaleLowerCase()}|${item.modifiedAt || 0}|${item.size ?? ''}|${item.fileCount ?? ''}`
}

function rememberLocalExplanation(key: string, result: FileExplanation) {
  localExplanationCache.delete(key)
  localExplanationCache.set(key, result)
  while (localExplanationCache.size > maximumLocalExplanations) {
    localExplanationCache.delete(localExplanationCache.keys().next().value as string)
  }
}

function presentExplanation(item: DirectoryItem, result: FileExplanation) {
  const base: FileExplanation = {
    ...result,
    size: item.size ?? result.size,
    fileCount: item.fileCount ?? result.fileCount,
    isDirectory: item.isDirectory,
    kind: result.source || '本地功能分析',
    title: mode.value === 'search' ? displayItemName(item) : item.name,
    description: result.reason || '暂时没有足够证据解释其用途。',
    action: ['safe', 'low'].includes(result.risk)
      ? '确认内容后可以处理。'
      : '建议保留，并在获得更多证据后再决定。'
  }
  const cached = aiSession.get(item.path, fingerprint(item, result))
  return cached ? applyAiRecord(base, cached) : base
}

function storedSessionRecord(record: StoredAiAnalysis): AiSessionRecord {
  return {
    parsed: record.parsed as AiSessionRecord['parsed'],
    raw: record.raw,
    model: record.model,
    analysisMode: record.analysisMode,
    thinkingLevel: record.thinkingLevel,
    tokenBudget: record.tokenBudget,
    usage: record.usage,
    analyzedAt: record.analyzedAt,
    fingerprint: record.fingerprint,
    analysisVersion: record.analysisVersion,
    promptVersion: record.promptVersion,
    evidenceVersion: record.evidenceVersion,
    evidenceDigest: record.evidenceDigest,
    provider: record.provider
  }
}

async function showExplanation(item: DirectoryItem, result: FileExplanation, currentRequest: number) {
  const api = desktopApi()
  if (!api || currentRequest !== selectionRequestId) return
  const presented = presentExplanation(item, result)
  explanation.value = presented
  if (presented.aiAnalyzed) return
  try {
    const currentFingerprint = fingerprint(item, result)
    const stored = await api.aiAnalysisGet({ path: item.path, fingerprint: currentFingerprint })
    if (currentRequest !== selectionRequestId || selected.value?.path !== item.path) return
    if (stored.status === 'current' && stored.record) {
      const record = aiSession.remember(item.path, storedSessionRecord(stored.record))
      explanation.value = { ...applyAiRecord(presented, record), aiPersisted: true }
    }
  } catch {
    // Persistent analysis is an optimization; local inspection must remain available.
  }
}

function invalidateSelection() {
  selectionRequestId += 1
  refreshingExplanation.value = false
}

async function selectItem(item: DirectoryItem) {
  const api = desktopApi()
  if (!api) return
  const currentRequest = ++selectionRequestId
  refreshingExplanation.value = true
  selected.value = item
  aiError.value = ''
  const cacheKey = localExplanationKey(item)
  const cachedLocal = localExplanationCache.get(cacheKey)
  if (cachedLocal) {
    localExplanationCache.delete(cacheKey)
    localExplanationCache.set(cacheKey, cachedLocal)
    // Display an immediate local preview, but always revalidate the surrounding evidence.
    explanation.value = { ...cachedLocal, title: item.name }
  } else {
    explanation.value = null
  }
  try {
    const result = await api.inspectExplain(item.path)
    if (currentRequest !== selectionRequestId) return
    rememberLocalExplanation(cacheKey, result)
    await showExplanation(item, result, currentRequest)
  } catch (error) {
    if (currentRequest === selectionRequestId) {
      explanation.value = null
      const target = mode.value === 'search' ? searchError : inspectError
      target.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (currentRequest === selectionRequestId) refreshingExplanation.value = false
  }
}

function handleRowClick(item: DirectoryItem) {
  if (mode.value === 'search') {
    if (searchAnalysisOpen.value) void selectItem(item)
    else selected.value = item
    return
  }
  if (rowClickTimer) clearTimeout(rowClickTimer)
  rowClickTimer = setTimeout(() => {
    rowClickTimer = null
    void selectItem(item)
  }, item.isDirectory ? 180 : 0)
}

function handleRowDoubleClick(item: DirectoryItem) {
  if (rowClickTimer) {
    clearTimeout(rowClickTimer)
    rowClickTimer = null
  }
  if (mode.value === 'search') { void runFileAction(item, 'open'); return }
  if (item.isDirectory) {
    mode.value = 'browse'
    void loadDirectory(item.path)
  } else {
    void runFileAction(item, 'open')
  }
}

async function requestAi() {
  if (refreshingExplanation.value || aiBusy.value) return
  if (!aiConfigured.value) {
    showAiSettings.value = true
    return
  }
  const api = desktopApi()
  if (!api || !explanation.value || !selected.value) return
  const targetPath = selected.value.path
  const currentFingerprint = fingerprint(selected.value, explanation.value)
  const targetSelection = selectionRequestId
  aiBusy.value = true
  aiError.value = ''
  try {
    const result = await api.aiReview({ evidence: createAiEvidence(explanation.value) })
    if (!result.ok) {
      aiError.value = result.reason || 'AI 服务没有返回有效结果'
      return
    }
    const refreshed = await api.inspectExplain(targetPath)
    if (refreshed.evidenceFingerprint && refreshed.evidenceFingerprint !== currentFingerprint) {
      if (selected.value?.path === targetPath && targetSelection === selectionRequestId) {
        await showExplanation(selected.value, refreshed, targetSelection)
        aiError.value = '分析期间本地证据发生变化，结果未套用。请基于更新后的证据重新分析。'
      }
      return
    }
    const record = aiSession.save(targetPath, currentFingerprint, result)
    if (selected.value?.path === targetPath && targetSelection === selectionRequestId && explanation.value && fingerprint(selected.value, explanation.value) === currentFingerprint) {
      explanation.value = applyAiRecord(explanation.value, record)
      await nextTick()
      explainPanel.value?.scrollTo({ top: 0, behavior: 'smooth' })
    }
    try {
      await api.aiAnalysisSave({ ...result, path: targetPath, fingerprint: currentFingerprint })
      if (selected.value?.path === targetPath && targetSelection === selectionRequestId && explanation.value?.aiAnalyzed && fingerprint(selected.value, explanation.value) === currentFingerprint) {
        explanation.value = { ...explanation.value, aiPersisted: true }
      }
    } catch (error) {
      aiError.value = `分析已经完成，但本地保存失败：${error instanceof Error ? error.message : String(error)}`
    }
  } catch (error) {
    aiError.value = error instanceof Error ? error.message : String(error)
  } finally {
    aiBusy.value = false
  }
}

async function cancelAi() {
  const api = desktopApi()
  if (!api || !aiBusy.value) return
  await api.aiCancel()
}

function goBack() {
  if (historyIndex.value <= 0) return
  const index = historyIndex.value - 1
  void loadDirectory(history.value[index], false, index)
}

function goForward() {
  if (historyIndex.value >= history.value.length - 1) return
  const index = historyIndex.value + 1
  void loadDirectory(history.value[index], false, index)
}

function pathName(value: string) { return value.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || value }
function toggleFavorite() {
  if (!browsePath.value) return
  favoritePaths.value = isFavorite.value ? favoritePaths.value.filter(location => location.toLowerCase() !== browsePath.value.toLowerCase()) : [browsePath.value, ...favoritePaths.value].slice(0, 12)
  try { localStorage.setItem('disk-sense.favorite-paths', JSON.stringify(favoritePaths.value)) } catch { /* Navigation remains usable without persistence. */ }
}

async function runFileAction(item: DirectoryItem, action: 'open' | 'reveal' | 'copy') {
  const api = desktopApi()
  if (!api || fileActionBusy.value || (mode.value === 'search' && searching.value)) return
  fileActionBusy.value = true
  if (fileActionNoticeTimer) clearTimeout(fileActionNoticeTimer)
  fileActionNotice.value = ''
  try {
    await api.inspectFileAction({ path: item.path, action, ...(mode.value === 'search' ? { query: searchQuery.value } : {}) })
    fileActionNotice.value = { open: '已请求使用默认程序打开', reveal: '已在资源管理器中定位', copy: '已复制路径' }[action]
    fileActionNoticeTimer = setTimeout(() => { fileActionNotice.value = ''; fileActionNoticeTimer = null }, 2500)
  }
  catch (error) { (mode.value === 'search' ? searchError : inspectError).value = error instanceof Error ? error.message : String(error) }
  finally { fileActionBusy.value = false }
}

async function analyzeSearchTarget() {
  if (!searchTarget.value || searching.value) return
  searchAnalysisOpen.value = true
  await selectItem(searchTarget.value)
}

function handleListKeydown(event: KeyboardEvent) {
  if (event.target !== fileScroller.value && !(event.target instanceof HTMLElement && event.target.closest('.file-row'))) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSearchSelection(event.key === 'ArrowDown' ? 1 : -1) }
  else if (event.key === 'Enter') {
    event.preventDefault()
    if (mode.value === 'search') void handleSearchEnter(event)
    else if (selected.value) handleRowDoubleClick(selected.value)
  }
}

let appliedSearchRequest = 0
function focusSearch() { setMode('search'); void nextTick(() => { searchInputElement.value?.focus(); searchInputElement.value?.select() }) }
function applySearchRequest() {
  if (props.requestedSearch && props.requestedSearch !== appliedSearchRequest) { appliedSearchRequest = props.requestedSearch; focusSearch() }
}
watch(() => props.requestedSearch, () => { if (workspaceActive) applySearchRequest() })
function handleWorkspaceKeydown(event: KeyboardEvent) {
  if (!workspaceActive || showAiSettings.value || event.isComposing) return
  if (event.ctrlKey && event.key.toLowerCase() === 'l' && mode.value === 'browse') { event.preventDefault(); pathInputElement.value?.focus(); pathInputElement.value?.select() }
  else if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); focusSearch() }
  else if (event.altKey && mode.value === 'browse' && ['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    if (event.key === 'ArrowLeft') goBack()
    else if (event.key === 'ArrowRight') goForward()
    else goUp()
  } else if (event.key === 'F5') { event.preventDefault(); if (mode.value === 'browse') void loadDirectory(browsePath.value, false); else void performSearch() }
}

function goUp() {
  const clean = browsePath.value.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(clean)) return
  const index = clean.lastIndexOf('\\')
  if (index < 0) return
  const parent = clean.slice(0, index)
  void loadDirectory(/^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent)
}

function onListScroll(event: Event) {
  const element = event.currentTarget as HTMLElement
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
  if (mode.value === 'browse') scheduleVisibleBrowseRefresh()
  else {
    scheduleNativeIconLoad()
    if (!searching.value && searchResultMeta.value?.nextOffset != null && element.scrollTop + element.clientHeight >= element.scrollHeight - 200) {
      void performSearch({ append: true })
    }
  }
}

function resetListScroll() {
  scrollTop.value = 0
  if (fileScroller.value) fileScroller.value.scrollTop = 0
}

function attachScrollerObserver() {
  resizeObserver?.disconnect()
  if (!fileScroller.value) return
  viewportHeight.value = fileScroller.value.clientHeight
  resizeObserver = new ResizeObserver(entries => {
    viewportHeight.value = entries[0]?.contentRect.height || viewportHeight.value
  })
  resizeObserver.observe(fileScroller.value)
}

function parentPath(value: string) {
  const clean = value.replace(/[\\/]+$/, '')
  const index = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))
  return index > 0 ? clean.slice(0, index) : clean
}

function searchItem(item: DirectoryItem) {
  return item as FileSearchItem
}

function displayItemName(item: DirectoryItem) {
  return nativePresentation(item.path)?.displayName || searchItem(item).displayName || item.name
}

function nativePresentation(filePath: string) {
  return nativePresentations.value[filePath.toLowerCase()]
}

function nativeIcon(filePath: string) {
  return nativePresentation(filePath)?.dataUrl || ''
}

function scheduleNativeIconLoad() {
  if (!workspaceActive) return
  if (nativeIconTimer) clearTimeout(nativeIconTimer)
  nativeIconTimer = setTimeout(() => {
    nativeIconTimer = null
    void loadVisibleNativeIcons()
  }, 45)
}

async function loadVisibleNativeIcons() {
  if (!workspaceActive || mode.value !== 'search') return
  const api = desktopApi()
  if (!api?.inspectFilePresentations) return
  const paths = visibleRows.value
    .map(row => row.item.path)
    .filter(filePath => !nativePresentation(filePath) && !pendingNativeIcons.has(filePath.toLowerCase()))
    .slice(0, 32)
  if (!paths.length) return
  paths.forEach(filePath => pendingNativeIcons.add(filePath.toLowerCase()))
  try {
    const loaded = await api.inspectFilePresentations(paths)
    const next = new Map(Object.entries(nativePresentations.value))
    for (const [filePath, presentation] of Object.entries(loaded)) {
      if (presentation.dataUrl?.startsWith('data:image/') || presentation.displayName) {
        const cacheKey = filePath.toLowerCase()
        next.delete(cacheKey)
        next.set(cacheKey, presentation)
      }
    }
    while (next.size > maximumNativePresentations) next.delete(next.keys().next().value as string)
    nativePresentations.value = Object.fromEntries(next)
  } catch {
    // Native icons improve recognition but never block search results.
  } finally {
    paths.forEach(filePath => pendingNativeIcons.delete(filePath.toLowerCase()))
  }
}

function searchPriority(item: DirectoryItem) {
  return searchItem(item).searchPriority || 'standard'
}

function searchItemKind(item: DirectoryItem) {
  return searchItem(item).searchKind || (item.isDirectory ? 'folder' : 'file')
}

function searchResultReason(item: DirectoryItem) {
  const presentation = nativePresentation(item.path)
  if (searchItemKind(item) === 'application' && presentation?.displayName?.startsWith('Microsoft ')) {
    return 'Microsoft Office 应用'
  }
  return searchItem(item).relevanceReason || (item.isDirectory ? '文件夹匹配' : '文件名匹配')
}

function searchIconName(item: DirectoryItem) {
  const kind = searchItemKind(item)
  return ['folder', 'application', 'document', 'image', 'video', 'audio', 'archive', 'installer', 'code'].includes(kind)
    ? kind
    : 'file'
}

function searchNameSegments(name: string, item?: DirectoryItem) {
  const result = item as FileSearchItem | undefined
  return highlightSearchName(name, searchQuery.value, result?.matchTitle === name ? result.matchPositions : undefined)
}

function formatModified(value: number) {
  if (!value) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value))
}

function formatRelativeModified(value: number) {
  if (!value) return '时间未知'
  const elapsed = Math.max(0, Date.now() - value)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / (7 * 86_400_000))} 周前`
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

function formatRelativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime()
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return `${Math.floor(elapsed / 86_400_000)} 天前`
}

function fileTypeLabel(extension: string) {
  const knownTypes: Record<string, string> = {
    '.lnk': '快捷方式',
    '.url': '网页快捷方式',
    '.exe': '应用程序',
    '.msi': '安装程序',
    '.msix': '应用安装包',
    '.appx': '应用安装包'
  }
  return knownTypes[extension.toLowerCase()]
    || (extension ? `${extension.slice(1).toUpperCase()} 文件` : '文件')
}

onMounted(() => {
  document.addEventListener('keydown', handleWorkspaceKeydown)
  try { favoritePaths.value = readFavoritePaths(localStorage.getItem('disk-sense.favorite-paths')) } catch { /* Optional local preference. */ }
  void desktopApi()?.inspectLocations().then(locations => { quickLocations.value = locations }).catch(() => {})
  initialized = true
  void loadAiStatus()
  void loadIndexStatus()
  if (props.requestedPath) void applyPathRequest()
  else void loadDirectory('C:\\')
  applySearchRequest()
  nextTick(attachScrollerObserver)
})

function subscribeIndexProgress() {
  if (unsubscribeIndex) return
  const api = desktopApi()
  if (!api) return
  unsubscribeIndex = api.onInspectIndexProgress(status => {
    const wasBuilding = searchIndex.value?.building
    const previousEntries = searchIndex.value?.entries || 0
    const previousChangedAt = lastObservedChangedAt || searchIndex.value?.lastChangedAt || ''
    searchIndex.value = status
    lastObservedChangedAt = status.lastChangedAt || ''
    const rebuildCompleted = Boolean(wasBuilding && !status.building)
    const filesChanged = Boolean(status.lastChangedAt && status.lastChangedAt !== previousChangedAt)
    const grew = status.building && status.entries > previousEntries
    if (rebuildCompleted || filesChanged || grew) scheduleBackgroundSearchRefresh()
  })
}

function stopActiveWork() {
  workspaceActive = false
  navigationRequestId += 1
  closeDirectorySession()
  invalidateSelection()
  searchRequestId += 1
  loading.value = false
  searching.value = false
  if (rowClickTimer) clearTimeout(rowClickTimer)
  if (searchTimer) clearTimeout(searchTimer)
  if (backgroundRefreshTimer) clearTimeout(backgroundRefreshTimer)
  if (nativeIconTimer) clearTimeout(nativeIconTimer)
  if (visibleMetadataTimer) clearTimeout(visibleMetadataTimer)
  if (fileActionNoticeTimer) clearTimeout(fileActionNoticeTimer)
  fileActionNoticeTimer = null
  fileActionNotice.value = ''
  rowClickTimer = null
  searchTimer = null
  backgroundRefreshTimer = null
  nativeIconTimer = null
  visibleMetadataTimer = null
  unsubscribeIndex?.()
  unsubscribeIndex = null
  resizeObserver?.disconnect()
  resizeObserver = null
  pendingNativeIcons.clear()
  hydratingPaths.clear()
  estimatingPaths.value = new Set()
  estimatingCount.value = 0
}

onActivated(() => {
  workspaceActive = true
  void applyPathRequest()
  applySearchRequest()
  subscribeIndexProgress()
  if (!initialized) return
  void loadAiStatus()
  void loadIndexStatus()
  if (selected.value && !explanation.value) void selectItem(selected.value)
  nextTick(() => {
    attachScrollerObserver()
    if (!browsePath.value && !loading.value) void loadDirectory('C:\\')
    else if (mode.value === 'browse') {
      if (directoryTruncated.value && !directorySessionId.value) void loadDirectory(browsePath.value, false)
      else scheduleVisibleBrowseRefresh()
    }
    else {
      scheduleNativeIconLoad()
      if (searchQuery.value.trim()) scheduleBackgroundSearchRefresh()
    }
  })
})

onDeactivated(stopActiveWork)
onBeforeUnmount(() => { stopActiveWork(); document.removeEventListener('keydown', handleWorkspaceKeydown) })
</script>

<style src="./explorer.css"></style>

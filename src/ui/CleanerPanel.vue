<template>
  <section class="page cleanup-page">
    <header class="page-header cleaner-page-header">
      <div>
        <div class="eyebrow"><span></span> 空间处理</div>
        <h1>清理中心</h1>
        <p>查看可处理空间，核对文件，再执行清理。</p>
      </div>
      <div class="cleaner-safety-state">
        <span><AppIcon name="shield" /></span>
        <div><b>可恢复处理</b><small>普通文件移入回收站</small></div>
      </div>
    </header>

    <nav class="cleanup-tabs cleaner-view-tabs" role="tablist" aria-label="清理中心" @keydown="handleRovingKeydown">
        <button role="tab" :tabindex="activeTab === 'junk' ? 0 : -1" :aria-selected="activeTab === 'junk'" :class="{ active: activeTab === 'junk' }" @click="activeTab = 'junk'">
          <AppIcon name="clean" /><span><b>垃圾清理</b><small>缓存、临时文件和日志</small></span>
        </button>
        <button role="tab" :tabindex="activeTab === 'slimming' ? 0 : -1" :aria-selected="activeTab === 'slimming'" :class="{ active: activeTab === 'slimming' }" @click="openSlimming">
          <AppIcon name="database" /><span><b>系统瘦身</b><small>Windows 官方维护能力</small></span>
        </button>
        <button role="tab" :tabindex="activeTab === 'history' ? 0 : -1" :aria-selected="activeTab === 'history'" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
          <AppIcon name="history" /><span><b>操作记录</b><small>结果、失败与释放空间</small></span>
        </button>
    </nav>

    <template v-if="activeTab === 'junk'">
      <section class="cleaner-workspace">
        <header class="cleaner-commandbar">
          <div class="cleaner-command-title">
            <span><AppIcon name="clean" /></span>
            <div><b>{{ scannedCount ? '扫描结果' : '查找可清理空间' }}</b><small>{{ scannedCount ? '展开分类核对文件，再选择要处理的内容。' : `${rules.length} 条本地规则 · 缓存、临时文件与诊断日志` }}</small></div>
          </div>

          <div v-if="scannedCount" class="cleaner-command-total">
            <strong>{{ formatBytes(foundBytes) }}</strong>
            <small>按规则汇总占用</small>
          </div>

          <div class="cleaner-command-actions">
            <button class="compact-tool-button" :disabled="busy" @click="showExclusions = true">
              <AppIcon name="shield" />排除项<small v-if="exclusions.length">{{ exclusions.length }}</small>
            </button>
            <button class="secondary-button" :disabled="cleanupBusy" @click="scanBusy ? cancelScans() : scanAll()">
              <AppIcon :name="scanBusy ? 'close' : 'scan'" />{{ scanBusy ? '取消扫描' : scannedCount ? '重新扫描' : '开始扫描' }}
            </button>
            <button class="primary-button" :disabled="scanBusy || (!cleanupBusy && !selected.length)" @click="cleanupBusy ? cancelCleanup() : execute()">
              <AppIcon :name="cleanupBusy ? 'close' : 'clean'" />{{ cleanupBusy ? '停止清理' : `清理 ${selected.length || ''}`.trim() }}
            </button>
          </div>
        </header>

        <div v-if="!scannedCount && !busy" class="cleaner-start-guide">
          <div><span>01</span><b>扫描已知位置</b><p>按明确规则检查占用，先生成预览。</p></div>
          <div><span>02</span><b>核对并选择</b><p>查看用途、安全依据和具体文件。</p></div>
          <div><span>03</span><b>移入回收站</b><p>普通文件可恢复，清空后释放空间。</p></div>
        </div>

        <div v-if="scannedCount || busy" class="cleaner-stats">
          <article><span>已知项目</span><b>{{ foundItems.toLocaleString() }}</b><small>按规则汇总，可能交叠</small></article>
          <article><span>已知占用</span><b>{{ formatBytes(foundBytes) }}</b><small>含只读统计，非释放估算</small></article>
          <article><span>当前可处理</span><b>{{ formatBytes(actionableBytes) }}</b><small>{{ actionableItems.toLocaleString() }} 个文件通过安全条件</small></article>
          <article class="selected-metric"><span>已选择</span><b>{{ formatBytes(selectedBytes) }}</b><small>{{ selected.length.toLocaleString() }} 个文件</small></article>
          <article class="scan-time-stat">
            <span>扫描状态</span>
            <b>{{ scanBusy ? `${scanProgress}%` : incompleteScans ? '结果不完整' : scannedCount ? '扫描结束' : '尚未扫描' }}</b>
            <small>
              {{ scannedCount }} / {{ rules.length }} 条规则
              <template v-if="lastScanDurationMs"> · {{ formatDuration(lastScanDurationMs) }}</template>
            </small>
          </article>
        </div>

        <div v-if="cleanupBusy" class="cleanup-operation">
          <div>
            <b>正在移入回收站</b>
            <span>{{ executeProgress.processed }} / {{ executeProgress.total }}</span>
          </div>
          <progress :value="executeProgress.processed" :max="Math.max(1, executeProgress.total)"></progress>
          <small>{{ executeProgress.current || '正在重新校验文件状态…' }}</small>
        </div>
        <div v-else-if="busy && scanStatus.current" class="cleanup-operation scan-operation">
          <div>
            <b>{{ scanStatus.phase === 'discovery' ? '正在查找应用位置' : '正在扫描文件' }} · {{ scanningRuleTitle }}</b>
            <span>已访问 {{ scanStatus.visited.toLocaleString() }} 项 · 发现 {{ scanStatus.found.toLocaleString() }} 个候选</span>
          </div>
          <small>{{ scanStatus.current }}</small>
        </div>

        <p v-if="message" class="inline-message cleaner-message" aria-live="polite">{{ message }}</p>

        <div class="cleaner-list-heading">
          <div><b>{{ scannedCount ? '分类与文件' : '扫描范围' }}</b><span>{{ categoryGroups.length }} 个分类 · 点击展开规则</span></div>
          <details class="risk-guide">
            <summary><AppIcon name="shield" />清理等级</summary>
            <div>
              <span v-for="level in riskLevels" :key="level.value" class="risk-chip" :class="riskClass(level.value)"><i></i>{{ level.label }}</span>
            </div>
            <p>只有“安全”和“低风险”候选可以进入回收站流程；未知和高风险内容不会自动选择。</p>
          </details>
        </div>
        <div class="cleaner-table-heading" aria-hidden="true"><span>分类 / 安全依据</span><span>扫描进度</span><span>发现占用</span></div>
        <div class="cleaner-category-list">
          <section
            v-for="group in categoryGroups"
            :key="group.key"
            class="cleaner-category"
            :class="{ open: isCategoryExpanded(group.key), scanned: group.scanned }"
          >
            <header
              class="cleaner-category-row"
              role="button"
              tabindex="0"
              :aria-expanded="isCategoryExpanded(group.key)"
              @click="toggleCategoryExpanded(group.key)"
              @keydown.enter.prevent="toggleCategoryExpanded(group.key)"
              @keydown.space.prevent="toggleCategoryExpanded(group.key)"
            >
              <span class="category-chevron"><AppIcon name="arrow" /></span>
              <label class="cleanup-check category-check" title="选择该分类中所有可安全处理的文件" @click.stop>
                <input
                  type="checkbox"
                  :disabled="!group.selectableFiles.length"
                  :checked="isCategorySelected(group.key)"
                  :indeterminate="isCategoryPartiallySelected(group.key)"
                  @change="toggleCategory(group.key)"
                />
                <span></span>
              </label>
              <span class="category-main-icon"><AppIcon :name="ruleIcon(group.key)" /></span>
              <div class="category-copy">
                <div>
                  <b>{{ group.title }}</b>
                  <span class="risk-chip" :class="riskClass(group.risk)"><i></i>{{ riskLabel(group.risk) }}</span>
                </div>
                <p>{{ group.description }}</p>
              </div>
              <div class="category-selection">
                <span v-if="group.selectedFiles">{{ group.selectedFiles.toLocaleString() }} 个已选</span>
                <small>
                  {{ group.scanned }} / {{ group.rules.length }} 条规则已扫描
                  <template v-if="group.incomplete"> · {{ group.incomplete }} 条结果不完整</template>
                  <template v-if="group.retainedItems"> · 保留 {{ group.retainedItems.toLocaleString() }} 个近期文件</template>
                </small>
              </div>
              <div class="category-amount">
                <b>{{ group.unavailable ? '未能读取' : group.scanned ? formatBytes(group.bytes) : '尚未扫描' }}</b>
                <small>{{ group.scanned ? `${group.items.toLocaleString()} 个项目` : `${group.rules.length} 条规则` }}</small>
              </div>
            </header>

            <div v-if="isCategoryExpanded(group.key)" class="category-rule-list">
              <article v-for="rule in group.rules" :key="rule.id" class="compact-rule" :class="{ scanned: results[rule.id] }">
                <label class="cleanup-check" :title="rule.selectable ? '选择该规则发现的文件' : '该规则不能直接选择'">
                  <input
                    type="checkbox"
                    :disabled="!(results[rule.id]?.selectable ?? rule.selectable) || !results[rule.id]?.files.length"
                    :checked="isSelected(rule.id)"
                    @change="toggle(rule.id)"
                  />
                  <span></span>
                </label>

                <div class="compact-rule-copy">
                  <div class="cleanup-rule-title">
                    <b>{{ rule.title }}</b>
                    <span class="risk-chip" :class="riskClass(rule.risk)"><i></i>{{ riskLabel(rule.risk) }}</span>
                    <span v-if="rule.requiresAdmin" class="admin-chip">需要管理员</span>
                    <span v-if="results[rule.id]" class="scan-coverage" :class="results[rule.id].coverage?.status" role="status">{{ cleanerCoverageLabel(results[rule.id]) }}</span>
                  </div>
                  <p>{{ rule.reason }}</p>
                  <details class="rule-evidence">
                    <summary>安全依据与文件明细</summary>
                    <p v-if="rule.version">规则版本 {{ rule.version }} · {{ rule.source }}</p>
                    <ToolCachePanel v-if="['npm-cache', 'pip-cache', 'nuget-cache', 'uv-cache', 'pnpm-cache'].includes(rule.id)" :rule-id="rule.id" />
                    <div class="rule-safety">
                      <AppIcon name="shield" />
                      <span>{{ rule.safetyNote }}</span>
                      <small v-if="rule.maximumAgeDays != null">最近 {{ rule.maximumAgeDays }} 天 · 仅观察</small>
                      <small v-else-if="rule.minimumAgeDays">保留最近 {{ rule.minimumAgeDays }} 天</small>
                    </div>
                    <p v-if="results[rule.id]?.blockedReason" class="rule-blocked">{{ results[rule.id].blockedReason }}</p>
                    <p v-if="results[rule.id]?.truncated" class="rule-blocked">{{ scanLimitMessage(results[rule.id]) }}</p>
                    <div v-if="results[rule.id]?.coverage" class="rule-scan-report">
                      <p v-if="!results[rule.id].summaryOnly">
                        {{ results[rule.id].coverage!.roots }} 个规则位置 · 已读取 {{ results[rule.id].coverage!.directoriesRead }} 个目录
                        <template v-if="results[rule.id].coverage!.missingRoots"> · {{ results[rule.id].coverage!.missingRoots }} 个位置不存在</template>
                        <template v-if="results[rule.id].coverage!.excludedRoots"> · {{ results[rule.id].coverage!.excludedRoots }} 个位置已排除</template>
                      </p>
                      <p v-else>已检查 {{ results[rule.id].coverage!.roots }} 个卷的系统汇总。</p>
                      <p v-if="results[rule.id].coverage!.discovery?.directoriesRead || results[rule.id].coverage!.discovery?.missingLocations || results[rule.id].coverage!.discovery?.excludedLocations || results[rule.id].coverage!.discovery?.linksSkipped" class="rule-discovery-report">
                        应用位置发现：读取 {{ results[rule.id].coverage!.discovery!.directoriesRead }} 个目录
                        <template v-if="results[rule.id].coverage!.discovery!.missingLocations"> · {{ results[rule.id].coverage!.discovery!.missingLocations }} 个检查位置不存在</template>
                        <template v-if="results[rule.id].coverage!.discovery!.excludedLocations"> · {{ results[rule.id].coverage!.discovery!.excludedLocations }} 个位置按排除项跳过</template>
                        <template v-if="results[rule.id].coverage!.discovery!.linksSkipped"> · {{ results[rule.id].coverage!.discovery!.linksSkipped }} 个链接目录已跳过</template>
                      </p>
                      <p v-if="results[rule.id].coverage!.errorCount" class="rule-blocked">
                        {{ results[rule.id].coverage!.errorCount }} 处未能完成检查，当前数量不代表完整占用。已通过校验的文件仍可核对。
                      </p>
                      <ul v-if="results[rule.id].coverage!.diagnostics.length">
                        <li v-for="(issue, index) in results[rule.id].coverage!.diagnostics" :key="index">
                          <code :title="issue.code">{{ cleanerIssueLabel(issue.code) }}</code><span :title="issue.path">{{ issue.path }}</span>
                        </li>
                      </ul>
                      <p v-if="results[rule.id].coverage!.omittedDiagnostics">另有 {{ results[rule.id].coverage!.omittedDiagnostics }} 条问题未展开。</p>
                    </div>
                    <p v-if="results[rule.id]?.retained.recentItems" class="rule-retained">
                      已发现但保留最近 {{ rule.minimumAgeDays }} 天内的
                      {{ results[rule.id].retained.recentItems.toLocaleString() }} 个文件（{{ formatBytes(results[rule.id].retained.recentBytes) }}），不会进入清理计划。
                    </p>
                    <div v-if="results[rule.id]?.volumeBreakdown?.length" class="volume-breakdown">
                      <span v-for="volume in results[rule.id].volumeBreakdown" :key="volume.root" :class="{ unavailable: volume.code !== 0 }">
                        <b>{{ volume.root }}</b>
                        <small>{{ volume.code === 0 ? `${volume.items.toLocaleString()} 项 · ${formatBytes(volume.bytes)}` : '当前无法读取' }}</small>
                      </span>
                    </div>
                    <div v-if="results[rule.id]?.files.length" class="rule-files">
                      <header><b>文件路径</b><span>大小</span><span>操作</span></header>
                      <div v-for="file in results[rule.id].files.slice(0, 30)" :key="file.path">
                        <span :title="file.path">{{ file.path }}</span><small>{{ formatBytes(file.size) }}</small>
                        <button :aria-label="`排除 ${file.path}`" @click="excludeFile(file.path)">排除</button>
                      </div>
                      <p v-if="results[rule.id].files.length > 30">还有 {{ results[rule.id].files.length - 30 }} 个文件未展开</p>
                    </div>
                    <p v-else class="rule-detail-empty">{{ results[rule.id] ? '此规则没有可展开的文件候选。' : '扫描后可在这里核对具体文件。' }}</p>
                  </details>
                </div>

                <div class="compact-rule-result">
                  <b>{{ results[rule.id]?.coverage?.status === 'unavailable' ? '未能读取' : results[rule.id] ? formatBytes(results[rule.id].total) : '—' }}</b>
                  <small v-if="results[rule.id]?.coverage?.status === 'unavailable'">展开查看原因</small>
                  <small v-else-if="results[rule.id]">
                    <span>{{ results[rule.id].itemCount.toLocaleString() }} 个{{ results[rule.id].summaryOnly ? '项目' : '发现' }}</span>
                    <span v-if="!results[rule.id].summaryOnly && results[rule.id].selectable">
                      {{ results[rule.id].candidateItemCount.toLocaleString() }} 个可处理
                    </span>
                    <span v-else-if="!results[rule.id].summaryOnly && results[rule.id].configuredSelectable">等待关闭相关应用</span>
                    <span v-else-if="!results[rule.id].summaryOnly">仅检测</span>
                  </small>
                  <small v-else>等待扫描</small>
                </div>

                <button class="text-button compact-scan-button" :disabled="busy" @click="scanRule(rule.id)">
                  {{ scanningIds.has(rule.id) ? '扫描中…' : results[rule.id] ? '重扫' : '扫描' }}
                  <AppIcon name="arrow" />
                </button>
              </article>
            </div>
          </section>
        </div>
        <footer class="cleaner-selection-note">
          <AppIcon name="shield" /><span v-if="selected.length">已选择 {{ selected.length.toLocaleString() }} 个文件 · {{ formatBytes(selectedBytes) }}。执行前会再次校验文件状态。</span><span v-else>扫描只读取文件信息；选择文件并确认后才会执行处理。</span>
        </footer>
      </section>

      <div v-if="showExclusions" class="cleaner-drawer-backdrop" @click.self="showExclusions = false">
        <aside ref="exclusionDialogElement" class="cleaner-drawer" role="dialog" aria-modal="true" aria-labelledby="cleaner-exclusions-title" @keydown="handleDialogKeydown($event, () => showExclusions = false)">
          <header>
            <div><span>保护路径</span><h2 id="cleaner-exclusions-title">清理排除项</h2><p>这些路径不会进入任何清理候选。</p></div>
            <button class="modal-close" aria-label="关闭" @click="showExclusions = false">×</button>
          </header>
          <div class="exclusion-form">
            <label><span>完整路径</span><input v-model="exclusionPath" placeholder="例如 D:\\Projects" @keyup.enter="addExclusion()" /></label>
            <label><span>保护范围</span><select v-model="exclusionMode"><option value="prefix">保护此目录及其内容</option><option value="exact">只保护这个路径</option></select></label>
            <button class="primary-button" :disabled="busy || !exclusionPath.trim()" @click="addExclusion()">添加保护</button>
          </div>
          <div class="exclusion-list-heading"><b>已保护的路径</b><span>{{ exclusions.length }} 项</span></div>
          <div v-if="exclusions.length" class="exclusion-list">
            <div v-for="item in exclusions" :key="item.id">
              <span><b :title="item.path">{{ item.path }}</b><small>{{ item.mode === 'prefix' ? '目录及其内容' : '仅此路径' }} · {{ item.reason }}</small></span>
              <button :disabled="busy" @click="removeExclusion(item.id)">移除</button>
            </div>
          </div>
          <div v-else class="drawer-empty"><AppIcon name="shield" /><b>暂无排除项</b><p>你也可以从具体文件明细中直接添加排除。</p></div>
        </aside>
      </div>
    </template>

    <template v-else>
      <CleanupHistoryPanel v-if="activeTab === 'history'" :refresh-key="historyRefreshKey" />
      <template v-else-if="activeTab === 'slimming'">
        <section class="slimming-workspace">
          <header class="slimming-intro">
            <div class="slimming-visual"><AppIcon name="database" /><span></span></div>
            <div>
              <span>Windows 维护</span>
              <h2>查看 Windows 系统项目</h2>
              <p>只调用 Windows 官方维护能力。普通清理、不可逆维护和系统设置严格分流，不会直接删除 WinSxS 或分页文件。</p>
            </div>
            <div class="slimming-toolbar">
              <span class="admin-state" :class="{ active: slimmingStatus?.elevated }">
                <i></i>{{ slimmingStatus?.elevated ? '管理员模式' : '普通权限' }}
              </span>
              <button class="secondary-button" :disabled="slimmingBusy || maintenanceBusy" @click="loadSlimming">
                <AppIcon name="scan" />{{ slimmingBusy ? '检测中…' : '重新检测' }}
              </button>
            </div>
          </header>

          <div class="maintenance-boundary">
            <span><AppIcon name="shield" /><b>执行边界</b></span>
            <p>命令和参数由程序白名单固定生成；执行前再次检查管理员权限。ResetBase 必须输入专用确认词，运行后保留本地结果。</p>
          </div>

          <div v-if="maintenanceBusy" class="maintenance-operation">
            <div>
              <span class="maintenance-spinner"></span>
              <div><b>Windows 正在处理</b><small>{{ maintenanceProgress.message || '等待系统维护命令返回…' }}</small></div>
              <strong v-if="maintenanceProgress.percent !== null">{{ Math.round(maintenanceProgress.percent) }}%</strong>
            </div>
            <progress v-if="maintenanceProgress.percent !== null" :value="maintenanceProgress.percent" max="100"></progress>
            <p>系统维护开始后不强制终止 DISM，避免组件存储处于不完整状态。</p>
          </div>

          <div v-if="slimmingBusy && !slimming.length" class="slimming-skeleton">
            <div v-for="index in 4" :key="index"></div>
          </div>

          <div v-else class="slimming-list">
            <article v-for="item in slimming" :key="item.id" class="slimming-rule" :data-risk="item.risk">
              <div class="slimming-icon"><AppIcon :name="item.id === 'hibernation' ? 'history' : item.id === 'virtual-memory' ? 'settings' : 'database'" /></div>
              <div class="slimming-copy">
                <div class="cleanup-rule-title">
                  <b>{{ item.title }}</b>
                  <span class="risk-chip" :class="riskClass(item.risk)"><i></i>{{ riskLabel(item.risk) }}</span>
                  <span v-if="item.requiresAdmin" class="admin-chip">需要管理员</span>
                  <span v-if="item.actions.some(action => action.irreversible)" class="irreversible-chip">不可逆</span>
                </div>
                <p>{{ item.description }}</p>
                <div class="slimming-warning"><AppIcon name="shield" />{{ item.impact }}</div>
              </div>
              <div class="slimming-state">
                <span :class="{ detected: item.detected }">{{ item.detected ? '已检测到系统项目' : '未检测到可处理项目' }}</span>
                <b>{{ item.bytes ? formatBytes(item.bytes) : item.status }}</b>
                <small>{{ item.action }}</small>
                <div class="slimming-actions">
                  <button
                    v-for="action in item.actions"
                    :key="action.id"
                    :class="{ danger: action.irreversible, secondary: action.readOnly }"
                    :disabled="maintenanceBusy || !action.enabled"
                    :title="action.disabledReason || action.description"
                    @click="requestMaintenance(item, action)"
                  >
                    {{ action.label }}
                  </button>
                </div>
                <small v-if="item.actions.every(action => !action.enabled)" class="action-disabled-reason">
                  {{ item.actions.find(action => action.disabledReason)?.disabledReason }}
                </small>
              </div>
            </article>
          </div>

          <section v-if="maintenanceHistory.length" class="maintenance-history">
            <header><div><span>LOCAL MAINTENANCE AUDIT</span><b>最近的系统维护</b></div><small>本机保留最近 30 次</small></header>
            <article v-for="job in maintenanceHistory.slice(0, 5)" :key="job.id">
              <span class="maintenance-result-icon" :class="{ success: job.success }"><AppIcon :name="job.success ? 'shield' : 'close'" /></span>
              <div><b>{{ job.title }}</b><small>{{ formatDateTime(job.finishedAt) }} · {{ job.readOnly ? '只读分析' : job.irreversible ? '不可逆维护' : '系统维护' }}</small></div>
              <p>{{ job.message }}</p>
              <strong :class="{ success: job.success }">{{ job.recoveryRequired ? '结果待核对' : job.restartRequired ? '完成，需重启' : job.success ? '成功' : `失败 ${job.exitCode}` }}</strong>
            </article>
          </section>
        </section>
      </template>
    </template>

    <div v-if="cleanupDialog" class="modal cleaner-confirm-modal" @click.self="cleanupDialog = false">
      <section ref="cleanupDialogElement" class="modal-card" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirm-title" @keydown="handleDialogKeydown($event, () => cleanupDialog = false)">
        <div class="modal-title"><div><p class="kicker">核对处理计划</p><h2 id="cleanup-confirm-title">将所选文件移入回收站？</h2></div><button class="modal-close" aria-label="关闭" @click="cleanupDialog = false">×</button></div>
        <div class="cleaner-confirm-summary"><div><span>所选文件</span><b>{{ selected.length.toLocaleString() }} <small>个</small></b></div><div><span>文件占用</span><b>{{ formatBytes(selectedBytes) }}</b></div></div>
        <div class="maintenance-confirm-impact"><b>清空回收站后才会释放空间</b><p>执行前会再次核对文件状态。文件状态变化、被占用或超出安全范围时，将跳过并记录原因。</p></div>
        <div class="modal-actions"><button class="quiet" @click="cleanupDialog = false">返回核对</button><span></span><button class="primary-button" :disabled="!selected.length || busy" @click="performCleanup">确认移入回收站</button></div>
      </section>
    </div>

    <div v-if="maintenanceDialog" class="modal maintenance-modal" @click.self="closeMaintenanceDialog">
      <section ref="maintenanceDialogElement" class="modal-card" role="dialog" aria-modal="true" aria-labelledby="maintenance-confirm-title" @keydown="handleDialogKeydown($event, closeMaintenanceDialog)">
        <div class="modal-title">
          <div><p class="kicker">系统维护确认</p><h2 id="maintenance-confirm-title">{{ maintenanceDialog.action.label }}</h2></div>
          <button class="modal-close" aria-label="关闭" @click="closeMaintenanceDialog">×</button>
        </div>
        <div class="maintenance-confirm-risk" :class="riskClass(maintenanceDialog.action.risk)">
          <AppIcon name="shield" />
          <div>
            <b>{{ maintenanceDialog.item.title }} · {{ riskLabel(maintenanceDialog.action.risk) }}</b>
            <p>{{ maintenanceDialog.action.description }}</p>
          </div>
        </div>
        <div class="maintenance-confirm-impact">
          <b>{{ maintenanceDialog.action.irreversible ? '不可逆影响' : '执行影响' }}</b>
          <p>{{ maintenanceDialog.item.impact }}</p>
        </div>
        <label class="maintenance-confirm-input">
          <span>请输入 <code>{{ maintenanceDialog.action.confirmationPhrase }}</code> 确认</span>
          <input v-model="maintenanceConfirmation" autocomplete="off" spellcheck="false" :placeholder="maintenanceDialog.action.confirmationPhrase" @keyup.enter="executeMaintenance" />
        </label>
        <p class="maintenance-confirm-note">Disk Sense 只会提交上方固定操作，不会把输入内容拼接进系统命令。</p>
        <div class="modal-actions">
          <button class="quiet" @click="closeMaintenanceDialog">取消</button>
          <span></span>
          <button
            :class="maintenanceDialog.action.irreversible ? 'danger-quiet' : 'scan'"
            :disabled="maintenanceConfirmation.trim() !== maintenanceDialog.action.confirmationPhrase || maintenanceBusy"
            @click="executeMaintenance"
          >
            {{ maintenanceDialog.action.irreversible ? '确认不可逆维护' : '确认执行' }}
          </button>
        </div>
      </section>
    </div>

    <p v-if="message && activeTab !== 'junk'" class="inline-message" aria-live="polite">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { desktopApi } from '../platform/api'
import { handleRovingKeydown, trapDialogKeydown } from '../application/accessibility'
import type {
  CleanerExecuteProgress,
  CleanerFile,
  CleanerRule,
  CleanerScanProgress,
  CleanerScanResult,
  CleanupExclusion,
  MaintenanceJob,
  MaintenanceProgress,
  MaintenanceStatus,
  SlimmingAction,
  SlimmingItem
} from '../domain/desktop'
import { riskClass, riskLabel, riskLevels } from '../domain/risk'
import { formatBytes, formatDateTime } from '../shared/format'
import { cleanerCoverageLabel, cleanerFileKey, cleanerIssueLabel, uniqueCleanerFiles } from '../application/cleaner'
import AppIcon from './AppIcon.vue'
import ToolCachePanel from './ToolCachePanel.vue'
import CleanupHistoryPanel from './CleanupHistoryPanel.vue'

const activeTab = ref<'junk' | 'slimming' | 'history'>('junk')
const rules = ref<CleanerRule[]>([])
const results = reactive<Record<string, CleanerScanResult>>({})
const selected = ref<CleanerFile[]>([])
const slimming = ref<SlimmingItem[]>([])
const slimmingStatus = ref<MaintenanceStatus | null>(null)
const maintenanceHistory = ref<MaintenanceJob[]>([])
const scanBusy = ref(false)
const cleanupBusy = ref(false)
const slimmingBusy = ref(false)
const maintenanceBusy = ref(false)
const busy = computed(() => scanBusy.value || cleanupBusy.value || slimmingBusy.value || maintenanceBusy.value || scanningIds.value.size > 0)
const scanningIds = ref(new Set<string>())
const message = ref('')
const exclusions = ref<CleanupExclusion[]>([])
const exclusionPath = ref('')
const exclusionMode = ref<'exact' | 'prefix'>('prefix')
const showExclusions = ref(false)
const expandedCategories = ref(new Set<string>())
const historyRefreshKey = ref(0)
const lastScanDurationMs = ref(0)
const executeProgress = reactive<CleanerExecuteProgress>({ id: '', processed: 0, total: 0, succeeded: 0, failed: 0, current: '' })
const scanStatus = reactive<CleanerScanProgress>({ ruleId: '', visited: 0, found: 0, current: '' })
const maintenanceProgress = reactive<MaintenanceProgress>({ id: '', actionId: '', phase: 'running', percent: null, message: '' })
const maintenanceDialog = ref<{ item: SlimmingItem; action: SlimmingAction } | null>(null)
const maintenanceConfirmation = ref('')
const cleanupDialog = ref(false)
const exclusionDialogElement = ref<HTMLElement | null>(null)
const cleanupDialogElement = ref<HTMLElement | null>(null)
const maintenanceDialogElement = ref<HTMLElement | null>(null)
let previousDialogFocus: HTMLElement | null = null
let unsubscribeExecute: (() => void) | null = null
let unsubscribeScan: (() => void) | null = null
let unsubscribeMaintenance: (() => void) | null = null

const scannedCount = computed(() => Object.keys(results).length)
const scanProgress = computed(() => rules.value.length ? Math.round(scannedCount.value / rules.value.length * 100) : 0)
const foundItems = computed(() => Object.values(results).reduce((sum, result) => sum + (result.itemCount ?? result.files.length), 0))
const foundBytes = computed(() => Object.values(results).reduce((sum, result) => sum + result.total, 0))
const actionableFiles = computed(() => uniqueCleanerFiles(Object.values(results).flatMap(result => result.selectable ? result.files : [])))
const actionableBytes = computed(() => actionableFiles.value.reduce((sum, file) => sum + file.size, 0))
const actionableItems = computed(() => actionableFiles.value.length)
const incompleteScans = computed(() => Object.values(results).filter(result => result.truncated || ['partial', 'unavailable'].includes(result.coverage?.status || '')).length)
const selectedBytes = computed(() => selected.value.reduce((sum, item) => sum + item.size, 0))
const scanningRuleTitle = computed(() => rules.value.find(rule => rule.id === scanStatus.ruleId)?.title || '清理规则')
const categoryOrder = ['Windows', '浏览器', '应用缓存', '开发工具', '诊断', '图形', 'Windows 更新']
const categoryMeta: Record<string, { title: string; description: string }> = {
  Windows: { title: 'Windows 临时与缓存', description: '系统和用户临时文件、资源管理器缓存及回收站占用' },
  浏览器: { title: '浏览器缓存', description: '只处理可重建网页缓存，不触碰登录状态、密码和书签' },
  应用缓存: { title: '应用程序缓存', description: '通信与桌面应用生成的可重建界面缓存' },
  开发工具: { title: '开发工具缓存', description: '下载缓存、索引和临时构建数据，不处理项目文件' },
  诊断: { title: '诊断与错误报告', description: '过期崩溃转储和 Windows 错误诊断信息' },
  图形: { title: '图形缓存', description: '可由显卡驱动和应用重新生成的着色器缓存' },
  'Windows 更新': { title: 'Windows 更新缓存', description: '只检测更新下载占用，交由 Windows 官方维护流程处理' }
}
const riskPriority: Record<CleanerRule['risk'], number> = {
  safe: 0,
  low: 1,
  attention: 2,
  elevated: 3,
  danger: 4
}
const categoryGroups = computed(() => {
  const selectedPaths = new Set(selected.value.map(cleanerFileKey))
  return [...new Set(rules.value.map(rule => rule.category))]
    .sort((left, right) => {
      const leftIndex = categoryOrder.indexOf(left)
      const rightIndex = categoryOrder.indexOf(right)
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right, 'zh-CN')
    })
    .map(key => {
      const groupRules = rules.value.filter(rule => rule.category === key)
      const groupResults = groupRules.map(rule => results[rule.id]).filter(Boolean)
      const selectableFiles = uniqueCleanerFiles(groupResults.flatMap(result => result.selectable ? result.files : []))
      const risk = groupRules.reduce(
        (highest, rule) => riskPriority[rule.risk] > riskPriority[highest] ? rule.risk : highest,
        groupRules[0]?.risk || 'safe'
      )
      return {
        key,
        title: categoryMeta[key]?.title || key,
        description: categoryMeta[key]?.description || `${key}相关的清理候选`,
        risk,
        rules: groupRules,
        scanned: groupResults.length,
        incomplete: groupResults.filter(result => result.truncated || ['partial', 'unavailable'].includes(result.coverage?.status || '')).length,
        unavailable: groupResults.length > 0 && groupResults.every(result => result.coverage?.status === 'unavailable'),
        items: groupResults.reduce((sum, result) => sum + (result.itemCount ?? result.files.length), 0),
        bytes: groupResults.reduce((sum, result) => sum + result.total, 0),
        retainedItems: groupResults.reduce((sum, result) => sum + result.retained.recentItems + result.retained.olderItems, 0),
        selectableFiles,
        selectedFiles: selectableFiles.filter(file => selectedPaths.has(cleanerFileKey(file))).length
      }
    })
})

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))} 毫秒`
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)} 秒`
}

function scanLimitMessage(result: CleanerScanResult) {
  const messages: Record<string, string> = {
    'max-files': '候选文件达到单规则 20,000 个上限',
    'max-visited': '目录遍历达到单规则 100,000 项上限',
    'max-time': '扫描达到单规则 20 秒时间上限'
  }
  const detail = messages[result.limitReason || ''] || '扫描达到安全资源上限'
  return `${detail}；当前结果可安全预览，但不代表该目录的完整总量。`
}

function setScanning(id: string, active: boolean) {
  const next = new Set(scanningIds.value)
  if (active) next.add(id)
  else next.delete(id)
  scanningIds.value = next
}

function isCategoryExpanded(key: string) {
  return expandedCategories.value.has(key)
}

function toggleCategoryExpanded(key: string) {
  const next = new Set(expandedCategories.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedCategories.value = next
}

function categoryByKey(key: string) {
  return categoryGroups.value.find(group => group.key === key)
}

function isCategorySelected(key: string) {
  const group = categoryByKey(key)
  return Boolean(group?.selectableFiles.length && group.selectedFiles === group.selectableFiles.length)
}

function isCategoryPartiallySelected(key: string) {
  const group = categoryByKey(key)
  return Boolean(group?.selectedFiles && group.selectedFiles < group.selectableFiles.length)
}

function toggleCategory(key: string) {
  const group = categoryByKey(key)
  if (!group?.selectableFiles.length) return
  const groupPaths = new Set(group.selectableFiles.map(cleanerFileKey))
  if (isCategorySelected(key)) {
    selected.value = selected.value.filter(file => !groupPaths.has(cleanerFileKey(file)))
    return
  }
  selected.value = uniqueCleanerFiles([...selected.value, ...group.selectableFiles])
}

async function scanRule(id: string, propagateError = false) {
  const api = desktopApi()
  if (!api || scanningIds.value.has(id)) return
  setScanning(id, true)
  selected.value = selected.value.filter(item => item.ruleId !== id)
  delete results[id]
  try {
    results[id] = await api.cleanerScan(id)
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      message.value = error instanceof Error ? error.message : String(error)
    }
    if (propagateError) throw error
  } finally {
    setScanning(id, false)
  }
}

async function runLimited(ids: string[], concurrency: number) {
  const queue = [...ids]
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()
      if (id) await scanRule(id, true)
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  const failure = outcomes.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

async function scanAll() {
  scanBusy.value = true
  message.value = ''
  selected.value = []
  for (const id of Object.keys(results)) delete results[id]
  const startedAt = performance.now()
  try {
    await runLimited(rules.value.map(rule => rule.id), 3)
    const retainedItems = Object.values(results).reduce((sum, result) => sum + result.retained.recentItems + result.retained.olderItems, 0)
    const coverageNote = incompleteScans.value ? `有 ${incompleteScans.value} 条规则未完整扫描，请展开查看原因。` : ''
    message.value = `扫描结束：按规则汇总发现 ${foundItems.value.toLocaleString()} 个项目，占用 ${formatBytes(foundBytes.value)}（规则间可能交叠）；去重后 ${actionableItems.value.toLocaleString()} 个文件（${formatBytes(actionableBytes.value)}）通过当前安全条件，另有 ${retainedItems.toLocaleString()} 个文件按保留时间保留。${coverageNote}`
  } catch (error) {
    message.value = error instanceof Error && error.name === 'AbortError' ? '扫描已取消，已完成的规则结果仍可查看。' : error instanceof Error ? error.message : String(error)
  } finally {
    lastScanDurationMs.value = performance.now() - startedAt
    scanBusy.value = false
  }
}

async function cancelScans() {
  const api = desktopApi()
  if (!api) return
  const result = await api.cleanerScanCancel()
  if (result.cancelled) message.value = '正在停止扫描…'
}

function isSelected(id: string) {
  const files = results[id]?.files || []
  const selectedPaths = new Set(selected.value.map(cleanerFileKey))
  return files.length > 0 && files.every(item => selectedPaths.has(cleanerFileKey(item)))
}

function toggle(id: string) {
  const rule = rules.value.find(item => item.id === id)
  if (!(results[id]?.selectable ?? rule?.selectable)) return
  const files = results[id]?.files || []
  const paths = new Set(files.map(cleanerFileKey))
  if (isSelected(id)) {
    selected.value = selected.value.filter(item => !paths.has(cleanerFileKey(item)))
  } else {
    selected.value = uniqueCleanerFiles([...selected.value, ...files])
  }
}

function execute() {
  if (!selected.value.length) return
  cleanupDialog.value = true
}

async function performCleanup() {
  if (!selected.value.length || busy.value) return
  cleanupDialog.value = false
  const api = desktopApi()
  if (!api) return
  cleanupBusy.value = true
  executeProgress.id = ''
  executeProgress.processed = 0
  executeProgress.total = selected.value.length
  executeProgress.succeeded = 0
  executeProgress.failed = 0
  executeProgress.current = ''
  message.value = ''
  try {
    const affectedRules = [...new Set(selected.value.map(item => item.ruleId))]
    const job = await api.cleanerExecute(selected.value)
    const cancelled = job.cancelled ? '；任务已按请求停止' : ''
    const overflow = job.rejectedOverflow ? `；另有 ${job.rejectedOverflow} 个文件超过单次任务上限` : ''
    message.value = `已将 ${job.succeeded} 个文件（${formatBytes(job.movedToTrashBytes)}）移入回收站${job.failed ? `；${job.failed} 个文件未处理` : ''}${cancelled}${overflow}。这些空间需在清空回收站后才会真正释放。`
    selected.value = []
    historyRefreshKey.value++
    await runLimited(affectedRules, 2)
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    cleanupBusy.value = false
  }
}

async function loadExclusions() {
  const api = desktopApi()
  if (api) exclusions.value = await api.cleanerExclusions()
}

async function addExclusion(pathOverride?: string) {
  const value = String(pathOverride || exclusionPath.value).trim()
  if (!value) return
  const api = desktopApi()
  if (!api) return
  try {
    await api.cleanerExclusionAdd({
      path: value,
      mode: pathOverride ? 'exact' : exclusionMode.value,
      reason: pathOverride ? '从清理文件明细中排除' : '用户手动排除'
    })
    exclusionPath.value = ''
    selected.value = []
    for (const id of Object.keys(results)) delete results[id]
    await loadExclusions()
    message.value = '排除项已保存。为保证结果准确，请重新扫描。'
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
}

async function excludeFile(filePath: string) {
  await addExclusion(filePath)
}

async function removeExclusion(id: string) {
  const api = desktopApi()
  if (!api) return
  try {
    await api.cleanerExclusionRemove(id)
    for (const ruleId of Object.keys(results)) delete results[ruleId]
    selected.value = []
    await loadExclusions()
    message.value = '排除项已移除，请重新扫描以更新候选结果。'
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
}

async function cancelCleanup() {
  const api = desktopApi()
  if (!api) return
  const result = await api.cleanerCancel()
  if (result.cancelled) message.value = '正在安全停止；当前文件处理完成后不会继续下一个。'
}

async function loadSlimming() {
  const api = desktopApi()
  if (!api) return
  slimmingBusy.value = true
  try {
    const [status, items, history] = await Promise.all([
      api.cleanerSlimmingStatus(),
      api.cleanerSlimming(),
      api.cleanerSlimmingHistory()
    ])
    slimmingStatus.value = status
    slimming.value = items
    maintenanceHistory.value = history
    maintenanceBusy.value = Boolean(status.activeTask)
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    slimmingBusy.value = false
  }
}

function closeMaintenanceDialog() {
  if (maintenanceBusy.value) return
  maintenanceDialog.value = null
  maintenanceConfirmation.value = ''
}

function requestMaintenance(item: SlimmingItem, action: SlimmingAction) {
  if (!action.enabled || maintenanceBusy.value) {
    message.value = action.disabledReason || '当前不能执行该操作'
    return
  }
  if (action.readOnly) {
    void runMaintenance(action, action.confirmationPhrase)
    return
  }
  maintenanceDialog.value = { item, action }
  maintenanceConfirmation.value = ''
}

async function runMaintenance(action: SlimmingAction, confirmation: string) {
  const api = desktopApi()
  if (!api || maintenanceBusy.value) return
  maintenanceBusy.value = true
  Object.assign(maintenanceProgress, {
    id: '',
    actionId: action.id,
    phase: 'running',
    percent: null,
    message: '正在建立安全维护任务…'
  })
  message.value = ''
  try {
    const job = await api.cleanerSlimmingExecute({ actionId: action.id, confirmation })
    message.value = job.message
    historyRefreshKey.value++
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    maintenanceBusy.value = false
    await loadSlimming()
  }
}

async function executeMaintenance() {
  const dialog = maintenanceDialog.value
  if (!dialog || maintenanceConfirmation.value.trim() !== dialog.action.confirmationPhrase) return
  const confirmation = maintenanceConfirmation.value.trim()
  maintenanceDialog.value = null
  maintenanceConfirmation.value = ''
  await runMaintenance(dialog.action, confirmation)
}

function openSlimming() {
  activeTab.value = 'slimming'
  if (!slimming.value.length) void loadSlimming()
}

function ruleIcon(category: string) {
  if (category.includes('Windows')) return 'shield'
  if (category.includes('诊断')) return 'history'
  if (category.includes('浏览器')) return 'overview'
  return 'database'
}

function handleDialogKeydown(event: KeyboardEvent, close: () => void) {
  trapDialogKeydown(event, event.currentTarget as HTMLElement, close)
}

watch([showExclusions, cleanupDialog, maintenanceDialog], async (values, previous) => {
  const open = values.some(Boolean)
  if (open && !previous.some(Boolean)) previousDialogFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (open) {
    const dialog = exclusionDialogElement.value || cleanupDialogElement.value || maintenanceDialogElement.value
    dialog?.querySelector<HTMLButtonElement>('.modal-close')?.focus()
  } else if (previousDialogFocus?.isConnected) {
    previousDialogFocus.focus()
    previousDialogFocus = null
  }
})

onMounted(async () => {
  const api = desktopApi()
  if (!api) return
  unsubscribeExecute = api.onCleanerExecuteProgress(progress => Object.assign(executeProgress, progress))
  unsubscribeScan = api.onCleanerScanProgress(progress => Object.assign(scanStatus, progress))
  unsubscribeMaintenance = api.onCleanerSlimmingProgress(progress => {
    Object.assign(maintenanceProgress, progress)
    if (progress.phase !== 'running') {
      maintenanceBusy.value = false
      window.setTimeout(() => void loadSlimming(), 200)
    }
  })
  try {
    ;[rules.value, exclusions.value] = await Promise.all([api.cleanerRules(), api.cleanerExclusions()])
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  }
})

onUnmounted(() => {
  unsubscribeExecute?.()
  unsubscribeScan?.()
  unsubscribeMaintenance?.()
})
</script>

<style src="./cleaner.css"></style>

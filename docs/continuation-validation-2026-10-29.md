# 续修：搜索首屏与 Windows 实机验证

基于上一轮本地修改继续，版本仍为 0.9.0-beta.9。本文件记录推送前的本地验收证据，最后复核日期为 2026-10-30；远端运行状态另见 [GitHub Actions](https://github.com/IC-sd/disk-sense/actions)。

## 搜索

- 避免缩写分支对已经召回的记录重复匹配、重复插入。
- 首屏和前 2048 个排序位置使用有界 Top-K 堆；应用标题只在堆内去重，精确总数单独计算。保留完整候选，不减少召回结果。
- 完整排序键、评分和索引延迟到深分页；并发删除使首屏缺项时回退到完整排序，维持冻结游标与实时路径校验。
- 只读连接的缓存指纹不再被临时表写入误判失效，外部主库提交仍使新查询刷新。
- 固定种子与对抗测试对照完整内存排序，覆盖应用标题进出堆、替换、历史偏好、四种排序、Unicode、取消、删除补页与元数据冻结。

`node --expose-gc scripts/benchmark-bounded-search.cjs 100000`，每次命中 100,000 条并完整保留：

| 排序 | 新查询首屏 | 第二页 | 同会话重复首屏 |
| --- | --- | --- | --- |
| 名称 | 764.42 ms | 210.22 ms | 0.61 ms |
| 相关度 | 1321.77 ms | 455.29 ms | 0.89 ms |
| 大小 | 1184.06 ms | 359.83 ms | 0.45 ms |
| 修改时间 | 1297.09 ms | 402.08 ms | 0.43 ms |

本机单次合成索引引擎测量，原始 JSON：`work/search-final-100k.json`。此前同机脚本首次为约 2.2–5 秒。没有隔离后台负载，也未统计多次运行分位数；结果不等于 GUI 输入延迟或所有机器的性能保证。深分页仍需支付完整排序索引成本，不能理解为所有页始终低于一毫秒。

## 已执行验证

- 全量自动化：53 个测试文件，448 项通过；前端和关键后端类型检查、55 个桌面模块语法检查及差异空白检查通过。最终测试日志：`work/continuation-locations-tests.txt`。硬链接和 Windows 原生元数据测试需要沙箱外权限；最终全量运行已通过，不将沙箱内权限失败计为通过。
- 官方锁定 Electron 43.8.1 的镜像字节与 npm 包内官方 checksums.json 的 SHA256 完全一致，恢复运行时；没有修改默认下载源或降版本。
- 修复 Vite 监听项目 work 目录中的 Chromium Cookies 导致 EBUSY；开发冒烟可以显式选择独立验证运行时。
- 真实 Electron 开发冒烟通过，包括拼音、缩写、分页、排序会话、建库期间查询、图标、键盘与分析面板。
- 最后页面巡检发现 Windows 无法解析 `desktop` 已知目录时，`inspect:locations` 会整体失败；现逐项跳过不可用目录，保留其他可访问位置。已补目录失败、重复项、文件与不存在路径的回归测试，并重新通过真实开发版完整页面夹具巡检；日志：`work/smoke-locations-fix.txt`，未再出现该 IPC 错误。
- 包含快捷位置修复的 electron-builder 解包程序重新构建完成；ASAR 11 个必需文件和 5 个安全 Fuses 检查通过；真实 packaged=true 浅色程序高级搜索、8 项浅色界面属性及 AI 对话框键盘导航冒烟通过。原始结果：`work/package-check-locations-fix.txt`、`work/smoke-packaged-locations-fix.txt`；截图 `work/smoke-packaged-locations-fix.png` 已目视复核。
- 可运行程序：`release/win-unpacked/Disk Sense.exe`，需保留同目录配套文件；该本地验证产物未签名。

## 仍需独立环境的验收

本机是 Windows 11 家庭版实机，未发现可用的 Windows Sandbox、Hyper-V 管理、VMware 或 VirtualBox 环境。没有在宿主机安装搜索服务、执行真实用户数据清理、系统维护或重启。

安装升级、卸载保留、服务安装与重启、USN 断档等不能标记为已验收。对应隔离流程见 [Windows 验收清单](windows-acceptance.md)。该工作流仅手动触发，本地记录时尚未在 GitHub 运行；推送源码本身不会触发独立安装验收。

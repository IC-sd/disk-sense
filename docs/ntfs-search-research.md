# NTFS 索引研究与实现

2026-10-18，资料来源为用户提供的 Listary 6.3.5.94 研究目录，以及本机固定 NTFS 卷的只读实验。资料中的操作建议作为研究材料处理；具体实现与执行范围按用户的文件搜索需求确定。

## 能直接核实的 Listary 行为

- `readable/Listary/Listary/Core/FileSearch/-.cs:863` 为原生卷索引提供普通卷句柄、异步卷句柄和以 `128` 访问权限打开的 `$MFT::$DATA` 句柄。
- `decompiled/Listary.Service/Listary/Service/ListaryService.cs:128-135` 中，服务实现 `CreateFile`，并通过 `DuplicateHandle` 将句柄交给调用进程。
- 这些证据能确认卷元数据读取和权限辅助的结构；不能据此还原原生内核的全部快照一致性、缓存和排序策略。

Disk Sense 的辅助程序、解析器、同步状态机均为本项目实现。权限辅助由自己的 Windows 服务完成，经首次 Windows UAC 确认后，安装到管理员拥有的 `%ProgramFiles%\Disk Sense Search\<SID摘要>`，以 LocalSystem 自动启动。只开放 `probe`、`snapshot`、`journal` 和 `identity` 等固定的只读元数据操作，不接收任意命令、写盘或服务关闭 RPC。主程序保持普通权限；管道有用户 SID ACL、禁止网络访问的 ACL 和随机令牌验证。令牌文件仅管理员、SYSTEM 和目标用户可读取。服务支持最多四个连接，快照枚举串行执行。

## 当前索引方式

1. 通过 `FSCTL_GET_NTFS_VOLUME_DATA` 获取几何参数，保存卷序列号、完整根 FRN、USN 日志标识及起始游标。
2. 用 `FSCTL_GET_NTFS_FILE_RECORD` 从最高有效记录向下枚举，检查返回的实际序号，跳过空洞。驱动返回的记录包含当前缓存中的元数据。目录图按完整 FRN（含序列号）解析路径，同时合并扩展记录中的文件名，收录硬链接。
3. SQLite 分批提交文件、拼音和 FRN 图。已有索引持续可搜。只有完整快照成功后才清除旧记录；中断或失败保留旧索引。
4. 每 2 秒尝试读取 USN 变更。先固定本轮日志末尾，再合并涉及的 FRN，重新读取当前记录。扩展文件名可通过属性列表解析；原始读取不支持时，用 `OpenFileById` 和 `FindFirstFileNameW` 取得硬链接元数据。
5. 目录改名使用数据库事务同时迁移后代路径，支持父子同时改名、交换名称、仅改变大小写及子树移出已删除目录。文件更新按批提交，完整应用后再推进游标。退出期间的变更在下次普通权限连接后从已保存游标补收。服务短暂断开只重连重试，保留快照和日志游标。
6. 卷替换、日志覆盖或更换、图缺口、异常版本及过大积压触发快照重建，避免把不完整回放记成已同步。

启用 NTFS 的卷由 USN 维护，不重复安装递归文件监听，也不按固定周期重扫全盘。其他文件系统和权限不可用时，使用现有 Win32/Node 目录枚举及文件监听。重新授权已有完整 NTFS 索引时先回放日志，正常情况下不重建快照。

辅助程序也实现了 `$MFT` 区段读取和原始 FILE/USA 校验，供 `snapshot` 的 `raw: true` 诊断模式使用。本机 C 盘支持，D 盘的相关操作返回错误 50。正式路径选择驱动记录，以免原始磁盘页落后于文件系统缓存。MFT 按实际父记录解析，不进入重解析点的目标；云目录中属于当前卷的子记录仍可收录。

## 权限与能力边界

本机普通用户的卷枚举返回访问拒绝（5）。搜索页点击“启用开机加速”并通过首次 Windows 管理员确认，即安装当前用户的只读服务。应用退出和服务重启后，普通权限进程均可重新连接；正常 Windows 开机自动启动服务。服务二进制版本更新时需重新确认安装；“关闭开机加速”卸载服务，保留搜索索引。实际系统重启未执行，本次核验了 SCM 的 Auto 配置、LocalSystem 账户、受保护安装 ACL，以及服务停止/启动后的普通权限自动重连。

旧版临时会话连接只作为兼容路径保留。新安装使用持久服务，临时会话的四小时寿命不适用于服务。

首次完整入库仍需要时间。原生读取耗时、SQLite 建库耗时和 GUI 查询延迟分别记录，不能把某个原生阶段的秒数当作完整搜索启动速度。辅助程序在本机用 .NET Framework 编译，失败时保留常规扫描路径。断点恢复只重建未完成的原生卷；已完成卷回放日志，不被其他卷的收录代次清理。

批量补收已将目录关系删除从整卷扫描改为两个路径范围查询。未变化记录不重写代次和目录关系；只有大小/时间变化时仅更新对应列，不重写名称、类型和路径索引。收录代次持久化后，普通启动无需再遍历文件表计算最大代次。约九十万条真实索引副本的 6,000 个文件身份变更应用约 4.3 秒，构造服务约 325 毫秒；真实服务离线变更验证另见 `docs/ntfs-validation.json`，不能将这两种不同工作量的测量直接比较。

## Windows 文档

- [FSCTL_GET_NTFS_FILE_RECORD：返回实际占用记录、输出缓冲区大小和多记录文件](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_get_ntfs_file_record)
- [FSCTL_READ_USN_JOURNAL](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_read_usn_journal)
- [遍历变更日志记录缓冲区](https://learn.microsoft.com/en-us/windows/win32/fileio/walking-a-buffer-of-change-journal-records)
- [MULTI_SECTOR_HEADER：USA 与固定 512 字节序列跨度](https://learn.microsoft.com/en-us/windows/win32/devnotes/multi-sector-header)
- [OpenFileById](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-openfilebyid)
- [FindFirstFileNameW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfilenamew)
- [Service security and access rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)
- [ServiceBase.OnStart](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onstart)

复现实验使用 `scripts/probe-ntfs.cjs`、`scripts/verify-ntfs.cjs`、`scripts/verify-ntfs-search.cjs`。服务验收使用 `scripts/verify-ntfs-service.cjs --plan`、`--install` 和 `--restart`；后两者会执行明确的服务管理操作。`scripts/verify-ntfs-warm-start.cjs` 使用真实索引副本验证普通权限重启及离线变化；`scripts/profile-search-lifecycle.cjs` 使用副本测量 SQLite 补收。验证脚本的文件改动限于自己创建的临时目录；全盘读取只涉及索引元数据。

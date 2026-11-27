# 数据源更新

在 Windows 管理员端顶部打开「数据源更新」。自动更新页显示已配置的下载任务及可配置来源。手动更新页提供来源链接和上传文件入口。通过校验的自动下载数据汇入左侧数据库列表中的「自动更新谱库」。

## 来源与版本

目录包含 52 个来源，其中 39 个支持在软件内配置自动检查，13 个列在手动更新页。

- MassBank 通过正式发布标签确定指定贡献机构的目录。服务比较 Git 目录哈希并校验谱图文件。
- MSⁿLib 通过 Zenodo 的发布信息定位所选子库。服务支持校验过的 MGF 和逐行 JSON 导出。
- 固定文件及 GNPS2 下载地址记录在 `scripts/customer-delivery/source-files.json`。可变文件通过 HTTP 版本标记与内容 SHA-256 判断变化。固定版本附件若改用新编号或文件名，由维护人员核验后更新下载清单。

## 定时检查和恢复

已启用的任务由 Test1 按北京时间每月 15 日 03:00 起依次检查。服务每 15 秒判断任务是否到期，一次执行一个自动下载任务。Windows 管理员端关闭后，Test1 服务会继续调度。计划时间和任务状态保存在 `candidate-data/source-updates/tasks.json`。

下载进度和错误可以在管理员端查看。服务重启会重新读取任务状态，继续处理到期未启动的任务。已中断的批次可手动重试，服务会优先复用符合续传条件的批次文件。下载文件、回执与错误日志保存在 `candidate-data/source-updates/batches/<批次ID>/`。

自动更新入口 `scripts/customer-delivery/source-download.py` 使用同目录的 `download.py`。解析模块生成候选谱图，服务校验并去重后写入「自动更新谱库」对应的 `lds-workspace.sqlite`。手动上传走管理员选定的业务库、差异核对和发布流程。

Test1 的完整状态路径和部署方式见 [服务器部署与 GitHub 交接](server-deployment.md)。

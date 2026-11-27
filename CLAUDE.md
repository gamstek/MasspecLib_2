# MasspecLib2 项目约定

- 每次完成并验证 MasspecLib2 源码修改后，同步改动文件到 `Test1:/workspace/ptk-master2`。同步后逐文件核对 SHA-256，并在交付时说明验证结果。
- Test1 当前交付服务从 `/workspace/ptk-master2/outputs/usability_revision_20261029/candidate-source` 运行。服务依赖的源码或版本有变化时，同步实际运行目录，按需重新加载服务并检查 `/health`。
- 同步前比对远端版本和待改文件，保留服务器独有的改动。仅上传本次源码变更及对应项目文档。
- 已安装的 Windows 管理员端通过新版 MSI 更新。
- 服务器实际配置和密钥位于 `.server/`，运行环境位于 `.runtime/`。这两处内容和实际谱库数据应保存在受控备份中。部署步骤见 [服务器部署说明](docs/server-deployment.md)。

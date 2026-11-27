# MasspecLib2

MasspecLib2 提供多数据库检索、质谱与液相方法查看、数据源更新和客户交付。版本见 [package.json](package.json)。

- [服务器部署与 GitHub 交接](docs/server-deployment.md)
- [数据源更新](docs/source-updates.md)

## 构建 Windows 应用

在 Windows 上安装 Node.js 22.13 或更高的 22.x 版本后，从项目根目录执行。

```powershell
npm ci --ignore-scripts
npm run db:gen
npm run build
```

编译产物在 `out/`。从新服务器部署到生成管理员 MSI 和客户打包模板，请按仓库的 [部署手册](docs/server-deployment.md) 操作。项目协作规则见 [AGENTS.md](AGENTS.md)。

# 开发指南

本指南面向在 `dev` 分支或本地源码检出中工作的贡献者。

## 分支职责

- `main`：面向正式发布，承载安装脚本、发布说明与用户侧验证入口。
- `dev`：日常开发分支，承载源码迭代与贡献者协作流程。
- `release/vX.Y.Z`：特定版本的发布验证与热修复分支。

开发专用行为应先保留在 `dev` 分支，验证稳定后再提升到 `main`。

## 启动源码 CLI

在源码检出目录中运行：

```bash
npm ci
npm run build
cd clients/go-tui && make build && cd ../..
npm run cli -- go --check --no-start-nexus
npm run cli -- go
```

`bbl go` 是正式交互客户端。TypeScript chat TUI 已在 v0.3.7 从发布包中移除，因此源码验证也应走用户安装后实际使用的 Go TUI 路径。

## 与 release 二进制对比

发布验证应使用已安装或已构建的二进制：

```bash
bbl go --check --no-start-nexus
./dist/cli/program.js go --check --no-start-nexus
```

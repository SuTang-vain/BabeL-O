# 开发指南

本指南面向在 `dev` 分支或本地源码检出中工作的贡献者。

## 分支职责

- `main`：面向正式发布，承载安装脚本、发布说明与用户侧验证入口。
- `dev`：日常开发分支，承载源码迭代与贡献者协作流程。
- `release/vX.Y.Z`：特定版本的发布验证与热修复分支。

开发专用行为应先保留在 `dev` 分支，验证稳定后再提升到 `main`。

## 使用 dev 模式启动源码 CLI

在源码检出目录中运行：

```bash
npm ci
npm run cli -- chat dev
```

`chat dev` 会从当前源码树启动交互式 TUI，并在欢迎标题中显示：

```text
❖ BABEL-O  dev
```

本地验证源码改动时请使用该模式，避免与 `$PATH` 中已安装的正式 release 二进制 `bbl chat` 混淆。

## 与 release 二进制对比

发布验证应使用已安装或已构建的二进制：

```bash
bbl chat
./dist/bbl chat
```

这些命令应显示 release 版本标题，例如 `❖ BABEL-O  v0.3.1`，而不是 `dev`。

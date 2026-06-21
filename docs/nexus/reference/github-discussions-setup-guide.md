# GitHub Discussions Setup Guide

> State: Guide
> Track: Product / Community / Governance
> Priority: P0
> Source of truth: [../active/TODO_product_30day.md](../active/TODO_product_30day.md), [../../../README.md](../../../README.md), [../../../README.zh-CN.md](../../../README.zh-CN.md), [../../../GOVERNANCE.md](../../../GOVERNANCE.md)
> Governance: This guide owns the manual GitHub Discussions setup checklist. It does not replace GitHub repository settings or community moderation decisions.
> Related: [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md)

## Purpose

This is an operator checklist for Product W4.2. GitHub Discussions cannot be
enabled from repository files; a repository owner must enable it in GitHub
settings.

## Enable Discussions

1. Open the GitHub repository.
2. Go to `Settings` -> `General` -> `Features`.
3. Enable `Discussions`.
4. Open the new `Discussions` tab.
5. Create or confirm these categories:
   - `Q&A`
   - `Show and tell`
   - `Ideas`
   - `General`

## Repository Links

These files already point users toward Discussions:

- `README.md`
- `README.zh-CN.md`
- `GOVERNANCE.md`

Until Discussions are enabled, users can still use issue templates:

- bug report
- feature request
- documentation issue
- question

## Maintainer Routine

- Check public issues or Discussions once per working day when possible.
- Keep bug reports in issues.
- Move open-ended usage questions to Discussions after the feature is enabled.
- Do not open Discord or Slack until there is enough maintainer capacity.

## Verification

After enabling:

- The README Discussions badge opens the repository Discussions tab.
- The categories above are visible.
- A test Q&A post can be created and answered.

## 中文概述

### 背景

GitHub Discussions 需要仓库 owner 在 GitHub Settings 里手动开启，代码无法代办。

### 核心做法

开启 Discussions 后创建 Q&A、Show and tell、Ideas、General 四类讨论区，并保持 README、中文 README 和 GOVERNANCE 的入口可用。

### 当前状态

文档和入口已准备好；仓库 Settings 开关仍需要 owner 手动执行。

### 下一步

开启 Discussions 后发一个测试 Q&A，并确认 README 徽章能打开 Discussions 页面。

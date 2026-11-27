<div align="center">

<img src="public/tracefork-icon.svg" alt="TraceFork 图标" width="96" height="96" />

# TraceFork

**比较同一任务的 GUI 智能体轨迹，查看行为在哪里分歧、又在哪里汇合。**

[English](README.md) · **简体中文**

[![React](https://img.shields.io/badge/React-19-149eca)](package.json)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6)](src/)
[![源码许可](https://img.shields.io/badge/Code_license-MIT-green)](LICENSE)

**已被 EMNLP 2026 System Demonstrations 接收。**  
Yuzhang Zhong、Stephen Xia · [论文信息](https://yuzhang-zhong.github.io/publication/2026-tracefork)

[快速开始](#quick-start) · [功能](#what-it-does) · [轨迹库](#static-trajectory-library) · [部署](#deployment) · [参与贡献](#contributing)

</div>

> **一句话速览：** 两个 GUI / 浏览器智能体（WebArena、VisualWebArena、Playwright、computer-use）跑同一网页任务，一个成功一个失败或死循环，肉眼比对几千行 JSON 日志太痛苦？TraceFork（[免安装在线演示](https://yuzhang-zhong.github.io/TraceFork/)）自动对齐两条执行轨迹，画成带截图证据的**分叉树**，一眼定位从哪一步开始走岔路或重新汇合。

TraceFork 帮助研究者比较 GUI 智能体执行同一任务的多次运行，检查行为从哪里开始不同。它将已发布或用户提供的 Web 智能体轨迹规范化，对齐相应步骤，并用检查树展示共同进展、分叉、未匹配步骤和后续汇合。

系统用于检查轨迹，不负责实时控制智能体。可比较人与模型、模型与模型、不同提示词设置，以及同一任务中成功和失败的运行。

<a id="what-it-does"></a>
## 功能

- 检索由 WebArena / VisualWebArena 风格轨迹构成的静态轨迹库。
- 通过确定性对齐与分歧评分，比较同一任务的两次运行。
- 展示动作节点、分叉与汇合结构，以及可悬停查看的截图证据。
- 接收粘贴的原始日志、渲染 HTML 摘录、规范化 JSON，以及可选的图像帧附件。
- 提供数据集导入、静态库导出与诊断检索脚本。

TraceFork 只使用可观察的轨迹材料：动作、目标、页面或状态摘要、截图、经过本地来源地址脱敏的 URL，以及已发布日志中存在的公开模型输出摘录。它不声称能够访问私有思维链。

<a id="quick-start"></a>
## 快速开始

先安装 Node.js 和 npm：

```bash
git clone https://github.com/yuzhang-zhong/TraceFork.git
cd TraceFork
npm install
npm run dev
```

打开终端打印的本地 Vite 地址。

生产构建：

```bash
npm run build
```

运行测试：

```bash
npm test
```

<a id="static-trajectory-library"></a>
## 静态轨迹库

仓库自带的规范化静态轨迹库位于 [`public/trajectory-library/`](public/trajectory-library/)。

原始基准数据压缩包不提交到仓库。如果你持有本地 WebArena / VisualWebArena 发布数据，请将原始文件保留在前端打包目录之外，再使用：

```bash
npm run dataset:audit
npm run dataset:export-static
npm run dataset:diagnostics
npm run dataset:research-cases
```

Git 忽略了 `Datasets/`、`dist/`、`node_modules/`、本地日志、凭据和生成的过程截图。

<a id="optional-supabase-backend"></a>
## 可选 Supabase 后端

使用自带轨迹库时，TraceFork 可以作为静态演示运行。需要托管检索数据库时，先应用 [`supabase/schema.sql`](supabase/schema.sql)，再配置服务端环境变量：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

不要把 service-role 密钥暴露在浏览器代码中。

<a id="deployment"></a>
## 部署

仓库内的 [GitHub Pages 工作流](.github/workflows/pages.yml) 使用以下配置构建 Vite 应用：

```text
VITE_BASE_PATH=/TraceFork/
```

若需要托管解析、Supabase 检索等后端 API 路由，请将 API 单独部署到无服务器托管环境，并在前端构建时设置 `VITE_API_BASE_URL`。

<a id="repository-hygiene"></a>
## 仓库内容边界

这个公开仓库不应包含：

- `.env*` 文件或 API 密钥；
- 原始 WebArena / VisualWebArena 数据压缩包；
- 本地 Playwright trace 压缩包；
- 私人草稿、审稿文件或生成的论文插图；
- 构建后的 `dist/` 输出；
- 本地截图、临时日志或与个人机器绑定的路径。

<a id="contributing"></a>
## 参与贡献

欢迎提出改进：

1. Fork 仓库，并为修改创建分支。
2. 使用 `npm install` 安装依赖，运行 `npm test` 和 `npm run build`。
3. 提交 Pull Request，说明改动，以及它影响的轨迹测试样例（如有）。

不要提交密钥、原始基准数据压缩包或生成的 `dist/` 输出，详见[仓库内容边界](#repository-hygiene)。

<a id="license"></a>
## 常见问题 · FAQ

<details>
<summary>TraceFork 与 LangSmith、Phoenix 或 Playwright Trace Viewer 单条轨迹回放有什么区别？</summary>

传统 **Playwright Trace Viewer** 或 **LangSmith** 主要面向单次运行回放；而本 MIT **开源**系统（EMNLP 2026 Demo，免安装在线版：https://yuzhang-zhong.github.io/TraceFork/ ）专门针对**同一任务下多条轨迹的横向步骤对齐、分叉汇合树（Fork/Rejoin Tree）与错误归因（Error Analysis）**，支持 **WebArena、VisualWebArena、OSWorld、Mind2Web、BrowserGym** 以及 **Claude Computer Use、OpenAI Operator、Browser-Use、UI-TARS** 等多智能体或人机对比评测。

</details>

## 许可

TraceFork 源码采用 MIT License，详见 [LICENSE](LICENSE)。

由基准数据衍生的轨迹、截图、缩略图、日志及其他第三方材料**不在 MIT 授权范围内**，仍受原始来源的许可和条款约束，包括 WebArena 与 VisualWebArena。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

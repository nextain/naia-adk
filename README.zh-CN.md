[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

# Naia ADK

**为 AI 编程智能体预先整理好的工作区脚手架。**

使用 Claude Code、Codex 这类 AI 编程工具时，每个工具的规则文件位置都不一样，"这份文档能不能公开"、
"技能放在哪里"也各有各的说法。Naia ADK 是预先铺好这套骨架的工作区。就像在新笔记本上先配好开发环境一样，
它先给 AI 智能体准备好一张整洁的桌子。它还附带一个仪表盘，让你可以直观地查看工作区的状态。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## 5 分钟跑起来

需要 **Node 22 及以上、pnpm 9 及以上**。

```bash
pnpm install    # 安装工作区依赖
pnpm dev        # 同时启动 API 服务器(:3141) 和仪表盘(:3142)
```

在浏览器中打开 `http://localhost:3142` 即可看到仪表盘。在这里可以直接看到三样东西：

- **工作区** — 项目和子模块、文件树，以及每一项的公开等级。
- **技能目录** — 本工作区中注册的技能列表及其内容。
- **设置 / 监控** — 服务器配置、客户端状态、数据目录。

仪表盘只把文档页面使用的 `/api/portal` 请求转发到 3141 端口的 API 服务器。如果只想启动服务器或只想启动仪表盘，
分别使用 `pnpm dev:server`(→ 3141)和 `pnpm dev:dashboard`(→ 3142)。启动脚本 `./start.sh`(Linux/macOS)
和 `start.bat`(Windows)最终也是运行 `pnpm dev`。服务器 CLI 接受 `--port`、`--host`、`--root` 选项。
例如，要指向另一个工作区，可以这样写：`pnpm serve -- --root /path/to/workspace`。

## 里面有什么

### 工作区脚手架

为了让 AI 智能体能立刻开始工作，它提供一组位置固定的目录。AI 读取的上下文放在 `.agents/`(英文，JSON/YAML)，
给人读的文档放在 `.users/context/`(韩文)和 `.users/context/en/`(英文)。这个镜像并不是完整复制，而是以
人需要阅读的核心文档为主的部分镜像(例如技能以 `.agents/skills/` 为原本，`.users/skills/` 中只有一部分)。
技能、数据、项目都有固定的位置，所以无论用哪个工具打开，看到的结构都一样。

### 仪表盘与 API

包含一个用于直观管理工作区的 Next.js 仪表盘，以及在背后支撑它的 Fastify API 服务器。通过顶部导航中的
**文档**(`/docs`)和 **工作** 标签页，可以在一个地方查看公司共享文档和协作看板；用
`pnpm adk:setup -- --company <仓库地址>` 命令可以一次性设置好公司文档和项目仓库。详细的设置与用法请参阅
[入门指南(韩文)](docs/guides/onboarding.ko.md)。
API 提供工作区元数据(`/api/workspace`)、技能目录(`/api/skills`)、公司文档门户(`/api/portal`)，以及实时
通知文件变更的 WebSocket(`/api/ws`)。有了这个 API，不只是仪表盘，其他程序也能访问工作区。

### 技能系统

把重复的工作打包成技能来复用。每个技能由一个 `SKILL.md` 文件定义，API 服务器扫描 `skills/` 目录生成目录。
此时只要有一个技能不符合规范，整个目录就会报错(fail-closed)。这样设计不是为了悄悄剔除坏掉的技能、只输出
其余部分，而是让运维人员当场修好。这是为了防止在不知情的情况下对外提供错误列表而做的选择。

### 目前包含的技能

技能分为四类。为了不必为了知道有哪些技能而重读全部内容，`.agents/context/skills-index.yaml` 中逐行整理了
每个技能做什么、何时使用。下面是它的目录。

**文档与对外产出** — 制作给人阅读的东西。
`doc-coauthoring`(规格与设计文档)、`proposal-writing`(提案书)、`read-doc`、
`translate-doc`、`press-release`、`weekly-report`、`document-generation`(品牌
PDF 与电子签名)、`copyright-reg`(著作权登记材料)、`patent-draft` 和
`patent-pipeline`(专利说明书)、`youtube-upload`(发布视频与字幕)。

**运转工作区** — 处理仓库本身的那双手。
`project-create`、`project-migration`、`merge-worktree`、`migrate-ctx`、
`session-resume`、`sync-upstream`(上游同步)、`manage-skills`、
`secret-vault`(加密密钥保险库)。

**验证关卡** — 不接受"已通过"的说法、而是要求证据的地方。
`verify-implementation`、`verify-contract-conformance`、`verify-request-contract`、
`verify-product-preservation`、`verify-benchmark-contract`、`verify-review-gate`、
`verify-build`(是否真的能构建)、`verify-conflict-markers`(是否残留冲突标记)、
`verify-i18n` 和 `verify-hardcoded-strings`(字符串是否放在该放的地方)、`webapp-testing`，
以及附加对抗式评审的 `review-pass`。

**运维与实验** — 与外部打交道或处理模型的工作。
`manage-discord-sessions`(Discord 网关运维)、`channel-management`、
`service-management`(运行、成本与故障处理)、`web-monitoring`、`email`、`sms`、
`upstream-pr-review`(提交到开源项目之前的检查)、`payroll`、
`finetune-persona`(角色 LoRA 训练)。

新建技能时从 `SKILL_TEMPLATE.md` 开始，建好之后也要在索引里留一行。索引与实际不一致时，下一个会话就会
重新创建一个它根本不知道已经存在的技能。

### 规则集与最小治理

即使是一个人用的工作区，一旦 AI 和自动化介入，就需要最低限度的规则。Naia ADK 把 `read`、`write`、
`execute`、`publish` 分为不同的关注点，并为每份文档标注公开等级。生产变更、密钥处理、对外公开这类难以撤回
的操作，会与普通的本地编辑分开，必须经过审批关卡。

公开等级分为四级。`public` 是可以原样发布到公开网站或开源仓库的内容；`controlled` 是经过审核后可以对外
分享的内容；`internal` 是只在工作区内部使用的内容；`confidential` 是合同、凭据、个人信息这类敏感内容。
凭据通常放在 git 之外，但按等级来说仍然是 `confidential`。

> **会话契约关卡在 marker-free 检出中处于启用状态。** 没有契约的会话也可以执行符合策略的日常工作，例如本地
> 检查、`npm test`、构建、`mkdir`、普通的非破坏性 Git stage/commit。治理与主机策略文件、共享入口文件、会话
> 契约与注册表权限、删除、破坏性或远程命令、对外发送以及生产变更，仍然需要契约。这个关卡是仓库钩子层面的
> 本地治理检查，不是操作系统沙箱，也不保证钩子之外执行的命令。详细策略请参阅
> `.agents/context/agents-rules.json` 和 `.agents/context/harness.yaml`。如果项目根目录或任一祖先目录中存在
> `.codex/no-harness`、`.claude/no-harness` 或 `.pi/no-harness`，其下的检出也会继承恢复模式。此候选版本的
> 会话契约钩子连接范围是 Codex 和 Claude，并不声称提供 Pi 会话契约适配器。

### 密钥放在哪里

API 密钥和证书不能直接提交到 git。但如果只放在各自的笔记本上，每次换机器都会丢失，也说不清谁持有什么。
Naia ADK 是这样折中的：把装有密钥的整个文件夹打包并加密，只把**这一个文件**提交到 git，解密后的内容则
完全不让 git 看到。

具体来说，就是用 tar 打包 `key/` 文件夹，再用 [age](https://github.com/FiloSottile/age) 加密，生成一个
`key.age`。`key/` 在 `.gitignore` 中，即使失手也不会被提交。被提交的永远只有 `key.age` 这一个文件。

密码由人亲自输入。AI 既不代为接收，也不代为输入。因此，打开和锁上保险库由用户在自己的终端里完成，而不需要
密码的检查和备份可以交给 AI。这个边界在技能内部按命令划分。

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # 在新仓库中创建保险库
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # 打开(需要密码)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # 重新锁上(需要密码)
bash .agents/skills/secret-vault/scripts/vault.sh status   # 检查备份是否为最新
bash .agents/skills/secret-vault/scripts/vault.sh sync     # 只提交 key.age 并 push
```

之所以有 `status`，是因为出错的方式是固定的：添加了密钥却忘了重新锁上，锁上了却忘了 push，或者留下了临时
文件，这些情况反复发生。`status` 一次检查这三种情况。对于"密钥都备份好了吗？"这个问题，不靠记忆，而是用
这条命令回答。

`lock` 在生成新的密文之后，会**再解密一次试试**，只有成功时才替换原有文件。这是为了防止中途失败、让保险库
处于损坏状态。

这个模式以 `data-private` 这样的个人仓库为标准使用场景，但任何放有一个 `key.age` 和被 gitignore 的 `key/`
的仓库都可以直接使用。如果想改名，可以用 `VAULT` 和 `PLAIN_DIR` 环境变量覆盖。

### LLM 适配器(naia-anyllm)

为需要连接 LLM 的功能内置了 `naia-anyllm` 适配器。它可以经由 [any-llm](https://github.com/nextain/any-llm)
网关，也可以直接连接 OpenAI、Anthropic、Google 等提供商。默认使用 Naia 账户：把在
[naia.nextain.io](https://naia.nextain.io) 签发的密钥放入 `NAIA_KEY` 环境变量，即可直接使用账户额度。没有
密钥时，会在任何付费调用之前报错。如果想更换提供商或模型，复制
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example) 使用；API 密钥不要放在
配置文件里，而是放在环境变量或操作系统的密钥存储中。`naia-settings/llm.json` 中只记录
`apiKeyRef: "NAIA_KEY"`，不记录密钥值。如果个人 fork 需要长期备份，请使用 `data-private/key/` 中的 age 加密
保险库(参见 [`.env.example`](.env.example))。

查询支持的模型和当前价格、翻译长篇 PDF，请使用 `translate-doc` 技能。查询模型和价格无需密钥；翻译会先给出
预估费用，并可以从中断处继续。

## 为什么这样设计

### 格式即契约

Naia ADK 的核心不是某个特定工具，而是**格式**。目录布局(`.agents/`、`.users/`、`skills/`、`data-*/`)和
文件模式(`agents-rules.json`、`SKILL.md`)是既定的约定，任何能读懂这套约定的工具都可以使用同一个工作区。
Claude Code、opencode、Codex、naia-agent 无需内嵌彼此的代码，就能各自读取同一个工作区。所以无论更换工具
还是混用多个工具，工作区都照常运作。

规则的强制执行(enforcement)本身也不绑定于工具。与宿主无关的核心(`.agents/hooks/core/`)和策略
(`.agents/hooks/policies/`)用同一套规则同时驱动 Claude Code 钩子和 pi 扩展。

### 成长为团队之前的个人基础

Naia ADK 始终是单人、个人用的。公司组织架构、租户规则、委托审批链之类属于更上层的职责。相应地，它在工作区
成长到团队或公司规模之前，提供一个地方，让你预先写下如何处理上下文的规范。

需要团队协作和共享知识时，可以扩展到 [Naia Business ADK](https://nextain.io/adk)。这一扩展把基线拓宽到资产、
流程和权限治理，并加入团队所有权和委托审批。

### fork 谱系

Naia ADK 以"fork 后变成自己的"为前提。个人可以直接 fork `naia-adk`。组织可以选择 `naia-business-adk` 这样
单独的组织谱系，创建公司和成员的工作区。并不要求所有用户都遵循一条固定的 fork 链。

```
naia-adk                  ← 公开的个人基础 (Apache 2.0)
  └── {user}-adk          ← 直接 fork 的个人工作区

naia-business-adk         ← 可选的组织谱系
  └── {org}-adk            ← 组织 fork：公司数据 + 业务子模块
        └── {member}-adk    ← 从组织派生的成员工作区
```

Nextain 的内部谱系是与上述选项无关的一个运营示例。公开基础的用户可以直接维护个人 fork。个人 fork 用
`{user}-adk` 这样的形式，填入自己的账户名来命名。

如果需要项目/团队基线，可以把 [naia-pj-adk](https://github.com/nextain/naia-pj-adk) 作为单独的基线来选择。
PJ 是处理多项目上下文漂移、调用成本和 Discord 运营边界的适配器基线。个人 fork 的定制与面向团队的角色、工作
时间规则是两个不同的问题。这套结构帮助整理和追踪工作是设计目标，并不是经过测量、保证节省成本或缩短工作时间
的主张。PJ 基线不是个人 fork 的上游仓库。需要组织协作时使用的 `naia-business-adk` 是可选的。

## 结构

仓库大致分为运行时代码(`packages/`)、规则与上下文(`.agents/`、`.users/`)、技能(`skills/`、
`.agents/skills/`)，以及每个 fork 自行填充的数据目录。

| 目录 | 用途 |
|-----------|---------|
| `.agents/` | 面向 AI 的上下文(英文，JSON/YAML)— 规则的唯一事实来源 |
| `.users/context/` | 给人读的文档(韩文，Markdown) |
| `.users/context/en/` | 给人读的英文镜像(Markdown) |
| `.claude/` | Claude Code 配置、钩子、技能符号链接 |
| `skills/` | 运维/运行时技能(由仪表盘 API 提供) |
| `scripts/` | 实用脚本 |
| `templates/` | 文档模板 |
| `docs/` | 架构文档、设计规格 |
| `packages/` | 运行时包(pnpm 工作区) |

### 运行时包(packages/，共 10 个)

其中三个是真正运行的程序，其余是定义格式与规格的轻量包。

- `core` — 解析工作区和技能的引擎。
- `server` — 基于 Fastify 的 REST/WebSocket API。
- `dashboard` — Next.js 仪表盘 UI。
- `skill-spec` — 与工具无关的技能格式契约(`SkillDescriptor`、`SkillLoader`)。
- `skills-builtin` — 通用技能目录。
- `openclaw-compat` — 把 OpenClaw 技能迁移为 naia 格式的工具。
- `persona` — 系统提示词约定规格。
- `process` — 工作流模式规格(评审 → 决策 → 执行、问题驱动开发等)。
- `naia-anyllm` — any-llm 网关 / 直连提供商的 LLM 适配器。
- `artifacts-spec` — 权限(RBAC)与开发生命周期(SDLC)产出物的标准模式。用 JSON Schema 定义 15 种产出物，
  并规定每种产出物是由 git 跟踪还是仅限于会话。

### 数据目录(gitignore，每个 fork 自行填充)

这四个目录不会提交到仓库。由 fork 的人放入自己的数据。

| 目录 | 范围 | 内容 |
|-----------|-------|---------|
| `data-company/` | 公司 | 全公司文档、共享资源 |
| `data-teams/` | 团队 | 各团队文档(战略、会计等) |
| `data-private/` | 个人 | 个人数据、env 文件、非公开文档 |
| `projects/` | 个人 | 项目仓库(子模块) |

### 两棵技能树

技能分布在两个地方，使用者不同。

- `.agents/skills/` — AI 辅助与工作流技能。Claude Code 通过 `.claude/skills/` 符号链接使用它们。其中包括评审
  (`review-pass`)、验证(`verify-implementation`)、工作树合并(`merge-worktree`)、文档提取(`read-doc`)、专利、
  著作权、薪资之类的业务技能，以及 `finetune-persona`、`secret-vault`、`youtube-upload` 等。
- `skills/` — 运维/运行时技能。API 服务器扫描 `skills/**/SKILL.md` 并提供给仪表盘。包括邮件、短信、通知发送，
  渠道管理，服务与网站监控，文档生成等；`skills/business/` 中放有组织用技能(例如 `press-release`)。

完整列表以仪表盘中的技能目录为最准确。文本形式整理的表格在[技能索引](.agents/context/skills-index.yaml)中。

## 开始使用

### 个人

1. 把 `naia-adk` fork 到自己的账户(尽可能设为私有)。
2. 克隆：`git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. 添加 upstream：`git remote add upstream https://github.com/nextain/naia-adk.git`
4. 创建数据目录：`mkdir -p data-private projects`
5. 添加项目、配置 `.agents/`，然后开始工作。
6. 如果使用 Naia 账户资源，请把 `NAIA_KEY` 设为环境变量。
7. 定期同步：`git fetch upstream && git merge upstream/main`

### 企业

1. 如需访问 `naia-business-adk`，请[联系我们](https://nextain.io/contact)。
2. 把 `naia-business-adk` 以私有方式 fork 到组织账户，然后克隆。
3. 添加 upstream：`git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. 填入公司数据和项目子模块：`mkdir -p data-company projects`、
   `git submodule add <repo> projects/<name>`
5. 每位成员再 fork 组织的 ADK，作为个人工作区使用。

### 与 Naia OS 集成(可选)

如果使用 [Naia OS](https://github.com/nextain/naia-os) 桌面应用，请把工作区路径指定为你自己的 ADK 目录。
技能和数据会通过 API 提供。

## 贡献

issue、PR、讨论可以用你习惯的语言来写，AI 会居中协调沟通。不过 git 记录(提交、上下文、共享产出物)请用英文。
详细流程和规则请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。开发流程默认采用问题驱动开发，详细流程整理在
[AGENTS.md](AGENTS.md)、[工作索引](.agents/context/ai-work-index.yaml)、
[技能索引](.agents/context/skills-index.yaml) 和 [`.agents/workflows/`](.agents/workflows/) 中。

## 路线图

以下是尚未实现的计划，不是目前可用的功能。

- **知识原子(Knowledge atoms)** — 现在的上下文以文件为单位，即使只想找一条信息，也要加载整个文件，浪费
  token。我们正在考虑把它拆分成有意义的最小知识单元，用标签和链接连接起来，只精确取出需要的那一块。目标是
  通过 CLI 或 MCP 访问，使其不绑定于特定工具。

## 许可证

Apache License 2.0。详情请参阅 [LICENSE](LICENSE)。

```
Copyright 2026 Nextain Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

## 链接

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia Dashboard** — [naia.nextain.io](https://naia.nextain.io)

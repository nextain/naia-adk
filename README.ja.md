[English](README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

# Naia ADK

**AI コーディングエージェントが働くワークスペースを、あらかじめ整えておいたスキャフォールド。**

Claude Code や Codex のような AI コーディングツールを使っていると、ツールごとにルールファイルの置き場所が違い、
「この文書は公開してよいのか」「スキルはどこに置くのか」もまちまちです。Naia ADK はその骨組みを
あらかじめ敷いておいたワークスペースです。新しいノートパソコンに開発環境を整えるように、AI エージェントにも
片付いた机を先に用意するわけです。ワークスペースの状態を目で確認できるダッシュボードも同梱しています。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## 5 分で起動する

**Node 22 以上、pnpm 9 以上**が必要です。

```bash
pnpm install    # ワークスペースの依存関係をインストール
pnpm dev        # API サーバー(:3141) とダッシュボード(:3142) を同時に起動
```

ブラウザで `http://localhost:3142` を開くとダッシュボードが表示されます。ここで次の三つをすぐに確認できます。

- **ワークスペース** — プロジェクトとサブモジュール、ファイルツリー、そして各項目の公開レベル。
- **スキルカタログ** — このワークスペースに登録されたスキルの一覧と内容。
- **設定 / モニタリング** — サーバー設定、クライアントの状態、データディレクトリ。

ダッシュボードは、文書画面が使う `/api/portal` リクエストだけを 3141 番ポートの API サーバーへ転送します。
サーバーだけ、またはダッシュボードだけを起動したい場合は、それぞれ `pnpm dev:server`(→ 3141)、
`pnpm dev:dashboard`(→ 3142)を使います。ランチャースクリプト `./start.sh`(Linux/macOS)と
`start.bat`(Windows)も、結局は `pnpm dev` を実行します。サーバー CLI は `--port`、`--host`、`--root`
オプションを受け付けます。たとえば別のワークスペースを指すには `pnpm serve -- --root /path/to/workspace`
のように使います。

## 中身

### ワークスペーススキャフォールド

AI エージェントがすぐに作業できるよう、置き場所の決まったディレクトリ一式を提供します。AI が読む
コンテキストは `.agents/`(英語、JSON/YAML)に置き、人が読む文書は `.users/context/`(韓国語)と
`.users/context/en/`(英語)に置きます。このミラーは全体をそのまま複製したものではなく、人が読むべき
主要な文書を中心にした部分ミラーです(たとえばスキルは `.agents/skills/` 側が正本で、`.users/skills/`
には一部だけがあります)。スキル、データ、プロジェクトにはすべて決まった場所があるので、どのツールで
開いても同じ形に見えます。

### ダッシュボードと API

ワークスペースを目で管理する Next.js ダッシュボードと、それを支える Fastify API サーバーが含まれます。
上部ナビゲーションの **文書**(`/docs`)と **作業** タブで、会社の共有文書と共同作業ボードを一か所で
見られます。また `pnpm adk:setup -- --company <リポジトリURL>` コマンドで、会社の文書とプロジェクト
リポジトリを一度にセットアップできます。詳しい設定と使い方は
[オンボーディングガイド(韓国語)](docs/guides/onboarding.ko.md)を参照してください。
API は、ワークスペースのメタデータ(`/api/workspace`)、スキルカタログ(`/api/skills`)、会社文書
ポータル(`/api/portal`)、そしてファイルの変更をリアルタイムに通知する WebSocket(`/api/ws`)を
提供します。この API のおかげで、ダッシュボードだけでなく他のプログラムもワークスペースにアクセスできます。

### スキルシステム

繰り返しの作業をスキルとしてまとめ、再利用します。各スキルは `SKILL.md` 一つで定義され、API サーバーが
`skills/` 以下を走査してカタログを作ります。このとき、一つでも規格に違反するスキルがあればカタログ全体が
エラーになるよう設計しています(fail-closed)。壊れたスキルを黙って外して残りだけを出す代わりに、
運用者がその場で直すようにしたものです。誤った一覧に気づかないまま提供してしまう事故を防ぐための
選択です。

### いま入っているスキル

スキルは四つの系統に分かれます。どんなスキルがあるかを知るために全体を読み直さなくて済むよう、
`.agents/context/skills-index.yaml` に、何をいつ使うかを一行ずつまとめてあります。
以下はその目次です。

**文書と対外成果物** — 人が読むものを作る仕事です。
`doc-coauthoring`(仕様書・設計文書)、`proposal-writing`(提案書)、`read-doc`、
`translate-doc`、`press-release`、`weekly-report`、`document-generation`(ブランド
PDF と電子署名)、`copyright-reg`(著作権登録書類)、`patent-draft` と
`patent-pipeline`(特許明細書)、`youtube-upload`(動画と字幕の投稿)。

**ワークスペースを回す仕事** — リポジトリそのものを扱う手です。
`project-create`、`project-migration`、`merge-worktree`、`migrate-ctx`、
`session-resume`、`sync-upstream`(アップストリーム同期)、`manage-skills`、
`secret-vault`(暗号化シークレット保管庫)。

**検証ゲート** — 「通った」という言葉の代わりに証拠を求める場所です。
`verify-implementation`、`verify-contract-conformance`、`verify-request-contract`、
`verify-product-preservation`、`verify-benchmark-contract`、`verify-review-gate`、
`verify-build`(実際にビルドできるか)、`verify-conflict-markers`(コンフリクトマーカーが残っていないか)、
`verify-i18n` と `verify-hardcoded-strings`(文字列があるべき場所にあるか)、`webapp-testing`、
そして敵対的レビューを付ける `review-pass`。

**運用と実験** — 外部と接する仕事や、モデルを扱う仕事です。
`manage-discord-sessions`(Discord ゲートウェイの運用)、`channel-management`、
`service-management`(稼働とコスト、障害対応)、`web-monitoring`、`email`、`sms`、
`upstream-pr-review`(オープンソースへ出す前の点検)、`payroll`、
`finetune-persona`(キャラクター LoRA 学習)。

スキルを新しく作るときは `SKILL_TEMPLATE.md` から始め、作った後は索引にも一行を残します。
索引が実際とずれると、次のセッションはあることすら知らないスキルをまた作ってしまいます。

### ルール一式と最小限のガバナンス

一人で使うワークスペースでも、AI と自動化が手を触れた瞬間から最小限のルールが必要です。Naia ADK は
`read`、`write`、`execute`、`publish` を別々の関心事として分け、文書ごとに公開レベルを付けます。
本番環境の変更やシークレットの取り扱い、対外公開のように元に戻しにくい作業は、通常のローカル編集と
分けて承認ゲートを通すようにします。

公開レベルは四段階です。`public` は公開ウェブサイトやオープンソースリポジトリにそのまま出してよいもの、
`controlled` はレビューを経れば外部と共有できるもの、`internal` はワークスペースの中だけで使うもの、
`confidential` は契約書・認証情報・個人情報のように機微なものです。認証情報は通常 git の外に置きますが、
レベルとしては依然として `confidential` です。

> **セッション契約ゲートは marker-free のチェックアウトで有効です。** 契約のないセッションでも、ポリシーに
> 沿ったローカル点検、`npm test`、ビルド、`mkdir`、通常の非破壊的な Git stage/commit のような日常作業は
> 実行できます。ガバナンス・ホストポリシーファイル、共有エントリーポイント、セッション契約・レジストリ権限、
> 削除、破壊的・リモートのコマンド、外部への送信と本番変更には、引き続き契約が必要です。このゲートは
> リポジトリフックによるローカルなガバナンス検査であり、OS のサンドボックスではなく、フックの外で実行される
> コマンドまでは保証しません。詳しいポリシーは `.agents/context/agents-rules.json` と
> `.agents/context/harness.yaml` を参照してください。`.codex/no-harness`、`.claude/no-harness`、
> `.pi/no-harness` がプロジェクトルートまたは祖先ディレクトリにあると、その下のチェックアウトにも復旧モードが
> 継承されます。この候補でセッション契約フックが接続されている範囲は Codex と Claude であり、Pi のセッション
> 契約アダプターを提供するとは主張していません。

### シークレットはどこに置くか

API キーや証明書を git にそのまま上げることはできません。かといって各自のノートパソコンにだけ置けば、
マシンを替えるたびに消え、誰が何を持っているのかも分からなくなります。Naia ADK はその間をこう通ります。
シークレットを入れたフォルダー一つを丸ごとまとめて暗号化した **ファイル一つだけ** を git に上げ、
復号した中身は git からまったく見えないようにします。

具体的には、`key/` フォルダーを tar でまとめ、[age](https://github.com/FiloSottile/age) で暗号化して
`key.age` 一つを作ります。`key/` は `.gitignore` に入っているので、うっかりでも上がりません。
コミットされるのは常に `key.age` 一つだけです。

パスワードは人が直接入力します。AI が代わりに受け取ることも、代わりに入れることもありません。そのため
開ける作業と閉じる作業はユーザーが自分のターミナルで行い、パスワードの要らない点検とバックアップは
AI が代行できます。この境界がスキルの中でコマンド単位に分けられています。

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # 新しいリポジトリに保管庫を作る
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # 開ける(パスワードが必要)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # 再び閉じる(パスワードが必要)
bash .agents/skills/secret-vault/scripts/vault.sh status   # バックアップが最新か点検
bash .agents/skills/secret-vault/scripts/vault.sh sync     # key.age だけをコミットして push
```

`status` があるのは、ミスの形が決まっているからです。キーを追加して閉じ直すのを忘れる、閉じたのに
push を忘れる、一時ファイルが残る、ということが繰り返されます。`status` はその三つを一度に見ます。
「キーは全部バックアップされているか?」という問いには、記憶ではなくこのコマンドで答えます。

`lock` は新しい暗号文を作った後、**もう一度復号してみて** 成功したときだけ既存のファイルを置き換えます。
途中で失敗して保管庫が壊れたまま残るのを防ぐためです。

このパターンは `data-private` のような個人リポジトリを標準の利用先としていますが、`key.age` 一つと
gitignore された `key/` を置くどのリポジトリでもそのまま使えます。名前を変えたい場合は、`VAULT` と
`PLAIN_DIR` 環境変数で上書きします。

### LLM アダプター(naia-anyllm)

LLM に接続する必要がある機能のために、`naia-anyllm` アダプターを内蔵しています。[any-llm](https://github.com/nextain/any-llm)
ゲートウェイを経由するか、OpenAI・Anthropic・Google のようなプロバイダーに直接つなぎます。デフォルトは
Naia アカウントで、[naia.nextain.io](https://naia.nextain.io) で発行したキーを `NAIA_KEY` 環境変数に
入れれば、アカウントのクレジットですぐに使えます。キーがなければ、有料の呼び出しの前にエラーを出します。
プロバイダーやモデルを変えたい場合は
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example) をコピーして使い、
API キーは設定ファイルではなく環境変数か OS のキーストアに置きます。`naia-settings/llm.json` には、
キーの値の代わりに `apiKeyRef: "NAIA_KEY"` だけを記録します。個人フォークで長期のバックアップが必要なら、
`data-private/key/` の age 暗号化保管庫を使います([`.env.example`](.env.example) 参照)。

対応モデルと現在の価格の照会、長い PDF の翻訳には `translate-doc` スキルを使います。モデル・価格の照会は
キーなしで可能で、翻訳は見積もりコストを先に示し、中断した地点から再開できます。

## なぜこう作ったのか

### フォーマットこそが契約

Naia ADK の核心は特定のツールではなく **フォーマット** です。ディレクトリ構成(`.agents/`、`.users/`、
`skills/`、`data-*/`)とファイルスキーマ(`agents-rules.json`、`SKILL.md`)が決められた約束であり、
この約束を読めるツールなら何でも同じワークスペースを利用できます。Claude Code、opencode、Codex、
naia-agent は、互いのコードを組み込まなくても、同じワークスペースをそれぞれ読みます。だからツールを
替えても、複数のツールを混ぜて使っても、ワークスペースはそのまま動きます。

このルールの強制(enforcement)自体もツールに縛られません。ホスト中立のコア(`.agents/hooks/core/`)と
ポリシー(`.agents/hooks/policies/`)が、Claude Code のフックと pi の拡張の両方を同じルールで動かします。

### チームに育つ前の個人用ベース

Naia ADK はあくまで一人用、個人用です。会社の組織図やテナントのルール、委任承認チェーンのようなものは
上位レイヤーの役割です。その代わり、ワークスペースがチームや会社の規模に育つ前に、コンテキストを
どう扱うかの規律をあらかじめ一か所に書いておく場所を提供します。

チームでの協業と共有知識が必要になったら、[Naia Business ADK](https://nextain.io/adk) へ拡張します。
この拡張はベースラインを資産・プロセス・権限のガバナンスへ広げ、チームの所有権と委任承認を加えます。

### フォークの系譜

Naia ADK はフォークして自分のものにすることを前提としています。個人は `naia-adk` を直接フォークできます。
組織は `naia-business-adk` のような別の組織系譜を選び、会社・メンバーのワークスペースを作れます。
すべてのユーザーが一つの固定されたフォークチェーンに従う必要はありません。

```
naia-adk                  ← 公開の個人用ベース (Apache 2.0)
  └── {user}-adk          ← 直接フォークした個人ワークスペース

naia-business-adk         ← 選択可能な組織系譜
  └── {org}-adk            ← 組織フォーク: 会社データ + ビジネスサブモジュール
        └── {member}-adk    ← 組織から派生したメンバーのワークスペース
```

Nextain の内部の系譜は、上の選択肢とは別の運用例です。公開ベースのユーザーは、直接の個人フォークを
維持できます。個人フォークは `{user}-adk` のように自分のアカウント名を入れて呼びます。

プロジェクト・チームのベースラインが必要なら、[naia-pj-adk](https://github.com/nextain/naia-pj-adk) を
別のベースラインとして選べます。PJ は、複数プロジェクトのコンテキストドリフト、呼び出しコスト、Discord
運用の境界を扱うアダプターのベースラインです。個人フォークのカスタマイズと、チーム向けの役割・勤務時間の
ルールは別の問題です。この構造が整理と追跡を助けるのは設計上の目標であり、コスト削減や作業時間の短縮を
測定して保証する主張ではありません。PJ ベースラインは個人フォークの上位リポジトリではありません。
組織での協業が必要なときの `naia-business-adk` は任意です。

## 構成

リポジトリは大きく、ランタイムのコード(`packages/`)、ルールとコンテキスト(`.agents/`、`.users/`)、
スキル(`skills/`、`.agents/skills/`)、そしてフォークごとに埋めるデータディレクトリに分かれます。

| ディレクトリ | 用途 |
|-----------|---------|
| `.agents/` | AI 向けコンテキスト(英語、JSON/YAML)— ルールの唯一の情報源 |
| `.users/context/` | 人が読む文書(韓国語、Markdown) |
| `.users/context/en/` | 人が読む英語ミラー(Markdown) |
| `.claude/` | Claude Code の設定、フック、スキルのシンボリックリンク |
| `skills/` | 運用/ランタイムスキル(ダッシュボード API が提供) |
| `scripts/` | ユーティリティスクリプト |
| `templates/` | 文書テンプレート |
| `docs/` | アーキテクチャ文書、設計仕様 |
| `packages/` | ランタイムパッケージ(pnpm ワークスペース) |

### ランタイムパッケージ(packages/、10 個)

三つは実際に動くプログラムで、残りはフォーマットと規格を定義する薄いパッケージです。

- `core` — ワークスペースとスキルを解析するエンジン。
- `server` — Fastify ベースの REST/WebSocket API。
- `dashboard` — Next.js のダッシュボード UI。
- `skill-spec` — ツール非依存のスキルフォーマット契約(`SkillDescriptor`、`SkillLoader`)。
- `skills-builtin` — 汎用スキルカタログ。
- `openclaw-compat` — OpenClaw のスキルを naia フォーマットへ移すマイグレーションツール。
- `persona` — システムプロンプトの規約仕様。
- `process` — ワークフローパターンの仕様(レビュー → 決定 → 実行、イシュー駆動開発など)。
- `naia-anyllm` — any-llm ゲートウェイ / プロバイダー直結の LLM アダプター。
- `artifacts-spec` — 権限(RBAC)と開発ライフサイクル(SDLC)の成果物の標準スキーマ。15 種類の成果物を
  JSON Schema で定義し、各成果物が git で追跡されるのかセッション限定なのかまで規定します。

### データディレクトリ(gitignore、フォークごとに埋める)

この四つのディレクトリはリポジトリに上がりません。フォークした人が自分のデータを入れます。

| ディレクトリ | 範囲 | 内容 |
|-----------|-------|---------|
| `data-company/` | 会社 | 会社全体の文書、共有リソース |
| `data-teams/` | チーム | チームごとの文書(戦略、会計など) |
| `data-private/` | 個人 | 個人データ、env ファイル、非公開文書 |
| `projects/` | 個人 | プロジェクトリポジトリ(サブモジュール) |

### 二つのスキルツリー

スキルは二か所に分かれていて、利用する主体が異なります。

- `.agents/skills/` — AI 補助とワークフローのスキル。Claude Code が `.claude/skills/` のシンボリック
  リンクを通じて使います。レビュー(`review-pass`)、検証(`verify-implementation`)、ワークツリーの
  マージ(`merge-worktree`)、文書抽出(`read-doc`)、特許・著作権・給与のような業務スキル、そして
  `finetune-persona`、`secret-vault`、`youtube-upload` などが入っています。
- `skills/` — 運用/ランタイムスキル。API サーバーが `skills/**/SKILL.md` を走査してダッシュボードに
  提供します。メール・SMS・通知の送信、チャネル管理、サービス・ウェブのモニタリング、文書生成のような
  ものがあり、`skills/business/` には組織向けのスキル(例: `press-release`)が入っています。

全体の一覧は、ダッシュボードのスキルカタログで確認するのが最も正確です。テキストでまとめた表は
[スキル索引](.agents/context/skills-index.yaml)にあります。

## はじめに

### 個人向け

1. `naia-adk` を自分のアカウントにフォークします(できれば非公開で)。
2. クローンします: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. upstream を追加します: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. データディレクトリを作ります: `mkdir -p data-private projects`
5. プロジェクトを追加し、`.agents/` を設定してから作業を始めます。
6. Naia アカウントのリソースを使う場合は、`NAIA_KEY` を環境変数に設定します。
7. 定期的に同期します: `git fetch upstream && git merge upstream/main`

### 企業向け

1. `naia-business-adk` へのアクセスについて[お問い合わせ](https://nextain.io/contact)ください。
2. `naia-business-adk` を組織アカウントに非公開でフォークし、クローンします。
3. upstream を追加します: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. 会社のデータとプロジェクトのサブモジュールを埋めます: `mkdir -p data-company projects`、
   `git submodule add <repo> projects/<name>`
5. 各メンバーは組織の ADK をさらにフォークし、個人のワークスペースとして使います。

### Naia OS との連携(任意)

[Naia OS](https://github.com/nextain/naia-os) デスクトップアプリを使っている場合は、ワークスペースの
パスを自分の ADK ディレクトリに指定してください。スキルとデータが API で提供されます。

## コントリビューション

イシュー、PR、ディスカッションは、使いやすい言語で書いてかまいません。AI がやり取りを仲介します。
ただし git の記録(コミット、コンテキスト、共有成果物)は英語で残します。詳しい手順とルールは
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。開発プロセスはイシュー駆動開発を基本とし、
詳しい流れは [AGENTS.md](AGENTS.md)、[業務索引](.agents/context/ai-work-index.yaml)、
[スキル索引](.agents/context/skills-index.yaml)、[`.agents/workflows/`](.agents/workflows/) に
まとめてあります。

## ロードマップ

以下はまだ実装されていない計画で、現在動作する機能ではありません。

- **知識アトム(Knowledge atoms)** — いまのコンテキストはファイル単位なので、情報の一片を探すにも
  ファイル全体を読み込んでトークンを浪費します。これを意味を持つ最小の知識単位に分け、タグとリンクで
  つなぎ、必要な一片だけを正確に取り出して使う方向を検討しています。CLI や MCP でアクセスし、
  ツールに縛られないようにすることが目標です。

## ライセンス

Apache License 2.0。詳しくは [LICENSE](LICENSE) を参照してください。

```
Copyright 2026 Nextain Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

## リンク

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia Dashboard** — [naia.nextain.io](https://naia.nextain.io)

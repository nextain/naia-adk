[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [Español](README.es.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md) | **Português** | [Bahasa Indonesia](README.id.md) | [Tiếng Việt](README.vi.md)

# Naia ADK

**Um andaime de espaço de trabalho pré-organizado para agentes de codificação de IA trabalharem.**

Quando você usa ferramentas de codificação com IA como Claude Code ou Codex, cada
ferramenta guarda seus arquivos de regras em um lugar diferente, e perguntas como
«este documento pode ser publicado?» ou «para onde vão os skills?» recebem
respostas improvisadas. O Naia ADK monta essa estrutura de antemão. Assim como se
prepara o ambiente de desenvolvimento num notebook novo, ele entrega ao agente de
IA uma mesa arrumada para começar. E inclui um painel para ver o estado do espaço
de trabalho de relance.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Funcionando em 5 minutos

Você precisa de **Node 22+** e **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Abra `http://localhost:3142` no navegador para ver o painel. Três coisas ficam
visíveis de imediato:

- **Workspace** — projetos e submódulos, a árvore de arquivos e o nível de
  divulgação de cada item.
- **Skills catalog** — a lista de skills registrados neste espaço de trabalho e
  seu conteúdo.
- **Settings / monitoring** — configuração do servidor, estado dos clientes,
  diretórios de dados.

O painel só encaminha ao servidor API na porta 3141 as requisições `/api/portal`
da visão de documentos. Para rodar só um deles, use `pnpm dev:server` (→ 3141) ou
`pnpm dev:dashboard` (→ 3142). Os scripts de inicialização `./start.sh`
(Linux/macOS) e `start.bat` (Windows) executam ambos `pnpm dev`. O CLI do servidor
aceita `--port`, `--host` e `--root`; por exemplo, aponte para outro espaço de
trabalho com `pnpm serve -- --root /path/to/workspace`.

## O que há dentro

### O andaime do espaço de trabalho

Ele dá ao agente de IA um conjunto de diretórios com lugares fixos para tudo,
para que ele possa começar a trabalhar imediatamente. O contexto voltado à IA vive
em `.agents/` (inglês, JSON/YAML). Os guias legíveis por pessoas vivem em
`.users/context/` (coreano) e `.users/context/en/` (inglês). Esse espelho é
parcial, não uma cópia completa — contém só os documentos que uma pessoa precisa
ler (por exemplo, os skills são canônicos sob `.agents/skills/`, e só alguns são
refletidos em `.users/skills/`). Skills, dados e projetos têm lugares designados,
então o espaço de trabalho parece o mesmo não importa qual ferramenta o abra.

### Painel e API

Um painel Next.js gerencia o espaço de trabalho visualmente, sustentado por um
servidor API Fastify. As abas **Docs** (`/docs`) e **Work** na navegação superior
mostram os documentos compartilhados da empresa e o quadro de colaboração num só
lugar, e `pnpm adk:setup -- --company <repo-url>` configura os repositórios de
documentos da empresa e de projetos numa etapa. Para detalhes de configuração e
uso, veja o
[guia de integração](docs/guides/onboarding.en.md)
([한국어](docs/guides/onboarding.ko.md)).
Veja o [guia de redação da documentação de desenvolvimento](docs/guides/dev-docs-writing.en.md)
para documentar arquitetura, contratos e evidências de implementação.
A API expõe os metadados do espaço de trabalho (`/api/workspace`), o catálogo de
skills (`/api/skills`), o portal de documentos da empresa (`/api/portal`) e um
WebSocket que transmite eventos de mudança de arquivos (`/api/ws`). Graças a essa
API, outros programas além do painel também alcançam o espaço de trabalho.

### Sistema de skills

Tarefas repetidas são agrupadas em skills reutilizáveis. Cada skill é definido por
um único `SKILL.md`, e o servidor API varre `skills/` para montar o catálogo. Se
um único skill violar o formato, o catálogo inteiro levanta um erro (falha
fechada): em vez de descartar silenciosamente o skill quebrado e servir o resto, o
operador é obrigado a corrigi-lo na hora. É uma escolha deliberada para não
distribuir por acidente um catálogo incompleto.

### O que há hoje na árvore de skills

Os skills se dividem em quatro grupos. Para que uma sessão não precise reler cada
`SKILL.md` para saber o que existe, `.agents/context/skills-index.yaml` carrega
uma linha por skill dizendo o que ele faz e quando usá-lo. A lista abaixo é o
sumário desse índice.

**Documentos e trabalho para fora** — coisas que uma pessoa vai ler.
`doc-coauthoring` (especificações e documentos de design), `proposal-writing`,
`read-doc`, `translate-doc`, `press-release`, `weekly-report`,
`document-generation` (PDFs com a marca e assinaturas digitais), `copyright-reg`
(registros de direitos autorais), `patent-draft` e `patent-pipeline` (patentes),
`youtube-upload` (vídeos e legendas).

**Operando o espaço de trabalho** — as mãos que tocam o próprio repositório.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream` (sincronização com o upstream), `manage-skills` e
`secret-vault` para o cofre cifrado de segredos.

**Portas de verificação** — os lugares que pedem evidência em vez de afirmação.
`verify-implementation`, `verify-contract-conformance`, `verify-request-contract`,
`verify-product-preservation`, `verify-benchmark-contract`, `verify-review-gate`,
`verify-build` (se compila de verdade), `verify-conflict-markers` (se restaram
marcadores de conflito), `verify-i18n` e `verify-hardcoded-strings` (se as strings
estão no lugar), `webapp-testing` e `review-pass` para revisão adversária.

**Operações e experimentos** — trabalho que sai para fora ou toca modelos.
`manage-discord-sessions` para o gateway do Discord, `channel-management`,
`service-management` (disponibilidade, custos, incidentes), `web-monitoring`,
`email`, `sms`, `upstream-pr-review` (uma comporta antes de tudo que vai para um
mantenedor OSS), `payroll` e `finetune-persona` para treino LoRA de personagens.

Comece um skill novo a partir de `.agents/skills/SKILL_TEMPLATE.md` e some sua
linha ao índice quando ele existir. Quando o índice se desviar da árvore, a sessão
seguinte reconstrói um skill que ela já tinha.

### Regras e governança mínima

Mesmo um espaço de trabalho de uso individual precisa de algumas regras mínimas
assim que a IA e a automação o tocam. O Naia ADK separa `read`, `write`,
`execute` e `publish` como preocupações distintas, e prende a cada documento um
nível de divulgação. Ações difíceis de desfazer — mudanças de produção,
manuseio de segredos, afirmações públicas — são separadas das edições locais
ordinárias e encaminhadas a portas de aprovação.

A divulgação tem quatro níveis. `public` é seguro para publicar como está num site
público ou repositório open source; `controlled` pode ser compartilhado fora após
revisão; `internal` fica dentro do espaço de trabalho; `confidential` cobre
material sensível como contratos, credenciais e dados pessoais. Credenciais
costumam viver fora do git, mas por nível continuam `confidential`.

> **A porta do contrato de sessão está ativa num checkout sem marcadores.** Uma
> sessão não vinculada pode fazer trabalho local rotineiro permitido pela política
> como inspeção, `npm test`, builds, `mkdir` e stage/commit Git ordinário não
> destrutivo. Arquivos de governança e política de host, pontos de entrada
> compartilhados, contratos de sessão e autoridade do registro, exclusão, comandos
> destrutivos ou remotos, efeitos externos e mudanças de produção continuam
> exigindo contrato. É uma checagem de governança dos hooks do repositório; não é
> um sandbox do sistema operacional nem garante comandos lançados fora dos hooks.
> Veja `.agents/context/agents-rules.json` e `.agents/context/harness.yaml` para
> a política. Um marcador `.codex/no-harness`, `.claude/no-harness` ou
> `.pi/no-harness` na raiz do projeto ou num ancestral é herdado pelos checkouts
> descendentes. Este candidato conecta o hook do contrato de sessão ao Codex e ao
> Claude; não afirma um adaptador Pi do contrato de sessão.

### Onde vivem os segredos

Não dá para subir chaves de API e certificados ao git. Mas guardá-los só em cada
notebook significa que somem quando a máquina troca, e ninguém sabe dizer quem tem
o quê. O Naia ADK corta esse nó subindo **um único arquivo**: a pasta de
segredos, arquivada e cifrada. O conteúdo decifrado o git jamais vê.

Em concreto, a pasta `key/` é empacotada com tar e cifrada com
[age](https://github.com/FiloSottile/age) num único `key.age`. `key/` está no
`.gitignore`, então não pode ser subida por acidente. A única coisa que um dia
chega a um commit é `key.age`.

Uma pessoa digita a frase secreta. A IA nem a recebe nem a digita por ninguém.
Abrir e selar o cofre acontece portanto no próprio terminal do usuário, enquanto
as checagens e o backup — que não precisam da frase — podem ser delegados. Essa
fronteira é traçada comando a comando dentro do skill.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` existe porque os erros têm forma fixa. Você adiciona uma chave e esquece
de selar, ou sela e esquece de subir, ou um arquivo temporário fica para trás.
`status` procura as três coisas de uma vez. Quando perguntarem se as chaves têm
backup, responda com esse comando em vez de responder de memória.

`lock` escreve o novo cifrado, **decifra de novo para conferir** e só então
substitui o arquivo antigo — assim uma selagem pela metade nunca deixa um cofre
quebrado.

O consumidor padrão desse padrão é um repositório privado como `data-private`,
mas qualquer repositório com `key.age` e `key/` ignorado pelo git pode usá-lo.
Redefina `VAULT` e `PLAIN_DIR` para renomear qualquer um dos lados.

### Adaptador LLM (naia-anyllm)

Para as funções que precisam alcançar um LLM, o adaptador `naia-anyllm` vem
embutido. Ele se conecta pelo gateway [any-llm](https://github.com/nextain/any-llm),
ou direto a provedores como OpenAI, Anthropic e Google. O padrão é uma conta Naia:
ponha uma chave emitida em [naia.nextain.io](https://naia.nextain.io) na variável
de ambiente `NAIA_KEY` e você já usa seus créditos da conta. Sem chave, ele
levanta um erro antes de qualquer chamada paga. Para trocar de provedor ou modelo,
copie
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example),
e guarde as chaves de API em variáveis de ambiente ou no chaveiro do sistema
operacional, nunca no arquivo de configuração. `naia-settings/llm.json` registra
só `apiKeyRef: "NAIA_KEY"`, nunca o valor. Se um fork pessoal precisar de backup
de longo prazo, use o cofre cifrado com age em `data-private/key/` (ver
[`.env.example`](.env.example)).

Para listar os modelos suportados e seus preços atuais, e para traduzir PDFs
longos, use o skill `translate-doc`. Consultas de modelos e preços funcionam sem
chave; a tradução mostra primeiro o custo estimado e pode continuar de onde
parou.

## Por que é construído assim

### O formato é o contrato

O coração do Naia ADK não é uma ferramenta específica, mas um **formato**. O
layout de diretórios (`.agents/`, `.users/`, `skills/`, `data-*/`) e os esquemas
de arquivos (`agents-rules.json`, `SKILL.md`) são um acordo fixo, e qualquer
ferramenta capaz de ler esse acordo pode consumir o mesmo espaço de trabalho.
Claude Code, Codex, opencode, naia-agent, agy e muse leem cada um o mesmo espaço
sem embutir o código uns dos outros. Assim você pode trocar de ferramenta ou
misturar várias, e o espaço continua funcionando.

A aplicação das regras também é agnóstica à ferramenta. Um núcleo neutro de host
(`.agents/hooks/core/`) e políticas (`.agents/hooks/policies/`) movem tanto os
hooks do Claude Code quanto a extensão pi com as mesmas regras.

### Uma base pessoal antes de crescer em equipe

O Naia ADK é estritamente unipessoal, para uso pessoal. Organogramas de empresa,
regras de tenants e cadeias de aprovação delegada pertencem a uma camada
superior. O que ele lhe dá é um único lugar para escrever a disciplina de
contexto antes de o espaço crescer à escala de equipe ou empresa.

Para colaboração em equipe e conhecimento compartilhado, você pode escolher a
linhagem organizacional opcional representada pelo
[Naia Business ADK](https://nextain.io/adk). Ela soma governança de ativos,
processos e permissões, titularidade da equipe e aprovações delegadas.

### Linhagens de forks

O Naia ADK foi feito para sofrer fork para o seu próprio espaço de trabalho.
Pessoas podem forkar `naia-adk` diretamente. Uma organização pode escolher uma
linhagem organizacional separada como `naia-business-adk` para os espaços da
empresa e dos membros. Nenhuma cadeia fixa única é exigida de nenhum usuário.

```
naia-adk                  ← public personal base (Apache 2.0)
  └── {user}-adk          ← direct personal fork

naia-business-adk         ← optional organization lineage
  └── {org}-adk            ← org fork: company data + business submodules
        └── {member}-adk    ← member workspace derived from the organization
```

A linhagem interna da Nextain é um exemplo operacional à parte. Um usuário público
pode manter um fork pessoal direto e chamá-lo `{user}-adk` com o nome da conta.

Se você precisar de uma base de projeto/equipe, pode escolher
[naia-pj-adk](https://github.com/nextain/naia-pj-adk) como base separada. PJ é
uma base adaptadora para deriva de contexto multiprojeito, custo de chamadas e
fronteiras de operação do Discord. Personalização do fork pessoal e regras de
papéis/horários da equipe são preocupações separadas. Ajudar a organizar e
rastrear esse trabalho é um objetivo de desenho desta estrutura, não uma garantia
medida de economia de custos ou prazos mais curtos. A base PJ não é o repositório
pai de um fork pessoal. `naia-business-adk`, para quando você precisar de
colaboração organizacional, é opcional.

## Estrutura

O repositório se divide em código de runtime (`packages/`), regras e contexto
(`.agents/`, `.users/`), skills (`skills/`, `.agents/skills/`) e os diretórios
de dados que cada fork preenche.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | Contexto voltado à IA (inglês, JSON/YAML) — fonte única da verdade para regras |
| `.users/context/` | Guias legíveis por pessoas (coreano, Markdown) |
| `.users/context/en/` | Espelho legível em inglês (Markdown) |
| `.claude/` | Config do Claude Code, hooks, symlinks de skills |
| `skills/` | Skills operacionais/de runtime (servidos pela API do painel) |
| `scripts/` | Scripts utilitários |
| `templates/` | Modelos de documentos |
| `docs/` | Documentos de arquitetura, especificações de design |
| `packages/` | Pacotes de runtime (espaço pnpm) |
| `config/` | Perfis de exemplo de trabalhadores e config de deploy |

### Pacotes de runtime (packages/, 12 no total)

Três são programas reais em execução; o resto são pacotes leves que definem
formatos e especificações.

- `core` — o motor que analisa o espaço de trabalho e os skills.
- `server` — a API REST/WebSocket Fastify.
- `dashboard` — a UI Next.js do painel.
- `skill-spec` — o contrato de formato de skill agnóstico a ferramentas
  (`SkillDescriptor`, `SkillLoader`).
- `skills-builtin` — o catálogo genérico de skills.
- `openclaw-compat` — uma ferramenta que migra skills OpenClaw para o formato naia.
- `persona` — a especificação de convenção do prompt do sistema.
- `process` — a especificação de padrões de fluxo (revisão → decisão → execução,
  desenvolvimento dirigido por issues etc.).
- `naia-anyllm` — o adaptador LLM via gateway any-llm / provedores diretos.
- `artifacts-spec` — o esquema padrão para artefatos de permissão (RBAC) e de
  ciclo de vida de desenvolvimento (SDLC). Define 15 tipos de artefatos como JSON
  Schema e precisa, para cada um, se a instância tem acompanhamento no git ou é
  limitada à sessão.
- `ax-messenger` — o pacote de retransmissão/administração do messenger Matrix
  (retransmissão IA, registro e provedores sobre `matrix-js-sdk`).
- `benchmark-contract` — contratos permanentes de benchmark e evidência de
  governança compartilhados por `naia-adk` e `naia-agent`.

### Níveis de trabalhadores e substituições de revisores

Papéis e modelos são configurados separadamente — nenhuma versão de modelo está
gravada na arquitetura.

- `config/tier-profile.example.json` (`tier-profile/v1`) é um perfil de
  trabalhador 4-níveis agnóstico a modelo. Os níveis descrevem *papéis*
  (checagens leves, design e implementação, sessões de papel, revisão
  independente); os candidatos de cada nível ligam CLI e modelo separadamente,
  então trocar de modelo nunca muda a estrutura de papéis.
- As substituições de revisores das portas de aprovação vivem no
  `.claude/deploy/config.json` da instância como `review_models` (id do revisor →
  modelo exato, esforço mínimo, runner). Só se aplicam após aprovação `CFG-`; sem
  config aprovada valem os defaults do código. Os runners incluem `agy`, `muse`,
  `codex` e `claude`. Veja o
  [guia da porta do plano de aprovação](docs/guides/approval-plan-gate.en.md).
- `naia-settings/review.json` guarda o painel de revisão entre repositórios e a
  política de níveis de modelos consumidos pelo skill `review-pass` e `naia-agent`.

### Diretórios de dados (gitignored, preenchidos por fork)

Esses quatro nunca sobem. Quem forka o repositório preenche seus próprios dados.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Documentos de toda a empresa, recursos compartilhados |
| `data-teams/` | Team | Documentos de equipe (estratégia, contabilidade etc.) |
| `data-private/` | Personal | Dados pessoais, arquivos env, documentos privados |
| `projects/` | Personal | Repositórios de projetos (submódulos) |

### Duas árvores de skills

Os skills vivem em dois lugares, consumidos por partes diferentes.

- `.agents/skills/` — skills de assistência IA e fluxos. O Claude Code os usa via
  symlink `.claude/skills/`. Inclui revisão (`review-pass`), verificação
  (`verify-implementation`), fusão de worktree (`merge-worktree`), extração de
  documentos (`read-doc`), skills de negócio como patente/direitos/folha e outros
  como `finetune-persona`, `secret-vault` e `youtube-upload`.
- `skills/` — skills operacionais/de runtime. O servidor API varre
  `skills/**/SKILL.md` e os serve ao painel. Incluem envio de
  email/SMS/notificações, gestão de canais, supervisão de serviços e web e
  geração de documentos; `skills/business/` contém skills de organização como
  `press-release`.

A lista mais exata é o catálogo de skills no painel. Há uma tabela de texto no
[índice de skills](.agents/context/skills-index.yaml).

## Começando

### Pessoal

1. Forke `naia-adk` para sua conta (privado se puder).
2. Clone: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Some o upstream: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Crie os diretórios de dados: `mkdir -p data-private projects`
5. Some projetos, configure `.agents/` e comece a trabalhar.
6. Se usar recursos de conta Naia, defina `NAIA_KEY` como variável de ambiente.
7. Sincronize periodicamente: `git fetch upstream && git merge upstream/main`

### Empresa

1. [Fale conosco](https://nextain.io/contact) para acesso a `naia-business-adk`.
2. Forke `naia-business-adk` em privado na conta da organização e clone depois.
3. Some o upstream: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Preencha os dados da empresa e os submódulos de projetos:
   `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Cada membro forka de novo o ADK da organização como espaço pessoal.

### Integração com Naia Shell (opcional)

Se você usa o app desktop & web [Naia Shell](https://github.com/nextain/naia-shell),
aponte seu caminho de espaço de trabalho para seu diretório ADK. Skills e dados
são servidos pela API.

## Contribuindo

Escreva issues, PRs e discussões no idioma em que você fica à vontade; a IA faz
a mediação da comunicação. Só mantenha o registro git (commits, contexto,
artefatos compartilhados) em inglês. Para o processo completo e as regras, veja
[CONTRIBUTING.md](CONTRIBUTING.md). O desenvolvimento é por padrão dirigido por
issues; o fluxo detalhado vive em [AGENTS.md](AGENTS.md), no
[índice de trabalho](.agents/context/ai-work-index.yaml), no
[índice de skills](.agents/context/skills-index.yaml) e em
[`.agents/workflows/`](.agents/workflows/).

## Roteiro

O seguinte está planejado, não é um recurso que opere hoje.

- **Knowledge atoms** — o contexto atual é baseado em arquivos, então achar uma
  informação significa carregar o arquivo inteiro e desperdiçar tokens. A ideia é
  quebrar o contexto nas menores unidades com sentido, ligá-las com tags e puxar
  só o trecho exato de que se precisa. O acesso iria por CLI ou MCP para seguir
  agnóstico às ferramentas.

## Licença e aviso de patentes

- **Código (`Apache-2.0`):** sob a [licença Apache 2.0 (`Apache-2.0`)](LICENSE).
  Livre para usar, modificar e distribuir — inclusive para fins comerciais,
  serviços hospedados ou gerenciados pagos (SaaS) e organizações de qualquer
  tamanho. A seção 3 da licença Apache 2.0 inclui uma licença de patente para o
  código contido neste repositório.
- **Patentes:** [`PATENTS.md`](PATENTS.md) explica a divisão de limites de
  reivindicações, lista os pedidos de patente da Nextain e concede um compromisso
  de patente condicional adicional (além do escopo já licenciado sob a seção 3 da
  licença Apache 2.0) para indivíduos, sem fins lucrativos e desenvolvedores
  conformes do ecossistema Naia. Esse compromisso adicional não cobre a prática de
  uma patente listada por meio de método ou módulo não contido neste repositório
  em serviços hospedados pagos para terceiros, produtos fechados/OEM ou
  implantações corporativas que alcancem ou superem os limiares de receita ou
  assentos da seção 2 de [`PATENTS.md`](PATENTS.md); ver seções 2 e 3 de
  [`PATENTS.md`](PATENTS.md).
- **Comercial:** [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) cobre os módulos
  proprietários Nextain Tier-2 e os pipelines cloud não publicados neste
  repositório, as licenças comerciais de patentes para métodos não contidos aqui,
  e o suporte empresarial e a indenização.
- **Contribuir:** ver [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull requests são
  aceitos sob [`CLA.md`](CLA.md) (ou [`CLA-CORPORATE.md`](CLA-CORPORATE.md) para
  contribuições corporativas).

## Ecossistema Naia

- **naia-shell** — [github.com/nextain/naia-shell](https://github.com/nextain/naia-shell) (cliente shell desktop & web)
- **naia-agent** — [github.com/nextain/naia-agent](https://github.com/nextain/naia-agent) (runtime de agentes e orquestração de ferramentas)
- **naia-memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory) (memória persistente de agentes)
- **naia-kb-compiler** — [github.com/nextain/naia-kb-compiler](https://github.com/nextain/naia-kb-compiler) (compilador de bases de conhecimento para contexto estruturado)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia** — [naia.nextain.io](https://naia.nextain.io)

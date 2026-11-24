[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | **Français** | [Deutsch](README.de.md) | [Русский](README.ru.md) | [Español](README.es.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md) | [Português](README.pt.md) | [Bahasa Indonesia](README.id.md) | [Tiếng Việt](README.vi.md)

# Naia ADK

**Une base d'espace de travail pré-organisée pour que les agents de codage IA travaillent.**

Quand vous utilisez des outils de codage IA comme Claude Code ou Codex, chaque outil
range ses fichiers de règles à un endroit différent, et des questions comme « ce
document peut-il être publié ? » ou « où vont les skills ? » reçoivent des réponses
improvisées. Naia ADK pose ce squelette à l'avance. Comme on prépare un
environnement de développement sur un ordinateur portable neuf, il remet à l'agent
IA un bureau bien rangé pour commencer. Il fournit aussi un tableau de bord pour
voir l'état de l'espace de travail en un coup d'œil.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## En route en 5 minutes

Il faut **Node 22+** et **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Ouvrez `http://localhost:3142` dans votre navigateur pour voir le tableau de bord.
Trois choses sont visibles tout de suite :

- **Workspace** — les projets et sous-modules, l'arborescence des fichiers et le
  niveau de divulgation de chaque élément.
- **Skills catalog** — la liste des skills enregistrés dans cet espace de travail,
  et leur contenu.
- **Settings / monitoring** — la configuration du serveur, l'état des clients, les
  répertoires de données.

Le tableau de bord ne transmet vers le serveur API sur le port 3141 que les requêtes
`/api/portal` de la vue docs. Pour n'en lancer qu'un seul, utilisez
`pnpm dev:server` (→ 3141) ou `pnpm dev:dashboard` (→ 3142). Les scripts de
lancement `./start.sh` (Linux/macOS) et `start.bat` (Windows) exécutent tous deux
`pnpm dev`. Le serveur CLI accepte `--port`, `--host` et `--root` ; par exemple,
pointez-le vers un autre espace de travail avec
`pnpm serve -- --root /path/to/workspace`.

## Ce qu'il y a dedans

### Le squelette de l'espace de travail

Il donne à un agent IA un ensemble de répertoires avec des emplacements fixes pour
tout, afin qu'il puisse commencer à travailler immédiatement. Le contexte destiné à
l'IA vit dans `.agents/` (anglais, JSON/YAML). Les guides lisibles par les humains
vivent dans `.users/context/` (coréen) et `.users/context/en/` (anglais).
Ce miroir est partiel, pas une copie complète — il ne contient que les documents
qu'une personne a besoin de lire (par exemple, les skills sont canoniques sous
`.agents/skills/`, et seuls certains sont reflétés dans `.users/skills/`). Les
skills, les données et les projets ont tous des emplacements désignés, si bien que
l'espace de travail se ressemble quel que soit l'outil qui l'ouvre.

### Tableau de bord et API

Un tableau de bord Next.js gère visuellement l'espace de travail, adossé à un
serveur API Fastify. Les onglets **Docs** (`/docs`) et **Work** dans la navigation
du haut montrent les documents partagés de l'entreprise et le tableau de
collaboration au même endroit, et
`pnpm adk:setup -- --company <repo-url>` met en place les dépôts de documents
d'entreprise et de projets en une seule étape. Pour la configuration et les détails
d'utilisation, voir le
[guide d'intégration](docs/guides/onboarding.en.md)
([한국어](docs/guides/onboarding.ko.md)).
Voir le [guide de rédaction de la documentation de développement](docs/guides/dev-docs-writing.en.md)
pour documenter l'architecture, les contrats et les preuves d'implémentation.
L'API expose les métadonnées de l'espace de travail (`/api/workspace`), le
catalogue de skills (`/api/skills`), le portail des documents d'entreprise
(`/api/portal`), et un WebSocket qui diffuse les événements de changement de
fichiers (`/api/ws`). Grâce à cette API, d'autres programmes que le tableau de bord
peuvent aussi joindre l'espace de travail.

### Système de skills

Les tâches répétées sont regroupées en skills réutilisables. Chaque skill est défini
par un seul `SKILL.md`, et le serveur API parcourt `skills/` pour construire le
catalogue. Si un seul skill viole le format, tout le catalogue lève une erreur
(fermeture stricte) : plutôt que de servir le reste en abandonnant silencieusement
le skill cassé, l'opérateur est amené à le corriger sur-le-champ. C'est un choix
délibéré pour éviter de livrer un catalogue incomplet par accident.

### Ce que contient l'arbre des skills aujourd'hui

Les skills se répartissent en quatre groupes. Pour qu'une session n'ait pas à
relire chaque `SKILL.md` pour savoir ce qui existe, `.agents/context/skills-index.yaml`
porte une ligne par skill disant ce qu'il fait et quand l'utiliser. La liste
ci-dessous est la table des matières de cet index.

**Documents et travail tourné vers l'extérieur** — ce qu'une personne lira.
`doc-coauthoring` (spécifications et documents de conception), `proposal-writing`,
`read-doc`, `translate-doc`, `press-release`, `weekly-report`,
`document-generation` (PDF aux couleurs de la marque et signatures numériques),
`copyright-reg` (dépôts de droits d'auteur), `patent-draft` et `patent-pipeline`
(brevets), `youtube-upload` (vidéos et sous-titres).

**Faire tourner l'espace de travail** — les mains qui touchent le dépôt lui-même.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream` (synchronisation amont), `manage-skills`, et
`secret-vault` pour le coffre-fort chiffré des secrets.

**Portes de vérification** — les endroits qui demandent des preuves au lieu d'une
affirmation. `verify-implementation`, `verify-contract-conformance`,
`verify-request-contract`, `verify-product-preservation`, `verify-benchmark-contract`,
`verify-review-gate`, `verify-build` (est-ce que ça compile vraiment),
`verify-conflict-markers` (reste-t-il des marqueurs de conflit), `verify-i18n` et
`verify-hardcoded-strings` (les chaînes sont-elles à leur place), `webapp-testing`,
et `review-pass` pour la revue adverse.

**Opérations et expériences** — le travail qui sort vers l'extérieur ou touche aux
modèles. `manage-discord-sessions` pour la passerelle Discord,
`channel-management`, `service-management` (disponibilité, coûts, incidents),
`web-monitoring`, `email`, `sms`, `upstream-pr-review` (un sas avant tout ce qui va
vers un mainteneur OSS), `payroll`, et `finetune-persona` pour l'entraînement LoRA
de personnages.

Démarrez un nouveau skill depuis `.agents/skills/SKILL_TEMPLATE.md`, et ajoutez sa
ligne à l'index une fois qu'il existe. Quand l'index dérive de l'arbre, la session
suivante reconstruit un skill qu'elle avait déjà.

### Règles et gouvernance minimale

Même un espace de travail utilisé seul a besoin de quelques règles minimales dès
que l'IA et l'automatisation y touchent. Naia ADK sépare `read`, `write`,
`execute` et `publish` comme des préoccupations distinctes, et attache un niveau de
divulgation à chaque document. Les actions difficiles à annuler — changements de
production, manipulation de secrets, affirmations publiques — sont séparées des
modifications locales ordinaires et routées vers des portes d'approbation.

La divulgation a quatre niveaux. `public` peut être publié tel quel vers un site
public ou un dépôt open source ; `controlled` peut être partagé à l'extérieur après
revue ; `internal` reste dans l'espace de travail ; `confidential` couvre les
matériaux sensibles comme les contrats, les identifiants et les données
personnelles. Les identifiants vivent habituellement hors de git, mais par niveau
ils restent `confidential`.

> **Le garde-fou du contrat de session est actif dans un checkout sans marqueur.**
> Une session non liée peut effectuer un travail local de routine conforme à la
> politique comme l'inspection, `npm test`, les builds, `mkdir`, et le stage/commit
> Git ordinaire non destructif. Les fichiers de gouvernance et de politique d'hôte,
> les points d'entrée partagés, les contrats de session et l'autorité de registre,
> la suppression, les commandes destructrices ou distantes, les effets sortants et
> les changements de production exigent toujours un contrat. C'est un contrôle de
> gouvernance des hooks du dépôt ; ce n'est pas un bac à sable du système
> d'exploitation et il ne garantit pas les commandes lancées hors des hooks. Voir
> `.agents/context/agents-rules.json` et `.agents/context/harness.yaml` pour la
> politique. Un marqueur `.codex/no-harness`, `.claude/no-harness` ou
> `.pi/no-harness` à la racine du projet ou chez un ancêtre est hérité par les
> checkouts descendants. Ce candidat connecte le hook de contrat de session à Codex
> et Claude ; il ne prétend pas à un adaptateur Pi de contrat de session.

### Où vivent les secrets

On ne peut pas commiter les clés API et les certificats dans git. Mais les garder
seulement sur chaque ordinateur portable veut dire qu'ils disparaissent quand la
machine change, et personne ne peut dire qui détient quoi. Naia ADK tranche ce nœud
en ne commitant **qu'un seul fichier** : le dossier des secrets, archivé et
chiffré. Le contenu déchiffré n'est jamais vu par git du tout.

Concrètement, le dossier `key/` est archivé (tar) et chiffré avec
[age](https://github.com/FiloSottile/age) en un seul `key.age`. `key/` est dans
`.gitignore`, donc il ne peut pas être commité par accident. La seule chose qui
atterrit un jour dans un commit, c'est `key.age`.

Une personne tape la phrase secrète. L'IA ne la reçoit ni ne la tape à la place de
personne. Ouvrir et sceller le coffre se font donc dans le terminal de
l'utilisateur, tandis que les vérifications et la sauvegarde — qui n'ont pas besoin
de la phrase secrète — peuvent être déléguées. Cette frontière est tracée commande
par commande à l'intérieur du skill.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` existe parce que les erreurs ont une forme fixe. On ajoute une clé et on
oublie de sceller, ou on scelle et on oublie de pousser, ou un fichier temporaire
est laissé derrière. `status` cherche les trois à la fois. Quand quelqu'un demande
si les clés sont sauvegardées, répondez avec cette commande plutôt que de mémoire.

`lock` écrit le nouveau chiffré, **le déchiffre à nouveau pour vérifier**, et
alors seulement remplace l'ancien fichier — ainsi un scellage à moitié fini ne
laisse jamais un coffre cassé.

Le consommateur standard de ce motif est un dépôt privé comme `data-private`,
mais tout dépôt avec un `key.age` et un `key/` ignoré par git peut l'utiliser.
Redéfinissez `VAULT` et `PLAIN_DIR` pour renommer l'un ou l'autre côté.

### Adaptateur LLM (naia-anyllm)

Pour les fonctionnalités qui doivent joindre un LLM, l'adaptateur `naia-anyllm`
est intégré. Il se connecte via la passerelle [any-llm](https://github.com/nextain/any-llm),
ou directement à des fournisseurs comme OpenAI, Anthropic et Google. Par défaut
c'est un compte Naia : mettez une clé émise sur [naia.nextain.io](https://naia.nextain.io)
dans la variable d'environnement `NAIA_KEY` et vous pouvez utiliser vos crédits de
compte tout de suite. Sans clé, il lève une erreur avant tout appel payant. Pour
changer de fournisseur ou de modèle, copiez
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example),
et gardez les clés API dans des variables d'environnement ou le trousseau du
système d'exploitation, jamais dans le fichier de config. `naia-settings/llm.json`
n'enregistre que `apiKeyRef: "NAIA_KEY"`, jamais la valeur de la clé. Si un fork
personnel a besoin d'une sauvegarde à long terme, utilisez le coffre chiffré avec
age dans `data-private/key/` (voir [`.env.example`](.env.example)).

Pour lister les modèles pris en charge et leurs prix actuels, et pour traduire de
longs PDF, utilisez le skill `translate-doc`. Les consultations de modèles et de
prix marchent sans clé ; la traduction montre le coût estimé d'abord et peut
reprendre où elle s'est arrêtée.

## Pourquoi c'est construit ainsi

### Le format est le contrat

Le cœur de Naia ADK n'est pas un outil particulier mais un **format**. La disposition
des répertoires (`.agents/`, `.users/`, `skills/`, `data-*/`) et les schémas de
fichiers (`agents-rules.json`, `SKILL.md`) sont un accord fixe, et tout outil
capable de lire cet accord peut consommer le même espace de travail. Claude Code,
Codex, opencode, naia-agent, agy et muse lisent chacun le même espace de travail
sans embarquer le code des autres. Vous pouvez donc changer d'outil ou en mélanger
plusieurs, et l'espace de travail continue de marcher.

L'application des règles elle-même est agnostique aux outils. Un cœur neutre
d'hôte (`.agents/hooks/core/`) et des politiques (`.agents/hooks/policies/`)
pilotent à la fois les hooks de Claude Code et l'extension pi avec les mêmes règles.

### Une base personnelle avant de grandir en équipe

Naia ADK est strictement mono-utilisateur, pour un usage personnel. Les
organigrammes d'entreprise, les règles de locataires et les chaînes d'approbation
déléguées appartiennent à une couche supérieure. Ce qu'il vous donne, c'est un seul
endroit où écrire la discipline du contexte avant que l'espace de travail ne
grandisse à l'échelle de l'équipe ou de l'entreprise.

Pour la collaboration en équipe et les connaissances partagées, vous pouvez choisir
la lignée organisationnelle optionnelle représentée par
[Naia Business ADK](https://nextain.io/adk). Elle ajoute la gouvernance des actifs,
des processus et des permissions, la propriété d'équipe et les approbations
déléguées.

### Lignées de forks

Naia ADK est fait pour être forké dans votre propre espace de travail. Les
individus peuvent forker `naia-adk` directement. Une organisation peut choisir une
lignée organisationnelle séparée comme `naia-business-adk` pour les espaces de
travail de l'entreprise et des membres. Une seule chaîne fixe n'est exigée pour
aucun utilisateur.

```
naia-adk                  ← public personal base (Apache 2.0)
  └── {user}-adk          ← direct personal fork

naia-business-adk         ← optional organization lineage
  └── {org}-adk            ← org fork: company data + business submodules
        └── {member}-adk    ← member workspace derived from the organization
```

La lignée interne de Nextain est un exemple d'exploitation séparé. Un utilisateur
public peut garder un fork personnel direct et le nommer `{user}-adk` avec le nom
du compte.

Si vous avez besoin d'une base de référence projet/équipe, vous pouvez choisir
[naia-pj-adk](https://github.com/nextain/naia-pj-adk) comme base séparée. PJ est une
base d'adaptation pour la dérive de contexte multi-projets, le coût des appels et
les frontières d'exploitation Discord. L'adaptation du fork personnel et les règles
de rôles d'équipe/heures de travail sont des préoccupations séparées. Aider à
organiser et tracer ce travail est un objectif de conception de cette structure,
pas une garantie mesurée d'économies de coûts ou de délais plus courts. La base PJ
n'est pas le dépôt parent d'un fork personnel. `naia-business-adk`, pour quand vous
avez besoin de collaboration organisationnelle, est optionnel.

## Structure

Le dépôt se divise en code runtime (`packages/`), règles et contexte (`.agents/`,
`.users/`), skills (`skills/`, `.agents/skills/`), et les répertoires de données
que chaque fork remplit.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | Contexte destiné à l'IA (anglais, JSON/YAML) — source unique de vérité pour les règles |
| `.users/context/` | Guides lisibles par les humains (coréen, Markdown) |
| `.users/context/en/` | Miroir lisible en anglais (Markdown) |
| `.claude/` | Config Claude Code, hooks, liens symboliques de skills |
| `skills/` | Skills opérationnels/runtime (servis par l'API du tableau de bord) |
| `scripts/` | Scripts utilitaires |
| `templates/` | Modèles de documents |
| `docs/` | Docs d'architecture, spécifications de conception |
| `packages/` | Paquets runtime (espace de travail pnpm) |
| `config/` | Exemples de profils de travailleurs et config de déploiement |

### Paquets runtime (packages/, 12 au total)

Trois sont de vrais programmes qui tournent ; le reste sont des paquets fins qui
définissent des formats et des spécifications.

- `core` — le moteur qui analyse l'espace de travail et les skills.
- `server` — l'API REST/WebSocket Fastify.
- `dashboard` — l'interface Next.js du tableau de bord.
- `skill-spec` — le contrat de format de skill agnostique aux outils
  (`SkillDescriptor`, `SkillLoader`).
- `skills-builtin` — le catalogue générique de skills.
- `openclaw-compat` — un outil qui migre les skills OpenClaw vers le format naia.
- `persona` — la spécification de convention de prompt système.
- `process` — la spécification de motif de workflow (revue → décision → exécution,
  développement piloté par les issues, et ainsi de suite).
- `naia-anyllm` — l'adaptateur LLM passerelle any-llm / fournisseurs directs.
- `artifacts-spec` — le schéma standard pour les artefacts de permission (RBAC) et
  de cycle de vie de développement (SDLC). Il définit 15 types d'artefacts en JSON
  Schema et précise, pour chacun, si l'instance est suivie par git ou limitée à la
  session.
- `ax-messenger` — le paquet relais/admin du messenger Matrix (relais IA, registre
  et fournisseurs sur `matrix-js-sdk`).
- `benchmark-contract` — contrats permanents de benchmark et de gouvernance
  partagés par `naia-adk` et `naia-agent`.

### Tiers de travailleurs et surcharges de relecteurs

Les rôles et les modèles sont configurés séparément — aucune version de modèle
n'est gravée dans l'architecture.

- `config/tier-profile.example.json` (`tier-profile/v1`) est un profil de
  travailleur 4-tiers agnostique aux modèles. Les tiers décrivent des *rôles*
  (vérifications légères, conception et implémentation, sessions de rôles, revue
  indépendante) ; les candidats de chaque tier lient un CLI et un modèle
  séparément, si bien que changer de modèle ne change jamais la structure des rôles.
- Les surcharges de relecteurs des portes d'approbation vivent dans le
  `.claude/deploy/config.json` de l'instance comme `review_models` (id de relecteur
  → modèle exact, effort minimum, runner). Elles ne s'appliquent qu'après approbation
  `CFG-` ; sans config approuvée, les défauts du code s'appliquent. Les runners
  incluent `agy`, `muse`, `codex` et `claude`. Voir le
  [guide de la porte du plan d'approbation](docs/guides/approval-plan-gate.en.md).
- `naia-settings/review.json` contient le panel de revue inter-dépôts et la
  politique de tiers de modèles consommés par le skill `review-pass` et `naia-agent`.

### Répertoires de données (gitignored, remplis par fork)

Ces quatre-là ne sont jamais commités. Quiconque forke le dépôt remplit ses propres
données.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Documents à l'échelle de l'entreprise, ressources partagées |
| `data-teams/` | Team | Documents d'équipe (stratégie, comptabilité, etc.) |
| `data-private/` | Personal | Données personnelles, fichiers env, docs privés |
| `projects/` | Personal | Dépôts de projets (sous-modules) |

### Deux arbres de skills

Les skills vivent à deux endroits, consommés par des parties différentes.

- `.agents/skills/` — skills d'assistance IA et de workflow. Claude Code les
  utilise via le lien symbolique `.claude/skills/`. Inclut la revue
  (`review-pass`), la vérification (`verify-implementation`), la fusion de worktree
  (`merge-worktree`), l'extraction de documents (`read-doc`), des skills métier
  comme brevet/droits d'auteur/paie, et d'autres comme `finetune-persona`,
  `secret-vault` et `youtube-upload`.
- `skills/` — skills opérationnels/runtime. Le serveur API parcourt
  `skills/**/SKILL.md` et les sert au tableau de bord. Ceux-ci incluent
  l'envoi d'email/SMS/notifications, la gestion de canaux, la supervision de
  services et du web, et la génération de documents ; `skills/business/` contient
  des skills d'organisation comme `press-release`.

La liste la plus exacte est le catalogue de skills dans le tableau de bord. Une
table texte est dans l'[index des skills](.agents/context/skills-index.yaml).

## Pour commencer

### Personnel

1. Forkez `naia-adk` dans votre propre compte (privé si vous pouvez).
2. Clonez-le : `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Ajoutez l'amont : `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Créez les répertoires de données : `mkdir -p data-private projects`
5. Ajoutez des projets, configurez `.agents/`, et commencez à travailler.
6. Si vous utilisez des ressources de compte Naia, définissez `NAIA_KEY` comme
   variable d'environnement.
7. Synchronisez périodiquement : `git fetch upstream && git merge upstream/main`

### Entreprise

1. [Contactez-nous](https://nextain.io/contact) pour l'accès à `naia-business-adk`.
2. Forkez `naia-business-adk` en privé dans votre compte d'organisation, puis
   clonez-le.
3. Ajoutez l'amont : `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Remplissez les données d'entreprise et les sous-modules de projets :
   `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Chaque membre forke à nouveau l'ADK de l'organisation comme espace de travail
   personnel.

### Intégration Naia Shell (optionnel)

Si vous utilisez l'app desktop & web [Naia Shell](https://github.com/nextain/naia-shell),
pointez son chemin d'espace de travail vers votre répertoire ADK. Les skills et les
données sont servis via l'API.

## Contribuer

Écrivez les issues, PR et discussions dans la langue où vous êtes à l'aise ;
l'IA fait la médiation de la communication. Gardez juste le dossier git (commits,
contexte, artefacts partagés) en anglais. Pour le processus complet et les règles,
voir [CONTRIBUTING.md](CONTRIBUTING.md). Le développement est par défaut piloté par
les issues ; le flux détaillé vit dans [AGENTS.md](AGENTS.md), l'
[index de travail](.agents/context/ai-work-index.yaml), l'
[index des skills](.agents/context/skills-index.yaml), et
[`.agents/workflows/`](.agents/workflows/).

## Feuille de route

Ce qui suit est prévu, pas une fonctionnalité qui marche aujourd'hui.

- **Knowledge atoms** — le contexte d'aujourd'hui est basé sur des fichiers, donc
  trouver un morceau d'information veut dire charger tout le fichier et gaspiller
  des tokens. L'idée est de casser le contexte en plus petites unités
  significatives, de les lier avec des tags, et de ne sortir que le morceau exact
  dont on a besoin. L'accès passerait par le CLI ou MCP pour rester agnostique aux
  outils.

## Licence & avis brevets

- **Code (`Apache-2.0`) :** sous [licence Apache 2.0 (`Apache-2.0`)](LICENSE).
  Libre d'utiliser, modifier et distribuer — y compris à des fins commerciales,
  services hébergés ou gérés payants (SaaS), et organisations de toute taille. La
  section 3 de la licence Apache 2.0 inclut une licence de brevet pour le code
  contenu dans ce dépôt.
- **Brevets :** [`PATENTS.md`](PATENTS.md) explique la séparation des frontières de
  revendication, liste les demandes de brevet de Nextain, et accorde un engagement
  de brevet conditionnel supplémentaire (au-delà de la portée déjà licenciée sous la
  section 3 de la licence Apache 2.0) pour les individus, les organisations à but
  non lucratif et les développeurs conformes de l'écosystème Naia. Cet engagement
  supplémentaire ne couvre pas la pratique d'un brevet listé via une méthode ou un
  module non contenu dans ce dépôt dans des services hébergés payants pour des
  tiers, des produits fermés/OEM, ou des déploiements à l'échelle de l'entreprise
  atteignant ou dépassant les seuils de revenus ou de sièges de la section 2 de
  [`PATENTS.md`](PATENTS.md) ; voir les sections 2 et 3 de [`PATENTS.md`](PATENTS.md).
- **Commercial :** [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) couvre les
  modules propriétaires Nextain Tier-2 et les pipelines cloud non publiés dans ce
  dépôt, les licences de brevets commerciales pour les méthodes non contenues ici,
  et le support entreprise et l'indemnisation.
- **Contribuer :** voir [`CONTRIBUTING.md`](CONTRIBUTING.md). Les pull requests sont
  acceptées sous [`CLA.md`](CLA.md) (ou [`CLA-CORPORATE.md`](CLA-CORPORATE.md) pour
  les contributions d'entreprise).

## Écosystème Naia

- **naia-shell** — [github.com/nextain/naia-shell](https://github.com/nextain/naia-shell) (client shell desktop & web)
- **naia-agent** — [github.com/nextain/naia-agent](https://github.com/nextain/naia-agent) (runtime d'agent & orchestration d'outils)
- **naia-memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory) (mémoire persistante d'agent)
- **naia-kb-compiler** — [github.com/nextain/naia-kb-compiler](https://github.com/nextain/naia-kb-compiler) (compilateur de base de connaissances pour contexte structuré)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia** — [naia.nextain.io](https://naia.nextain.io)

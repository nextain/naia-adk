[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Français](README.fr.md) | **Deutsch** | [Русский](README.ru.md) | [Español](README.es.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md) | [Português](README.pt.md) | [Bahasa Indonesia](README.id.md) | [Tiếng Việt](README.vi.md)

# Naia ADK

**Ein vorbereitetes Arbeitsplatz-Gerüst, in dem KI-Coding-Agenten arbeiten.**

Wer KI-Coding-Werkzeuge wie Claude Code oder Codex nutzt, erlebt: Jedes Tool legt
seine Regeldateien woanders ab, und Fragen wie „Darf dieses Dokument veröffentlicht
werden?" oder „Wohin gehören Skills?" werden ad hoc beantwortet. Naia ADK legt
dieses Skelett im Voraus fest. So wie man auf einem neuen Laptop erst die
Entwicklungsumgebung einrichtet, übergibt es dem KI-Agenten einen aufgeräumten
Schreibtisch zum Starten. Dazu gibt es ein Dashboard, das den Arbeitsplatzstatus
auf einen Blick zeigt.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## In 5 Minuten startklar

Benötigt werden **Node 22+** und **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Öffne `http://localhost:3142` im Browser für das Dashboard. Drei Dinge sind sofort
sichtbar:

- **Workspace** — Projekte und Submodule, Dateibaum und die jeweilige
  Offenlegungsstufe.
- **Skills catalog** — die Liste der in diesem Workspace registrierten Skills und
  ihr Inhalt.
- **Settings / monitoring** — Serverkonfiguration, Client-Status, Datenverzeichnisse.

Das Dashboard leitet an den API-Server auf Port 3141 nur die `/api/portal`-Anfragen
der Docs-Ansicht weiter. Um nur eines von beiden zu starten, nutze
`pnpm dev:server` (→ 3141) oder `pnpm dev:dashboard` (→ 3142). Die Startskripte
`./start.sh` (Linux/macOS) und `start.bat` (Windows) führen beide `pnpm dev` aus.
Der Server-CLI akzeptiert `--port`, `--host` und `--root`; zeige z. B. mit
`pnpm serve -- --root /path/to/workspace` auf einen anderen Workspace.

## Was drinsteckt

### Das Workspace-Gerüst

Es gibt einem KI-Agenten eine Verzeichnisstruktur mit festen Plätzen für alles, sodass
er sofort losarbeiten kann. KI-seitiger Kontext liegt in `.agents/` (Englisch,
JSON/YAML). Menschenlesbare Anleitungen liegen in `.users/context/` (Koreanisch)
und `.users/context/en/` (Englisch). Dieser Spiegel ist partiell, keine
vollständige Kopie — er enthält nur die Dokumente, die ein Mensch lesen muss
(Skills sind z. B. kanonisch unter `.agents/skills/`, nur einige sind nach
`.users/skills/` gespiegelt). Skills, Daten und Projekte haben alle feste Orte,
sodass der Workspace gleich aussieht, egal welches Tool ihn öffnet.

### Dashboard und API

Ein Next.js-Dashboard verwaltet den Workspace visuell, getragen von einem
Fastify-API-Server. Die Tabs **Docs** (`/docs`) und **Work** in der oberen
Navigation zeigen gemeinsame Firmendokumente und das Kollaborationsboard an einem
Ort, und `pnpm adk:setup -- --company <repo-url>` richtet Firmendocs- und
Projekt-Repos in einem Schritt ein. Für Setup- und Nutzungsdetails siehe die
[Onboarding-Anleitung](docs/guides/onboarding.en.md)
([한국어](docs/guides/onboarding.ko.md)).
Siehe die [Anleitung zum Schreiben von Entwicklungsdokumentation](docs/guides/dev-docs-writing.en.md),
um Architektur, Verträge und Implementierungsnachweise zu dokumentieren.
Die API stellt Workspace-Metadaten (`/api/workspace`), den Skill-Katalog
(`/api/skills`), das Firmendocs-Portal (`/api/portal`) und einen WebSocket bereit,
der Dateiänderungsereignisse streamt (`/api/ws`). Dank dieser API erreichen auch
andere Programme als das Dashboard den Workspace.

### Skill-System

Wiederkehrende Aufgaben werden in wiederverwendbare Skills gebündelt. Jeder Skill
wird durch genau ein `SKILL.md` definiert, und der API-Server scannt `skills/`, um
den Katalog zu bauen. Verletzt auch nur ein Skill das Format, wirft der gesamte
Katalog einen Fehler (Fail-closed): Statt den kaputten Skill stillschweigend zu
überspringen und den Rest zu servieren, wird der Betreiber angehalten, ihn sofort
zu reparieren. Das ist eine bewusste Entscheidung, um versehentlich unvollständige
Kataloge zu verhindern.

### Was heute im Skill-Baum steckt

Die Skills fallen in vier Gruppen. Damit eine Sitzung nicht jedes `SKILL.md` neu
lesen muss, um zu erfahren, was es gibt, trägt `.agents/context/skills-index.yaml`
eine Zeile pro Skill — was er tut und wann man ihn nutzt. Die Liste unten ist das
Inhaltsverzeichnis dieses Index.

**Dokumente und Außenarbeit** — Dinge, die ein Mensch lesen wird.
`doc-coauthoring` (Spezifikationen und Designdokumente), `proposal-writing`,
`read-doc`, `translate-doc`, `press-release`, `weekly-report`,
`document-generation` (PDFs im Markendesign und digitale Signaturen),
`copyright-reg` (Urheberrechtsanmeldungen), `patent-draft` und `patent-pipeline`
(Patentschriften), `youtube-upload` (Videos und Untertitel).

**Den Workspace am Laufen halten** — die Hände, die das Repo selbst anfassen.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream` (Upstream-Sync), `manage-skills` und
`secret-vault` für den verschlüsselten Geheimnis-Tresor.

**Verifikations-Gates** — die Stellen, die Nachweise statt Behauptungen verlangen.
`verify-implementation`, `verify-contract-conformance`, `verify-request-contract`,
`verify-product-preservation`, `verify-benchmark-contract`, `verify-review-gate`,
`verify-build` (baut es wirklich), `verify-conflict-markers` (sind Konfliktmarker
übrig), `verify-i18n` und `verify-hardcoded-strings` (sind die Strings am richtigen
Ort), `webapp-testing` sowie `review-pass` für adversarielles Review.

**Betrieb und Experimente** — Arbeit, die nach außen reicht oder Modelle anfasst.
`manage-discord-sessions` für das Discord-Gateway, `channel-management`,
`service-management` (Uptime, Kosten, Incidents), `web-monitoring`, `email`, `sms`,
`upstream-pr-review` (eine Schleuse vor allem, was an OSS-Maintainer geht),
`payroll` sowie `finetune-persona` für Charakter-LoRA-Training.

Starte einen neuen Skill von `.agents/skills/SKILL_TEMPLATE.md` aus und trage seine
Zeile in den Index ein, sobald er existiert. Wenn der Index vom Baum abdriftet,
baut die nächste Sitzung einen Skill neu, den sie schon hatte.

### Regeln und Mindest-Governance

Selbst ein allein genutzter Workspace braucht minimale Regeln, sobald KI und
Automatisierung ihn anfassen. Naia ADK trennt `read`, `write`, `execute` und
`publish` als eigene Belange und hängt an jedes Dokument eine Offenlegungsstufe.
Schwer rückgängig zu machende Aktionen — Produktionsänderungen, Geheimnishandling,
öffentliche Behauptungen — werden von gewöhnlichen lokalen Edits getrennt und
durch Freigabe-Gates geroutet.

Offenlegung hat vier Stufen. `public` darf unverändert an eine öffentliche Seite
oder ein Open-Source-Repo; `controlled` darf nach Review extern geteilt werden;
`internal` bleibt im Workspace; `confidential` deckt sensible Materialien wie
Verträge, Zugangsdaten und personenbezogene Daten ab. Zugangsdaten liegen
normalerweise außerhalb von git, bleiben aber stufenmäßig `confidential`.

> **Der Session-Contract-Gate ist in einem markerfreien Checkout aktiv.** Eine
> ungebundene Sitzung darf routinemäßige, politikkonforme lokale Arbeit tun wie
> Inspektion, `npm test`, Builds, `mkdir` sowie gewöhnliches nicht-destruktives
> Git-Stage/Commit. Governance- und Host-Policy-Dateien, geteilte Entrypoints,
> Session-Verträge und Registry-Autorität, Löschung, destruktive oder ferne
> Befehle, ausgehende Effekte und Produktionsänderungen erfordern weiter einen
> Vertrag. Dies ist eine Governance-Prüfung der Repo-Hooks; keine
> Betriebssystem-Sandbox und keine Garantie für Befehle außerhalb der Hooks. Siehe
> `.agents/context/agents-rules.json` und `.agents/context/harness.yaml` für die
> Policy. Ein `.codex/no-harness`-, `.claude/no-harness`- oder `.pi/no-harness`-Marker
> am Projektroot oder einem Vorfahren wird an abgeleitete Checkouts vererbt. Dieser
> Kandidat verbindet den Session-Contract-Hook mit Codex und Claude; er behauptet
> keinen Pi-Session-Contract-Adapter.

### Wo Geheimnisse liegen

API-Schlüssel und Zertifikate lassen sich nicht nach git committen. Sie nur auf
jedem Laptop zu halten, hieße aber: Bei Maschinenwechsel sind sie weg, und niemand
kann sagen, wer was hält. Naia ADK durchschneidet diesen Knoten, indem es **genau
eine Datei** committet: den Ordner der Geheimnisse, archiviert und verschlüsselt.
Den entschlüsselten Inhalt sieht git überhaupt nie.

Konkret wird der Ordner `key/` getart und mit
[age](https://github.com/FiloSottile/age) zu einem einzigen `key.age` verschlüsselt.
`key/` steht in `.gitignore`, kann also nicht versehentlich committet werden. Das
Einzige, das je in einem Commit landet, ist `key.age`.

Eine Person tippt die Passphrase. Die KI erhält sie weder noch tippt sie sie für
jemanden ein. Öffnen und Versiegeln des Tresors geschehen also im eigenen Terminal
des Nutzers, während Prüfungen und Backup — die keine Passphrase brauchen —
delegiert werden können. Diese Grenze wird Befehl für Befehl innerhalb des Skills
gezogen.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` existiert, weil die Fehler eine feste Form haben. Man fügt einen Schlüssel
hinzu und vergisst zu versiegeln, oder versiegelt und vergisst zu pushen, oder eine
temporäre Datei bleibt zurück. `status` sucht alle drei auf einmal. Wenn jemand
fragt, ob die Schlüssel gesichert sind, antworte mit diesem Befehl statt aus dem
Gedächtnis.

`lock` schreibt das neue Chiffrat, **entschlüsselt es zur Prüfung erneut** und
ersetzt erst dann die alte Datei — so hinterlässt eine halbfertige Versiegelung
nie einen kaputten Tresor.

Standardkonsument dieses Musters ist ein privates Repo wie `data-private`, aber
jedes Repo mit `key.age` und gitignoriertem `key/` kann es nutzen. Überschreibe
`VAULT` und `PLAIN_DIR`, um eine der beiden Seiten umzubenennen.

### LLM-Adapter (naia-anyllm)

Für Funktionen, die ein LLM erreichen müssen, ist der `naia-anyllm`-Adapter
eingebaut. Er verbindet sich über das [any-llm](https://github.com/nextain/any-llm)-Gateway
oder direkt mit Anbietern wie OpenAI, Anthropic und Google. Standard ist ein
Naia-Konto: Lege einen auf [naia.nextain.io](https://naia.nextain.io) ausgestellten
Schlüssel in die Umgebungsvariable `NAIA_KEY`, und du kannst deine Kontoguthaben
sofort nutzen. Ohne Schlüssel wirft er vor jedem kostenpflichtigen Aufruf einen
Fehler. Um Anbieter oder Modelle zu wechseln, kopiere
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example)
und halte API-Schlüssel in Umgebungsvariablen oder dem Schlüsselbund des
Betriebssystems, nie in der Konfigurationsdatei. `naia-settings/llm.json`
zeichnet nur `apiKeyRef: "NAIA_KEY"` auf, nie den Schlüsselwert. Braucht ein
persönlicher Fork Langzeit-Backup, nutze den age-verschlüsselten Tresor in
`data-private/key/` (siehe [`.env.example`](.env.example)).

Zum Auflisten unterstützter Modelle und aktueller Preise sowie zum Übersetzen
langer PDFs nutze den Skill `translate-doc`. Modell- und Preisabfragen gehen ohne
Schlüssel; Übersetzung zeigt erst die geschätzten Kosten und kann fortsetzen, wo
sie stoppte.

## Warum es so gebaut ist

### Das Format ist der Vertrag

Das Herz von Naia ADK ist kein bestimmtes Tool, sondern ein **Format**. Das
Verzeichnislayout (`.agents/`, `.users/`, `skills/`, `data-*/`) und die
Dateischemas (`agents-rules.json`, `SKILL.md`) sind eine feste Vereinbarung, und
jedes Tool, das diese Vereinbarung lesen kann, kann denselben Workspace
konsumieren. Claude Code, Codex, opencode, naia-agent, agy und muse lesen je
denselben Workspace, ohne den Code der anderen einzubetten. Man kann also Tools
tauschen oder mehrere mischen, und der Workspace funktioniert weiter.

Auch die Regeldurchsetzung selbst ist tool-agnostisch. Ein hostneutraler Kern
(`.agents/hooks/core/`) und Policies (`.agents/hooks/policies/`) treiben sowohl
die Claude-Code-Hooks als auch die pi-Erweiterung mit denselben Regeln.

### Eine persönliche Basis, bevor sie zum Team heranwächst

Naia ADK ist strikt Einzelbenutzer, für den persönlichen Gebrauch. Firmen-Orgcharts,
Tenant-Regeln und delegierte Freigabeketten gehören in eine höhere Schicht. Was es
dir gibt, ist ein einziger Ort, um Kontextdisziplin festzuschreiben, bevor der
Workspace auf Team- oder Firmengröße wächst.

Für Teamkollaboration und geteiltes Wissen kannst du die optionale
Organisationslinien-Abstammung wählen, repräsentiert durch
[Naia Business ADK](https://nextain.io/adk). Sie fügt Asset-, Prozess- und
Berechtigungs-Governance, Team-Ownerschaft und delegierte Freigaben hinzu.

### Fork-Linien

Naia ADK ist dafür gedacht, in den eigenen Workspace geforkt zu werden. Einzelne
dürfen `naia-adk` direkt forken. Eine Organisation darf eine separate
Organisationslinien-Abstammung wie `naia-business-adk` für Firmen- und
Mitglieder-Workspaces wählen. Eine einzige feste Kette ist für keinen Nutzer
erforderlich.

```
naia-adk                  ← public personal base (Apache 2.0)
  └── {user}-adk          ← direct personal fork

naia-business-adk         ← optional organization lineage
  └── {org}-adk            ← org fork: company data + business submodules
        └── {member}-adk    ← member workspace derived from the organization
```

Nextains interne Linie ist ein separates Betriebsbeispiel. Ein öffentlicher Nutzer
darf einen direkten persönlichen Fork behalten und ihn mit dem Kontonamen
`{user}-adk` nennen.

Wer eine Projekt-/Team-Baseline braucht, kann
[naia-pj-adk](https://github.com/nextain/naia-pj-adk) als separate Baseline wählen.
PJ ist eine Adapter-Baseline für Multi-Projekt-Kontextdrift, Aufrufkosten und
Discord-Betriebsgrenzen. Personal-Fork-Zuschnitt und Team-Rollen-/Arbeitszeitregeln
sind separate Belange. Diese Arbeit zu organisieren und nachverfolgbar zu machen,
ist ein Designziel dieser Struktur, keine gemessene Garantie für Kosteneinsparung
oder kürzere Arbeitszeit. Die PJ-Baseline ist nicht das Eltern-Repo eines
persönlichen Forks. `naia-business-adk`, für wenn du organisatorische
Kollaboration brauchst, ist optional.

## Struktur

Das Repo gliedert sich in Runtime-Code (`packages/`), Regeln und Kontext
(`.agents/`, `.users/`), Skills (`skills/`, `.agents/skills/`) und die
Datenverzeichnisse, die jeder Fork füllt.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | KI-seitiger Kontext (Englisch, JSON/YAML) — Single Source of Truth für Regeln |
| `.users/context/` | Menschenlesbare Anleitungen (Koreanisch, Markdown) |
| `.users/context/en/` | Englischer menschenlesbarer Spiegel (Markdown) |
| `.claude/` | Claude-Code-Konfiguration, Hooks, Skill-Symlinks |
| `skills/` | Operative/Runtime-Skills (von der Dashboard-API serviert) |
| `scripts/` | Hilfsskripte |
| `templates/` | Dokumentvorlagen |
| `docs/` | Architektur-Docs, Design-Spezifikationen |
| `packages/` | Runtime-Pakete (pnpm-Workspace) |
| `config/` | Beispiel-Worker-Tier-Profile und Deploy-Konfiguration |

### Runtime-Pakete (packages/, 12 Stück)

Drei sind tatsächlich laufende Programme; der Rest sind schlanke Pakete, die
Formate und Spezifikationen definieren.

- `core` — die Engine, die Workspace und Skills parst.
- `server` — die Fastify-REST/WebSocket-API.
- `dashboard` — die Next.js-Dashboard-UI.
- `skill-spec` — der tool-agnostische Skill-Formatvertrag (`SkillDescriptor`,
  `SkillLoader`).
- `skills-builtin` — der generische Skill-Katalog.
- `openclaw-compat` — ein Tool, das OpenClaw-Skills ins naia-Format migriert.
- `persona` — die System-Prompt-Konventionsspezifikation.
- `process` — die Workflow-Musterspezifikation (Review → Entscheiden → Ausführen,
  Issue-getriebene Entwicklung usw.).
- `naia-anyllm` — der any-llm-Gateway-/Direktanbieter-LLM-Adapter.
- `artifacts-spec` — das Standardschema für Berechtigungs-(RBAC-) und
  Entwicklungslebenszyklus-(SDLC-)Artefakte. Es definiert 15 Artefakttypen als JSON
  Schema und legt für jeden fest, ob die Instanz git-getrackt oder
  session-scoped ist.
- `ax-messenger` — das Matrix-Messenger-Relay-/Admin-Paket (KI-Relay, Ledger und
  Provider über `matrix-js-sdk`).
- `benchmark-contract` — permanente Benchmark- und Governance-Nachweisverträge,
  geteilt von `naia-adk` und `naia-agent`.

### Worker-Tiers und Reviewer-Overrides

Rollen und Modelle werden getrennt konfiguriert — keine Modellversion ist in die
Architektur eingebacken.

- `config/tier-profile.example.json` (`tier-profile/v1`) ist ein modellagnostisches
  4-Tier-Worker-Profil. Tiers beschreiben *Rollen* (leichte Checks, Design und
  Implementierung, Rollensitzungen, unabhängiges Review); die Kandidaten jedes Tiers
  binden CLI und Modell separat, sodass ein Modelltausch nie die Rollenstruktur
  ändert.
- Freigabe-Gate-Reviewer-Overrides liegen in der instanzseitigen
  `.claude/deploy/config.json` als `review_models` (Reviewer-ID → exaktes Modell,
  Mindestaufwand, Runner). Sie greifen erst nach `CFG-`-Freigabe; ohne freigegebene
  Konfiguration gelten die Code-Defaults. Runner umfassen `agy`, `muse`, `codex`
  und `claude`. Siehe die
  [Freigabeplan-Gate-Anleitung](docs/guides/approval-plan-gate.en.md).
- `naia-settings/review.json` hält das repoübergreifende Review-Panel und die
  Modell-Tier-Policy, konsumiert vom Skill `review-pass` und `naia-agent`.

### Datenverzeichnisse (gitignored, pro Fork gefüllt)

Diese vier werden nie committet. Wer das Repo forkt, füllt eigene Daten ein.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Firmenweite Docs, geteilte Ressourcen |
| `data-teams/` | Team | Teamdokumente (Strategie, Buchhaltung usw.) |
| `data-private/` | Personal | Persönliche Daten, Env-Dateien, private Docs |
| `projects/` | Personal | Projekt-Repos (Submodule) |

### Zwei Skill-Bäume

Skills leben an zwei Orten, konsumiert von verschiedenen Parteien.

- `.agents/skills/` — KI-Assistenz- und Workflow-Skills. Claude Code nutzt sie über
  den `.claude/skills/`-Symlink. Umfasst Review (`review-pass`), Verifikation
  (`verify-implementation`), Worktree-Merge (`merge-worktree`),
  Dokumentenextraktion (`read-doc`), Business-Skills wie Patent/Urheberrecht/-
  Gehaltsabrechnung sowie andere wie `finetune-persona`, `secret-vault` und
  `youtube-upload`.
- `skills/` — operative/Runtime-Skills. Der API-Server scannt
  `skills/**/SKILL.md` und serviert sie ans Dashboard. Dazu gehören
  E-Mail/SMS-/Benachrichtigungsversand, Kanalmanagement, Service- und
  Web-Monitoring sowie Dokumentengenerierung; `skills/business/` hält
  Org-Skills wie `press-release`.

Die genaueste Liste ist der Skill-Katalog im Dashboard. Eine Texttabelle steht im
[Skill-Index](.agents/context/skills-index.yaml).

## Erste Schritte

### Persönlich

1. Forke `naia-adk` in deinen eigenen Account (privat, wenn möglich).
2. Klone es: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Füge das Upstream hinzu: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Lege Datenverzeichnisse an: `mkdir -p data-private projects`
5. Füge Projekte hinzu, konfiguriere `.agents/` und lege los.
6. Wenn du Naia-Kontoressourcen nutzt, setze `NAIA_KEY` als Umgebungsvariable.
7. Synchronisiere regelmäßig: `git fetch upstream && git merge upstream/main`

### Firma

1. [Kontaktiere uns](https://nextain.io/contact) für Zugang zu `naia-business-adk`.
2. Forke `naia-business-adk` privat in deinen Org-Account und klone es dann.
3. Füge das Upstream hinzu: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Fülle Firmendaten und Projekt-Submodule: `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Jedes Mitglied forkt die Org-ADK erneut als persönlichen Workspace.

### Naia-Shell-Integration (optional)

Wenn du die [Naia Shell](https://github.com/nextain/naia-shell)-Desktop- & Web-App
nutzt, zeige ihren Workspace-Pfad auf dein ADK-Verzeichnis. Skills und Daten werden
über die API serviert.

## Beitragen

Schreibe Issues, PRs und Diskussionen in der Sprache, in der du dich wohlfühlst;
die KI vermittelt die Kommunikation. Halte nur den Git-Record (Commits, Kontext,
geteilte Artefakte) auf Englisch. Für den vollständigen Prozess und die Regeln siehe
[CONTRIBUTING.md](CONTRIBUTING.md). Entwicklung läuft standardmäßig Issue-getrieben;
der detaillierte Fluss liegt in [AGENTS.md](AGENTS.md), dem
[Arbeitsindex](.agents/context/ai-work-index.yaml), dem
[Skill-Index](.agents/context/skills-index.yaml) und
[`.agents/workflows/`](.agents/workflows/).

## Roadmap

Das Folgende ist geplant, kein heute funktionierendes Feature.

- **Knowledge atoms** — heutiger Kontext ist dateibasiert, also heißt ein
  Informationsteil zu finden, die ganze Datei zu laden und Tokens zu verschwenden.
  Die Idee: Kontext in kleinste bedeutungsvolle Einheiten brechen, sie mit Tags
  verlinken und nur das exakt benötigte Stück holen. Zugriff ginge über CLI oder
  MCP, damit es tool-agnostisch bleibt.

## Lizenz & Patenthinweis

- **Code (`Apache-2.0`):** Lizenziert unter der [Apache-Lizenz 2.0 (`Apache-2.0`)](LICENSE).
  Frei zu nutzen, ändern und verteilen — einschließlich für kommerzielle Zwecke,
  bezahlte gehostete oder gemanagte Dienste (SaaS) und Organisationen jeder Größe.
  Abschnitt 3 der Apache-Lizenz 2.0 enthält eine Patentlizenz für den in diesem
  Repo enthaltenen Code.
- **Patente:** [`PATENTS.md`](PATENTS.md) erklärt die Aufteilung der
  Anspruchsgrenzen, listet Nextains Patentanmeldungen und gewährt einen
  zusätzlichen bedingten Patent-Covenant (über den bereits unter Abschnitt 3 der
  Apache-Lizenz 2.0 lizenzierten Umfang hinaus) für Einzelpersonen, Non-Profits und
  konforme Naia-Ökosystem-Entwickler. Dieser zusätzliche Covenant deckt nicht das
  Praktizieren eines gelisteten Patents durch eine Methode oder ein Modul ab, die
  nicht in diesem Repo enthalten sind, in bezahlten gehosteten Diensten für Dritte,
  geschlossenen/OEM-Produkten oder unternehmensweiten Deployments, die die Umsatz-
  oder Sitz-Schwellen in Abschnitt 2 von [`PATENTS.md`](PATENTS.md) erreichen oder
  überschreiten; siehe Abschnitte 2 und 3 von [`PATENTS.md`](PATENTS.md).
- **Kommerziell:** [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) deckt proprietäre
  Nextain-Tier-2-Module und Cloud-Pipelines ab, die nicht in diesem Repo
  veröffentlicht sind, kommerzielle Patentlizenzen für hier nicht enthaltene
  Methoden sowie Enterprise-Support und Freistellung.
- **Beitragen:** siehe [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull Requests werden
  unter [`CLA.md`](CLA.md) akzeptiert (oder [`CLA-CORPORATE.md`](CLA-CORPORATE.md)
  für Firmenbeiträge).

## Naia-Ökosystem

- **naia-shell** — [github.com/nextain/naia-shell](https://github.com/nextain/naia-shell) (Desktop- & Web-Shell-Client)
- **naia-agent** — [github.com/nextain/naia-agent](https://github.com/nextain/naia-agent) (Agent-Runtime & Tool-Orchestrierung)
- **naia-memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory) (persistenter Agent-Speicher)
- **naia-kb-compiler** — [github.com/nextain/naia-kb-compiler](https://github.com/nextain/naia-kb-compiler) (Knowledge-Base-Compiler für strukturierten Kontext)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia** — [naia.nextain.io](https://naia.nextain.io)

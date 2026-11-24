[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | **Español** | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md) | [Português](README.pt.md) | [Bahasa Indonesia](README.id.md) | [Tiếng Việt](README.vi.md)

# Naia ADK

**Un andamio de espacio de trabajo pre-organizado para que trabajen los agentes de codificación de IA.**

Cuando usas herramientas de codificación con IA como Claude Code o Codex, cada
herramienta guarda sus archivos de reglas en un lugar distinto, y preguntas como
«¿se puede publicar este documento?» o «¿dónde van los skills?» se responden de
forma improvisada. Naia ADK deja puesta esa estructura por adelantado. Igual que
preparas el entorno de desarrollo en un portátil nuevo, le entrega al agente de IA
un escritorio ordenado para empezar. Además incluye un panel para ver el estado del
espacio de trabajo de un vistazo.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## En marcha en 5 minutos

Necesitas **Node 22+** y **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Abre `http://localhost:3142` en tu navegador para ver el panel. Tres cosas se ven
de inmediato:

- **Workspace** — proyectos y submódulos, el árbol de archivos y el nivel de
  divulgación de cada elemento.
- **Skills catalog** — la lista de skills registrados en este espacio de trabajo y
  su contenido.
- **Settings / monitoring** — configuración del servidor, estado de los clientes,
  directorios de datos.

El panel solo reenvía al servidor API del puerto 3141 las peticiones `/api/portal`
de la vista de documentos. Para lanzar solo uno de ellos, usa `pnpm dev:server`
(→ 3141) o `pnpm dev:dashboard` (→ 3142). Los scripts de arranque `./start.sh`
(Linux/macOS) y `start.bat` (Windows) ejecutan ambos `pnpm dev`. El CLI del
servidor acepta `--port`, `--host` y `--root`; por ejemplo, apúntalo a otro
espacio de trabajo con `pnpm serve -- --root /path/to/workspace`.

## Qué hay dentro

### El andamio del espacio de trabajo

Le da a un agente de IA un conjunto de directorios con lugares fijos para todo,
para que pueda empezar a trabajar de inmediato. El contexto orientado a la IA vive
en `.agents/` (inglés, JSON/YAML). Las guías legibles por personas viven en
`.users/context/` (coreano) y `.users/context/en/` (inglés). Ese espejo es
parcial, no una copia completa — solo contiene los documentos que una persona
necesita leer (por ejemplo, los skills son canónicos bajo `.agents/skills/`, y
solo algunos se reflejan en `.users/skills/`). Los skills, los datos y los
proyectos tienen ubicaciones designadas, así que el espacio de trabajo se ve igual
sin importar qué herramienta lo abra.

### Panel y API

Un panel Next.js gestiona el espacio de trabajo de forma visual, respaldado por un
servidor API Fastify. Las pestañas **Docs** (`/docs`) y **Work** de la navegación
superior muestran los documentos compartidos de la empresa y el tablero de
colaboración en un solo lugar, y `pnpm adk:setup -- --company <repo-url>`
configura los repositorios de documentos de empresa y proyectos en un paso. Para
los detalles de configuración y uso, consulta la
[guía de incorporación](docs/guides/onboarding.en.md)
([한국어](docs/guides/onboarding.ko.md)).
Consulta la [guía de redacción de documentación de desarrollo](docs/guides/dev-docs-writing.en.md)
para documentar la arquitectura, los contratos y la evidencia de implementación.
La API expone los metadatos del espacio de trabajo (`/api/workspace`), el
catálogo de skills (`/api/skills`), el portal de documentos de empresa
(`/api/portal`) y un WebSocket que transmite eventos de cambio de archivos
(`/api/ws`). Gracias a esta API, otros programas además del panel también pueden
alcanzar el espacio de trabajo.

### Sistema de skills

Las tareas repetidas se agrupan en skills reutilizables. Cada skill se define con
un único `SKILL.md`, y el servidor API recorre `skills/` para construir el
catálogo. Si un solo skill viola el formato, todo el catálogo lanza un error
(cierre estricto): en lugar de descartar en silencio el skill roto y servir el
resto, se obliga al operador a corregirlo en el acto. Es una decisión deliberada
para no distribuir por accidente un catálogo incompleto.

### Qué hay hoy en el árbol de skills

Los skills se reparten en cuatro grupos. Para que una sesión no tenga que releer
cada `SKILL.md` para saber qué existe, `.agents/context/skills-index.yaml` lleva
una línea por skill que dice qué hace y cuándo usarlo. La lista de abajo es el
índice de ese índice.

**Documentos y trabajo hacia afuera** — cosas que una persona leerá.
`doc-coauthoring` (especificaciones y documentos de diseño), `proposal-writing`,
`read-doc`, `translate-doc`, `press-release`, `weekly-report`,
`document-generation` (PDF con marca y firmas digitales), `copyright-reg`
(registros de derechos de autor), `patent-draft` y `patent-pipeline` (patentes),
`youtube-upload` (vídeos y subtítulos).

**Operar el espacio de trabajo** — las manos que tocan el repositorio mismo.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream` (sincronización con upstream), `manage-skills` y
`secret-vault` para la caja fuerte cifrada de secretos.

**Puertas de verificación** — los lugares que piden evidencia en vez de
afirmaciones. `verify-implementation`, `verify-contract-conformance`,
`verify-request-contract`, `verify-product-preservation`, `verify-benchmark-contract`,
`verify-review-gate`, `verify-build` (si compila de verdad),
`verify-conflict-markers` (si quedan marcadores de conflicto), `verify-i18n` y
`verify-hardcoded-strings` (si las cadenas están en su sitio), `webapp-testing` y
`review-pass` para la revisión adversaria.

**Operaciones y experimentos** — trabajo que sale hacia afuera o toca modelos.
`manage-discord-sessions` para la pasarela de Discord, `channel-management`,
`service-management` (disponibilidad, costes, incidentes), `web-monitoring`,
`email`, `sms`, `upstream-pr-review` (un filtro antes de todo lo que va a un
mantenedor OSS), `payroll` y `finetune-persona` para entrenar LoRA de personajes.

Empieza un skill nuevo desde `.agents/skills/SKILL_TEMPLATE.md` y añade su línea
al índice cuando exista. Cuando el índice se desvíe del árbol, la siguiente sesión
reconstruye un skill que ya tenía.

### Reglas y gobernanza mínima

Incluso un espacio de trabajo de uso individual necesita unas reglas mínimas en
cuanto la IA y la automatización lo tocan. Naia ADK separa `read`, `write`,
`execute` y `publish` como inquietudes distintas, y asigna a cada documento un
nivel de divulgación. Las acciones difíciles de deshacer — cambios de producción,
manejo de secretos, afirmaciones públicas — se separan de las ediciones locales
ordinarias y se dirigen a puertas de aprobación.

La divulgación tiene cuatro niveles. `public` puede publicarse tal cual en un
sitio público o repositorio open source; `controlled` puede compartirse fuera tras
revisión; `internal` se queda en el espacio de trabajo; `confidential` cubre
material sensible como contratos, credenciales y datos personales. Las
credenciales suelen vivir fuera de git, pero por nivel siguen siendo
`confidential`.

> **La puerta del contrato de sesión está activa en un checkout sin marcadores.**
> Una sesión no vinculada puede hacer trabajo local rutinario permitido por la
> política como inspección, `npm test`, compilaciones, `mkdir` y stage/commit Git
> ordinario no destructivo. Los archivos de gobernanza y política de host, los
> puntos de entrada compartidos, los contratos de sesión y la autoridad del
> registro, la eliminación, los comandos destructivos o remotos, los efectos
> externos y los cambios de producción siguen exigiendo un contrato. Es un control
> de gobernanza de los hooks del repositorio; no es un sandbox del sistema
> operativo ni garantiza los comandos lanzados fuera de los hooks. Consulta
> `.agents/context/agents-rules.json` y `.agents/context/harness.yaml` para la
> política. Un marcador `.codex/no-harness`, `.claude/no-harness` o
> `.pi/no-harness` en la raíz del proyecto o en un ancestro lo heredan los
> checkouts descendientes. Este candidato conecta el hook del contrato de sesión
> con Codex y Claude; no afirma un adaptador Pi del contrato de sesión.

### Dónde viven los secretos

No puedes subir claves API ni certificados a git. Pero guardarlos solo en cada
portátil significa que desaparecen cuando cambia la máquina, y nadie puede decir
quién tiene qué. Naia ADK corta ese nudo subiendo **un único archivo**: la carpeta
de secretos, archivada y cifrada. Git jamás ve el contenido descifrado.

En concreto, la carpeta `key/` se empaqueta con tar y se cifra con
[age](https://github.com/FiloSottile/age) en un único `key.age`. `key/` está en
`.gitignore`, así que no puede subirse por accidente. Lo único que llega a un
commit es `key.age`.

Una persona escribe la frase de paso. La IA ni la recibe ni la escribe en nombre de
nadie. Abrir y sellar la caja fuerte ocurre por tanto en la propia terminal del
usuario, mientras que las comprobaciones y la copia de seguridad — que no necesitan
la frase — sí pueden delegarse. Esa frontera se traza comando a comando dentro del
skill.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` existe porque los errores tienen una forma fija. Añades una clave y
olvidas sellar, o sellas y olvidas subir, o queda un archivo temporal atrás.
`status` busca las tres cosas a la vez. Cuando alguien pregunte si las claves
tienen copia, responde con ese comando en lugar de hacerlo de memoria.

`lock` escribe el nuevo cifrado, **lo descifra de nuevo para comprobarlo** y solo
entonces reemplaza el archivo anterior — así un sellado a medias nunca deja una
caja rota.

El consumidor estándar de este patrón es un repositorio privado como
`data-private`, pero cualquier repositorio con `key.age` y `key/` ignorado por git
puede usarlo. Redefine `VAULT` y `PLAIN_DIR` para renombrar cualquiera de los dos
lados.

### Adaptador LLM (naia-anyllm)

Para las funciones que necesitan llegar a un LLM, el adaptador `naia-anyllm`
viene integrado. Se conecta a través de la pasarela [any-llm](https://github.com/nextain/any-llm)
o directamente a proveedores como OpenAI, Anthropic y Google. Por defecto es una
cuenta Naia: pon una clave emitida en [naia.nextain.io](https://naia.nextain.io)
en la variable de entorno `NAIA_KEY` y podrás usar los créditos de tu cuenta de
inmediato. Sin clave, lanza un error antes de cualquier llamada de pago. Para
cambiar de proveedor o modelo, copia
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example)
y guarda las claves API en variables de entorno o en el llavero del sistema
operativo, nunca en el archivo de configuración. `naia-settings/llm.json` solo
registra `apiKeyRef: "NAIA_KEY"`, nunca el valor. Si un fork personal necesita
respaldo a largo plazo, usa la caja cifrada con age en `data-private/key/` (ver
[`.env.example`](.env.example)).

Para listar los modelos admitidos y sus precios actuales, y para traducir PDF
largos, usa el skill `translate-doc`. Las consultas de modelos y precios funcionan
sin clave; la traducción muestra primero el coste estimado y puede continuar donde
se detuvo.

## Por qué está construido así

### El formato es el contrato

El corazón de Naia ADK no es una herramienta concreta sino un **formato**. La
disposición de directorios (`.agents/`, `.users/`, `skills/`, `data-*/`) y los
esquemas de archivos (`agents-rules.json`, `SKILL.md`) son un acuerdo fijo, y
cualquier herramienta capaz de leer ese acuerdo puede consumir el mismo espacio de
trabajo. Claude Code, Codex, opencode, naia-agent, agy y muse leen cada uno el
mismo espacio sin embeber el código de los demás. Así puedes cambiar de
herramienta o mezclar varias, y el espacio sigue funcionando.

La aplicación de las reglas también es agnóstica a la herramienta. Un núcleo
neutral de host (`.agents/hooks/core/`) y unas políticas (`.agents/hooks/policies/`)
mueven tanto los hooks de Claude Code como la extensión pi con las mismas reglas.

### Una base personal antes de crecer a equipo

Naia ADK es estrictamente unipersonal, para uso personal. Los organigramas de
empresa, las reglas de inquilinos y las cadenas de aprobación delegada pertenecen
a una capa superior. Lo que sí te da es un único lugar donde escribir la
disciplina del contexto antes de que el espacio crezca a escala de equipo o de
empresa.

Para la colaboración en equipo y el conocimiento compartido, puedes elegir el
linaje organizacional opcional representado por
[Naia Business ADK](https://nextain.io/adk). Añade gobernanza de activos, procesos
y permisos, propiedad del equipo y aprobaciones delegadas.

### Linajes de forks

Naia ADK está hecho para bifurcarse en tu propio espacio de trabajo. Las personas
pueden bifurcar `naia-adk` directamente. Una organización puede elegir un linaje
organizacional separado como `naia-business-adk` para los espacios de la empresa
y los miembros. No se exige una única cadena fija a ningún usuario.

```
naia-adk                  ← public personal base (Apache 2.0)
  └── {user}-adk          ← direct personal fork

naia-business-adk         ← optional organization lineage
  └── {org}-adk            ← org fork: company data + business submodules
        └── {member}-adk    ← member workspace derived from the organization
```

El linaje interno de Nextain es un ejemplo operativo aparte. Un usuario público
puede mantener un fork personal directo y llamarlo `{user}-adk` con el nombre de
la cuenta.

Si necesitas una base de proyecto/equipo, puedes elegir
[naia-pj-adk](https://github.com/nextain/naia-pj-adk) como base separada. PJ es
una base adaptadora para la deriva de contexto multiproyecto, el coste de llamadas
y las fronteras de operación de Discord. La personalización del fork personal y las
reglas de roles/horarios del equipo son inquietudes separadas. Ayudar a organizar
y trazar ese trabajo es un objetivo de diseño de esta estructura, no una garantía
medida de ahorro de costes ni de plazos más cortos. La base PJ no es el
repositorio padre de un fork personal. `naia-business-adk`, para cuando necesites
colaboración organizacional, es opcional.

## Estructura

El repositorio se divide en código de runtime (`packages/`), reglas y contexto
(`.agents/`, `.users/`), skills (`skills/`, `.agents/skills/`) y los directorios
de datos que cada fork rellena.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | Contexto para la IA (inglés, JSON/YAML) — única fuente de verdad de las reglas |
| `.users/context/` | Guías legibles por personas (coreano, Markdown) |
| `.users/context/en/` | Espejo legible en inglés (Markdown) |
| `.claude/` | Config de Claude Code, hooks, enlaces de skills |
| `skills/` | Skills operativos/de runtime (servidos por la API del panel) |
| `scripts/` | Scripts de utilidades |
| `templates/` | Plantillas de documentos |
| `docs/` | Documentos de arquitectura, especificaciones de diseño |
| `packages/` | Paquetes de runtime (espacio pnpm) |
| `config/` | Perfiles de ejemplo de trabajadores y config de despliegue |

### Paquetes de runtime (packages/, 12 en total)

Tres son programas reales en ejecución; el resto son paquetes ligeros que definen
formatos y especificaciones.

- `core` — el motor que analiza el espacio de trabajo y los skills.
- `server` — la API REST/WebSocket Fastify.
- `dashboard` — la interfaz Next.js del panel.
- `skill-spec` — el contrato de formato de skill agnóstico a herramientas
  (`SkillDescriptor`, `SkillLoader`).
- `skills-builtin` — el catálogo genérico de skills.
- `openclaw-compat` — una herramienta que migra skills OpenClaw al formato naia.
- `persona` — la especificación de convención del prompt del sistema.
- `process` — la especificación de patrones de flujo (revisión → decisión →
  ejecución, desarrollo dirigido por issues, etc.).
- `naia-anyllm` — el adaptador LLM vía pasarela any-llm / proveedores directos.
- `artifacts-spec` — el esquema estándar para artefactos de permisos (RBAC) y de
  ciclo de vida de desarrollo (SDLC). Define 15 tipos de artefactos como JSON
  Schema y precisa, para cada uno, si la instancia lleva seguimiento en git o está
  limitada a la sesión.
- `ax-messenger` — el paquete de retransmisión/administración del messenger Matrix
  (retransmisión IA, registro y proveedores sobre `matrix-js-sdk`).
- `benchmark-contract` — contratos permanentes de benchmark y evidencia de
  gobernanza compartidos por `naia-adk` y `naia-agent`.

### Niveles de trabajadores y sustituciones de revisores

Los roles y los modelos se configuran por separado — ninguna versión de modelo
está grabada en la arquitectura.

- `config/tier-profile.example.json` (`tier-profile/v1`) es un perfil de
  trabajador 4-niveles agnóstico al modelo. Los niveles describen *roles*
  (revisiones ligeras, diseño e implementación, sesiones de rol, revisión
  independiente); los candidatos de cada nivel enlazan CLI y modelo por separado,
  así que cambiar de modelo nunca cambia la estructura de roles.
- Las sustituciones de revisores de las puertas de aprobación viven en el
  `.claude/deploy/config.json` de la instancia como `review_models` (id de
  revisor → modelo exacto, esfuerzo mínimo, runner). Solo se aplican tras
  aprobación `CFG-`; sin config aprobada rigen los defectos del código. Los
  runners incluyen `agy`, `muse`, `codex` y `claude`. Consulta la
  [guía de la puerta del plan de aprobación](docs/guides/approval-plan-gate.en.md).
- `naia-settings/review.json` guarda el panel de revisión entre repositorios y la
  política de niveles de modelos que consumen el skill `review-pass` y
  `naia-agent`.

### Directorios de datos (gitignored, rellenados por fork)

Estos cuatro nunca se suben. Quien bifurca el repositorio rellena sus propios
datos.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Documentos de toda la empresa, recursos compartidos |
| `data-teams/` | Team | Documentos de equipo (estrategia, contabilidad, etc.) |
| `data-private/` | Personal | Datos personales, archivos env, documentos privados |
| `projects/` | Personal | Repositorios de proyectos (submódulos) |

### Dos árboles de skills

Los skills viven en dos lugares, consumidos por distintas partes.

- `.agents/skills/` — skills de asistencia IA y flujos. Claude Code los usa vía el
  enlace `.claude/skills/`. Incluye revisión (`review-pass`), verificación
  (`verify-implementation`), fusión de worktree (`merge-worktree`), extracción de
  documentos (`read-doc`), skills de negocio como patente/derechos/nómina y otros
  como `finetune-persona`, `secret-vault` y `youtube-upload`.
- `skills/` — skills operativos/de runtime. El servidor API recorre
  `skills/**/SKILL.md` y los sirve al panel. Incluyen envío de
  email/SMS/notificaciones, gestión de canales, supervisión de servicios y web y
  generación de documentos; `skills/business/` contiene skills de organización
  como `press-release`.

La lista más exacta es el catálogo de skills del panel. Hay una tabla de texto en
el [índice de skills](.agents/context/skills-index.yaml).

## Primeros pasos

### Personal

1. Bifurca `naia-adk` en tu propia cuenta (privado si puedes).
2. Clónalo: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Añade el upstream: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Crea los directorios de datos: `mkdir -p data-private projects`
5. Añade proyectos, configura `.agents/` y empieza a trabajar.
6. Si usas recursos de cuenta Naia, define `NAIA_KEY` como variable de entorno.
7. Sincroniza periódicamente: `git fetch upstream && git merge upstream/main`

### Empresa

1. [Contáctanos](https://nextain.io/contact) para acceder a `naia-business-adk`.
2. Bifurca `naia-business-adk` en privado en tu cuenta de organización y luego
   clónalo.
3. Añade el upstream: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Rellena los datos de empresa y los submódulos de proyectos:
   `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Cada miembro vuelve a bifurcar el ADK de la organización como espacio personal.

### Integración con Naia Shell (opcional)

Si usas la app de escritorio y web [Naia Shell](https://github.com/nextain/naia-shell),
apunta su ruta de espacio de trabajo a tu directorio ADK. Los skills y los datos
se sirven por la API.

## Cómo contribuir

Escribe issues, PR y discusiones en el idioma con el que te sientas cómodo; la IA
media la comunicación. Solo mantén el registro git (commits, contexto, artefactos
compartidos) en inglés. Para el proceso completo y las reglas, consulta
[CONTRIBUTING.md](CONTRIBUTING.md). El desarrollo es por defecto dirigido por
issues; el flujo detallado vive en [AGENTS.md](AGENTS.md), el
[índice de trabajo](.agents/context/ai-work-index.yaml), el
[índice de skills](.agents/context/skills-index.yaml) y
[`.agents/workflows/`](.agents/workflows/).

## Hoja de ruta

Lo siguiente está previsto, no es una función que opere hoy.

- **Knowledge atoms** — el contexto actual está basado en archivos, así que
  encontrar un dato significa cargar todo el archivo y desperdiciar tokens. La
  idea es romper el contexto en las unidades mínimas con sentido, enlazarlas con
  etiquetas y extraer solo el fragmento exacto que se necesita. El acceso iría por
  CLI o MCP para seguir siendo agnóstico a las herramientas.

## Licencia y aviso de patentes

- **Código (`Apache-2.0`):** bajo la [licencia Apache 2.0 (`Apache-2.0`)](LICENSE).
  Libre de usar, modificar y distribuir — incluso con fines comerciales, servicios
  alojados o gestionados de pago (SaaS) y organizaciones de cualquier tamaño. La
  sección 3 de la licencia Apache 2.0 incluye una licencia de patente para el
  código contenido en este repositorio.
- **Patentes:** [`PATENTS.md`](PATENTS.md) explica la división de límites de
  reivindicaciones, lista las solicitudes de patente de Nextain y otorga un
  compromiso de patente condicional adicional (más allá del alcance ya licenciado
  bajo la sección 3 de la licencia Apache 2.0) para individuos, organizaciones sin
  ánimo de lucro y desarrolladores conformes del ecosistema Naia. Ese compromiso
  adicional no cubre la práctica de una patente listada mediante un método o
  módulo no contenido en este repositorio en servicios alojados de pago para
  terceros, productos cerrados/OEM o despliegues empresariales que alcancen o
  superen los umbrales de ingresos o puestos de la sección 2 de
  [`PATENTS.md`](PATENTS.md); consulta las secciones 2 y 3 de
  [`PATENTS.md`](PATENTS.md).
- **Comercial:** [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) cubre los
  módulos propietarios Nextain Tier-2 y los pipelines cloud no publicados en este
  repositorio, las licencias comerciales de patentes para métodos no contenidos
  aquí, y el soporte empresarial y la indemnización.
- **Contribuir:** consulta [`CONTRIBUTING.md`](CONTRIBUTING.md). Los pull requests
  se aceptan bajo [`CLA.md`](CLA.md) (o [`CLA-CORPORATE.md`](CLA-CORPORATE.md)
  para contribuciones corporativas).

## Ecosistema Naia

- **naia-shell** — [github.com/nextain/naia-shell](https://github.com/nextain/naia-shell) (cliente shell de escritorio y web)
- **naia-agent** — [github.com/nextain/naia-agent](https://github.com/nextain/naia-agent) (runtime de agentes y orquestación de herramientas)
- **naia-memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory) (memoria persistente de agentes)
- **naia-kb-compiler** — [github.com/nextain/naia-kb-compiler](https://github.com/nextain/naia-kb-compiler) (compilador de bases de conocimiento para contexto estructurado)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia** — [naia.nextain.io](https://naia.nextain.io)

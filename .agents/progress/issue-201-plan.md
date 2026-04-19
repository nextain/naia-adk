# #201 OpenClaw 제거 Phase 4 — 완전 제거 + 이관 계획

## 배경
- Epic #186의 최종 Phase
- Phase 1-3 완료: CommandExecutor 추상화, NativeCommandExecutor, MCP 브릿지
- 168+ 파일, 670+ OpenClaw 참조 제거 필요

## 조사 결과
| 카테고리 | 파일 수 | 참조 수 | 담당 Sub-phase |
|----------|---------|---------|----------------|
| Agent 소스 (src/) | 9 | 30+ | A |
| Agent 테스트 | 13 | 30+ | A |
| Agent 스크립트/assets | 8 | 20+ | A |
| Agent reports/benchmarks | 8 | 10+ | A |
| Agent config (package.json) | 2 | 5+ | A |
| Shell/Tauri Rust | 4 | 173 | C |
| Shell 프론트엔드 (src/) | 19 | 87 | B |
| Shell E2E 테스트 | 9 | 42 | B |
| Config/빌드/스크립트 | 15 | 117 | D |
| Flatpak/배포 | 3 | 22 | D |
| 문서 (.agents/.users/README) | 50+ | 100+ | E |
| OS/인스톨러 | 3 | 18 | D |
| CI (.github/) | 1 | 2 | D |

## ClawHub 호환성 요구사항
- ClawHub (clawhub.ai): ~3,286개 스킬 마켓플레이스
- 스킬 포맷: SKILL.md + YAML frontmatter (Agent Skills 표준 호환)
- `clawhub` CLI: 독립 npm 패키지 (OpenClaw 런타임 무관)
- `metadata.openclaw.requires`: 의존성 체크 (bins, env, config) — Naia 자체 구현 필요
- `skills.install` RPC: brew/node/go/uv 자동 설치 — Gateway 없이 직접 구현 필요

## Sub-phase 계획

### A. Agent 전체 마이그레이션 (~40 파일, Low risk)

**소스 코드:**
- path-resolver.ts: DefaultPathResolver → ~/.naia/ 경로 (remove ~/.openclaw/)
- protocol.ts + index.ts: TTS engine "openclaw" → "gateway"
- naia-discord.ts: allowlist path ~/.openclaw/credentials/ → ~/.naia/credentials/
- adapter-openclaw.ts: remove benchmark adapter (OpenClaw-specific)
- run-comparison.ts: OpenClawAdapter import/case 분기 제거
- memory/types.ts: OpenClawAdapter 주석 제거
- gateway/client.ts, tts-proxy.ts: comment cleanup

**스크립트/assets:**
- scripts/generate-skill-manifests.ts: OPENCLAW_SKILLS_DIR → NAIA_SKILLS_DIR, metadata.openclaw 파싱
- scripts/__tests__/generate-manifests.test.ts: metadata.openclaw 테스트 업데이트
- assets/default-skills/ 6개 skill.json: "OpenClaw" 설명문 치환

**config:**
- package.json: @mem0/openclaw-mem0 의존성 정리

**reports:**
- agent/reports/benchmarks/ 8개 파일: "OpenClaw" 문자열 치환

**테스트 (13 파일):**
- 모든 agent 테스트: mock 경로, 설명문, 상수 업데이트

### B. Shell 프론트엔드 마이그레이션 (~26 파일, Medium risk)

**핵심 모듈:**
- openclaw-sync.ts → gateway-sync.ts (rename + update all imports)
- channel-sync.ts: syncOpenClawWithChannels() → syncGatewayChannels()
- gateway-sessions.ts: OpenClaw heartbeat 상수/함수 정리
- discord-api.ts: OpenClaw config 주석 제거

**타입/설정:**
- types.ts, config.ts, chat-service.ts: ttsEngine: "openclaw" → "gateway"
- i18n.ts: "OpenClaw Gateway URL/Token" → "Naia Gateway URL/Token" (12 languages)

**컴포넌트:**
- App.tsx: openclaw-sync → gateway-sync import
- OnboardingWizard.tsx: syncToOpenClaw → syncToGateway
- ChatPanel.tsx: sync 호출 업데이트
- SettingsTab.tsx: sync 호출 + reset 함수 이름 업데이트
- WslSetupScreen.tsx: provision_openclaw → provision_gateway 키 (Sub-phase C와 동기화)

**테스트 (9 E2E + 4 unit):**
- openclaw-sync.test.ts → gateway-sync.test.ts
- channel-sync.test.ts: mock 업데이트
- chat-service.test.ts, gateway-sessions.test.ts: 상수 업데이트
- E2E specs: mock captures 업데이트

### C. Rust/Tauri 백엔드 마이그레이션 (~4 파일, HIGH risk)

**lib.rs (가장 큰 변경):**
- find_openclaw_paths() → find_gateway_paths()
- ensure_openclaw_config() → ensure_gateway_config()
- spawn_node_host() (lib.rs 전용, wsl.rs의 spawn_node_host_in_wsl()과 별개): 바이너리 경로 + env vars 업데이트
- sync_openclaw_config() → sync_gateway_config()
- reset_openclaw_data() → reset_gateway_data()
- read_discord_bot_token(): config 경로 업데이트
- OPENCLAW_ env var prefix → NAIA_GATEWAY_
- process grep 패턴: "openclaw.*gateway" → "naia.*gateway"

**wsl.rs:**
- spawn_gateway_in_wsl(): /opt/naia/openclaw/ → /opt/naia/gateway/ 경로
- spawn_node_host_in_wsl(): 동일 경로 변경
- provision_distro() 내 openclaw 설치 로직 → gateway 패키지로 전환
- emit_provision_progress("provisionOpenclaw") → 키 변경
- kill_openclaw_processes(): pkill 패턴 변경

**windows.rs:**
- ~/.openclaw/ 참조 경로 → ~/.naia/ 전환
- should_skip_openclaw_sync() → should_skip_gateway_sync()

**linux.rs:**
- kill_wsl_openclaw_processes(): 함수 이름 + 패턴
- should_skip_openclaw_sync() → should_skip_gateway_sync()

**마이그레이션 스크립트 (lib.rs startup에 구현):**
- ~/.openclaw/identity/ → ~/.naia/identity/ (copy, preserve originals)
- ~/.openclaw/openclaw.json → ~/.naia/gateway.json (transform keys)
- ~/.openclaw/workspace/ → ~/.naia/workspace/ (symlink or copy)
- 첫 부팅 시 자동 실행, 이미 완료 시 skip
- Idempotent 설계: 각 단계(identity→config→workspace) 독립 실행, 개별 실패 시 skip 후 다음 진행
- 실패 로그: ~/.naia/migration.log에 기록, 재실행 시 이미 완료된 단계 skip
- 롤백 불필요: 원본 ~/.openclaw/ 보존하므로 수동 복구 가능

**주의:** Sub-phase B의 WslSetupScreen.tsx와 동기화 필수 (provision 키 일치)

### D. Config/Scripts/Systemd/CI (~18 파일, Medium risk)

**systemd:**
- naia-gateway.service (2 copies): ExecStart, WorkingDirectory, Description

**설치/설정 스크립트:**
- install-gateway.sh: install path ~/.naia/gateway/, config 경로
- setup-openclaw.sh → setup-gateway.sh: rename + 내용 치환 + 호출처 (systemd unit, install scripts) 참조 업데이트
- config/defaults/openclaw-bootstrap.json → gateway-bootstrap.json
- config/wsl/healthcheck.sh: endpoint + binary path
- config/wsl/Dockerfile: Node.js + 패키지 설치 경로

**테스트 스크립트:**
- scripts/test-windows-e2e.mjs: OPENCLAW_PATH, ~/.openclaw/, pkill 패턴
- scripts/test-windows-app-e2e.mjs: /__openclaw__/canvas/ 엔드포인트
- scripts/test-wsl-full-setup.mjs: /opt/naia/openclaw/, npm install openclaw
- scripts/dev-setup.mjs: openclaw.mjs 경로

**Shell 관련:**
- shell/.env.sample: openclaw.json 참조
- shell/e2e-tauri/wdio.conf.ts: pkill -9 -f openclaw-node

**Flatpak:**
- flatpak/io.nextain.naia.yml: npm install + bundle 경로
- flatpak/io.nextain.naia.metainfo.xml: release notes

**CI:**
- .github/workflows/ci.yml: phase3-openclaw-hybrid-plan 참조

**OS/인스톨러:**
- os/tests/test-liveinst-wrapper.sh: pkill, test 경로
- installer/hook-post-rootfs.sh: kill, lock/pid cleanup

### E. 문서 (~50+ 파일, Low risk)

**.agents/context/ (주요):**
- architecture.yaml: OpenClaw Gateway → Naia Gateway
- openclaw-sync.yaml → gateway-sync.yaml
- channels-discord.yaml, contributing.yaml, skill-naia-discord.yaml
- phase3-plan.yaml: OpenClaw 참조 업데이트

**.users/context/ (EN + KO 미러):**
- architecture.md, openclaw-sync.md → gateway-sync.md
- channels-discord.md, contributing.md, channel-sync.md, skill-naia-discord.md
- ko/ 하위 11개 파일 동일 업데이트

**엔트리 포인트:**
- CLAUDE.md, AGENTS.md: Gateway 커맨드 참조

**README (13 languages):**
- 아키텍처 설명 업데이트

**릴리즈 노트:**
- releases/*.yaml, CHANGELOG*.md: 역사적 참조는 유지, 마이그레이션 노트 추가

**agent/reports/benchmarks/:**
- Sub-phase A에서 처리 (8개 파일)

### F. ClawHub 스킬 호환성 (~5 파일 신규, Medium risk)

**metadata 파싱:**
- metadata.openclaw.requires → metadata.naia.requires 호환 파싱
- 기존 metadata.openclaw도 backward-compat으로 읽기 (v1.x 유지, 제거 시 별도 이슈 생성)

**의존성 설치기:**
- agent/src/skills/dependency-installer.ts (신규): brew/node/go/uv/download 지원
- Gateway skills.install RPC 대체 (자체 child_process 기반)
- skill-manager.ts: installSkill() 로직을 Gateway RPC → 자체 설치기로 전환

**스킬 경로:**
- ~/.naia/skills/ (이미 구현됨)
- CLAWHUB_SKILLS_DIR 환경 변수 지원

## 마이그레이션 스크립트
Sub-phase C에서 구현 (lib.rs startup 로직). 상세 내용은 Sub-phase C 참조.

## 실행 순서
A → B → C → D → E → F (의존성 기반: Agent 추상화 → Shell UI → Rust 런타임 → 배포 설정 → 문서 → 새 기능)

**순서 근거:** Agent 코드(A)가 Shell/Rust의 기반. Rust(C)가 Tauri invoke 키의 SoT — C에서 새 키를 정의하고 B에서 그에 맞춰 호출. 다만 A→B→C 순서를 유지하는 이유: B의 변경은 키 이름 치환 위주로 C와 독립적이며, C의 마이그레이션 로직이 가장 위험하므로 A→B를 먼저 안정화 후 C 진행. Config(D)는 런타임 변경 후 업데이트. 문서(E)는 코드 확정 후. ClawHub(F)는 독립 기능 추가.

**Invoke 키 SoT:** Sub-phase C (Rust)에서 최종 정의. B는 아래 키 목록을 기준으로 작업.

| 기존 키 (OpenClaw) | 새 키 (Naia) |
|---------------------|--------------|
| sync_openclaw_config | sync_gateway_config |
| reset_openclaw_data | reset_gateway_data |
| provision_openclaw (WSL) | provision_gateway |
| should_skip_openclaw_sync | should_skip_gateway_sync (플랫폼별 #[cfg] 조건부 컴파일, 단일 invoke 키) |

## 위험도 평가
| Sub-phase | Risk | Reason |
|-----------|------|--------|
| A (Agent) | Low | Phase 1-3에서 추상화 완료, 경로만 전환 |
| B (Shell) | Medium | i18n 12언어, 컴포넌트 다수, WslSetupScreen↔Rust 동기화 |
| C (Rust) | HIGH | spawn/kill/config 로직, 3 플랫폼, 바이너리 경로 |
| D (Config) | Medium | systemd/Flatpak 빌드 영향, CI 파이프라인 |
| E (Docs) | Low | 텍스트 치환 위주 |
| F (ClawHub) | Medium | 새 기능 구현 (의존성 설치기) |

## 각 Sub-phase 검증 방법
| Sub-phase | 검증 |
|-----------|------|
| A | pnpm test (agent), tsc --noEmit, grep -r "openclaw" agent/src/ = 0 |
| B | pnpm test (shell), grep -r "openclaw" shell/src/ shell/e2e-tauri/ = 0 |
| C | cargo test, cargo build, grep -r "openclaw" shell/src-tauri/src/ = 0 |
| D | grep -r "openclaw" config/ scripts/ flatpak/ = 0, systemd unit 로드 확인 |
| E | grep -r "openclaw" .agents/ .users/ --exclude-dir=releases --exclude="CHANGELOG*" = 0 |
| F | npx vitest run src/skills/__tests__/dependency-installer.test.ts, 로컬 fixture 기반 (clawhub.ai 미접속) |

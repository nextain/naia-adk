# 3층 쓰기 막기 (lead-write-guard)

3층(역할 세션)은 감시·평가·사용자 소통을 한다. 저장소 코드의 설계·구현·검증은 2층 일꾼이 한다.
이 훅은 그 경계를 장치로 건다. 규칙은 한 줄: **3층은 저장소 작업 트리 안에 쓰지 않는다.**

- 훅: `.claude/hooks/lead-write-guard.js`, 공용 판정 `.claude/hooks/lib/lead-guard.js`
- 층 프로파일 견본: `config/tier-profile.example.json` (인스턴스 실사용 설정은 `config/tier-profile.json`, 업스트림 기본 모델 이름 없음)
- 예외 대본: `scripts/lead-guard-exception.mjs`
- 시험: `.claude/hooks/lead-write-guard.test.cjs` (`scripts/adk-user-profile.test.mjs` 가 같이 부른다), `.agents/hooks/muse-pretooluse-adapter.test.cjs`
- 등록: 사용자 프로필 `templates/claude-user-profile/settings.json` · `templates/muse-user-profile/settings.json` (`adk-user-profile` 이 Claude·Muse 사용자 설정에 병합), 저장소 `.claude/settings.json` · `.muse/hooks.json`

## 옛 장치(`lead-role-guard.js`, alpha-adk)와의 차이

옛 장치는 9/28 에 만들어졌으나 등록 0건이었다. 이유와 다시 켜면 깨지는 것:

| 옛 전제 | 지금 운영 | 결과 |
|---|---|---|
| 세션이 `.agents/lead-sessions/<sid>.json` 을 **스스로 선언** | 그 폴더는 없다. 선언하지 않으면 막히지 않는다 | 막는 대상이 스스로 켜는 구조라 꺼진 채 남음 |
| 보호 경로는 `projects/naia.land` 등 제품 저장소 고정 | 서버마다 저장소가 다르다(모든 ADK 서버 동등) | ADK·문서 저장소는 대상 밖 |
| 안내문이 `review-run.mjs` → 작업보드 → agy 개발자 | 지금은 지시서 파일 → `spawn-worker.mjs` + 인스턴스 층 프로파일(`config/tier-profile.json`) 2층 명령 틀 → 결과 파일 | 안내가 현실과 안 맞음 |
| 1259줄, 검수 기록·QC·이슈 닫기까지 한 훅 | 막기만 필요 | 마찰·오탐 위험 |
| 등록 파일 수정 검증 등 자기 보호가 복잡 | 자기 보호는 경로 목록 하나로 충분 | 단순화 |

새 훅은 위 셋(선언·고정 경로·옛 안내문)을 버리고 아래 구조로 다시 만들었다. 옛 훅은 가져오지 않았다.

## 설계 원칙 (11/14 05:53Z 대표님 원문과 대응)

> 원문 (11/14 05:53Z): **"글쓰기 관련일, 명시적으로 직접 일을하라고 하는일, 긴급장애 같은건만 3층이"**

이 훅의 허용·차단 경계는 위 원문에 맞춰 나눈다.

| 원문 분류 | 구체 대상 | 장치 대응 |
|---|---|---|
| 글쓰기 관련일 | 역할 문서(`docs/common/<역할>/**`, `docs/common/team/now/<역할>.md`), 진행 기록(`.agents/progress/**`), 작업 폴더(`.agents/work/**`), 저장소 밖 지시서·결과·기억 파일 | **늘 허용** |
| 명시적으로 직접 일을하라고 하는일 | 승인자가 3층에게 직접 수정을 지시한 경우 | **비상 길(`scripts/lead-guard-exception.mjs`)로만** 허용 |
| 긴급장애 | 즉시 복구가 필요한 장애 수정 | **비상 길(범위·만료 제한 예외)로만** 허용 |

## 누가 3층인가

환경 변수(`NAIA_ROLE` 등)로 정하지 않는다. 변수 하나로 풀리는 구멍이 되기 때문이다. 두 사실만 본다.

1. 훅의 조상 중 가장 가까운 `claude` 프로세스의 **실제 시작 작업 폴더**(`/proc/<pid>/cwd`)에서 위로 올라가며
   찾은 `.naia-role.json` 이 `{"role": "<역할>", "lead_guard": {"enabled": true}}` 를 가진다. (`CLAUDE_PROJECT_DIR` 환경 변수는 실제 대화형 세션에 없을 수 있어 조상 판정에 쓰지 않으며, `claude` 조상이 없는 직접 실행 시험에서만 보조로 본다. 훅 호출 뒤 자식 셸에서 `cd` 해도 조상 `claude` 의 `/proc/<pid>/cwd` 는 안 바뀐다.)
2. 그 claude 가 `-p/--print` 가 아니고(값 옵션 `--append-system-prompt -p` 나 `--` 뒤 인자는 플래그로 오인하지 않음), 훅 입력에 `agent_id`(서브에이전트)가 없다.

표지가 없거나 `enabled` 가 아니면 3층이 아니다. **기본은 허용**이다. 2층 일꾼(작업 폴더에서 `spawn-worker.mjs` 로 띄운 외부 CLI 일꾼, 헤드리스 `claude -p`, 서브에이전트)은 통과한다.
`muse` 는 `.agents/hooks/muse-pretooluse-adapter.cjs` 로 `PreToolUse` (매처 없이 모든 도구·`multi_edit` 각 edit·`apply_patch` 각 파일·`workflow`·미지 도구 포함) 에서 같은 `lead-write-guard.js` 와 짝 관문들을 호출한다(저장소 `.muse/hooks.json`, 사용자 설정 `templates/muse-user-profile/settings.json` → 승인 후 `adk-user-profile.mjs` 로 `~/.config/muse/settings.json` 병합). 저장소 밖 폴더에서는 사용자 층(`~/.config/muse/settings.json`)만 걸리며 그 범위는 같은 층의 Claude Code 사용자 프로파일(`templates/claude-user-profile/settings.json`)과 같다. `codex·agy` 는 Claude·Muse 훅이 안 돌므로 이 훅의 대상이 아니다(3층이 `agy·codex` 인 환경은 해당 도구의 훅으로 별도 설계가 필요하다 — 미해결).
역할 폴더에 표지를 두는 일은 켜는 절차의 일부다(아래).

## 무엇이 막히나

저장소(`.git` 이 있는 작업 트리) 안 쓰기 중 허용 목록 밖. **성격: 실수 방지용(우회 가능)** — 정적 분석으로 막는 장치이며, 난독화(`eval`/`base64`)나 동적 조립까지 완전히 봉쇄하는 샌드박스가 아니다. 대상: Edit·Write·NotebookEdit·MultiEdit·apply_patch, 그리고 셸 쓰기:

- 파일·권한 변경: `>`, `>>`, `tee`, `sed/perl/ruby/awk -i`, `cp/mv/rm/truncate/shred/unlink`, `touch`, `mkdir`, `chmod/chown/chgrp`, `curl -o/-O`, `wget -O/-P`, `patch`, `rsync`, `dd of=`, `tar -x`
- git 쓰기: `apply`, `am`, `rm`, `mv`, `restore`, `clean`, `checkout`, `switch`, `merge`, `pull`, `cherry-pick`, `rebase`, `revert`, `reset --hard|--merge|--keep|--`, `stash`(`list`/`show` 제외), `commit -a`/`--all`/경로 지정
- 패키지 관리·파이프·탐색·대본: `npm/pnpm/yarn/bun install/i/ci/add/remove/uninstall/update/...`, `xargs <변경 명령>`, `find -delete`/`-exec <변경 명령>`, 지역 셸 대본(`.sh`, 1MB 이하 재귀 3단계), Python/Node/Ruby/Perl 쓰기·삭제·이름변경(`open`, `Path`, `os.remove/unlink/rmdir/rename/replace`, `shutil.*`, `fs.*` — 단 한 줄 상수 변수와 `+`/`/` 결합까지 정적 해석)

`cd` 접두와 심볼릭 링크는 실제 경로로 푼 뒤 판정한다. 읽기·`git status/log/diff/commit -m` 는 통과한다.

**허용**(저장소 안): `docs/common/<역할>/**`, `docs/common/team/now/<역할>.md`, `docs/common/team/now/<역할>/**`, `.agents/progress/**`(해당 폴더 `mkdir -p` 포함), `.agents/work/**`, 표지의 `lead_guard.allow` 글롭.
**허용(일회용 연결 worktree 전체 정리)**: `rm -rf <linked-worktree>` / `git worktree remove <linked-worktree>` 는 삭제 대상이 worktree 루트 자신(`real === repo`)이고 `.git` 이 `gitdir:` 파일이며 본 ADK 루트·역할 폴더를 포함하지 않을 때만 허용한다(worktree 내부 파일 쓰기·수정은 여전히 막힌다).
**저장소 밖은 기본 허용**: 지시서·결과 폴더(`<작업 폴더>/<일>/`), 기억 파일, 임시 파일, 디스코드 본문 임시 파일.
**자기 보호**(항상 막힘): `.naia-role.json`, `~/.claude/settings*.json`, `~/.claude/hooks`, `config/tier-profile.json`, `.agents/lead-guard/`, 표지의 `lead_guard.protect`.

안내문은 코드에 모델이나 일꾼 CLI 이름을 박아 넣지 않고 `.naia-role.json` 의 `lead_guard` 설정(`work_dir` 기본 `<작업 폴더>`, `worker_guide` 선택, `approver_label` 기본 `승인자`)과 인스턴스 층 프로파일 `config/tier-profile.json`(`NAIA_ADK_ROOT` 가 있으면 `<NAIA_ADK_ROOT>/config/tier-profile.json`, 없으면 `<ADK_ROOT>/config/tier-profile.json`)을 읽는다. 명령어 키워드로 특정 CLI 호출을 가로막는 관문은 두지 않는다.

- **설정 있음(`ok`)**: `tiers["2"].candidates` 의 우선순위대로 2층 명령 틀(`{cli}`, `{model}`, `{effort}`, `{prompt_file}`, `{work_dir}`, `{result_file}` 치환)을 표준 실행 대본에 넣어 보여 준다:
  `node scripts/worker-runner/spawn-worker.mjs --id <일> --role <역할> --work-dir <작업 폴더>/<일> --watch-dir <작업 폴더>/<일> --result-file <작업 폴더>/<일>/result.md -- <2층 1순위 명령 틀>` (2순위 이상 후보와 `max_parallel` 동시 상한이 있으면 함께 표시).
- **설정 없음(`missing`)**: 모델 이름을 지어내지 않고 `"층 프로파일 설정 없음: config/tier-profile.json 을 만드세요"` 만 안내한다.
- **설정 깨짐(`broken`)**: JSON 문법 오류, 필수 칸(`tiers.2.candidates[].cli`·`model`·`command_template`) 누락, `config/tier-profile.example.json` 의 미치환 자리표시자(`<CLI_1>`, `<TIER2_MODEL_1>` 등)가 남았을 때 `"층 프로파일 설정 깨짐(config/tier-profile.json: <사유>): 형식과 필수 칸(tiers.2.candidates[].cli·model·command_template)을 고치세요"` 만 안내한다.
또한 PreToolUse 관문(`.claude/hooks/lead-write-guard.js`, `.agents/hooks/policies/bash.js`, `.codex/hooks/session-contract-gate.cjs`, `.pi/extensions/naia-harness.ts`)은 에이전트 셸에서 일꾼 CLI(`agy`·`codex`·`claude -p`/`--print`·`muse exec`·`opencode run` 등)를 분리 실행(`nohup`, `setsid`/`setsid --fork`, `systemd-run`, `daemonize`, `at`/`batch`, `disown`, 백그라운드 `&`, `( … ) &`/`{ …; } &` 부분 셸, `bash -c`/`sh -c`, `tmux -d`/`send-keys`/`run-shell`, `screen -dm` 등)하는 명령을 가로막고, 허용된 두 표준 진입점(`scripts/worker-runner/spawn-worker.mjs` 또는 설정으로 지정된 서버 표준 어댑터 대본 경로)만 통과시킨다.
일꾼 지시서(`prompt.md`)에는 고치기 전 [상위 구조 적합 세 칸](./architecture-fit-before-fix.md)(`original_request` 최초 요구 원문 · `parent_structure` 붙는 상위 구조 · `acceptance_rationale` 받아들이는 방식)을 반드시 적는다(`review-pass` planning/development 리뷰가 세 칸 누락·견본·단일 서버만 기술을 차단한다).
막힘·예외 사용·훅 오류는 `.agents/lead-guard/audit.jsonl` 에 남는다(기기별, git 제외).

## 비상 길 (긴급 예외)

승인자가 허락한 예외만, 기록 파일 **하나**(`.agents/lead-guard/exception.json`)로 연다.

```
node scripts/lead-guard-exception.mjs open --scope <절대경로[,..]> --ttl-min <1..480> --approved-by <이름> --approval-ref "<승인자 원문 또는 링크(8자 이상)>" --reason "<이유>"
node scripts/lead-guard-exception.mjs close | status
```

- 범위는 절대 경로 3단계 이상, 최대 8시간. 만료·불량 기록은 무효(막힘으로 돌아감). 열기·닫기·사용마다 감사 기록.
- 3층이 혼자 여는 길이 없다(단 실수 방지 수준): 훅이 `lead-guard-exception` 열기/닫기 명령을 막고, 예외 파일·상태 폴더 쓰기를 막으며, 대본 자체가 **조상 claude 전부**에서 `-p` 가 아닌 3층 조상이 하나라도 있으면(3층이 띄운 일꾼 포함) 거부한다.
- 남는 위험(우회 가능): 3층이 `setsid`·tmux 등으로 프로세스 계통을 끊고 띄운 일꾼은 조상 검사를 피할 수 있다. 그 일꾼이 대신 열면
  감사 기록(`exception-open`)에 `approval_ref` 와 함께 남으므로 사후에 승인자 허락 원문과 대조한다. 훅이 `lead-guard-exception` 문자열을 막아
  단순 직접 호출은 막히지만 완전 차단은 아니다. 완전 차단은 승인자 서명 검증이 필요하며 이번 범위 밖이다.

## 켜는 절차 (3층 검수·승인 뒤, 사람이 한다)

1. 인스턴스 뿌리(`NAIA_ADK_ROOT` 또는 ADK 뿌리)에 `config/tier-profile.example.json` 을 참고해 `config/tier-profile.json` 을 만들고 자리표시자(`<CLI_1>`, `<TIER2_MODEL_1>` 등)를 실제 인스턴스 층 프로파일 값으로 채운다.
2. 역할 폴더(예: `/path/to/<역할>`)에 `.naia-role.json` 을 둔다: `{"role":"<역할>","lead_guard":{"enabled":true,"work_dir":"/path/to/work","approver_label":"<승인자>"}}`. 역할 이름은 `docs/common/<역할>/` 과 같다.
3. `node scripts/adk-user-profile.mjs apply` 로 사용자 프로필을 병합한다(Claude `~/.claude/settings.json` 과 Muse `~/.config/muse/settings.json` PreToolUse 에 훅이 등록된다; Muse 만 적용할 때는 `--target muse`). 새 claude·muse 세션부터 적용.
4. 확인: 역할 세션에서 저장소 파일 Edit → `config/tier-profile.json` 의 2층 명령 틀(설정이 없으면 설정 안내)과 함께 막히는지, 2층 일꾼은 통과하는지.

되돌리기: 역할 폴더의 `.naia-role.json` 에서 `lead_guard.enabled` 를 `false`(또는 파일 삭제) → 즉시 3층 판정이 꺼진다(훅이 안 막음).
훅 등록까지 빼려면 사용자 설정(`~/.claude/settings.json` · `~/.config/muse/settings.json`)에서 `lead-write-guard.js` 항목을 지운다. Claude 는 훅 예외 시 통과하고, Muse 어댑터는 훅 오류 시 fail-closed 로 막히지만 표지를 끄면 정상 통과한다.

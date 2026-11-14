# 3층 쓰기 막기 (lead-write-guard)

3층(역할 세션)은 감시·평가·사용자 소통을 한다. 저장소 코드의 설계·구현·검증은 2층 일꾼이 한다.
이 훅은 그 경계를 장치로 건다. 규칙은 한 줄: **3층은 저장소 작업 트리 안에 쓰지 않는다.**

- 훅: `.claude/hooks/lead-write-guard.js`, 공용 판정 `.claude/hooks/lib/lead-guard.js`
- 예외 대본: `scripts/lead-guard-exception.mjs`
- 시험: `.claude/hooks/lead-write-guard.test.cjs` (`scripts/adk-user-profile.test.mjs` 가 같이 부른다)
- 등록: 사용자 프로필 `templates/claude-user-profile/settings.json` (`adk-user-profile` 이 사용자 설정에 병합)

## 옛 장치(`lead-role-guard.js`, alpha-adk)와의 차이

옛 장치는 9/28 에 만들어졌으나 등록 0건이었다. 이유와 다시 켜면 깨지는 것:

| 옛 전제 | 지금 운영 | 결과 |
|---|---|---|
| 세션이 `.agents/lead-sessions/<sid>.json` 을 **스스로 선언** | 그 폴더는 없다. 선언하지 않으면 막히지 않는다 | 막는 대상이 스스로 켜는 구조라 꺼진 채 남음 |
| 보호 경로는 `projects/naia.land` 등 제품 저장소 고정 | 서버마다 저장소가 다르다(모든 ADK 서버 동등) | ADK·문서 저장소는 대상 밖 |
| 안내문이 `review-run.mjs` → 작업보드 → agy 개발자 | 지금은 지시서 파일 → `claude -p`/codex/agy/muse 한 줄 → 결과 파일 | 안내가 현실과 안 맞음 |
| 1259줄, 검수 기록·QC·이슈 닫기까지 한 훅 | 막기만 필요 | 마찰·오탐 위험 |
| 등록 파일 수정 검증 등 자기 보호가 복잡 | 자기 보호는 경로 목록 하나로 충분 | 단순화 |

새 훅은 위 셋(선언·고정 경로·옛 안내문)을 버리고 아래 구조로 다시 만들었다. 옛 훅은 가져오지 않았다.

## 누가 3층인가

환경 변수(`NAIA_ROLE` 등)로 정하지 않는다. 변수 하나로 풀리는 구멍이 되기 때문이다. 두 사실만 본다.

1. 훅의 조상 중 가장 가까운 `claude` 프로세스가 **시작할 때의** `CLAUDE_PROJECT_DIR`(`/proc/<pid>/environ`)에서 위로 올라가며
   찾은 `.naia-role.json` 이 `{"role": "<역할>", "lead_guard": {"enabled": true}}` 를 가진다. 명령 앞에 변수를 붙여도 이 값은 안 바뀐다.
2. 그 claude 가 `-p/--print` 가 아니고, 훅 입력에 `agent_id`(서브에이전트)가 없다.

표지가 없거나 `enabled` 가 아니면 3층이 아니다. **기본은 허용**이다. 2층 일꾼(`claude -p`, 서브에이전트)은 통과한다.
codex·agy·muse 는 Claude 훅이 안 돌므로 이 훅의 대상이 아니다(3층이 agy·muse 인 서버는 해당 도구의 훅으로 별도 설계가 필요하다 — 미해결).
역할 폴더에 표지를 두는 일은 켜는 절차의 일부다(아래).

## 무엇이 막히나

저장소(`.git` 이 있는 작업 트리) 안 쓰기 중 허용 목록 밖. 대상: Edit·Write·NotebookEdit·MultiEdit·apply_patch, 그리고 셸 쓰기
(`sed -i`, `cat >`, `tee`, `cp/mv/rm`, `python/node/ruby/perl` 의 글자 그대로 적힌 파일 쓰기, `git apply/am/rm/mv/restore/clean`,
`git checkout|reset --hard`, `patch`, `rsync`, `dd of=`, `tar -x`). `cd` 접두와 심볼릭 링크는 실제 경로로 푼 뒤 판정한다.
읽기·`git status/log/diff` 는 통과한다.

**허용**(저장소 안): `docs/common/<역할>/**`, `.agents/progress/**`, `.agents/work/**`, 표지의 `lead_guard.allow` 글롭.
**저장소 밖은 기본 허용**: 지시서·결과 폴더(`/home/nextain/work/<일>/`), 기억 파일, 임시 파일, 디스코드 본문 임시 파일.
**자기 보호**(항상 막힘): `.naia-role.json`, `~/.claude/settings*.json`, `~/.claude/hooks`, `.agents/lead-guard/`, 표지의 `lead_guard.protect`.

막히면 안내문이 나온다: "2층 일꾼에게 지시서로 맡기십시오" + 한 줄 예시
`claude -p --model sonnet "$(cat /home/nextain/work/<일>/prompt.md)" > /home/nextain/work/<일>/out.log 2>&1 &`.
막힘·예외 사용·훅 오류는 `.agents/lead-guard/audit.jsonl` 에 남는다(기기별, git 제외).

## 비상 길 (긴급 예외)

대표님이 허락한 예외만, 기록 파일 **하나**(`.agents/lead-guard/exception.json`)로 연다.

```
node scripts/lead-guard-exception.mjs open --scope <절대경로[,..]> --ttl-min <1..480> --approved-by <이름> --approval-ref "<대표님 원문 또는 링크(8자 이상)>" --reason "<이유>"
node scripts/lead-guard-exception.mjs close | status
```

- 범위는 절대 경로 3단계 이상, 최대 8시간. 만료·불량 기록은 무효(막힘으로 돌아감). 열기·닫기·사용마다 감사 기록.
- 3층이 혼자 여는 길이 없다: 훅이 `lead-guard-exception` 열기/닫기 명령을 막고, 예외 파일·상태 폴더 쓰기를 막으며, 대본 자체가
  **조상 claude 전부**를 보고 3층이 하나라도 있으면(3층이 띄운 일꾼 포함) 거부한다.
- 남는 위험(문서화): 3층이 `setsid`·tmux 등으로 프로세스 계통을 끊고 띄운 일꾼은 조상 검사를 피할 수 있다. 그 일꾼이 대신 열면
  감사 기록(`exception-open`)에 `approval_ref` 와 함께 남으므로 사후에 대표님 허락 원문과 대조한다. 훅이 `lead-guard-exception` 문자열을 막아
  직접 호출은 어렵지만 완전 차단은 아니다. 완전 차단은 대표님 승인 서명(승인 기록 검증)이 필요하며 이번 범위 밖이다.

## 켜는 절차 (3층 검수·승인 뒤, 사람이 한다)

1. 역할 폴더(예: `/home/nextain/minho`)에 `.naia-role.json` 을 둔다: `{"role":"minho","lead_guard":{"enabled":true}}`. 역할 이름은 `docs/common/<역할>/` 과 같다.
2. `node scripts/adk-user-profile.mjs` 로 사용자 프로필을 병합한다(훅이 사용자 설정 PreToolUse 에 등록된다). 새 claude 세션부터 적용.
3. 확인: 역할 세션에서 저장소 파일 Edit → 안내문과 함께 막히는지, `claude -p` 일꾼은 통과하는지.

되돌리기: 역할 폴더의 `.naia-role.json` 에서 `lead_guard.enabled` 를 `false`(또는 파일 삭제) → 즉시 3층 판정이 꺼진다(훅이 안 막음).
훅 등록까지 빼려면 사용자 설정(`~/.claude/settings.json`)에서 `lead-write-guard.js` 항목을 지운다. 훅이 예외로 끝나도 통과하는 기본 허용이므로 켠 뒤 막혀 일이 멈추는 일은 표지를 끄면 풀린다.

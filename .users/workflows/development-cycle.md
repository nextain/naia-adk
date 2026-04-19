# 경량 개발 사이클 (Development Cycle)

`.agents/workflows/development-cycle.yaml`에 대한 사람이 읽을 수 있는 가이드입니다.

## 개요

기능 변경이 아닌 **단순 변경 지시**를 위한 경량 워크플로우입니다.

### 적용 범위
- 오타 수정
- 설정값 변경
- 단순 지시 (한 줄 수정 등)
- 기능 변경이 아닌 작업

기능 단위 작업은 `issue-driven-development.yaml`을 사용하세요.

---

## 단계

### 1. Change — 읽고, 수정하고, 검증

1. 수정할 파일 읽기
2. 요청한 변경 적용
3. 변경 부분 한 번 다시 읽기 — 의도치 않은 편집/오타 없는지 확인 (1회 시각 검토)
4. 변경이 올바른지 검증 (시각적 확인 또는 테스트 실행)

**규칙:**
- 요청한 것만 최소한으로 변경
- 요청 범위를 넘는 과도한 설계나 리팩토링 금지

---

### 2. Commit — 스테이징 및 커밋

1. 관련 파일만 스테이징
2. 설명적인 커밋 메시지 작성

---

### 3. Push — 푸시 전 검증 후 푸시

1. **`git status` 실행** — 빌드에서 참조하는 파일(이미지, 폰트 등)이 모두 git 추적 중인지 확인
2. **Vercel 웹 프로젝트** (aiedu, naia, about, admin 등):
   - `pnpm build` / `npm run build` — 에러 없이 통과해야 함
   - 로컬 서버 기동 후 수정 페이지 열고 브라우저 콘솔 에러 없는지 확인
   - 위 2단계 통과 후에만 `git push`
3. **비-Vercel 프로젝트**: 커밋 후 바로 `git push`

**규칙:**
- 로컬 빌드 통과 ≠ Vercel 빌드 통과 — 파일이 로컬에 있어도 git 미추적이면 Vercel에서 ENOENT 발생
- ENOENT on Vercel = 파일은 로컬에 있지만 git에 없는 것 — 항상 git status 먼저 확인

---

## 관련 파일

- **SoT**: `.agents/workflows/development-cycle.yaml`
- **기능 단위 작업**: `.agents/workflows/issue-driven-development.yaml`

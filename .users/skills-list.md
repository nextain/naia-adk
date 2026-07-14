# Skills 목록

> **SoT**: `.agents/skills/`. 이 파일은 **사람용 단일 색인**이다.
> ⚠️ per-item 복사(`.users/skills/...`)는 하지 않는다 — 이 색인 한 장만 둔다.
> 갱신: `node scripts/gen-lists.mjs skills` (결정론 생성).

| 이름 | 파일 | 설명 |
|------|------|------|
| copyright-reg | `.agents/skills/copyright-reg/SKILL.md` | 어문저작권 등록 서류 생성. 업무상저작물 확인서 PDF(넥스테인 브랜딩) + 저작권등록신청명세서 내용란 초안을 생성합니다. "저작권 등록", "업무상저작물 확인서", "copyright" 등 요청 시 사용. |
| doc-coauthoring | `.agents/skills/doc-coauthoring/SKILL.md` | 기술 스펙, 제안서, 결정 문서, PRD 등 구조화된 문서를 3단계로 공동 작성합니다. "문서 작성", "스펙 작성", "제안서", "RFC", "설계 문서", "PRD" 등 비코드 문서 작성 요청 시 반드시 사용. /doc-coauthoring으로 호출. |
| finetune-persona | `.agents/skills/finetune-persona/SKILL.md` | > |
| manage-skills | `.agents/skills/manage-skills/SKILL.md` | 세션 변경사항을 분석해 verify-* 스킬 드리프트를 탐지하고 자동 생성/업데이트합니다. issue-driven-development Sync 단계, 새 패턴/규칙 도입 후, PR 전 검증 스킬 커버리지 확인 시 반드시 사용. /manage-skills로 호출. |
| merge-worktree | `.agents/skills/merge-worktree/SKILL.md` | Squash-merge the current worktree branch into the main branch (or a specified target). Analyzes git history and source code to craft a comprehensive commit mess |
| migrate-ctx | `.agents/skills/migrate-ctx/SKILL.md` | > |
| patent-draft | `.agents/skills/patent-draft/SKILL.md` | 특허 초안 생성 요청 시 반드시 사용. KIPO(한국특허청) 전자출원 양식 기반 특허 명세서 초안을 생성한다. 코드 분석 결과, 발명 아이디어, 또는 기존 기술 설명으로부터 출원 가능한 명세서 초안을 작성. "특허", "patent", "출원", "명세서", "청구항" 키워드 시 트리거 |
| patent-pipeline | `.agents/skills/patent-pipeline/SKILL.md` | 코드베이스 기반 AI 자동 특허 발굴·평가·출원 파이프라인. "특허", "가출원", "patent", "발명 발굴" 등 특허 관련 작업 요청 시 반드시 사용. /patent-pipeline으로 호출. |
| payroll | `.agents/skills/payroll/SKILL.md` | 급여명세서 PDF 생성 + 이메일 발송. 급여 데이터를 받아 A4 PDF를 만들고 각 사원에게 이메일로 발송합니다. "급여명세서", "급여 보내기", "payroll" 등 급여 관련 요청 시 사용. |
| press-release | `.agents/skills/press-release/SKILL.md` | 보도자료 작성·기자 조사·개인화 발송·결과 수집·인사이트 도출 전체 워크플로우. "보도자료", "press release", "기자 발송", "PR 배포" 요청 시 사용. |
| project-create | `.agents/skills/project-create/SKILL.md` | > |
| project-migration | `.agents/skills/project-migration/SKILL.md` | > |
| read-doc | `.agents/skills/read-doc/SKILL.md` | 문서 파일(HWP/HWPX/PDF/DOCX/XLSX/PPTX)의 텍스트를 추출해 컨텍스트에 로드합니다. docs-business/ 폴더의 파일이나 .hwp/.hwpx/.pdf/.docx/.xlsx/.pptx 파일이 언급될 때, 또는 문서 내용을 검토/분석해야 할 때 반드시 사용. |
| review-pass | `.agents/skills/review-pass/SKILL.md` | > |
| secret-vault | `.agents/skills/secret-vault/SKILL.md` | age 암호화 시크릿 볼트(`key.age` + 평문 `key/`)를 열고·수정하고·다시 잠글 때 반드시 사용. data-private 등 "암호화된 키 파일을 어떻게 푸는가", "키를 추가하고 다시 암호화", "복호화가 깨져 보인다", "key.age unlock/lock" 요청 시 |
| verify-contract-conformance | `.agents/skills/verify-contract-conformance/SKILL.md` | 계약(선언된 API/인터페이스)과 코드 구현 사이의 드리프트를 결정론으로 검출합니다. 시그니처 드리프트·계약만 선언(미구현)·코드만 존재(미문서)를 잡아 "게이트는 통과하는데 계약과 분기한 가짜 성공"을 차단. 기능 구현 후·PR 전·마이그레이션 시·issue-driven-develop |
| verify-implementation | `.agents/skills/verify-implementation/SKILL.md` | 등록된 모든 verify-* 스킬을 순차 실행해 통합 검증 보고서를 생성합니다. 기능 구현 후, PR 전, 코드 리뷰 시, issue-driven-development Review/Post-test Review 단계마다 반드시 사용. /verify-implementation으로 호출. |
| webapp-testing | `.agents/skills/webapp-testing/SKILL.md` | Playwright로 로컬 웹 앱을 테스트합니다. naia.nextain.io, about.nextain.io, aiedu.nextain.io 등 Next.js 앱의 E2E 테스트, UI 동작 검증, 스크린샷 캡처, 콘솔 로그 확인 시 반드시 사용. 사용자에게 수동 테스트를 시키지 말고 |
| weekly-report | `.agents/skills/weekly-report/SKILL.md` | 주간 업무 결과를 git 커밋과 작업 로그에서 수집해 작성합니다. "주간 업무 결과", "결과 작성", "이번 주 뭐 했는지" 등 주간 보고 요청 시 사용. |
| youtube-upload | `.agents/skills/youtube-upload/SKILL.md` | YouTube에 영상을 자막·썸네일·제목/설명/태그까지 자동 업로드할 때 반드시 사용. 밋업/발표/콘텐츠 영상을 YouTube Data API v3로 올린다. "유튜브 올려", "youtube 업로드", "영상 게시" 등 요청 시 사용. |

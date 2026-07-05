---
name: youtube-upload
description: YouTube에 영상을 자막·썸네일·제목/설명/태그까지 자동 업로드할 때 반드시 사용. 밋업/발표/콘텐츠 영상을 YouTube Data API v3로 올린다. "유튜브 올려", "youtube 업로드", "영상 게시" 등 요청 시 사용.
license: Apache-2.0
---

# YouTube Upload

## 목적

YouTube Data API v3로 영상 + 자막(srt) + 썸네일 + 메타(제목/설명/태그)를 한 번에 자동 업로드한다. 한국어 자막을 올리면 유튜브가 100여 개 언어로 자동 번역한다. 정기 콘텐츠 업로드에 재사용.

> 인증 파일은 사용자 홈의 `.youtube/` 폴더에 둔다(`client_secret.json`, `token.json`). ADK 루트 밖이며 절대 커밋 금지.

## 사전 준비 (1회만)

1. **Google Cloud Console** → "YouTube Data API v3" 사용 설정
2. **OAuth 동의 화면** 구성 → 본인 유튜브 계정을 **테스트 사용자**로 추가 (미검증 앱 필수)
3. **사용자 인증 정보** → **OAuth 클라이언트 ID** → **데스크톱 앱** → `client_secret.json` 다운로드 → 홈의 `.youtube/` 폴더에 배치
4. 인증 실행: `python scripts/youtube_auth.py` — 브라우저 로그인 1회 → 홈의 `.youtube/token.json` 저장

## 워크플로우

### Step 1: 메타 파일 준비
`description.md` 에 아래 섹션으로 작성 (스킬이 파싱):
```
## 제목
영상 제목 한 줄
## 설명
여러 줄 설명 + 챕터(00:00 ...) + 링크
## 태그
태그1, 태그2, 태그3
```

### Step 2: 업로드
```bash
python scripts/youtube_upload.py \
  --video final.mp4 --srt ko.srt --thumb thumb.jpg \
  --desc description.md --privacy unlisted
```
**처음엔 `--privacy unlisted`** 로 올려 검토 후 유튜브 스튜디오에서 public 전환.

## Key Files

| 파일 | 용도 |
|------|------|
| `scripts/youtube_auth.py` | OAuth 인증 (1회, 브라우저 로그인) |
| `scripts/youtube_upload.py` | 영상+자막+썸네일+메타 업로드 |

## 참고

- 인증 파일(홈의 `.youtube/`)은 **절대 커밋 금지** (개인 인증 정보)
- 자막 srt(한국어)가 유튜브 다국어 자동 번역의 소스가 된다
- 의존성: `pip install --user google-api-python-client google-auth-oauthlib`
- category 28 = Science & Technology (기본)

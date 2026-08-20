---
name: youtube-upload
description: YouTube에 영상을 자막·썸네일·제목/설명/태그까지 자동 업로드할 때 반드시 사용. 밋업/발표/콘텐츠 영상을 YouTube Data API v3로 올린다. "유튜브 올려", "youtube 업로드", "영상 게시" 등 요청 시 사용.
license: Apache-2.0
---

# YouTube Upload

## 목적

YouTube Data API v3로 영상 + 자막(srt) + 썸네일 + 메타(제목/설명/태그)를 한 번에 자동 업로드한다. 한국어 자막을 올리면 유튜브가 100여 개 언어로 자동 번역한다. 정기 콘텐츠 업로드에 재사용.

> 인증 파일은 사용자 홈의 `.youtube/` 폴더에 둔다(`client_secret.json`, `token.json`). ADK 루트 밖이며 절대 커밋 금지.

## 사전 준비

두 갈래다. **OAuth 클라이언트를 한 번도 만든 적이 없으면** 아래 "처음 만들 때"를,
**다른 PC 에서 이미 쓰고 있으면** "다른 PC 에서 이어 쓸 때"를 따른다. 뒤엣것을
모르면 새 기계마다 Console 을 다시 거치게 되고, 실제로 그렇게 막힌 적이 있다.

### 처음 만들 때 (계정당 1회)

1. **Google Cloud Console** → "YouTube Data API v3" 사용 설정
2. **OAuth 동의 화면** 구성 → 본인 유튜브 계정을 **테스트 사용자**로 추가 (미검증 앱 필수)
3. **사용자 인증 정보** → **OAuth 클라이언트 ID** → **데스크톱 앱** → `client_secret.json` 다운로드
4. 홈의 `.youtube/` 폴더에 배치
5. **볼트에도 넣는다** — `data-private` 의 `key/youtube-client-secret.json` 으로
   복사한 뒤 다시 잠근다(`secret-vault` 스킬). 이 한 번이 다음 기계를 살린다.
6. 인증 실행: `python scripts/youtube_auth.py` — 브라우저 로그인 1회 → 홈의 `.youtube/token.json` 저장

### 다른 PC 에서 이어 쓸 때 (기계당 1회)

1. `data-private` 볼트를 연다(`secret-vault` 스킬, 비밀번호는 사람이 직접 입력).
2. `key/youtube-client-secret.json` → 그 PC 홈의 `.youtube/client_secret.json` 으로 복사.
3. `python scripts/youtube_auth.py` — 브라우저 로그인 1회. `token.json` 은 기계마다
   새로 만든다. 토큰은 볼트에 넣지 않는다 — 클라이언트는 앱 식별자지만 토큰은
   계정 접근 그 자체다.

Console 을 다시 거칠 필요는 없다. 클라이언트는 앱 하나에 하나면 된다.

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
| `scripts/youtube_auth.py` | OAuth 인증 (기계당 1회, 브라우저 로그인) |
| `scripts/youtube_upload.py` | 영상+자막+썸네일+메타 업로드 |
| `scripts/youtube_privacy.py` | 올린 뒤 공개범위 전환 (unlisted → public 등) |

공개범위 전환은 스튜디오에서 손으로 해도 되지만, 여러 개를 한꺼번에 바꿀 때는
스크립트가 낫다. 현재 상태를 먼저 읽어 `madeForKids` 같은 다른 필드를 보존하고
`privacyStatus` 만 바꾼다.

```bash
python scripts/youtube_privacy.py --ids VIDEO_ID1 VIDEO_ID2 --privacy public
```

## 참고

- 인증 파일(홈의 `.youtube/`)은 **절대 커밋 금지**. 공유는 볼트로만 한다.
- 링크로 돌려 볼 영상은 `unlisted`(일부 공개)다. `private`(비공개)는 지정한 Google
  계정만 볼 수 있어 링크를 받아도 열리지 않는다.
- 자막 srt(한국어)가 유튜브 다국어 자동 번역의 소스가 된다
- 의존성: `pip install --user google-api-python-client google-auth-oauthlib`
- category 28 = Science & Technology (기본)

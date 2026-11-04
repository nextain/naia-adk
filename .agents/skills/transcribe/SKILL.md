---
name: transcribe
description: 소리·영상 파일을 글이나 자막(srt·vtt)으로 받아쓸 때 반드시 사용. "받아쓰기", "받아써", "자막 뽑아", "대사 시각", "회의 녹음 글로", "영상 대사 확인", "음성 인식", "STT", "transcribe" 요청이나, 쇼츠·영상 대사가 원고와 맞는지 시각까지 확인할 때 쓴다. 기본은 게이트웨이(any-llm 호환, /v1/audio/transcriptions; 서버별 열쇠로 크레딧 차감), 자막·화자 구분은 애저 AI 서비스 직접(애저 크레딧). 바깥 유료 API 는 쓰지 않는다.
license: Apache-2.0
---

# 받아쓰기 (transcribe)

범위: 공통. 인스턴스 값(애저 지역·계정, 게이트웨이 주소, 열쇠 환경 변수 이름)은 저장소 뿌리의 `config/transcribe.json` 에만 둔다(예시: `config.example.json`).

## 길 두 개

| 길 | 언제 | 과금 | 돌려주는 것 |
|---|---|---|---|
| `gateway` | 기본. 글만 필요할 때, 그 서버의 게이트웨이 열쇠가 있을 때 | 게이트웨이 계정 크레딧(서버별로 잡힘) | 글·길이·비용 |
| `azure` | 자막(srt·vtt)·json·화자 구분, 또는 게이트웨이 열쇠가 없을 때 | 애저 AI 서비스 계정(서비스 크레딧) | 구절별 시각·화자·글 |

이 어댑터의 게이트웨이 `/v1/audio/transcriptions` 경로는 글 응답을 처리한다. 구절 시각을 돌려주게 되면 자막도 게이트웨이로 옮긴다.

## 명령

```bash
T=.agents/skills/transcribe/scripts/transcribe.mjs

node $T 회의.m4a                               # 글(기본 한국어)
node $T 쇼츠.mp4 --format srt --out 쇼츠.srt     # 영상 → 자막(영상은 ffmpeg 로 소리만 뽑아 보냄)
node $T 인터뷰.wav --diarize 2 --format vtt      # 화자 둘 구분
node $T a.wav b.wav --locale ko-KR,en-US        # 여러 파일, 두 언어 섞임
node $T a.wav --backend azure --format json     # 원본 응답 그대로
```

- 시작할 때 고른 길과 까닭을 한 줄(stderr), 끝날 때 길이·비용을 한 줄 알린다.
- 열쇠: 게이트웨이는 환경 변수(`gateway.key_env`). 애저는 환경 변수(`key_env`)가 없으면 `az` 로그인 권한으로 그때그때 받는다. 어느 열쇠도 화면·파일에 쓰지 않는다.
- 소리 파일이 아닌 것(mp4·mov 등)은 16kHz 한 채널 wav 로 바꿔 보낸다. 바꾼 파일은 끝나면 지운다.
- 한 파일 한도는 애저 빠른 받아쓰기 기준(2시간·300MB 안쪽). 더 길면 ffmpeg 로 나눠 보낸다.

## 서버별 크레딧

서버(인스턴스)마다 게이트웨이 열쇠를 따로 두어야 사용량이 서버별로 잡힌다. 열쇠 발급은 게이트웨이 운영 변경이라 그 인스턴스의 운영 승인 절차를 따른다. 열쇠가 없는 동안은 `azure` 길로 돌고, 사용량은 애저 계정에 합쳐 잡힌다.

## 앱(셸) 안에서

이 스킬은 서버·작업 공간용이다. 앱 안의 듣기는 기기에서 되는 것부터 고른다: 브라우저 듣기가 있는 기기는 그것 먼저(무료), 없으면 로컬 모델(GPU·CPU), 둘 다 안 되면 게이트웨이. 리눅스 웹킷 셸에는 브라우저 듣기가 없다.

시험: `node --test .agents/skills/transcribe/scripts/transcribe.test.mjs`

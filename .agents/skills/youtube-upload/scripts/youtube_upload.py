#!/usr/bin/env python3
"""YouTube 업로드 — 영상 + 자막(srt) + 썸네일 + 메타(제목/설명/태그).

사전: python youtube_auth.py 로 ~/.youtube/token.json 생성.
실행:
  python youtube_upload.py --video final.mp4 --srt ko.srt --thumb thumb.jpg \
    --desc description.md --privacy unlisted
"""
import os
import re
import sys
import argparse
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
TOKEN = os.path.expanduser("~/.youtube/token.json")


def parse_desc(path):
    """description.md → (title, description, tags). ## 제목/## 설명/## 태그 섹션 파싱."""
    text = open(path, encoding="utf-8").read()

    def section(*names):
        for name in names:
            m = re.search(rf"^##\s*{re.escape(name)}\s*\n(.*?)(?=\n##\s|\Z)", text, re.S | re.M)
            if m:
                return m.group(1).strip()
        return ""

    title_block = section("제목", "Title")
    title = title_block.splitlines()[0].strip() if title_block else "Untitled"
    description = section("설명", "Description")
    tags_line = section("태그", "Tags")
    tags = [t.strip() for t in re.split(r"[,\n]", tags_line) if t.strip()][:30]
    return title, description, tags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--srt")
    ap.add_argument("--thumb")
    ap.add_argument("--desc", required=True)
    ap.add_argument("--privacy", default="unlisted", choices=["private", "unlisted", "public"])
    ap.add_argument("--lang", default="ko")
    ap.add_argument("--category", default="28")  # Science & Technology
    a = ap.parse_args()

    if not os.path.exists(TOKEN):
        sys.exit("token.json 없음 — 먼저 `python youtube_auth.py` 실행")
    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    yt = build("youtube", "v3", credentials=creds)

    title, description, tags = parse_desc(a.desc)
    print(f"제목: {title}\n태그: {', '.join(tags)}\n공개범위: {a.privacy}\n업로드 시작...")

    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": a.category,
            "defaultLanguage": a.lang,
        },
        "status": {"privacyStatus": a.privacy, "selfDeclaredMadeForKids": False},
    }
    media = MediaFileUpload(a.video, chunksize=1024 * 1024 * 8, resumable=True)
    req = yt.videos().insert(part="snippet,status", body=body, media_body=media)
    resp = None
    while resp is None:
        status, resp = req.next_chunk()
        if status:
            print(f"  업로드 {int(status.progress() * 100)}%")
    vid = resp["id"]
    print(f"✓ 영상 업로드: https://youtu.be/{vid}")

    # 자막 먼저 (썸네일 실패가 자막을 막지 않도록)
    if a.srt and os.path.exists(a.srt):
        yt.captions().insert(
            part="snippet",
            body={"snippet": {"videoId": vid, "language": a.lang, "name": "Korean", "isDraft": False}},
            media_body=MediaFileUpload(a.srt),
        ).execute()
        print("✓ 자막 업로드 (유튜브 다국어 자동번역 소스)")

    if a.thumb and os.path.exists(a.thumb):
        try:
            yt.thumbnails().set(videoId=vid, media_body=MediaFileUpload(a.thumb)).execute()
            print("✓ 썸네일 설정")
        except Exception as e:
            print(f"⚠️ 썸네일 실패(채널 전화 인증 필요할 수 있음, 영상·자막은 정상): {str(e)[:120]}")

    print(f"\n검토 → https://studio.youtube.com/video/{vid}/edit  (검토 후 공개로 전환)")


if __name__ == "__main__":
    main()

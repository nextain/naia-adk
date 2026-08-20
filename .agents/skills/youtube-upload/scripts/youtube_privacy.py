#!/usr/bin/env python3
"""YouTube 공개범위(privacy) 전환 — unlisted/private → public 등.

현재 status 를 fetch 해 madeForKids 등 다른 필드를 보존하며 privacyStatus 만 변경.
사전: youtube_auth.py 로 ~/.youtube/token.json 생성(force-ssl scope 포함).
실행:
  python youtube_privacy.py --ids VIDID1 VIDID2 --privacy public
"""
import os
import sys
import argparse
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
TOKEN = os.path.expanduser("~/.youtube/token.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", nargs="+", required=True, help="영상 ID 목록")
    ap.add_argument("--privacy", default="public", choices=["private", "unlisted", "public"])
    a = ap.parse_args()

    if not os.path.exists(TOKEN):
        sys.exit("token.json 없음 — 먼저 `python youtube_auth.py` 실행")
    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    yt = build("youtube", "v3", credentials=creds)

    resp = yt.videos().list(part="snippet,status", id=",".join(a.ids)).execute()
    found = {item["id"]: item for item in resp.get("items", [])}
    missing = [v for v in a.ids if v not in found]
    if missing:
        print(f"⚠️ 찾을 수 없음: {', '.join(missing)}")

    for vid in a.ids:
        item = found.get(vid)
        if not item:
            continue
        status = item["status"]
        old = status.get("privacyStatus")
        title = item["snippet"].get("title", "")[:50]
        if old == a.privacy:
            print(f"= {vid}  이미 {a.privacy}  ({title})")
            continue
        status["privacyStatus"] = a.privacy
        yt.videos().update(part="status", body={"id": vid, "status": status}).execute()
        print(f"✓ {vid}  {old} → {a.privacy}  ({title})  https://youtu.be/{vid}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""YouTube OAuth 인증 — 1회 실행(브라우저 로그인). ~/.youtube/token.json 저장.

사전: ~/.youtube/client_secret.json (Google Cloud Console → OAuth 데스크톱 클라이언트).
실행: python youtube_auth.py
"""
import os
import sys
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
HOME = os.path.expanduser("~/.youtube")
CLIENT = os.path.join(HOME, "client_secret.json")
TOKEN = os.path.join(HOME, "token.json")


def main():
    os.makedirs(HOME, exist_ok=True)
    if not os.path.exists(CLIENT):
        sys.exit(
            f"client_secret.json 없음: {CLIENT}\n"
            "Google Cloud Console → YouTube Data API v3 → OAuth 데스크톱 클라이언트를 만들어\n"
            "client_secret.json 을 위 경로에 두세요."
        )
    flow = InstalledAppFlow.from_client_secrets_file(CLIENT, SCOPES)
    creds = flow.run_local_server(port=0)
    with open(TOKEN, "w", encoding="utf-8") as f:
        f.write(creds.to_json())
    print(f"✓ 인증 완료. 토큰 저장: {TOKEN}")


if __name__ == "__main__":
    main()

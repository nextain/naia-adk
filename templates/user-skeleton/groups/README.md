# 속한 그룹 (`groups/`)

같은 기기에 그룹 ADK 가 있으면 여기에 상대 소프트링크로 붙입니다.

```bash
node scripts/adk-link.mjs --link --from <사용자 ADK> --to <그룹 ADK>
```

명령은 `groups/<그룹 식별자>` 링크와 `adk.json` 의 `links[]` 항목을 함께 만듭니다. 링크를 따라 그룹의 `keys/` 를 읽거나 복사하지 않습니다.

# 명령어

## 실행

```bash
pnpm dev          # 로컬 실행 (.env 자동 로드)
pnpm start        # CI 실행 (환경변수 외부 주입)
```

## 환경변수

| 변수 | 설명 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 알림 받을 채팅/그룹 ID |
| `TARGET_DATE` | (선택) 특정 날짜만 체크 `YYYYMMDD` |

## 상태 초기화

```bash
rm -f state.json   # 모든 상영을 "새 상영"으로 다시 인식
```

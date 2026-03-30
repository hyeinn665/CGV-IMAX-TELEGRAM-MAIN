# 프로젝트 구조

```
cgv-imax-telegram/
├── src/
│   └── index.ts              # 메인 스크립트 (API 조회 → IMAX 필터 → 텔레그램 전송)
├── .github/
│   └── workflows/
│       └── imax-check.yml    # GitHub Actions cron (15분 간격, KST 07:00~02:00)
├── .env                      # 로컬 환경변수 (git 제외)
├── .env.example              # 환경변수 템플릿
├── state.json                # 알림 발송 이력 (git에 커밋하여 Actions 간 유지)
├── package.json
├── tsconfig.json
└── pnpm-lock.yaml
```

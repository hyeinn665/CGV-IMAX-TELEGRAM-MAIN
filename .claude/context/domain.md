# CGV API 도메인 지식

## API 엔드포인트

베이스 URL: `https://api.cgv.co.kr`

| 엔드포인트 | 용도 |
|-----------|------|
| `/cnm/atkt/searchMovScnInfo` | 특정 극장+날짜의 전체 상영 정보 |
| `/cnm/atkt/searchSiteScnscYmdListBySite` | 극장의 예매 가능한 날짜 목록 |
| `/cnm/atkt/searchLastScnDay` | 마지막 상영일 |

### 주요 파라미터

- `coCd`: 회사코드 (`A420` 고정)
- `siteNo`: 극장코드 (`0013` = 용산아이파크몰)
- `scnYmd`: 상영일 (`YYYYMMDD`)
- `rtctlScopCd`: `08` 고정

### 응답 데이터 주요 필드

| 필드 | 설명 | 예시 |
|------|------|------|
| `movNo` | 영화 번호 | `30000994` |
| `movNm` | 영화명 | `프로젝트 헤일메리` |
| `scnsNm` | 상영관명 | `IMAX관` |
| `movkndDsplEnm` | 상영 포맷 | `IMAX LASER 2D` |
| `scnsrtTm` | 시작시간 | `0930` |
| `scnendTm` | 종료시간 | `1216` |
| `frSeatCnt` | 잔여좌석 | `203` |
| `stcnt` | 총좌석 | `624` |

## HMAC 인증

CGV API는 요청마다 HMAC-SHA256 서명이 필요.

- **헤더**: `X-TIMESTAMP`, `X-SIGNATURE`
- **서명 방식**: `HmacSHA256("{timestamp}|{pathname}|{body}", HMAC_KEY)` → Base64
- **HMAC 키**: CGV 프론트엔드 JS 번들에 하드코딩 (클라이언트 공개 키)
  - 소스 위치: `_next/static/chunks/1453-*.js` 내 `fetch.ts` 인터셉터 모듈
- **키 로테이션**: CGV가 사이트를 재배포하면 키가 변경될 수 있음

## IMAX 판별 기준

다음 중 하나라도 해당하면 IMAX 상영으로 분류:
- `scnsNm`(상영관명)에 "IMAX" 포함
- `movkndDsplEnm`(상영 포맷)에 "IMAX" 포함

## 차단 대응

### HMAC 키 변경 시 (401 Unauthorized)
1. 텔레그램으로 에러 알림이 자동 발송됨
2. CGV 사이트(`cgv.co.kr`) 접속 → DevTools Network 탭
3. `api.cgv.co.kr` 요청의 `X-SIGNATURE` 헤더 확인
4. 또는 JS 번들에서 `HmacSHA256` 검색하여 새 키 추출
5. `src/index.ts`의 `HMAC_KEY` 상수 업데이트

### IP 차단 시
- GitHub Actions는 매 실행마다 IP가 바뀌므로 가능성 낮음
- 15분 간격 × 14일치 = 실행당 ~14 API 호출로 적절한 수준

## 딥링크

영화별 예매 페이지 (앱 설치 시 CGV 앱에서 열림):
```
https://cgv.co.kr/cnm/movieBook/movie?movNo={movNo}&siteNo={siteNo}&siteNm={siteNm}&scnYmd={scnYmd}
```

지원 파라미터: `movNo`, `siteNo`, `siteNm`, `scnYmd`, `custNo`, `eventYn`, `scnsNo`, `scnSseq`

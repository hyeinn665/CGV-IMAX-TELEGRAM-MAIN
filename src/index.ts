import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, Page } from 'playwright';

// ─── 설정 ────────────────────────────────────────────────────────────────────
const THEATER_CODE = '0013'; // 용산아이파크몰 CGV
const CO_CD = 'A420';
const STATE_FILE = path.join(process.cwd(), 'state.json');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

/**
 * TARGET_DATE: "20260410" 형식. 미설정 시 API에서 반환하는 상영일 전체 체크.
 * 예: 특정 영화 예매 오픈을 기다릴 때 날짜 고정.
 */
const TARGET_DATE = process.env.TARGET_DATE ?? null;

// ─── 타입 ────────────────────────────────────────────────────────────────────
interface Showing {
  date: string; // "20260410"
  movie: string; // "프로젝트 헤일메리"
  times: string[]; // ["09:30", "12:40", "15:50"]
  screen: string; // "IMAX관"
  movNo: string; // "30000994"
}

interface State {
  notified: string[]; // `${date}_${movie}_${times.join(",")}` 형태 키
  lastChecked: string;
}

// ─── Playwright 브라우저 ──────────────────────────────────────────────────────
let _cgvPage: Page | null = null;

async function initBrowser(): Promise<void> {
  console.log('🌐 Playwright 브라우저 초기화 중...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  _cgvPage = await context.newPage();
  // cgv.co.kr 방문으로 Cloudflare __cf_bm 쿠키 취득 (페이지는 유지)
  await _cgvPage.goto('https://www.cgv.co.kr', { waitUntil: 'networkidle', timeout: 30_000 });
  console.log('✅ 브라우저 초기화 완료 (Cloudflare 쿠키 취득)');
}

async function closeBrowser(): Promise<void> {
  await _cgvPage?.context().browser()?.close();
  _cgvPage = null;
}

// ─── CGV API 인증 ─────────────────────────────────────────────────────────────
const HMAC_KEY = 'ydqXY0ocnFLmJGHr_zNzFcpjwAsXq_8JcBNURAkRscg';

function makeSignature(pathname: string, body: string, timestamp: string) {
  const message = `${timestamp}|${pathname}|${body}`;
  return crypto
    .createHmac('sha256', HMAC_KEY)
    .update(message)
    .digest('base64');
}

async function cgvApi<T>(pathname: string, query: string): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = makeSignature(pathname, '', timestamp);
  const url = `https://api.cgv.co.kr${pathname}${query}`;

  console.log(`[cgvApi] ${pathname} | timestamp=${timestamp} | sig=${signature.slice(0, 10)}...`);

  // Chrome 브라우저 내부에서 fetch — CF TLS 핑거프린트 + 쿠키 그대로 사용
  const result = await _cgvPage!.evaluate(
    async ({ url, timestamp, signature }: { url: string; timestamp: string; signature: string }) => {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'ko-KR',
          'X-TIMESTAMP': timestamp,
          'X-SIGNATURE': signature,
        },
      });
      const body = await res.text();
      return { status: res.status, body };
    },
    { url, timestamp, signature },
  );

  if (result.status !== 200) {
    console.error(`[cgvApi] HTTP ${result.status}:`, result.body.slice(0, 300));
    throw new Error(`CGV API HTTP ${result.status}`);
  }

  const data = JSON.parse(result.body) as { statusCode: number; statusMessage: string; data: T };

  if (data.statusCode !== 0) {
    throw new Error(`CGV API 오류: ${data.statusMessage}`);
  }

  return data.data;
}

// ─── 상태 관리 ────────────────────────────────────────────────────────────────
function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) return { notified: [], lastChecked: '' };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

function saveState(state: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function makeKey(s: Showing) {
  const timesOnly = s.times.map((t) => t.replace(/\(.*\)/, ''));
  return `${s.date}_${s.movie}_${timesOnly.join(',')}`;
}

// ─── CGV API 조회 ─────────────────────────────────────────────────────────────
interface CgvScheduleItem {
  scnYmd: string;
  movNo: string;
  movNm: string;
  scnsNm: string;
  scnsrtTm: string;
  scnendTm: string;
  movkndDsplEnm: string;
  frSeatCnt: string;
  stcnt: string;
}

async function fetchImaxShowings(date: string): Promise<Showing[]> {
  const items = await cgvApi<CgvScheduleItem[]>(
    '/cnm/atkt/searchMovScnInfo',
    `?coCd=${CO_CD}&siteNo=${THEATER_CODE}&scnYmd=${date}&scnsNo=&scnSseq=&rtctlScopCd=08&custNo=`,
  );

  // IMAX 상영만 필터
  const imaxItems = items.filter(
    (s) =>
      s.scnsNm?.toUpperCase().includes('IMAX') ||
      s.movkndDsplEnm?.toUpperCase().includes('IMAX'),
  );

  // 영화+상영관별로 시간 그룹핑
  const grouped = new Map<string, Showing>();
  for (const s of imaxItems) {
    const key = `${s.movNm}__${s.scnsNm}`;
    const time = `${s.scnsrtTm.slice(0, 2)}:${s.scnsrtTm.slice(2)}(${s.frSeatCnt}/${s.stcnt}석)`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        date,
        movie: `${s.movNm} (${s.movkndDsplEnm})`,
        times: [time],
        screen: s.scnsNm,
        movNo: s.movNo,
      });
    } else {
      grouped.get(key)!.times.push(time);
    }
  }

  return [...grouped.values()];
}

interface CgvDateItem {
  scnYmd: string;
}

async function getDatesToCheck(): Promise<string[]> {
  if (TARGET_DATE) return [TARGET_DATE];

  const dates = await cgvApi<CgvDateItem[]>(
    '/cnm/atkt/searchSiteScnscYmdListBySite',
    `?coCd=${CO_CD}&siteNo=${THEATER_CODE}`,
  );

  return dates.map((d) => d.scnYmd);
}

// ─── 텔레그램 발송 ─────────────────────────────────────────────────────────────
async function sendTelegram(showings: Showing[]) {
  if (showings.length === 0) return;

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  const lines = showings.map((s) => {
    const y = s.date.slice(0, 4);
    const m = s.date.slice(4, 6);
    const d = s.date.slice(6, 8);
    const dow = dayNames[new Date(`${y}-${m}-${d}`).getDay()];

    const timeLines = s.times
      .map((t) => `    ${escMd(t)}`)
      .join('\n');

    const bookUrl =
      `https://cgv.co.kr/cnm/movieBook/movie?movNo=${s.movNo}` +
      `&siteNo=${THEATER_CODE}` +
      `&siteNm=${encodeURIComponent('CGV 용산아이파크몰')}` +
      `&scnYmd=${s.date}`;

    return (
      `🎬 *${escMd(s.movie)}*\n` +
      `📅 ${escMd(`${m}.${d}`)}\\(${escMd(dow)}\\)  \\|  🎭 ${escMd(s.screen)}\n\n` +
      `${timeLines}\n\n` +
      `🔗 [예매하기](${bookUrl})`
    );
  });

  const text =
    `🚨 *CGV 용산 IMAX 새 상영 알림*\n\n` + lines.join('\n\n━━━━━━━━━━━━━━\n\n');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: CHAT_ID,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: false,
        },
      );
      console.log(`✅ 텔레그램 전송 완료 (${showings.length}건)`);
      return;
    } catch (err) {
      console.error(
        `  ⚠️ 텔레그램 전송 실패 (${attempt}/3):`,
        (err as Error).message,
      );
      if (attempt < 3) await sleep(attempt * 1000);
    }
  }

  throw new Error('텔레그램 전송 3회 실패');
}

async function sendTelegramError(message: string) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: `⚠️ CGV IMAX 알리미 오류\n\n${message}`,
      },
    );
  } catch {
    // 에러 알림 전송 자체가 실패하면 무시
  }
}

// MarkdownV2 이스케이프
function escMd(s: string) {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`⏰ 체크 시작: ${new Date().toISOString()}`);

  await initBrowser();

  try {
    const state = loadState();
    const dates = await getDatesToCheck();
    console.log(`🎯 대상 날짜: ${dates.length}일 (${dates[0]} ~ ${dates[dates.length - 1]})`);

    const newShowings: Showing[] = [];

    for (const date of dates) {
      console.log(`  📆 ${date} 조회 중...`);
      try {
        const showings = await fetchImaxShowings(date);
        console.log(`     → IMAX 상영 ${showings.length}건 발견`);

        for (const s of showings) {
          const key = makeKey(s);
          if (!state.notified.includes(key)) {
            newShowings.push(s);
            state.notified.push(key);
          }
        }

        await sleep(300);
      } catch (err) {
        console.error(`  ❌ ${date} 조회 실패:`, (err as Error).message);
      }
    }

    if (newShowings.length > 0) {
      console.log(`📨 새 상영 ${newShowings.length}건 → 텔레그램 전송`);
      await sendTelegram(newShowings);
    } else {
      console.log('🔇 새로운 IMAX 상영 없음');
    }

    state.lastChecked = new Date().toISOString();

    // 30일 이전 키 정리 (state.json 비대화 방지)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');
    state.notified = state.notified.filter((k) => k.slice(0, 8) >= cutoffStr);

    saveState(state);
    console.log('💾 상태 저장 완료');
  } finally {
    await closeBrowser();
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(async (err) => {
  console.error('💥 치명적 오류:', err);
  await closeBrowser();
  await sendTelegramError(
    `${(err as Error).message}\n\n${(err as Error).stack ?? ''}`,
  );
  process.exit(1);
});

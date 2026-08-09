const { onRequest } = require('firebase-functions/v2/https');
const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
} = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const line = require('@line/bot-sdk');

admin.initializeApp();
setGlobalOptions({ region: 'asia-east1', maxInstances: 10 });

const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

const APP_ID = 'schdule-f5cda';
const BUILD_VERSION = '2026-08-08-v25-themed-cards';

// 通知開關 (true=開, false=關，省 LINE push 額度)
const NOTIFY_ON_CREATE = true;
const NOTIFY_ON_UPDATE = false;
const NOTIFY_ON_DELETE = false;
const NOTIFY_DAILY_SUMMARY = true;
const NOTIFY_PRE_EVENT_REMINDER = false;
const NOTIFY_WEEKLY_SUNDAY_PREVIEW = false;
const TAIPEI_TZ = 'Asia/Taipei';
const db = () => admin.firestore();

function lineClient() {
  return new line.Client({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value(),
  });
}

async function lineApiGet(path) {
  const res = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LINE API ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// -------- OpenAI Responses API agent (function calling + 即時上網搜尋) --------
// Responses API 內建 web_search 工具，省下另外接搜尋 API 的麻煩。
async function openaiResponses(input, tools, model = 'gpt-4o-mini', toolChoice = 'auto') {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY.value()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
      tools,
      tool_choice: toolChoice,
      max_output_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Firebase Functions runtime is UTC. 所有日期計算都要明確指定 Asia/Taipei，
// 不能用 Date.prototype.getHours/getDate (它們會回傳 UTC 值)。
function formatDateTW(d) {
  // YYYY-MM-DD in Asia/Taipei timezone（用 sv-SE 取 ISO-like 格式）
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TAIPEI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

function taipeiMidnight(dateStr) {
  // dateStr 是 YYYY-MM-DD（視為 Taipei 當地日期），回傳對應 UTC 時間戳
  return new Date(`${dateStr}T00:00:00+08:00`);
}

function taipeiEventStart(dateStr, timeStr) {
  // dateStr=YYYY-MM-DD, timeStr=HH:MM，都是 Taipei 當地時間
  return new Date(`${dateStr}T${timeStr}:00+08:00`);
}

function getDayOfWeekTaipei(d) {
  // 0=Sun, 1=Mon, ..., 6=Sat (Taipei 當地)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TAIPEI_TZ,
    weekday: 'short',
  });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[fmt.format(d)];
}

function shortDateLabel(d) {
  // 給 title 用的「5/13（一）」格式，已對齊 Taipei 時區
  return formatDateLabel(d);
}

function addDaysStr(dateStr, days) {
  // dateStr=YYYY-MM-DD, 回傳加 days 天後的 YYYY-MM-DD
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function addMonthKey(key, delta) {
  // key=YYYY-MM, 回傳加 delta 月後的 YYYY-MM
  const [y, m] = key.split('-').map(Number);
  let newM = m + delta;
  let newY = y;
  while (newM <= 0) { newM += 12; newY -= 1; }
  while (newM > 12) { newM -= 12; newY += 1; }
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

function daysBetween(targetStr, baseStr) {
  // 兩個 YYYY-MM-DD 之間相差天數 (target - base)
  const t = new Date(targetStr + 'T00:00:00Z').getTime();
  const b = new Date(baseStr + 'T00:00:00Z').getTime();
  return Math.round((t - b) / 86400000);
}

function parseTimeRangeStr(str) {
  // 「14:30」或「14:30-16:00」或「14時30」回傳 { startTime, endTime, isAllDay:false } 或 null
  const re = /^(\d{1,2})[:時](\d{2})(?:\s*[\-~到至]\s*(\d{1,2})[:時](\d{2}))?$/;
  const m = str.match(re);
  if (!m) return null;
  const sh = m[1].padStart(2, '0');
  const sm = m[2];
  const startTime = `${sh}:${sm}`;
  let endTime;
  if (m[3]) {
    endTime = `${m[3].padStart(2, '0')}:${m[4]}`;
  } else {
    // 沒寫結束 → 預設 +1 小時，封頂 23:xx
    const total = parseInt(sh) * 60 + parseInt(sm) + 60;
    const eh = Math.min(23, Math.floor(total / 60));
    const em = total % 60;
    endTime = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
  }
  return { startTime, endTime, isAllDay: false };
}

async function findEventsByDateTitle(uid, dateStr, titleQuery) {
  // 回傳含日期 dateStr 且 title 含 titleQuery 的所有事件 { ref, data }
  const eventsSnap = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_events')
    .where('startDate', '<=', dateStr)
    .get();
  const matches = [];
  eventsSnap.forEach((d) => {
    const e = d.data();
    if (!e.endDate || e.endDate < dateStr) return;
    if (titleQuery && e.title && !e.title.includes(titleQuery)) return;
    matches.push({ ref: d.ref, data: e });
  });
  return matches;
}

function monthRangeForQuery(y, mo) {
  // 給「整月行程」/「2026/7」等查詢用
  const monthStartStr = `${y}-${String(mo).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const monthEndStr = `${y}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    start: taipeiMidnight(monthStartStr),
    days: lastDay,
    title: `📅 ${y}/${mo} 整月行程（${monthStartStr} ~ ${monthEndStr}）`,
  };
}

function formatEvent(ev) {
  const time = ev.isAllDay
    ? `${ev.startDate}${ev.startDate !== ev.endDate ? ` ~ ${ev.endDate}` : ''}（全天）`
    : `${ev.startDate} ${ev.startTime}-${ev.endTime}`;
  return `${ev.title}\n  ${time}`;
}

// 取得對話的推播目標 ID：個人聊天回傳 userId，群組回傳 groupId，多人聊天室回傳 roomId
function getSourceId(ev) {
  const src = ev.source || {};
  if (src.type === 'group') return src.groupId;
  if (src.type === 'room') return src.roomId;
  return src.userId;
}

function getWelcomeText(sourceType) {
  const scope = sourceType === 'group' ? '這個群組' : sourceType === 'room' ? '這個聊天室' : '這個 LINE';
  return `哈囉！要把${scope}跟 BiBi 行事曆綁定，請打開行事曆 App → 設定 → LINE 通知，按「複製綁定指令」按鈕，再貼到這裡傳送即可。\n\n或是直接傳給我：\n綁定 <你的裝置 ID>`;
}

function buildWelcomeFlex(sourceType) {
  const scope = sourceType === 'group' ? '這個群組' : sourceType === 'room' ? '這個聊天室' : '這個 LINE';
  return {
    type: 'flex',
    altText: '哈囉！我是 BiBi 行事曆助手',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        backgroundColor: '#8D6E63',
        contents: [
          { type: 'text', text: '👋 哈囉，我是 BiBi！', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: `要把${scope}跟行事曆綁定起來嗎？`, color: '#FFFFFF', size: 'xs', wrap: true, margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            { type: 'text', text: '①', weight: 'bold', color: '#8D6E63', size: 'sm', flex: 0 },
            { type: 'box', layout: 'vertical', flex: 1, contents: [
              { type: 'text', text: '綁定行事曆', weight: 'bold', size: 'sm' },
              { type: 'text', text: '打開行事曆 App → 設定 → LINE 通知 → 按「複製綁定指令」貼到這裡傳送', size: 'xs', color: '#666', wrap: true, margin: 'xs' },
            ]},
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            { type: 'text', text: '②', weight: 'bold', color: '#8D6E63', size: 'sm', flex: 0 },
            { type: 'box', layout: 'vertical', flex: 1, contents: [
              { type: 'text', text: '自我介紹', weight: 'bold', size: 'sm' },
              { type: 'text', text: '傳「我是 <你在 App 設定的名字>」，之後你新增的行程會自動歸給你', size: 'xs', color: '#666', wrap: true, margin: 'xs' },
            ]},
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            { type: 'text', text: '③', weight: 'bold', color: '#8D6E63', size: 'sm', flex: 0 },
            { type: 'box', layout: 'vertical', flex: 1, contents: [
              { type: 'text', text: '開始用', weight: 'bold', size: 'sm' },
              { type: 'text', text: '查行程：今日／本週／7月／5/16 ｜ 新增：「新增 明天10點 看牙醫」', size: 'xs', color: '#666', wrap: true, margin: 'xs' },
            ]},
          ]},
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'sm',
        contents: [
          { type: 'button', style: 'primary', height: 'sm', color: '#8D6E63',
            action: { type: 'message', label: '看完整指令', text: '幫助' } },
        ],
      },
    },
  };
}

async function removeBindingsForSource(sourceId) {
  if (!sourceId) return;
  const snap = await db()
    .collectionGroup('bibi_settings')
    .where('lineUserIds', 'array-contains', sourceId)
    .get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.forEach((doc) =>
    batch.update(doc.ref, {
      lineUserIds: admin.firestore.FieldValue.arrayRemove(sourceId),
    })
  );
  await batch.commit();
}

const WEEK_DAYS_TW = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_EN_TO_TW = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' };

function formatDateLabel(d) {
  // 用 Asia/Taipei 取月/日/星期，避免 UTC 偏移導致差一天
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TAIPEI_TZ,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  return `${month}/${day}（${WEEKDAY_EN_TO_TW[weekday] || weekday}）`;
}

function getQuickReplyItems() {
  return [
    { type: 'action', action: { type: 'message', label: '今日', text: '今日' } },
    { type: 'action', action: { type: 'message', label: '明天', text: '明天' } },
    { type: 'action', action: { type: 'message', label: '本週', text: '本週' } },
    { type: 'action', action: { type: 'message', label: '本月', text: '本月' } },
    { type: 'action', action: { type: 'message', label: '下一個', text: '下一個' } },
    { type: 'action', action: { type: 'message', label: '幫助', text: '幫助' } },
  ];
}

function withQuickReply(message) {
  // Defensive: 用 Object.assign 而非 spread，確保 quickReply 屬性能正確附加
  return Object.assign({}, message, {
    quickReply: { items: getQuickReplyItems() },
  });
}

async function safeReply(client, replyToken, message) {
  // 在 Firebase Functions log 印出送出去的 JSON 結構，方便驗證 quickReply 真的有加上
  const preview = JSON.stringify({
    type: message.type,
    hasQuickReply: !!message.quickReply,
    quickReplyItemCount: message.quickReply?.items?.length ?? 0,
  });
  console.log('[reply]', preview);
  try {
    return await client.replyMessage(replyToken, message);
  } catch (err) {
    console.error('[reply-failed]', err?.originalError?.response?.data || err?.message || err);
    throw err;
  }
}

function getRangeFromText(text) {
  // 以 Taipei 當地日期為基準，避免 UTC 凌晨時段算到昨天
  const today = taipeiMidnight(formatDateTW(new Date()));
  if (text === '今日' || text === '今天' || text === '今日行程') {
    return { start: today, days: 1, title: '📅 今日行程' };
  }
  if (text === '明天' || text === '明日' || text === '明日行程') {
    const t = new Date(today);
    t.setDate(today.getDate() + 1);
    return { start: t, days: 1, title: '📅 明日行程' };
  }
  if (text === '後天') {
    const t = new Date(today);
    t.setDate(today.getDate() + 2);
    return { start: t, days: 1, title: `📅 後天行程（${shortDateLabel(t)}）` };
  }
  if (text === '大後天') {
    const t = new Date(today);
    t.setDate(today.getDate() + 3);
    return { start: t, days: 1, title: `📅 大後天行程（${shortDateLabel(t)}）` };
  }
  // 本週 / 下週 / 下下週 / 週末：以「週一」為一週起始
  const dow = getDayOfWeekTaipei(new Date()); // 0=日, 1=一, ...
  const daysToMonday = (dow + 6) % 7; // 一→0, 二→1, ..., 日→6
  if (text === '本週' || text === '這週' || text === '這禮拜' || text === '本周') {
    const monday = new Date(today);
    monday.setDate(today.getDate() - daysToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      start: monday,
      days: 7,
      title: `📅 本週行程（${shortDateLabel(monday)} ~ ${shortDateLabel(sunday)}）`,
    };
  }
  if (text === '下週' || text === '下周' || text === '下禮拜') {
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() - daysToMonday + 7);
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    return {
      start: nextMonday,
      days: 7,
      title: `📅 下週行程（${shortDateLabel(nextMonday)} ~ ${shortDateLabel(nextSunday)}）`,
    };
  }
  if (text === '下下週' || text === '下下周' || text === '下下禮拜') {
    const nm = new Date(today);
    nm.setDate(today.getDate() - daysToMonday + 14);
    const ns = new Date(nm);
    ns.setDate(nm.getDate() + 6);
    return {
      start: nm,
      days: 7,
      title: `📅 下下週行程（${shortDateLabel(nm)} ~ ${shortDateLabel(ns)}）`,
    };
  }
  if (text === '週末' || text === '周末' || text === '禮拜' || text === '這週末') {
    const sat = new Date(today);
    sat.setDate(today.getDate() - daysToMonday + 5); // 週六
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);
    return {
      start: sat,
      days: 2,
      title: `📅 週末行程（${shortDateLabel(sat)} ~ ${shortDateLabel(sun)}）`,
    };
  }
  if (text === '整月行程' || text === '當月行程' || text === '本月' ||
      text === '這個月' || text === '本月行程' || text === '這個月行程') {
    const todayStr2 = formatDateTW(new Date());
    const [y, mo] = todayStr2.split('-').map(Number);
    return monthRangeForQuery(y, mo);
  }
  // 年月查詢：「2026/7」「2026-7」「2026年7月」「2026/07/行程」等
  let mm;
  if ((mm = text.match(/^(\d{4})[\/\-年](\d{1,2})月?(行程|份)?$/))) {
    const y = parseInt(mm[1]);
    const mo = parseInt(mm[2]);
    if (mo >= 1 && mo <= 12) return monthRangeForQuery(y, mo);
  }
  // 純月份查詢：「7月」「7月行程」「7月份」(假設當前年；如果已過去就推到明年)
  if ((mm = text.match(/^(\d{1,2})月(行程|份)?$/))) {
    const mo = parseInt(mm[1]);
    if (mo >= 1 && mo <= 12) {
      const todayStr2 = formatDateTW(new Date());
      const [curY, curMo] = todayStr2.split('-').map(Number);
      // 「7月」今天是 5 月 → 今年；今天是 8 月 → 明年
      const y = mo >= curMo ? curY : curY + 1;
      return monthRangeForQuery(y, mo);
    }
  }
  // 純日期查詢：使用者直接傳「5/16」、「5月20日」、「週三」、「下週一」等，
  // 整段文字就是日期關鍵字時，當成單日行程查詢
  const todayStr = formatDateTW(new Date());
  const token = parseDateToken(text, todayStr, dow);
  if (token && text === token.consumed) {
    const d = taipeiMidnight(token.date);
    return { start: d, days: 1, title: `📅 ${shortDateLabel(d)} 行程` };
  }
  return null;
}

// -------- Flex 卡片主題：公主風 / 航海風，依日期奇偶交替 --------
// 版權考量：不能用迪士尼/航海王的角色圖像，用配色 + 通用符號致敬，
// 色票對齊 App 端 THEMES 的 kuromi（粉紅戀愛）與 onepiece（航海王）。
const FLEX_THEMES = {
  classic: {
    name: '經典', deco: '', deco2: '',
    headerText: '#FFFFFF', headerBg: '#BCAAA4', gradient: null,
    accent: '#8D6E63', accentSoft: '#EFEBE9', text: '#333333', sub: '#999999',
  },
  princess: {
    name: '公主風', deco: '👑', deco2: '✨',
    headerText: '#FFFFFF', headerBg: '#F48FB1', gradient: ['#F48FB1', '#CE93D8'],
    accent: '#D07890', accentSoft: '#FCE4EC', text: '#5E4048', sub: '#9C8288',
  },
  pirate: {
    name: '航海風', deco: '⚓', deco2: '🌊',
    headerText: '#FFFFFF', headerBg: '#29B6F6', gradient: ['#4FC3F7', '#0277BD'],
    accent: '#0277BD', accentSoft: '#E3F2FD', text: '#37474F', sub: '#78909C',
  },
};

// 偶數日 → 公主風、奇數日 → 航海風（同一天所有卡片風格一致）
function flexThemeForToday(todayStr) {
  return parseInt(todayStr.slice(8), 10) % 2 === 0 ? FLEX_THEMES.princess : FLEX_THEMES.pirate;
}

// 主題化的標頭 box（有漸層用漸層，否則純色）
function themedHeaderBox(th, contents, paddingAll = 'lg') {
  const box = { type: 'box', layout: 'vertical', paddingAll, contents };
  if (th.gradient) {
    box.background = {
      type: 'linearGradient', angle: '135deg',
      startColor: th.gradient[0], endColor: th.gradient[1],
    };
  } else {
    box.backgroundColor = th.headerBg;
  }
  return box;
}

function buildAgendaFlex(title, dateGroups, { compact = false, uidRoles = {}, subtitle = null, theme = null } = {}) {
  const th = theme || FLEX_THEMES.classic;
  const ownerOf = (ev) => computeOwnerLabel(ev.eventType, uidRoles[ev._uid]);
  const todayStr = formatDateTW(new Date());
  const showDateHeader = dateGroups.length > 1;
  const bodyContents = [];

  // 雙欄時間軸列（非 compact 用）：左＝時間、中＝軸點、右＝標題+負責人
  const timelineRow = (leftText, isAllDay, titleText, ownerText) => ({
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'lg',
    contents: [
      { type: 'text', text: leftText, size: 'sm', weight: 'bold',
        color: th.accent, flex: 2, align: 'end', gravity: 'top', margin: 'xs' },
      { type: 'box', layout: 'vertical', flex: 0, width: '12px', paddingTop: '4px',
        contents: [{
          type: 'box', layout: 'vertical', width: '10px', height: '10px',
          cornerRadius: isAllDay ? '2px' : '5px', backgroundColor: th.accent,
          contents: [{ type: 'filler' }],
        }] },
      { type: 'box', layout: 'vertical', flex: 6,
        contents: [
          { type: 'text', text: titleText, size: 'lg', weight: 'bold', wrap: true, color: th.text },
          { type: 'text', text: ownerText, size: 'xs', color: th.sub },
        ] },
    ],
  });

  dateGroups.forEach((g, idx) => {
    if (compact && g.events.length === 0) return; // 整月卡片自動跳過空檔
    const isToday = g.dateStr === todayStr;
    if (showDateHeader) {
      bodyContents.push({
        type: 'text',
        text: isToday ? `▶ ${formatDateLabel(g.date)}　今天` : formatDateLabel(g.date),
        weight: 'bold',
        size: compact ? 'sm' : 'md',
        color: isToday ? th.accent : '#555555',
        margin: idx === 0 ? 'none' : 'xl',
      });
      bodyContents.push({
        type: 'separator',
        margin: 'xs',
        color: isToday ? th.headerBg : '#EEEEEE',
      });
    }
    if (g.events.length === 0) {
      bodyContents.push({
        type: 'text',
        text: showDateHeader ? '（空檔）' : '今天沒有行程，好好休息 ☕',
        size: compact ? 'xs' : 'sm',
        color: '#AAAAAA',
        margin: 'sm',
      });
      return;
    }
    // 全天事件先列，跟有時間的分開
    const allDayEvents = g.events.filter((e) => e.isAllDay);
    const timedEvents = g.events.filter((e) => !e.isAllDay);

    allDayEvents.forEach((ev) => {
      // 多日事件在 compact 模式下顯示「→ 結束日」標示，
      // 因為這版只在起始日列出一次，看不到範圍會困惑
      const isMulti = ev.startDate !== ev.endDate;
      const baseTitle = isMulti && compact
        ? `${ev.title || '(未命名)'} → ${ev.endDate.slice(5).replace('-', '/')}`
        : (ev.title || '(未命名)');
      if (!compact) {
        bodyContents.push(timelineRow('📌 全天', true, baseTitle, ownerOf(ev)));
        return;
      }
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: '📌 全天', size: 'xs',
            color: th.accent, weight: 'bold', flex: 2, gravity: 'top', margin: 'xs' },
          {
            type: 'box', layout: 'vertical', flex: 5,
            contents: [
              { type: 'text', text: baseTitle, size: 'md',
                wrap: true, weight: 'bold', color: th.text },
              { type: 'text', text: ownerOf(ev), size: 'xs', color: th.sub },
            ],
          },
        ],
      });
    });
    timedEvents.forEach((ev) => {
      const isMulti = ev.startDate !== ev.endDate;
      const baseTitle = isMulti && compact
        ? `${ev.title || '(未命名)'} → ${ev.endDate.slice(5).replace('-', '/')}`
        : (ev.title || '(未命名)');
      if (!compact) {
        bodyContents.push(timelineRow(ev.startTime || '--:--', false, baseTitle, ownerOf(ev)));
        return;
      }
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: ev.startTime || '', size: 'sm',
            weight: 'bold', color: th.accent, flex: 2, gravity: 'top', margin: 'xs' },
          {
            type: 'box', layout: 'vertical', flex: 5,
            contents: [
              { type: 'text', text: baseTitle, size: 'md',
                wrap: true, weight: 'bold', color: th.text },
              { type: 'text', text: ownerOf(ev), size: 'xs', color: th.sub },
            ],
          },
        ],
      });
    });
  });

  // compact 模式下若整個月都沒事件，補一條提示
  if (compact && bodyContents.length === 0) {
    bodyContents.push({
      type: 'text', text: '這段期間沒有任何行程 ☕',
      size: 'sm', color: '#999999', align: 'center', margin: 'lg',
    });
  }

  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: themedHeaderBox(th, [
        {
          type: 'text',
          text: th.deco ? `${th.deco} ${title}` : title,
          weight: 'bold',
          size: compact ? 'md' : 'lg',
          color: th.headerText,
        },
        ...(subtitle ? [{
          type: 'text', text: subtitle, size: 'xs',
          color: '#FFFFFFDD', margin: 'sm', wrap: true,
        }] : []),
      ]),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'lg',
        contents: bodyContents.length > 0 ? bodyContents : [{
          type: 'text', text: '沒有行程 ☕', size: 'sm', color: '#999999',
        }],
      },
    },
  };
}

// -------- Carousel：本週/下週等多日查詢，一天一張卡橫向滑動 --------
function buildAgendaCarousel(title, dateGroups, { uidRoles = {}, theme = null } = {}) {
  const th = theme || FLEX_THEMES.classic;
  const todayStr = formatDateTW(new Date());
  const ownerOf = (ev) => computeOwnerLabel(ev.eventType, uidRoles[ev._uid]);
  const totalCount = dateGroups.reduce((s, g) => s + g.events.length, 0);

  const dayRow = (ev) => {
    const isMulti = ev.startDate !== ev.endDate;
    const baseTitle = isMulti
      ? `${ev.title || '(未命名)'} → ${ev.endDate.slice(5).replace('-', '/')}`
      : (ev.title || '(未命名)');
    return {
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
      contents: [
        { type: 'text', text: ev.isAllDay ? '全天' : (ev.startTime || '--:--'),
          size: 'xs', weight: 'bold', color: th.accent, flex: 2, gravity: 'top', margin: 'xs' },
        { type: 'box', layout: 'vertical', flex: 6,
          contents: [
            { type: 'text', text: baseTitle, size: 'md', weight: 'bold', wrap: true, color: th.text },
            { type: 'text', text: ownerOf(ev), size: 'xxs', color: th.sub },
          ] },
      ],
    };
  };

  const bubbles = [];
  // 第一張：總覽卡
  const overviewBody = {
    type: 'box', layout: 'vertical', justifyContent: 'center', paddingAll: 'xl', height: '170px',
    contents: [
      { type: 'text', text: th.deco ? `${th.deco} ${th.deco2}`.trim() : '📅', size: 'xxl', align: 'center' },
      { type: 'text', text: title, size: 'lg', weight: 'bold', align: 'center',
        color: th.headerText, margin: 'md', wrap: true },
      { type: 'text', text: `共 ${totalCount} 個行程・往右滑看每天 →`, size: 'xs',
        align: 'center', color: '#FFFFFFDD', margin: 'sm' },
    ],
  };
  if (th.gradient) {
    overviewBody.background = {
      type: 'linearGradient', angle: '135deg',
      startColor: th.gradient[0], endColor: th.gradient[1],
    };
  } else {
    overviewBody.backgroundColor = th.headerBg;
  }
  bubbles.push({ type: 'bubble', size: 'kilo', body: overviewBody });

  // 之後：一天一張
  for (const g of dateGroups) {
    const isToday = g.dateStr === todayStr;
    const rows = [];
    if (g.events.length === 0) {
      rows.push({ type: 'text', text: '（空檔）☕', size: 'sm', color: th.sub, align: 'center', margin: 'lg' });
    } else {
      g.events.slice(0, 8).forEach((ev) => rows.push(dayRow(ev)));
      if (g.events.length > 8) {
        rows.push({ type: 'text', text: `…共 ${g.events.length} 件`, size: 'xs', color: th.sub, margin: 'sm', align: 'center' });
      }
    }
    bubbles.push({
      type: 'bubble', size: 'kilo',
      header: themedHeaderBox(
        isToday ? th : { ...th, gradient: null, headerBg: th.accentSoft, headerText: th.accent },
        [{
          type: 'text',
          text: isToday ? `👉 ${formatDateLabel(g.date)}　今天` : formatDateLabel(g.date),
          weight: 'bold', size: 'sm',
          color: isToday ? th.headerText : th.accent,
        }],
        'md'
      ),
      body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: rows },
    });
  }

  return {
    type: 'flex',
    altText: title,
    contents: { type: 'carousel', contents: bubbles.slice(0, 12) },
  };
}

async function getBoundUidsForSource(sourceId) {
  if (!sourceId) return [];
  const snap = await db()
    .collectionGroup('bibi_settings')
    .where('lineUserIds', 'array-contains', sourceId)
    .get();
  const uids = [];
  snap.forEach((doc) => {
    if (doc.id !== 'line') return;
    const uid = doc.ref.parent.parent?.id;
    if (uid) uids.push(uid);
  });
  return uids;
}

async function getRoleSettings(uid) {
  const doc = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_settings').doc('roles')
    .get();
  return doc.exists ? doc.data() : { role1: '我', role2: '夥伴' };
}

// 每個 event 後面要標示「誰的行程」，跟 App 端 dayViewEvents 規則一致
function computeOwnerLabel(eventType, roles) {
  if (eventType === 'me') return (roles?.role1 || '我').trim() || '我';
  if (eventType === 'partner') return (roles?.role2 || '夥伴').trim() || '夥伴';
  return '共同';
}

// 角色 A (me) → 莫蘭迪紅、角色 B (partner) → 莫蘭迪奶油、共同 → 深咖啡
// 對應 App.jsx 裡 TECHO_COLORS 的 key
const COLOR_BY_TYPE = { me: 'smokedPlum', partner: 'pastelCream', common: 'latte' };

// AI 看標題自動分類用：給 AI 看的色票清單 + 適用場景提示
const AI_COLOR_HINTS = [
  { key: 'smokedPlum', name: '煙燻梅 (莫蘭迪紅)', use: '醫療/健檢/重要日子' },
  { key: 'ironBlue', name: '鐵藍灰', use: '工作/會議/正式' },
  { key: 'mossGreen', name: '苔蘚綠', use: '戶外/運動/登山' },
  { key: 'ocher', name: '赭石黃', use: '學習/上課/讀書' },
  { key: 'latte', name: '深咖啡', use: '共同/一般' },
  { key: 'tea', name: '重焙茶', use: '聚會/朋友' },
  { key: 'mist', name: '暴風藍', use: '旅遊/出差' },
  { key: 'sakura', name: '乾燥櫻', use: '紀念日/慶祝/生日' },
  { key: 'mint', name: '松針綠', use: '健康/瑜珈/瘦身' },
  { key: 'lemon', name: '蜂蜜黃', use: '休閒/娛樂' },
  { key: 'lavender', name: '紫羅蘭', use: '美容/SPA' },
  { key: 'slate', name: '岩石灰', use: '雜務/家事' },
  { key: 'pastelCream', name: '雲朵棉花 (莫蘭迪奶油)', use: '夥伴專屬' },
  { key: 'pastelSakura', name: '櫻花氣泡', use: '約會/浪漫' },
  { key: 'pastelMatcha', name: '抹茶牛奶', use: '輕食/咖啡廳' },
  { key: 'pastelSky', name: '冰河藍', use: '水上/游泳' },
];

// AI 使用上限（防爆預算）
const AI_MAX_CALLS_PER_MONTH = 1000;       // 月度上限：~ NT$ 50-100 / 月
const AI_RATE_LIMIT_PER_MIN = 5;           // 每分鐘最多 5 次 (per sourceId)
const AI_CONVERSATION_TTL_HOURS = 24;      // 對話記憶 24 小時內有效
const AI_CONVERSATION_KEEP_TURNS = 3;      // 保留最近 3 輪 (= 6 則訊息)

function buildEventConfirmFlex(ev, ownerLabel, opts = {}) {
  const { uid, eventId } = opts;
  const dateLine = ev.startDate === ev.endDate
    ? ev.startDate
    : `${ev.startDate} ~ ${ev.endDate}`;
  const timeLine = ev.isAllDay ? '全天' : `${ev.startTime} - ${ev.endTime}`;
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: '✅ 已新增行程', weight: 'bold', color: '#FFFFFF' }],
      backgroundColor: '#8D6E63',
      paddingAll: 'md',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: 'lg',
      contents: [
        { type: 'text', text: ev.title, weight: 'bold', size: 'lg', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: '📅', flex: 1, size: 'xs' },
          { type: 'text', text: dateLine, flex: 6, size: 'sm' },
        ]},
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: '⏰', flex: 1, size: 'xs' },
          { type: 'text', text: timeLine, flex: 6, size: 'sm' },
        ]},
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: '👤', flex: 1, size: 'xs' },
          { type: 'text', text: ownerLabel, flex: 6, size: 'sm' },
        ]},
      ],
    },
  };
  // 有帶 uid + eventId 才加 button (postback 需要事件位址)
  if (uid && eventId) {
    const editAction = ev.isAllDay
      ? { type: 'datetimepicker', label: '✏️ 改日期', mode: 'date',
          data: `act=edit-date&uid=${uid}&id=${eventId}` }
      : { type: 'datetimepicker', label: '🕓 改時間', mode: 'datetime',
          data: `act=edit-datetime&uid=${uid}&id=${eventId}`,
          initial: `${ev.startDate}T${ev.startTime}` };
    bubble.footer = {
      type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'sm',
      contents: [
        { type: 'button', style: 'secondary', height: 'sm',
          action: { type: 'postback', label: '🗑️ 刪除',
            data: `act=delete&uid=${uid}&id=${eventId}`,
            displayText: `刪除：${ev.title}` } },
        { type: 'button', style: 'secondary', height: 'sm', action: editAction },
      ],
    };
  }
  return { type: 'flex', altText: `已新增：${ev.title}`, contents: bubble };
}

// -------- 自然語言事件解析 --------

// 解析一個日期 token (從 text 開頭嘗試比對)，
// 回傳 { date: 'YYYY-MM-DD', consumed: '原始符合的字串' } 或 null。
function parseDateToken(text, todayStr, todayDow) {
  const dateKeywords = [
    { re: /^(今天|今日)/, days: 0 },
    { re: /^(明天|明日)/, days: 1 },
    { re: /^(後天)/, days: 2 },
    { re: /^(大後天)/, days: 3 },
  ];
  for (const { re, days } of dateKeywords) {
    const m = text.match(re);
    if (m) return { date: addDaysStr(todayStr, days), consumed: m[0] };
  }
  const wdMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  let m;
  if ((m = text.match(/^下週([日天一二三四五六])/) ||
            text.match(/^下周([日天一二三四五六])/) ||
            text.match(/^下禮拜([日天一二三四五六])/))) {
    const target = wdMap[m[1]];
    const daysToMonday = (todayDow + 6) % 7;
    const offsetFromMonday = (target + 6) % 7;
    return {
      date: addDaysStr(todayStr, -daysToMonday + 7 + offsetFromMonday),
      consumed: m[0],
    };
  }
  if ((m = text.match(/^週([日天一二三四五六])/) ||
            text.match(/^周([日天一二三四五六])/) ||
            text.match(/^禮拜([日天一二三四五六])/) ||
            text.match(/^星期([日天一二三四五六])/))) {
    const target = wdMap[m[1]];
    const offset = (target - todayDow + 7) % 7;
    return { date: addDaysStr(todayStr, offset), consumed: m[0] };
  }
  const buildMDDate = (m1, m2, mraw) => {
    const month = parseInt(m1);
    const day = parseInt(m2);
    const [y] = todayStr.split('-').map(Number);
    const cand = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // 只有比今天「明顯過去」(超過 60 天) 才推到明年，
    // 避免「5/13」today=5/15 被推到明年產生跨年事件
    const daysDiff = (new Date(cand) - new Date(todayStr)) / 86400000;
    return {
      date: daysDiff < -60
        ? `${y + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        : cand,
      consumed: mraw,
    };
  };
  if ((m = text.match(/^(\d{1,2})\/(\d{1,2})/))) {
    return buildMDDate(m[1], m[2], m[0]);
  }
  if ((m = text.match(/^(\d{1,2})月(\d{1,2})[日號]?/))) {
    return buildMDDate(m[1], m[2], m[0]);
  }
  return null;
}

// 範例：「後天10點要看醫生」、「明天下午3點半 阿明 牙醫」、「5/20 全天 媽媽生日」、
//      「5/13到5/15 出差」、「今晚 阿花生日趴」
function parseNaturalEvent(text, roleSettings, todayStr, todayDow) {
  const result = {
    isAllDay: true,
    startTime: '',
    endTime: '',
    startDate: todayStr,
    endDate: todayStr,
    title: '',
    description: '',
    eventType: 'common',
    color: COLOR_BY_TYPE.common,
  };
  let remaining = text.trim();
  let foundDate = false;
  let foundTime = false;

  // -- 1a. 模糊時段 (今晚/明早/明晚/後天晚上)，同時隱含日期+時間 --
  const fuzzyPhrases = [
    { re: /^(今晚|今天晚上)/, dateDays: 0, time: '20:00', endTime: '21:00' },
    { re: /^(今天中午)/, dateDays: 0, time: '12:00', endTime: '13:00' },
    { re: /^(今天傍晚)/, dateDays: 0, time: '18:00', endTime: '19:00' },
    { re: /^(明早|明天早上|明天早晨)/, dateDays: 1, time: '07:00', endTime: '08:00' },
    { re: /^(明晚|明天晚上)/, dateDays: 1, time: '20:00', endTime: '21:00' },
    { re: /^(明天中午)/, dateDays: 1, time: '12:00', endTime: '13:00' },
    { re: /^(後天晚上|後天晚)/, dateDays: 2, time: '20:00', endTime: '21:00' },
    { re: /^(後天早上|後天早)/, dateDays: 2, time: '07:00', endTime: '08:00' },
  ];
  for (const f of fuzzyPhrases) {
    const m = remaining.match(f.re);
    if (m) {
      result.startDate = addDaysStr(todayStr, f.dateDays);
      result.endDate = result.startDate;
      result.startTime = f.time;
      result.endTime = f.endTime;
      result.isAllDay = false;
      remaining = remaining.replace(m[0], '').trim();
      foundDate = true;
      foundTime = true;
      break;
    }
  }

  // -- 1b. 標準日期 (含日期範圍「5/13 到 5/15」「明天到後天」) --
  if (!foundDate) {
    const first = parseDateToken(remaining, todayStr, todayDow);
    if (first) {
      result.startDate = first.date;
      result.endDate = first.date;
      remaining = remaining.slice(first.consumed.length).trim();
      foundDate = true;
      // 看後面有沒有接連接詞 + 第二個日期 → 多日事件
      const connectorMatch = remaining.match(/^[到~\-至]\s*/);
      if (connectorMatch) {
        const afterConn = remaining.slice(connectorMatch[0].length);
        const second = parseDateToken(afterConn, todayStr, todayDow);
        if (second) {
          // 確保 endDate >= startDate (若使用者打反就 swap)
          if (second.date < result.startDate) {
            result.endDate = result.startDate;
            result.startDate = second.date;
          } else {
            result.endDate = second.date;
          }
          remaining = afterConn.slice(second.consumed.length).trim();
        }
      }
    }
  }

  // -- 2. 全天關鍵字 --
  if (/全天/.test(remaining)) {
    result.isAllDay = true;
    remaining = remaining.replace(/全天/g, '').trim();
    foundTime = true;
  }

  // -- 2b. 單獨的模糊時段（中午/傍晚/凌晨/清晨）— 沒附日期，套今天的時間 --
  if (!foundTime) {
    const slotMap = [
      { re: /中午/, time: '12:00', endTime: '13:00' },
      { re: /傍晚/, time: '18:00', endTime: '19:00' },
      { re: /清晨/, time: '06:00', endTime: '07:00' },
      { re: /凌晨/, time: '01:00', endTime: '02:00' },
    ];
    for (const s of slotMap) {
      if (s.re.test(remaining)) {
        result.startTime = s.time;
        result.endTime = s.endTime;
        result.isAllDay = false;
        remaining = remaining.replace(s.re, '').trim();
        foundTime = true;
        break;
      }
    }
  }

  // -- 3. 時間範圍 --（要在「全天」與模糊時段之後）
  if (!foundTime) {
    const timeRe = /(上午|下午|早上|晚上|中午)?\s*(\d{1,2})\s*[點:時](\s*(半|\d{1,2})\s*分?)?(?:\s*[到~\-至]\s*(上午|下午|早上|晚上|中午)?\s*(\d{1,2})\s*[點:時](\s*(半|\d{1,2})\s*分?)?)?/;
    const m = remaining.match(timeRe);
    if (m) {
      const ampm1 = m[1];
      let h1 = parseInt(m[2]);
      const min1raw = m[4];
      let mn1 = 0;
      if (min1raw === '半') mn1 = 30;
      else if (min1raw && /^\d+$/.test(min1raw)) mn1 = parseInt(min1raw);
      if ((ampm1 === '下午' || ampm1 === '晚上') && h1 < 12) h1 += 12;
      if (ampm1 === '中午' && h1 < 12) h1 += 12;
      if ((ampm1 === '上午' || ampm1 === '早上') && h1 === 12) h1 = 0;

      result.startTime = `${String(h1).padStart(2, '0')}:${String(mn1).padStart(2, '0')}`;
      result.isAllDay = false;

      const ampm2 = m[5];
      const h2raw = m[6];
      const min2raw = m[8];
      if (h2raw) {
        let h2 = parseInt(h2raw);
        let mn2 = 0;
        if (min2raw === '半') mn2 = 30;
        else if (min2raw && /^\d+$/.test(min2raw)) mn2 = parseInt(min2raw);
        if ((ampm2 === '下午' || ampm2 === '晚上') && h2 < 12) h2 += 12;
        if (ampm2 === '中午' && h2 < 12) h2 += 12;
        if ((ampm2 === '上午' || ampm2 === '早上') && h2 === 12) h2 = 0;
        result.endTime = `${String(h2).padStart(2, '0')}:${String(mn2).padStart(2, '0')}`;
      } else {
        // 沒寫結束時間 → 預設加 1 小時
        let h2 = h1 + 1;
        const mn2 = mn1;
        if (h2 >= 24) h2 = 23;
        result.endTime = `${String(h2).padStart(2, '0')}:${String(mn2).padStart(2, '0')}`;
      }
      remaining = remaining.replace(m[0], '').trim();
      foundTime = true;
    }
  }

  // -- 4. 角色辨識 --
  const r1 = (roleSettings?.role1 || '').trim();
  const r2 = (roleSettings?.role2 || '').trim();
  // 4a. 「共同 / 一起 / 我們 / 兩個人」這類關鍵字 → 鎖死 common，後續 senderRole fallback 不能覆蓋
  const commonKeywords = ['共同', '一起', '我們', '我倆', '兩個人', '兩人'];
  const hasCommonKeyword = commonKeywords.some((kw) => remaining.includes(kw));
  if (hasCommonKeyword) {
    result.eventType = 'common';
    result.color = COLOR_BY_TYPE.common;
    result._explicitCommon = true; // 讓 tryCreateExplicit 知道這是「使用者明確要共同」
    commonKeywords.forEach((kw) => { remaining = remaining.split(kw).join(' ').trim(); });
  } else if (r1 && r1 !== '我' && remaining.includes(r1)) {
    result.eventType = 'me';
    result.color = COLOR_BY_TYPE.me;
    remaining = remaining.split(r1).join('').trim();
  } else if (r2 && r2 !== '夥伴' && remaining.includes(r2)) {
    result.eventType = 'partner';
    result.color = COLOR_BY_TYPE.partner;
    remaining = remaining.split(r2).join('').trim();
  }

  // -- 5. Title --
  result.title = remaining
    .replace(/^[要去想是有的]+/, '')
    .replace(/[，。、,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!foundDate) return null; // 不是新增指令，讓 caller fall through
  if (!result.title) return { error: 'no_title' };
  // 預設：沒指定全天又沒指定時間 → 全天
  if (!foundTime) {
    result.isAllDay = true;
    result.startTime = '';
    result.endTime = '';
  }
  return result;
}

async function replyBindingStatus(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '🔓 這個聊天視窗還沒綁定任何行事曆\n\n請傳：綁定 <你的裝置 ID>',
    }));
  }
  const lines = ['🔗 綁定狀態', ''];
  const todayStr = formatDateTW(new Date());
  const monthStart = todayStr.slice(0, 8) + '01';
  for (const uid of uids) {
    const roles = await getRoleSettings(uid);
    const eventsSnap = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_events')
      .where('startDate', '>=', monthStart)
      .get();
    lines.push(`📋 UID：${uid.substring(0, 8)}…`);
    lines.push(`👥 ${roles.role1 || '我'} ／ ${roles.role2 || '夥伴'}`);
    lines.push(`📊 本月事件：${eventsSnap.size} 件`);
    lines.push('');
  }
  lines.push(`想要解除請傳：解除綁定`);
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: lines.join('\n'),
  }));
}

async function replyUsage(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '尚未綁定行事曆',
    }));
  }
  const lines = [];

  // 1) LINE 官方計費數字 (整個 channel 共用)
  try {
    const [quota, consumption] = await Promise.all([
      lineApiGet('/v2/bot/message/quota'),
      lineApiGet('/v2/bot/message/quota/consumption'),
    ]);
    const limit = quota.type === 'limited' ? quota.value
      : (quota.type === 'none' ? '無限' : (quota.value ?? '未知'));
    const used = consumption.totalUsage ?? 0;
    lines.push('📊 LINE 官方計費 (整個 Bot)');
    lines.push(`方案：${quota.type}`);
    lines.push(`本月已用：${used} 則`);
    lines.push(`配額：${limit}${typeof limit === 'number' ? ' 則' : ''}`);
    if (typeof limit === 'number') {
      if (used >= limit) {
        lines.push(`⚠️ 已超額 ${used - limit} 則`);
      } else {
        lines.push(`還剩：${limit - used} 則`);
      }
    }
  } catch (err) {
    lines.push('📊 LINE 官方計費');
    lines.push(`⚠️ 查詢失敗：${String(err.message || err).slice(0, 80)}`);
  }
  lines.push('');

  // 2) 內部分類計數 (此綁定的個別來源)
  const monthKey = formatDateTW(new Date()).slice(0, 7);
  const prevMonthKey = addMonthKey(monthKey, -1);
  lines.push('📋 內部計數 (參考)');
  for (const uid of uids) {
    const usageDoc = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_settings').doc('usage')
      .get();
    const data = usageDoc.exists ? usageDoc.data() : {};
    const thisMonth = data[monthKey] || 0;
    const prevMonth = data[prevMonthKey] || 0;
    const cat = data[`${monthKey}_categories`] || {};
    lines.push(`本月（${monthKey}）：${thisMonth} 則`);
    if (Object.keys(cat).length > 0) {
      const parts = [];
      if (cat.morning) parts.push(`每日 ${cat.morning}`);
      if (cat.reminder) parts.push(`提醒 ${cat.reminder}`);
      if (cat.event_create) parts.push(`新增 ${cat.event_create}`);
      if (cat.event_update) parts.push(`異動 ${cat.event_update}`);
      if (cat.other) parts.push(`其他 ${cat.other}`);
      if (parts.length) lines.push(`　└ ${parts.join('｜')}`);
    }
    lines.push(`上月（${prevMonthKey}）：${prevMonth} 則`);
  }
  lines.push('');
  lines.push('註：reply (回覆你的訊息) 不計費，');
  lines.push('　只有主動 push 才會算入官方配額。');
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: lines.join('\n'),
  }));
}

async function getSenderRoleForUid(uid, senderUserId) {
  if (!senderUserId) return null;
  const lineDoc = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_settings').doc('line')
    .get();
  return lineDoc.data()?.userRoleMap?.[senderUserId] || null;
}

async function handleIdentitySet(client, ev, text) {
  // 「我是 Shane」「我是 阿花」「我是 我」「我是 夥伴」
  const m = text.match(/^我是\s*[:：]?\s*(.+)$/);
  if (!m) return false;
  const claimedName = m[1].trim();
  if (!claimedName) return false;

  const sourceId = getSourceId(ev);
  const senderUserId = ev.source?.userId;
  if (!senderUserId) {
    await safeReply(client, ev.replyToken, {
      type: 'text',
      text: '抓不到你的 LINE 個人 ID — 請先把我加為好友再試一次。',
    });
    return true;
  }

  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '這個聊天還沒綁定行事曆，先傳：綁定 <你的裝置 ID>',
    }));
    return true;
  }

  // 從綁定的行事曆角色名稱比對 (不分大小寫、自動 trim)
  const claim = claimedName.toLowerCase();
  let matchedRole = null;
  let matchedRoleName = null;
  let firstRoles = null;
  for (const uid of uids) {
    const roles = await getRoleSettings(uid);
    if (!firstRoles) firstRoles = roles;
    const r1 = (roles.role1 || '我').trim();
    const r2 = (roles.role2 || '夥伴').trim();
    if (claim === r1.toLowerCase() || claim === '我' || claim === '我自己') {
      matchedRole = 'me'; matchedRoleName = r1; break;
    }
    if (claim === r2.toLowerCase() || claim === '夥伴' || claim === '另一半') {
      matchedRole = 'partner'; matchedRoleName = r2; break;
    }
  }

  if (!matchedRole) {
    // 群組／聊天室：比對失敗保持沉默，避免有人隨手打「我是吃飯了」就被回覆吵到
    const isGroup = ev.source?.type === 'group' || ev.source?.type === 'room';
    if (isGroup) return false;
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `找不到名字「${claimedName}」。\n目前行事曆設定的角色：${firstRoles.role1 || '我'} ／ ${firstRoles.role2 || '夥伴'}\n\n要改名請到 App 的設定畫面。\n\n請傳：我是 ${firstRoles.role1 || '我'}\n或：我是 ${firstRoles.role2 || '夥伴'}`,
    }));
    return true;
  }

  // 存到 userRoleMap，巢狀物件 + merge=true 才會正確 deep merge，
  // 不會蓋掉其他寄件人已存的 mapping。
  for (const uid of uids) {
    await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_settings').doc('line')
      .set({
        userRoleMap: { [senderUserId]: matchedRole },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  }

  await safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: `✅ 認識你了！\n之後你在這裡新增行程，沒特別指定的話會自動歸給「${matchedRoleName}」。\n\n要改回去請再傳：我是 <另一個名字>\n要看誰是誰請傳：誰是誰`,
  }));
  return true;
}

async function replyIdentityMap(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '尚未綁定行事曆',
    }));
    return;
  }
  const lines = ['👥 LINE ID 對應角色', ''];
  for (const uid of uids) {
    const roles = await getRoleSettings(uid);
    const lineDoc = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_settings').doc('line')
      .get();
    const map = lineDoc.data()?.userRoleMap || {};
    const entries = Object.entries(map);
    lines.push(`📋 ${uid.substring(0, 8)}…`);
    if (entries.length === 0) {
      lines.push('  （還沒有人設定）');
    } else {
      entries.forEach(([lineUid, role]) => {
        const name = role === 'me' ? (roles.role1 || '我') : (roles.role2 || '夥伴');
        lines.push(`  • ${lineUid.substring(0, 6)}… → ${name}`);
      });
    }
    lines.push(`  設定方式：我是 ${roles.role1 || '我'}　或　我是 ${roles.role2 || '夥伴'}`);
    lines.push('');
  }
  await safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: lines.join('\n'),
  }));
}

async function replyNextEvents(client, ev, count = 5) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '尚未綁定行事曆',
    }));
  }
  const todayStr = formatDateTW(new Date());
  const now = new Date();
  const allFuture = [];
  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const snap = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_events')
      .where('startDate', '>=', todayStr)
      .get();
    snap.forEach((d) => {
      const e = d.data();
      // 當天事件如果已過 startTime 就跳過
      if (e.startDate === todayStr && !e.isAllDay && e.startTime) {
        if (taipeiEventStart(e.startDate, e.startTime) < now) return;
      }
      allFuture.push({ ...e, _uid: uid });
    });
  }
  allFuture.sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
  });
  const slice = allFuture.slice(0, count);
  if (slice.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '🌤️ 接下來沒有任何行程，好好放鬆 ☕',
    }));
  }
  const title = count === 1 ? '⏰ 下一個行程' : `📅 即將到來（${slice.length} 件）`;
  const lines = [title, ''];
  slice.forEach((e, i) => {
    const days = daysBetween(e.startDate, todayStr);
    const dayLabel = days === 0 ? '今天'
      : days === 1 ? '明天'
      : days === 2 ? '後天'
      : `${days} 天後`;
    const timeLabel = e.isAllDay ? '全天' : `${e.startTime}-${e.endTime}`;
    const ownerLabel = computeOwnerLabel(e.eventType, uidRoles[e._uid]);
    lines.push(`${i + 1}. ${e.title}（${ownerLabel}）`);
    lines.push(`   📅 ${dayLabel} ${e.startDate} ${timeLabel}`);
  });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

async function replySearch(client, ev, query) {
  if (!query) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請輸入要搜尋的關鍵字。例：「找 媽媽」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '尚未綁定行事曆',
    }));
  }
  const matches = [];
  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const snap = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_events')
      .get();
    snap.forEach((d) => {
      const e = d.data();
      if (e.title && e.title.includes(query)) matches.push({ ...e, _uid: uid });
    });
  }
  if (matches.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 找不到含「${query}」的事件`,
    }));
  }
  matches.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const top = matches.slice(0, 20);
  const lines = [`🔍 「${query}」搜尋結果（${matches.length} 件）`, ''];
  top.forEach((e, i) => {
    const range = e.startDate === e.endDate ? e.startDate : `${e.startDate}~${e.endDate}`;
    const timeLabel = e.isAllDay ? '全天' : (e.startTime || '');
    const ownerLabel = computeOwnerLabel(e.eventType, uidRoles[e._uid]);
    lines.push(`${i + 1}. ${e.title}（${ownerLabel}）`);
    lines.push(`   ${range} ${timeLabel}`);
  });
  if (matches.length > 20) lines.push('', `（共 ${matches.length} 件，只顯示前 20）`);
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// ============================================================
// Batch 1 規則式增強：唯讀統計 / 倒數 / 篩選
// ============================================================

// 倒數 / 還剩：找標題符合的最近未來事件，回剩餘天數
async function replyCountdown(client, ev, query) {
  if (!query) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶上要倒數的事，例：「倒數 中秋」「倒數 阿花生日」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const matches = [];
  for (const uid of uids) {
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events').get();
    snap.forEach((d) => {
      const e = d.data();
      if (e.title && e.title.includes(query) && e.startDate >= todayStr) {
        matches.push(e);
      }
    });
  }
  if (matches.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 找不到含「${query}」的未來行程`,
    }));
  }
  matches.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const nearest = matches[0];
  const days = daysBetween(nearest.startDate, todayStr);
  const dayLabel = days === 0 ? '就是今天 🎉'
    : days === 1 ? '明天 ⏰'
    : days <= 7 ? `還剩 ${days} 天`
    : days <= 30 ? `還剩 ${days} 天（約 ${Math.round(days / 7)} 週）`
    : `還剩 ${days} 天（約 ${Math.round(days / 30)} 個月）`;
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: `⏳ ${nearest.title}\n📅 ${nearest.startDate}\n${dayLabel}`,
  }));
}

// 剩下 / 今天剩：今天還沒過的行程
async function replyRemainingToday(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const now = new Date();
  const remaining = [];
  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events')
      .where('startDate', '<=', todayStr).get();
    snap.forEach((d) => {
      const e = d.data();
      if (!e.endDate || e.endDate < todayStr) return;
      // 全天事件還沒結束就算，有時間事件還沒過開始時間才算
      if (!e.isAllDay && e.startTime) {
        if (taipeiEventStart(e.startDate, e.startTime) < now) return;
      }
      remaining.push({ ...e, _uid: uid });
    });
  }
  if (remaining.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '🍵 今天剩下的行程沒有了，可以放鬆～',
    }));
  }
  remaining.sort((a, b) => {
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
  });
  const lines = [`⏳ 今天剩下 ${remaining.length} 件：`, ''];
  remaining.forEach((e, i) => {
    const t = e.isAllDay ? '全天' : (e.startTime || '');
    const owner = computeOwnerLabel(e.eventType, uidRoles[e._uid]);
    lines.push(`${i + 1}. ${t} ${e.title}（${owner}）`);
  });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// 本月統計：總數 + 按 owner 拆解 + 最忙日
async function replyMonthlyStats(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd = `${y}-${String(m).padStart(2, '0')}-31`;

  const events = [];
  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events')
      .where('startDate', '<=', monthEnd).get();
    snap.forEach((d) => {
      const e = d.data();
      if (!e.endDate || e.endDate < monthStart) return;
      events.push({ ...e, _uid: uid });
    });
  }
  if (events.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `📊 ${y}/${m} 還沒有任何行程`,
    }));
  }
  const byType = { me: 0, partner: 0, common: 0 };
  const byDate = {};
  events.forEach((e) => {
    byType[e.eventType] = (byType[e.eventType] || 0) + 1;
    byDate[e.startDate] = (byDate[e.startDate] || 0) + 1;
  });
  const sampleRoles = uidRoles[uids[0]] || {};
  const role1 = sampleRoles.role1 || '我';
  const role2 = sampleRoles.role2 || '夥伴';
  const busyDays = Object.entries(byDate)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const lines = [
    `📊 ${y}/${m} 統計`,
    '',
    `共 ${events.length} 件`,
    `  • ${role1}：${byType.me || 0} 件`,
    `  • ${role2}：${byType.partner || 0} 件`,
    `  • 共同：${byType.common || 0} 件`,
  ];
  if (busyDays.length) {
    lines.push('', '🔥 最忙 Top 3：');
    busyDays.forEach(([d, n]) => lines.push(`  ${d}（${n} 件）`));
  }
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// 衝突：掃描未來 3 個月內所有撞時間的事件對
async function replyConflicts(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const horizonStr = addDaysStr(todayStr, 90);
  const events = [];
  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events')
      .where('startDate', '<=', horizonStr).get();
    snap.forEach((d) => {
      const e = d.data();
      if (!e.endDate || e.endDate < todayStr) return;
      events.push({ ...e, _uid: uid });
    });
  }
  // 找撞時間的 pair (O(n²) 但 n 通常 < 100)
  const conflicts = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i]; const b = events[j];
      // 日期沒重疊就跳過
      if (a.endDate < b.startDate || b.endDate < a.startDate) continue;
      // 全天 → 算衝突
      if (a.isAllDay || b.isAllDay) {
        conflicts.push([a, b]);
        continue;
      }
      // 有時間 → 看時間重疊
      if (a.startTime && a.endTime && b.startTime && b.endTime) {
        if (a.endTime <= b.startTime || b.endTime <= a.startTime) continue;
        conflicts.push([a, b]);
      }
    }
  }
  if (conflicts.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '✨ 未來 3 個月沒有撞時間的行程',
    }));
  }
  const lines = [`⚠️ 未來 3 個月有 ${conflicts.length} 組撞時間：`, ''];
  conflicts.slice(0, 10).forEach(([a, b], i) => {
    const tA = a.isAllDay ? '全天' : `${a.startTime}-${a.endTime}`;
    const tB = b.isAllDay ? '全天' : `${b.startTime}-${b.endTime}`;
    const ownerA = computeOwnerLabel(a.eventType, uidRoles[a._uid]);
    const ownerB = computeOwnerLabel(b.eventType, uidRoles[b._uid]);
    lines.push(`${i + 1}. ${a.startDate}`);
    lines.push(`   ${tA} ${a.title} (${ownerA})`);
    lines.push(`   ${tB} ${b.title} (${ownerB})`);
    lines.push('');
  });
  if (conflicts.length > 10) lines.push(`（共 ${conflicts.length} 組，只列前 10）`);
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n').trim(),
  }));
}

// 第幾週：ISO 8601 週數
function getISOWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
async function replyWeekNumber(client, ev) {
  const today = new Date();
  const todayStr = formatDateTW(today);
  const week = getISOWeekNumber(today);
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `📅 今天 ${todayStr} 是 ${today.getFullYear()} 年第 ${week} 週`,
  }));
}

// 從 TaiwanCalendar CDN 撈今年 + 明年的假日，快取在 module scope (cold start 後第一次撈)
let _holidayCache = null;
let _holidayCacheYear = null;
async function fetchHolidaysForYear(year) {
  const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
  if (!res.ok) throw new Error(`holiday api ${res.status}`);
  return res.json();
}
async function getHolidayList() {
  const now = new Date();
  const y = now.getFullYear();
  if (_holidayCache && _holidayCacheYear === y) return _holidayCache;
  try {
    const [thisYear, nextYear] = await Promise.all([
      fetchHolidaysForYear(y),
      fetchHolidaysForYear(y + 1).catch(() => []),
    ]);
    const merged = [...thisYear, ...nextYear]
      .filter((d) => d.isHoliday && d.date && d.date.length === 8)
      .map((d) => ({
        date: `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`,
        name: d.description || d.holidayCategory || '假日',
      }));
    _holidayCache = merged;
    _holidayCacheYear = y;
    return merged;
  } catch (e) {
    console.warn('[holidays] fetch failed', e?.message);
    return [];
  }
}

// 下個假日 / 假日清單
async function replyNextHoliday(client, ev) {
  const holidays = await getHolidayList();
  const todayStr = formatDateTW(new Date());
  const future = holidays.filter((h) => h.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  if (future.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '⚠️ 查不到接下來的國定假日資料',
    }));
  }
  const lines = ['🇹🇼 接下來的國定假日：', ''];
  future.slice(0, 8).forEach((h) => {
    const days = daysBetween(h.date, todayStr);
    const dLabel = days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天後`;
    lines.push(`${h.date}（${dLabel}）— ${h.name}`);
  });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// 標題關鍵字過濾清單 (生日 / 休假 等通用 helper)
async function replyTitleFilteredList(client, ev, keywords, displayName) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const items = [];
  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events').get();
    snap.forEach((d) => {
      const e = d.data();
      if (!e.endDate || e.endDate < todayStr) return;
      const hay = `${e.title || ''} ${e.description || ''}`;
      if (keywords.some((k) => hay.includes(k))) items.push({ ...e, _uid: uid });
    });
  }
  if (items.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 沒有找到「${displayName}」相關的未來行程`,
    }));
  }
  items.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const lines = [`📋 ${displayName}（${items.length} 件）`, ''];
  items.slice(0, 20).forEach((e, i) => {
    const days = daysBetween(e.startDate, todayStr);
    const dLabel = days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天後`;
    const owner = computeOwnerLabel(e.eventType, uidRoles[e._uid]);
    lines.push(`${i + 1}. ${e.startDate}（${dLabel}）${e.title}（${owner}）`);
  });
  if (items.length > 20) lines.push(`（共 ${items.length}，只列前 20）`);
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// ============================================================
// Batch 5: 空檔 / 便利貼 / 打卡 / 節氣
// ============================================================

// 空檔：找出今天 / 明天 / 本週剩下時段沒排程的區段
// 只考慮非全天事件，全天事件視為「忙整天」直接跳過
async function replyFreeSlots(client, ev, scope = 'tomorrow') {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  // 解析範圍
  const todayStr = formatDateTW(new Date());
  let targetDates = [];
  if (scope === 'today') targetDates = [todayStr];
  else if (scope === 'tomorrow') targetDates = [addDaysStr(todayStr, 1)];
  else if (scope === 'week') {
    for (let i = 0; i < 7; i++) targetDates.push(addDaysStr(todayStr, i));
  }
  const eventsByDate = {};
  for (const ds of targetDates) eventsByDate[ds] = [];
  for (const uid of uids) {
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events')
      .where('startDate', '<=', targetDates[targetDates.length - 1]).get();
    snap.forEach((d) => {
      const e = d.data();
      for (const ds of targetDates) {
        if (e.startDate <= ds && (e.endDate || e.startDate) >= ds) {
          eventsByDate[ds].push(e);
        }
      }
    });
  }
  const lines = [`🟢 空檔 (${scope === 'today' ? '今天' : scope === 'tomorrow' ? '明天' : '本週'})：`, ''];
  let totalFree = 0;
  for (const ds of targetDates) {
    const evs = eventsByDate[ds];
    const isAllDayBusy = evs.some((e) => e.isAllDay);
    if (isAllDayBusy) {
      lines.push(`${ds} ⛔ 全天有事`);
      continue;
    }
    // 把時間事件排好，找空檔（09:00-22:00 為主要活動時段）
    const timed = evs.filter((e) => !e.isAllDay && e.startTime && e.endTime)
      .map((e) => ({ s: e.startTime, e: e.endTime }))
      .sort((a, b) => a.s.localeCompare(b.s));
    const freeSlots = [];
    let cursor = '09:00';
    for (const { s, e } of timed) {
      if (s > cursor) freeSlots.push([cursor, s]);
      if (e > cursor) cursor = e;
    }
    if (cursor < '22:00') freeSlots.push([cursor, '22:00']);
    if (freeSlots.length === 0) {
      lines.push(`${ds} ⛔ 整天滿`);
    } else {
      lines.push(`${ds}`);
      freeSlots.forEach(([s, e]) => lines.push(`  • ${s} - ${e}`));
      totalFree += freeSlots.length;
    }
  }
  if (totalFree === 0 && lines.length <= 2) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '😵 沒有空檔',
    }));
  }
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// 便利貼：純文字短備忘，存到 sticky_notes collection (不放 events 避免汙染日曆)
async function trySticky(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶內容，例：「便利貼 買牛奶」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const targetUid = uids[0];
  await db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid)
    .collection('sticky_notes').add({
      text: text.slice(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `📝 已記下：${text}`,
  }));
}

// 看便利貼清單
async function replyStickyList(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const all = [];
  for (const uid of uids) {
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('sticky_notes')
      .orderBy('createdAt', 'desc').limit(20).get();
    snap.forEach((d) => all.push({ id: d.id, uid, ...d.data() }));
  }
  if (all.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '📝 便利貼空的。用「便利貼 XXX」隨手記',
    }));
  }
  const lines = [`📝 便利貼（${all.length} 張）`, ''];
  all.slice(0, 20).forEach((s, i) => lines.push(`${i + 1}. ${s.text}`));
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// 打卡：當下時間建一筆 X 行程
async function tryCheckin(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶事項，例：「打卡 跑步」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const targetUid = uids[0];
  const now = new Date();
  const dateStr = formatDateTW(now);
  // 用台北時區取時分 — Functions 主機是 UTC，getHours() 會差 8 小時
  const tpe = new Intl.DateTimeFormat('en-GB', {
    timeZone: TAIPEI_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const [tpeH, tpeM] = tpe.split(':').map(Number);
  const hh = String(tpeH % 24).padStart(2, '0');
  const mm = String(tpeM).padStart(2, '0');
  const startTime = `${hh}:${mm}`;
  const endTotal = (tpeH % 24) * 60 + tpeM + 30;
  const eh = String(Math.min(23, Math.floor(endTotal / 60))).padStart(2, '0');
  const em = String(endTotal % 60).padStart(2, '0');
  const senderRole = await getSenderRoleForUid(targetUid, ev.source?.userId);
  const eventType = senderRole || 'common';
  const ref = await db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid).collection('bibi_events').add({
      title: text.slice(0, 200),
      description: '',
      startDate: dateStr,
      endDate: dateStr,
      isAllDay: false,
      startTime,
      endTime: `${eh}:${em}`,
      color: COLOR_BY_TYPE[eventType] || 'latte',
      eventType,
      done: true, // 打卡本身就是完成
      createdVia: getSourceId(ev), // 回音抑制
    });
  await recordLastOp(targetUid, { type: 'create', eventId: ref.id });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `✅ 打卡：${text}\n　${dateStr} ${startTime}`,
  }));
}

// 24 節氣（粗略 — 用每年固定日期 ±1 天的近似值，足以給 LINE 顯示「下個節氣」）
const SOLAR_TERMS = [
  { name: '小寒', m: 1, d: 6 }, { name: '大寒', m: 1, d: 20 },
  { name: '立春', m: 2, d: 4 }, { name: '雨水', m: 2, d: 19 },
  { name: '驚蟄', m: 3, d: 6 }, { name: '春分', m: 3, d: 21 },
  { name: '清明', m: 4, d: 5 }, { name: '穀雨', m: 4, d: 20 },
  { name: '立夏', m: 5, d: 6 }, { name: '小滿', m: 5, d: 21 },
  { name: '芒種', m: 6, d: 6 }, { name: '夏至', m: 6, d: 21 },
  { name: '小暑', m: 7, d: 7 }, { name: '大暑', m: 7, d: 23 },
  { name: '立秋', m: 8, d: 8 }, { name: '處暑', m: 8, d: 23 },
  { name: '白露', m: 9, d: 8 }, { name: '秋分', m: 9, d: 23 },
  { name: '寒露', m: 10, d: 8 }, { name: '霜降', m: 10, d: 24 },
  { name: '立冬', m: 11, d: 7 }, { name: '小雪', m: 11, d: 22 },
  { name: '大雪', m: 12, d: 7 }, { name: '冬至', m: 12, d: 22 },
];
async function replyNextSolarTerm(client, ev) {
  const todayStr = formatDateTW(new Date());
  const y = new Date().getFullYear();
  const allWithDates = [];
  for (const yr of [y, y + 1]) {
    SOLAR_TERMS.forEach((t) => {
      allWithDates.push({
        date: `${yr}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`,
        name: t.name,
      });
    });
  }
  const future = allWithDates.filter((t) => t.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  if (future.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '查不到節氣' }));
  }
  const lines = ['🌿 接下來的節氣：', ''];
  future.slice(0, 6).forEach((t) => {
    const days = daysBetween(t.date, todayStr);
    const dLabel = days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天後`;
    lines.push(`${t.date}（${dLabel}）— ${t.name}`);
  });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// ============================================================
// Batch 4: 撤回 / 稍後提醒 helpers
// ============================================================

// 撤回 helper：記錄最近一次操作 (create / update / delete) 給「撤回」用
// 存在 users/{uid}/bibi_settings/lastop 單一 doc，每次 CRUD 覆蓋
async function recordLastOp(uid, op) {
  if (!uid || !op) return;
  try {
    await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_settings').doc('lastop')
      .set({ ...op, timestamp: admin.firestore.FieldValue.serverTimestamp() });
  } catch (e) {
    console.warn('[lastop] failed', e?.message);
  }
}

async function tryUndoLastOp(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const targetUid = uids[0];
  const ref = db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid)
    .collection('bibi_settings').doc('lastop');
  const snap = await ref.get();
  if (!snap.exists) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '⚠️ 沒有可撤回的操作',
    }));
  }
  const op = snap.data();
  const eventsCol = db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid).collection('bibi_events');
  try {
    if (op.type === 'create' && op.eventId) {
      await eventsCol.doc(op.eventId).delete();
      await ref.delete();
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: `↩️ 已撤回新增：${op.after?.title || ''}`,
      }));
    }
    if (op.type === 'update' && op.eventId && op.before) {
      await eventsCol.doc(op.eventId).set(op.before);
      await ref.delete();
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: `↩️ 已撤回修改：${op.before.title || ''}`,
      }));
    }
    if (op.type === 'delete' && op.before) {
      await eventsCol.add({ ...op.before, createdVia: getSourceId(ev) });
      await ref.delete();
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: `↩️ 已撤回刪除：${op.before.title || ''}`,
      }));
    }
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '⚠️ 上個操作無法撤回',
    }));
  } catch (e) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `❌ 撤回失敗：${e?.message || ''}`,
    }));
  }
}

// 稍後提醒：寫到 pending_reminders collection，每 5 分鐘 cron 撈出已到期的推播
// 格式偵測：「30 分鐘後提醒 X」「1 小時後提醒 X」「2 小時後 X」
async function tryDelayedReminder(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '格式：「30 分鐘後提醒 倒垃圾」「1 小時後 接小孩」',
    }));
  }
  // 解析延遲時間
  const m = text.match(/^(\d+)[\s　]*(分鐘?|小時|時|hr|min)[\s　]*(?:後|之後)?[\s　]*(?:提醒[\s　]*(?:我)?)?[\s　]*(.+?)$/);
  if (!m) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '解析不出來。例：「30 分鐘後提醒 倒垃圾」',
    }));
  }
  const amount = parseInt(m[1], 10);
  const unit = m[2];
  const reminderText = m[3].trim();
  const minutes = (unit.startsWith('小') || unit === '時' || unit === 'hr')
    ? amount * 60 : amount;
  if (minutes < 1 || minutes > 24 * 60 * 7) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '提醒時間範圍：1 分鐘 ~ 7 天',
    }));
  }
  const sourceId = getSourceId(ev);
  if (!sourceId) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '無法辨識聊天視窗',
    }));
  }
  const triggerAt = admin.firestore.Timestamp.fromMillis(Date.now() + minutes * 60 * 1000);
  await db().collection('artifacts').doc(APP_ID)
    .collection('pending_reminders').add({
      sourceId,
      text: reminderText.slice(0, 200),
      triggerAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  const triggerDate = new Date(Date.now() + minutes * 60 * 1000);
  const hh = String(triggerDate.getHours()).padStart(2, '0');
  const mm = String(triggerDate.getMinutes()).padStart(2, '0');
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: `⏰ ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分後` : `${minutes} 分鐘後`} (${hh}:${mm}) 提醒你：\n　${reminderText}`,
  }));
}

// 產出 iCal 格式 .ics 字串
function buildICS(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BiBi-Schedule//ZH-TW',
    'X-WR-CALNAME:BiBi 行事曆',
    'X-WR-TIMEZONE:Asia/Taipei',
  ];
  for (const e of events) {
    if (!e.title || !e.startDate) continue;
    const uid = `${e._eventId || Math.random().toString(36).slice(2)}@bibi-schedule`;
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${(e.title || '').replace(/[\r\n,;]/g, ' ')}`);
    if (e.description) {
      lines.push(`DESCRIPTION:${e.description.replace(/[\r\n,;]/g, ' ').slice(0, 500)}`);
    }
    if (e.isAllDay) {
      const dtStart = e.startDate.replace(/-/g, '');
      // iCal DTEND 是 exclusive，要 +1 天
      const endNext = addDaysStr(e.endDate || e.startDate, 1).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
      lines.push(`DTEND;VALUE=DATE:${endNext}`);
    } else {
      const dtStart = `${e.startDate.replace(/-/g, '')}T${(e.startTime || '09:00').replace(':', '')}00`;
      const dtEnd = `${(e.endDate || e.startDate).replace(/-/g, '')}T${(e.endTime || '10:00').replace(':', '')}00`;
      lines.push(`DTSTART;TZID=Asia/Taipei:${dtStart}`);
      lines.push(`DTEND;TZID=Asia/Taipei:${dtEnd}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// 匯出指令：產生 .ics 下載 URL (用 token 防別人偷拿)
async function tryExportICS(client, ev, text) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const targetUid = uids[0];
  // 先確保有匯出 token，沒有就生一個存到 settings
  const settingsRef = db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid)
    .collection('bibi_settings').doc('export');
  let snap = await settingsRef.get();
  let token = snap.exists ? snap.data().icalToken : null;
  if (!token) {
    const { randomUUID } = require('crypto');
    token = randomUUID();
    await settingsRef.set({ icalToken: token, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  // 解析範圍：「匯出 5月」「匯出 本月」「匯出」(全部未來)
  let rangeLabel = '未來全部';
  let queryStr = '';
  if (text) {
    const range = getRangeFromText('整月行程 ' + text) || getRangeFromText(text);
    if (range) {
      rangeLabel = range.title;
      queryStr = `&start=${formatDateTW(range.start)}&days=${range.days}`;
    }
  }
  const url = `https://exportical-${process.env.FUNCTION_REGION || 'asia-east1'}-${APP_ID}.cloudfunctions.net/exportIcal?uid=${targetUid}&token=${token}${queryStr}`;
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text:
      `📤 iCal 匯出連結（${rangeLabel}）：\n${url}\n\n` +
      '貼到 Google / Apple Calendar 的「從 URL 訂閱」即可同步。\n' +
      '⚠️ URL 內含 token，請勿外流。',
  }));
}

// ============================================================
// Batch 3: 批量新增 + 重複行程
// ============================================================

// 批量新增：「新增 5/20, 5/22, 5/25 牙醫」一次建三筆相同事件
// 偵測規則：第一段含「,」或「、」分隔的多個日期
async function tryBatchCreate(client, ev, text) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '尚未綁定行事曆',
    }));
  }
  // 把日期段抓出來：開頭一直到「最後一個逗號分隔的日期」
  const m = text.match(/^([\d\/\-,\s、，]+)\s+(.+)$/);
  if (!m) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '格式：「批量 5/20, 5/22, 5/25 牙醫」',
    }));
  }
  const datePart = m[1];
  const titlePart = m[2].trim();
  const dateStrs = datePart.split(/[,，、\s]+/).filter(Boolean);
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const targetUid = uids[0];
  const roles = await getRoleSettings(targetUid);
  const senderRole = await getSenderRoleForUid(targetUid, ev.source?.userId);
  const created = [];
  for (const ds of dateStrs) {
    const tok = parseDateToken(ds, todayStr, todayDow);
    if (!tok) continue;
    // 用 parseNaturalEvent 處理標題 + 顏色，但日期套用本筆
    const fakeText = `${tok.consumed} ${titlePart}`;
    const parsed = parseNaturalEvent(fakeText, roles, todayStr, todayDow);
    if (!parsed || parsed.error) continue;
    if (parsed.eventType === 'common' && senderRole && !parsed._explicitCommon) {
      parsed.eventType = senderRole;
      parsed.color = COLOR_BY_TYPE[senderRole] || COLOR_BY_TYPE.common;
    }
    delete parsed._explicitCommon;
    parsed.createdVia = sourceId; // 回音抑制：新增通知跳過來源聊天室
    const ref = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(targetUid).collection('bibi_events').add(parsed);
    created.push({ date: parsed.startDate, id: ref.id });
  }
  if (created.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '所有日期都解析失敗',
    }));
  }
  const lines = [`📋 已批量新增 ${created.length} 筆「${titlePart}」`, ''];
  created.forEach((c) => lines.push(`  • ${c.date}`));
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: lines.join('\n'),
  }));
}

// 重複行程：「重複 每週一 10:00 開會 共 8 次」「重複 每月 15 號 房租 12 次」「重複 每天 22:00 吃藥 30 次」
async function tryRecurringCreate(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '格式：\n「重複 每週一 10:00 開會 共 8 次」\n「重複 每月 15 號 房租 12 次」\n「重複 每天 22:00 吃藥 30 次」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  // 抓出「共 N 次 / N 次」當作 count，預設 12
  let count = 12;
  const countMatch = text.match(/(?:共[\s　]*)?(\d+)[\s　]*次/);
  if (countMatch) count = parseInt(countMatch[1], 10);
  if (count > 60) count = 60;
  if (count < 1) count = 1;
  let working = countMatch ? text.replace(countMatch[0], '').trim() : text;

  // 偵測週期
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const dowMap = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  let startDates = [];
  let intervalDays = null;

  let mMatch;
  if ((mMatch = working.match(/每週([日一二三四五六])/))) {
    const targetDow = dowMap[mMatch[1]];
    // 找到第一個 >= today 的 targetDow
    let d = new Date(todayStr + 'T00:00:00');
    while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
    for (let i = 0; i < count; i++) {
      const ds = new Date(d);
      ds.setDate(d.getDate() + i * 7);
      startDates.push(formatDateTW(ds));
    }
    working = working.replace(mMatch[0], '').trim();
    intervalDays = 7;
  } else if ((mMatch = working.match(/每月[\s　]*(\d{1,2})[\s　]*(?:號|日)?/))) {
    const day = parseInt(mMatch[1], 10);
    if (day < 1 || day > 31) {
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: '每月日期要 1-31',
      }));
    }
    const now = new Date(todayStr + 'T00:00:00');
    let y = now.getFullYear();
    let m = now.getMonth();
    // 如果本月那天已過，從下個月開始
    if (now.getDate() > day) m += 1;
    for (let i = 0; i < count; i++) {
      const ds = new Date(y, m + i, day);
      startDates.push(formatDateTW(ds));
    }
    working = working.replace(mMatch[0], '').trim();
  } else if (working.match(/^每天/)) {
    for (let i = 0; i < count; i++) {
      startDates.push(addDaysStr(todayStr, i));
    }
    working = working.replace(/^每天[\s　]*/, '').trim();
    intervalDays = 1;
  } else {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '抓不到週期。格式：\n「每週X」「每月 N 號」「每天」\n例：「重複 每週一 10:00 開會 共 8 次」',
    }));
  }

  // 解析時間 + 標題：剩下的 working 餵給 parseNaturalEvent（用第一個日期）
  const targetUid = uids[0];
  const roles = await getRoleSettings(targetUid);
  const senderRole = await getSenderRoleForUid(targetUid, ev.source?.userId);
  const fakeText = `${startDates[0].replace(/-/g, '/').replace(/^\d{4}\//, '')} ${working}`;
  const sample = parseNaturalEvent(fakeText, roles, todayStr, todayDow);
  if (!sample || sample.error) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '抓不到時間 / 標題。\n例：「重複 每週一 10:00 開會 共 8 次」',
    }));
  }
  // 套用 senderRole fallback
  if (sample.eventType === 'common' && senderRole && !sample._explicitCommon) {
    sample.eventType = senderRole;
    sample.color = COLOR_BY_TYPE[senderRole] || COLOR_BY_TYPE.common;
  }
  delete sample._explicitCommon;

  // 為每個日期建一筆 (用 sample 的 title/time/owner)
  const batch = db().batch();
  for (const ds of startDates) {
    const ref = db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(targetUid).collection('bibi_events').doc();
    batch.set(ref, {
      title: sample.title,
      description: sample.description || '',
      startDate: ds,
      endDate: ds,
      isAllDay: sample.isAllDay,
      startTime: sample.startTime || '',
      endTime: sample.endTime || '',
      color: sample.color,
      eventType: sample.eventType,
      recurringGroup: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdVia: sourceId, // 回音抑制

    });
  }
  await batch.commit();
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: `🔁 已建立重複行程「${sample.title}」共 ${startDates.length} 筆\n　${startDates[0]} ～ ${startDates[startDates.length - 1]}`,
  }));
}

async function tryCreateExplicit(client, ev, text) {
  // 由「新增 X」指令明確觸發，所以可以對所有錯誤狀態都回覆
  if (!text) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請補上行程內容。\n例如：\n　「新增 明天10點 看牙醫」\n　「新增 5/20 全天 媽媽生日」\n　「新增 7/10-7/22 加州旅遊」',
    }));
    return;
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '尚未綁定行事曆，無法新增。先傳：綁定 <你的裝置 ID>',
    }));
    return;
  }

  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const targetUid = uids[0];
  const roles = await getRoleSettings(targetUid);
  const senderRole = await getSenderRoleForUid(targetUid, ev.source?.userId);

  const parsed = parseNaturalEvent(text, roles, todayStr, todayDow);
  if (!parsed) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `抓不到日期 🤔「${text}」\n例如：「新增 明天10點 看牙醫」、「新增 5/20 全天 媽媽生日」`,
    }));
    return;
  }
  if (parsed.error === 'no_title') {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '抓不到行程名稱 🤔\n例如：「新增 明天10點 開會」、「新增 5/20 全天 媽媽生日」',
    }));
    return;
  }

  // 用戶沒明確提到角色名稱、也沒講「共同/一起」這類關鍵字 → fallback 用寄件人角色
  if (parsed.eventType === 'common' && senderRole && !parsed._explicitCommon) {
    parsed.eventType = senderRole;
    parsed.color = COLOR_BY_TYPE[senderRole] || COLOR_BY_TYPE.common;
  }
  // 清掉 internal flag，不要存進 Firestore
  delete parsed._explicitCommon;
  parsed.createdVia = sourceId; // 回音抑制：新增通知跳過來源聊天室

  const added = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid)
    .collection('bibi_events')
    .add(parsed);

  const ownerLabel = parsed.eventType === 'me' ? (roles.role1 || '我')
    : parsed.eventType === 'partner' ? (roles.role2 || '夥伴')
    : '共同';
  await safeReply(client, ev.replyToken, withQuickReply(
    buildEventConfirmFlex(parsed, ownerLabel, { uid: targetUid, eventId: added.id })
  ));
}

async function tryRoleFilteredQuery(client, ev, text) {
  // 「Shane 今天」「阿花 本週」「共同 明天」這類 prefix
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) return false;
  const roles = await getRoleSettings(uids[0]);
  const r1 = (roles.role1 || '').trim();
  const r2 = (roles.role2 || '').trim();

  let filterType = null;
  let remaining = null;
  if (r1 && r1 !== '我' && text.startsWith(r1)) {
    filterType = 'me';
    remaining = text.slice(r1.length).trim();
  } else if (r2 && r2 !== '夥伴' && text.startsWith(r2)) {
    filterType = 'partner';
    remaining = text.slice(r2.length).trim();
  } else if (text.startsWith('只看共同') || text.startsWith('共同 ') ||
             text.startsWith('一起 ')) {
    filterType = 'common';
    remaining = text.replace(/^(只看共同|共同|一起)[\s　]*/, '');
  } else if (text.startsWith('只看我') || text.startsWith('我的 ')) {
    filterType = 'me';
    remaining = text.replace(/^(只看我|我的)[\s　]*/, '');
  }
  if (!filterType || !remaining) return false;

  const range = getRangeFromText(remaining);
  if (!range) return false;
  // 把角色標籤插進 title
  const label = filterType === 'me' ? (r1 || '我')
    : filterType === 'partner' ? (r2 || '夥伴') : '共同';
  range.title = range.title.replace(/^📅\s?/, `📅 ${label}・`);
  range.filterType = filterType;
  await replyAgenda(client, ev, range);
  return true;
}

async function tryEditEvent(client, ev, text) {
  // 三種子指令：改日期 / 改時間 / 改名稱（也可以「改」當改日期簡寫）
  let mode, body;
  if (text.startsWith('改日期')) {
    mode = 'date'; body = text.replace(/^改日期[\s　]*/, '').trim();
  } else if (text.startsWith('改時間')) {
    mode = 'time'; body = text.replace(/^改時間[\s　]*/, '').trim();
  } else if (text.startsWith('改名稱') || text.startsWith('改標題')) {
    mode = 'title'; body = text.replace(/^改(名稱|標題)[\s　]*/, '').trim();
  } else {
    mode = 'date'; body = text.replace(/^改[\s　]*/, '').trim();
  }
  if (!body) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請依以下格式：\n　改日期 5/20 媽媽生日 5/21\n　改時間 5/20 看牙醫 14:30\n　改名稱 5/20 媽媽生日 媽媽77大壽',
    }));
    return;
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '尚未綁定行事曆',
    }));
    return;
  }
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());

  // 第一個 token 必須是舊日期
  const oldDateToken = parseDateToken(body, todayStr, todayDow);
  if (!oldDateToken) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '抓不到舊日期。例：「改日期 5/20 媽媽生日 5/21」',
    }));
    return;
  }
  const afterDate = body.slice(oldDateToken.consumed.length).trim();

  // 解析「舊標題 + 新值」
  let oldTitle, newValue;
  if (mode === 'date') {
    // 最後一個 token 應該是新日期
    const lastSpace = afterDate.lastIndexOf(' ');
    if (lastSpace === -1) {
      await safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: '少了新日期。例：「改日期 5/20 媽媽生日 5/21」',
      }));
      return;
    }
    oldTitle = afterDate.slice(0, lastSpace).trim();
    const newDateStr = afterDate.slice(lastSpace + 1).trim();
    const newDateToken = parseDateToken(newDateStr, todayStr, todayDow);
    if (!newDateToken || newDateStr !== newDateToken.consumed) {
      await safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: `新日期格式錯誤：「${newDateStr}」`,
      }));
      return;
    }
    newValue = newDateToken.date;
  } else if (mode === 'time') {
    const lastSpace = afterDate.lastIndexOf(' ');
    if (lastSpace === -1) {
      await safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: '少了新時間。例：「改時間 5/20 看牙醫 14:30」',
      }));
      return;
    }
    oldTitle = afterDate.slice(0, lastSpace).trim();
    const newTimeStr = afterDate.slice(lastSpace + 1).trim();
    const parsed = parseTimeRangeStr(newTimeStr);
    if (!parsed) {
      await safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: `時間格式錯誤：「${newTimeStr}」(例 14:30 或 14:30-16:00)`,
      }));
      return;
    }
    newValue = parsed;
  } else { // title
    // 用 → 當分隔符 (新標題可能有空格)
    const m = afterDate.match(/^(.+?)\s*[→\->]\s*(.+)$/);
    if (m) {
      oldTitle = m[1].trim();
      newValue = m[2].trim();
    } else {
      const lastSpace = afterDate.lastIndexOf(' ');
      if (lastSpace === -1) {
        await safeReply(client, ev.replyToken, withQuickReply({
          type: 'text', text: '少了新名稱。例：「改名稱 5/20 媽媽生日 媽媽77大壽」\n如果新名稱有空格請用「→」分隔：「改名稱 5/20 X → 新 名 稱」',
        }));
        return;
      }
      oldTitle = afterDate.slice(0, lastSpace).trim();
      newValue = afterDate.slice(lastSpace + 1).trim();
    }
  }
  if (!oldTitle) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請補上要修改的事件名稱關鍵字',
    }));
    return;
  }

  // 找事件
  const targetUid = uids[0];
  const matches = await findEventsByDateTitle(targetUid, oldDateToken.date, oldTitle);
  if (matches.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `${oldDateToken.date} 找不到包含「${oldTitle}」的事件`,
    }));
    return;
  }
  if (matches.length > 1) {
    const list = matches.map((m, i) => `${i + 1}. ${m.data.title}`).join('\n');
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `找到 ${matches.length} 筆相符，請補更精準關鍵字：\n${list}`,
    }));
    return;
  }
  const match = matches[0];
  const updates = {};
  if (mode === 'date') {
    const dayDiff = daysBetween(newValue, match.data.startDate);
    updates.startDate = newValue;
    updates.endDate = addDaysStr(match.data.endDate, dayDiff);
    updates.reminderNotifiedAt = admin.firestore.FieldValue.delete();
  } else if (mode === 'time') {
    Object.assign(updates, newValue);
    updates.reminderNotifiedAt = admin.firestore.FieldValue.delete();
  } else if (mode === 'title') {
    updates.title = newValue;
  }
  await match.ref.update(updates);

  // 顯示更新後的事件
  const after = { ...match.data, ...updates };
  const roles = await getRoleSettings(targetUid);
  const ownerLabel = after.eventType === 'me' ? (roles.role1 || '我')
    : after.eventType === 'partner' ? (roles.role2 || '夥伴') : '共同';
  const flex = buildEventConfirmFlex(after, ownerLabel);
  flex.contents.header.contents[0].text = '✏️ 已更新行程';
  flex.altText = `✏️ 已更新：${after.title}`;
  await safeReply(client, ev.replyToken, withQuickReply(flex));
}

async function handlePostback(client, ev) {
  const dataStr = ev.postback?.data || '';
  const params = new URLSearchParams(dataStr);
  const act = params.get('act');

  // 記帳刪除按鈕（僅私聊；驗證發送者確實綁定該帳務空間）
  if (act === 'fexp_del') {
    const fid = params.get('fid');
    const expenseId = params.get('id');
    const senderId = ev.source?.type === 'user' ? ev.source.userId : null;
    const bound = senderId ? await getFinanceIdForLineUser(senderId) : null;
    if (!fid || !expenseId || bound !== fid) {
      await safeReply(client, ev.replyToken, { type: 'text', text: '⚠️ 無法執行此刪除。' });
      return;
    }
    const ref = finSpaceRef(fid).collection('expenses').doc(expenseId);
    const snap = await ref.get();
    if (!snap.exists) {
      await safeReply(client, ev.replyToken, financeQuickReply({
        type: 'text', text: '⚠️ 這筆記帳已經刪過了。',
      }));
      return;
    }
    const e = { id: snap.id, ...snap.data() };
    await ref.set({ deletedVia: 'line' }, { merge: true });
    await ref.delete();
    await safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: `🗑️ 已刪除：${expenseLineLabel(e)}`,
    }));
    return;
  }

  const uid = params.get('uid');
  const eventId = params.get('id');
  if (!act || !uid || !eventId) return;

  const ref = db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_events').doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '⚠️ 找不到事件 (可能已被刪除)',
    }));
    return;
  }
  const data = snap.data();

  if (act === 'delete') {
    await ref.delete();
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🗑️ 已刪除：${data.title}`,
    }));
    return;
  }

  if (act === 'edit-date' || act === 'edit-datetime') {
    // datetimepicker 觸發的 postback 帶 params.datetime / params.date / params.time
    const pickedDate = ev.postback?.params?.date;
    const pickedDateTime = ev.postback?.params?.datetime;
    const updates = { reminderNotifiedAt: admin.firestore.FieldValue.delete() };

    if (act === 'edit-date' && pickedDate) {
      const dayDiff = daysBetween(pickedDate, data.startDate);
      updates.startDate = pickedDate;
      updates.endDate = addDaysStr(data.endDate, dayDiff);
    } else if (act === 'edit-datetime' && pickedDateTime) {
      // pickedDateTime = "YYYY-MM-DDTHH:MM"
      const [datePart, timePart] = pickedDateTime.split('T');
      const dayDiff = daysBetween(datePart, data.startDate);
      updates.startDate = datePart;
      updates.endDate = addDaysStr(data.endDate, dayDiff);
      updates.startTime = timePart;
      updates.isAllDay = false;
      // 預設 +1hr
      const [h, m] = timePart.split(':').map(Number);
      const endTotal = h * 60 + m + 60;
      const eh = Math.min(23, Math.floor(endTotal / 60));
      const em = endTotal % 60;
      updates.endTime = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
    } else {
      return; // 沒帶 datetime 就忽略
    }

    await ref.update(updates);
    const after = { ...data, ...updates };
    const roles = await getRoleSettings(uid);
    const ownerLabel = after.eventType === 'me' ? (roles.role1 || '我')
      : after.eventType === 'partner' ? (roles.role2 || '夥伴') : '共同';
    const flex = buildEventConfirmFlex(after, ownerLabel, { uid, eventId });
    flex.contents.header.contents[0].text = '✏️ 已更新行程';
    flex.altText = `✏️ 已更新：${after.title}`;
    await safeReply(client, ev.replyToken, withQuickReply(flex));
    return;
  }
}

// -------- AI 助理：cost / safety guards --------

// Webhook 去重複觸發：同一個 webhookEventId 只處理一次 (LINE 偶爾重送)
async function isDuplicateWebhookEvent(webhookEventId) {
  if (!webhookEventId) return false;
  const ref = db().collection('artifacts').doc(APP_ID)
    .collection('webhook_dedup').doc(webhookEventId);
  try {
    return await db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (snap.exists) return true;
      t.set(ref, { processedAt: admin.firestore.FieldValue.serverTimestamp() });
      return false;
    });
  } catch (e) {
    console.warn('[dedup] failed', e?.message);
    return false; // 失敗就放行，寧可重複處理也別漏掉
  }
}

// Rate limit：每個 sourceId 每分鐘最多 N 次 AI 呼叫
async function checkAIRateLimit(sourceId) {
  if (!sourceId) return { allowed: true, count: 0 };
  const ref = db().collection('artifacts').doc(APP_ID)
    .collection('ai_rate_limit').doc(sourceId);
  const oneMinAgo = Date.now() - 60_000;
  try {
    return await db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      const prev = snap.exists ? (snap.data().times || []) : [];
      const recent = prev.filter((ts) => ts > oneMinAgo);
      if (recent.length >= AI_RATE_LIMIT_PER_MIN) {
        return { allowed: false, count: recent.length };
      }
      recent.push(Date.now());
      t.set(ref, { times: recent.slice(-AI_RATE_LIMIT_PER_MIN) });
      return { allowed: true, count: recent.length };
    });
  } catch (e) {
    console.warn('[rate_limit] failed', e?.message);
    return { allowed: true, count: 0 };
  }
}

// 月度用量上限：以 primaryUid 為單位累計
async function checkAndIncrementAIUsage(uid) {
  const monthKey = formatDateTW(new Date()).slice(0, 7); // YYYY-MM
  const ref = db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('ai_usage').doc(monthKey);
  try {
    return await db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= AI_MAX_CALLS_PER_MONTH) {
        return { allowed: false, count, limit: AI_MAX_CALLS_PER_MONTH };
      }
      t.set(ref, {
        count: count + 1,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { allowed: true, count: count + 1, limit: AI_MAX_CALLS_PER_MONTH };
    });
  } catch (e) {
    // 這是花費護欄 → fail closed：Firestore 異常時暫停 AI，而不是放行
    console.warn('[ai_usage] failed (fail closed)', e?.message);
    return { allowed: false, count: -1, limit: AI_MAX_CALLS_PER_MONTH };
  }
}

// AI 操作 log
async function logAIInvocation(uid, sourceId, userMsg, finalAnswer, toolCalls, error) {
  try {
    await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('ai_logs').add({
        sourceId,
        userMsg: (userMsg || '').slice(0, 500),
        finalAnswer: (finalAnswer || '').slice(0, 1500),
        toolCalls: (toolCalls || []).slice(0, 20).map((c) => ({
          name: c.name,
          args: JSON.stringify(c.args || {}).slice(0, 500),
        })),
        error: error ? String(error).slice(0, 300) : null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.warn('[ai_log] failed', e?.message);
  }
}

// LINE 顯示「打字中…」動畫，最多 60 秒 (5 秒一級)
async function startLineLoading(sourceId, seconds = 30) {
  if (!sourceId) return;
  const loadingSeconds = Math.min(60, Math.max(5, Math.ceil(seconds / 5) * 5));
  try {
    await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatId: sourceId, loadingSeconds }),
    });
  } catch (e) {
    console.warn('[loading] failed', e?.message);
  }
}

// AI 對話記憶（短期）：用 sourceId 當 key，存最近幾輪 user/assistant 對話
async function loadAIConversation(sourceId) {
  if (!sourceId) return [];
  try {
    const ref = db().collection('artifacts').doc(APP_ID)
      .collection('ai_conversations').doc(sourceId);
    const snap = await ref.get();
    if (!snap.exists) return [];
    const data = snap.data();
    const ttlMs = AI_CONVERSATION_TTL_HOURS * 3600 * 1000;
    const updatedAt = data.updatedAt?.toMillis?.() || 0;
    if (Date.now() - updatedAt > ttlMs) return [];
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (e) {
    console.warn('[convo_load] failed', e?.message);
    return [];
  }
}

// 判斷 sourceId 是不是在 AI 對話追問期 (5 分鐘內有對話記錄)
// 用來讓使用者後續回「不用」「對」等不帶「親」前綴的話也能進到 AI agent
async function hasRecentAIConversation(sourceId, withinMinutes = 5) {
  if (!sourceId) return false;
  try {
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('ai_conversations').doc(sourceId).get();
    if (!snap.exists) return false;
    const updatedAt = snap.data().updatedAt?.toMillis?.() || 0;
    return Date.now() - updatedAt < withinMinutes * 60 * 1000;
  } catch {
    return false;
  }
}

async function saveAIConversation(sourceId, messages) {
  if (!sourceId) return;
  try {
    // 只保留最近 N 輪 user+assistant 交互
    const kept = messages.slice(-AI_CONVERSATION_KEEP_TURNS * 2);
    await db().collection('artifacts').doc(APP_ID)
      .collection('ai_conversations').doc(sourceId)
      .set({
        messages: kept,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.warn('[convo_save] failed', e?.message);
  }
}

// -------- AI 助理：直接操作行事曆 + 即時上網 --------
// Tool 給 GPT 呼叫。所有寫入只能寫到 ctx.primaryUid，讀取/修改/刪除限制在 ctx.uids 範圍內。
const aiToolHandlers = {
  async get_events({ startDate, endDate }, ctx) {
    const results = [];
    for (const uid of ctx.uids) {
      const snap = await db().collection('artifacts').doc(APP_ID)
        .collection('users').doc(uid).collection('bibi_events')
        .where('startDate', '<=', endDate).get();
      const roles = ctx.uidRoles[uid] || {};
      snap.forEach((d) => {
        const e = d.data();
        if (!e.endDate || e.endDate < startDate) return;
        results.push({
          _uid: uid,
          _eventId: d.id,
          title: e.title,
          startDate: e.startDate,
          endDate: e.endDate,
          isAllDay: !!e.isAllDay,
          startTime: e.startTime || null,
          endTime: e.endTime || null,
          description: e.description || '',
          eventType: e.eventType || 'common',
          ownerName: computeOwnerLabel(e.eventType, roles),
        });
      });
    }
    return { events: results.slice(0, 80) };
  },

  async search_events({ query }, ctx) {
    const results = [];
    for (const uid of ctx.uids) {
      const snap = await db().collection('artifacts').doc(APP_ID)
        .collection('users').doc(uid).collection('bibi_events').get();
      const roles = ctx.uidRoles[uid] || {};
      snap.forEach((d) => {
        const e = d.data();
        const blob = `${e.title || ''} ${e.description || ''}`;
        if (!blob.includes(query)) return;
        results.push({
          _uid: uid,
          _eventId: d.id,
          title: e.title,
          startDate: e.startDate,
          endDate: e.endDate,
          isAllDay: !!e.isAllDay,
          startTime: e.startTime || null,
          endTime: e.endTime || null,
          eventType: e.eventType || 'common',
          ownerName: computeOwnerLabel(e.eventType, roles),
        });
      });
    }
    return { events: results.slice(0, 30) };
  },

  async create_event(args, ctx) {
    const eventType = ['me', 'partner', 'common'].includes(args.eventType) ? args.eventType : 'common';
    // 顏色決定優先順序：AI 指定 > 角色預設
    // - me 預設 smokedPlum (莫蘭迪紅)、partner 預設 pastelCream (莫蘭迪奶油)
    // - common: AI 可以依標題內容自由選色 (AI_COLOR_HINTS)
    const aiPickedColor = args.color && AI_COLOR_HINTS.find((c) => c.key === args.color)?.key;
    const color = aiPickedColor || COLOR_BY_TYPE[eventType] || 'latte';
    const data = {
      title: String(args.title || '').slice(0, 200),
      startDate: args.startDate,
      endDate: args.endDate || args.startDate,
      isAllDay: !!args.isAllDay,
      startTime: args.isAllDay ? '' : (args.startTime || '09:00'),
      endTime: args.isAllDay ? '' : (args.endTime || '10:00'),
      description: String(args.description || '').slice(0, 1000),
      eventType,
      color,
      createdVia: ctx.sourceId || null, // 回音抑制：新增通知跳過來源聊天室
    };
    if (!data.title || !data.startDate || !data.endDate) {
      return { error: 'title / startDate / endDate 不能空' };
    }
    const ref = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(ctx.primaryUid).collection('bibi_events').add(data);
    const roles = ctx.uidRoles[ctx.primaryUid] || {};
    await recordLastOp(ctx.primaryUid, { type: 'create', eventId: ref.id, after: data });
    return {
      ok: true, _eventId: ref.id, _uid: ctx.primaryUid,
      ...data,
      ownerName: computeOwnerLabel(eventType, roles),
    };
  },

  async update_event({ uid, eventId, updates }, ctx) {
    if (!ctx.uids.includes(uid)) return { error: '無權更新此 uid 的行程' };
    const ref = db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events').doc(eventId);
    const before = await ref.get();
    if (!before.exists) return { error: '事件不存在' };
    const allowed = ['title', 'startDate', 'endDate', 'isAllDay', 'startTime', 'endTime', 'description', 'eventType'];
    const safe = {};
    for (const k of allowed) if (updates && updates[k] !== undefined) safe[k] = updates[k];
    if (safe.eventType && COLOR_BY_TYPE[safe.eventType]) safe.color = COLOR_BY_TYPE[safe.eventType];
    await ref.update(safe);
    await recordLastOp(uid, { type: 'update', eventId, before: before.data(), after: { ...before.data(), ...safe } });
    return { ok: true, _eventId: eventId, _uid: uid, updates: safe };
  },

  async delete_event({ uid, eventId }, ctx) {
    if (!ctx.uids.includes(uid)) return { error: '無權刪除此 uid 的行程' };
    const ref = db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events').doc(eventId);
    const before = await ref.get();
    if (!before.exists) return { error: '事件不存在' };
    const title = before.data().title;
    await recordLastOp(uid, { type: 'delete', eventId, before: before.data() });
    await ref.delete();
    return { ok: true, deletedTitle: title };
  },
};

function aiCalendarToolDefs() {
  return [
    {
      type: 'function',
      name: 'get_events',
      description: '查指定日期區間內所有行程。回傳每筆帶 _uid + _eventId 供後續 update/delete 使用。',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['startDate', 'endDate'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'search_events',
      description: '依關鍵字模糊搜尋行程 (含 title + description)，跨所有時間。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'create_event',
      description:
        '【新增行程的唯一方法】要在行事曆建立任何事件都必須呼叫這個 tool，' +
        '不可以僅用文字回「已新增」假裝完成。\n' +
        'eventType: me=role1 的、partner=role2 的、common=兩人共同 (沒明說就 common)。\n' +
        '預設顏色：me→smokedPlum (莫蘭迪紅)，partner→pastelCream (莫蘭迪奶油)，common→latte。\n' +
        '可選擇傳入 color 覆寫，common 行程建議依標題語意挑選 color (見下方清單)。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate: { type: 'string', description: 'YYYY-MM-DD，單日跟 startDate 相同' },
          isAllDay: { type: 'boolean' },
          startTime: { type: 'string', description: 'HH:MM 24h，isAllDay=true 可省略' },
          endTime: { type: 'string', description: 'HH:MM 24h，isAllDay=true 可省略' },
          description: { type: 'string' },
          eventType: { type: 'string', enum: ['me', 'partner', 'common'] },
          color: {
            type: 'string',
            description:
              '可選。常見：smokedPlum/ironBlue/mossGreen/ocher/latte/tea/mist/' +
              'sakura/mint/lemon/lavender/slate/pastelCream/pastelSakura/' +
              'pastelMatcha/pastelSky',
          },
        },
        required: ['title', 'startDate', 'endDate', 'isAllDay'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'update_event',
      description:
        '【修改行程的唯一方法】不可以僅用文字回「已修改」假裝完成。' +
        '請先用 get_events / search_events 取得 _uid 跟 _eventId 再呼叫。',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string' },
          eventId: { type: 'string' },
          updates: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              startDate: { type: 'string' },
              endDate: { type: 'string' },
              isAllDay: { type: 'boolean' },
              startTime: { type: 'string' },
              endTime: { type: 'string' },
              description: { type: 'string' },
              eventType: { type: 'string', enum: ['me', 'partner', 'common'] },
            },
            additionalProperties: false,
          },
        },
        required: ['uid', 'eventId', 'updates'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'delete_event',
      description:
        '【刪除行程的唯一方法】不可以僅用文字回「已刪除」假裝完成。' +
        '請先用 get_events / search_events 確認哪一筆再呼叫。',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string' },
          eventId: { type: 'string' },
        },
        required: ['uid', 'eventId'],
        additionalProperties: false,
      },
    },
  ];
}

// AI Agent：吃完整 input (含歷史)，輸出 {text, toolCalls}
// 偵測使用者輸入是不是「該執行某 tool」的意圖，避免 LLM 用文字假裝完成
// 命中後第一輪呼叫會用 tool_choice='required' 強制 model 必須呼叫至少一個 tool
function detectActionIntent(text) {
  if (!text || text.length < 2) return false;
  // 動詞關鍵字
  const verbs = [
    '新增', '加', '建立', '排程', '排', '訂', '預約', '安排',
    '改', '修改', '換', '挪', '搬', '延', '提前',
    '刪', '取消', '拿掉', '移除',
    '查', '看', '幾件', '哪天', '哪幾天', '多少',
    '幫我', '幫忙', '記一下', '記得'
  ];
  if (verbs.some((v) => text.includes(v))) return true;
  // 純查詢字
  if (['什麼', '哪'].some((w) => text.includes(w))) return true;
  // 短句 + 含時間 → 大多是「明天 X」「週日 X」這種隱含 create
  const timeKeys = ['今天', '明天', '後天', '大後天', '週', '禮拜', '星期', '日', '月', '號', '點', '凌晨', '早上', '中午', '下午', '傍晚', '晚上'];
  const hasTime = timeKeys.some((k) => text.includes(k));
  if (hasTime && text.length <= 30) return true;
  return false;
}

async function runAIAgent(input, ctx, maxIterations = 8) {
  const tools = [
    { type: 'web_search' }, // OpenAI 內建工具，可上網拿即時資訊 (天氣/新聞/查資料)
    ...aiCalendarToolDefs(),
    // 帳務唯讀查詢：只在「私聊 + 已帳務綁定」時注入，群組物理上拿不到這些工具
    ...(ctx.financeId ? aiFinanceToolDefs() : []),
  ];
  const toolCalls = [];
  let allInput = [...input];
  for (let i = 0; i < maxIterations; i++) {
    // 第一輪：若使用者輸入像 CRUD 意圖，強制 tool_choice='required'
    // 後續輪：用 'auto' 讓 model 自己決定要不要再呼叫
    const toolChoice = (i === 0 && ctx.forceTool) ? 'required' : 'auto';
    const data = await openaiResponses(allInput, tools, 'gpt-4o-mini', toolChoice);
    const output = data.output || [];
    allInput = allInput.concat(output);
    let hadFunctionCall = false;
    for (const item of output) {
      if (item.type === 'function_call') {
        hadFunctionCall = true;
        let args = {};
        try { args = JSON.parse(item.arguments || '{}'); } catch {}
        toolCalls.push({ name: item.name, args });
        let result;
        try {
          const fn = aiToolHandlers[item.name] ||
            (ctx.financeId ? aiFinanceToolHandlers[item.name] : undefined);
          result = fn ? await fn(args, ctx) : { error: `unknown tool: ${item.name}` };
        } catch (e) {
          result = { error: String(e?.message || e).slice(0, 300) };
        }
        allInput.push({
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(result),
        });
      }
    }
    if (!hadFunctionCall) {
      // 沒有再 call function = 終局答案
      let text = '';
      for (const item of output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if ((c.type === 'output_text' || c.type === 'text') && c.text) text += c.text;
          }
        }
      }
      return { text: text.trim() || '🤔', toolCalls };
    }
  }
  return { text: '⚠️ 處理太久了，請改用更簡單的句子重試', toolCalls };
}

// Vision: 把 LINE 傳來的圖片下載成 base64
async function downloadLineImageAsBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}` },
  });
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // LINE 圖片大多是 JPEG，但保險起見直接用 image/jpeg
  return { b64: buf.toString('base64'), mimeType: 'image/jpeg' };
}

function buildAISystemPrompt(today, dow, uidRoles, primaryUid, senderRole, senderName) {
  const roleStrs = Object.keys(uidRoles).map((uid) => {
    const r = uidRoles[uid];
    return `  - uid="${uid}": me="${r.role1 || '我'}", partner="${r.role2 || '夥伴'}"`;
  }).join('\n');
  const colorList = AI_COLOR_HINTS.map((c) => `  - ${c.key} — ${c.use}`).join('\n');

  // 「現在發訊息的人」對應到哪個 role：用來決定預設 eventType
  // - 已綁定 (透過「我是 Shane」) → senderRole = 'me' 或 'partner'
  // - 未綁定 → senderRole = null，預設 common
  const senderLine = senderRole
    ? `**現在發這則訊息的人 = ${senderName} (對應 ${senderRole})**`
    : `**現在發訊息的人未綁定 role**（沒打過「我是 XXX」）`;

  // 計算本週/下週/下下週每天的日期 (週起始 = 週一)
  // 直接寫死給 AI 查，避免它自己算錯（曾踩雷：「這禮拜天」被誤判成今天）
  const dowSun = getDayOfWeekTaipei(new Date(today + 'T00:00:00')); // 0=Sun~6=Sat
  const dowMonFirst = (dowSun + 6) % 7; // 0=Mon~6=Sun
  const labels = ['一', '二', '三', '四', '五', '六', '天']; // Mon~Sun
  const weekRows = (offsetWeeks) => labels.map((lbl, i) => {
    const offset = (i - dowMonFirst) + offsetWeeks * 7;
    return `  禮拜${lbl} = ${addDaysStr(today, offset)}`;
  }).join('\n');

  // ============================================================
  // 結構說明：
  // 上半部 (# 一 ~ # 九) 完全靜態，讓 OpenAI prompt caching 命中
  // 下半部 (# 十) 才放動態日期/角色，每次不同
  // ============================================================
  return `你是 BiBi 行事曆的 AI 助理「親」，幫一對伴侶管理共同行程。

# 一、人格 & 講話風格
- 像安靜可靠的私人秘書：不囉嗦、不雞婆、不諂媚。
- 台灣口語中文，平輩語氣，emoji 適度別氾濫。
- 預設使用者很忙：每句話都有目的，能 1 行解決就不要 3 行。

# 二、工具選用 (順序就是判斷邏輯)
1. 行事曆相關 → get_events / search_events / create_event / update_event / delete_event
2. 需最新外部資料（天氣/股市/新聞/查地點/即時匯率/比賽結果）→ web_search
3. 常識 / 算數 / 純對話 → **直接答，別呼叫任何工具**（web_search 是付費的，
   問「番茄炒蛋怎麼做」不要去搜）。

# 🚨 重要：行程動作一定要呼叫 tool，不能只回文字
- 要新增 → **必須**呼叫 create_event
- 要修改 → **必須**呼叫 update_event
- 要刪除 → **必須**呼叫 delete_event
- 要查詢 → **必須**呼叫 get_events 或 search_events
**絕對不要在沒呼叫 tool 的情況下回「✅ 已新增…」「✏️ 已修改…」之類的話。**
沒呼叫 tool 就 = 沒做事，就算文字寫得很完整也是在騙人。
這是最常見錯誤，請自我檢查：每次回覆「已新增 / 已修改 / 已刪除」之前，
本輪 output 一定要有對應的 function_call。

# 三、日期解析（最常踩雷，務必照規則）
所有相對日期都轉成 YYYY-MM-DD 再呼叫 tool。
- 禮拜天 / 週日 / 星期天 / 星期日 = **Sunday**，不是「今天」也不是「任一天」
- 禮拜一~禮拜六 對應 Mon~Sat
- 「這禮拜X / 這週X」→ 直接查〈本週日期〉表，**不要自己算**
- 「下禮拜X / 下週X」→ 查〈下週日期〉表
- 「下下禮拜X / 下下週X」→ 查〈下下週日期〉表
- 「明天 / 後天 / 大後天」= today + 1 / 2 / 3 天
- 「N 天後 / N 天前」= today ± N 天
- 「禮拜X 中午」這種日期+時間 → 先抓日期再附時間

# 四、時間預設（重要：沒寫具體時間就是全天）
- **規則**：使用者沒寫具體時間點 → isAllDay=true (全天) 直接建立。
- 「具體時間」= 含數字的時間，例：3 點、14:00、八點半、晚上 8 點、下午 3 點半
- 「模糊時段詞」（早上 / 中午 / 下午 / 傍晚 / 晚上 / 凌晨 / 半夜）單獨出現 → 仍視為全天，不要硬塞時間
- 模糊詞 + 具體數字（例「下午 3 點」「晚上 8 點」）→ 用該時間
- 時長預設 1 小時（除非使用者另說）

範例：
- 「明天健身房」 → 全天 ✅
- 「明天晚上健身房」 → 全天 ✅（晚上是模糊詞）
- 「明天晚上 8 點健身房」 → 20:00-21:00 ✅
- 「明天 14:00 開會」 → 14:00-15:00 ✅
- 「明天下午 3 點看醫生」 → 15:00-16:00 ✅

# 五、果斷原則（最重要）
有「事 + 日期」就**直接 create_event**，不要追問細節：
- ✅ 「明天健身房」 → 直接建明天全天「健身房」
- ✅ 「這禮拜天甜點店」 → 直接建那天全天「甜點店」
- ✅ 「這禮拜天 12 點甜點店」 → 直接建那天 12:00-13:00「甜點店」
- ✅ 「6/1 全家旅遊三天」 → 直接建 6/1-6/3 全天「全家旅遊」
- ❌ 不要回「請問你要新增嗎？店名是？地址是？要幾點？」
只有完全模糊（例「幫我加個東西」沒時間沒事）才追問，且只問**一個關鍵點**。

# 六、追問接話（依上下文判斷，不要又重問）
- 「不用 / 不需要 / 算了」 → 用預設值直接執行
- 「對 / 是 / 好 / ok / 確認」 → 直接執行剛才提的動作
- 「不對 / 不是 / 取消」 → 停下、不要動，等下一個指示

# 七、修改 / 刪除安全流程
1. 先 get_events 或 search_events 拿到 _eventId + _uid
2. 找到 **1 筆** → 直接動
3. 找到 **2 筆以上** → 列出讓使用者選，**這輪不要動**
4. 找不到 → 老實說「沒找到 XXX，我搜過 5/15~5/25 共 0 筆」

# 八、回覆格式（短、可掃讀）
完成操作的標準範本（1~2 行就好）：
- 新增： ✅ 已加 5/24 (日) 12:00 甜點店 (共同)
- 修改： ✏️ 5/20 牙醫 → 5/22 14:00
- 刪除： 🗑️ 已刪 5/20 牙醫
- 多筆候選： 找到 2 筆「牙醫」：
            1. 5/20 (二) 14:00 (我)
            2. 5/27 (二) 14:00 (我)
            要動哪一個？
- 列行程： 📅 5/24 (日)
            • 全天 媽媽生日 (共同)
            • 12:00 甜點店 (共同)
            • 18:00 晚餐 (夥伴)
- 上網結果： 1-2 句總結即可
整個回覆 **< 400 字**（LINE 上太長反而看不下去）。

# 九、嚴格禁止
- ❌ 不編造行程，沒查到就老實說
- ❌ 不主動雞婆建議（「順便要不要…」「我幫你也…」）
- ❌ 不複述使用者剛說的話（「好的關於你說的 5/24 中午…」← 浪費字數）
- ❌ 不自我介紹 / 不解釋你是 AI / 不說「我是大型語言模型…」
- ❌ 不過度道歉
- ❌ 不在 common 行程之外亂選 color，me / partner 用預設色就好

# 顏色色票 (僅 common 行程可選傳 color)
${colorList}

# 角色歸屬 / 顏色預設（重要）
${senderLine}

判斷 eventType 的優先順序：
1. 使用者明確說「共同 / 一起 / 我們 / 兩個人 / 兩人 / 我倆」 → eventType=common → latte (深咖啡)
2. 使用者明確提到 role1 (對方 role1 名字) → eventType=me → smokedPlum (莫蘭迪紅)
3. 使用者明確提到 role2 (對方 role2 名字) → eventType=partner → pastelCream (莫蘭迪奶油)
4. 都沒明說、且**發訊息的人有綁 role** → eventType=senderRole (歸這個發訊息的人)
5. 都沒明說、發訊息的人也沒綁 role → eventType=common (fallback)

範例（假設 senderRole=me，使用者叫 "Shane"）：
- 「明天健身房」 → me (歸 Shane，因為沒講別人)
- 「明天我們一起看電影」 → common (有「我們/一起」關鍵字)
- 「明天阿花要去看牙醫」 → partner (明確說阿花)
- 「明天 Shane 跟阿花要去吃飯」 → common (兩個人都提到 = 共同)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 十、本次對話的即時資訊（每次不同）

今天：${today} (星期${dow})、台北時區。

📅 本週日期（Mon→Sun）：
${weekRows(0)}

📅 下週日期：
${weekRows(1)}

📅 下下週日期：
${weekRows(2)}

📋 綁定的行事曆 uid 與角色名：
${roleStrs}
建立新行程預設寫到 primaryUid="${primaryUid}"。`;
}

async function replyAskGPT(client, ev, question, options = {}) {
  // options: { initialUserContent }  — Vision 用，把 user 訊息換成多模態 content array
  if (!question && !options.initialUserContent) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請帶上要問 / 要做的事。\n例：\n　「親 我下週有幾件事」\n　「親 明天3點和小美喝咖啡幫我加進去」\n　「親 把5/20牙醫改到5/22」\n　「親 台北明天會下雨嗎」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    // 只綁帳務、沒綁行事曆的人給明確指引（AI 目前需要行事曆綁定才能啟動）
    const finOnly = await getFinanceIdForEvent(ev);
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: finOnly
        ? 'AI 助理需要先綁定行事曆才能使用（帳務查詢也是走同一個 AI）。\n請先傳：綁定 <你的裝置 ID>\n（App 設定裡有「複製綁定指令」按鈕）'
        : '尚未綁定行事曆。先傳：綁定 <你的裝置 ID>',
    }));
  }
  const primaryUid = uids[0];

  // === 防爆預算三道牆 ===
  // 1. Rate limit (每分鐘)
  const rl = await checkAIRateLimit(sourceId);
  if (!rl.allowed) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `🛑 一分鐘最多用 ${AI_RATE_LIMIT_PER_MIN} 次 AI，稍等一下再試 🙏`,
    }));
  }
  // 2. 月度上限
  const monthly = await checkAndIncrementAIUsage(primaryUid);
  if (!monthly.allowed) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `🛑 這個月 AI 已用 ${monthly.count}/${monthly.limit} 次，下個月 1 號自動歸零。\n（防止意外爆預算的保險機制）`,
    }));
  }

  // === 顯示「打字中…」動畫 ===
  startLineLoading(sourceId, 30); // fire-and-forget

  let finalText = '';
  let toolCalls = [];
  let errorForLog = null;

  try {
    const today = formatDateTW(new Date());
    const dow = ['一', '二', '三', '四', '五', '六', '日'][(getDayOfWeekTaipei(new Date()) - 1 + 7) % 7];
    const uidRoles = {};
    for (const uid of uids) uidRoles[uid] = await getRoleSettings(uid);

    // 抓「發這則訊息的人」對應到哪個 role (透過「我是 XXX」綁定的)
    const senderRole = await getSenderRoleForUid(primaryUid, ev.source?.userId);
    const primaryRoles = uidRoles[primaryUid] || {};
    const senderName = senderRole === 'me' ? (primaryRoles.role1 || '我')
      : senderRole === 'partner' ? (primaryRoles.role2 || '夥伴')
      : '訪客';

    let systemPrompt = buildAISystemPrompt(today, dow, uidRoles, primaryUid, senderRole, senderName);

    // 帳務查詢：只在「一對一私聊 + 已帳務綁定」注入工具與說明；
    // 群組/未綁定 → 不給工具也不揭露資料，僅引導到私聊
    const financeId = await getFinanceIdForEvent(ev);
    if (financeId) {
      systemPrompt += '\n\n【帳務查詢】此私聊的使用者已綁定個人帳務空間。' +
        '你可以用 query_expenses / query_finance_bills 查詢他的私人記帳、信用卡帳期與貸款（唯讀，金額為新台幣）。' +
        '這是使用者本人的私密資料，只在這個私聊回答。' +
        '你沒有任何寫入記帳的工具——不可宣稱已幫使用者記帳/刪帳，請引導他直接輸入「品項 金額」。';
    } else {
      systemPrompt += '\n\n【帳務】你在此對話沒有任何記帳/帳務工具，也拿不到任何消費資料。' +
        '若被問到記帳、花費金額、信用卡帳單等問題，一律回覆：帳務功能僅在個人私聊中提供' +
        (ev.source?.type === 'user' ? '，請先傳「帳務綁定」啟用。' : '。') +
        '不可編造任何金額。';
    }

    // 載入對話歷史 (短期記憶)
    const history = await loadAIConversation(sourceId);

    // 組 input：system + history + 這次 user
    const userContent = options.initialUserContent || question;
    const input = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userContent },
    ];

    // 若使用者輸入像 CRUD 意圖 (含時間/動詞)，強制 model 第一輪必須呼叫 tool
    // 避免 hallucination：用文字假裝完成新增/修改/刪除
    const forceTool = typeof question === 'string' && detectActionIntent(question);
    const result = await runAIAgent(input, { uids, primaryUid, uidRoles, forceTool, financeId, sourceId });
    finalText = result.text;
    toolCalls = result.toolCalls;

    // 安全網：若 AI 文字宣稱完成 CRUD 但實際沒呼叫對應 tool → 改成警告，
    // 避免使用者以為操作成功
    const claimedMutation = /已(新增|加入|建立|加好|排好|修改|更動|改|刪除|刪掉|取消|拿掉)/.test(finalText);
    const actuallyMutated = toolCalls.some((t) =>
      ['create_event', 'update_event', 'delete_event'].includes(t.name));
    if (claimedMutation && !actuallyMutated) {
      console.warn('[ai_hallucination]', { question, finalText, toolCalls });
      finalText = '⚠️ 抱歉，我剛剛回覆裡的「已完成」是錯的，' +
        '實際上沒寫到行事曆。請改用更明確的句子重講一次，' +
        '例如「親 幫我加 5/22 20:00 慢跑」。';
    }

    // 存對話歷史 (只存 user / assistant 純文字，不存 tool call)
    // user content 如果是多模態，存純文字摘要
    const userTextForHistory = typeof userContent === 'string'
      ? userContent
      : `[圖片] ${question || ''}`.trim();
    await saveAIConversation(sourceId, [
      ...history,
      { role: 'user', content: userTextForHistory },
      { role: 'assistant', content: finalText },
    ]);

    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: finalText.slice(0, 4900),
    }));
  } catch (err) {
    console.error('[ask] failed', err?.message || err);
    errorForLog = err?.message || String(err);
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `❌ AI 失敗，等等再試\n${String(err?.message || '').slice(0, 200)}`,
    }));
  } finally {
    // log 給後台追蹤
    await logAIInvocation(primaryUid, sourceId,
      typeof question === 'string' ? question : '[image]',
      finalText, toolCalls, errorForLog);
  }
}

// 接收 LINE 圖片訊息 → 走 Vision pipeline
async function replyAskGPTFromImage(client, ev, messageId, caption) {
  const sourceId = getSourceId(ev);
  startLineLoading(sourceId, 30);
  try {
    const { b64, mimeType } = await downloadLineImageAsBase64(messageId);
    const userContent = [
      {
        type: 'input_text',
        text: caption ||
          '請幫我從這張圖建立行事曆事件 (婚禮邀請函/機票/活動傳單之類)。如果看到日期/時間/地點/標題就抓出來。如果無法判讀就老實說。',
      },
      { type: 'input_image', image_url: `data:${mimeType};base64,${b64}` },
    ];
    await replyAskGPT(client, ev, caption || '[image]', { initialUserContent: userContent });
  } catch (e) {
    console.error('[vision] failed', e?.message || e);
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `❌ 圖片讀取失敗：${String(e?.message || '').slice(0, 120)}`,
    }));
  }
}

// ============================================================
// Batch 2: 完成 / 取消 / 複製 / 延後 / 提前 ─ 共用 helper
// ============================================================

// 通用：依關鍵字 + 日期/最近未來 找一筆事件，回 { ref, data, uid } 或多筆/0 筆訊息
// strategy = 'nearest' | 'date'
async function findOneEventByQuery(uids, titleQuery, dateStr = null) {
  if (!titleQuery) return { error: 'no_query' };
  const todayStr = formatDateTW(new Date());
  const matches = [];
  for (const uid of uids) {
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events').get();
    snap.forEach((d) => {
      const e = d.data();
      if (!e.title || !e.title.includes(titleQuery)) return;
      if (dateStr) {
        // 限定該日期區間內 (該日落在 [startDate, endDate])
        if (e.startDate > dateStr || e.endDate < dateStr) return;
      } else {
        // 未來事件 (最近)
        if (e.endDate < todayStr) return;
      }
      matches.push({ ref: d.ref, data: e, uid });
    });
  }
  matches.sort((a, b) => a.data.startDate.localeCompare(b.data.startDate));
  if (matches.length === 0) return { error: 'not_found' };
  if (matches.length > 1 && !dateStr) {
    // 沒指定日期、多筆 → 回多筆讓使用者選
    return { error: 'multiple', matches };
  }
  return { match: matches[0] };
}

// 完成 ✅：標記 done=true (App 之後可以加打勾顯示)
async function tryCompleteEvent(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶上要完成的事件。\n例：「完成 5/20 牙醫」「完成 牙醫」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const dateToken = parseDateToken(text, todayStr, todayDow);
  const titleQuery = dateToken ? text.slice(dateToken.consumed.length).trim() : text.trim();
  const dateStr = dateToken ? dateToken.date : null;

  const result = await findOneEventByQuery(uids, titleQuery, dateStr);
  if (result.error === 'no_query') {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶上事件名稱關鍵字。',
    }));
  }
  if (result.error === 'not_found') {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 找不到「${titleQuery}」`,
    }));
  }
  if (result.error === 'multiple') {
    const lines = ['找到多筆，請加上日期：', ''];
    result.matches.slice(0, 5).forEach((m, i) =>
      lines.push(`${i + 1}. ${m.data.startDate} ${m.data.title}`));
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: lines.join('\n'),
    }));
  }
  await result.match.ref.update({ done: true, doneAt: admin.firestore.FieldValue.serverTimestamp() });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `✅ 已完成：${result.match.data.title}\n　${result.match.data.startDate}`,
  }));
}

// 取消：標記 status='cancelled' (保留紀錄，跟刪除不同)
async function tryCancelEvent(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶上要取消的事件。\n例：「取消 5/20 牙醫」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const dateToken = parseDateToken(text, todayStr, todayDow);
  const titleQuery = dateToken ? text.slice(dateToken.consumed.length).trim() : text.trim();
  const dateStr = dateToken ? dateToken.date : null;

  const result = await findOneEventByQuery(uids, titleQuery, dateStr);
  if (result.error === 'not_found') {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 找不到「${titleQuery}」`,
    }));
  }
  if (result.error === 'multiple') {
    const lines = ['找到多筆，請加上日期：', ''];
    result.matches.slice(0, 5).forEach((m, i) =>
      lines.push(`${i + 1}. ${m.data.startDate} ${m.data.title}`));
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: lines.join('\n'),
    }));
  }
  await result.match.ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `❎ 已取消：${result.match.data.title}\n　${result.match.data.startDate}`,
  }));
}

// 複製：「複製 5/20 牙醫 到 6/20」「複製 5/20 牙醫 一週後」
async function tryCopyEvent(client, ev, text) {
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '格式：「複製 <來源日期> <事件名> 到 <目標日期>」\n例：「複製 5/20 牙醫 到 6/20」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());

  // 解析「到 / 改成 / →」分割
  const splitMatch = text.match(/^(.+?)[\s　]*(?:到|改成|→|->)[\s　]*(.+?)$/);
  if (!splitMatch) {
    // 沒有「到」→ 可能是「一週後」「N 天後」這種
    const altMatch = text.match(/^(.+?)[\s　]*(一週後|一周後|下週|下周|[一二三四五六七八九十\d]+天後)$/);
    if (!altMatch) {
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: '請用「到」分隔，例：「複製 5/20 牙醫 到 6/20」',
      }));
    }
    const srcPart = altMatch[1];
    const shiftStr = altMatch[2];
    const shiftDays = shiftStr.includes('週') || shiftStr.includes('周') ? 7
      : parseInt(shiftStr.match(/\d+/)?.[0] || '0', 10);
    return await doCopy(client, ev, srcPart, null, shiftDays, uids, todayStr, todayDow);
  }
  return await doCopy(client, ev, splitMatch[1], splitMatch[2], null, uids, todayStr, todayDow);
}
async function doCopy(client, ev, srcPart, dstDateStr, shiftDays, uids, todayStr, todayDow) {
  const srcDate = parseDateToken(srcPart, todayStr, todayDow);
  if (!srcDate) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '抓不到來源日期，例「複製 5/20 牙醫 到 6/20」',
    }));
  }
  const titleQuery = srcPart.slice(srcDate.consumed.length).trim();
  if (!titleQuery) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '請帶上要複製的事件名，例「複製 5/20 牙醫 到 6/20」',
    }));
  }
  const result = await findOneEventByQuery(uids, titleQuery, srcDate.date);
  if (result.error === 'not_found') {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 ${srcDate.date} 找不到「${titleQuery}」`,
    }));
  }
  let targetDate;
  if (dstDateStr) {
    const dstTok = parseDateToken(dstDateStr, todayStr, todayDow);
    if (!dstTok) {
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: `抓不到目標日期「${dstDateStr}」`,
      }));
    }
    targetDate = dstTok.date;
  } else if (shiftDays) {
    targetDate = addDaysStr(result.match.data.startDate, shiftDays);
  }
  const dayDiff = daysBetween(targetDate, result.match.data.startDate);
  const newEndDate = addDaysStr(result.match.data.endDate, dayDiff);
  const orig = result.match.data;
  const newData = {
    title: orig.title,
    description: orig.description || '',
    startDate: targetDate,
    endDate: newEndDate,
    // 舊資料可能缺這些欄位；undefined 會讓 Firestore add() 直接 throw
    isAllDay: !!orig.isAllDay,
    startTime: orig.startTime || '',
    endTime: orig.endTime || '',
    color: orig.color || 'latte',
    eventType: orig.eventType || 'common',
    createdVia: getSourceId(ev), // 回音抑制
  };
  await db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(result.match.uid).collection('bibi_events').add(newData);
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `📋 已複製：${orig.title}\n　${orig.startDate} → ${targetDate}`,
  }));
}

// 延後 / 提前：找最近未來的事件，整體 shift N 天 / 小時
async function tryShiftEvent(client, ev, text, direction) {
  // direction: 1=延後, -1=提前
  if (!text) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: direction > 0
        ? '格式：「延後 牙醫 1 天」「延後 會議 30 分鐘」'
        : '格式：「提前 牙醫 1 天」「提前 會議 30 分鐘」',
    }));
  }
  // 解析「<事件名> <數量> 天/小時/分鐘」
  const m = text.match(/^(.+?)[\s　]+(\d+)[\s　]*(天|小時|分鐘|分|hour|min)/);
  if (!m) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '解析不出來，例：「延後 牙醫 1 天」「延後 會議 30 分鐘」',
    }));
  }
  const titleQuery = m[1].trim();
  const amount = parseInt(m[2], 10);
  const unit = m[3];
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text: '尚未綁定行事曆' }));
  }
  const result = await findOneEventByQuery(uids, titleQuery);
  if (result.error === 'not_found') {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🔍 找不到「${titleQuery}」`,
    }));
  }
  if (result.error === 'multiple') {
    const lines = ['找到多筆，請加日期，例「延後 5/20 牙醫 1 天」：', ''];
    result.matches.slice(0, 5).forEach((mm, i) =>
      lines.push(`${i + 1}. ${mm.data.startDate} ${mm.data.title}`));
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: lines.join('\n'),
    }));
  }
  const data = result.match.data;
  const updates = {};
  if (unit === '天') {
    updates.startDate = addDaysStr(data.startDate, amount * direction);
    updates.endDate = addDaysStr(data.endDate, amount * direction);
  } else if (data.isAllDay) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '全天行程無法用分鐘 / 小時調整，請改用「N 天」或「改時間」',
    }));
  } else {
    // 分鐘 / 小時 → 移動 startTime + endTime
    const minutes = unit.startsWith('小') || unit === 'hour' ? amount * 60 : amount;
    const shift = direction * minutes;
    updates.startTime = shiftTimeStr(data.startTime, shift);
    updates.endTime = shiftTimeStr(data.endTime, shift);
    if (!updates.startTime || !updates.endTime) {
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: '時間超出 00:00-23:59 範圍，無法調整',
      }));
    }
  }
  await result.match.ref.update(updates);
  const arrow = direction > 0 ? '⏩ 延後' : '⏪ 提前';
  const timeRange = updates.startTime
    ? `${updates.startTime}-${updates.endTime}`
    : updates.isAllDay ? '全天' : (data.startTime ? `${data.startTime}-${data.endTime}` : '');
  const dateLabel = updates.startDate || data.startDate;
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'text', text: `${arrow}：${data.title}\n　→ ${dateLabel} ${timeRange}`,
  }));
}
function shiftTimeStr(hhmm, shiftMin) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + shiftMin;
  if (total < 0 || total >= 24 * 60) return null;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

async function tryDeleteEvent(client, ev, text) {
  if (!text) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請指定要刪除的日期 + 事件名稱。\n例：「刪除 5/20 媽媽生日」',
    }));
    return;
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '尚未綁定行事曆，無法刪除',
    }));
    return;
  }
  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const targetUid = uids[0];

  const dateToken = parseDateToken(text, todayStr, todayDow);
  if (!dateToken) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請先指定日期。\n例：「刪除 5/20 媽媽生日」',
    }));
    return;
  }
  const titleQuery = text.slice(dateToken.consumed.length).trim();
  if (!titleQuery) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請補上要刪除的事件名稱（部分關鍵字即可）。\n例：「刪除 5/20 媽媽生日」',
    }));
    return;
  }

  // 撈出 startDate <= 目標日的事件，再過濾 endDate >= 目標日，
  // 然後比對 title 包含關鍵字
  const dateStr = dateToken.date;
  const eventsSnap = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid)
    .collection('bibi_events')
    .where('startDate', '<=', dateStr)
    .get();
  const matches = [];
  eventsSnap.forEach((d) => {
    const e = d.data();
    if (!e.endDate || e.endDate < dateStr) return;
    if (e.title && e.title.includes(titleQuery)) {
      matches.push({ ref: d.ref, data: e });
    }
  });

  if (matches.length === 0) {
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `${dateStr} 沒有找到包含「${titleQuery}」的行程`,
    }));
    return;
  }
  if (matches.length > 1) {
    const list = matches.map((m, i) => {
      const range = m.data.startDate === m.data.endDate
        ? m.data.startDate
        : `${m.data.startDate} ~ ${m.data.endDate}`;
      return `${i + 1}. ${m.data.title}（${range}）`;
    }).join('\n');
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `找到 ${matches.length} 筆相符的行程，請打更精準的關鍵字：\n\n${list}`,
    }));
    return;
  }

  const match = matches[0];
  await match.ref.delete();
  const range = match.data.startDate === match.data.endDate
    ? match.data.startDate
    : `${match.data.startDate} ~ ${match.data.endDate}`;
  await safeReply(client, ev.replyToken, withQuickReply({
    type: 'text',
    text: `🗑️ 已刪除：${match.data.title}\n　${range}`,
  }));
}

async function replyAgenda(client, ev, range) {
  const sourceId = getSourceId(ev);
  if (!sourceId) {
    return safeReply(client, ev.replyToken, {
      type: 'text',
      text: '無法辨識來源，請改回個人聊天視窗或重新邀請 Bot。',
    });
  }
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '你還沒綁定任何行事曆。請先傳：綁定 <你的裝置 ID>',
    }));
  }

  // 範圍超過 14 天 (e.g. 整月) 進入 compact 模式：
  // 空檔日不顯示、多日事件只列在範圍內的起始日，避免卡片過長
  const compactMode = range.days > 14;

  const dateGroups = [];
  for (let i = 0; i < range.days; i++) {
    const d = new Date(range.start);
    d.setDate(range.start.getDate() + i);
    dateGroups.push({ date: d, dateStr: formatDateTW(d), events: [] });
  }
  const rangeStartStr = dateGroups[0].dateStr;
  const rangeEndStr = dateGroups[dateGroups.length - 1].dateStr;

  const uidRoles = {};
  for (const uid of uids) {
    uidRoles[uid] = await getRoleSettings(uid);
    const eventsSnap = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_events')
      .where('startDate', '<=', rangeEndStr)
      .get();
    eventsSnap.forEach((doc) => {
      const e = doc.data();
      if (!e.endDate || e.endDate < rangeStartStr) return;
      if (range.filterType && e.eventType !== range.filterType) return;
      const tagged = { ...e, _uid: uid };
      if (compactMode) {
        // 只在「範圍內的第一天」列出一次，避免多日事件填滿整張卡片
        const firstInRange = e.startDate < rangeStartStr ? rangeStartStr : e.startDate;
        const g = dateGroups.find((g) => g.dateStr === firstInRange);
        if (g) g.events.push(tagged);
      } else {
        for (const g of dateGroups) {
          if (g.dateStr >= e.startDate && g.dateStr <= e.endDate) {
            g.events.push(tagged);
          }
        }
      }
    });
  }
  for (const g of dateGroups) {
    g.events.sort((a, b) => {
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
    });
  }

  const theme = flexThemeForToday(formatDateTW(new Date()));
  // 2~11 天的範圍（本週/下週/週末）→ Carousel 一天一張；單日 → 時間軸單卡；整月 → compact 列表
  const message = (!compactMode && dateGroups.length > 1 && dateGroups.length <= 11)
    ? buildAgendaCarousel(range.title, dateGroups, { uidRoles, theme })
    : buildAgendaFlex(range.title, dateGroups, { compact: compactMode, uidRoles, theme });
  return safeReply(client, ev.replyToken, withQuickReply(message));
}

async function incrementPushCount(uid, count = 1, category = 'other') {
  if (!count || count < 1) return;
  const monthKey = formatDateTW(new Date()).slice(0, 7); // YYYY-MM
  try {
    await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_settings').doc('usage')
      .set({
        [monthKey]: admin.firestore.FieldValue.increment(count),
        [`${monthKey}_categories`]: {
          [category]: admin.firestore.FieldValue.increment(count),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  } catch (err) {
    console.warn('[usage] increment failed', err?.message || err);
  }
}

async function pushToTargets(uid, lineUserIds, message, category = 'other') {
  if (!lineUserIds || lineUserIds.length === 0) return;
  const msgObject = typeof message === 'string'
    ? { type: 'text', text: message }
    : message;
  const client = lineClient();
  const results = await Promise.allSettled(
    lineUserIds.map((id) => client.pushMessage(id, msgObject))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('[push] failed', {
        uid, to: lineUserIds[i],
        err: r.reason?.originalError?.response?.data || r.reason?.message || r.reason,
      });
    }
  });
  const successCount = results.filter((r) => r.status === 'fulfilled').length;
  if (successCount > 0) await incrementPushCount(uid, successCount, category);
}

async function pushToBoundUsers(uid, message, category = 'other', excludeSourceId = null) {
  const doc = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_settings').doc('line')
    .get();
  let lineUserIds = (doc.exists ? doc.data().lineUserIds : []) || [];
  // 回音抑制：跳過發起操作的那個聊天室 (它已經收到確認回覆了)
  if (excludeSourceId) lineUserIds = lineUserIds.filter((id) => id !== excludeSourceId);
  await pushToTargets(uid, lineUserIds, message, category);
}

function getHelpText(showFinanceHint = false) {
  return [
    '📅 行事曆指令：',
    '',
    '🔗 設定 / 綁定',
    '　綁定 <裝置ID>　— 綁定行事曆',
    '　解除綁定',
    '　我是 <名字>　— 群組裡告訴 Bot 你是誰',
    '　狀態 / 綁定狀態 / status',
    '　用量 / 推播用量 / usage',
    '　誰是誰　— 群組內誰對應哪個 role',
    '　幫助 / 說明 / 指令 / help',
    '',
    '📅 查詢行程（規則式、不花 token）',
    '　今日／今天／今日行程',
    '　明天／明日　|　後天／大後天',
    '　本週／下週／下下週',
    '　週末／這週末',
    '　本月／這個月／整月行程',
    '　7月／2026/7　— 指定月份',
    '　直接傳日期：「5/16」「週三」「下週一」',
    '　下一個 / 最近（接下來 5 件）',
    '',
    '🎭 角色過濾',
    '　「Shane 今天」「阿花 本週」　— 只看那個 role',
    '　「只看共同 X」「共同 X」「一起 X」',
    '　「只看我 X」「我的 X」',
    '',
    '🔍 搜尋',
    '　找 / 搜尋 / 查 <關鍵字>',
    '',
    '➕ 新增（必須以「新增」開頭）',
    '　「新增 明天10點 看牙醫」',
    '　「新增 5/20 全天 媽媽生日」',
    '　「新增 7/10-7/22 加州旅遊」',
    '',
    '✏️ 編輯',
    '　「改日期 5/20 媽媽生日 5/21」',
    '　「改時間 5/20 看牙醫 14:30-16:00」',
    '　「改名稱 5/20 媽媽生日 媽媽77大壽」',
    '　(或從事件卡片底部按鈕直接改／刪)',
    '',
    '🗑️ 刪除 / 完成 / 取消',
    '　「刪除 5/20 媽媽生日」',
    '　「完成 5/20 牙醫」　— 標記完成 ✅',
    '　「取消 5/20 牙醫」　— 標為取消 ❎ (保留紀錄)',
    '',
    '📋 複製 / 延後 / 提前',
    '　「複製 5/20 牙醫 到 6/20」',
    '　「複製 5/20 牙醫 一週後」',
    '　「延後 牙醫 1 天」「提前 會議 30 分鐘」',
    '',
    '🔁 批量 / 重複',
    '　「批量 5/20, 5/22, 5/25 牙醫」',
    '　「重複 每週一 10:00 開會 共 8 次」',
    '　「重複 每月 15 號 房租 12 次」',
    '　「重複 每天 22:00 吃藥 30 次」',
    '',
    '⏳ 倒數 / 今天剩 / 空檔',
    '　「倒數 阿花生日」「還剩 中秋」',
    '　「剩下」「今天剩什麼」',
    '　「明天有空嗎」「今天空檔」「本週空檔」',
    '',
    '📊 統計 / 衝突 / 假日 / 節氣',
    '　「統計」「本月統計」',
    '　「衝突」「撞時間」',
    '　「假日」「下個假日」',
    '　「節氣」「下個節氣」',
    '　「第幾週」',
    '　「生日」「休假」',
    '',
    '📝 便利貼 / 打卡 / 撤回',
    '　「便利貼 買牛奶」「便利貼」(看清單)',
    '　「打卡 跑步」　— 立刻建一筆 30 分鐘的事',
    '　「撤回」　— 復原上一筆 AI / 規則建的事',
    '',
    '⏰ 稍後提醒',
    '　「30 分鐘後提醒 倒垃圾」',
    '　「1 小時後 接小孩」',
    '',
    '📤 匯出',
    '　「匯出」　— 給 Google / Apple Calendar 訂閱 URL',
    '　「匯出 5月」　— 指定範圍',
    '',
    '🤖 AI 助理 — 自然語言、自動操作行事曆 + 上網',
    '　觸發：「親 …」「AI: …」「ai: …」',
    '　範例：',
    '　　親 我下週有幾件事',
    '　　親 明天3點和小美喝咖啡幫我加進去',
    '　　親 把5/20牙醫改到5/22同時間',
    '　　親 刪掉這週末所有共同行程',
    '　　親 台北明天會下雨嗎',
    '　　親 今天美股漲跌如何',
    '　　親 我下週的行程裡哪天最忙',
    '　　親 幫我規劃週末一日遊，找2個信義區景點',
    '',
    '💡 省錢小撇步：',
    '　記得格式用規則式（免費）',
    '　懶得記就「親 …」（每次約 NT$ 0.01-1）',
    '',
    '⏰ 自動通知：每日 00:00 當日行程預覽',
    ...(showFinanceHint
      ? ['', '💰 記帳/帳單是另一套指令（私聊限定）：傳「記帳指令」看完整列表']
      : []),
    '',
    `（版本 ${BUILD_VERSION}）`,
  ].join('\n');
}

// ============================================================
// 帳務子系統 (Finance)：綁定 / 帳單 / 記帳
// 與行事曆完全隔離的私人空間：
//   artifacts/{APP_ID}/finance_bindings/{lineUserId} → { financeId }
//   artifacts/{APP_ID}/finance/{financeId}            → space doc (ownerLineUserId, lastOp)
//   artifacts/{APP_ID}/finance/{financeId}/bills      → 信用卡(結帳日/額度) + 貸款(繳款日)
//   artifacts/{APP_ID}/finance/{financeId}/expenses   → 記帳明細
// 所有指令僅在 1-on-1 私聊生效；群組一律無視。推播只到綁定者本人。
// ============================================================

const EXPENSE_CATEGORIES = {
  food: { name: '餐飲', emoji: '🍜' },
  transport: { name: '交通', emoji: '🚗' },
  shopping: { name: '購物', emoji: '🛒' },
  entertainment: { name: '娛樂', emoji: '🎮' },
  home: { name: '居住', emoji: '🏠' },
  medical: { name: '醫療', emoji: '💊' },
  other: { name: '其他', emoji: '📦' },
};

const EXPENSE_KEYWORD_RULES = [
  ['food', ['早餐', '午餐', '晚餐', '宵夜', '早午餐', '下午茶', '咖啡', '飲料', '手搖', '便當', '聚餐', '吃', '餐', '麵', '飯', '火鍋', '燒烤', '壽司', '甜點', '蛋糕', '麥當勞', '肯德基', '星巴克', '飲品', '酒']],
  ['transport', ['加油', '油錢', '停車', '捷運', '公車', '高鐵', '台鐵', '火車', '計程車', 'Uber', 'uber', '機票', '車票', '過路費', '洗車', '修車', '保養', '悠遊卡', '加值']],
  ['shopping', ['全聯', '家樂福', '好市多', 'Costco', 'costco', '超市', '菜', '網購', '蝦皮', 'momo', 'MOMO', '淘寶', '衣服', '鞋', '包包', '日用品', '衛生紙', '洗衣精', '買']],
  ['entertainment', ['電影', '遊戲', '課金', 'KTV', 'ktv', '唱歌', '展覽', '門票', '演唱會', '訂閱', 'Netflix', 'netflix', 'Spotify', 'spotify', '桌遊', '旅遊', '住宿', '飯店']],
  ['home', ['房租', '房貸', '水費', '電費', '瓦斯', '網路費', '電話費', '管理費', '家具', '家電', '修繕']],
  ['medical', ['掛號', '看病', '看醫生', '牙醫', '藥', '診所', '醫院', '保健', '維他命', '眼鏡', '保險']],
];

function guessExpenseCategory(item) {
  for (const [cat, keys] of EXPENSE_KEYWORD_RULES) {
    if (keys.some((k) => item.includes(k))) return cat;
  }
  return 'other';
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US');
}

const finBindingRef = (lineUserId) => db()
  .collection('artifacts').doc(APP_ID)
  .collection('finance_bindings').doc(lineUserId);

const finSpaceRef = (fid) => db()
  .collection('artifacts').doc(APP_ID)
  .collection('finance').doc(fid);

function genFinanceId() {
  // fid 是帳務空間唯一的存取憑證 → 必須用 CSPRNG，且長度要夠 (16 字 ≈ 79 bits)
  const { randomBytes } = require('crypto');
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[buf[i] % chars.length];
  return `fin-${s}`;
}

// 只有一對一私聊才會回傳 financeId，群組/聊天室永遠 null
async function getFinanceIdForLineUser(lineUserId) {
  if (!lineUserId) return null;
  try {
    const snap = await finBindingRef(lineUserId).get();
    return snap.exists ? (snap.data().financeId || null) : null;
  } catch (e) {
    console.warn('[finance] binding read failed', e?.message);
    return null;
  }
}

async function getFinanceIdForEvent(ev) {
  if (ev.source?.type !== 'user') return null;
  return getFinanceIdForLineUser(ev.source.userId);
}

function financeQuickReply(message) {
  return Object.assign({}, message, {
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '今天花多少', text: '今天花多少' } },
        { type: 'action', action: { type: 'message', label: '本月花費', text: '本月花費' } },
        { type: 'action', action: { type: 'message', label: '帳單', text: '帳單' } },
        { type: 'action', action: { type: 'message', label: '記帳明細', text: '記帳' } },
        { type: 'action', action: { type: 'message', label: '撤回', text: '撤回' } },
        { type: 'action', action: { type: 'message', label: '記帳指令', text: '記帳指令' } },
      ],
    },
  });
}

// 記帳/帳務的完整指令說明（與行事曆的 getHelpText 分開，各自獨立）
function getFinanceHelpText() {
  return [
    '💰 記帳 / 帳務指令（限一對一私聊）',
    '',
    '🔗 綁定',
    '　帳務綁定　— 建立你的帳務空間',
    '　帳務綁定 <帳務ID>　— 換手機接回舊資料',
    '　帳務狀態　— 查 ID / 本月統計',
    '　帳務解綁　— 解除綁定（資料保留）',
    '　刪除帳務空間 → 回覆「確認刪除」（全刪、不可復原）',
    '',
    '🧾 記帳（直接打，不用任何前綴）',
    '　「早餐 65」',
    '　「午餐 151 國泰」— 標記刷卡、算進帳期',
    '　「昨天 宵夜 120」「前天 咖啡 80」',
    '　「8/2 晚餐 420 國泰」— 補記過去日期',
    '　分類自動判斷（餐飲/交通/購物/娛樂/居住/醫療/其他）',
    '',
    '💳 信用卡 / 貸款',
    '　「信用卡 國泰卡 15號 額度100000」（額度可省略）',
    '　「貸款 房貸 10號 25000」（金額可省略）',
    '　「帳單」— 所有卡片/貸款＋本期已刷＋剩餘額度',
    '　直接打卡名（例「國泰卡」）— 單卡帳期明細',
    '　「刪除帳單 國泰卡」',
    '',
    '🔍 查詢',
    '　「今天花多少」— 今日合計＋分類',
    '　「本月花費」— 月合計＋分類排行＋與上月比較',
    '　「記帳」— 最近 10 筆明細',
    '',
    '🗑️ 刪除 / 撤回',
    '　「撤回」— 撤掉剛剛那筆',
    '　「刪帳」— 列出最近 10 筆，點按鈕刪',
    '　「刪帳 早餐」「刪帳 8/3 加油」— 指定刪',
    '',
    '🤖 AI 查詢（唯讀，不會亂記帳）',
    '　「親 我這個月吃飯花多少」',
    '　「親 這期國泰卡最大的三筆是什麼」',
    '　※ AI 需同時綁定行事曆才能使用',
    '',
    '⏰ 自動私訊通知',
    '　結帳日當天：本期應繳金額',
    '　貸款繳款日前 3 天起倒數提醒',
    '　每月 1 號：上月月結報告',
    '',
    '💡 小提醒',
    '　跟 AI 對話後 5 分鐘內，訊息會優先當 AI 追問；',
    '　這時要記帳請在金額加「元」，例「早餐 65元」',
    '　品項開頭避免行事曆動詞（改/刪除/取消/複製…），',
    '　或前面加日期，例「昨天 複製鑰匙 100」',
    '　「刪帳」搜尋範圍為最近 90 天',
    '',
    '🔒 隱私：以上全部只在你的私聊生效，',
    '　群組和夥伴完全看不到、查不到。',
    '',
    '📅 行事曆功能請傳：「行事曆指令」',
  ].join('\n');
}

// --- 日期工具：月底 clamp ---
function daysInMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function clampedDateForMonth(mk, day) {
  const last = daysInMonthKey(mk);
  return `${mk}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

// 下一個「每月 day 號」（含今天）
function nextMonthlyOccurrence(day, todayStr) {
  const mk = todayStr.slice(0, 7);
  let cand = clampedDateForMonth(mk, day);
  if (cand < todayStr) cand = clampedDateForMonth(addMonthKey(mk, 1), day);
  return cand;
}

// 信用卡本期帳期：上個結帳日隔天 ~ 下個結帳日（含今天）
function cardCycleForToday(day, todayStr) {
  const endStr = nextMonthlyOccurrence(day, todayStr);
  const prevStmt = clampedDateForMonth(addMonthKey(endStr.slice(0, 7), -1), day);
  return { startStr: addDaysStr(prevStmt, 1), endStr };
}

async function getFinanceBills(fid) {
  const snap = await finSpaceRef(fid).collection('bills').get();
  const bills = [];
  snap.forEach((d) => bills.push({ id: d.id, ...d.data() }));
  bills.sort((a, b) => (a.day || 0) - (b.day || 0));
  return bills;
}

async function getExpensesInRange(fid, startStr, endStr) {
  // 單欄位 range query（免 composite index），卡別/分類過濾在記憶體做
  const snap = await finSpaceRef(fid).collection('expenses')
    .where('date', '>=', startStr)
    .where('date', '<=', endStr)
    .get();
  const items = [];
  snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
  items.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  return items;
}

function sumExpenses(items) {
  return items.reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

// 卡名比對：「國泰」可對到「國泰卡」，去掉尾字「卡」後做前綴比對
function matchCardBill(bills, token) {
  if (!token) return null;
  const norm = (s) => String(s || '').replace(/卡$/, '');
  const t = norm(token);
  if (!t) return null;
  return bills.find((b) => b.type === 'card' &&
    (norm(b.name) === t || norm(b.name).startsWith(t) || t.startsWith(norm(b.name)))) || null;
}

async function recordFinanceLastOp(fid, op) {
  try {
    await finSpaceRef(fid).set({
      lastOp: { ...op, at: admin.firestore.Timestamp.now() },
    }, { merge: true });
  } catch (e) {
    console.warn('[finance] lastOp failed', e?.message);
  }
}

// --- 記帳文字解析：[昨天/前天/M/D] 品項 金額 [卡名|現金] ---
function parseExpenseText(text, todayStr) {
  let working = text.trim();
  let dateStr = todayStr;
  let m;
  if ((m = working.match(/^(?:昨天|昨日)[\s　]+/))) {
    dateStr = addDaysStr(todayStr, -1);
    working = working.slice(m[0].length);
  } else if ((m = working.match(/^前天[\s　]+/))) {
    dateStr = addDaysStr(todayStr, -2);
    working = working.slice(m[0].length);
  } else if ((m = working.match(/^(\d{1,2})[\/月](\d{1,2})[日號]?[\s　]+/))) {
    const y = parseInt(todayStr.slice(0, 4), 10);
    const mm = String(parseInt(m[1], 10)).padStart(2, '0');
    const dd = String(parseInt(m[2], 10)).padStart(2, '0');
    if (parseInt(mm, 10) < 1 || parseInt(mm, 10) > 12 || parseInt(dd, 10) < 1 || parseInt(dd, 10) > 31) return null;
    let cand = `${y}-${mm}-${dd}`;
    if (cand > todayStr) cand = `${y - 1}-${mm}-${dd}`; // 補記只能記過去
    // 拒絕不存在的日期 (2/30、4/31、非閏年 2/29)，否則會存進資料庫卻永遠不列入月統計
    const chk = new Date(cand + 'T00:00:00Z');
    if (isNaN(chk.getTime()) ||
        chk.getUTCMonth() + 1 !== parseInt(mm, 10) ||
        chk.getUTCDate() !== parseInt(dd, 10)) return null;
    dateStr = cand;
    working = working.slice(m[0].length);
  }
  m = working.match(/^(.+?)[\s　]+(\d{1,7})(?:元|塊)?(?:[\s　]+(\S{1,12}))?$/);
  if (!m) return null;
  const item = m[1].trim();
  const amount = parseInt(m[2], 10);
  const payToken = m[3] || null;
  if (!item || item.length > 24) return null;
  if (/^[\d\s\/\-:：.,]+$/.test(item)) return null; // 純數字/日期樣式不當品項
  if (!amount || amount < 1 || amount > 9999999) return null;
  return { dateStr, item, amount, payToken };
}

// --- 記帳 catch-all：私聊 + 已綁定才會嘗試。回傳 true = 已處理 ---
async function tryFinanceExpenseCatchAll(client, ev, text) {
  if (ev.source?.type !== 'user') return false;
  const fid = await getFinanceIdForLineUser(ev.source.userId);
  if (!fid) return false;

  const todayStr = formatDateTW(new Date());
  const bills = await getFinanceBills(fid);

  // 1) 單獨輸入卡名 → 本期帳期明細
  if (text.length <= 12 && !/\d/.test(text)) {
    const card = matchCardBill(bills, text);
    if (card && card.name.replace(/卡$/, '').length >= text.replace(/卡$/, '').length - 1) {
      await replyCardCycleDetail(client, ev, fid, card, todayStr);
      return true;
    }
  }

  // 2) 品項 金額 [卡名]
  const parsed = parseExpenseText(text, todayStr);
  if (!parsed) return false;

  let card = null;
  let item = parsed.item;
  let unknownCardToken = null;
  if (parsed.payToken) {
    if (/^(現金|cash)$/i.test(parsed.payToken)) {
      card = null;
    } else {
      card = matchCardBill(bills, parsed.payToken);
      if (!card) {
        item = `${item} ${parsed.payToken}`.trim(); // 對不到卡就當品項的一部分
        // 長得像卡名（2-6 個非數字字元）就提醒使用者，避免「以為算進卡片了」
        if (/^[^\d\s]{2,6}$/.test(parsed.payToken)) unknownCardToken = parsed.payToken;
      }
    }
  }
  if (item.length > 24) return false;

  const category = guessExpenseCategory(item);
  const data = {
    date: parsed.dateStr,
    item,
    amount: parsed.amount,
    category,
    card: card ? card.name : null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await finSpaceRef(fid).collection('expenses').add(data);
  await recordFinanceLastOp(fid, { type: 'expense_create', expenseId: ref.id, item, amount: parsed.amount, date: parsed.dateStr });

  const cat = EXPENSE_CATEGORIES[category] || EXPENSE_CATEGORIES.other;
  const dayItems = await getExpensesInRange(fid, parsed.dateStr, parsed.dateStr);
  const dayLabel = parsed.dateStr === todayStr ? '今日' : parsed.dateStr.slice(5).replace('-', '/');
  const lines = [
    `✅ 已記：${cat.emoji} ${cat.name}・${item} $${fmtMoney(parsed.amount)}`,
    `${dayLabel}累計 $${fmtMoney(sumExpenses(dayItems))}`,
  ];
  if (parsed.amount >= 10000) lines.push('⚠️ 金額較大，記錯請按「撤回」');
  if (unknownCardToken) {
    lines.push(`⚠️ 沒有「${unknownCardToken}」這張卡，已當現金記（未計入任何卡片帳期）。`);
    lines.push(`要歸戶請先建卡：「信用卡 ${unknownCardToken}卡 15號」，再「撤回」重記`);
  }
  if (card) {
    const cycle = cardCycleForToday(card.day, todayStr);
    const cycleItems = (await getExpensesInRange(fid, cycle.startStr, cycle.endStr))
      .filter((e) => e.card === card.name);
    const cycleSum = sumExpenses(cycleItems);
    lines.push(`💳 ${card.name}本期已刷 $${fmtMoney(cycleSum)}（${cycle.endStr.slice(5).replace('-', '/')} 結帳）`);
    if (card.limit) lines.push(`　剩餘額度約 $${fmtMoney(Math.max(0, card.limit - cycleSum))}`);
  }
  await safeReply(client, ev.replyToken, financeQuickReply({ type: 'text', text: lines.join('\n') }));
  return true;
}

async function replyCardCycleDetail(client, ev, fid, card, todayStr) {
  const cycle = cardCycleForToday(card.day, todayStr);
  const items = (await getExpensesInRange(fid, cycle.startStr, cycle.endStr))
    .filter((e) => e.card === card.name);
  const total = sumExpenses(items);
  const lines = [
    `💳 ${card.name}（每月 ${card.day} 號結帳）`,
    `本期帳期 ${cycle.startStr.slice(5).replace('-', '/')} ~ ${cycle.endStr.slice(5).replace('-', '/')}`,
    `本期已刷 $${fmtMoney(total)}（＝本次應繳）`,
  ];
  if (card.limit) {
    const pct = Math.round((total / card.limit) * 1000) / 10;
    lines.push(`剩餘額度約 $${fmtMoney(Math.max(0, card.limit - total))} / $${fmtMoney(card.limit)}（已用 ${pct}%）`);
  }
  if (items.length > 0) {
    lines.push('');
    items.slice(-10).forEach((e) => {
      lines.push(`• ${e.date.slice(5).replace('-', '/')} ${e.item} $${fmtMoney(e.amount)}`);
    });
    if (items.length > 10) lines.push(`…（僅列最近 10 筆，共 ${items.length} 筆）`);
  }
  return safeReply(client, ev.replyToken, financeQuickReply({ type: 'text', text: lines.join('\n') }));
}

// --- 帳務指令 gateway：明確關鍵字才進來，回傳 true = 已處理 ---
const FINANCE_CMD_RE = /^(帳務|信用卡|貸款|帳單$|刪除帳單|刪除帳務空間$|刪帳|記帳$|記帳指令$|今天花|今日花|本月花|這個月花|確認刪除$)/;

async function tryFinanceCommand(client, ev, text) {
  if (ev.source?.type !== 'user') return false;
  if (!FINANCE_CMD_RE.test(text)) return false;
  const lineUserId = ev.source.userId;

  // -- 綁定系列（不需要已綁定） --
  let m;
  if ((m = text.match(/^帳務綁定(?:[\s　]+(\S+))?$/))) {
    await handleFinanceBind(client, ev, lineUserId, m[1] || null);
    return true;
  }
  if (text === '記帳指令' || text === '帳務指令' || text === '帳務幫助') {
    await safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: getFinanceHelpText(),
    }));
    return true;
  }
  if (text === '帳務狀態' || text === '帳務') {
    await replyFinanceStatus(client, ev, lineUserId);
    return true;
  }
  if (text === '帳務解綁') {
    const fid = await getFinanceIdForLineUser(lineUserId);
    if (!fid) {
      await safeReply(client, ev.replyToken, { type: 'text', text: '目前沒有帳務綁定。' });
      return true;
    }
    await finBindingRef(lineUserId).delete();
    await safeReply(client, ev.replyToken, {
      type: 'text',
      text: `已解除帳務綁定，資料原封保留。\n想接回來請傳：\n帳務綁定 ${fid}`,
    });
    return true;
  }

  const fid = await getFinanceIdForLineUser(lineUserId);
  if (!fid) {
    await safeReply(client, ev.replyToken, {
      type: 'text',
      text: '還沒建立帳務空間。先傳「帳務綁定」即可開始（獨立於行事曆、只有你看得到）。',
    });
    return true;
  }

  // -- 刪除整個空間（二次確認） --
  if (text === '刪除帳務空間') {
    await finBindingRef(lineUserId).set({
      pendingDeleteAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    await safeReply(client, ev.replyToken, {
      type: 'text',
      text: '⚠️ 這會永久刪除你的所有卡片、貸款設定與全部記帳紀錄，無法復原。\n確定要刪，請在 1 分鐘內回覆：確認刪除',
    });
    return true;
  }
  if (text === '確認刪除') {
    const bindSnap = await finBindingRef(lineUserId).get();
    const pendingAt = bindSnap.exists ? bindSnap.data().pendingDeleteAt : null;
    if (!pendingAt || (Date.now() - pendingAt.toMillis()) > 60 * 1000) {
      await safeReply(client, ev.replyToken, { type: 'text', text: '沒有待確認的刪除操作（或已逾時）。' });
      return true;
    }
    await wipeFinanceSpace(fid, lineUserId);
    await safeReply(client, ev.replyToken, { type: 'text', text: '🗑️ 已清空帳務空間並解除綁定。' });
    return true;
  }

  // -- 帳單設定 --
  if ((m = text.match(/^信用卡[\s　]+(\S+)[\s　]+(?:結帳[\s　]*)?(\d{1,2})[\s　]*號?(?:[\s　]+額度[\s　]*([\d,]+))?$/))) {
    await handleFinanceCardCreate(client, ev, fid, m[1], parseInt(m[2], 10), m[3]);
    return true;
  }
  if (text.startsWith('信用卡')) {
    await safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: '格式：「信用卡 國泰卡 15號」\n或含額度：「信用卡 國泰卡 15號 額度100000」',
    }));
    return true;
  }
  if ((m = text.match(/^貸款[\s　]+(\S+)[\s　]+(?:每月[\s　]*)?(\d{1,2})[\s　]*號?(?:[\s　]+([\d,]+))?$/))) {
    await handleFinanceLoanCreate(client, ev, fid, m[1], parseInt(m[2], 10), m[3]);
    return true;
  }
  if (text.startsWith('貸款')) {
    await safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: '格式：「貸款 房貸 10號」\n或含金額：「貸款 房貸 10號 25000」',
    }));
    return true;
  }
  if (text === '帳單') {
    await replyFinanceBillList(client, ev, fid);
    return true;
  }
  if ((m = text.match(/^刪除帳單[\s　]*(\S+)?$/))) {
    await handleFinanceBillDelete(client, ev, fid, m[1] || null);
    return true;
  }

  // -- 記帳查詢 / 刪除 --
  if (/^(今天花|今日花)/.test(text)) {
    await replyExpenseDaySummary(client, ev, fid, formatDateTW(new Date()));
    return true;
  }
  if (/^(本月花|這個月花)/.test(text)) {
    await replyExpenseMonthSummary(client, ev, fid, formatDateTW(new Date()).slice(0, 7));
    return true;
  }
  if (text === '記帳') {
    await replyExpenseRecent(client, ev, fid);
    return true;
  }
  if ((m = text.match(/^刪帳單[\s　]*(\S+)?$/))) {
    // 「刪帳單」視為「刪除帳單」的簡寫，避免被當成「刪帳 單」
    await handleFinanceBillDelete(client, ev, fid, m[1] || null);
    return true;
  }
  if ((m = text.match(/^刪帳(?:[\s　]+(.+))?$/))) {
    await handleExpenseDelete(client, ev, fid, (m[1] || '').trim());
    return true;
  }
  return false;
}

async function handleFinanceBind(client, ev, lineUserId, requestedFid) {
  if (requestedFid) {
    // ID 只允許安全字元 — 含 / 的字串會讓 Firestore doc path 直接 throw
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(requestedFid)) {
      return safeReply(client, ev.replyToken, {
        type: 'text', text: `「${requestedFid.slice(0, 40)}」不是有效的帳務 ID 格式（fin- 開頭的英數字串）。`,
      });
    }
    // 帶 ID：接回既有空間
    const snap = await finSpaceRef(requestedFid).get();
    if (!snap.exists) {
      return safeReply(client, ev.replyToken, {
        type: 'text', text: `找不到帳務空間「${requestedFid}」，請確認 ID 是否正確。\n要開新空間直接傳「帳務綁定」即可。`,
      });
    }
    // 防接管：若這個空間目前有「別的 LINE 帳號」綁定中，拒絕接手，
    // 避免 fid 外流（截圖等）就被第三者整碗端走。原帳號要先「帳務解綁」才能轉移。
    const activeSnap = await db().collection('artifacts').doc(APP_ID)
      .collection('finance_bindings').where('financeId', '==', requestedFid).get();
    const boundByOther = activeSnap.docs.some((d) => d.id !== lineUserId);
    if (boundByOther) {
      return safeReply(client, ev.replyToken, {
        type: 'text',
        text: '⚠️ 這個帳務空間目前綁定在另一個 LINE 帳號上，無法接手。\n若是要轉移到這個帳號，請先用原帳號傳「帳務解綁」。',
      });
    }
    // 若原本綁著另一個空間，回覆裡保留舊 ID，避免舊資料從此找不回來
    const prevFid = await getFinanceIdForLineUser(lineUserId);
    await finBindingRef(lineUserId).set({ financeId: requestedFid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await finSpaceRef(requestedFid).set({ ownerLineUserId: lineUserId }, { merge: true });
    const switched = prevFid && prevFid !== requestedFid
      ? `\n（原本綁定的是 ${prevFid}，資料仍保留，想切回請傳「帳務綁定 ${prevFid}」）`
      : '';
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: `✅ 已接回帳務空間 ${requestedFid}${switched}\n直接輸入「品項 金額」就能記帳，例：早餐 65`,
    }));
  }
  const existing = await getFinanceIdForLineUser(lineUserId);
  if (existing) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: `你已經綁定帳務空間了 ✅\n帳務 ID：${existing}\n（想在 App 看帳務頁：長按月曆 logo → 貼上此 ID）`,
    }));
  }
  const fid = genFinanceId();
  await finSpaceRef(fid).set({
    ownerLineUserId: lineUserId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await finBindingRef(lineUserId).set({ financeId: fid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return safeReply(client, ev.replyToken, financeQuickReply({
    type: 'text',
    text: [
      '✅ 已建立你的帳務空間（獨立於行事曆、只有你看得到）',
      `帳務 ID：${fid}`,
      '',
      '開始使用：',
      '• 記帳：「早餐 65」「午餐 151 國泰」「昨天 宵夜 120」',
      '• 建卡：「信用卡 國泰卡 15號 額度100000」',
      '• 貸款：「貸款 房貸 10號 25000」',
      '• 查詢：「今天花多少」「本月花費」「帳單」',
      '',
      '想在 App 看帳務頁：長按月曆 logo 0.5 秒 → 貼上帳務 ID',
    ].join('\n'),
  }));
}

async function replyFinanceStatus(client, ev, lineUserId) {
  const fid = await getFinanceIdForLineUser(lineUserId);
  if (!fid) {
    return safeReply(client, ev.replyToken, {
      type: 'text', text: '尚未綁定帳務空間。傳「帳務綁定」即可建立（免費、獨立於行事曆）。',
    });
  }
  const bills = await getFinanceBills(fid);
  const mk = formatDateTW(new Date()).slice(0, 7);
  const monthItems = await getExpensesInRange(fid, `${mk}-01`, clampedDateForMonth(mk, 31));
  const spaceSnap = await finSpaceRef(fid).get();
  const pushCount = spaceSnap.exists ? (spaceSnap.data()[`pushCount_${mk}`] || 0) : 0;
  return safeReply(client, ev.replyToken, financeQuickReply({
    type: 'text',
    text: [
      '📂 帳務狀態',
      `帳務 ID：${fid}`,
      `卡片/貸款：${bills.length} 筆`,
      `本月記帳：${monthItems.length} 筆・$${fmtMoney(sumExpenses(monthItems))}`,
      `本月帳務推播：${pushCount} 則`,
      '',
      '（App 帳務頁：長按月曆 logo → 貼上帳務 ID）',
    ].join('\n'),
  }));
}

async function wipeFinanceSpace(fid, lineUserId) {
  // 先刪 space doc + binding，讓 expenses 刪除觸發器找不到 owner → 不會推播轟炸
  await finSpaceRef(fid).delete();
  await finBindingRef(lineUserId).delete();
  for (const sub of ['bills', 'expenses']) {
    // 分批刪除子集合
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const snap = await finSpaceRef(fid).collection(sub).limit(300).get();
      if (snap.empty) break;
      const batch = db().batch();
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

async function handleFinanceCardCreate(client, ev, fid, name, day, limitStr) {
  if (day < 1 || day > 31) {
    return safeReply(client, ev.replyToken, { type: 'text', text: '結帳日要 1-31 號' });
  }
  const limit = limitStr ? parseInt(limitStr.replace(/,/g, ''), 10) : null;
  const bills = await getFinanceBills(fid);
  const existing = bills.find((b) => b.type === 'card' && b.name === name);
  const data = { type: 'card', name, day, limit: limit || null };
  if (existing) {
    await finSpaceRef(fid).collection('bills').doc(existing.id).set(data, { merge: true });
  } else {
    data.createdAt = admin.firestore.FieldValue.serverTimestamp();
    await finSpaceRef(fid).collection('bills').add(data);
  }
  const todayStr = formatDateTW(new Date());
  const cycle = cardCycleForToday(day, todayStr);
  const lines = [
    `💳 ${existing ? '已更新' : '已新增'}：${name}`,
    `每月 ${day} 號結帳${limit ? `・額度 $${fmtMoney(limit)}` : ''}`,
    `本期帳期：${cycle.startStr.slice(5).replace('-', '/')} ~ ${cycle.endStr.slice(5).replace('-', '/')}`,
    '',
    `記帳時在後面加卡名就會算進帳期，例：「午餐 151 ${name.replace(/卡$/, '')}」`,
  ];
  return safeReply(client, ev.replyToken, financeQuickReply({ type: 'text', text: lines.join('\n') }));
}

async function handleFinanceLoanCreate(client, ev, fid, name, day, amountStr) {
  if (day < 1 || day > 31) {
    return safeReply(client, ev.replyToken, { type: 'text', text: '繳款日要 1-31 號' });
  }
  const amount = amountStr ? parseInt(amountStr.replace(/,/g, ''), 10) : null;
  const bills = await getFinanceBills(fid);
  const existing = bills.find((b) => b.type === 'loan' && b.name === name);
  const data = { type: 'loan', name, day, amount: amount || null };
  if (existing) {
    await finSpaceRef(fid).collection('bills').doc(existing.id).set(data, { merge: true });
  } else {
    data.createdAt = admin.firestore.FieldValue.serverTimestamp();
    await finSpaceRef(fid).collection('bills').add(data);
  }
  const todayStr = formatDateTW(new Date());
  const next = nextMonthlyOccurrence(day, todayStr);
  const daysLeft = daysBetween(next, todayStr);
  return safeReply(client, ev.replyToken, financeQuickReply({
    type: 'text',
    text: [
      `🏦 ${existing ? '已更新' : '已新增'}：${name}`,
      `每月 ${day} 號繳款${amount ? `・$${fmtMoney(amount)}` : ''}`,
      `下次繳款日：${next.slice(5).replace('-', '/')}（${daysLeft === 0 ? '就是今天' : `還 ${daysLeft} 天`}）`,
      '',
      '繳款日前 3 天起會私訊提醒你。',
    ].join('\n'),
  }));
}

async function replyFinanceBillList(client, ev, fid) {
  const bills = await getFinanceBills(fid);
  if (bills.length === 0) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text',
      text: [
        '還沒有任何卡片或貸款。',
        '',
        '建立方式：',
        '「信用卡 國泰卡 15號 額度100000」',
        '「貸款 房貸 10號 25000」',
        '（額度/金額可省略）',
      ].join('\n'),
    }));
  }
  const todayStr = formatDateTW(new Date());
  const lines = ['📋 你的帳務'];
  for (const b of bills) {
    if (b.type === 'card') {
      const cycle = cardCycleForToday(b.day, todayStr);
      const items = (await getExpensesInRange(fid, cycle.startStr, cycle.endStr))
        .filter((e) => e.card === b.name);
      const total = sumExpenses(items);
      const dLeft = daysBetween(cycle.endStr, todayStr);
      lines.push('');
      lines.push(`💳 ${b.name}　每月 ${b.day} 號結帳（${dLeft === 0 ? '今天結帳' : `還 ${dLeft} 天`}）`);
      lines.push(`　本期已刷 $${fmtMoney(total)}${b.limit ? `・剩餘額度約 $${fmtMoney(Math.max(0, b.limit - total))}` : ''}`);
    } else {
      const next = nextMonthlyOccurrence(b.day, todayStr);
      const dLeft = daysBetween(next, todayStr);
      lines.push('');
      lines.push(`🏦 ${b.name}　每月 ${b.day} 號繳款${b.amount ? `・$${fmtMoney(b.amount)}` : ''}`);
      lines.push(`　下次 ${next.slice(5).replace('-', '/')}（${dLeft === 0 ? '就是今天' : `還 ${dLeft} 天`}）`);
    }
  }
  return safeReply(client, ev.replyToken, financeQuickReply({ type: 'text', text: lines.join('\n') }));
}

async function handleFinanceBillDelete(client, ev, fid, name) {
  if (!name) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: '格式：「刪除帳單 國泰卡」',
    }));
  }
  const bills = await getFinanceBills(fid);
  const norm = (s) => String(s || '').replace(/卡$/, '');
  const hit = bills.find((b) => b.name === name) ||
    bills.find((b) => norm(b.name) === norm(name)) ||
    bills.find((b) => norm(b.name).startsWith(norm(name)));
  if (!hit) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: `找不到「${name}」。傳「帳單」看看現有清單。`,
    }));
  }
  await finSpaceRef(fid).collection('bills').doc(hit.id).delete();
  return safeReply(client, ev.replyToken, financeQuickReply({
    type: 'text',
    text: `🗑️ 已刪除：${hit.type === 'card' ? '💳' : '🏦'} ${hit.name}\n（歷史記帳保留，只是不再有提醒與帳期統計）`,
  }));
}

function expenseLineLabel(e) {
  const cat = EXPENSE_CATEGORIES[e.category] || EXPENSE_CATEGORIES.other;
  return `${e.date.slice(5).replace('-', '/')} ${cat.emoji} ${e.item} $${fmtMoney(e.amount)}${e.card ? `（💳${e.card}）` : ''}`;
}

async function replyExpenseDaySummary(client, ev, fid, dateStr) {
  const items = await getExpensesInRange(fid, dateStr, dateStr);
  if (items.length === 0) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: `📅 ${dateStr.slice(5).replace('-', '/')} 還沒有記帳。直接輸入「品項 金額」即可記一筆。`,
    }));
  }
  const byCat = {};
  items.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + (Number(e.amount) || 0); });
  const catLine = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => {
      const cat = EXPENSE_CATEGORIES[c] || EXPENSE_CATEGORIES.other;
      return `${cat.emoji} ${cat.name} $${fmtMoney(v)}`;
    }).join('｜');
  const lines = [
    `📅 ${dateStr.slice(5).replace('-', '/')} 支出 $${fmtMoney(sumExpenses(items))}`,
    catLine,
    '',
  ];
  items.slice(0, 20).forEach((e) => lines.push(`• ${e.item} $${fmtMoney(e.amount)}${e.card ? `（💳${e.card}）` : ''}`));
  if (items.length > 20) lines.push(`…共 ${items.length} 筆（僅列前 20 筆）`);
  return safeReply(client, ev.replyToken, financeQuickReply({ type: 'text', text: lines.join('\n') }));
}

function buildMonthSummaryLines(mk, items, prevItems) {
  const total = sumExpenses(items);
  const byCat = {};
  let cardSum = 0;
  items.forEach((e) => {
    byCat[e.category] = (byCat[e.category] || 0) + (Number(e.amount) || 0);
    if (e.card) cardSum += Number(e.amount) || 0;
  });
  const lines = [
    `📊 ${parseInt(mk.slice(5), 10)} 月支出 $${fmtMoney(total)}`,
    `現金 $${fmtMoney(total - cardSum)}・刷卡 $${fmtMoney(cardSum)}`,
  ];
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([c, v]) => {
    const cat = EXPENSE_CATEGORIES[c] || EXPENSE_CATEGORIES.other;
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    lines.push(`${cat.emoji} ${cat.name} $${fmtMoney(v)}（${pct}%）`);
  });
  if (prevItems && prevItems.length > 0) {
    const prevTotal = sumExpenses(prevItems);
    const diff = total - prevTotal;
    if (diff !== 0) lines.push(diff > 0 ? `比上月多 $${fmtMoney(diff)}` : `比上月少 $${fmtMoney(-diff)} 👍`);
  }
  return lines;
}

// 月結 Flex 長條圖卡片（「本月花費」查詢與每月 1 號月結推播共用）
function buildMonthReportFlex(mk, items, prevItems, theme) {
  const th = theme || FLEX_THEMES.classic;
  const total = sumExpenses(items);
  const byCat = {};
  let cardSum = 0;
  items.forEach((e) => {
    byCat[e.category] = (byCat[e.category] || 0) + (Number(e.amount) || 0);
    if (e.card) cardSum += Number(e.amount) || 0;
  });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxV = catRows.length > 0 ? catRows[0][1] : 1;

  const body = [];
  for (const [c, v] of catRows) {
    const cat = EXPENSE_CATEGORIES[c] || EXPENSE_CATEGORIES.other;
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    body.push({
      type: 'box', layout: 'horizontal', margin: 'md',
      contents: [
        { type: 'text', text: `${cat.emoji} ${cat.name}`, size: 'sm', color: th.text, flex: 4 },
        { type: 'text', text: `$${fmtMoney(v)}（${pct}%）`, size: 'sm', weight: 'bold',
          color: th.text, flex: 5, align: 'end' },
      ],
    });
    body.push({
      type: 'box', layout: 'vertical', height: '8px', backgroundColor: th.accentSoft,
      cornerRadius: '4px', margin: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', width: `${Math.max(4, Math.round((v / maxV) * 100))}%`,
        height: '8px', cornerRadius: '4px', backgroundColor: th.accent,
        contents: [{ type: 'filler' }],
      }],
    });
  }
  if (prevItems && prevItems.length > 0) {
    const diff = total - sumExpenses(prevItems);
    if (diff !== 0) {
      body.push({
        type: 'text', margin: 'lg', size: 'xs', align: 'center', color: th.sub,
        text: diff > 0 ? `比上月多 $${fmtMoney(diff)}` : `比上月少 $${fmtMoney(-diff)} 👍`,
      });
    }
  }

  return {
    type: 'flex',
    altText: `📊 ${parseInt(mk.slice(5), 10)} 月支出 $${fmtMoney(total)}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: themedHeaderBox(th, [
        { type: 'text', text: `${th.deco} ${parseInt(mk.slice(5), 10)} 月記帳月結`.trim(),
          size: 'sm', weight: 'bold', color: th.headerText },
        { type: 'text', text: `$${fmtMoney(total)}`, size: '3xl', weight: 'bold',
          color: th.headerText, margin: 'sm' },
        { type: 'text', text: `現金 $${fmtMoney(total - cardSum)}・刷卡 $${fmtMoney(cardSum)}`,
          size: 'xs', color: '#FFFFFFDD', margin: 'sm' },
      ]),
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
    },
  };
}

// 結帳日 Hero 大數字卡（應繳金額置中放大）
function buildStatementHeroFlex(cardName, amount, cycle, theme) {
  const th = theme || FLEX_THEMES.classic;
  const heroBody = {
    type: 'box', layout: 'vertical', justifyContent: 'center', paddingAll: 'xxl',
    contents: [
      { type: 'text', text: `${th.deco} 今天是結帳日 ${th.deco2}`.trim(),
        size: 'sm', color: '#FFFFFFDD', align: 'center' },
      { type: 'text', text: `💳 ${cardName}`, size: 'lg', weight: 'bold',
        color: th.headerText, align: 'center', margin: 'md' },
      { type: 'text', text: `$${fmtMoney(amount)}`, size: '3xl', weight: 'bold',
        color: th.headerText, align: 'center', margin: 'md' },
      { type: 'text', size: 'xs', color: '#FFFFFFCC', align: 'center', margin: 'sm',
        text: `本期應繳（${cycle.startStr.slice(5).replace('-', '/')} ~ ${cycle.endStr.slice(5).replace('-', '/')}）` },
    ],
  };
  if (th.gradient) {
    heroBody.background = {
      type: 'linearGradient', angle: '135deg',
      startColor: th.gradient[0], endColor: th.gradient[1],
    };
  } else {
    heroBody.backgroundColor = th.headerBg;
  }
  return {
    type: 'flex',
    altText: `💳 ${cardName}今天結帳，本期應繳 $${fmtMoney(amount)}`,
    contents: { type: 'bubble', size: 'mega', body: heroBody },
  };
}

async function replyExpenseMonthSummary(client, ev, fid, mk) {
  const items = await getExpensesInRange(fid, `${mk}-01`, clampedDateForMonth(mk, 31));
  if (items.length === 0) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: `${parseInt(mk.slice(5), 10)} 月還沒有記帳紀錄。`,
    }));
  }
  const prevMk = addMonthKey(mk, -1);
  const prevItems = await getExpensesInRange(fid, `${prevMk}-01`, clampedDateForMonth(prevMk, 31));
  const theme = flexThemeForToday(formatDateTW(new Date()));
  return safeReply(client, ev.replyToken, financeQuickReply(
    buildMonthReportFlex(mk, items, prevItems, theme)
  ));
}

async function replyExpenseRecent(client, ev, fid) {
  const todayStr = formatDateTW(new Date());
  const items = await getExpensesInRange(fid, addDaysStr(todayStr, -90), todayStr);
  if (items.length === 0) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: '還沒有記帳紀錄。直接輸入「品項 金額」即可，例：早餐 65',
    }));
  }
  const recent = items.slice(-10).reverse();
  const lines = ['🧾 最近的記帳：'];
  recent.forEach((e) => lines.push(`• ${expenseLineLabel(e)}`));
  lines.push('');
  lines.push('要刪除請傳「刪帳」或「刪帳 品項」');
  return safeReply(client, ev.replyToken, financeQuickReply({ type: 'text', text: lines.join('\n') }));
}

function buildExpenseDeleteFlex(fid, items) {
  return {
    type: 'flex',
    altText: '選擇要刪除的記帳',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: '#F5F0EB',
        contents: [{ type: 'text', text: '🗑️ 點選要刪除的記帳', weight: 'bold', size: 'sm', color: '#5F524C' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: items.map((e) => ({
          type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
          contents: [
            {
              type: 'box', layout: 'vertical', flex: 7,
              contents: [
                { type: 'text', text: `${e.item} $${fmtMoney(e.amount)}`, size: 'sm', weight: 'bold', wrap: true, color: '#5F524C' },
                { type: 'text', text: `${e.date.slice(5).replace('-', '/')}${e.card ? `・💳${e.card}` : ''}`, size: 'xs', color: '#998B82' },
              ],
            },
            {
              type: 'button', style: 'primary', color: '#D48888', height: 'sm', flex: 3,
              action: {
                type: 'postback',
                label: '刪除',
                data: `act=fexp_del&fid=${fid}&id=${e.id}`,
                displayText: `刪除 ${e.item} $${fmtMoney(e.amount)}`,
              },
            },
          ],
        })),
      },
    },
  };
}

async function handleExpenseDelete(client, ev, fid, query) {
  const todayStr = formatDateTW(new Date());
  const items = await getExpensesInRange(fid, addDaysStr(todayStr, -90), todayStr);
  if (items.length === 0) {
    return safeReply(client, ev.replyToken, financeQuickReply({
      type: 'text', text: '最近 90 天沒有記帳紀錄。',
    }));
  }
  let candidates = items;
  if (query) {
    // 「刪帳 8/3 加油」→ 日期 + 關鍵字；「刪帳 加油」→ 關鍵字
    let keyword = query;
    let dateFilter = null;
    const dm = query.match(/^(\d{1,2})[\/月](\d{1,2})[日號]?[\s　]*(.*)$/);
    if (dm) {
      const y = parseInt(todayStr.slice(0, 4), 10);
      let cand = `${y}-${String(parseInt(dm[1], 10)).padStart(2, '0')}-${String(parseInt(dm[2], 10)).padStart(2, '0')}`;
      if (cand > todayStr) cand = `${y - 1}${cand.slice(4)}`;
      dateFilter = cand;
      keyword = (dm[3] || '').trim();
    }
    candidates = items.filter((e) =>
      (!dateFilter || e.date === dateFilter) &&
      (!keyword || e.item.includes(keyword)));
    if (candidates.length === 0) {
      return safeReply(client, ev.replyToken, financeQuickReply({
        type: 'text', text: `找不到符合「${query}」的記帳。傳「刪帳」看最近清單。`,
      }));
    }
    if (candidates.length === 1) {
      const e = candidates[0];
      await finSpaceRef(fid).collection('expenses').doc(e.id)
        .set({ deletedVia: 'line' }, { merge: true });
      await finSpaceRef(fid).collection('expenses').doc(e.id).delete();
      return safeReply(client, ev.replyToken, financeQuickReply({
        type: 'text', text: `🗑️ 已刪除：${expenseLineLabel(e)}`,
      }));
    }
  }
  // 多筆或未指定 → 列表點按刪（最近 10 筆）
  const list = candidates.slice(-10).reverse();
  return safeReply(client, ev.replyToken, buildExpenseDeleteFlex(fid, list));
}

// 「撤回」整合：比較記帳與行事曆的最後操作時間，撤回較新的那個
// 回傳 true = 已由記帳側處理
async function tryFinanceUndoIfNewer(client, ev) {
  if (ev.source?.type !== 'user') return false;
  const fid = await getFinanceIdForLineUser(ev.source.userId);
  if (!fid) return false;
  const spaceSnap = await finSpaceRef(fid).get();
  const finOp = spaceSnap.exists ? spaceSnap.data().lastOp : null;
  if (!finOp || finOp.type !== 'expense_create' || !finOp.expenseId) return false;

  // 行事曆側的 lastop 時間
  let calMillis = 0;
  const uids = await getBoundUidsForSource(getSourceId(ev));
  if (uids.length > 0) {
    const calSnap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uids[0])
      .collection('bibi_settings').doc('lastop').get();
    if (calSnap.exists && calSnap.data().timestamp) {
      calMillis = calSnap.data().timestamp.toMillis();
    }
  }
  const finMillis = finOp.at ? finOp.at.toMillis() : 0;
  if (finMillis <= calMillis) return false; // 行事曆操作比較新 → 交回原本的撤回

  const ref = finSpaceRef(fid).collection('expenses').doc(finOp.expenseId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.set({ deletedVia: 'line' }, { merge: true });
  await ref.delete();
  await finSpaceRef(fid).set({ lastOp: admin.firestore.FieldValue.delete() }, { merge: true });
  await safeReply(client, ev.replyToken, financeQuickReply({
    type: 'text', text: `↩️ 已撤回記帳：${finOp.item} $${fmtMoney(finOp.amount)}`,
  }));
  return true;
}

// --- AI 唯讀查詢工具（只在私聊 + 已綁定時注入；群組物理上拿不到） ---
const aiFinanceToolHandlers = {
  async query_expenses({ startDate, endDate, keyword, card }, ctx) {
    if (!ctx.financeId) return { error: 'no finance space' };
    if (!startDate || !endDate) return { error: 'startDate / endDate 必填' };
    let items = await getExpensesInRange(ctx.financeId, startDate, endDate);
    if (keyword) items = items.filter((e) => e.item.includes(keyword));
    if (card) items = items.filter((e) => e.card && e.card.includes(card.replace(/卡$/, '')));
    const byCategory = {};
    items.forEach((e) => {
      const cat = EXPENSE_CATEGORIES[e.category]?.name || '其他';
      byCategory[cat] = (byCategory[cat] || 0) + (Number(e.amount) || 0);
    });
    return {
      total: sumExpenses(items),
      count: items.length,
      byCategory,
      items: items.slice(-60).map((e) => ({
        date: e.date, item: e.item, amount: e.amount,
        category: EXPENSE_CATEGORIES[e.category]?.name || '其他',
        card: e.card || null,
      })),
    };
  },

  async query_finance_bills(_args, ctx) {
    if (!ctx.financeId) return { error: 'no finance space' };
    const todayStr = formatDateTW(new Date());
    const bills = await getFinanceBills(ctx.financeId);
    const out = [];
    for (const b of bills) {
      if (b.type === 'card') {
        const cycle = cardCycleForToday(b.day, todayStr);
        const items = (await getExpensesInRange(ctx.financeId, cycle.startStr, cycle.endStr))
          .filter((e) => e.card === b.name);
        const total = sumExpenses(items);
        out.push({
          type: 'card', name: b.name, statementDay: b.day,
          cycleStart: cycle.startStr, cycleEnd: cycle.endStr,
          cycleSpent: total, limit: b.limit || null,
          remainingLimit: b.limit ? Math.max(0, b.limit - total) : null,
        });
      } else {
        out.push({
          type: 'loan', name: b.name, dueDay: b.day, amount: b.amount || null,
          nextDueDate: nextMonthlyOccurrence(b.day, todayStr),
        });
      }
    }
    return { bills: out };
  },
};

function aiFinanceToolDefs() {
  return [
    {
      type: 'function',
      name: 'query_expenses',
      description: '查詢使用者的私人記帳（唯讀）。回傳總額、分類統計與明細。金額為新台幣。',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate: { type: 'string', description: 'YYYY-MM-DD' },
          keyword: { type: 'string', description: '可選，品項關鍵字' },
          card: { type: 'string', description: '可選，信用卡名稱' },
        },
        required: ['startDate', 'endDate'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'query_finance_bills',
      description: '查詢使用者的信用卡（結帳日/本期已刷/額度）與貸款（繳款日）狀態（唯讀）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

// -------- Webhook: handle messages received by the bot --------
exports.lineWebhook = onRequest(
  {
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, OPENAI_API_KEY],
    cors: false,
    timeoutSeconds: 60, // AI agent 多輪 function call + web_search 最多會跑 20-40 秒
  },
  async (req, res) => {
    const signature = req.get('x-line-signature');
    // 必須用 LINE 實際簽章的原始 bytes 驗證；re-serialize 過的 JSON
    // 在 unicode/欄位順序有差異時會讓合法 webhook 被 401 丟掉
    const body = req.rawBody || JSON.stringify(req.body);
    if (!line.validateSignature(body, LINE_CHANNEL_SECRET.value(), signature)) {
      res.status(401).send('Invalid signature');
      return;
    }

    const events = req.body.events || [];
    const client = lineClient();

    for (const ev of events) {
      try {
        // 去重複觸發 (LINE 偶爾會重送同一個 webhookEventId)
        if (await isDuplicateWebhookEvent(ev.webhookEventId)) {
          console.log('[dedup] skip', ev.webhookEventId);
          continue;
        }
        if (ev.type === 'follow' || ev.type === 'join') {
          await safeReply(client, ev.replyToken, withQuickReply(
            buildWelcomeFlex(ev.source?.type)
          ));
        } else if (ev.type === 'unfollow' || ev.type === 'leave') {
          await removeBindingsForSource(getSourceId(ev));
        } else if (ev.type === 'postback') {
          await handlePostback(client, ev);
        } else if (ev.type === 'message' && ev.message.type === 'image') {
          // 圖片訊息 → 走 Vision pipeline，由 AI 看圖建行程
          await replyAskGPTFromImage(client, ev, ev.message.id, '');
        } else if (ev.type === 'message' && ev.message.type === 'text') {
          const sourceId = getSourceId(ev);
          if (!sourceId) {
            await safeReply(client, ev.replyToken, {
              type: 'text',
              text: '無法辨識訊息來源，請改用個人聊天或重新邀請 Bot。',
            });
            continue;
          }
          const text = ev.message.text.trim();
          const bindMatch = text.match(/^綁定[\s　]+(\S+)$/);
          const range = getRangeFromText(text);

          if (bindMatch) {
            const uid = bindMatch[1];
            await db()
              .collection('artifacts').doc(APP_ID)
              .collection('users').doc(uid)
              .collection('bibi_settings').doc('line')
              .set(
                {
                  lineUserIds: admin.firestore.FieldValue.arrayUnion(sourceId),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            await safeReply(client, ev.replyToken, withQuickReply({
              type: 'text',
              text: `✅ 綁定成功！\n之後 ${uid.substring(0, 6)}... 這組行事曆有變動或排程提醒都會推到這個聊天視窗。\n\n想取消綁定請傳：解除綁定`,
            }));
          } else if (text === '解除綁定') {
            await removeBindingsForSource(sourceId);
            await safeReply(client, ev.replyToken, {
              type: 'text',
              text: '已解除所有綁定。要重新綁定請再傳：綁定 <你的裝置 ID>',
            });
          } else if (text === '狀態' || text === '綁定狀態' || text === 'status') {
            await replyBindingStatus(client, ev);
          } else if (text === '用量' || text === '推播用量' || text === 'usage') {
            await replyUsage(client, ev);
          } else if (ev.source?.type === 'user' && await tryFinanceCommand(client, ev, text)) {
            // 帳務指令（綁定/帳單/記帳查詢/刪帳）— 僅私聊，群組直接無視
          } else if (text === '誰是誰' || text === '誰是誰?' || text === '誰是誰？') {
            await replyIdentityMap(client, ev);
          } else if (text === '幫助' || text === '說明' || text === '指令' ||
                     text === '行事曆指令' || text === '行事曆' ||
                     text.toLowerCase() === 'help') {
            await safeReply(client, ev.replyToken, withQuickReply({
              type: 'text', text: getHelpText(ev.source?.type === 'user'),
            }));
          } else if (text === '下一個' || text === '下個' || text === 'next') {
            await replyNextEvents(client, ev, 1);
          } else if (text === '最近' || text === '即將' || text === '即將到來') {
            await replyNextEvents(client, ev, 5);
          } else if ((text === '撤回' || text === 'Undo' || text === 'undo' || text === 'UNDO') &&
                     await tryFinanceUndoIfNewer(client, ev)) {
            // 記帳的撤回（比行事曆操作更新時優先）
          } else if (text === '撤回' || text === 'Undo' || text === 'undo' || text === 'UNDO') {
            await tryUndoLastOp(client, ev);
          } else if (text === '匯出' || text.startsWith('匯出 ') || text.startsWith('匯出　')) {
            await tryExportICS(client, ev, text.replace(/^匯出[\s　]*/, '').trim());
          } else if (/^\d+[\s　]*(分鐘?|小時|時|hr|min)[\s　]*後/.test(text)) {
            await tryDelayedReminder(client, ev, text);
          } else if (text === '剩下' || text === '今天剩' || text === '今天還剩' ||
                     text === '剩什麼' || text === '今天剩什麼') {
            await replyRemainingToday(client, ev);
          } else if (text === '空檔' || text === '明天空檔' || text === '明天有空嗎') {
            await replyFreeSlots(client, ev, 'tomorrow');
          } else if (text === '今天空檔' || text === '今天有空嗎') {
            await replyFreeSlots(client, ev, 'today');
          } else if (text === '本週空檔' || text === '這週空檔' || text === '本週有空嗎') {
            await replyFreeSlots(client, ev, 'week');
          } else if (text === '便利貼' || text === '便利貼清單' || text === '備忘') {
            await replyStickyList(client, ev);
          } else if (text.startsWith('便利貼 ') || text.startsWith('便利貼　') || text.startsWith('記一下 ') || text.startsWith('記一下　')) {
            await trySticky(client, ev, text.replace(/^(便利貼|記一下)[\s　]*/, '').trim());
          } else if (text.startsWith('打卡')) {
            await tryCheckin(client, ev, text.replace(/^打卡[\s　]*/, '').trim());
          } else if (text === '節氣' || text === '下個節氣') {
            await replyNextSolarTerm(client, ev);
          } else if (text === '統計' || text === '本月統計' || text === '月統計') {
            await replyMonthlyStats(client, ev);
          } else if (text === '衝突' || text === '撞時間' || text === '撞行程') {
            await replyConflicts(client, ev);
          } else if (text === '第幾週' || text === '週數' || text === '今天第幾週') {
            await replyWeekNumber(client, ev);
          } else if (text === '假日' || text === '下個假日' || text === '國定假日') {
            await replyNextHoliday(client, ev);
          } else if (text === '生日' || text === '生日清單' || text === '所有生日') {
            await replyTitleFilteredList(client, ev, ['生日', '生辰', '壽', '誕辰'], '生日');
          } else if (text === '休假' || text === '請假' || text === '請假清單') {
            await replyTitleFilteredList(client, ev, ['休假', '請假', '年假', '特休', '病假', '事假'], '休假');
          } else if (text.startsWith('倒數') || text.startsWith('還剩')) {
            const q = text.replace(/^(倒數|還剩)[\s　]*/, '').trim();
            await replyCountdown(client, ev, q);
          } else if (/^(親|AI|ai)[\s　:：]/.test(text) || text === '親' || text.toLowerCase() === 'ai') {
            // 收緊判斷，避免「親愛的」「親自」這種以親開頭的非指令被誤觸
            const q = text.replace(/^(親|AI|ai)[\s　:：]*/, '').trim();
            await replyAskGPT(client, ev, q);
          } else if (text.startsWith('找') || text.startsWith('搜尋') || text.startsWith('查')) {
            const q = text.replace(/^(搜尋|找|查)[\s　]*/, '').trim();
            await replySearch(client, ev, q);
          } else if (text.startsWith('我是') && await handleIdentitySet(client, ev, text)) {
            // 已處理「我是 X」自我介紹
          } else if (text.startsWith('改')) {
            await tryEditEvent(client, ev, text);
          } else if (text.startsWith('新增')) {
            const body = text.replace(/^新增[\s　]*/, '').trim();
            // 偵測批量 (多個逗號分隔的日期) → tryBatchCreate
            const hasMultiDate = /[\d]+[\/\-][\d]+[\s　]*[,，、]/.test(body);
            if (hasMultiDate) await tryBatchCreate(client, ev, body);
            else await tryCreateExplicit(client, ev, body);
          } else if (text.startsWith('批量')) {
            await tryBatchCreate(client, ev, text.replace(/^批量[\s　]*/, '').trim());
          } else if (text.startsWith('重複')) {
            await tryRecurringCreate(client, ev, text.replace(/^重複[\s　]*/, '').trim());
          } else if (text.startsWith('刪除') || text.startsWith('刪 ') || text === '刪') {
            const body = text.replace(/^刪除?[\s　]*/, '').trim();
            await tryDeleteEvent(client, ev, body);
          } else if (text.startsWith('完成')) {
            await tryCompleteEvent(client, ev, text.replace(/^完成[\s　]*/, '').trim());
          } else if (text.startsWith('取消')) {
            await tryCancelEvent(client, ev, text.replace(/^取消[\s　]*/, '').trim());
          } else if (text.startsWith('複製')) {
            await tryCopyEvent(client, ev, text.replace(/^複製[\s　]*/, '').trim());
          } else if (text.startsWith('延後')) {
            await tryShiftEvent(client, ev, text.replace(/^延後[\s　]*/, '').trim(), 1);
          } else if (text.startsWith('提前')) {
            await tryShiftEvent(client, ev, text.replace(/^提前[\s　]*/, '').trim(), -1);
          } else if (await tryRoleFilteredQuery(client, ev, text)) {
            // 已處理角色過濾 (Shane 今天 / 阿花 本週 / 只看共同 等)
          } else if (range) {
            await replyAgenda(client, ev, range);
          } else if (ev.source?.type === 'group' || ev.source?.type === 'room') {
            // 群組／多人聊天室：非指令訊息保持安靜，避免 AI 被亂觸發
          } else if (/\d[元塊]/.test(text) && await tryFinanceExpenseCatchAll(client, ev, text)) {
            // 記帳的明確逃生口：金額後面帶「元/塊」（例「早餐 65元」）
            // 就算在 AI 對話 5 分鐘窗口內也強制當記帳，不會被 AI 追問吃掉
          } else if (text.length >= 2 && await hasRecentAIConversation(sourceId)) {
            // AI 對話追問優先於記帳 catch-all：
            // 否則「AI 問幾點 → 使用者答『下午 3』」會被記成一筆 $3 支出
            await replyAskGPT(client, ev, text);
          } else if (await tryFinanceExpenseCatchAll(client, ev, text)) {
            // 記帳：「品項 金額 [卡名]」／卡名查詢 — 僅私聊 + 已帳務綁定
          } else {
            await safeReply(client, ev.replyToken, withQuickReply({
              type: 'text',
              text: getHelpText(ev.source?.type === 'user'),
            }));
          }
        }
      } catch (err) {
        console.error('Webhook event error:', err);
      }
    }
    res.status(200).send('OK');
  }
);

// -------- Realtime notifications: event CRUD --------
exports.notifyOnEventCreate = onDocumentCreated(
  {
    document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async (event) => {
    if (!NOTIFY_ON_CREATE) return;
    const ev = event.data.data();
    const uid = event.params.uid;
    const eventId = event.params.eventId;
    const roles = await getRoleSettings(uid);
    const ownerLabel = ev.eventType === 'me' ? (roles.role1 || '我')
      : ev.eventType === 'partner' ? (roles.role2 || '夥伴')
      : '共同';
    const flex = buildEventConfirmFlex(ev, ownerLabel, { uid, eventId });
    flex.contents.header.contents[0].text = '📝 新增行程';
    flex.altText = `📝 新增行程：${ev.title}`;
    // 回音抑制：LINE 建立的行程不再推回來源聊天室 (那裡已有確認回覆)
    await pushToBoundUsers(uid, flex, 'event_create', ev.createdVia || null);
  }
);

// 修改通知：預設關閉（NOTIFY_ON_UPDATE=false）。
// 仍保留 trigger，因為要在「時間變動時清掉 reminderNotifiedAt」讓提醒可重發。
exports.notifyOnEventUpdate = onDocumentUpdated(
  {
    document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const timeChanged =
      before.startDate !== after.startDate ||
      before.endDate !== after.endDate ||
      before.startTime !== after.startTime ||
      before.endTime !== after.endTime ||
      before.isAllDay !== after.isAllDay;
    const titleChanged = before.title !== after.title;
    if (!timeChanged && !titleChanged) return;

    // 時間變動 → 清提醒記號 (跟通知開關無關，永遠執行)
    if (timeChanged && after.reminderNotifiedAt) {
      await event.data.after.ref.update({
        reminderNotifiedAt: admin.firestore.FieldValue.delete(),
      });
    }

    if (!NOTIFY_ON_UPDATE) return;
    const uid = event.params.uid;
    await pushToBoundUsers(uid, `✏️ 行程更新：${formatEvent(after)}`, 'event_update');
  }
);

exports.notifyOnEventDelete = onDocumentDeleted(
  {
    document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async (event) => {
    if (!NOTIFY_ON_DELETE) return;
    const ev = event.data.data();
    const uid = event.params.uid;
    await pushToBoundUsers(uid, `🗑️ 行程刪除：${ev.title}`, 'event_update');
  }
);

// -------- Scheduled notifications --------
// 抓今日天氣摘要 (台北)，用 OpenAI web_search 一次拿，所有使用者共用同一份結果
async function getTodayWeatherBlurb(today) {
  try {
    const data = await openaiResponses(
      [{
        role: 'user',
        content:
          `用一行 (40 字內) 簡潔告訴我「${today} 高雄今天的天氣摘要 + 紫外線指數」。` +
          `格式：「🌤️ 26-32°C，降雨機率 30%，紫外線指數，要注意防曬喔！」。直接給結論，不要前言。`,
      }],
      [{ type: 'web_search' }],
    );
    // 從 response 中抽出最終文字
    for (const item of data.output || []) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if ((c.type === 'output_text' || c.type === 'text') && c.text) {
            return c.text.trim().slice(0, 80);
          }
        }
      }
    }
    return '';
  } catch (e) {
    console.warn('[weather] failed', e?.message || e);
    return '';
  }
}

exports.dailyMorningSummary = onSchedule(
  {
    schedule: '0 0 * * *',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY],
  },
  async () => {
    if (!NOTIFY_DAILY_SUMMARY) {
      console.log('[dailyMorningSummary] disabled by feature flag');
      return;
    }
    const today = formatDateTW(new Date());
    console.log('[dailyMorningSummary] start', { today, buildVersion: BUILD_VERSION });

    // 整批使用者共用同一份天氣 (省一次 web_search 費用)
    const weatherBlurb = await getTodayWeatherBlurb(today);

    // 不用 where('lineUserIds', '!=', [])：collectionGroup + 陣列 != 查詢
    // 在沒手動建 index 時會丟 FAILED_PRECONDITION 讓 function 500。
    const snap = await db().collectionGroup('bibi_settings').get();
    console.log('[dailyMorningSummary] bibi_settings docs:', snap.size);

    for (const doc of snap.docs) {
      try {
        if (doc.id !== 'line') continue;
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;
        const lineUserIds = doc.data()?.lineUserIds || [];
        if (lineUserIds.length === 0) continue;

        const eventsSnap = await db()
          .collection('artifacts').doc(APP_ID)
          .collection('users').doc(uid)
          .collection('bibi_events')
          .where('startDate', '<=', today)
          .get();

        const roles = await getRoleSettings(uid);
        const dayEvents = [];
        eventsSnap.forEach((d) => {
          const e = d.data();
          if (!e.endDate || e.endDate < today) return; // 已結束的略過
          dayEvents.push({ ...e, _uid: uid });
        });
        dayEvents.sort((a, b) => {
          if (a.isAllDay && !b.isAllDay) return -1;
          if (!a.isAllDay && b.isAllDay) return 1;
          return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
        });

        // 一律推放大版 Flex 卡片（雙欄時間軸），天氣放標頭副標、依日期套主題；
        // 空日也用卡片，body 會顯示「今天沒有行程，好好休息 ☕」
        const todayDate = new Date(`${today}T00:00:00+08:00`);
        const theme = flexThemeForToday(today);
        const flex = buildAgendaFlex(
          `今日行程　${formatDateLabel(todayDate)}`,
          [{ date: todayDate, dateStr: today, events: dayEvents }],
          { uidRoles: { [uid]: roles }, subtitle: weatherBlurb || null, theme }
        );
        flex.altText = dayEvents.length > 0
          ? `${theme.deco} 今日行程 ${dayEvents.length} 件`
          : `${theme.deco} 今天沒有行程，好好休息 💤`;
        await pushToTargets(uid, lineUserIds, flex, 'morning');
      } catch (err) {
        console.error('[dailyMorningSummary] user error', { path: doc.ref.path, err: err?.message || err });
      }
    }
    console.log('[dailyMorningSummary] done');
  }
);

exports.preEventReminder = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    if (!NOTIFY_PRE_EVENT_REMINDER) {
      console.log('[preEventReminder] disabled by feature flag');
      return;
    }
    const now = new Date();
    const horizon = new Date(now.getTime() + 45 * 60 * 1000);
    const today = formatDateTW(now);
    console.log('[preEventReminder] start', { today, buildVersion: BUILD_VERSION });

    // 避免 collectionGroup + 多 where 的 composite index 需求，
    // 先抓綁定設定，再逐個 user 查當天事件 (數量小，效能 OK)。
    const settingsSnap = await db().collectionGroup('bibi_settings').get();
    for (const settingDoc of settingsSnap.docs) {
      try {
        if (settingDoc.id !== 'line') continue;
        const uid = settingDoc.ref.parent.parent?.id;
        if (!uid) continue;
        const lineUserIds = settingDoc.data()?.lineUserIds || [];
        if (lineUserIds.length === 0) continue;

        const eventsSnap = await db()
          .collection('artifacts').doc(APP_ID)
          .collection('users').doc(uid)
          .collection('bibi_events')
          .where('startDate', '==', today)
          .get();

        for (const doc of eventsSnap.docs) {
          const ev = doc.data();
          if (ev.isAllDay) continue;
          if (!ev.startTime) continue;
          if (ev.reminderNotifiedAt) continue;
          // 事件的 startDate/startTime 都是 Taipei 當地時間，
          // 用 ISO 8601 帶 +08:00 偏移建構正確的 UTC 時間戳。
          const startTs = taipeiEventStart(ev.startDate, ev.startTime);
          if (startTs > now && startTs <= horizon) {
            console.log('[preEventReminder] pushing', { uid, title: ev.title, startTime: ev.startTime });
            await pushToBoundUsers(
              uid,
              `⏰ 即將開始：${ev.title}\n  ${ev.startTime} - ${ev.endTime}`,
              'reminder'
            );
            await doc.ref.update({
              reminderNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      } catch (err) {
        console.error('[preEventReminder] user error', { path: settingDoc.ref.path, err: err?.message || err });
      }
    }
    console.log('[preEventReminder] done');
  }
);

// 每週日 20:00 (Taipei) 推下週預覽
exports.weeklySundayPreview = onSchedule(
  {
    schedule: '0 20 * * 0',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    if (!NOTIFY_WEEKLY_SUNDAY_PREVIEW) {
      console.log('[weeklySundayPreview] disabled by feature flag');
      return;
    }
    const todayStr = formatDateTW(new Date());
    const dow = getDayOfWeekTaipei(new Date());
    // 從今天到下個週一的天數：週日 → 1、其他天就是 (8 - dow) % 7
    const daysToNextMonday = ((8 - dow) % 7) || 7;
    const nextMondayStr = addDaysStr(todayStr, daysToNextMonday);
    const nextSundayStr = addDaysStr(nextMondayStr, 6);
    console.log('[weeklySundayPreview] start', {
      buildVersion: BUILD_VERSION, nextMondayStr, nextSundayStr,
    });

    const settingsSnap = await db().collectionGroup('bibi_settings').get();
    for (const settingDoc of settingsSnap.docs) {
      try {
        if (settingDoc.id !== 'line') continue;
        const uid = settingDoc.ref.parent.parent?.id;
        if (!uid) continue;
        const lineUserIds = settingDoc.data()?.lineUserIds || [];
        if (lineUserIds.length === 0) continue;

        const eventsSnap = await db()
          .collection('artifacts').doc(APP_ID)
          .collection('users').doc(uid)
          .collection('bibi_events')
          .where('startDate', '<=', nextSundayStr)
          .get();

        const roles = await getRoleSettings(uid);

        // 依日期分組
        const byDate = {};
        for (let i = 0; i < 7; i++) {
          byDate[addDaysStr(nextMondayStr, i)] = [];
        }
        eventsSnap.forEach((d) => {
          const e = d.data();
          if (!e.endDate || e.endDate < nextMondayStr) return;
          for (const dateStr of Object.keys(byDate)) {
            if (dateStr >= e.startDate && dateStr <= e.endDate) {
              byDate[dateStr].push(e);
            }
          }
        });

        const lines = [`🌙 下週行程預覽 (${nextMondayStr} ~ ${nextSundayStr})`, ''];
        let totalCount = 0;
        for (const dateStr of Object.keys(byDate)) {
          const events = byDate[dateStr];
          const label = formatDateLabel(taipeiMidnight(dateStr));
          if (events.length === 0) continue;
          totalCount += events.length;
          lines.push(`${label}`);
          // 全天先列
          events.sort((a, b) => {
            if (a.isAllDay && !b.isAllDay) return -1;
            if (!a.isAllDay && b.isAllDay) return 1;
            return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
          });
          events.forEach((e) => {
            const ownerLabel = computeOwnerLabel(e.eventType, roles);
            lines.push(`  • ${e.isAllDay ? '全天' : e.startTime || ''} ${e.title}（${ownerLabel}）`);
          });
          lines.push('');
        }
        const message = totalCount === 0
          ? `🌙 下週 (${nextMondayStr} ~ ${nextSundayStr}) 沒有排程，可以好好放鬆 ☕`
          : lines.join('\n').trim();

        await pushToTargets(uid, lineUserIds, message, 'weekly');
      } catch (err) {
        console.error('[weeklySundayPreview] user error', {
          path: settingDoc.ref.path, err: err?.message || err,
        });
      }
    }
    console.log('[weeklySundayPreview] done');
  }
);

// ============================================================
// iCal 匯出 HTTP endpoint：用 token 驗證，回傳 text/calendar 內容
// 給 Google / Apple Calendar 的「從 URL 訂閱」用
// ============================================================
exports.exportIcal = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      const uid = String(req.query.uid || '');
      const token = String(req.query.token || '');
      const startStr = req.query.start ? String(req.query.start) : null;
      const days = req.query.days ? parseInt(String(req.query.days), 10) : null;
      if (!uid || !token) {
        res.status(400).send('Missing uid or token');
        return;
      }
      const settings = await db().collection('artifacts').doc(APP_ID)
        .collection('users').doc(uid)
        .collection('bibi_settings').doc('export').get();
      if (!settings.exists || settings.data().icalToken !== token) {
        res.status(403).send('Invalid token');
        return;
      }
      // 抓事件 (沒指定範圍就抓未來全部)
      const todayStr = formatDateTW(new Date());
      const rangeStart = startStr || todayStr;
      const rangeEnd = days ? addDaysStr(rangeStart, days) : addDaysStr(todayStr, 365 * 2);
      const eventsSnap = await db().collection('artifacts').doc(APP_ID)
        .collection('users').doc(uid).collection('bibi_events')
        .where('startDate', '<=', rangeEnd).get();
      const events = [];
      eventsSnap.forEach((d) => {
        const e = d.data();
        if (!e.endDate || e.endDate < rangeStart) return;
        events.push({ _eventId: d.id, ...e });
      });
      const ics = buildICS(events);
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', 'inline; filename="bibi-schedule.ics"');
      res.status(200).send(ics);
    } catch (err) {
      console.error('[exportIcal]', err);
      res.status(500).send(String(err?.message || err));
    }
  }
);

// ============================================================
// 稍後提醒 cron：每 5 分鐘掃 pending_reminders 撈已到期的，push 完刪掉
// ============================================================
exports.runPendingReminders = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('pending_reminders')
      .where('triggerAt', '<=', now)
      .limit(50).get();
    if (snap.empty) return;
    const client = lineClient();
    for (const d of snap.docs) {
      try {
        const r = d.data();
        const msg = { type: 'text', text: `⏰ 提醒：${r.text}` };
        await client.pushMessage(r.sourceId, msg);
      } catch (e) {
        console.warn('[reminders] push failed', d.id, e?.message);
      } finally {
        await d.ref.delete();
      }
    }
  }
);

// ============================================================
// 帳務排程通知：每日 00:10 (Asia/Taipei)
//  - 信用卡結帳日當天 → 「今天結帳，本期應繳 $N」
//  - 貸款繳款日前 3 天起每天 + 當天
//  - 每月 1 號 → 上月記帳月結報告
// 全部只私訊給綁定者本人，不進群組、不進共用摘要。
// ============================================================
exports.financeDailyNotify = onSchedule(
  {
    schedule: '10 0 * * *',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    const todayStr = formatDateTW(new Date());
    const mk = todayStr.slice(0, 7);
    const isFirstOfMonth = todayStr.endsWith('-01');
    const bindingsSnap = await db().collection('artifacts').doc(APP_ID)
      .collection('finance_bindings').get();
    console.log('[financeDailyNotify] start', { todayStr, bindings: bindingsSnap.size });
    if (bindingsSnap.empty) return;
    const client = lineClient();

    const theme = flexThemeForToday(todayStr);

    for (const bindDoc of bindingsSnap.docs) {
      try {
        const lineUserId = bindDoc.id;
        const fid = bindDoc.data().financeId;
        if (!fid) continue;
        // 同一天所有帳務訊息合併成一次 push（最多 5 個訊息物件，LINE 計費以
        // 「一次 push × 收件人」算 1 則，Flex 卡片化不會增加額度消耗）
        const messages = [];
        const textLines = [];

        // 月結報告（1 號）→ 長條圖卡片
        if (isFirstOfMonth) {
          const lastMk = addMonthKey(mk, -1);
          const lastItems = await getExpensesInRange(fid, `${lastMk}-01`, clampedDateForMonth(lastMk, 31));
          if (lastItems.length > 0) {
            const prevMk = addMonthKey(lastMk, -1);
            const prevItems = await getExpensesInRange(fid, `${prevMk}-01`, clampedDateForMonth(prevMk, 31));
            messages.push(buildMonthReportFlex(lastMk, lastItems, prevItems, theme));
          }
        }

        // 帳單提醒
        const bills = await getFinanceBills(fid);
        for (const b of bills) {
          if (b.type === 'card') {
            const stmtToday = clampedDateForMonth(mk, b.day) === todayStr;
            if (stmtToday) {
              const cycle = cardCycleForToday(b.day, todayStr); // endStr === today
              const items = (await getExpensesInRange(fid, cycle.startStr, cycle.endStr))
                .filter((e) => e.card === b.name);
              const due = sumExpenses(items);
              if (messages.length < 4) {
                // 結帳日 → Hero 大數字卡
                messages.push(buildStatementHeroFlex(b.name, due, cycle, theme));
              } else {
                textLines.push(`💳 ${b.name}今天結帳，本期應繳 $${fmtMoney(due)}`);
              }
            }
          } else {
            const next = nextMonthlyOccurrence(b.day, todayStr);
            const dLeft = daysBetween(next, todayStr);
            if (dLeft === 0) {
              textLines.push(`🏦 ${b.name}今天繳款${b.amount ? ` $${fmtMoney(b.amount)}` : ''}`);
            } else if (dLeft >= 1 && dLeft <= 3) {
              textLines.push(`🏦 ${b.name}繳款日 ${next.slice(5).replace('-', '/')}（還 ${dLeft} 天）${b.amount ? `$${fmtMoney(b.amount)}` : ''}`);
            }
          }
        }

        if (textLines.length > 0) messages.push({ type: 'text', text: textLines.join('\n') });
        if (messages.length === 0) continue;
        await client.pushMessage(lineUserId, messages.slice(0, 5));
        await finSpaceRef(fid).set({
          [`pushCount_${mk}`]: admin.firestore.FieldValue.increment(1),
        }, { merge: true });
      } catch (err) {
        console.error('[financeDailyNotify] user error', { id: bindDoc.id, err: err?.message || err });
      }
    }
    console.log('[financeDailyNotify] done');
  }
);

// ============================================================
// 記帳刪除觸發器：App 端刪除 → LINE 私訊留底
// LINE 端刪除前會先蓋 deletedVia:'line' 戳記，這裡看到就跳過（避免重複通知）
// ============================================================
exports.notifyOnExpenseDelete = onDocumentDeleted(
  {
    document: `artifacts/${APP_ID}/finance/{fid}/expenses/{expenseId}`,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.deletedVia === 'line') return;
    const fid = event.params.fid;
    const spaceSnap = await finSpaceRef(fid).get();
    if (!spaceSnap.exists) return; // 空間已整個刪除 (wipe) → 不推
    const owner = spaceSnap.data().ownerLineUserId;
    if (!owner) return;
    const cat = EXPENSE_CATEGORIES[data.category] || EXPENSE_CATEGORIES.other;
    try {
      await lineClient().pushMessage(owner, {
        type: 'text',
        text: `🗑️ 已刪除記帳：${(data.date || '').slice(5).replace('-', '/')} ${cat.emoji} ${data.item} $${fmtMoney(data.amount)}`,
      });
      const mk = formatDateTW(new Date()).slice(0, 7);
      await finSpaceRef(fid).set({
        [`pushCount_${mk}`]: admin.firestore.FieldValue.increment(1),
      }, { merge: true });
    } catch (e) {
      console.warn('[expenseDelete] push failed', e?.message);
    }
  }
);

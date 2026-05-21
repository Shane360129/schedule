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
const BUILD_VERSION = '2026-05-21-v21-ai-agent';

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
async function openaiResponses(input, tools, model = 'gpt-4o-mini') {
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
      tool_choice: 'auto',
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

function buildAgendaFlex(title, dateGroups, { compact = false, uidRoles = {} } = {}) {
  const ownerOf = (ev) => computeOwnerLabel(ev.eventType, uidRoles[ev._uid]);
  const todayStr = formatDateTW(new Date());
  const showDateHeader = dateGroups.length > 1;
  const bodyContents = [];

  dateGroups.forEach((g, idx) => {
    if (compact && g.events.length === 0) return; // 整月卡片自動跳過空檔
    const isToday = g.dateStr === todayStr;
    if (showDateHeader) {
      bodyContents.push({
        type: 'text',
        text: isToday ? `▶ ${formatDateLabel(g.date)}　今天` : formatDateLabel(g.date),
        weight: 'bold',
        size: 'sm',
        color: isToday ? '#8D6E63' : '#555555',
        margin: idx === 0 ? 'none' : 'lg',
      });
      bodyContents.push({
        type: 'separator',
        margin: 'xs',
        color: isToday ? '#BCAAA4' : '#EEEEEE',
      });
    }
    if (g.events.length === 0) {
      bodyContents.push({
        type: 'text',
        text: showDateHeader ? '（空檔）' : '今天沒有行程，好好休息 ☕',
        size: 'xs',
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
      const titleText = `${baseTitle}（${ownerOf(ev)}）`;
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: '📌', size: 'xs', flex: 2, gravity: 'top' },
          { type: 'text', text: titleText, size: 'sm', wrap: true, flex: 5,
            weight: 'bold', color: '#6D4C41' },
        ],
      });
    });
    timedEvents.forEach((ev) => {
      const isMulti = ev.startDate !== ev.endDate;
      const baseTitle = isMulti && compact
        ? `${ev.title || '(未命名)'} → ${ev.endDate.slice(5).replace('-', '/')}`
        : (ev.title || '(未命名)');
      const titleText = `${baseTitle}（${ownerOf(ev)}）`;
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: ev.startTime || '', size: 'xs',
            color: '#999999', flex: 2, gravity: 'top' },
          { type: 'text', text: titleText, size: 'sm', wrap: true, flex: 5 },
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
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'text',
          text: title,
          weight: 'bold',
          size: 'md',
          color: '#FFFFFF',
        }],
        backgroundColor: '#BCAAA4',
        paddingAll: 'md',
      },
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
    console.warn('[ai_usage] failed', e?.message);
    return { allowed: true, count: 0, limit: AI_MAX_CALLS_PER_MONTH };
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
    };
    if (!data.title || !data.startDate || !data.endDate) {
      return { error: 'title / startDate / endDate 不能空' };
    }
    const ref = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(ctx.primaryUid).collection('bibi_events').add(data);
    const roles = ctx.uidRoles[ctx.primaryUid] || {};
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
    return { ok: true, _eventId: eventId, _uid: uid, updates: safe };
  },

  async delete_event({ uid, eventId }, ctx) {
    if (!ctx.uids.includes(uid)) return { error: '無權刪除此 uid 的行程' };
    const ref = db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_events').doc(eventId);
    const before = await ref.get();
    if (!before.exists) return { error: '事件不存在' };
    const title = before.data().title;
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
        '新增一筆行程。\n' +
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
      description: '更新已存在的行程。請先用 get_events / search_events 取得 _uid 跟 _eventId。',
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
      description: '刪除一筆行程。請先用 get_events / search_events 確認哪一筆。',
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
async function runAIAgent(input, ctx, maxIterations = 8) {
  const tools = [
    { type: 'web_search' }, // OpenAI 內建工具，可上網拿即時資訊 (天氣/新聞/查資料)
    ...aiCalendarToolDefs(),
  ];
  const toolCalls = [];
  let allInput = [...input];
  for (let i = 0; i < maxIterations; i++) {
    const data = await openaiResponses(allInput, tools);
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
          const fn = aiToolHandlers[item.name];
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

# 四、時間預設（使用者沒明說時直接用，不要追問）
- 早上 = 09:00、中午 = 12:00、下午 = 14:00、傍晚 = 18:00、晚上 = 20:00
- 凌晨 = 02:00、半夜 = 23:00
- 沒講時長 → 預設 1 小時
- 沒講時間 + 沒講全天 → 預設 isAllDay=true (全天)

# 五、果斷原則（最重要）
有「事 + 大概時間」就**直接 create_event**，不要追問細節：
- ✅ 「明天健身房」 → 直接建明天全天「健身房」
- ✅ 「這禮拜天中午甜點店」 → 直接建那天 12:00-13:00「甜點店」
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
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '尚未綁定行事曆。先傳：綁定 <你的裝置 ID>',
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

    const systemPrompt = buildAISystemPrompt(today, dow, uidRoles, primaryUid, senderRole, senderName);

    // 載入對話歷史 (短期記憶)
    const history = await loadAIConversation(sourceId);

    // 組 input：system + history + 這次 user
    const userContent = options.initialUserContent || question;
    const input = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userContent },
    ];

    const result = await runAIAgent(input, { uids, primaryUid, uidRoles });
    finalText = result.text;
    toolCalls = result.toolCalls;

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

  return safeReply(client, ev.replyToken, withQuickReply(
    buildAgendaFlex(range.title, dateGroups, { compact: compactMode, uidRoles })
  ));
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

async function pushToBoundUsers(uid, message, category = 'other') {
  const doc = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_settings').doc('line')
    .get();
  const lineUserIds = (doc.exists ? doc.data().lineUserIds : []) || [];
  await pushToTargets(uid, lineUserIds, message, category);
}

function getHelpText() {
  return [
    '🤖 我聽得懂的指令：',
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
    '🗑️ 刪除',
    '　「刪除 5/20 媽媽生日」',
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
    '',
    `（版本 ${BUILD_VERSION}）`,
  ].join('\n');
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
    const body = JSON.stringify(req.body);
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
          } else if (text === '誰是誰' || text === '誰是誰?' || text === '誰是誰？') {
            await replyIdentityMap(client, ev);
          } else if (text === '幫助' || text === '說明' || text === '指令' ||
                     text.toLowerCase() === 'help') {
            await safeReply(client, ev.replyToken, withQuickReply({
              type: 'text', text: getHelpText(),
            }));
          } else if (text === '下一個' || text === '下個' || text === 'next') {
            await replyNextEvents(client, ev, 1);
          } else if (text === '最近' || text === '即將' || text === '即將到來') {
            await replyNextEvents(client, ev, 5);
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
            await tryCreateExplicit(client, ev, body);
          } else if (text.startsWith('刪除') || text.startsWith('刪 ') || text === '刪') {
            const body = text.replace(/^刪除?[\s　]*/, '').trim();
            await tryDeleteEvent(client, ev, body);
          } else if (await tryRoleFilteredQuery(client, ev, text)) {
            // 已處理角色過濾 (Shane 今天 / 阿花 本週 / 只看共同 等)
          } else if (range) {
            await replyAgenda(client, ev, range);
          } else if (ev.source?.type === 'group' || ev.source?.type === 'room') {
            // 群組／多人聊天室：非指令訊息保持安靜，避免 AI 被亂觸發
          } else if (text.length >= 2 && await hasRecentAIConversation(sourceId)) {
            // 1-on-1 對話追問：5 分鐘內剛跟 AI 對話過 → 沒前綴的話也視為 AI 對話延續
            // 例：使用者「親 這禮拜天中午要去甜點店」→ AI 問細節 → 使用者「不用」
            await replyAskGPT(client, ev, text);
          } else {
            await safeReply(client, ev.replyToken, withQuickReply({
              type: 'text',
              text: getHelpText(),
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
    await pushToBoundUsers(uid, flex, 'event_create');
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
          `用一行 (40 字內) 簡潔告訴我「${today} 台北今天的天氣摘要 + 是否要帶傘」。` +
          `格式：「🌤️ 26-32°C，降雨 30%，帶把折傘剛好」。直接給結論，不要前言。`,
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
        const lines = [`🌙 今日 (${today}) 行程：`];
        eventsSnap.forEach((d) => {
          const e = d.data();
          if (!e.endDate || e.endDate < today) return; // 已結束的略過
          const ownerLabel = computeOwnerLabel(e.eventType, roles);
          lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}（${ownerLabel}）`);
        });

        let message;
        if (lines.length === 1) {
          message = `🌙 今天 (${today}) 沒有排程，好好休息 💤`;
        } else {
          message = lines.join('\n');
        }
        if (weatherBlurb) {
          message = `${weatherBlurb}\n\n${message}`;
        }

        await pushToTargets(uid, lineUserIds, message, 'morning');
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

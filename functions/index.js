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

const APP_ID = 'schdule-f5cda';
const BUILD_VERSION = '2026-05-15-v12-date-query';
const TAIPEI_TZ = 'Asia/Taipei';
const db = () => admin.firestore();

function lineClient() {
  return new line.Client({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value(),
  });
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
    { type: 'action', action: { type: 'message', label: '下週', text: '下週' } },
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

function buildAgendaFlex(title, dateGroups) {
  const todayStr = formatDateTW(new Date());
  const showDateHeader = dateGroups.length > 1;
  const bodyContents = [];

  dateGroups.forEach((g, idx) => {
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
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          {
            type: 'text',
            text: '📌',
            size: 'xs',
            flex: 2,
            gravity: 'top',
          },
          {
            type: 'text',
            text: ev.title || '(未命名)',
            size: 'sm',
            wrap: true,
            flex: 5,
            weight: 'bold',
            color: '#6D4C41',
          },
        ],
      });
    });
    timedEvents.forEach((ev) => {
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          {
            type: 'text',
            text: ev.startTime || '',
            size: 'xs',
            color: '#999999',
            flex: 2,
            gravity: 'top',
          },
          {
            type: 'text',
            text: ev.title || '(未命名)',
            size: 'sm',
            wrap: true,
            flex: 5,
          },
        ],
      });
    });
  });

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

const COLOR_BY_TYPE = { me: 'tea', partner: 'sesame', common: 'latte' };

function buildEventConfirmFlex(ev, ownerLabel) {
  const dateLine = ev.startDate === ev.endDate
    ? ev.startDate
    : `${ev.startDate} ~ ${ev.endDate}`;
  const timeLine = ev.isAllDay ? '全天' : `${ev.startTime} - ${ev.endTime}`;
  return {
    type: 'flex',
    altText: `已新增：${ev.title}`,
    contents: {
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
    },
  };
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
  if (r1 && r1 !== '我' && remaining.includes(r1)) {
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

async function tryCreateNaturalEvent(client, ev, text) {
  // 回傳 true 表示有解析成功並處理了；false 表示不像新增指令，呼叫端繼續走其他分支
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) return false; // 還沒綁定就別誤判

  const todayStr = formatDateTW(new Date());
  const todayDow = getDayOfWeekTaipei(new Date());
  const targetUid = uids[0]; // 多綁時只新增到第一個
  const roles = await getRoleSettings(targetUid);
  const senderRole = await getSenderRoleForUid(targetUid, ev.source?.userId);

  const parsed = parseNaturalEvent(text, roles, todayStr, todayDow);
  if (!parsed) return false;

  // 抓到日期但沒寫事件標題：在 DM 提示用戶補上，群組裡 silent 避免吵
  if (parsed.error === 'no_title') {
    const isGroup = ev.source?.type === 'group' || ev.source?.type === 'room';
    if (isGroup) return false;
    await safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '看起來想新增行程，但抓不到行程名稱 🤔\n例如：「明天10點 開會」、「5/20 全天 媽媽生日」',
    }));
    return true;
  }

  // 用戶沒明確提到角色名稱 → fallback 用寄件人角色
  if (parsed.eventType === 'common' && senderRole) {
    parsed.eventType = senderRole;
    parsed.color = COLOR_BY_TYPE[senderRole] || COLOR_BY_TYPE.common;
  }

  await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(targetUid)
    .collection('bibi_events')
    .add(parsed);

  const ownerLabel = parsed.eventType === 'me' ? (roles.role1 || '我')
    : parsed.eventType === 'partner' ? (roles.role2 || '夥伴')
    : '共同';
  await safeReply(client, ev.replyToken, withQuickReply(
    buildEventConfirmFlex(parsed, ownerLabel)
  ));
  return true;
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

  const dateGroups = [];
  for (let i = 0; i < range.days; i++) {
    const d = new Date(range.start);
    d.setDate(range.start.getDate() + i);
    dateGroups.push({ date: d, dateStr: formatDateTW(d), events: [] });
  }
  const rangeStartStr = dateGroups[0].dateStr;
  const rangeEndStr = dateGroups[dateGroups.length - 1].dateStr;

  for (const uid of uids) {
    const eventsSnap = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_events')
      .where('startDate', '<=', rangeEndStr)
      .get();
    eventsSnap.forEach((doc) => {
      const e = doc.data();
      if (!e.endDate || e.endDate < rangeStartStr) return;
      for (const g of dateGroups) {
        if (g.dateStr >= e.startDate && g.dateStr <= e.endDate) {
          g.events.push(e);
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

  return safeReply(client, ev.replyToken, withQuickReply(buildAgendaFlex(range.title, dateGroups)));
}

async function pushToBoundUsers(uid, message) {
  const doc = await db()
    .collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('bibi_settings').doc('line')
    .get();
  const lineUserIds = (doc.exists ? doc.data().lineUserIds : []) || [];
  if (lineUserIds.length === 0) return;

  const client = lineClient();
  await Promise.allSettled(
    lineUserIds.map((id) => client.pushMessage(id, { type: 'text', text: message }))
  );
}

function getHelpText() {
  return [
    '🤖 我聽得懂的指令：',
    '',
    '🔗 綁定 <裝置 ID>　— 綁定行事曆',
    '🙋 我是 <你的名字>　— 自我介紹，新增行程時自動歸給你',
    '🚫 解除綁定　— 取消綁定',
    '📊 狀態 / 誰是誰　— 查綁定資訊',
    '',
    '📅 查詢行程：',
    '　今日／明天／後天／大後天',
    '　本週／下週／下下週／週末',
    '　直接傳日期也可以：「5/16」「5月20日」「週三」「下週一」',
    '',
    '➕ 直接傳訊息就能新增行程：',
    '　「明天10點看牙醫」',
    '　「後天下午3點半開會」',
    '　「5/20 全天 媽媽生日」',
    '　「5/13到5/15 出差」← 多日',
    '　「今晚 阿花生日趴」← 模糊時段',
    '',
    '時段別名：今晚 20:00 / 明早 07:00 /',
    '　中午 12:00 / 傍晚 18:00',
    '',
    '⚠️ 編輯／刪除請到 App 操作。',
    '',
    `（版本 ${BUILD_VERSION}）`,
  ].join('\n');
}

// -------- Webhook: handle messages received by the bot --------
exports.lineWebhook = onRequest(
  {
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET],
    cors: false,
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
        if (ev.type === 'follow' || ev.type === 'join') {
          await safeReply(client, ev.replyToken, withQuickReply({
            type: 'text',
            text: getWelcomeText(ev.source?.type),
          }));
        } else if (ev.type === 'unfollow' || ev.type === 'leave') {
          await removeBindingsForSource(getSourceId(ev));
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
          } else if (text === '誰是誰' || text === '誰是誰?' || text === '誰是誰？') {
            await replyIdentityMap(client, ev);
          } else if (text.startsWith('我是') && await handleIdentitySet(client, ev, text)) {
            // 已處理「我是 X」自我介紹
          } else if (range) {
            await replyAgenda(client, ev, range);
          } else if (await tryCreateNaturalEvent(client, ev, text)) {
            // 已自動把訊息解析為新增行程
          } else if (ev.source?.type === 'group' || ev.source?.type === 'room') {
            // 群組／多人聊天室：非指令訊息保持安靜，避免干擾其他對話
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
    const ev = event.data.data();
    const uid = event.params.uid;
    await pushToBoundUsers(uid, `📝 新增行程：${formatEvent(ev)}`);
  }
);

exports.notifyOnEventUpdate = onDocumentUpdated(
  {
    document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const uid = event.params.uid;
    const timeChanged =
      before.startDate !== after.startDate ||
      before.endDate !== after.endDate ||
      before.startTime !== after.startTime ||
      before.endTime !== after.endTime ||
      before.isAllDay !== after.isAllDay;
    const titleChanged = before.title !== after.title;
    if (!timeChanged && !titleChanged) return;

    // 時間有變動，要清掉「已提醒」記號才能在新時間重新提醒
    if (timeChanged && after.reminderNotifiedAt) {
      await event.data.after.ref.update({
        reminderNotifiedAt: admin.firestore.FieldValue.delete(),
      });
    }

    await pushToBoundUsers(uid, `✏️ 行程更新：${formatEvent(after)}`);
  }
);

exports.notifyOnEventDelete = onDocumentDeleted(
  {
    document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async (event) => {
    const ev = event.data.data();
    const uid = event.params.uid;
    await pushToBoundUsers(uid, `🗑️ 行程刪除：${ev.title}`);
  }
);

// -------- Scheduled notifications --------
exports.dailyMorningSummary = onSchedule(
  {
    schedule: '0 9 * * *',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    const today = formatDateTW(new Date());
    console.log('[dailyMorningSummary] start', { today, buildVersion: BUILD_VERSION });

    // 不用 where('lineUserIds', '!=', [])：collectionGroup + 陣列 != 查詢
    // 在沒手動建 index 時會丟 FAILED_PRECONDITION 讓 function 500。
    // 直接撈全部 bibi_settings 在程式內過濾，數量小不會有效能問題。
    const snap = await db().collectionGroup('bibi_settings').get();
    console.log('[dailyMorningSummary] bibi_settings docs:', snap.size);

    for (const doc of snap.docs) {
      try {
        if (doc.id !== 'line') continue;
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;
        const lineUserIds = doc.data()?.lineUserIds || [];
        if (lineUserIds.length === 0) continue;

        // 只用 startDate 單欄位 range，endDate 在程式裡過濾，
        // 避免 Firestore 對兩個不同欄位的 range query 要求 composite index。
        const eventsSnap = await db()
          .collection('artifacts').doc(APP_ID)
          .collection('users').doc(uid)
          .collection('bibi_events')
          .where('startDate', '<=', today)
          .get();

        const lines = [`☀️ 早安！今天 (${today}) 的行程：`];
        eventsSnap.forEach((d) => {
          const e = d.data();
          if (!e.endDate || e.endDate < today) return; // 已結束的略過
          lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}`);
        });

        const message =
          lines.length === 1
            ? `☀️ 早安！${today} 今天沒有排程，好好享受 ☕`
            : lines.join('\n');

        const client = lineClient();
        const results = await Promise.allSettled(
          lineUserIds.map((id) => client.pushMessage(id, { type: 'text', text: message }))
        );
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            console.error('[dailyMorningSummary] push failed', {
              uid, to: lineUserIds[i],
              err: r.reason?.originalError?.response?.data || r.reason?.message || r.reason,
            });
          }
        });
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
              `⏰ 即將開始：${ev.title}\n  ${ev.startTime} - ${ev.endTime}`
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
            lines.push(`  • ${e.isAllDay ? '全天' : e.startTime || ''} ${e.title}`);
          });
          lines.push('');
        }
        const message = totalCount === 0
          ? `🌙 下週 (${nextMondayStr} ~ ${nextSundayStr}) 沒有排程，可以好好放鬆 ☕`
          : lines.join('\n').trim();

        const client = lineClient();
        const results = await Promise.allSettled(
          lineUserIds.map((id) => client.pushMessage(id, { type: 'text', text: message }))
        );
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            console.error('[weeklySundayPreview] push failed', {
              uid, to: lineUserIds[i],
              err: r.reason?.originalError?.response?.data || r.reason?.message || r.reason,
            });
          }
        });
      } catch (err) {
        console.error('[weeklySundayPreview] user error', {
          path: settingDoc.ref.path, err: err?.message || err,
        });
      }
    }
    console.log('[weeklySundayPreview] done');
  }
);

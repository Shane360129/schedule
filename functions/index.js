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
const STORAGE_BUCKET = 'schdule-f5cda.firebasestorage.app';
const BUILD_VERSION = '2026-05-21-v20-ai';

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

// -------- OpenAI API helpers --------
async function openaiChat(systemPrompt, userMessage) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY.value()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 800,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI chat ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function openaiImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY.value()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI image ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data?.[0]?.b64_json;
}

// 上傳到 Firebase Storage 並回傳長期可用的下載 URL (含 token，不會過期)
async function uploadGalleryImage(uid, b64Image, prompt) {
  const buffer = Buffer.from(b64Image, 'base64');
  const docRef = db().collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid).collection('bibi_gallery').doc();
  const docId = docRef.id;
  const storagePath = `gallery/${uid}/${docId}.png`;
  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const file = bucket.file(storagePath);
  // firebaseStorageDownloadTokens 是 Firebase 慣例，加了之後可以用 ?token= 公開讀取
  const { randomUUID } = require('crypto');
  const token = randomUUID();
  await file.save(buffer, {
    metadata: {
      contentType: 'image/png',
      metadata: { firebaseStorageDownloadTokens: token },
    },
    resumable: false,
  });
  const downloadUrl =
    `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}` +
    `/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  await docRef.set({
    prompt,
    storagePath,
    downloadUrl,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { docId, downloadUrl };
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

const COLOR_BY_TYPE = { me: 'tea', partner: 'sesame', common: 'latte' };

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

  // 用戶沒明確提到角色名稱 → fallback 用寄件人角色
  if (parsed.eventType === 'common' && senderRole) {
    parsed.eventType = senderRole;
    parsed.color = COLOR_BY_TYPE[senderRole] || COLOR_BY_TYPE.common;
  }

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

  // 圖庫刪除走另一個 collection，先攔截
  if (act === 'del_img') {
    await deleteGalleryImage(client, ev, uid, eventId);
    return;
  }

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

// -------- AI 指令：問答 / 生成圖片 / 圖庫 / 刪除圖片 --------
async function replyAskGPT(client, ev, question) {
  if (!question) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請帶上要問的問題。\n例：「問 今天台北會下雨嗎？」\n　　「問 番茄炒蛋怎麼做」',
    }));
  }
  try {
    const today = formatDateTW(new Date());
    const dow = ['一', '二', '三', '四', '五', '六', '日'][(getDayOfWeekTaipei(new Date()) - 1 + 7) % 7];
    const answer = await openaiChat(
      `你是 BiBi 行事曆裡的 AI 小幫手，講中文（台灣用語）。今天是 ${today} (星期${dow})。\n回答要簡潔、口語、不超過 3 段。可以適度用 emoji。\n如果是行事曆相關的事 (查詢/修改行程)，請提醒使用者使用對應指令而不是直接幫他改。`,
      question,
    );
    const text = (answer || '🤔 想不到耶').slice(0, 4900);
    return safeReply(client, ev.replyToken, withQuickReply({ type: 'text', text }));
  } catch (err) {
    console.error('[ask] failed', err?.message || err);
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `❌ AI 回答失敗，等等再試\n${String(err?.message || '').slice(0, 120)}`,
    }));
  }
}

async function replyGenerateImage(client, ev, prompt) {
  if (!prompt) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '請補上提示詞。\n例：「生成圖片 一隻彈鋼琴的橘貓 水彩風」',
    }));
  }
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: '尚未綁定行事曆，無法存圖庫。先傳：綁定 <你的裝置 ID>',
    }));
  }
  const targetUid = uids[0];
  // 先告知正在繪製，避免使用者乾等 (DALL-E 一般 8-20 秒)
  // 用 reply token 一次只能回一次，所以這裡直接做完一次回，不發中間狀態
  try {
    const b64 = await openaiImage(prompt);
    if (!b64) throw new Error('API 回傳空圖片');
    const { downloadUrl } = await uploadGalleryImage(targetUid, b64, prompt);
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'image',
      originalContentUrl: downloadUrl,
      previewImageUrl: downloadUrl,
    }));
  } catch (err) {
    console.error('[gen_img] failed', err?.message || err);
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text',
      text: `❌ 生圖失敗：${String(err?.message || '').slice(0, 150)}`,
    }));
  }
}

async function replyGallery(client, ev) {
  const sourceId = getSourceId(ev);
  const uids = await getBoundUidsForSource(sourceId);
  if (uids.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '尚未綁定行事曆',
    }));
  }
  const items = [];
  for (const uid of uids) {
    const snap = await db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_gallery')
      .orderBy('createdAt', 'desc').limit(10).get();
    snap.forEach((d) => items.push({ id: d.id, uid, ...d.data() }));
  }
  if (items.length === 0) {
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '📷 圖庫是空的。用「生成圖片 <提示詞>」開始畫圖！',
    }));
  }
  items.sort((a, b) =>
    (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  const top = items.slice(0, 10);
  const bubbles = top.map((item) => ({
    type: 'bubble',
    size: 'kilo',
    hero: {
      type: 'image',
      url: item.downloadUrl,
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'cover',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [{
        type: 'text',
        text: (item.prompt || '').slice(0, 60) || '(無提示詞)',
        size: 'xs',
        wrap: true,
        color: '#5D4037',
      }],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: '🗑️ 刪除',
          data: `act=del_img&uid=${item.uid}&id=${item.id}`,
          displayText: `刪除圖片：${(item.prompt || '').slice(0, 20)}`,
        },
      }],
    },
  }));
  return safeReply(client, ev.replyToken, withQuickReply({
    type: 'flex',
    altText: `📷 圖庫（${top.length} 張）`,
    contents: { type: 'carousel', contents: bubbles },
  }));
}

async function deleteGalleryImage(client, ev, uid, id) {
  try {
    const ref = db().collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid).collection('bibi_gallery').doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return safeReply(client, ev.replyToken, withQuickReply({
        type: 'text', text: '⚠️ 找不到圖片 (可能已刪除)',
      }));
    }
    const data = snap.data();
    try {
      await admin.storage().bucket(STORAGE_BUCKET).file(data.storagePath).delete();
    } catch (e) {
      // Storage 刪不到不擋整個刪除，Firestore 記錄還是清掉
      console.warn('[del_img] storage delete failed', e?.message || e);
    }
    await ref.delete();
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: `🗑️ 已刪除圖片：${(data.prompt || '').slice(0, 30)}`,
    }));
  } catch (err) {
    console.error('[del_img] failed', err?.message || err);
    return safeReply(client, ev.replyToken, withQuickReply({
      type: 'text', text: '❌ 刪除失敗',
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
    '🔗 綁定 / 解除綁定 / 我是 <名字>',
    '📊 狀態 / 誰是誰 / 用量',
    '',
    '📅 查詢行程：',
    '　今日／明天／後天／大後天',
    '　本週／下週／下下週／週末',
    '　整月行程／本月／7月／2026/7',
    '　下一個 / 最近（接下來 5 件）',
    '　直接傳日期：「5/16」「週三」「下週一」',
    '　依角色：「Shane 今天」「阿花 本週」「只看共同 明天」',
    '',
    '🔍 找 / 搜尋 <關鍵字>　— 搜尋事件標題',
    '',
    '➕ 新增（必須以「新增」開頭）：',
    '　「新增 明天10點 看牙醫」',
    '　「新增 5/20 全天 媽媽生日」',
    '　「新增 7/10-7/22 加州旅遊」',
    '',
    '✏️ 編輯：',
    '　「改日期 5/20 媽媽生日 5/21」',
    '　「改時間 5/20 看牙醫 14:30-16:00」',
    '　「改名稱 5/20 媽媽生日 媽媽77大壽」',
    '　(或從事件卡片底部按鈕直接改／刪)',
    '',
    '🗑️ 「刪除 5/20 媽媽生日」',
    '',
    '🤖 AI 助理：',
    '　「問 番茄炒蛋怎麼做」',
    '　「生成圖片 一隻彈鋼琴的橘貓」',
    '　「圖庫」— 翻歷史圖、可刪除',
    '',
    '⏰ 自動通知：每日 00:00 當日行程預覽 + 新增事件 Flex 卡片',
    '',
    `（版本 ${BUILD_VERSION}）`,
  ].join('\n');
}

// -------- Webhook: handle messages received by the bot --------
exports.lineWebhook = onRequest(
  {
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, OPENAI_API_KEY],
    cors: false,
    timeoutSeconds: 60, // DALL-E 生圖可能要 10-20 秒，留多點 buffer
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
          await safeReply(client, ev.replyToken, withQuickReply(
            buildWelcomeFlex(ev.source?.type)
          ));
        } else if (ev.type === 'unfollow' || ev.type === 'leave') {
          await removeBindingsForSource(getSourceId(ev));
        } else if (ev.type === 'postback') {
          await handlePostback(client, ev);
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
          } else if (text === '圖庫' || text === '相簿' || text.toLowerCase() === 'gallery') {
            await replyGallery(client, ev);
          } else if (text.startsWith('生成圖片') || text.startsWith('畫圖') || text.startsWith('畫一張')) {
            const p = text.replace(/^(生成圖片|畫一張|畫圖)[\s　:：]*/, '').trim();
            await replyGenerateImage(client, ev, p);
          } else if (/^(問|AI|ai)[\s　:：]/.test(text) || text === '問' || text.toLowerCase() === 'ai') {
            // 收緊判斷，避免「問題」這種以問開頭的非指令被誤觸
            const q = text.replace(/^(問|AI|ai)[\s　:：]*/, '').trim();
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
            // 群組／多人聊天室：非指令訊息保持安靜
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
exports.dailyMorningSummary = onSchedule(
  {
    schedule: '0 0 * * *',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    if (!NOTIFY_DAILY_SUMMARY) {
      console.log('[dailyMorningSummary] disabled by feature flag');
      return;
    }
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

        const roles = await getRoleSettings(uid);
        const lines = [`🌙 今日 (${today}) 行程：`];
        eventsSnap.forEach((d) => {
          const e = d.data();
          if (!e.endDate || e.endDate < today) return; // 已結束的略過
          const ownerLabel = computeOwnerLabel(e.eventType, roles);
          lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}（${ownerLabel}）`);
        });

        const message =
          lines.length === 1
            ? `🌙 今天 (${today}) 沒有排程，好好休息 💤`
            : lines.join('\n');

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

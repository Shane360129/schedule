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
const db = () => admin.firestore();

function lineClient() {
  return new line.Client({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value(),
  });
}

function formatDateTW(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

function formatDateLabel(d) {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${m}/${day}（${WEEK_DAYS_TW[d.getDay()]}）`;
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
  return { ...message, quickReply: { items: getQuickReplyItems() } };
}

function getRangeFromText(text) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (text === '今日' || text === '今天' || text === '今日行程') {
    return { start: today, days: 1, title: '📅 今日行程' };
  }
  if (text === '明天' || text === '明日' || text === '明日行程') {
    const t = new Date(today);
    t.setDate(today.getDate() + 1);
    return { start: t, days: 1, title: '📅 明日行程' };
  }
  if (text === '本週' || text === '這週' || text === '這禮拜' || text === '本周') {
    return { start: today, days: 7, title: '📅 本週行程（今天起 7 日）' };
  }
  if (text === '下週' || text === '下周' || text === '下禮拜') {
    const t = new Date(today);
    t.setDate(today.getDate() + 7);
    return { start: t, days: 7, title: '📅 下週行程' };
  }
  return null;
}

function buildAgendaFlex(title, dateGroups) {
  const showDateHeader = dateGroups.length > 1;
  const bodyContents = [];

  dateGroups.forEach((g, idx) => {
    if (showDateHeader) {
      bodyContents.push({
        type: 'text',
        text: formatDateLabel(g.date),
        weight: 'bold',
        size: 'sm',
        color: '#555555',
        margin: idx === 0 ? 'none' : 'lg',
      });
      bodyContents.push({ type: 'separator', margin: 'xs', color: '#EEEEEE' });
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
    g.events.forEach((ev) => {
      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          {
            type: 'text',
            text: ev.isAllDay ? '全天' : (ev.startTime || ''),
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

async function replyAgenda(client, ev, range) {
  const sourceId = getSourceId(ev);
  if (!sourceId) {
    return client.replyMessage(ev.replyToken, {
      type: 'text',
      text: '無法辨識來源，請改回個人聊天視窗或重新邀請 Bot。',
    });
  }
  const snap = await db()
    .collectionGroup('bibi_settings')
    .where('lineUserIds', 'array-contains', sourceId)
    .get();
  const uids = new Set();
  snap.forEach((doc) => {
    const uid = doc.ref.parent.parent?.id;
    if (uid) uids.add(uid);
  });
  if (uids.size === 0) {
    return client.replyMessage(ev.replyToken, withQuickReply({
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

  return client.replyMessage(ev.replyToken, withQuickReply(buildAgendaFlex(range.title, dateGroups)));
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
    '🚫 解除綁定　— 取消綁定',
    '📅 今日 / 明天 / 本週 / 下週　— 查詢行程',
    '❓ 幫助　— 顯示這個說明',
    '',
    '提示：可使用下方按鈕快速查詢。',
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
          await client.replyMessage(ev.replyToken, withQuickReply({
            type: 'text',
            text: getWelcomeText(ev.source?.type),
          }));
        } else if (ev.type === 'unfollow' || ev.type === 'leave') {
          await removeBindingsForSource(getSourceId(ev));
        } else if (ev.type === 'message' && ev.message.type === 'text') {
          const sourceId = getSourceId(ev);
          if (!sourceId) {
            await client.replyMessage(ev.replyToken, {
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
            await client.replyMessage(ev.replyToken, withQuickReply({
              type: 'text',
              text: `✅ 綁定成功！\n之後 ${uid.substring(0, 6)}... 這組行事曆有變動或排程提醒都會推到這個聊天視窗。\n\n想取消綁定請傳：解除綁定`,
            }));
          } else if (text === '解除綁定') {
            await removeBindingsForSource(sourceId);
            await client.replyMessage(ev.replyToken, {
              type: 'text',
              text: '已解除所有綁定。要重新綁定請再傳：綁定 <你的裝置 ID>',
            });
          } else if (range) {
            await replyAgenda(client, ev, range);
          } else {
            await client.replyMessage(ev.replyToken, withQuickReply({
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
    if (
      before.title === after.title &&
      before.startDate === after.startDate &&
      before.endDate === after.endDate &&
      before.startTime === after.startTime &&
      before.endTime === after.endTime &&
      before.isAllDay === after.isAllDay
    ) {
      return;
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
    schedule: '0 8 * * *',
    timeZone: 'Asia/Taipei',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    const today = formatDateTW(new Date());

    const snap = await db()
      .collectionGroup('bibi_settings')
      .where('lineUserIds', '!=', [])
      .get();

    for (const doc of snap.docs) {
      if (doc.id !== 'line') continue;
      const uid = doc.ref.parent.parent?.id;
      if (!uid) continue;
      const lineUserIds = doc.data().lineUserIds || [];
      if (lineUserIds.length === 0) continue;

      const eventsSnap = await db()
        .collection('artifacts').doc(APP_ID)
        .collection('users').doc(uid)
        .collection('bibi_events')
        .where('startDate', '<=', today)
        .where('endDate', '>=', today)
        .get();

      const lines = [`☀️ 早安！今天 (${today}) 的行程：`];
      eventsSnap.forEach((d) => {
        const e = d.data();
        lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}`);
      });

      const message =
        lines.length === 1
          ? `☀️ 早安！${today} 今天沒有排程，好好享受 ☕`
          : lines.join('\n');

      const client = lineClient();
      await Promise.allSettled(
        lineUserIds.map((id) => client.pushMessage(id, { type: 'text', text: message }))
      );
    }
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
    const inHalfHour = new Date(now.getTime() + 30 * 60 * 1000);
    const inQuarter = new Date(now.getTime() + 15 * 60 * 1000);
    const today = formatDateTW(now);

    const snap = await db()
      .collectionGroup('bibi_events')
      .where('startDate', '==', today)
      .where('isAllDay', '==', false)
      .get();

    for (const doc of snap.docs) {
      const ev = doc.data();
      if (!ev.startTime) continue;
      const [h, m] = ev.startTime.split(':').map(Number);
      const startTs = new Date(now);
      startTs.setHours(h, m, 0, 0);
      if (startTs >= inQuarter && startTs < inHalfHour) {
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;
        await pushToBoundUsers(
          uid,
          `⏰ 30 分鐘後開始：${ev.title}\n  ${ev.startTime} - ${ev.endTime}`
        );
      }
    }
  }
);

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

async function replyTodayAgenda(client, ev) {
  const lineUserId = ev.source.userId;
  const snap = await db()
    .collectionGroup('bibi_settings')
    .where('lineUserIds', 'array-contains', lineUserId)
    .get();

  const uids = new Set();
  snap.forEach((doc) => {
    const uid = doc.ref.parent.parent?.id;
    if (uid) uids.add(uid);
  });

  if (uids.size === 0) {
    return client.replyMessage(ev.replyToken, {
      type: 'text',
      text: '你還沒綁定任何行事曆。請先傳：綁定 <你的裝置 ID>',
    });
  }

  const today = formatDateTW(new Date());
  const lines = [`📅 ${today} 今日行程`];

  for (const uid of uids) {
    const eventsSnap = await db()
      .collection('artifacts').doc(APP_ID)
      .collection('users').doc(uid)
      .collection('bibi_events')
      .where('startDate', '<=', today)
      .where('endDate', '>=', today)
      .get();
    eventsSnap.forEach((doc) => {
      const e = doc.data();
      lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}`);
    });
  }

  if (lines.length === 1) lines.push('（沒有行程，好好休息 ☕）');

  return client.replyMessage(ev.replyToken, { type: 'text', text: lines.join('\n') });
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
        if (ev.type === 'follow') {
          await client.replyMessage(ev.replyToken, {
            type: 'text',
            text: '哈囉！要把這個 LINE 跟 BiBi 行事曆綁定，請打開行事曆 App → 設定 → LINE 通知，按「複製綁定指令」按鈕，再貼到這裡傳送即可。\n\n或是直接傳給我：\n綁定 <你的裝置 ID>',
          });
        } else if (ev.type === 'message' && ev.message.type === 'text') {
          const text = ev.message.text.trim();
          const m = text.match(/^綁定[\s　]+(\S+)$/);
          if (m) {
            const uid = m[1];
            await db()
              .collection('artifacts').doc(APP_ID)
              .collection('users').doc(uid)
              .collection('bibi_settings').doc('line')
              .set(
                {
                  lineUserIds: admin.firestore.FieldValue.arrayUnion(ev.source.userId),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            await client.replyMessage(ev.replyToken, {
              type: 'text',
              text: `✅ 綁定成功！\n之後 ${uid.substring(0, 6)}... 這組行事曆有變動或排程提醒都會推給你。\n\n想取消綁定請傳：解除綁定`,
            });
          } else if (text === '解除綁定') {
            const snap = await db()
              .collectionGroup('bibi_settings')
              .where('lineUserIds', 'array-contains', ev.source.userId)
              .get();
            const batch = db().batch();
            snap.forEach((doc) =>
              batch.update(doc.ref, {
                lineUserIds: admin.firestore.FieldValue.arrayRemove(ev.source.userId),
              })
            );
            await batch.commit();
            await client.replyMessage(ev.replyToken, {
              type: 'text',
              text: '已解除所有綁定。要重新綁定請再傳：綁定 <你的裝置 ID>',
            });
          } else if (text === '今日行程' || text === '今天') {
            await replyTodayAgenda(client, ev);
          } else {
            await client.replyMessage(ev.replyToken, {
              type: 'text',
              text: '我聽得懂的指令：\n• 綁定 <你的裝置 ID>\n• 解除綁定\n• 今日行程',
            });
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

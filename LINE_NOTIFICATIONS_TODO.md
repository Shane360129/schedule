# LINE 通知整合 — Claude Code 執行清單

> 這份文件記載了「Firebase Functions + LINE Messaging API」的完整實作計畫。
>
> **使用方式**：
> 1. 人類先做好 §0 的「手動準備」（取得 LINE Token、開啟 Firebase Blaze 方案）。
> 2. 把這份文件交給桌面版 Claude Code（一句話「請依照 LINE_NOTIFICATIONS_TODO.md 執行」即可）。
> 3. Claude Code 會依序執行 §1 ~ §6 的步驟，遇到需要人類動作時會停下來等你。

---

## 目錄

- [0. 人類手動準備（必須先做完）](#0-人類手動準備必須先做完)
- [1. 環境準備](#1-環境準備)
- [2. Webhook 與帳號綁定](#2-webhook-與帳號綁定)
- [3. 即時通知：事件新增/修改/刪除](#3-即時通知事件新增修改刪除)
- [4. 排程通知：每日早晨摘要 + 開始前提醒](#4-排程通知每日早晨摘要--開始前提醒)
- [5. 前端整合：在設定畫面加綁定 UI](#5-前端整合在設定畫面加綁定-ui)
- [6. 驗證與部署清單](#6-驗證與部署清單)
- [附錄 A：Firestore 資料結構](#附錄-afirestore-資料結構)
- [附錄 B：費用估算](#附錄-b費用估算)
- [附錄 C：除錯指南](#附錄-c除錯指南)

---

## 0. 人類手動準備（必須先做完）

> ⚠️ Claude Code 沒辦法幫你點網頁、刷信用卡，這些只能你自己做。

### 0.1 申請 LINE Messaging API Bot

1. 進入 https://developers.line.biz/console/
2. 用 LINE 帳號登入
3. 建立一個 **Provider**（例如：「BiBi」）
4. 在該 Provider 下建立一個 **Messaging API channel**：
   - Channel name：`BiBi Schedule Bot`
   - Channel description：行事曆通知
   - Category / Subcategory：自選
   - Email：自填
5. 建立完成後到 channel 設定頁：
   - **Basic settings** 分頁 → 找到 **Channel secret**，複製下來
   - **Messaging API** 分頁 → 拉到底，按 **Issue** 取得 **Channel access token (long-lived)**，複製下來
   - **Messaging API** 分頁 → **Auto-reply messages** 改為「Disabled」（不要用內建自動回覆）
   - **Messaging API** 分頁 → **Greeting messages** 也建議停用（用我們自己的歡迎詞）

把這兩個值先存著（等下要設成 Firebase Secret）：
```
LINE_CHANNEL_SECRET = <貼上 Channel secret>
LINE_CHANNEL_ACCESS_TOKEN = <貼上 Channel access token>
```

### 0.2 加 Bot 為好友

在 **Messaging API** 分頁找 **Bot basic ID** 或 QR Code，用你跟伴侶的 LINE 都掃碼加 Bot 為好友。沒加好友的話 Bot 不能 push 給你。

### 0.3 升級 Firebase 到 Blaze 方案

1. 進入 https://console.firebase.google.com/project/schdule-f5cda/usage/details
2. 點 **Modify plan** → 選 **Blaze (Pay as you go)**
3. 綁定信用卡（要求需要，但 free tier 通常用不完）
4. 建議設定 **預算警報**：左側 ⚙️ → Usage and billing → Details & settings → Budgets & alerts → 設個每月 $1 USD 警報

> 為何要 Blaze？Functions 要對外打 LINE API，免費的 Spark 方案禁止 outbound HTTPS。
> Free tier 含：每月 200 萬次 invocations、400,000 GB-seconds，你們兩人用一輩子也用不完。

### 0.4 完成的標記

做完以上請打個勾：
- [ ] 拿到 Channel secret 與 Channel access token
- [ ] 你跟伴侶都加 Bot 好友了
- [ ] Firebase 已升級到 Blaze

確認都打勾後再讓 Claude Code 接手。

---

## 1. 環境準備

> 從這裡開始 Claude Code 接手。

### 1.1 安裝 Firebase CLI

```bash
npm install -g firebase-tools
firebase --version  # 應該 ≥ 13
```

### 1.2 登入 Firebase

```bash
firebase login
```

會打開瀏覽器，登入 Firebase 用的 Google 帳號（要是 `schdule-f5cda` 專案的擁有者）。

### 1.3 在 repo 根目錄初始化 Functions

```bash
cd /path/to/schedule
firebase init functions
```

互動選項：
- **Use an existing project** → 選 `schdule-f5cda`
- **Language**: JavaScript（簡單；要 TypeScript 也可以但這份清單以 JS 範例）
- **ESLint?** No
- **Install dependencies now?** Yes

完成後會多出：
```
functions/
├── .gitignore
├── index.js
├── node_modules/
├── package.json
└── package-lock.json
firebase.json
.firebaserc
```

### 1.4 安裝必要套件

```bash
cd functions
npm install firebase-admin firebase-functions @line/bot-sdk
npm install --save-dev firebase-functions-test
cd ..
```

### 1.5 在 .gitignore 加入

確認根目錄 `.gitignore` 含有：
```
functions/node_modules
functions/.env*
.firebase/
```

### 1.6 設定 Secrets（LINE Token）

```bash
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
# 貼上 §0.1 拿到的 Channel access token，Enter

firebase functions:secrets:set LINE_CHANNEL_SECRET
# 貼上 §0.1 拿到的 Channel secret，Enter
```

可以驗證：
```bash
firebase functions:secrets:access LINE_CHANNEL_ACCESS_TOKEN
```

---

## 2. Webhook 與帳號綁定

### 2.1 寫 functions/index.js

把 `functions/index.js` 整個換成下面內容：

```js
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
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

// -------- Webhook：處理 Bot 收到的訊息 --------
exports.lineWebhook = onRequest({
  secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET],
  cors: false,
}, async (req, res) => {
  // 簽章驗證
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
        // 新加好友 → 發歡迎訊息與綁定教學
        await client.replyMessage(ev.replyToken, {
          type: 'text',
          text: '哈囉！要把這個 LINE 跟 BiBi 行事曆綁定，請打開行事曆 App → 設定 → LINE 通知，貼上你的「裝置 ID」並按綁定。\n\n或是直接傳給我：\n綁定 <你的裝置 ID>',
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
            .set({
              lineUserIds: admin.firestore.FieldValue.arrayUnion(ev.source.userId),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          await client.replyMessage(ev.replyToken, {
            type: 'text',
            text: `✅ 綁定成功！\n之後 ${uid.substring(0, 6)}... 這組行事曆有變動或排程提醒都會推給你。\n\n想取消綁定請傳：解除綁定`,
          });
        } else if (text === '解除綁定') {
          // 找出所有有這 lineUserId 的 settings 並移除
          const snap = await db()
            .collectionGroup('bibi_settings')
            .where('lineUserIds', 'array-contains', ev.source.userId)
            .get();
          const batch = db().batch();
          snap.forEach(doc => batch.update(doc.ref, {
            lineUserIds: admin.firestore.FieldValue.arrayRemove(ev.source.userId),
          }));
          await batch.commit();
          await client.replyMessage(ev.replyToken, {
            type: 'text',
            text: '已解除所有綁定。要重新綁定請再傳：綁定 <你的裝置 ID>',
          });
        } else if (text === '今日行程' || text === '今天') {
          // 查所有綁定的 UID，撈今日事件
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
});

async function replyTodayAgenda(client, ev) {
  const lineUserId = ev.source.userId;
  // 找所有綁這個 lineUserId 的 UID
  const snap = await db()
    .collectionGroup('bibi_settings')
    .where('lineUserIds', 'array-contains', lineUserId)
    .get();

  const uids = new Set();
  snap.forEach(doc => {
    // doc.ref.parent.parent.id 是 user uid
    const uid = doc.ref.parent.parent?.id;
    if (uid) uids.add(uid);
  });

  if (uids.size === 0) {
    return client.replyMessage(ev.replyToken, { type: 'text', text: '你還沒綁定任何行事曆。請先傳：綁定 <你的裝置 ID>' });
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
    eventsSnap.forEach(doc => {
      const e = doc.data();
      lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}`);
    });
  }

  if (lines.length === 1) lines.push('（沒有行程，好好休息 ☕）');

  return client.replyMessage(ev.replyToken, { type: 'text', text: lines.join('\n') });
}

function formatDateTW(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports.formatDateTW = formatDateTW;
module.exports.APP_ID = APP_ID;
module.exports.db = db;
module.exports.lineClient = lineClient;
```

### 2.2 部署 Webhook

```bash
firebase deploy --only functions:lineWebhook
```

部署完成後，會看到類似：
```
Function URL (lineWebhook(asia-east1)): https://linewebhook-xxxx.asia-east1.run.app
```

複製這個 URL。

### 2.3 把 URL 設回 LINE Bot

1. 回到 https://developers.line.biz/console/
2. 你的 channel → **Messaging API** 分頁
3. **Webhook URL** 貼上剛剛的 URL
4. **Use webhook** 切 ON
5. 按 **Verify** 應該回 Success

### 2.4 測試綁定

1. 在 BiBi App 設定畫面複製「裝置識別碼 (ID)」（例如 `abc123xyz...`）
2. 打開 LINE 你的 Bot，傳：`綁定 abc123xyz...`
3. 應該收到「✅ 綁定成功！」

驗證 Firestore：
```
artifacts/schdule-f5cda/users/<你的UID>/bibi_settings/line
  ↳ lineUserIds: ["Uxxxxx你的LINE..."]
```

---

## 3. 即時通知：事件新增/修改/刪除

在 `functions/index.js` 後面追加：

```js
// -------- 即時通知：事件 CRUD --------
exports.notifyOnEventCreate = onDocumentCreated({
  document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
}, async (event) => {
  const ev = event.data.data();
  const uid = event.params.uid;
  await pushToBoundUsers(uid, `📝 新增行程：${formatEvent(ev)}`);
});

exports.notifyOnEventUpdate = onDocumentUpdated({
  document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
}, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const uid = event.params.uid;
  // 只在重要欄位改變時通知，避免 spam
  if (
    before.title === after.title &&
    before.startDate === after.startDate &&
    before.endDate === after.endDate &&
    before.startTime === after.startTime &&
    before.endTime === after.endTime &&
    before.isAllDay === after.isAllDay
  ) return;
  await pushToBoundUsers(uid, `✏️ 行程更新：${formatEvent(after)}`);
});

exports.notifyOnEventDelete = onDocumentDeleted({
  document: `artifacts/${APP_ID}/users/{uid}/bibi_events/{eventId}`,
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
}, async (event) => {
  const ev = event.data.data();
  const uid = event.params.uid;
  await pushToBoundUsers(uid, `🗑️ 行程刪除：${ev.title}`);
});

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
    lineUserIds.map(id => client.pushMessage(id, { type: 'text', text: message }))
  );
}

function formatEvent(ev) {
  const time = ev.isAllDay
    ? `${ev.startDate}${ev.startDate !== ev.endDate ? ` ~ ${ev.endDate}` : ''}（全天）`
    : `${ev.startDate} ${ev.startTime}-${ev.endTime}`;
  return `${ev.title}\n  ${time}`;
}
```

部署：
```bash
firebase deploy --only functions:notifyOnEventCreate,functions:notifyOnEventUpdate,functions:notifyOnEventDelete
```

### 3.1 測試

1. 在 BiBi App 新增一筆事件
2. 你的 LINE 應該幾秒內收到「📝 新增行程：...」
3. 改一下標題或時間 → 收到「✏️ 行程更新」
4. 刪除 → 收到「🗑️ 行程刪除」

> 注意：v2 Firestore trigger 第一次部署可能需要 1-2 分鐘 propagate。

---

## 4. 排程通知：每日早晨摘要 + 開始前提醒

繼續在 `functions/index.js` 追加：

```js
// -------- 排程通知 --------
exports.dailyMorningSummary = onSchedule({
  schedule: '0 8 * * *',
  timeZone: 'Asia/Taipei',
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
}, async () => {
  const today = formatDateTW(new Date());

  // 列出所有有 LINE 綁定的 user
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
    eventsSnap.forEach(d => {
      const e = d.data();
      lines.push(`• ${e.isAllDay ? '全天' : (e.startTime || '')} ${e.title}`);
    });

    const message = lines.length === 1
      ? `☀️ 早安！${today} 今天沒有排程，好好享受 ☕`
      : lines.join('\n');

    const client = lineClient();
    await Promise.allSettled(
      lineUserIds.map(id => client.pushMessage(id, { type: 'text', text: message }))
    );
  }
});

// 每 15 分鐘掃一次，找 15-30 分鐘後要開始的事件
exports.preEventReminder = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'Asia/Taipei',
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
}, async () => {
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
    // 落在 15 ~ 30 分鐘之間
    if (startTs >= inQuarter && startTs < inHalfHour) {
      const uid = doc.ref.parent.parent?.id;
      if (!uid) continue;
      await pushToBoundUsers(uid, `⏰ 30 分鐘後開始：${ev.title}\n  ${ev.startTime} - ${ev.endTime}`);
    }
  }
});
```

部署：
```bash
firebase deploy --only functions:dailyMorningSummary,functions:preEventReminder
```

### 4.1 測試

立即手動觸發測試（不必等到早上 8 點）：
```bash
gcloud scheduler jobs run firebase-schedule-dailyMorningSummary-asia-east1 --location=asia-east1
```
或在 Google Cloud Console → Cloud Scheduler 找到該 job 按「Run now」。

---

## 5. 前端整合：在設定畫面加綁定 UI

> 這部分修改 `src/App.jsx`，讓使用者可以直接複製「綁定指令」傳到 LINE。

### 5.1 找到設定 Modal 內 ID Sync Section（約 line 818）

在 ID Sync Section 之後（`<hr>` 之前）插入新的 section：

```jsx
<hr style={{ borderColor: theme.colors.border }} />

{/* LINE 通知綁定 */}
<div className="space-y-2">
  <label className="text-xs font-bold uppercase flex items-center gap-1" style={{ color: theme.colors.secondaryText }}>
    💬 LINE 通知
  </label>
  <p className="text-[11px] leading-snug" style={{ color: theme.colors.secondaryText }}>
    1. 加 Bot 好友（QR Code 在 README）<br/>
    2. 點下方按鈕複製綁定指令<br/>
    3. 在 LINE 對 Bot 貼上並送出
  </p>
  <button
    onClick={() => {
      const cmd = `綁定 ${customUserId || user?.uid || ''}`;
      navigator.clipboard.writeText(cmd).then(
        () => addToast('已複製，貼到 LINE Bot 對話即可 ✨'),
        () => addToast('複製失敗', 'error')
      );
    }}
    className="w-full py-2 text-xs font-bold rounded-lg active:scale-95 transition-transform"
    style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
  >
    複製「綁定」指令
  </button>
</div>
```

### 5.2 build 並 push

```bash
npm run build
git add -A
git commit -m "feat(ui): 設定畫面新增 LINE 通知綁定按鈕"
git push origin main
```

GitHub Actions 會自動部署。

---

## 6. 驗證與部署清單

完成所有步驟後跑一次完整流程：

- [ ] LINE Bot 加好友 → 收到歡迎訊息
- [ ] 在 App 設定畫面複製綁定指令 → 貼到 LINE → 收到「✅ 綁定成功」
- [ ] Firestore 確認 `artifacts/schdule-f5cda/users/{uid}/bibi_settings/line.lineUserIds` 有你的 LINE userId
- [ ] 新增一筆事件 → LINE 收到「📝 新增行程」
- [ ] 修改該事件標題 → LINE 收到「✏️ 行程更新」
- [ ] 刪除該事件 → LINE 收到「🗑️ 行程刪除」
- [ ] LINE 對 Bot 傳「今日行程」→ 收到當日清單
- [ ] 排程：手動觸發 `dailyMorningSummary` → 收到早晨摘要
- [ ] 排程：建立一個 25 分鐘後開始的事件，等下個 15 分鐘整觸發 → 收到「⏰ 30 分鐘後開始」

### 部署 Cheatsheet

```bash
# 全部 functions 重新部署
firebase deploy --only functions

# 看 logs
firebase functions:log --only lineWebhook
firebase functions:log --only notifyOnEventCreate

# 刪除某個 function
firebase functions:delete preEventReminder --region=asia-east1
```

---

## 附錄 A：Firestore 資料結構

通知系統用到的新文件：

```
artifacts/schdule-f5cda/users/{uid}/bibi_settings/line
  {
    lineUserIds: ["Uxxxxx...", "Uyyyyy..."],
    updatedAt: <Timestamp>
  }
```

不影響既有的 `roles` 與 `bibi_events`。

---

## 附錄 B：費用估算

兩人使用、每天平均 5 則事件異動，估算：

| 項目 | 月用量 | Free tier | 額外費用 |
|---|---|---|---|
| Functions invocations | ~500 | 2,000,000 | $0 |
| Functions compute (GB-s) | ~50 | 400,000 | $0 |
| Firestore 讀取 | ~5,000 | 1,500,000/月不限 | $0 |
| LINE Push messages | ~300 | 200 / 月 | 超過 100 則：通常 ~$0.4 USD 起 |
| Cloud Scheduler jobs | 2 | 3 / 月 | $0 |
| Outbound HTTPS | ~10MB | 5GB | $0 |

→ 預期月費 **0 - 0.5 USD**。

> ⚠️ LINE 免費方案推送上限是每月 200 則。如果你們事件很多，會收到 LINE 的提醒。可降低通知頻率，或升級 LINE Light/Standard 方案。

---

## 附錄 C：除錯指南

### Webhook Verify 失敗
- 看 `firebase functions:log --only lineWebhook` 抓 stack
- 常見：簽章驗證失敗 → 確認 `LINE_CHANNEL_SECRET` 對應到 channel 對的

### 部署 onDocumentCreated 報錯
- 確認專案用的是 Native mode Firestore（不是 Datastore mode）
- 確認 region 與 Firestore region 相容（這份用 `asia-east1`，與 Firestore default 一致）

### Push 沒收到
- 用 https://developers.line.biz/console/ → channel → Statistics 看 Push API 是否被呼叫
- 看 `firebase functions:log` 是否有 4xx
- 401: token 失效 → 重新 issue 並 `firebase functions:secrets:set` 一次
- 400: lineUserId 格式錯誤 → 確認 Firestore 裡的 lineUserIds 是 `U` 開頭

### 排程沒跑
- Google Cloud Console → Cloud Scheduler，查 job state 是否 enabled
- 看執行歷史，若失敗會有 stack trace

### Local 測試 webhook
```bash
firebase emulators:start --only functions
# 用 ngrok 把 localhost:5001 暴露給 LINE，把 ngrok URL 設成暫時 webhook
```

---

## 完成後可以做的延伸

- ⚡ **配對驗證**：只在「綁定我的 UID 跟伴侶的 UID」都完成後，才允許共享（搭配 Firestore Security Rules）
- 📅 **LIFF**：把 App 包進 LINE，從 LINE 內開啟可直接拿 LINE userId 自動綁定，免複製貼上
- 🔕 **通知偏好**：讓使用者選哪些事件類型（我/伴侶/共同）要通知、靜音時段等
- 📊 **每週統計**：每週日晚上推一份「下週行程預覽」

---

**結束。如果中途卡住，把錯誤訊息貼給 Claude Code 即可，這份文件涵蓋的內容它都看得懂。**

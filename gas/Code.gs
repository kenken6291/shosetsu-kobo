/**
 * 小説工房 Code.gs v1.0.0
 * GitHub Pages から text/plain の POST(JSON) を受けるAPI。
 *
 * スクリプトプロパティ:
 *   GEMINI_API_KEY        必須
 *   GEMINI_TEXT_MODEL     任意（既定: gemini-2.5-flash）
 *   GEMINI_TTS_MODEL      任意（既定: gemini-2.5-flash-preview-tts）
 *   SPREADSHEET_ID        任意（スプレッドシートに紐づけていない場合）
 *   DRIVE_ROOT_FOLDER_ID  任意（未設定なら setup() で自動作成）
 *   PEPPER                setup() で自動作成
 *   DAILY_GEN_LIMIT       任意（1人あたりのAI呼び出し上限・6時間ごと。既定300）
 *   DEV_SHOW_TEMP_PASSWORD 任意（'true' で仮パスワードを画面にも返す。テスト時のみ）
 *
 * ※ コードを変えたら「デプロイを管理 → 編集 → 新バージョン」で再デプロイすること。
 */

const APP = { NAME: '小説工房', VERSION: '1.0.0' };
const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const SESSION_TTL = 21600;               // 6時間（CacheService上限）
const LOCK_MINUTES = 15;
const MAX_FAILS = 5;
const SHEET_USERS = 'Users';
const SHEET_NOVELS = 'Novels';
const USER_HEADERS = ['userId', 'email', 'username', 'passHash', 'salt', 'status', 'failCount', 'lockedUntil', 'createdAt', 'updatedAt', 'lastLoginAt'];
const NOVEL_HEADERS = ['novelId', 'userId', 'title', 'folderId', 'folderUrl', 'chapterCount', 'charCount', 'settings', 'createdAt', 'updatedAt'];

/* ================= 入口 ================= */
function doGet() {
  return json_({ ok: true, app: APP.NAME, version: APP.VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません', code: 'BAD_REQUEST' });
  }
  const routes = {
    ping: () => ({ app: APP.NAME, version: APP.VERSION }),
    register: register_,
    login: login_,
    logout: logout_,
    me: me_,
    changePassword: changePassword_,
    resetPassword: resetPassword_,
    generate: generate_,
    tts: tts_,
    saveNovel: saveNovel_,
    listNovels: listNovels_,
    loadNovel: loadNovel_,
    deleteNovel: deleteNovel_
  };
  const fn = routes[req.action];
  if (!fn) return json_({ ok: false, error: '不明な操作です: ' + req.action, code: 'BAD_ACTION' });
  try {
    return json_(Object.assign({ ok: true }, fn(req)));
  } catch (err) {
    console.error(req.action, err && err.stack ? err.stack : err);
    return json_({ ok: false, error: (err && err.message) || String(err), code: (err && err.code) || 'ERROR' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg, code) {
  const e = new Error(msg);
  e.code = code || 'ERROR';
  throw e;
}

/* ================= 初期設定（最初に1回手動実行） ================= */
function setup() {
  sheet_(SHEET_USERS, USER_HEADERS);
  sheet_(SHEET_NOVELS, NOVEL_HEADERS);
  pepper_();
  const root = rootFolder_();
  Logger.log('準備完了。保存先フォルダ: ' + root.getUrl());
  if (!prop_('GEMINI_API_KEY', '')) Logger.log('※ スクリプトプロパティ GEMINI_API_KEY を設定してください');
}

/* ================= 共通 ================= */
function prop_(k, d) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  return (v === null || v === '') ? d : v;
}

function pepper_() {
  let p = prop_('PEPPER', '');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    PropertiesService.getScriptProperties().setProperty('PEPPER', p);
  }
  return p;
}

function ss_() {
  const id = prop_('SPREADSHEET_ID', '');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) fail_('スプレッドシートが見つかりません。SPREADSHEET_ID を設定してください', 'CONFIG');
  return ss;
}

function sheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@'); // 日付などの自動変換を防ぐ
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(sh) {
  const v = sh.getDataRange().getValues();
  const h = v.shift() || [];
  return v.map((r, i) => {
    const o = { _row: i + 2 };
    h.forEach((k, j) => { o[k] = r[j]; });
    return o;
  });
}

function writeRow_(sh, headers, rowNum, obj) {
  const vals = headers.map(h => cell_(obj[h]));
  sh.getRange(rowNum, 1, 1, headers.length).setNumberFormat('@').setValues([vals]);
}

function appendRow_(sh, headers, obj) {
  writeRow_(sh, headers, sh.getLastRow() + 1, obj);
}

// 数式インジェクション対策
function cell_(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function now_() { return new Date().toISOString(); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ================= パスワード ================= */
function hash_(pw, salt) {
  const pepper = pepper_();
  let h = salt + ':' + pw + ':' + pepper;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + pepper, Utilities.Charset.UTF_8));
  }
  return h;
}

function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  for (let i = 0; i < 10; i++) s += chars[(bytes[i] + 256) % chars.length];
  return s + String((bytes[12] + 256) % 10); // 数字を必ず含める
}

function validPassword_(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

function normEmail_(e) {
  const s = String(e || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 254) fail_('メールアドレスの形式が正しくありません', 'VALIDATION');
  return s;
}

function findUserByEmail_(email) {
  const sh = sheet_(SHEET_USERS, USER_HEADERS);
  return rows_(sh).find(r => String(r.email).toLowerCase() === email) || null;
}

function findUserById_(id) {
  const sh = sheet_(SHEET_USERS, USER_HEADERS);
  return rows_(sh).find(r => r.userId === id) || null;
}

function saveUser_(u) {
  const sh = sheet_(SHEET_USERS, USER_HEADERS);
  writeRow_(sh, USER_HEADERS, u._row, u);
}

function publicUser_(u) {
  return { userId: u.userId, email: u.email, username: u.username, status: u.status };
}

function sendMail_(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: '【' + APP.NAME + '】' + subject, body: body, name: APP.NAME });
}

function devShow_() { return prop_('DEV_SHOW_TEMP_PASSWORD', '') === 'true'; }

/* ================= 会員 ================= */
function register_(req) {
  const email = normEmail_(req.email);
  const username = String(req.username || '').trim();
  if (!username || username.length > 30) fail_('ユーザー名は1〜30文字で入力してください', 'VALIDATION');

  return withLock_(() => {
    if (findUserByEmail_(email)) {
      fail_('このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワード再発行」をご利用ください', 'EXISTS');
    }
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    const t = now_();
    const sh = sheet_(SHEET_USERS, USER_HEADERS);
    appendRow_(sh, USER_HEADERS, {
      userId: Utilities.getUuid(), email: email, username: username,
      passHash: hash_(temp, salt), salt: salt, status: 'FIRST_LOGIN',
      failCount: 0, lockedUntil: '', createdAt: t, updatedAt: t, lastLoginAt: ''
    });
    sendMail_(email, '仮パスワードのお知らせ',
      username + ' さん\n\n' + APP.NAME + ' への登録ありがとうございます。\n\n仮パスワード：' + temp +
      '\n\nこの仮パスワードでログインすると、本パスワードの設定画面が表示されます。\n心当たりがない場合は、このメールを破棄してください。');
    const res = { message: '仮パスワードをメールで送りました。メールに書かれた仮パスワードでログインしてください。' };
    if (devShow_()) res.tempPassword = temp;
    return res;
  });
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  const ng = 'メールアドレスまたはパスワードが違います';

  return withLock_(() => {
    const u = findUserByEmail_(email);
    if (!u) fail_(ng, 'AUTH_FAILED');
    if (u.status === 'SUSPENDED') fail_('このアカウントは利用停止中です', 'SUSPENDED');
    const lockedUntil = Number(u.lockedUntil || 0);
    if (lockedUntil > Date.now()) {
      const min = Math.ceil((lockedUntil - Date.now()) / 60000);
      fail_('ログインに続けて失敗したため、あと' + min + '分ほどお待ちください', 'LOCKED');
    }
    if (hash_(pw, u.salt) !== u.passHash) {
      u.failCount = Number(u.failCount || 0) + 1;
      if (u.failCount >= MAX_FAILS) {
        u.lockedUntil = String(Date.now() + LOCK_MINUTES * 60000);
        u.failCount = 0;
      }
      u.updatedAt = now_();
      saveUser_(u);
      fail_(ng, 'AUTH_FAILED');
    }
    u.failCount = 0;
    u.lockedUntil = '';
    u.lastLoginAt = now_();
    saveUser_(u);

    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ userId: u.userId }), SESSION_TTL);
    return { token: token, user: publicUser_(u) };
  });
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('sess_' + req.token);
  return {};
}

// セッション確認。allowFirst=true ならパスワード未変更でも通す
function session_(req, allowFirst) {
  const token = String(req.token || '');
  if (!token) fail_('ログインしてください', 'AUTH');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) fail_('ログインの有効期限が切れました', 'AUTH');
  const s = JSON.parse(raw);
  cache.put('sess_' + token, raw, SESSION_TTL); // 使うたびに延長
  const u = findUserById_(s.userId);
  if (!u || u.status === 'SUSPENDED') fail_('ログインしてください', 'AUTH');
  if (u.status === 'FIRST_LOGIN' && !allowFirst) fail_('本パスワードの設定が必要です', 'PW_CHANGE_REQUIRED');
  return u;
}

function me_(req) {
  const u = session_(req, true);
  return { user: publicUser_(u) };
}

function changePassword_(req) {
  const u0 = session_(req, true);
  const cur = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (!validPassword_(next)) fail_('新しいパスワードは8文字以上で、英字と数字を両方含めてください', 'VALIDATION');
  if (cur === next) fail_('今と同じパスワードは使えません', 'VALIDATION');

  return withLock_(() => {
    const u = findUserById_(u0.userId);
    if (hash_(cur, u.salt) !== u.passHash) fail_('現在のパスワードが違います', 'AUTH_FAILED');
    u.salt = Utilities.getUuid();
    u.passHash = hash_(next, u.salt);
    u.status = 'ACTIVE';
    u.updatedAt = now_();
    saveUser_(u);
    return { user: publicUser_(u) };
  });
}

function resetPassword_(req) {
  const email = normEmail_(req.email);
  const res = { message: '登録されているメールアドレスであれば、新しい仮パスワードを送りました。メールをご確認ください。' };

  // 同じアドレスへの連続送信を抑止（2分）
  const cache = CacheService.getScriptCache();
  const key = 'reset_' + Utilities.base64EncodeWebSafe(email);
  if (cache.get(key)) fail_('少し時間をおいてから、もう一度お試しください', 'RATE_LIMIT');
  cache.put(key, '1', 120);

  return withLock_(() => {
    const u = findUserByEmail_(email);
    if (!u || u.status === 'SUSPENDED') return res; // 登録の有無は明かさない
    const temp = tempPassword_();
    u.salt = Utilities.getUuid();
    u.passHash = hash_(temp, u.salt);
    u.status = 'FIRST_LOGIN';
    u.failCount = 0;
    u.lockedUntil = '';
    u.updatedAt = now_();
    saveUser_(u);
    sendMail_(email, '仮パスワードの再発行',
      u.username + ' さん\n\n仮パスワードを再発行しました。\n\n仮パスワード：' + temp +
      '\n\nログイン後、本パスワードを設定してください。\n心当たりがない場合は、このメールを破棄してください（以前のパスワードは使えなくなっています。上の仮パスワードでログインして再設定してください）。');
    if (devShow_()) res.tempPassword = temp;
    return res;
  });
}

/* ================= 利用回数制限 ================= */
function countUsage_(userId) {
  const limit = Number(prop_('DAILY_GEN_LIMIT', '300'));
  const cache = CacheService.getScriptCache();
  const key = 'use_' + userId;
  const n = Number(cache.get(key) || 0) + 1;
  if (n > limit) fail_('AIの利用回数の上限に達しました。しばらく時間をおいてからお試しください', 'RATE_LIMIT');
  cache.put(key, String(n), SESSION_TTL);
}

/* ================= Gemini（文章） ================= */
function generate_(req) {
  const u = session_(req, false);
  const prompt = String(req.prompt || '');
  if (!prompt) fail_('指示が空です', 'VALIDATION');
  if (prompt.length > 200000) fail_('指示が長すぎます', 'VALIDATION');
  countUsage_(u.userId);
  return callGemini_({
    system: req.system ? String(req.system) : '',
    prompt: prompt,
    json: !!req.json,
    maxTokens: Math.min(32768, Math.max(256, Number(req.maxTokens) || 8192)),
    temperature: Math.min(2, Math.max(0, Number(req.temperature) || 0.9))
  });
}

function callGemini_(o) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) fail_('サーバーにGemini APIキーが設定されていません', 'CONFIG');
  const model = prop_('GEMINI_TEXT_MODEL', DEFAULT_TEXT_MODEL);
  const body = {
    contents: [{ role: 'user', parts: [{ text: o.prompt }] }],
    generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
    ]
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  if (o.json) body.generationConfig.responseMimeType = 'application/json';

  const data = fetchGemini_(model, body, key);
  const cand = (data.candidates || [])[0];
  if (!cand) {
    const reason = data.promptFeedback && data.promptFeedback.blockReason;
    fail_(reason ? 'AIが内容を理由に生成を止めました（' + reason + '）。設定や題材を少し変えてお試しください' : 'AIから応答がありませんでした', 'GEMINI');
  }
  const text = ((cand.content && cand.content.parts) || [])
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text).join('');
  if (!text && cand.finishReason === 'SAFETY') fail_('AIが内容を理由に生成を止めました。設定や題材を少し変えてお試しください', 'GEMINI');
  return { text: text, finishReason: cand.finishReason || '' };
}

function fetchGemini_(model, body, key) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  let last = '';
  for (let i = 0; i < 3; i++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    last = code + ' ' + res.getContentText().slice(0, 300);
    if (code === 429 || code >= 500) { Utilities.sleep(2000 * (i + 1)); continue; }
    break;
  }
  console.error('Gemini error', last);
  if (/^429/.test(last)) fail_('AIが混み合っています。少し待ってからお試しください', 'GEMINI_BUSY');
  fail_('AIの呼び出しに失敗しました（' + last.slice(0, 120) + '）', 'GEMINI');
}

/* ================= Gemini TTS（朗読） ================= */
function tts_(req) {
  const u = session_(req, false);
  const text = String(req.text || '').trim();
  if (!text) fail_('読み上げる文章が空です', 'VALIDATION');
  if (text.length > 2000) fail_('1回に読み上げられるのは2000字までです', 'VALIDATION');
  countUsage_(u.userId);

  const key = prop_('GEMINI_API_KEY', '');
  if (!key) fail_('サーバーにGemini APIキーが設定されていません', 'CONFIG');
  const model = prop_('GEMINI_TTS_MODEL', DEFAULT_TTS_MODEL);
  const voice = /^[A-Za-z]{2,20}$/.test(String(req.voice || '')) ? req.voice : 'Charon';
  const style = String(req.stylePrompt || '').slice(0, 300);

  const body = {
    contents: [{ role: 'user', parts: [{ text: (style ? style + '\n\n' : '') + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const data = fetchGemini_(model, body, key);
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const audio = parts.find(p => p.inlineData && p.inlineData.data);
  if (!audio) fail_('音声を作れませんでした', 'GEMINI');

  const mime = audio.inlineData.mimeType || '';
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1] || 24000);
  const pcm = Utilities.base64Decode(audio.inlineData.data);
  const wav = pcmToWav_(pcm, rate, 1, 16);

  let fileUrl = '';
  if (req.novelId) {
    const rec = ownNovel_(u, String(req.novelId));
    const folder = DriveApp.getFolderById(rec.folderId);
    const audioFolder = subFolder_(folder, 'audio');
    const name = String(req.fileName || 'audio.wav').replace(/[^\w.\-]/g, '_').slice(0, 60);
    const old = audioFolder.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);
    fileUrl = audioFolder.createFile(Utilities.newBlob(wav, 'audio/wav', name)).getUrl();
  }
  return { audioBase64: Utilities.base64Encode(wav), mimeType: 'audio/wav', fileUrl: fileUrl };
}

// 16bit PCM(リトルエンディアン) に WAV ヘッダーを付ける
function pcmToWav_(pcm, sampleRate, channels, bits) {
  const len = pcm.length;
  const h = [];
  const str = s => { for (let i = 0; i < s.length; i++) h.push(s.charCodeAt(i)); };
  const u32 = n => { h.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255); };
  const u16 = n => { h.push(n & 255, (n >>> 8) & 255); };
  str('RIFF'); u32(36 + len); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(channels); u32(sampleRate);
  u32(sampleRate * channels * bits / 8); u16(channels * bits / 8); u16(bits);
  str('data'); u32(len);
  const header = h.map(b => (b > 127 ? b - 256 : b)); // GASのバイトは符号付き
  return header.concat(pcm);
}

/* ================= ドライブ・作品データ ================= */
function rootFolder_() {
  const id = prop_('DRIVE_ROOT_FOLDER_ID', '');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 消えていたら作り直す */ }
  }
  const f = DriveApp.createFolder(APP.NAME + '_作品');
  PropertiesService.getScriptProperties().setProperty('DRIVE_ROOT_FOLDER_ID', f.getId());
  return f;
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function upsertFile_(folder, name, content, mime) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    const f = it.next();
    f.setContent(content);
    return f;
  }
  return folder.createFile(name, content, mime);
}

function safeName_(s) {
  return String(s || '無題').replace(/[\\\/:*?"<>|]/g, '_').trim().slice(0, 40) || '無題';
}

function ownNovel_(u, novelId) {
  const sh = sheet_(SHEET_NOVELS, NOVEL_HEADERS);
  const rec = rows_(sh).find(r => r.novelId === novelId);
  if (!rec) fail_('作品が見つかりません', 'NOT_FOUND');
  if (rec.userId !== u.userId) fail_('この作品を操作する権限がありません', 'FORBIDDEN');
  return rec;
}

function saveNovel_(req) {
  const u = session_(req, false);
  const n = req.novel || {};
  const ex = req.exports || {};
  const title = String(n.title || '無題').slice(0, 60);
  const stateJson = JSON.stringify(n);
  if (stateJson.length > 8 * 1024 * 1024) fail_('作品データが大きすぎます', 'VALIDATION');

  const chapters = Array.isArray(n.chapters) ? n.chapters : [];
  const written = chapters.filter(c => c && c.text);
  const charCount = written.reduce((a, c) => a + String(c.text).length, 0);
  const t = now_();

  return withLock_(() => {
    const sh = sheet_(SHEET_NOVELS, NOVEL_HEADERS);
    let rec = n.novelId ? rows_(sh).find(r => r.novelId === n.novelId) : null;
    if (rec && rec.userId !== u.userId) fail_('この作品を保存する権限がありません', 'FORBIDDEN');

    const novelId = rec ? rec.novelId : Utilities.getUuid();
    let folder = null;
    if (rec && rec.folderId) {
      try { folder = DriveApp.getFolderById(rec.folderId); if (folder.isTrashed()) folder = null; } catch (e) { folder = null; }
    }
    if (!folder) folder = subFolder_(rootFolder_(), safeName_(title) + '_' + novelId.slice(0, 8));

    n.novelId = novelId;
    upsertFile_(folder, 'state.json', JSON.stringify(n), 'application/json');
    if (ex.text) upsertFile_(folder, 'novel.txt', String(ex.text), MimeType.PLAIN_TEXT);
    if (ex.markdown) upsertFile_(folder, 'novel.md', String(ex.markdown), 'text/markdown');
    if (ex.plotJson) upsertFile_(folder, 'plot.json', String(ex.plotJson), 'application/json');
    if (ex.earthJson) upsertFile_(folder, 'earth_studio.json', String(ex.earthJson), 'application/json');
    if (ex.kml) upsertFile_(folder, 'earth_studio.kml', String(ex.kml), 'application/vnd.google-earth.kml+xml');
    if (folder.getName().indexOf(safeName_(title)) !== 0) folder.setName(safeName_(title) + '_' + novelId.slice(0, 8));

    const s = n.settings || {};
    const row = {
      novelId: novelId, userId: u.userId, title: title,
      folderId: folder.getId(), folderUrl: folder.getUrl(),
      chapterCount: written.length, charCount: charCount,
      settings: [s.style, s.era, s.tone, s.focus].filter(Boolean).join('/'),
      createdAt: rec ? rec.createdAt : t, updatedAt: t
    };
    if (rec) writeRow_(sh, NOVEL_HEADERS, rec._row, row);
    else appendRow_(sh, NOVEL_HEADERS, row);
    return { novelId: novelId, folderUrl: folder.getUrl() };
  });
}

function listNovels_(req) {
  const u = session_(req, false);
  const sh = sheet_(SHEET_NOVELS, NOVEL_HEADERS);
  const list = rows_(sh)
    .filter(r => r.userId === u.userId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 100)
    .map(r => ({
      novelId: r.novelId, title: r.title, folderUrl: r.folderUrl,
      chapterCount: Number(r.chapterCount || 0), charCount: Number(r.charCount || 0),
      updatedAt: r.updatedAt
    }));
  return { novels: list };
}

function loadNovel_(req) {
  const u = session_(req, false);
  const rec = ownNovel_(u, String(req.novelId || ''));
  let folder;
  try { folder = DriveApp.getFolderById(rec.folderId); } catch (e) { fail_('保存先フォルダが見つかりません', 'NOT_FOUND'); }
  const it = folder.getFilesByName('state.json');
  if (!it.hasNext()) fail_('作品データ（state.json）が見つかりません', 'NOT_FOUND');
  const novel = JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
  novel.novelId = rec.novelId;
  return { novel: novel };
}

function deleteNovel_(req) {
  const u = session_(req, false);
  return withLock_(() => {
    const rec = ownNovel_(u, String(req.novelId || ''));
    try { DriveApp.getFolderById(rec.folderId).setTrashed(true); } catch (e) { /* 既に無い */ }
    sheet_(SHEET_NOVELS, NOVEL_HEADERS).deleteRow(rec._row);
    return {};
  });
}

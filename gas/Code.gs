/**
 * 今日は何をしよう — GAS バックエンド（Code.gs）
 * GitHub Pages のフロントから Content-Type: text/plain の POST で呼ぶ JSON API。
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   GEMINI_API_KEY      : Gemini APIキー（必須）
 *   PEPPER              : パスワードハッシュ用ペッパー（setup() が自動作成）
 *   DRIVE_FOLDER_ID     : 写真保存フォルダID（setup() が自動作成）
 *   SPREADSHEET_ID      : 任意。スタンドアロンGASの場合のみ指定
 *   SHOW_TEMP_PASSWORD  : 任意。'true' で新規登録時に仮パスワードを画面にも表示（テスト用）
 *
 * ※コードを変更したら「デプロイを管理 → 編集 → バージョン：新バージョン」で再デプロイが必要です。
 */

const API_VERSION = 'v1.0.0';
const SESSION_TTL_SEC = 21600;   // 6時間（CacheService の上限）。利用するたびに延長
const MAX_LOGIN_FAIL = 5;
const LOCK_MINUTES = 15;
const HASH_ROUNDS = 300;
const MODES = ['roulette', 'amida', 'trump', 'omikuji'];
const OUTCOMES = ['followed', 'rebel', 'skipped'];

const SHEET = {
  USERS: 'Users',
  SETS: 'ChoiceSets',
  DRAWS: 'Draws',
  DIARIES: 'Diaries',
  EARTH: 'EarthVideos',
  SETTINGS: 'Settings'
};

const HEADERS = {
  Users: ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'failCount', 'lockedUntil', 'status', 'createdAt', 'lastLoginAt'],
  ChoiceSets: ['setId', 'userId', 'name', 'itemsJson', 'updatedAt'],
  Draws: ['drawId', 'userId', 'mode', 'itemsJson', 'result', 'fortune', 'isOutdoor', 'outcome', 'createdAt'],
  Diaries: ['diaryId', 'userId', 'date', 'title', 'did', 'feeling', 'emotionScore', 'nextWant', 'rawText', 'drawId', 'drawResult', 'outcome', 'photoIdsJson', 'aiComment', 'createdAt', 'updatedAt'],
  EarthVideos: ['keyword', 'driveFileId', 'title', 'note'],
  Settings: ['key', 'value', 'note']
};

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ============================== ルーティング ============================== */

const PUBLIC_ACTIONS = {
  ping: apiPing_,
  register: apiRegister_,
  login: apiLogin_,
  resetPassword: apiResetPassword_
};

const PRIVATE_ACTIONS = {
  me: apiMe_,
  logout: apiLogout_,
  changePassword: apiChangePassword_,
  listSets: apiListSets_,
  saveSet: apiSaveSet_,
  deleteSet: apiDeleteSet_,
  aiChoices: apiAiChoices_,
  saveDraw: apiSaveDraw_,
  setDrawOutcome: apiSetDrawOutcome_,
  listDraws: apiListDraws_,
  structureDiary: apiStructureDiary_,
  saveDiary: apiSaveDiary_,
  listDiaries: apiListDiaries_,
  deleteDiary: apiDeleteDiary_,
  uploadPhoto: apiUploadPhoto_,
  getPhoto: apiGetPhoto_,
  tts: apiTts_,
  analyze: apiAnalyze_
};

// 仮パスワードのままでも呼べる操作
const ALLOWED_WHEN_MUST_CHANGE = { me: true, logout: true, changePassword: true };

function doGet() {
  return json_({ ok: true, app: 'kyou-nani-shiyou', version: API_VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'BAD_REQUEST', message: 'リクエストの形式が正しくありません' });
  }
  try {
    const action = String(req.action || '');
    let result;
    if (PUBLIC_ACTIONS[action]) {
      result = PUBLIC_ACTIONS[action](req);
    } else if (PRIVATE_ACTIONS[action]) {
      const user = auth_(req.token);
      if (isTrue_(user.mustChange) && !ALLOWED_WHEN_MUST_CHANGE[action]) {
        throw new AppError('MUST_CHANGE', '先に仮パスワードを本パスワードに変更してください');
      }
      result = PRIVATE_ACTIONS[action](req, user);
    } else {
      throw new AppError('UNKNOWN_ACTION', '不明な操作です: ' + action);
    }
    return json_(Object.assign({ ok: true }, result || {}));
  } catch (err) {
    if (!(err instanceof AppError)) console.error(err && err.stack ? err.stack : err);
    return json_({
      ok: false,
      code: err.code || 'SERVER_ERROR',
      message: err instanceof AppError ? err.message : 'サーバーでエラーが発生しました：' + (err && err.message ? err.message : err)
    });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================== 初期セットアップ ============================== */

/** 最初に一度だけエディタから実行してください（権限の承認も兼ねます） */
function setup() {
  const ss = ss_();
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });

  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('DRIVE_FOLDER_ID')) {
    const folder = DriveApp.createFolder('今日は何をしよう_写真');
    p.setProperty('DRIVE_FOLDER_ID', folder.getId());
  }

  const st = ss.getSheetByName(SHEET.SETTINGS);
  if (st.getLastRow() === 1) {
    st.getRange(2, 1, 4, 3).setValues([
      ['GEMINI_MODEL', 'gemini-2.5-flash', 'テキスト生成に使うモデル名（新しいモデルが出たらここを書き換え）'],
      ['GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts', '読み上げ（TTS）モデル名'],
      ['TTS_VOICE', 'Kore', '読み上げの声（Kore / Puck / Aoede など）'],
      ['OUTDOOR_KEYWORDS', '散歩,おでかけ,お出かけ,外出,公園,海,山,川,湖,旅,ドライブ,サイクリング,自転車,カフェ,喫茶,神社,寺,温泉,ハイキング,キャンプ,買い物,街歩き,美術館,博物館,動物園,水族館,展望,花見,紅葉,ランチ,商店街,駅', '外出系と判定するキーワード（カンマ区切り）']
    ]);
  }

  const ev = ss.getSheetByName(SHEET.EARTH);
  if (ev.getLastRow() === 1) {
    ev.getRange(2, 1, 2, 4).setValues([
      ['散歩', '', '近所の散歩（例）', 'Earth Studioで書き出したmp4のDriveファイルIDかURLを入れる'],
      ['*', '', 'おでかけ共通（例）', 'キーワード「*」は外出系すべての既定動画']
    ]);
  }

  // 権限承認用（メール・外部通信）
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  CacheService.getScriptCache().removeAll(['set_GEMINI_MODEL', 'set_GEMINI_TTS_MODEL', 'set_TTS_VOICE', 'set_OUTDOOR_KEYWORDS']);
  Logger.log('セットアップ完了。DRIVE_FOLDER_ID=' + p.getProperty('DRIVE_FOLDER_ID'));
}

/* ============================== 共通ユーティリティ ============================== */

function prop_(key, def) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? def : v;
}

function ss_() {
  const id = prop_('SPREADSHEET_ID', '');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new AppError('NOT_SETUP', 'シート「' + name + '」がありません。GASエディタで setup() を実行してください');
  return sh;
}

function tz_() { return Session.getScriptTimeZone() || 'Asia/Tokyo'; }
function nowIso_() { return new Date().toISOString(); }
function todayStr_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function shortId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 14); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function str_(v, max) {
  let s = (v === null || v === undefined) ? '' : String(v).trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function parseJson_(s, def) {
  try { return s ? JSON.parse(s) : def; } catch (e) { return def; }
}

/** 数式として解釈されないようにする */
function cell_(v) {
  if (typeof v === 'string' && /^[=+@]/.test(v)) return "'" + v;
  return v;
}

function normalize_(key, v) {
  if (v instanceof Date) {
    return key === 'date' ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd') : v.toISOString();
  }
  return v;
}

function table_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const header = values.shift() || HEADERS[name];
  const rows = values.map(function (r, i) {
    const o = { _row: i + 2 };
    header.forEach(function (k, j) { o[k] = normalize_(k, r[j]); });
    return o;
  });
  return { sh: sh, header: header, rows: rows };
}

function append_(name, obj) {
  sheet_(name).appendRow(HEADERS[name].map(function (k) {
    return cell_(obj[k] === undefined || obj[k] === null ? '' : obj[k]);
  }));
}

function update_(name, row, patch) {
  const sh = sheet_(name);
  const h = HEADERS[name];
  const range = sh.getRange(row, 1, 1, h.length);
  const cur = range.getValues()[0];
  const next = h.map(function (k, i) {
    return Object.prototype.hasOwnProperty.call(patch, k) ? cell_(patch[k] === null ? '' : patch[k]) : cur[i];
  });
  range.setValues([next]);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function setting_(key, def) {
  const cache = CacheService.getScriptCache();
  const ck = 'set_' + key;
  const hit = cache.get(ck);
  if (hit !== null) return hit;
  let val = def;
  try {
    const r = table_(SHEET.SETTINGS).rows.filter(function (x) { return x.key === key; })[0];
    if (r && String(r.value) !== '') val = String(r.value);
  } catch (e) { /* 既定値を使う */ }
  cache.put(ck, val, 600);
  return val;
}

/* ============================== 認証 ============================== */

function hash_(password, salt) {
  const pepper = prop_('PEPPER', '');
  let d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password + '|' + pepper, Utilities.Charset.UTF_8);
  for (let i = 0; i < HASH_ROUNDS; i++) {
    d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d);
  }
  return Utilities.base64Encode(d);
}

function genTempPassword_() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now() + Math.random());
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[(bytes[i] + 128) % chars.length];
  return s.slice(0, 8) + String((bytes[20] + 128) % 10) + String((bytes[21] + 128) % 10);
}

function validatePassword_(pw) {
  if (pw.length < 8 || pw.length > 64) throw new AppError('WEAK_PASSWORD', 'パスワードは8〜64文字にしてください');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new AppError('WEAK_PASSWORD', 'パスワードには英字と数字を両方入れてください');
}

function validEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function findUserByEmail_(email) {
  return table_(SHEET.USERS).rows.filter(function (r) { return String(r.email).toLowerCase() === email; })[0] || null;
}

function findUserById_(id) {
  return table_(SHEET.USERS).rows.filter(function (r) { return r.userId === id; })[0] || null;
}

function publicUser_(u) {
  return { userId: u.userId, email: u.email, nickname: u.nickname, mustChange: isTrue_(u.mustChange) };
}

function createSession_(userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  CacheService.getScriptCache().put('s_' + token, userId, SESSION_TTL_SEC);
  return token;
}

function auth_(token) {
  token = str_(token, 100);
  if (!token) throw new AppError('SESSION_EXPIRED', 'ログインしてください');
  const cache = CacheService.getScriptCache();
  const uid = cache.get('s_' + token);
  if (!uid) throw new AppError('SESSION_EXPIRED', 'ログインの有効期限が切れました。もう一度ログインしてください');
  const u = findUserById_(uid);
  if (!u || u.status === 'suspended') {
    cache.remove('s_' + token);
    throw new AppError('SESSION_EXPIRED', 'このアカウントは利用できません');
  }
  cache.put('s_' + token, uid, SESSION_TTL_SEC);
  u._token = token;
  return u;
}

function sendTempMail_(email, nickname, temp, kind) {
  const isReset = kind === 'reset';
  const body = [
    (nickname || '') + ' さん',
    '',
    isReset ? '「今日は何をしよう」の仮パスワードを再発行しました。' : '「今日は何をしよう」へのご登録ありがとうございます。',
    '',
    '仮パスワード： ' + temp,
    '',
    'ログインすると本パスワードの設定画面が開きます。',
    '心当たりのない場合は、このメールを破棄してください。'
  ].join('\n');
  try {
    MailApp.sendEmail({ to: email, subject: '【今日は何をしよう】仮パスワードのお知らせ', body: body, name: '今日は何をしよう' });
    return true;
  } catch (e) {
    console.error('メール送信失敗: ' + e);
    return false;
  }
}

function apiPing_() {
  return { version: API_VERSION, time: nowIso_() };
}

function apiRegister_(req) {
  const email = str_(req.email, 200).toLowerCase();
  const nickname = str_(req.nickname, 20);
  if (!validEmail_(email)) throw new AppError('INVALID', 'メールアドレスの形式を確認してください');
  if (!nickname) throw new AppError('INVALID', 'ニックネームを入力してください');

  return withLock_(function () {
    if (findUserByEmail_(email)) {
      throw new AppError('EXISTS', 'このメールアドレスは登録済みです。「パスワードを忘れた」から仮パスワードを再発行できます');
    }
    const temp = genTempPassword_();
    const salt = Utilities.getUuid();
    append_(SHEET.USERS, {
      userId: 'u_' + shortId_(), email: email, nickname: nickname,
      passwordHash: hash_(temp, salt), salt: salt, mustChange: true,
      failCount: 0, lockedUntil: '', status: 'active', createdAt: nowIso_(), lastLoginAt: ''
    });
    const mailed = sendTempMail_(email, nickname, temp, 'register');
    const res = {
      message: mailed
        ? '仮パスワードをメールで送りました。メールを確認してログインしてください。'
        : 'メールを送れませんでした。時間をおいて「パスワードを忘れた」から再発行してください。'
    };
    if (prop_('SHOW_TEMP_PASSWORD', 'false') === 'true') res.tempPassword = temp;
    return res;
  });
}

function apiLogin_(req) {
  const email = str_(req.email, 200).toLowerCase();
  const pw = str_(req.password, 100);
  const u = findUserByEmail_(email);
  if (!u || u.status === 'suspended') throw new AppError('LOGIN_FAILED', 'メールアドレスかパスワードが違います');

  if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
    throw new AppError('LOCKED', 'ログインに続けて失敗したため、' +
      Utilities.formatDate(new Date(u.lockedUntil), tz_(), 'HH:mm') + ' までログインできません');
  }

  if (hash_(pw, String(u.salt)) !== String(u.passwordHash)) {
    const fails = Number(u.failCount || 0) + 1;
    const patch = { failCount: fails };
    if (fails >= MAX_LOGIN_FAIL) {
      patch.failCount = 0;
      patch.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
    }
    withLock_(function () { update_(SHEET.USERS, u._row, patch); });
    if (patch.lockedUntil) {
      throw new AppError('LOCKED', MAX_LOGIN_FAIL + '回続けて失敗したため、' + LOCK_MINUTES + '分間ログインできません');
    }
    throw new AppError('LOGIN_FAILED', 'メールアドレスかパスワードが違います（あと' + (MAX_LOGIN_FAIL - fails) + '回失敗するとロックされます）');
  }

  withLock_(function () { update_(SHEET.USERS, u._row, { failCount: 0, lockedUntil: '', lastLoginAt: nowIso_() }); });
  return { token: createSession_(u.userId), user: publicUser_(u) };
}

function apiResetPassword_(req) {
  const email = str_(req.email, 200).toLowerCase();
  if (!validEmail_(email)) throw new AppError('INVALID', 'メールアドレスの形式を確認してください');
  withLock_(function () {
    const u = findUserByEmail_(email);
    if (!u || u.status === 'suspended') return;
    const temp = genTempPassword_();
    const salt = Utilities.getUuid();
    update_(SHEET.USERS, u._row, {
      passwordHash: hash_(temp, salt), salt: salt, mustChange: true, failCount: 0, lockedUntil: ''
    });
    sendTempMail_(email, u.nickname, temp, 'reset');
  });
  // 登録有無が分からないよう、常に同じ文面を返す
  return { message: '登録済みのメールアドレスであれば、新しい仮パスワードを送りました。' };
}

function apiMe_(req, user) {
  return { user: publicUser_(user), version: API_VERSION };
}

function apiLogout_(req, user) {
  CacheService.getScriptCache().remove('s_' + user._token);
  return {};
}

function apiChangePassword_(req, user) {
  const current = str_(req.currentPassword, 100);
  const next = str_(req.newPassword, 100);
  if (hash_(current, String(user.salt)) !== String(user.passwordHash)) {
    throw new AppError('WRONG_PASSWORD', '現在のパスワード（仮パスワード）が違います');
  }
  validatePassword_(next);
  if (next === current) throw new AppError('WEAK_PASSWORD', '今と違うパスワードにしてください');
  const salt = Utilities.getUuid();
  withLock_(function () {
    update_(SHEET.USERS, user._row, { passwordHash: hash_(next, salt), salt: salt, mustChange: false });
  });
  user.mustChange = false;
  return { message: 'パスワードを変更しました', user: publicUser_(user) };
}

/* ============================== 選択肢セット ============================== */

function cleanItems_(items) {
  if (!Array.isArray(items)) return [];
  return items.map(function (x) { return str_(x, 60); }).filter(Boolean).slice(0, 40);
}

function apiListSets_(req, user) {
  const sets = table_(SHEET.SETS).rows
    .filter(function (r) { return r.userId === user.userId; })
    .map(function (r) { return { setId: r.setId, name: r.name, items: parseJson_(r.itemsJson, []), updatedAt: r.updatedAt }; });
  return { sets: sets };
}

function apiSaveSet_(req, user) {
  const name = str_(req.name, 30) || 'マイセット';
  const items = cleanItems_(req.items);
  if (items.length < 2) throw new AppError('INVALID', '選択肢は2個以上必要です');
  return withLock_(function () {
    const rows = table_(SHEET.SETS).rows;
    const ex = rows.filter(function (r) {
      return r.userId === user.userId && (req.setId ? r.setId === req.setId : r.name === name);
    })[0];
    if (ex) {
      update_(SHEET.SETS, ex._row, { name: name, itemsJson: JSON.stringify(items), updatedAt: nowIso_() });
      return { setId: ex.setId, message: '「' + name + '」を上書き保存しました' };
    }
    const id = 's_' + shortId_();
    append_(SHEET.SETS, { setId: id, userId: user.userId, name: name, itemsJson: JSON.stringify(items), updatedAt: nowIso_() });
    return { setId: id, message: '「' + name + '」を保存しました' };
  });
}

function apiDeleteSet_(req, user) {
  return withLock_(function () {
    const ex = table_(SHEET.SETS).rows.filter(function (r) { return r.userId === user.userId && r.setId === req.setId; })[0];
    if (!ex) throw new AppError('NOT_FOUND', 'セットが見つかりません');
    sheet_(SHEET.SETS).deleteRow(ex._row);
    return {};
  });
}

/* ============================== Gemini ============================== */

function geminiRaw_(model, body) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw new AppError('NO_API_KEY', 'GEMINI_API_KEY がスクリプトプロパティに設定されていません');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error('Gemini error ' + code + ': ' + res.getContentText().slice(0, 500));
    throw new AppError('AI_FAILED', code === 429
      ? 'AIの利用上限に達しました。少し時間をおいて試してください'
      : 'AIの呼び出しに失敗しました（' + code + '）。モデル名とAPIキーを確認してください');
  }
  return JSON.parse(res.getContentText());
}

function geminiJson_(prompt, temperature) {
  const model = setting_('GEMINI_MODEL', 'gemini-2.5-flash');
  const data = geminiRaw_(model, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: temperature === undefined ? 0.9 : temperature, responseMimeType: 'application/json' }
  });
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map(function (p) { return p.text || ''; }).join('').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* 下で失敗 */ } }
    throw new AppError('AI_FAILED', 'AIの返答を読み取れませんでした。もう一度試してください');
  }
}

function apiAiChoices_(req, user) {
  const theme = str_(req.theme, 60) || 'おまかせ';
  const note = str_(req.note, 200);
  const count = Math.max(2, Math.min(20, Number(req.count) || 8));
  const prompt = [
    'あなたは「今日は何をしよう」というアプリの企画担当です。',
    'ユーザーが今日やることをくじ引きで決めるための選択肢を' + count + '個考えてください。',
    'テーマ: ' + theme,
    note ? '追加の希望: ' + note : '',
    '条件:',
    '- 1項目は全角20文字以内。読んですぐ行動に移せる具体的な内容',
    '- ありきたりすぎず、ちょっと遊び心のあるものを混ぜる',
    '- 項目どうしが重ならない',
    '- 危険なこと・違法なこと・高額な出費は含めない',
    '出力はJSONのみ: {"items":["...","..."]}'
  ].filter(Boolean).join('\n');
  const out = geminiJson_(prompt, 1.0);
  const items = cleanItems_(out.items).slice(0, count);
  if (items.length < 2) throw new AppError('AI_FAILED', 'AIの提案を受け取れませんでした。もう一度試してください');
  return { items: items };
}

/* ============================== 抽選結果・Earth Studio ============================== */

function driveId_(v) {
  v = str_(v, 300);
  if (!v) return '';
  const m = v.match(/\/d\/([\w-]{20,})/) || v.match(/[?&]id=([\w-]{20,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(v) ? v : '';
}

function earthInfo_(text) {
  const keywords = setting_('OUTDOOR_KEYWORDS', '散歩,おでかけ,外出,公園,海,山,旅')
    .split(/[,、\s]+/).filter(Boolean);
  let isOutdoor = keywords.some(function (k) { return text.indexOf(k) >= 0; });
  let video = null;
  try {
    const rows = table_(SHEET.EARTH).rows.filter(function (r) { return driveId_(r.driveFileId); });
    let best = null;
    rows.forEach(function (r) {
      const k = str_(r.keyword);
      if (k && k !== '*' && text.indexOf(k) >= 0 && (!best || k.length > str_(best.keyword).length)) best = r;
    });
    if (best) isOutdoor = true;
    if (!best && isOutdoor) best = rows.filter(function (r) { return str_(r.keyword) === '*'; })[0] || null;
    if (best) {
      const id = driveId_(best.driveFileId);
      video = {
        fileId: id,
        title: str_(best.title),
        videoUrl: 'https://drive.google.com/uc?export=download&id=' + id,
        previewUrl: 'https://drive.google.com/file/d/' + id + '/preview'
      };
    }
  } catch (e) { /* 動画なしで続行 */ }
  return {
    isOutdoor: isOutdoor,
    video: video,
    earthUrl: isOutdoor ? 'https://earth.google.com/web/search/' + encodeURIComponent(text) : ''
  };
}

function apiSaveDraw_(req, user) {
  const mode = MODES.indexOf(req.mode) >= 0 ? req.mode : 'roulette';
  const result = str_(req.result, 60);
  if (!result) throw new AppError('INVALID', '抽選結果がありません');
  const earth = earthInfo_(result);
  const drawId = 'd_' + shortId_();
  withLock_(function () {
    append_(SHEET.DRAWS, {
      drawId: drawId, userId: user.userId, mode: mode,
      itemsJson: JSON.stringify(cleanItems_(req.items)), result: result,
      fortune: str_(req.fortune, 10), isOutdoor: earth.isOutdoor, outcome: '', createdAt: nowIso_()
    });
  });
  return { drawId: drawId, earth: earth };
}

function apiSetDrawOutcome_(req, user) {
  const outcome = OUTCOMES.indexOf(req.outcome) >= 0 ? req.outcome : '';
  return withLock_(function () {
    const d = table_(SHEET.DRAWS).rows.filter(function (r) { return r.userId === user.userId && r.drawId === req.drawId; })[0];
    if (!d) throw new AppError('NOT_FOUND', '抽選記録が見つかりません');
    update_(SHEET.DRAWS, d._row, { outcome: outcome });
    return {};
  });
}

function apiListDraws_(req, user) {
  const limit = Math.max(1, Math.min(100, Number(req.limit) || 20));
  const draws = table_(SHEET.DRAWS).rows
    .filter(function (r) { return r.userId === user.userId; })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
    .slice(0, limit)
    .map(function (r) {
      return { drawId: r.drawId, mode: r.mode, result: r.result, fortune: r.fortune, isOutdoor: isTrue_(r.isOutdoor), outcome: r.outcome, createdAt: r.createdAt };
    });
  return { draws: draws };
}

/* ============================== 日記 ============================== */

function apiStructureDiary_(req, user) {
  const text = str_(req.text, 4000);
  if (!text) throw new AppError('INVALID', '清書するメモがありません');
  const drawResult = str_(req.drawResult, 60);
  const prompt = [
    'ユーザーが今日のことをラフに話した音声メモを、本人の日記として清書してください。',
    drawResult ? '参考：今日はくじ引きで「' + drawResult + '」をやることに決まっていました。' : '',
    'ルール:',
    '- 話されていない出来事は作らない。言い間違いや繰り返しは自然に整える',
    '- 一人称の、やわらかい日記の文体',
    '- emotionScore は話しぶりから判断した気分。1=しんどい 2=いまいち 3=ふつう 4=よかった 5=最高 の整数',
    '- 話の中に該当がなければ nextWant は空文字',
    '出力はJSONのみ:',
    '{"title":"20字以内","did":"実際にやったこと（200字以内）","feeling":"感想（200字以内）","emotionScore":3,"nextWant":"次回やりたいこと（60字以内）","aiComment":"本人への前向きな一言（60字以内、親しみやすく）"}',
    '',
    '音声メモ:',
    text
  ].filter(Boolean).join('\n');
  const o = geminiJson_(prompt, 0.6);
  const score = Math.round(Number(o.emotionScore));
  return {
    diary: {
      title: str_(o.title, 60),
      did: str_(o.did, 2000),
      feeling: str_(o.feeling, 2000),
      emotionScore: score >= 1 && score <= 5 ? score : 3,
      nextWant: str_(o.nextWant, 500),
      aiComment: str_(o.aiComment, 300)
    }
  };
}

function diaryOut_(r) {
  return {
    diaryId: r.diaryId, date: r.date, title: r.title, did: r.did, feeling: r.feeling,
    emotionScore: r.emotionScore === '' ? null : Number(r.emotionScore),
    nextWant: r.nextWant, rawText: r.rawText, drawId: r.drawId, drawResult: r.drawResult,
    outcome: r.outcome, photoIds: parseJson_(r.photoIdsJson, []), aiComment: r.aiComment,
    createdAt: r.createdAt, updatedAt: r.updatedAt
  };
}

function apiSaveDiary_(req, user) {
  const d = req.diary || {};
  const score = Math.round(Number(d.emotionScore));
  const photoIds = (Array.isArray(d.photoIds) ? d.photoIds : []).map(function (x) { return driveId_(x); }).filter(Boolean).slice(0, 6);
  const rec = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? d.date : todayStr_(),
    title: str_(d.title, 60) || '無題の一日',
    did: str_(d.did, 2000),
    feeling: str_(d.feeling, 2000),
    emotionScore: score >= 1 && score <= 5 ? score : '',
    nextWant: str_(d.nextWant, 500),
    rawText: str_(d.rawText, 4000),
    drawId: str_(d.drawId, 40),
    drawResult: str_(d.drawResult, 60),
    outcome: OUTCOMES.indexOf(d.outcome) >= 0 ? d.outcome : '',
    photoIdsJson: JSON.stringify(photoIds),
    aiComment: str_(d.aiComment, 300),
    updatedAt: nowIso_()
  };
  if (!rec.drawId) { rec.drawResult = ''; rec.outcome = ''; }

  return withLock_(function () {
    let id;
    if (d.diaryId) {
      const ex = table_(SHEET.DIARIES).rows.filter(function (r) { return r.userId === user.userId && r.diaryId === d.diaryId; })[0];
      if (!ex) throw new AppError('NOT_FOUND', '日記が見つかりません');
      update_(SHEET.DIARIES, ex._row, rec);
      id = ex.diaryId;
    } else {
      id = 'n_' + shortId_();
      append_(SHEET.DIARIES, Object.assign({ diaryId: id, userId: user.userId, createdAt: nowIso_() }, rec));
    }
    if (rec.drawId && rec.outcome) {
      const dr = table_(SHEET.DRAWS).rows.filter(function (r) { return r.userId === user.userId && r.drawId === rec.drawId; })[0];
      if (dr) update_(SHEET.DRAWS, dr._row, { outcome: rec.outcome });
    }
    return { diaryId: id };
  });
}

function apiListDiaries_(req, user) {
  const limit = Math.max(1, Math.min(100, Number(req.limit) || 20));
  const offset = Math.max(0, Number(req.offset) || 0);
  const all = table_(SHEET.DIARIES).rows
    .filter(function (r) { return r.userId === user.userId; })
    .sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
  return { diaries: all.slice(offset, offset + limit).map(diaryOut_), total: all.length };
}

function apiDeleteDiary_(req, user) {
  return withLock_(function () {
    const ex = table_(SHEET.DIARIES).rows.filter(function (r) { return r.userId === user.userId && r.diaryId === req.diaryId; })[0];
    if (!ex) throw new AppError('NOT_FOUND', '日記が見つかりません');
    parseJson_(ex.photoIdsJson, []).forEach(function (fid) {
      try {
        const f = DriveApp.getFileById(fid);
        if (f.getDescription() === 'owner:' + user.userId) f.setTrashed(true);
      } catch (e) { /* 既に無い */ }
    });
    sheet_(SHEET.DIARIES).deleteRow(ex._row);
    return {};
  });
}

/* ============================== 写真（Google Drive） ============================== */

function apiUploadPhoto_(req, user) {
  const b64 = String(req.dataBase64 || '');
  if (!b64) throw new AppError('INVALID', '写真のデータがありません');
  if (b64.length > 8 * 1024 * 1024) throw new AppError('TOO_LARGE', '写真が大きすぎます（約6MBまで）');
  const mime = /^image\/(jpeg|png|webp|gif)$/.test(req.mimeType) ? req.mimeType : 'image/jpeg';
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime];
  const folderId = prop_('DRIVE_FOLDER_ID', '');
  if (!folderId) throw new AppError('NOT_SETUP', 'DRIVE_FOLDER_ID が未設定です。setup() を実行してください');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, user.userId + '_' + Date.now() + ext);
  const file = DriveApp.getFolderById(folderId).createFile(blob);
  file.setDescription('owner:' + user.userId);
  return { fileId: file.getId() };
}

function apiGetPhoto_(req, user) {
  const id = driveId_(req.fileId);
  if (!id) throw new AppError('INVALID', '写真IDが正しくありません');
  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { throw new AppError('NOT_FOUND', '写真が見つかりません'); }
  if (file.getDescription() !== 'owner:' + user.userId) throw new AppError('FORBIDDEN', 'この写真は表示できません');
  const blob = file.getBlob();
  return { dataBase64: Utilities.base64Encode(blob.getBytes()), mimeType: blob.getContentType() };
}

/* ============================== 読み上げ（Gemini TTS） ============================== */

function apiTts_(req, user) {
  const text = str_(req.text, 600);
  if (!text) throw new AppError('INVALID', '読み上げる文章がありません');
  const model = setting_('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const voice = setting_('TTS_VOICE', 'Kore');
  const data = geminiRaw_(model, {
    contents: [{ parts: [{ text: 'やさしく明るい声で、自然な日本語で読み上げてください：\n' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const audio = parts.filter(function (p) { return p.inlineData && p.inlineData.data; })[0];
  if (!audio) throw new AppError('AI_FAILED', '音声を作れませんでした');
  return { data: audio.inlineData.data, mimeType: audio.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000' };
}

/* ============================== 行動傾向のエンタメ分析 ============================== */

function apiAnalyze_(req, user) {
  const draws = table_(SHEET.DRAWS).rows.filter(function (r) { return r.userId === user.userId; });
  const diaries = table_(SHEET.DIARIES).rows.filter(function (r) { return r.userId === user.userId; });
  if (draws.length + diaries.length === 0) {
    return { empty: true, message: 'まだ記録がありません。くじを引いて、日記を1つ書くと分析できます' };
  }

  const modeCounts = { roulette: 0, amida: 0, trump: 0, omikuji: 0 };
  const resultCount = {};
  const outcomeCounts = { followed: 0, rebel: 0, skipped: 0 };
  const fortuneCounts = {};
  const weekCounts = [0, 0, 0, 0, 0, 0, 0]; // 月〜日
  let outdoor = 0;

  draws.forEach(function (d) {
    modeCounts[d.mode] = (modeCounts[d.mode] || 0) + 1;
    resultCount[d.result] = (resultCount[d.result] || 0) + 1;
    if (outcomeCounts[d.outcome] !== undefined) outcomeCounts[d.outcome]++;
    if (d.fortune) fortuneCounts[d.fortune] = (fortuneCounts[d.fortune] || 0) + 1;
    if (isTrue_(d.isOutdoor)) outdoor++;
    if (d.createdAt) {
      const u = Number(Utilities.formatDate(new Date(d.createdAt), tz_(), 'u')); // 1=月 … 7=日
      if (u >= 1 && u <= 7) weekCounts[u - 1]++;
    }
  });

  const topResults = Object.keys(resultCount)
    .map(function (k) { return { name: k, count: resultCount[k] }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 5);

  const decided = outcomeCounts.followed + outcomeCounts.rebel;
  const rebelRate = decided ? Math.round(outcomeCounts.rebel / decided * 100) : null;

  const scores = diaries.map(function (d) { return Number(d.emotionScore); }).filter(function (n) { return n >= 1 && n <= 5; });
  const avgEmotion = scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length * 10) / 10 : null;

  // 連続記録日数
  const dateSet = {};
  diaries.forEach(function (d) { if (d.date) dateSet[d.date] = true; });
  let streak = 0;
  const cur = new Date();
  if (!dateSet[Utilities.formatDate(cur, tz_(), 'yyyy-MM-dd')]) cur.setDate(cur.getDate() - 1);
  while (dateSet[Utilities.formatDate(cur, tz_(), 'yyyy-MM-dd')]) { streak++; cur.setDate(cur.getDate() - 1); }

  const level = Math.min(99, 1 + Math.floor((draws.length + diaries.length * 3) / 4));

  const stats = {
    totalDraws: draws.length,
    totalDiaries: diaries.length,
    modeCounts: modeCounts,
    topResults: topResults,
    outcomeCounts: outcomeCounts,
    rebelRate: rebelRate,
    avgEmotion: avgEmotion,
    outdoorRate: draws.length ? Math.round(outdoor / draws.length * 100) : null,
    weekCounts: weekCounts,
    fortuneCounts: fortuneCounts,
    streak: streak,
    level: level
  };

  const recent = diaries.slice()
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
    .slice(0, 12)
    .map(function (d) { return '- ' + d.date + '「' + d.title + '」気分' + (d.emotionScore || '?') + '：' + str_(d.feeling, 60); })
    .join('\n');

  const prompt = [
    'あなたはユーモアのある占い師兼エンタメ分析家です。',
    'ユーザーの「今日やることくじ」の履歴と日記から、遊び心のある冒険者タイプ診断を作ってください。',
    '数値は書き換えず、そのまま根拠として使ってください。からかいすぎず、最後は前向きに。',
    '',
    '統計: ' + JSON.stringify({
      くじ回数: stats.totalDraws, 日記数: stats.totalDiaries, よく使うくじ: modeCounts,
      よく出た結果: topResults, くじどおり: outcomeCounts.followed, 逆らった: outcomeCounts.rebel,
      やらなかった: outcomeCounts.skipped, 反逆率: rebelRate === null ? '不明' : rebelRate + '%',
      平均気分: avgEmotion, おでかけ率: stats.outdoorRate === null ? '不明' : stats.outdoorRate + '%',
      連続記録: streak + '日', レベル: level
    }),
    '最近の日記:',
    recent || '（まだなし）',
    '',
    '出力はJSONのみ:',
    '{"typeName":"〜な〜 の形の二つ名（例：休日は引きこもり気味な週末哲学者、25字以内）","description":"タイプの解説（120字以内）","luckyAction":"次の開運アクション（具体的に30字以内）","comment":"励ましの一言（60字以内）","tags":["#短いタグ","#短いタグ","#短いタグ"]}'
  ].join('\n');

  let persona;
  try {
    const o = geminiJson_(prompt, 1.0);
    persona = {
      typeName: str_(o.typeName, 40) || '気まぐれな今日の旅人',
      description: str_(o.description, 200),
      luckyAction: str_(o.luckyAction, 60),
      comment: str_(o.comment, 100),
      tags: (Array.isArray(o.tags) ? o.tags : []).map(function (t) { return str_(t, 16); }).filter(Boolean).slice(0, 3)
    };
  } catch (e) {
    persona = {
      typeName: '記録をはじめたばかりの新米冒険者',
      description: 'まだ旅は始まったばかり。くじと日記を重ねるほど、あなたらしさが見えてきます。',
      luckyAction: '今日のくじを1回引いてみる',
      comment: 'AIの分析は混み合っていました。数字はしっかり集計済みです。',
      tags: ['#はじめの一歩']
    };
  }
  persona.level = level;
  return { stats: stats, persona: persona };
}

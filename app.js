/**
 * 小説工房 app.js v1.0.3
 * 会員認証 / 設定UI / プロンプト組み立て / 章ごとの連鎖生成 / 朗読 / ロケ地 / ドライブ保存
 */
(() => {
  'use strict';

  const C = window.APP_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const LS = { session: 'skb_session', draft: 'skb_draft', theme: 'skb_theme', reader: 'skb_reader', guide: 'skb_guide_seen' };

  const state = {
    token: null,
    user: null,
    novel: blankNovel(),
    current: 0,          // 本文画面で選択中の章（-1 は全文の通し読み）
    editing: false,
    busy: false,
    abort: null,
    audio: { chunks: [], index: -1, done: {}, driveUrls: {} },
    reader: { vertical: false, size: 1.0625 }
  };

  function blankNovel() {
    return { novelId: null, title: '', settings: null, plot: null, chapters: [], locations: [], updatedAt: null };
  }

  /* ================= 共通ユーティリティ ================= */
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量超過などは無視 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function xmlEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const fmtNum = n => Number(n).toLocaleString('ja-JP');
  const kanji = n => ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n);

  let toastTimer = null;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3200);
  }

  function setBusy(on, msg = '') {
    state.busy = on;
    $('#statusbar').hidden = !on;
    $('#status-text').textContent = msg;
    $$('#app button').forEach(b => {
      if (['btn-abort', 'btn-theme', 'btn-copy-all'].includes(b.id) || b.closest('#player')) return;
      if (b.classList.contains('step') || b.classList.contains('toc-item')) return;
      b.disabled = on;
    });
    if (!on) { state.abort = null; refreshEarthButtons(); }
  }
  const status = msg => { $('#status-text').textContent = msg; };

  function download(name, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const safeFile = s => (String(s || '無題').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '無題');

  /* ================= GAS 通信 ================= */
  async function api(action, payload = {}, opts = {}) {
    if (!C.GAS_API_URL || C.GAS_API_URL.includes('XXXX')) {
      throw new Error('config.js の GAS_API_URL を設定してください');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || C.REQUEST_TIMEOUT_MS);
    const outer = opts.signal;
    const onOuter = () => ctrl.abort();
    if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', onOuter); }
    try {
      const res = await fetch(C.GAS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライト回避
        body: JSON.stringify(Object.assign({ action, token: state.token }, payload)),
        signal: ctrl.signal,
        redirect: 'follow'
      });
      if (!res.ok) throw new Error(`通信に失敗しました（${res.status}）`);
      const data = await res.json();
      if (!data.ok) {
        const err = new Error(data.error || '処理に失敗しました');
        err.code = data.code;
        if (data.code === 'AUTH') onSessionExpired();
        if (data.code === 'PW_CHANGE_REQUIRED') openPwModal(true);
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error(outer && outer.aborted ? '中断しました' : '時間切れになりました。もう一度お試しください');
        err.code = outer && outer.aborted ? 'ABORT' : 'TIMEOUT';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuter);
    }
  }

  function gemini({ system, prompt, json = false, maxTokens = 8192, temperature = 0.9 }) {
    return api('generate', { system, prompt, json, maxTokens, temperature }, { signal: state.abort?.signal });
  }

  function parseJsonLoose(text) {
    const t = String(text || '').replace(/```json|```/g, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 続行 */ }
    const s = t.indexOf('{'), e2 = t.lastIndexOf('}');
    if (s >= 0 && e2 > s) return JSON.parse(t.slice(s, e2 + 1));
    throw new Error('AIの出力を読み取れませんでした。もう一度お試しください');
  }

  /* ================= 認証 ================= */
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function initPwToggles() {
    $$('.pw-toggle').forEach(btn => {
      btn.innerHTML = EYE;
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? EYE_OFF : EYE;
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      });
    });
  }

  function authMsg(msg, kind = '') {
    const el = $('#auth-msg');
    el.textContent = msg;
    el.className = 'auth-msg' + (kind ? ' is-' + kind : '');
  }

  function switchAuthTab(name) {
    $$('.auth-tab').forEach(t => {
      const on = t.dataset.auth === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $$('[data-auth-panel]').forEach(p => { p.hidden = p.dataset.authPanel !== name; });
    authMsg('');
  }

  function showAuth() {
    $('#auth-screen').hidden = false;
    $('#app').hidden = true;
    $('#btn-logout').hidden = true;
    $('#user-name').hidden = true;
  }

  function showApp() {
    $('#auth-screen').hidden = true;
    $('#app').hidden = false;
    $('#btn-logout').hidden = false;
    $('#user-name').hidden = false;
    $('#user-name').textContent = state.user ? `${state.user.username} さん` : '';
    renderAll();
    loadWorks();
    setTimeout(maybeShowGuide, 300);
  }

  function onSessionExpired() {
    state.token = null; state.user = null;
    store.del(LS.session);
    showAuth();
    switchAuthTab('login');
    authMsg('ログインの有効期限が切れました。もう一度ログインしてください', 'error');
  }

  async function handleLogin(e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true; authMsg('確認しています…');
    try {
      const r = await api('login', { email: f.email.value.trim(), password: f.password.value });
      state.token = r.token; state.user = r.user;
      store.set(LS.session, { token: r.token, user: r.user });
      f.reset();
      authMsg('');
      if (r.user.status === 'FIRST_LOGIN') { showApp(); openPwModal(true); }
      else { showApp(); toast('ログインしました'); }
    } catch (err) {
      authMsg(err.message, 'error');
    } finally { btn.disabled = false; }
  }

  async function handleRegister(e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true; authMsg('登録しています…');
    try {
      const r = await api('register', { email: f.email.value.trim(), username: f.username.value.trim() });
      let msg = r.message;
      if (r.tempPassword) msg += `\n仮パスワード：${r.tempPassword}`;
      const email = f.email.value.trim();
      f.reset();
      switchAuthTab('login');
      $('#form-login').email.value = email;
      authMsg(msg, 'ok');
    } catch (err) {
      authMsg(err.message, 'error');
    } finally { btn.disabled = false; }
  }

  async function handleReset(e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true; authMsg('送信しています…');
    try {
      const r = await api('resetPassword', { email: f.email.value.trim() });
      let msg = r.message;
      if (r.tempPassword) msg += `\n仮パスワード：${r.tempPassword}`;
      const email = f.email.value.trim();
      f.reset();
      switchAuthTab('login');
      $('#form-login').email.value = email;
      authMsg(msg, 'ok');
    } catch (err) {
      authMsg(err.message, 'error');
    } finally { btn.disabled = false; }
  }

  function openPwModal(force) {
    const m = $('#pw-modal');
    m.dataset.force = force ? '1' : '';
    $('#pw-cancel').hidden = !!force;
    $('#pw-modal-lead').textContent = force
      ? '仮パスワードでログインしました。続けるには本パスワードを設定してください。'
      : 'パスワードを変更します。';
    $('#pw-msg').textContent = '';
    if (!m.open) m.showModal();
  }

  async function handlePwChange(e) {
    e.preventDefault();
    const f = e.target;
    const msg = $('#pw-msg');
    msg.className = 'auth-msg';
    if (f.next.value !== f.confirm.value) {
      msg.textContent = '確認用のパスワードが一致しません'; msg.classList.add('is-error'); return;
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(f.next.value)) {
      msg.textContent = '8文字以上で、英字と数字を両方含めてください'; msg.classList.add('is-error'); return;
    }
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true; msg.textContent = '変更しています…';
    try {
      await api('changePassword', { currentPassword: f.current.value, newPassword: f.next.value });
      state.user.status = 'ACTIVE';
      store.set(LS.session, { token: state.token, user: state.user });
      f.reset();
      $('#pw-modal').close();
      toast('パスワードを変更しました');
      setTimeout(maybeShowGuide, 300);
    } catch (err) {
      msg.textContent = err.message; msg.classList.add('is-error');
    } finally { btn.disabled = false; }
  }

  async function logout() {
    try { await api('logout', {}); } catch (e) { /* 失効済みでも続行 */ }
    state.token = null; state.user = null;
    store.del(LS.session);
    stopAudio();
    showAuth();
    switchAuthTab('login');
    authMsg('ログアウトしました', 'ok');
  }

  /* ================= 設定フォーム ================= */
  function fillSelect(sel, items, valueKey = 'id', labelKey = 'label') {
    sel.innerHTML = items.map(i => `<option value="${esc(i[valueKey])}">${esc(i[labelKey])}</option>`).join('');
  }

  function initSettingsForm() {
    $('#choices-style').innerHTML = C.STYLE_PRESETS.map(p => {
      const m = p.label.match(/^(.*?)（(.*)）$/);
      const name = m ? m[1] : p.label;
      const sub = m ? m[2] : '';
      return `<label class="choice"><input type="radio" name="style" value="${esc(p.id)}">
        <span class="choice-name">${esc(name)}</span><span class="choice-desc">${esc(sub)}</span></label>`;
    }).join('');
    fillSelect($('#sel-era'), C.ERA_PRESETS);
    fillSelect($('#sel-tone'), C.TONE_PRESETS);
    fillSelect($('#sel-focus'), C.FOCUS_PRESETS);
    $('#sel-chapters').innerHTML = C.CHAPTER_CHOICES.map(n => `<option value="${n}">${n}章</option>`).join('');
    fillSelect($('#sel-length'), C.LENGTH_CHOICES, 'value', 'label');
    $('#sel-era').addEventListener('change', updateEraNote);
    $('#form-settings').addEventListener('input', debounce(() => {
      state.novel.settings = readSettings(); saveDraft();
    }, 600));
    writeSettings(Object.assign({}, C.DEFAULTS));
  }

  function updateEraNote() {
    const era = C.ERA_PRESETS.find(p => p.id === $('#sel-era').value);
    $('#era-note').textContent = era ? era.prompt : '';
  }

  function readSettings() {
    const f = $('#form-settings');
    return {
      title: f.title.value.trim(),
      place: f.place.value.trim(),
      premise: f.premise.value.trim(),
      protagonist: f.protagonist.value.trim(),
      style: (f.querySelector('input[name=style]:checked') || {}).value || C.DEFAULTS.style,
      era: f.era.value, tone: f.tone.value, focus: f.focus.value,
      chapters: num(f.chapters.value, C.DEFAULTS.chapters),
      charsPerChapter: num(f.charsPerChapter.value, C.DEFAULTS.charsPerChapter),
      notes: f.notes.value.trim()
    };
  }

  function writeSettings(s) {
    const f = $('#form-settings');
    s = Object.assign({}, C.DEFAULTS, s || {});
    f.title.value = s.title || ''; f.place.value = s.place || '';
    f.premise.value = s.premise || ''; f.protagonist.value = s.protagonist || '';
    f.notes.value = s.notes || '';
    const radio = f.querySelector(`input[name=style][value="${s.style}"]`) || f.querySelector('input[name=style]');
    radio.checked = true;
    f.era.value = s.era; f.tone.value = s.tone; f.focus.value = s.focus;
    f.chapters.value = String(s.chapters); f.charsPerChapter.value = String(s.charsPerChapter);
    updateEraNote();
  }

  /* ================= プロンプト組み立て ================= */
  const pick = (list, id) => list.find(p => p.id === id) || list[0];

  function buildSystemPrompt(s) {
    const st = pick(C.STYLE_PRESETS, s.style);
    const era = pick(C.ERA_PRESETS, s.era);
    const tone = pick(C.TONE_PRESETS, s.tone);
    const focus = pick(C.FOCUS_PRESETS, s.focus);
    return [
      'あなたは日本語で長編小説を書く熟練の作家です。以下の作風・時代・トーン・描写方針を、最初から最後まで一貫して守ってください。',
      `【文体・作風：${st.label}】\n${st.prompt}`,
      `【時代背景・空気感：${era.label}】\n${era.prompt}\nこの時代に存在しない物・言葉・価値観を持ち込まないこと。風俗・物価・交通手段・言葉遣いを時代に合わせること。`,
      `【物語のトーン：${tone.label}】\n${tone.prompt}`,
      `【描写の切り口：${focus.label}】\n${focus.prompt}`,
      '【共通ルール】\n- 実在作家の文章を引用・再現せず、文体の特徴を参考にした独自の文章を書く。\n- あらすじ的な要約で済ませず、場面として描く。\n- 同じ比喩・言い回し・身振りを繰り返さない。\n- 指示された形式以外（前置き、解説、あとがき、注釈）は出力しない。'
    ].join('\n\n');
  }

  function buildPlotPrompt(s) {
    return `次の条件で、長編小説の全体プロットと章立てを作ってください。

【題名】${s.title || '（未定。物語にふさわしい題名を付けること）'}
【物語の核・あらすじ案】${s.premise}
【主人公】${s.protagonist || '（おまかせ）'}
【舞台となる土地】${s.place || '（時代に合う実在の土地を選ぶこと）'}
【章数】${s.chapters}章（起承転結を章に割り振る）
【1章の分量】約${s.charsPerChapter}字
【その他の希望】${s.notes || 'なし'}

条件：
- chapters はちょうど ${s.chapters} 件。phase は「起」「承」「転」「結」のいずれか。
- 各章の synopsis は200〜300字で、その章で起きる出来事と人物の感情の動きを具体的に書く。
- 伏線は前半の章に置き、後半で回収する。
- locations には実在の地名・建物・通り・駅・港などを書く（架空の店はその所在地の実在地名を添える）。

次のJSONだけを出力してください。
{
  "title": "題名",
  "logline": "物語を一文で",
  "theme": "主題",
  "setting": "舞台と時代の具体的な説明",
  "characters": [{"name": "名前", "role": "役割", "description": "年齢・外見・経歴・癖・隠している秘密"}],
  "chapters": [{"no": 1, "title": "章題", "phase": "起", "synopsis": "200〜300字", "keyScenes": ["場面1", "場面2"], "locations": ["地名"], "endingHook": "章の終わり方"}]
}`;
  }

  function charactersText(plot) {
    return (plot.characters || []).map(c => `・${c.name}（${c.role}）：${c.description}`).join('\n');
  }

  function buildChapterPrompt(s, plot, idx) {
    const ch = plot.chapters[idx];
    const total = plot.chapters.length;
    const prev = state.novel.chapters.slice(0, idx);
    const outline = plot.chapters.map((c, i) => `第${i + 1}章「${c.title}」（${c.phase}）${i === idx ? ' ← 今回' : ''}`).join('\n');
    const summaries = prev.map((c, i) => `第${i + 1}章「${plot.chapters[i].title}」：${c && c.summary ? c.summary : '（要約なし）'}`).join('\n');
    const lastText = idx > 0 && prev[idx - 1] && prev[idx - 1].text ? prev[idx - 1].text.slice(-C.CONTEXT_TAIL_CHARS) : '';
    const target = s.charsPerChapter;
    const isLast = idx === total - 1;

    return `長編小説『${plot.title}』の第${idx + 1}章（全${total}章）の本文を書いてください。

■ 物語の概要
${plot.logline}
主題：${plot.theme || ''}
舞台：${plot.setting || ''}

■ 登場人物
${charactersText(plot)}

■ 全体の章立て
${outline}

${idx > 0 ? `■ これまでの章の要約（この内容と矛盾させないこと）
${summaries}

■ 直前の本文（この続きとして自然につながるように書き出すこと。この部分は繰り返さない）
……${lastText}
` : ''}
■ 今回書く章
第${idx + 1}章「${ch.title}」（${ch.phase}）
あらすじ：${ch.synopsis}
入れる場面：${(ch.keyScenes || []).join('／')}
主な舞台：${(ch.locations || []).join('、')}
章の終わり方：${ch.endingHook || ''}

■ 書き方
- 分量は約${target}字（少なくとも${Math.round(target * 0.8)}字）。場面を省略せずに描く。
- 章題や見出しは書かず、本文だけを出力する。
- 段落の頭は全角スペースで一字下げ。会話は「」で書く。段落の間に空行は入れない。
- 場面転換には「＊」だけの行を使う。
${isLast ? '- 最終章として物語を締めくくる。伏線を回収し、余韻を残して終える。' : '- 章の最後は次の章へ読み進めたくなる引きで終える。物語を完結させない。'}`;
  }

  function buildContinuePrompt(plot, idx, text) {
    return `長編小説『${plot.title}』第${idx + 1}章「${plot.chapters[idx].title}」の本文が途中で切れました。
以下は書き終えた部分の末尾です。

……${text.slice(-C.CONTEXT_TAIL_CHARS)}

この直後から、同じ文体のまま続きを書いてください。既に書いた部分は繰り返さず、本文だけを出力してください。章の終わり方：${plot.chapters[idx].endingHook || ''}`;
  }

  function buildSummaryPrompt(plot, idx, text) {
    return `次は長編小説『${plot.title}』第${idx + 1}章「${plot.chapters[idx].title}」の本文です。
次の章を書く作家への引き継ぎメモとして、300字程度で要約してください。
起きた出来事、登場人物の現在の状態（居場所・怪我・感情・関係の変化）、未解決の謎や伏線、章の終わりの状況を必ず含めてください。要約文だけを出力してください。

${text}`;
  }

  function buildLocationPrompt(plot, fullText) {
    return `次の小説から、物語の舞台になった場所を最大${C.LOCATION_MAX}か所抜き出し、Google Earth で空撮するためのカメラ設定を付けてください。

題名：${plot.title}
舞台：${plot.setting || ''}

条件：
- 登場順に並べる。同じ場所は1回だけ。
- 実在の場所は実際の緯度経度を使う。架空の場所は、物語上もっとも近い実在の場所に置き換え、fictional を true にする。
- groundAltitude はその地点の地表標高（m）の概算。
- range はカメラから地点までの距離（m）。街路や建物は300〜1200、街全体は2000〜6000、山や海岸線は5000〜20000を目安にする。
- tilt は0が真下、90が水平。情景に合わせて45〜75を基本とする。heading は0が北、時計回りの度数。
- durationSec はその地点へ飛ぶ秒数（4〜10）。
- scene はその場所で起きた出来事を40字以内で。

次のJSONだけを出力してください。
{"locations": [{"name": "物語中の呼び名", "realPlace": "実在の地名・施設名", "fictional": false, "chapter": 1, "scene": "出来事", "lat": 35.0, "lng": 139.0, "groundAltitude": 10, "range": 800, "tilt": 60, "heading": 0, "durationSec": 6}]}

本文：
${fullText}`;
  }

  /* ================= 構成（プロット）生成 ================= */
  async function generatePlot(e) {
    if (e) e.preventDefault();
    const s = readSettings();
    if (!s.premise) { toast('物語の核・あらすじ案を入れてください', true); return; }
    if (state.novel.chapters.some(c => c && c.text) &&
      !confirm('構成を作り直すと、書いた本文は消えます。続けますか？')) return;

    state.abort = new AbortController();
    setBusy(true, '構成を考えています…（30秒〜1分ほど）');
    try {
      const r = await gemini({ system: buildSystemPrompt(s), prompt: buildPlotPrompt(s), json: true, maxTokens: 8192, temperature: 0.95 });
      const plot = normalizePlot(parseJsonLoose(r.text), s);
      state.novel.settings = s;
      state.novel.plot = plot;
      state.novel.title = plot.title;
      state.novel.chapters = plot.chapters.map(() => null);
      state.novel.locations = [];
      state.current = 0;
      saveDraft();
      renderAll();
      showPanel('plot');
      toast('構成ができました');
    } catch (err) {
      if (err.code !== 'ABORT') toast(err.message, true);
    } finally { setBusy(false); }
  }

  function normalizePlot(p, s) {
    const chapters = Array.isArray(p.chapters) ? p.chapters : [];
    if (!chapters.length) throw new Error('章立てが空でした。もう一度お試しください');
    return {
      title: String(p.title || s.title || '無題').trim(),
      logline: String(p.logline || ''),
      theme: String(p.theme || ''),
      setting: String(p.setting || ''),
      characters: (Array.isArray(p.characters) ? p.characters : []).map(c => ({
        name: String(c.name || ''), role: String(c.role || ''), description: String(c.description || '')
      })),
      chapters: chapters.map((c, i) => ({
        no: i + 1,
        title: String(c.title || `第${i + 1}章`),
        phase: String(c.phase || ''),
        synopsis: String(c.synopsis || ''),
        keyScenes: Array.isArray(c.keyScenes) ? c.keyScenes.map(String) : [],
        locations: Array.isArray(c.locations) ? c.locations.map(String) : [],
        endingHook: String(c.endingHook || '')
      }))
    };
  }

  function renderPlot() {
    const p = state.novel.plot;
    $('#plot-empty').hidden = !!p;
    $('#plot-editor').hidden = !p;
    if (!p) return;
    $('#plot-title').value = p.title;
    $('#plot-logline').value = p.logline;
    $('#plot-setting').value = p.setting;
    $('#plot-characters').value = p.characters.map(c => `${c.name}｜${c.role}｜${c.description}`).join('\n');
    $('#plot-chapters').innerHTML = p.chapters.map((c, i) => `
      <li data-i="${i}">
        <div class="plan-head">
          <span class="plan-no">第${kanji(i + 1)}章</span>
          <label class="field"><span>章題</span><input type="text" data-k="title" value="${esc(c.title)}"></label>
          <label class="field"><span>構成</span><input type="text" data-k="phase" value="${esc(c.phase)}" maxlength="4"></label>
        </div>
        <label class="field"><span>あらすじ</span><textarea data-k="synopsis" rows="4">${esc(c.synopsis)}</textarea></label>
        <label class="field"><span>入れる場面（／区切り）</span><input type="text" data-k="keyScenes" value="${esc(c.keyScenes.join('／'))}"></label>
        <div class="grid-2">
          <label class="field"><span>主な舞台（、区切り）</span><input type="text" data-k="locations" value="${esc(c.locations.join('、'))}"></label>
          <label class="field"><span>章の終わり方</span><input type="text" data-k="endingHook" value="${esc(c.endingHook)}"></label>
        </div>
      </li>`).join('');
  }

  function bindPlotEditor() {
    const sync = debounce(() => {
      const p = state.novel.plot; if (!p) return;
      p.title = $('#plot-title').value.trim() || '無題';
      p.logline = $('#plot-logline').value;
      p.setting = $('#plot-setting').value;
      p.characters = $('#plot-characters').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [name = '', role = '', ...rest] = l.split(/[｜|]/);
        return { name: name.trim(), role: role.trim(), description: rest.join('｜').trim() };
      });
      $$('#plot-chapters > li').forEach(li => {
        const c = p.chapters[num(li.dataset.i)];
        $$('[data-k]', li).forEach(inp => {
          const k = inp.dataset.k;
          if (k === 'keyScenes') c[k] = inp.value.split(/[／\/]/).map(x => x.trim()).filter(Boolean);
          else if (k === 'locations') c[k] = inp.value.split(/[、,]/).map(x => x.trim()).filter(Boolean);
          else c[k] = inp.value;
        });
      });
      state.novel.title = p.title;
      saveDraft();
      renderToc(); renderWriteHead();
    }, 500);
    $('#plot-editor').addEventListener('input', sync);
  }

  /* ================= 本文生成（章ごとの連鎖） ================= */
  async function ensureSummary(i) {
    const ch = state.novel.chapters[i];
    if (!ch || !ch.text || ch.summary) return;
    status(`第${i + 1}章の要約を作っています…`);
    const r = await gemini({ prompt: buildSummaryPrompt(state.novel.plot, i, ch.text), maxTokens: 1024, temperature: 0.3 });
    ch.summary = r.text.trim();
    saveDraft();
  }

  async function writeChapter(idx) {
    const s = state.novel.settings || readSettings();
    const plot = state.novel.plot;
    const total = plot.chapters.length;

    for (let i = 0; i < idx; i++) {
      if (!state.novel.chapters[i] || !state.novel.chapters[i].text) {
        throw new Error(`先に第${i + 1}章を書いてください（前の章の流れを引き継ぐため）`);
      }
      await ensureSummary(i);
    }

    status(`第${idx + 1}章／全${total}章を書いています…（1〜3分ほど）`);
    const maxTokens = Math.min(32768, Math.max(4096, Math.round(s.charsPerChapter * 2.2)));
    let r = await gemini({ system: buildSystemPrompt(s), prompt: buildChapterPrompt(s, plot, idx), maxTokens, temperature: 0.95 });
    let text = cleanChapter(r.text);

    let n = 0;
    while (r.finishReason === 'MAX_TOKENS' && n < C.MAX_CONTINUE) {
      n++;
      status(`第${idx + 1}章の続きを書いています…（${n}回目）`);
      r = await gemini({ system: buildSystemPrompt(s), prompt: buildContinuePrompt(plot, idx, text), maxTokens, temperature: 0.9 });
      text += '\n' + cleanChapter(r.text);
    }
    if (!text.trim()) throw new Error(`第${idx + 1}章の本文が空でした。もう一度お試しください`);

    state.novel.chapters[idx] = { title: plot.chapters[idx].title, text, summary: '' };
    // 後ろの章は前提が変わったので要約を捨てる（本文は残す）
    for (let j = idx + 1; j < total; j++) if (state.novel.chapters[j]) state.novel.chapters[j].summary = '';
    saveDraft();

    if (idx < total - 1) await ensureSummary(idx);
  }

  function cleanChapter(t) {
    return String(t || '')
      .replace(/^```.*$/gm, '')
      .replace(/^\s*(#+\s*)?第[0-9０-９一二三四五六七八九十]+章.*$/m, '') // 冒頭に章題が付いた場合
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  async function writeOne() {
    if (!state.novel.plot) { toast('先に構成を作ってください', true); return; }
    const idx = state.current;
    if (idx < 0) { toast('左の一覧から、書く章を選んでください', true); return; }
    if (state.novel.chapters[idx] && state.novel.chapters[idx].text &&
      !confirm(`第${idx + 1}章を書き直します。今の本文は置き換わります。`)) return;
    state.abort = new AbortController();
    setBusy(true, '準備しています…');
    try {
      await writeChapter(idx);
      renderWrite();
      toast(`第${idx + 1}章を書きました`);
    } catch (err) {
      if (err.code !== 'ABORT') toast(err.message, true);
    } finally { setBusy(false); renderWrite(); }
  }

  async function writeAll() {
    if (!state.novel.plot) { toast('先に構成を作ってください', true); return; }
    const total = state.novel.plot.chapters.length;
    const todo = [];
    for (let i = 0; i < total; i++) if (!state.novel.chapters[i] || !state.novel.chapters[i].text) todo.push(i);
    if (!todo.length) { toast('すべての章が書き上がっています'); return; }
    state.abort = new AbortController();
    setBusy(true, '準備しています…');
    try {
      for (const i of todo) {
        state.current = i;
        renderWrite();
        await writeChapter(i);
        renderWrite();
      }
      toast('すべての章を書き上げました');
    } catch (err) {
      if (err.code !== 'ABORT') toast(err.message, true);
    } finally { setBusy(false); renderWrite(); }
  }

  /* ================= 本文の表示・編集 ================= */
  function renderWriteHead() {
    const p = state.novel.plot;
    $('#write-title').textContent = p ? `『${p.title}』` : '本文';
    const written = state.novel.chapters.filter(c => c && c.text);
    const chars = written.reduce((a, c) => a + c.text.length, 0);
    $('#write-meta').textContent = p
      ? `${written.length}／${p.chapters.length}章　合計${fmtNum(chars)}字`
      : '前の章の要約と直前の場面を引き継ぎながら、1章ずつ書きます。';
  }

  function renderToc() {
    const p = state.novel.plot;
    if (!p) { $('#toc-list').innerHTML = ''; return; }
    const total = state.novel.chapters.reduce((a, c) => a + (c && c.text ? c.text.length : 0), 0);
    const full = `<li><button type="button" class="toc-item toc-full${state.current === -1 ? ' is-current' : ''}" data-i="-1">
        <span>全文（通し読み）</span><small>${total ? `${fmtNum(total)}字` : 'まだ本文がありません'}</small></button></li>`;
    $('#toc-list').innerHTML = full + p.chapters.map((c, i) => {
      const ch = state.novel.chapters[i];
      const done = ch && ch.text;
      return `<li><button type="button" class="toc-item${i === state.current ? ' is-current' : ''}${done ? ' is-written' : ''}" data-i="${i}">
        <span>第${kanji(i + 1)}章　${esc(c.title)}</span>
        <small>${done ? `${fmtNum(ch.text.length)}字` : '未執筆'}</small></button></li>`;
    }).join('');
  }

  function renderReader() {
    const p = state.novel.plot;
    const el = $('#reader');
    el.classList.toggle('is-vertical', state.reader.vertical);
    document.documentElement.style.setProperty('--reader-size', state.reader.size + 'rem');
    if (!p) { el.innerHTML = '<p class="placeholder">構成を作ると、ここに本文が表示されます。</p>'; $('#char-count').textContent = ''; return; }
    if (state.current === -1) {
      const parts = p.chapters.map((c, i) => {
        const x = state.novel.chapters[i];
        if (!x || !x.text) return '';
        return `<h3>第${kanji(i + 1)}章　${esc(c.title)}</h3>` + x.text.split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('');
      }).join('');
      el.innerHTML = parts ? `<h2 class="ms-title">${esc(p.title)}</h2>` + parts
        : '<p class="placeholder">まだ本文がありません。左の一覧から章を選んで書き始めてください。</p>';
      const total = state.novel.chapters.reduce((a, c) => a + (c && c.text ? c.text.length : 0), 0);
      $('#char-count').textContent = total ? `全文 ${fmtNum(total)}字` : '';
      if (state.reader.vertical) el.scrollLeft = el.scrollWidth; else el.scrollTop = 0;
      $('#btn-vertical').setAttribute('aria-pressed', String(state.reader.vertical));
      $('#btn-edit').disabled = true;
      return;
    }
    const ch = state.novel.chapters[state.current];
    const title = `第${kanji(state.current + 1)}章　${p.chapters[state.current].title}`;
    if (!ch || !ch.text) {
      el.innerHTML = `<h3>${esc(title)}</h3><p class="placeholder">この章はまだ書かれていません。「この章を書く／書き直す」で書き始めます。</p>`;
      $('#char-count').textContent = '';
    } else {
      el.innerHTML = `<h3>${esc(title)}</h3>` + ch.text.split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('');
      $('#char-count').textContent = `${fmtNum(ch.text.length)}字`;
    }
    if (state.reader.vertical) el.scrollLeft = el.scrollWidth; // 縦書きは右端から
    else el.scrollTop = 0;
    $('#btn-vertical').setAttribute('aria-pressed', String(state.reader.vertical));
    $('#btn-edit').disabled = state.busy || !(ch && ch.text);
  }

  function renderWrite() {
    renderWriteHead(); renderToc();
    if (!state.editing) renderReader();
    const p = state.novel.plot;
    const allDone = p && p.chapters.every((c, i) => state.novel.chapters[i] && state.novel.chapters[i].text);
    $('#btn-write-all').textContent = allDone ? 'すべて書き上がりました' : '残りの章を順に書く';
  }

  function startEdit() {
    if (state.current < 0) return;
    const ch = state.novel.chapters[state.current];
    if (!ch || !ch.text) return;
    state.editing = true;
    $('#editor-text').value = ch.text;
    $('#reader').hidden = true; $('#editor').hidden = false;
    $('#editor-text').focus();
  }
  function endEdit(save) {
    if (save) {
      const ch = state.novel.chapters[state.current];
      ch.text = $('#editor-text').value.replace(/\n{2,}/g, '\n').trim();
      ch.summary = ''; // 次の生成時に作り直す
      for (let j = state.current + 1; j < state.novel.chapters.length; j++) {
        if (state.novel.chapters[j]) state.novel.chapters[j].summary = '';
      }
      saveDraft();
      toast('編集を反映しました');
    }
    state.editing = false;
    $('#reader').hidden = false; $('#editor').hidden = true;
    renderWrite();
  }

  /* ================= 朗読（TTS） ================= */
  function renderVoiceOptions() {
    const p = state.novel.plot;
    const opts = ['<option value="all">全章</option>'];
    if (p) p.chapters.forEach((c, i) => {
      const done = state.novel.chapters[i] && state.novel.chapters[i].text;
      opts.push(`<option value="${i}"${done ? '' : ' disabled'}>第${i + 1}章　${esc(c.title)}${done ? '' : '（未執筆）'}</option>`);
    });
    const keep = $('#tts-scope').value;
    $('#tts-scope').innerHTML = opts.join('');
    if (keep && $(`#tts-scope option[value="${keep}"]`)) $('#tts-scope').value = keep;
  }

  function splitForTts(text, max) {
    const out = [];
    let buf = '';
    const push = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
    text.split('\n').map(s => s.trim()).filter(Boolean).forEach(para => {
      const sentences = para.split(/(?<=[。！？!?」])/);
      sentences.forEach(sen => {
        while (sen.length > max) { push(); out.push(sen.slice(0, max)); sen = sen.slice(max); }
        if (buf.length + sen.length > max) push();
        buf += sen;
      });
      if (buf.length > max * 0.6) push(); else buf += '\n';
    });
    push();
    // 文の途中で終わると、AIが続きを勝手に読もうとして余計な音が出やすいので句点で閉じる
    return out.map(t => (/[。！？!?」』）)…―]$/.test(t) ? t : t + '。'));
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // WAV（16bit・モノラル）→ { rate, samples:Int16Array }
  function wavToPcm(bytes) {
    const w = parseWav(bytes);
    if (!w || w.bits !== 16 || w.channels !== 1) throw new Error('音声の形式が想定と違います');
    const len = Math.floor(w.data.length / 2);
    const buf = new ArrayBuffer(len * 2);
    new Uint8Array(buf).set(w.data.subarray(0, len * 2));
    return { rate: w.sampleRate, samples: new Int16Array(buf) };
  }

  function pcmToWav(samples, rate) {
    const dataLen = samples.length * 2;
    const out = new Uint8Array(44 + dataLen);
    const v = new DataView(out.buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, dataLen, true);
    out.set(new Uint8Array(samples.buffer, samples.byteOffset, dataLen), 44);
    return out;
  }

  /**
   * 末尾の余計な音（「が〜」など）を取り除く。
   * 音量で発声区間を拾い、最後の発声が「短い」かつ「直前と間が空いている」ときは、
   * 本文とは関係のない音とみなして切り落とす。あわせて末尾の無音も詰め、短くフェードアウトする。
   */
  function trimTail(samples, rate) {
    const T = C.TTS_TRIM || {};
    if (T.enabled === false) return samples;
    const FR = 0.02;
    const fl = Math.max(1, Math.round(rate * FR));
    const n = Math.floor(samples.length / fl);
    if (n < 10) return samples;
    const rms = new Float32Array(n);
    let max = 0;
    for (let f = 0; f < n; f++) {
      let sum = 0;
      const o = f * fl;
      for (let i = 0; i < fl; i++) { const x = samples[o + i]; sum += x * x; }
      rms[f] = Math.sqrt(sum / fl);
      if (rms[f] > max) max = rms[f];
    }
    const thr = Math.max(T.minLevel ?? 250, max * (T.ratio ?? 0.07));
    const joinGap = Math.round(0.15 / FR);
    const segs = [];
    let cur = null;
    for (let f = 0; f < n; f++) {
      if (rms[f] <= thr) continue;
      if (cur && f - cur.e <= joinGap) cur.e = f + 1;
      else { cur = { s: f, e: f + 1 }; segs.push(cur); }
    }
    if (!segs.length) return samples;

    const maxSec = T.tailMaxSec ?? 0.7;
    const gapSec = T.gapSec ?? 0.3;
    let last = segs.length - 1, dropped = 0;
    while (last > 0 && dropped < 2) {
      const s = segs[last], p = segs[last - 1];
      if ((s.e - s.s) * FR < maxSec && (s.s - p.e) * FR >= gapSec) { last--; dropped++; }
      else break;
    }
    const end = Math.min(samples.length, Math.min(n, segs[last].e + Math.round(0.25 / FR)) * fl);
    const out = samples.slice(0, end);
    const fade = Math.min(out.length, Math.round(rate * 0.03));
    for (let i = 0; i < fade; i++) {
      const k = out.length - 1 - i;
      out[k] = Math.round(out[k] * (i / fade));
    }
    return out;
  }

  // 区切りをつなぐ（間に無音を入れる）
  function joinPcm(list, rate) {
    const total = list.reduce((a, x) => a + x.samples.length + Math.round(rate * x.pause), 0);
    const out = new Int16Array(total);
    let off = 0;
    list.forEach(x => { out.set(x.samples, off); off += x.samples.length + Math.round(rate * x.pause); });
    return out;
  }

  function chapterPcm(chIdx) {
    const parts = state.audio.chunks.filter(c => c.chapter === chIdx);
    if (!parts.length) return null;
    const rate = parts[0].rate;
    const list = parts.map((c, i) => ({ samples: c.samples, pause: c.head ? 0.9 : (i === parts.length - 1 ? 1.0 : 0.35) }));
    return { rate, samples: joinPcm(list, rate) };
  }

  function allPcm() {
    const chs = [...new Set(state.audio.chunks.map(c => c.chapter))];
    if (!chs.length) return null;
    const pcs = chs.map(chapterPcm);
    const rate = pcs[0].rate;
    return { rate, samples: joinPcm(pcs.map(p => ({ samples: p.samples, pause: 1.0 })), rate) };
  }

  let lamePromise = null;
  function loadLame() {
    if (window.lamejs) return Promise.resolve();
    if (!lamePromise) {
      lamePromise = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = C.LAMEJS_URL;
        s.onload = () => res();
        s.onerror = () => { lamePromise = null; rej(new Error('MP3に変換する部品を読み込めませんでした')); };
        document.head.appendChild(s);
      });
    }
    return lamePromise;
  }

  async function encodeMp3(samples, rate, onProgress) {
    await loadLame();
    const enc = new window.lamejs.Mp3Encoder(1, rate, C.MP3_KBPS || 64);
    const parts = [];
    const block = 1152;
    for (let i = 0; i < samples.length; i += block) {
      const b = enc.encodeBuffer(samples.subarray(i, i + block));
      if (b.length) parts.push(new Uint8Array(b));
      if (i % (block * 500) === 0) {
        if (onProgress) onProgress(i / samples.length);
        await new Promise(r => setTimeout(r, 0)); // 画面を固めない
      }
    }
    const f = enc.flush();
    if (f.length) parts.push(new Uint8Array(f));
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  const chapterFileName = (i, ext) =>
    `${safeFile(state.novel.title)}_第${String(i + 1).padStart(2, '0')}章_${safeFile(state.novel.plot.chapters[i].title)}.${ext}`;

  async function saveChapterToDrive(i) {
    const pc = chapterPcm(i);
    if (!pc) return;
    status(`第${i + 1}章の音声をMP3にまとめています…`);
    const blob = await encodeMp3(pc.samples, pc.rate, r => status(`第${i + 1}章の音声をMP3にまとめています…（${Math.round(r * 100)}%）`));
    const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
    status(`第${i + 1}章の音声をドライブに保存しています…`);
    const r = await api('saveAudio', {
      novelId: state.novel.novelId,
      fileName: `第${String(i + 1).padStart(2, '0')}章_${safeFile(state.novel.plot.chapters[i].title)}.mp3`,
      audioBase64: b64, mimeType: 'audio/mpeg'
    }, { signal: state.abort.signal });
    state.audio.driveUrls[i] = r.fileUrl;
    renderPlaylist();
  }

  async function generateTts() {
    const p = state.novel.plot;
    if (!p) { toast('先に本文を書いてください', true); return; }
    const scope = $('#tts-scope').value;
    const idxs = scope === 'all'
      ? p.chapters.map((_, i) => i).filter(i => state.novel.chapters[i] && state.novel.chapters[i].text)
      : [num(scope)];
    if (!idxs.length) { toast('朗読できる本文がありません', true); return; }

    const jobs = [];
    idxs.forEach(i => {
      const ch = state.novel.chapters[i];
      jobs.push({ chapter: i, text: `第${kanji(i + 1)}章、${p.chapters[i].title}。`, head: true });
      splitForTts(ch.text, C.TTS_CHUNK_CHARS).forEach(t => jobs.push({ chapter: i, text: t }));
    });

    const voice = $('#tts-voice').value;
    const toDrive = $('#tts-drive').checked;

    stopAudio();
    state.audio.chunks.forEach(c => URL.revokeObjectURL(c.url));
    state.audio = { chunks: [], index: -1, done: {}, driveUrls: {} };

    state.abort = new AbortController();
    setBusy(true, '音声を準備しています…');
    try {
      if (toDrive && !state.novel.novelId) {
        status('音声の保存先を作るため、先に作品をドライブに保存しています…');
        await saveToDrive(true);
      }
      for (let k = 0; k < jobs.length; k++) {
        const j = jobs[k];
        status(`音声を作っています…（${k + 1}／${jobs.length}）`);
        const r = await api('tts', { text: j.text, voice }, { signal: state.abort.signal });
        const pcm = wavToPcm(b64ToBytes(r.audioBase64));
        const samples = trimTail(pcm.samples, pcm.rate);
        const wav = pcmToWav(samples, pcm.rate);
        state.audio.chunks.push({
          chapter: j.chapter, head: !!j.head,
          label: j.head ? `第${j.chapter + 1}章 章題` : j.text.slice(0, 28) + (j.text.length > 28 ? '…' : ''),
          text: j.text, rate: pcm.rate, samples,
          url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
        });
        const chapterEnds = k === jobs.length - 1 || jobs[k + 1].chapter !== j.chapter;
        if (chapterEnds) {
          state.audio.done[j.chapter] = true;
          if (toDrive) await saveChapterToDrive(j.chapter);
        }
        renderPlaylist();
        if (k === 0) loadChunk(0, false);
      }
      toast(toDrive ? '音声を作り、章ごとにドライブへ保存しました' : '音声を作りました');
    } catch (err) {
      if (err.code !== 'ABORT') toast(err.message, true);
      else if (state.audio.chunks.length) toast(`中断しました（${state.audio.chunks.length}個まで作成済み）`);
    } finally { setBusy(false); renderPlaylist(); }
  }

  function renderPlaylist() {
    const chunks = state.audio.chunks;
    $('#player').hidden = !chunks.length;
    $('#pl-list').innerHTML = chunks.map((c, i) => `<li data-i="${i}" class="${i === state.audio.index ? 'is-current' : ''}">${esc(c.label)}</li>`).join('');

    const p = state.novel.plot;
    const chs = [...new Set(chunks.map(c => c.chapter))];
    $('#pl-chapters').innerHTML = chs.map(i => {
      const pc = chapterPcm(i);
      const sec = pc ? pc.samples.length / pc.rate : 0;
      const title = p && p.chapters[i] ? p.chapters[i].title : '';
      const partial = !state.audio.done[i];
      const drive = state.audio.driveUrls[i];
      return `<li>
        <span class="plc-name">第${kanji(i + 1)}章　${esc(title)}<small>${fmtTime(sec)}${partial ? '（作成中・途中まで）' : ''}</small></span>
        <span class="plc-actions">
          <button type="button" class="btn ghost small" data-ch="${i}" data-fmt="mp3">MP3</button>
          <button type="button" class="btn ghost small" data-ch="${i}" data-fmt="wav">WAV</button>
          ${drive ? `<a href="${esc(drive)}" target="_blank" rel="noopener">ドライブ</a>` : ''}
        </span></li>`;
    }).join('');
  }

  function loadChunk(i, autoplay = true) {
    const c = state.audio.chunks[i];
    if (!c) return;
    state.audio.index = i;
    const a = $('#audio');
    a.src = c.url;
    $('#pl-now').textContent = c.text;
    renderPlaylist();
    if (autoplay) a.play().catch(() => {});
  }

  function stopAudio() {
    const a = $('#audio');
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
  }

  const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  async function downloadPcm(pc, baseName, fmt, btn) {
    if (!pc) return;
    if (fmt === 'wav') { download(`${baseName}.wav`, new Blob([pcmToWav(pc.samples, pc.rate)], { type: 'audio/wav' })); return; }
    const label = btn ? btn.textContent : '';
    try {
      if (btn) { btn.disabled = true; btn.textContent = '変換中…'; }
      const blob = await encodeMp3(pc.samples, pc.rate, r => { if (btn) btn.textContent = `変換中 ${Math.round(r * 100)}%`; });
      download(`${baseName}.mp3`, blob);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  function bindPlayer() {
    const a = $('#audio');
    $('#pl-play').addEventListener('click', () => {
      if (state.audio.index < 0) loadChunk(0);
      else if (a.paused) a.play().catch(() => {}); else a.pause();
    });
    $('#pl-prev').addEventListener('click', () => loadChunk(Math.max(0, state.audio.index - 1)));
    $('#pl-next').addEventListener('click', () => loadChunk(Math.min(state.audio.chunks.length - 1, state.audio.index + 1)));
    a.addEventListener('play', () => { $('#pl-play').textContent = '一時停止'; });
    a.addEventListener('pause', () => { $('#pl-play').textContent = '再生'; });
    a.addEventListener('ended', () => {
      if (state.audio.index < state.audio.chunks.length - 1) loadChunk(state.audio.index + 1);
    });
    a.addEventListener('timeupdate', () => {
      if (a.duration) $('#pl-seek').value = String(Math.round(a.currentTime / a.duration * 1000));
      $('#pl-time').textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`;
    });
    $('#pl-seek').addEventListener('input', e => { if (a.duration) a.currentTime = a.duration * num(e.target.value) / 1000; });
    $('#pl-list').addEventListener('click', e => {
      const li = e.target.closest('li'); if (li) loadChunk(num(li.dataset.i));
    });
    $('#pl-chapters').addEventListener('click', e => {
      const b = e.target.closest('[data-ch]'); if (!b) return;
      const i = num(b.dataset.ch);
      downloadPcm(chapterPcm(i), chapterFileName(i, '').replace(/\.$/, ''), b.dataset.fmt, b);
    });
    $('#pl-dl-one').addEventListener('click', () => {
      const c = state.audio.chunks[state.audio.index]; if (!c) return;
      download(`${safeFile(state.novel.title)}_${String(state.audio.index + 1).padStart(3, '0')}.wav`,
        new Blob([pcmToWav(c.samples, c.rate)], { type: 'audio/wav' }));
    });
    $('#pl-dl-all-mp3').addEventListener('click', e => downloadPcm(allPcm(), `${safeFile(state.novel.title)}_朗読`, 'mp3', e.currentTarget));
    $('#pl-dl-all').addEventListener('click', e => downloadPcm(allPcm(), `${safeFile(state.novel.title)}_朗読`, 'wav', e.currentTarget));
  }

  function parseWav(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const str = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
    if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
    let o = 12, fmt = null;
    while (o + 8 <= bytes.length) {
      const id = str(o, 4), size = v.getUint32(o + 4, true);
      if (id === 'fmt ') fmt = { channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
      if (id === 'data' && fmt) return Object.assign(fmt, { data: bytes.slice(o + 8, o + 8 + Math.min(size, bytes.length - o - 8)) });
      o += 8 + size + (size % 2);
    }
    return null;
  }

  /* ================= ロケ地（Google Earth Studio 用） ================= */
  function fullText() {
    const p = state.novel.plot;
    if (!p) return '';
    return p.chapters.map((c, i) => {
      const ch = state.novel.chapters[i];
      return ch && ch.text ? `【第${i + 1}章 ${c.title}】\n${ch.text}` : '';
    }).filter(Boolean).join('\n\n');
  }

  async function extractLocations() {
    const p = state.novel.plot;
    const text = fullText();
    if (!p || !text) { toast('先に本文を書いてください', true); return; }
    state.abort = new AbortController();
    setBusy(true, '本文からロケ地を拾っています…');
    try {
      const r = await gemini({ prompt: buildLocationPrompt(p, text.slice(0, 120000)), json: true, maxTokens: 8192, temperature: 0.2 });
      const data = parseJsonLoose(r.text);
      const list = (Array.isArray(data.locations) ? data.locations : [])
        .map(l => ({
          name: String(l.name || l.realPlace || ''),
          realPlace: String(l.realPlace || ''),
          fictional: !!l.fictional,
          chapter: num(l.chapter, 1),
          scene: String(l.scene || ''),
          lat: num(l.lat, NaN), lng: num(l.lng, NaN),
          groundAltitude: num(l.groundAltitude, 0),
          range: Math.min(50000, Math.max(100, num(l.range, 800))),
          tilt: Math.min(85, Math.max(0, num(l.tilt, 60))),
          heading: ((num(l.heading, 0) % 360) + 360) % 360,
          durationSec: Math.min(20, Math.max(2, num(l.durationSec, 6)))
        }))
        .filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng) && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180)
        .slice(0, C.LOCATION_MAX);
      if (!list.length) throw new Error('ロケ地を見つけられませんでした');
      state.novel.locations = list;
      saveDraft();
      renderLocations();
      toast(`${list.length}か所のロケ地を拾いました`);
    } catch (err) {
      if (err.code !== 'ABORT') toast(err.message, true);
    } finally { setBusy(false); }
  }

  function earthWebUrl(l) {
    return `https://earth.google.com/web/@${l.lat},${l.lng},${Math.round(l.groundAltitude)}a,${Math.round(l.range)}d,35y,${Math.round(l.heading)}h,${Math.round(l.tilt)}t,0r`;
  }

  function renderLocations() {
    const list = state.novel.locations || [];
    $('#loc-table').hidden = !list.length;
    $('#loc-body').innerHTML = list.map((l, i) => `
      <tr data-i="${i}">
        <td>${l.chapter}</td>
        <td><span class="loc-name">${esc(l.name)}</span>
          <span class="loc-scene">${esc(l.realPlace)}${l.fictional ? '（置き換え）' : ''}／${esc(l.scene)}</span></td>
        <td><input type="number" step="0.000001" data-k="lat" value="${l.lat}" aria-label="緯度"></td>
        <td><input type="number" step="0.000001" data-k="lng" value="${l.lng}" aria-label="経度"></td>
        <td><input type="number" step="10" data-k="range" value="${l.range}" aria-label="距離"></td>
        <td><input type="number" step="1" data-k="tilt" value="${l.tilt}" aria-label="傾き"></td>
        <td><input type="number" step="1" data-k="heading" value="${l.heading}" aria-label="方位"></td>
        <td><input type="number" step="1" data-k="durationSec" value="${l.durationSec}" aria-label="秒"></td>
        <td><a href="${esc(earthWebUrl(l))}" target="_blank" rel="noopener">下見</a></td>
      </tr>`).join('');
    refreshEarthButtons();
  }

  function refreshEarthButtons() {
    const has = (state.novel.locations || []).length > 0;
    $('#btn-kml').disabled = state.busy || !has;
    $('#btn-earth-json').disabled = state.busy || !has;
  }

  // LookAt（見る地点・距離・傾き・方位）からカメラ位置を計算
  function cameraFromLookAt(l) {
    const t = l.tilt * Math.PI / 180, h = l.heading * Math.PI / 180;
    const horiz = l.range * Math.sin(t);
    const up = l.range * Math.cos(t);
    const dN = -horiz * Math.cos(h), dE = -horiz * Math.sin(h);
    return {
      lat: +(l.lat + dN / 111320).toFixed(7),
      lng: +(l.lng + dE / (111320 * Math.cos(l.lat * Math.PI / 180))).toFixed(7),
      altitude: Math.round(l.groundAltitude + up)
    };
  }

  function buildKml() {
    const list = state.novel.locations;
    const title = state.novel.title || '無題';
    const lookAt = l => `<LookAt><longitude>${l.lng}</longitude><latitude>${l.lat}</latitude><altitude>${l.groundAltitude}</altitude><heading>${l.heading}</heading><tilt>${l.tilt}</tilt><range>${l.range}</range><altitudeMode>absolute</altitudeMode></LookAt>`;
    const marks = list.map(l => `
      <Placemark>
        <name>${xmlEsc(l.name)}</name>
        <description>${xmlEsc(`第${l.chapter}章／${l.realPlace}${l.fictional ? '（置き換え）' : ''}／${l.scene}`)}</description>
        ${lookAt(l)}
        <styleUrl>#loc</styleUrl>
        <Point><coordinates>${l.lng},${l.lat},0</coordinates></Point>
      </Placemark>`).join('');
    const tour = list.map(l => `
        <gx:FlyTo><gx:duration>${l.durationSec}</gx:duration><gx:flyToMode>smooth</gx:flyToMode>${lookAt(l)}</gx:FlyTo>
        <gx:Wait><gx:duration>2</gx:duration></gx:Wait>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${xmlEsc(title)} ロケ地</name>
    <Style id="loc"><IconStyle><scale>1.1</scale></IconStyle><LabelStyle><scale>1.0</scale></LabelStyle></Style>
    <Folder><name>ロケ地</name>${marks}
    </Folder>
    <gx:Tour>
      <name>${xmlEsc(title)} 空撮ツアー</name>
      <gx:Playlist>${tour}
      </gx:Playlist>
    </gx:Tour>
  </Document>
</kml>`;
  }

  function buildEarthJson() {
    let t = 0;
    const keyframes = state.novel.locations.map(l => {
      const start = t;
      t += l.durationSec + 2;
      return {
        timeSec: start + l.durationSec, // 到着時刻（ここに Earth Studio のキーフレームを打つ）
        holdSec: 2,
        name: l.name, realPlace: l.realPlace, fictional: l.fictional, chapter: l.chapter, scene: l.scene,
        target: { latitude: l.lat, longitude: l.lng, altitude: l.groundAltitude },
        lookAt: { range: l.range, tilt: l.tilt, heading: l.heading },
        camera: cameraFromLookAt(l)
      };
    });
    return {
      format: 'shosetsu-kobo/earth-studio-track',
      version: C.VERSION,
      title: state.novel.title,
      fps: 30,
      totalDurationSec: t,
      note: 'tilt: 0=真下, 90=水平 / heading: 0=北・時計回り / altitude: m（海抜）',
      keyframes
    };
  }

  function bindLocationTable() {
    $('#loc-body').addEventListener('change', e => {
      const inp = e.target.closest('input'); if (!inp) return;
      const l = state.novel.locations[num(inp.closest('tr').dataset.i)];
      l[inp.dataset.k] = num(inp.value, l[inp.dataset.k]);
      saveDraft();
      const a = inp.closest('tr').querySelector('a');
      if (a) a.href = earthWebUrl(l);
    });
  }

  /* ================= 書き出し・ドライブ保存 ================= */
  function buildMarkdown() {
    const n = state.novel, p = n.plot;
    if (!p) return '';
    const out = [`# ${p.title}`, '', p.logline ? `> ${p.logline}` : '', ''];
    p.chapters.forEach((c, i) => {
      const ch = n.chapters[i];
      if (!ch || !ch.text) return;
      out.push(`## 第${kanji(i + 1)}章　${c.title}`, '');
      ch.text.split('\n').forEach(l => out.push(l, ''));
    });
    return out.join('\n');
  }

  function buildPlainText() {
    const n = state.novel, p = n.plot;
    if (!p) return '';
    const out = [p.title, '', ''];
    p.chapters.forEach((c, i) => {
      const ch = n.chapters[i];
      if (!ch || !ch.text) return;
      out.push(`第${kanji(i + 1)}章　${c.title}`, '', ch.text, '', '');
    });
    return out.join('\n');
  }

  function hasText() {
    return state.novel.plot && state.novel.chapters.some(c => c && c.text);
  }

  // 読書用HTML（縦書き／横書き切替・印刷対応）
  function buildHtml() {
    const n = state.novel, p = n.plot;
    if (!p) return '';
    const body = p.chapters.map((c, i) => {
      const ch = n.chapters[i];
      if (!ch || !ch.text) return '';
      return `<section class="ch"><h2>第${kanji(i + 1)}章　${esc(c.title)}</h2>${ch.text.split('\n').map(l => `<p>${esc(l)}</p>`).join('')}</section>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<style>
:root{--bg:#F6F7F2;--ink:#1F2530;--muted:#5C6573;--rule:#C9CFC6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1C2129;--ink:#DADDD5;--muted:#8D96A3;--rule:#2E3540;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP",serif;font-size:17px;line-height:2}
.bar{position:sticky;top:0;z-index:1;display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;background:var(--bg);border-bottom:1px solid var(--rule);font-family:sans-serif;font-size:14px}
.bar button{font:inherit;padding:4px 12px;border:1px solid var(--rule);border-radius:6px;background:transparent;color:var(--ink);cursor:pointer}
main{max-width:40em;margin:0 auto;padding:32px 20px 64px}
h1{font-size:1.8em;letter-spacing:.1em;margin:0 0 .4em;font-weight:600}
.log{color:var(--muted);margin:0 0 2.4em}
h2{font-size:1.25em;letter-spacing:.08em;margin:2.4em 0 1.2em;font-weight:600}
p{margin:0}
body.v main{writing-mode:vertical-rl;max-width:none;height:calc(100vh - 52px);overflow-x:auto;padding:28px 32px;line-height:1.95}
body.v h1{margin:0 0 0 .4em}
body.v .log{margin:0 0 0 2.4em}
body.v h2{margin:0 2.4em 0 1.2em}
@media print{.bar{display:none}body{font-size:10.5pt;background:#fff;color:#000}body.v main{writing-mode:horizontal-tb;height:auto;overflow:visible;max-width:none;padding:0}.ch{break-before:page}}
</style>
</head>
<body class="v">
<div class="bar"><button type="button" id="mode">横書きにする</button><button type="button" onclick="print()">印刷・PDF</button></div>
<main>
<h1>${esc(p.title)}</h1>
${p.logline ? `<p class="log">${esc(p.logline)}</p>` : ''}
${body}
</main>
<script>
var b=document.getElementById('mode');
b.onclick=function(){document.body.classList.toggle('v');b.textContent=document.body.classList.contains('v')?'横書きにする':'縦書きにする';};
</script>
</body>
</html>`;
  }

  async function copyAll() {
    if (!hasText()) { toast('まだ本文がありません', true); return; }
    const text = buildPlainText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(`全文（${fmtNum(text.length)}字）をコピーしました`);
  }

  function exportAll(fmt) {
    if (!hasText()) { toast('まだ本文がありません', true); return; }
    const base = safeFile(state.novel.title);
    if (fmt === 'txt') download(`${base}.txt`, buildPlainText(), 'text/plain;charset=utf-8');
    if (fmt === 'md') download(`${base}.md`, buildMarkdown(), 'text/markdown;charset=utf-8');
    if (fmt === 'html') download(`${base}.html`, buildHtml(), 'text/html;charset=utf-8');
  }

  function snapshot() {
    const n = state.novel;
    return {
      novelId: n.novelId, title: n.title || (n.plot && n.plot.title) || '無題',
      settings: n.settings || readSettings(), plot: n.plot,
      chapters: n.chapters, locations: n.locations, appVersion: C.VERSION
    };
  }

  async function saveToDrive(silent = false) {
    if (!state.novel.plot) { if (!silent) toast('保存する作品がありません', true); return; }
    const own = !silent;
    if (own) { state.abort = new AbortController(); setBusy(true, 'Googleドライブに保存しています…'); }
    try {
      const hasLoc = (state.novel.locations || []).length > 0;
      const r = await api('saveNovel', {
        novel: snapshot(),
        exports: {
          markdown: buildMarkdown(),
          text: buildPlainText(),
          html: buildHtml(),
          plotJson: JSON.stringify(state.novel.plot, null, 2),
          earthJson: hasLoc ? JSON.stringify(buildEarthJson(), null, 2) : '',
          kml: hasLoc ? buildKml() : ''
        }
      }, { signal: state.abort && state.abort.signal });
      state.novel.novelId = r.novelId;
      saveDraft();
      $('#drive-link').innerHTML = `保存しました：<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener">ドライブのフォルダを開く</a>`;
      if (own) toast('Googleドライブに保存しました');
      loadWorks();
    } catch (err) {
      if (!own) throw err;
      if (err.code !== 'ABORT') toast(err.message, true);
    } finally { if (own) setBusy(false); }
  }

  async function loadWorks() {
    const ul = $('#works-list');
    try {
      const r = await api('listNovels', {});
      if (!r.novels.length) { ul.innerHTML = '<li class="work-meta">まだ保存した作品はありません。</li>'; return; }
      ul.innerHTML = r.novels.map(n => `<li>
        <span class="work-title">${esc(n.title)}</span>
        <span class="work-meta">${n.chapterCount}章・${fmtNum(n.charCount)}字・${esc(String(n.updatedAt).slice(0, 16).replace('T', ' '))}</span>
        <a href="${esc(n.folderUrl)}" target="_blank" rel="noopener">ドライブ</a>
        <button type="button" class="btn ghost small" data-load="${esc(n.novelId)}">開く</button>
        <button type="button" class="btn ghost small" data-del="${esc(n.novelId)}">削除</button>
      </li>`).join('');
    } catch (err) {
      if (err.code !== 'AUTH') ul.innerHTML = `<li class="work-meta">一覧を読み込めませんでした：${esc(err.message)}</li>`;
    }
  }

  async function openWork(id) {
    if (state.novel.plot && !confirm('今の作品を閉じて、保存した作品を開きます。保存していない変更は消えます。')) return;
    state.abort = new AbortController();
    setBusy(true, '作品を読み込んでいます…');
    try {
      const r = await api('loadNovel', { novelId: id }, { signal: state.abort.signal });
      const n = r.novel;
      state.novel = Object.assign(blankNovel(), n, { novelId: id });
      state.current = 0;
      writeSettings(n.settings);
      saveDraft();
      renderAll();
      showPanel('write');
      toast(`『${state.novel.title}』を開きました`);
    } catch (err) {
      if (err.code !== 'ABORT') toast(err.message, true);
    } finally { setBusy(false); }
  }

  async function deleteWork(id) {
    if (!confirm('この作品をドライブから削除します（ゴミ箱へ移動）。よろしいですか？')) return;
    try {
      await api('deleteNovel', { novelId: id });
      if (state.novel.novelId === id) { state.novel.novelId = null; saveDraft(); }
      toast('削除しました');
      loadWorks();
    } catch (err) { toast(err.message, true); }
  }

  function newWork() {
    if (state.novel.plot && !confirm('新しい作品を始めます。今の作品は下書きから消えます（ドライブに保存済みのものは残ります）。')) return;
    state.novel = blankNovel();
    state.current = 0;
    stopAudio();
    state.audio.chunks.forEach(c => URL.revokeObjectURL(c.url));
    state.audio = { chunks: [], index: -1, done: {}, driveUrls: {} };
    writeSettings(C.DEFAULTS);
    $('#drive-link').textContent = '';
    saveDraft();
    renderAll();
    showPanel('settings');
  }

  /* ================= 下書き（ブラウザ内） ================= */
  const saveDraft = debounce(() => {
    state.novel.updatedAt = new Date().toISOString();
    store.set(LS.draft, state.novel);
  }, 400);

  function restoreDraft() {
    const d = store.get(LS.draft);
    if (d && typeof d === 'object') {
      state.novel = Object.assign(blankNovel(), d);
      if (d.settings) writeSettings(d.settings);
    }
  }

  /* ================= 画面切り替え・描画 ================= */
  function showPanel(name) {
    $$('.step').forEach(b => b.classList.toggle('is-active', b.dataset.panel === name));
    $$('.panel').forEach(p => p.classList.toggle('is-active', p.id === 'panel-' + name));
    if (name === 'voice') renderVoiceOptions();
    window.scrollTo({ top: 0 });
  }

  function renderSteps() {
    const n = state.novel;
    const done = {
      settings: !!n.plot,
      plot: !!n.plot,
      write: !!n.plot && n.plot.chapters.every((_, i) => n.chapters[i] && n.chapters[i].text),
      voice: state.audio.chunks.length > 0,
      earth: (n.locations || []).length > 0,
      library: !!n.novelId
    };
    $$('.step').forEach(b => b.classList.toggle('is-done', !!done[b.dataset.panel]));
  }

  function renderAll() {
    renderPlot();
    renderWrite();
    renderVoiceOptions();
    renderLocations();
    renderSteps();
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ================= テーマ・閲覧設定 ================= */
  function toggleTheme() {
    const root = document.documentElement;
    const isDark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = isDark ? 'light' : 'dark';
    try { localStorage.setItem(LS.theme, root.dataset.theme); } catch (e) {}
  }

  function saveReader() { store.set(LS.reader, state.reader); }

  /* ================= 使い方 ================= */
  function openGuide() {
    const m = $('#guide-modal');
    if ($('#pw-modal').open) return; // パスワード変更中は出さない
    if (!m.open) m.showModal();
    m.querySelector('.guide-body').scrollTop = 0;
    store.set(LS.guide, true);
  }
  // 初めてアプリ本体を開いたときに1回だけ自動で表示
  function maybeShowGuide() {
    if (!store.get(LS.guide)) openGuide();
  }

  /* ================= イベント登録・起動 ================= */
  function bind() {
    $$('.auth-tab').forEach(t => t.addEventListener('click', () => switchAuthTab(t.dataset.auth)));
    $('#form-login').addEventListener('submit', handleLogin);
    $('#form-register').addEventListener('submit', handleRegister);
    $('#form-reset').addEventListener('submit', handleReset);
    $('#form-pw').addEventListener('submit', handlePwChange);
    $('#pw-modal').addEventListener('cancel', e => { if ($('#pw-modal').dataset.force) e.preventDefault(); });
    $('#pw-cancel').addEventListener('click', () => $('#pw-modal').close());
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-guide').addEventListener('click', openGuide);
    $('#guide-close').addEventListener('click', () => $('#guide-modal').close());
    $('#guide-modal').addEventListener('click', e => { if (e.target.id === 'guide-modal') $('#guide-modal').close(); });
    $('#user-name').addEventListener('click', () => openPwModal(false));
    $('#user-name').title = 'パスワードを変更する';
    $('#user-name').style.cursor = 'pointer';

    $$('.step').forEach(b => b.addEventListener('click', () => showPanel(b.dataset.panel)));
    $('#btn-abort').addEventListener('click', () => { if (state.abort) state.abort.abort(); status('中断しています…'); });

    $('#form-settings').addEventListener('submit', generatePlot);
    $('#btn-new').addEventListener('click', newWork);
    $('#btn-replot').addEventListener('click', () => { showPanel('settings'); generatePlot(); });
    $('#btn-to-write').addEventListener('click', () => showPanel('write'));
    bindPlotEditor();

    $('#toc-list').addEventListener('click', e => {
      const b = e.target.closest('.toc-item'); if (!b) return;
      if (state.editing) endEdit(false);
      state.current = num(b.dataset.i);
      renderWrite();
    });
    $('#btn-write-one').addEventListener('click', writeOne);
    $('#btn-copy-all').addEventListener('click', copyAll);
    $$('[data-export]').forEach(b => b.addEventListener('click', () => exportAll(b.dataset.export)));
    $('#btn-write-all').addEventListener('click', writeAll);
    $('#btn-vertical').addEventListener('click', () => { state.reader.vertical = !state.reader.vertical; saveReader(); renderReader(); });
    $('#btn-font-up').addEventListener('click', () => { state.reader.size = Math.min(1.5, +(state.reader.size + 0.0625).toFixed(4)); saveReader(); renderReader(); });
    $('#btn-font-down').addEventListener('click', () => { state.reader.size = Math.max(0.875, +(state.reader.size - 0.0625).toFixed(4)); saveReader(); renderReader(); });
    $('#btn-edit').addEventListener('click', startEdit);
    $('#btn-edit-save').addEventListener('click', () => endEdit(true));
    $('#btn-edit-cancel').addEventListener('click', () => endEdit(false));

    fillSelect($('#tts-voice'), C.TTS_VOICES);
    $('#tts-voice').value = C.DEFAULTS.voice;
    $('#btn-tts').addEventListener('click', generateTts);
    bindPlayer();

    $('#btn-extract').addEventListener('click', extractLocations);
    $('#btn-kml').addEventListener('click', () => download(`${safeFile(state.novel.title)}_ロケ地.kml`, buildKml(), 'application/vnd.google-earth.kml+xml'));
    $('#btn-earth-json').addEventListener('click', () => download(`${safeFile(state.novel.title)}_earth_studio.json`, JSON.stringify(buildEarthJson(), null, 2), 'application/json'));
    bindLocationTable();

    $('#btn-save-drive').addEventListener('click', () => saveToDrive(false));
    $('#btn-dl-md').addEventListener('click', () => exportAll('md'));
    $('#btn-dl-txt').addEventListener('click', () => exportAll('txt'));
    $('#btn-dl-html').addEventListener('click', () => exportAll('html'));
    $('#btn-dl-plot').addEventListener('click', () => { if (state.novel.plot) download(`${safeFile(state.novel.title)}_構成.json`, JSON.stringify(state.novel.plot, null, 2), 'application/json'); });
    $('#btn-refresh-list').addEventListener('click', loadWorks);
    $('#works-list').addEventListener('click', e => {
      const l = e.target.closest('[data-load]'); if (l) return openWork(l.dataset.load);
      const d = e.target.closest('[data-del]'); if (d) return deleteWork(d.dataset.del);
    });

    // 画面変化のたびに手順の完了表示を更新
    new MutationObserver(debounce(renderSteps, 200)).observe($('#app'), { childList: true, subtree: true });
    window.addEventListener('beforeunload', e => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function boot() {
    document.title = C.APP_NAME;
    $('#app-name').textContent = C.APP_NAME;
    $('#app-version').textContent = C.VERSION;
    $('#app-updated').textContent = C.UPDATED;
    $('#foot-version').textContent = `${C.APP_NAME} ${C.VERSION}（最終更新 ${C.UPDATED}）`;

    const r = store.get(LS.reader);
    if (r) state.reader = Object.assign(state.reader, r);

    initPwToggles();
    initSettingsForm();
    bind();
    restoreDraft();

    const sess = store.get(LS.session);
    if (sess && sess.token) {
      state.token = sess.token; state.user = sess.user;
      try {
        const me = await api('me', {});
        state.user = me.user;
        store.set(LS.session, { token: state.token, user: state.user });
        showApp();
        if (me.user.status === 'FIRST_LOGIN') openPwModal(true);
        return;
      } catch (e) {
        if (e.code !== 'AUTH') { showAuth(); authMsg(e.message, 'error'); return; }
      }
    }
    showAuth();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

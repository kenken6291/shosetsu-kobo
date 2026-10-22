/* 今日は何をしよう — フロントエンド（app.js） */
'use strict';

(() => {
  /* ============================== 基本ユーティリティ ============================== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動作は続ける */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } }
  };
  const KEY = { token: 'kn_token', items: 'kn_items', mode: 'kn_mode', theme: 'kn_theme' };

  const DEFAULT_ITEMS = ['近所を散歩する', '本を1章だけ読む', '部屋を10分片付ける', '新しいレシピに挑戦', '20分だけ昼寝', '気になっていたカフェへ行く'];
  const MODE_LABEL = { roulette: 'ルーレット', amida: 'あみだくじ', trump: 'トランプ', omikuji: 'おみくじ' };
  const MODE_BUTTON = { roulette: 'ルーレットを回す', amida: 'あみだをたどる', trump: 'カードを配る', omikuji: 'おみくじを振る' };
  const MODE_HINT = {
    roulette: '',
    amida: '上の番号をタップするとそこから出発します。線の間をタップすると横線を足せます。',
    trump: '配ったあと、好きなカードを1枚めくってください。',
    omikuji: ''
  };
  const OUTCOME_LABEL = { followed: 'くじどおりにやった', rebel: 'くじに逆らった', skipped: 'やらなかった' };
  const FACES = ['', '😫', '🙁', '😐', '🙂', '😆'];
  const SCORE_COLORS = ['', '#8FA3C4', '#A9B7D6', '#C9C9B0', '#F6C454', '#F2A3AE'];
  const WEEK = ['月', '火', '水', '木', '金', '土', '日'];

  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.8 10.8 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.1-5.9M9.9 5.2A9.9 9.9 0 0 1 12 5c7 0 11 7 11 7a19.6 19.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const wheelColors = () => ['--w1', '--w2', '--w3', '--w4', '--w5', '--w6'].map(cssVar);

  function randInt(n) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return s || '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return `${+m[2]}月${+m[3]}日（${'日月火水木金土'[d.getDay()]}）`;
  }
  function kanjiNum(n) {
    const d = '〇一二三四五六七八九';
    if (n < 10) return d[n];
    if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
    return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  /* ============================== 状態 ============================== */
  const state = {
    token: LS.get(KEY.token, null),
    user: null,
    items: LS.get(KEY.items, DEFAULT_ITEMS.slice()),
    mode: LS.get(KEY.mode, CONFIG.DEFAULT_MODE || 'roulette'),
    sets: [],
    drawing: false,
    lastDraw: null,
    lastDrawSaving: null,
    linkedDraw: null,
    editingId: null,
    photos: [],
    diaries: [],
    diaryTotal: 0,
    stats: null,
    persona: null
  };
  if (!Array.isArray(state.items) || state.items.length < 2) state.items = DEFAULT_ITEMS.slice();
  if (!MODE_LABEL[state.mode]) state.mode = 'roulette';

  /* ============================== 通知・通信 ============================== */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
  }

  let busyCount = 0;
  function busy(on, text) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    if (on && text) $('#busyText').textContent = text;
    if (on && !text) $('#busyText').textContent = '通信中…';
    $('#busy').hidden = busyCount === 0;
  }

  async function api(action, payload = {}, opts = {}) {
    if (!CONFIG.GAS_API_URL || CONFIG.GAS_API_URL.includes('XXXX')) {
      throw new Error('config.js の GAS_API_URL を設定してください');
    }
    if (!opts.silent) busy(true, opts.busyText);
    try {
      let res;
      try {
        res = await fetch(CONFIG.GAS_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...payload, action, token: state.token })
        });
      } catch {
        throw new Error('サーバーにつながりません。通信状態を確認してください');
      }
      if (!res.ok) throw new Error(`サーバーに接続できませんでした（${res.status}）`);
      const data = await res.json();
      if (!data.ok) {
        if (data.code === 'SESSION_EXPIRED' && action !== 'login') {
          clearSession();
          showView('auth');
        } else if (data.code === 'MUST_CHANGE') {
          openChange(true);
        }
        const err = new Error(data.message || 'エラーが発生しました');
        err.code = data.code;
        throw err;
      }
      return data;
    } finally {
      if (!opts.silent) busy(false);
    }
  }

  /* ============================== 画面切り替え ============================== */
  function showView(name) {
    $('#authView').hidden = name !== 'auth';
    $('#changeView').hidden = name !== 'change';
    $('#mainView').hidden = name !== 'main';
    $('#logoutBtn').hidden = name === 'auth';
    $('#openChangeBtn').hidden = name !== 'main';
    $('#userName').hidden = name !== 'main';
    if (state.user) $('#userName').textContent = `${state.user.nickname} さん`;
    window.scrollTo(0, 0);
  }

  function switchTab(name) {
    $$('.tab-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    if (name === 'draw') requestAnimationFrame(relayoutStage);
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    LS.del(KEY.token);
  }

  /* ============================== テーマ ============================== */
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: '自動', light: 'ライト', dark: 'ダーク' };
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('#themeBtn').textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐';
    $('#themeBtn').setAttribute('aria-label', `表示テーマ：${THEME_LABEL[t]}（押して切り替え）`);
    requestAnimationFrame(relayoutStage);
  }

  /* ============================== 認証 ============================== */
  function setAuthTab(name) {
    $$('[data-auth]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.auth === name)));
    $$('[data-auth-form]').forEach((f) => { f.hidden = f.dataset.authForm !== name; });
    setMsg('#authMsg', '');
  }

  function setMsg(sel, text, isError = false) {
    const el = $(sel);
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  function wirePasswordToggles() {
    $$('.pw-toggle').forEach((btn) => {
      btn.innerHTML = EYE;
      btn.addEventListener('click', () => {
        const input = btn.previousElementSibling;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? EYE_OFF : EYE;
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      });
    });
  }

  function openChange(force) {
    $('#changeForm').reset();
    $$('#changeForm input').forEach((i) => { if (i.type === 'text') i.type = 'password'; });
    $$('#changeForm .pw-toggle').forEach((b) => { b.innerHTML = EYE; b.setAttribute('aria-pressed', 'false'); });
    $('#changeCancel').hidden = !!force;
    $('#changeLead').textContent = force
      ? '仮パスワードのままでは使えません。英字と数字をまぜた8文字以上にしてください。'
      : '英字と数字をまぜた8文字以上にしてください。';
    setMsg('#changeMsg', '');
    showView('change');
  }

  async function onLogin(e) {
    e.preventDefault();
    setMsg('#authMsg', '');
    try {
      const r = await api('login', { email: $('#loginEmail').value.trim(), password: $('#loginPassword').value }, { busyText: 'ログイン中…' });
      state.token = r.token;
      state.user = r.user;
      LS.set(KEY.token, r.token);
      $('#loginPassword').value = '';
      if (r.user.mustChange) openChange(true);
      else enterMain();
    } catch (err) {
      setMsg('#authMsg', err.message, true);
    }
  }

  async function onRegister(e) {
    e.preventDefault();
    setMsg('#authMsg', '');
    const email = $('#regEmail').value.trim();
    try {
      const r = await api('register', { email, nickname: $('#regNickname').value.trim() }, { busyText: '登録中…' });
      setAuthTab('login');
      $('#loginEmail').value = email;
      let msg = r.message;
      if (r.tempPassword) msg += `（テスト表示）仮パスワード：${r.tempPassword}`;
      setMsg('#authMsg', msg);
      $('#registerForm').reset();
    } catch (err) {
      setMsg('#authMsg', err.message, true);
    }
  }

  async function onReset(e) {
    e.preventDefault();
    setMsg('#authMsg', '');
    const email = $('#resetEmail').value.trim();
    try {
      const r = await api('resetPassword', { email }, { busyText: '再発行中…' });
      setAuthTab('login');
      $('#loginEmail').value = email;
      setMsg('#authMsg', r.message);
    } catch (err) {
      setMsg('#authMsg', err.message, true);
    }
  }

  async function onChangePassword(e) {
    e.preventDefault();
    const cur = $('#curPassword').value;
    const next = $('#newPassword').value;
    if (next !== $('#newPassword2').value) return setMsg('#changeMsg', '新しいパスワードが確認欄と一致しません', true);
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) {
      return setMsg('#changeMsg', '英字と数字をまぜた8文字以上にしてください', true);
    }
    try {
      const r = await api('changePassword', { currentPassword: cur, newPassword: next }, { busyText: '変更中…' });
      state.user = r.user;
      toast('パスワードを変更しました');
      enterMain();
    } catch (err) {
      setMsg('#changeMsg', err.message, true);
    }
  }

  async function onLogout() {
    try { await api('logout', {}, { silent: true }); } catch { /* 期限切れでも続行 */ }
    clearSession();
    stopListening();
    setAuthTab('login');
    showView('auth');
  }

  let mainReady = false;
  function enterMain() {
    showView('main');
    if (!mainReady) {
      mainReady = true;
      renderItems();
      setMode(state.mode);
      resetDiaryForm();
    }
    switchTab('draw');
    loadSets();
    loadDiaries(true);
  }

  /* ============================== 選択肢 ============================== */
  function renderItems() {
    const ul = $('#itemList');
    ul.innerHTML = '';
    const colors = wheelColors();
    state.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--dot', colors[i % colors.length]);
      li.innerHTML = `<input type="text" maxlength="60" aria-label="選択肢${i + 1}"><button type="button" class="icon-btn del" aria-label="「${esc(it)}」を削除">×</button>`;
      const inp = li.querySelector('input');
      inp.value = it;
      inp.addEventListener('change', () => {
        const v = inp.value.trim();
        if (v) state.items[i] = v;
        else if (state.items.length > 2) state.items.splice(i, 1);
        else inp.value = state.items[i];
        saveItems();
      });
      li.querySelector('.del').addEventListener('click', () => {
        if (state.items.length <= 2) return toast('選択肢は2個以上必要です');
        state.items.splice(i, 1);
        saveItems();
      });
      ul.appendChild(li);
    });
    $('#itemCount').textContent = state.items.length;
  }

  function saveItems() {
    LS.set(KEY.items, state.items);
    renderItems();
    mountStage();
  }

  async function loadSets() {
    try {
      const r = await api('listSets', {}, { silent: true });
      state.sets = r.sets || [];
      renderSets();
    } catch { /* セットが読めなくても抽選はできる */ }
  }

  function renderSets() {
    const sel = $('#setSelect');
    sel.innerHTML = '<option value="">保存したセットを読み込む</option>' +
      state.sets.map((s) => `<option value="${esc(s.setId)}">${esc(s.name)}（${s.items.length}個）</option>`).join('');
    $('#deleteSetBtn').disabled = true;
  }

  /* ============================== 抽選エンジン ============================== */

  // ---- ルーレット ----
  const Roulette = {
    angle: 0,
    mount(stage, items) {
      this.items = items;
      stage.innerHTML = '<div class="wheel-wrap"><canvas class="wheel" role="img" aria-label="ルーレット"></canvas><div class="wheel-pointer" aria-hidden="true"></div></div>';
      this.canvas = stage.querySelector('canvas');
      this.relayout();
    },
    relayout() {
      if (!this.canvas || !this.canvas.isConnected) return;
      const size = Math.max(240, Math.min(this.canvas.parentElement.clientWidth || 320, 420));
      const dpr = window.devicePixelRatio || 1;
      this.size = size;
      this.dpr = dpr;
      this.canvas.width = size * dpr;
      this.canvas.height = size * dpr;
      this.canvas.style.width = this.canvas.style.height = size + 'px';
      this.draw();
    },
    draw() {
      const ctx = this.canvas.getContext('2d');
      const s = this.size, cx = s / 2, cy = s / 2, r = s / 2 - 6;
      const n = this.items.length, seg = Math.PI * 2 / n;
      const colors = wheelColors();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, s, s);
      for (let i = 0; i < n; i++) {
        const a0 = this.angle + i * seg;
        let ci = i % colors.length;
        if (i === n - 1 && n % colors.length === 1 && n > 1) ci = (ci + 2) % colors.length; // 隣と同色を避ける
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, a0, a0 + seg);
        ctx.closePath();
        ctx.fillStyle = colors[ci];
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#1C2A4A';
        ctx.stroke();

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a0 + seg / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1C2A4A';
        const fs = Math.max(11, Math.min(17, s / (n > 12 ? 30 : 22)));
        ctx.font = `700 ${fs}px "Zen Maru Gothic", sans-serif`;
        ctx.fillText(fitText(ctx, this.items[i], r * 0.78 - 10), r - 12, 0);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#1C2A4A';
      ctx.stroke();
    },
    run() {
      return new Promise((resolve) => {
        const TAU = Math.PI * 2;
        const n = this.items.length, seg = TAU / n, idx = randInt(n);
        const jitter = (Math.random() - 0.5) * seg * 0.7;
        const target = -Math.PI / 2 - (idx + 0.5) * seg + jitter; // 針は真上
        const delta = (((target - this.angle) % TAU) + TAU) % TAU;
        const start = this.angle;
        const end = start + delta + (reduceMotion ? 1 : 6) * TAU;
        const dur = reduceMotion ? 600 : 4800;
        const t0 = performance.now();
        const step = (t) => {
          const p = Math.min(1, (t - t0) / dur);
          this.angle = start + (end - start) * (1 - Math.pow(1 - p, 4));
          this.draw();
          if (p < 1) requestAnimationFrame(step);
          else {
            this.angle = end % TAU;
            resolve({ result: this.items[idx] });
          }
        };
        requestAnimationFrame(step);
      });
    }
  };

  // ---- あみだくじ ----
  const Amida = {
    ROWS: 14,
    mount(stage, items) {
      this.items = items;
      this.n = items.length;
      this.bottom = shuffle(items.slice());
      this.rungs = this.makeRungs();
      this.start = null;
      this.path = null;
      this.progress = 0;
      this.revealed = false;
      this.endCol = null;
      stage.innerHTML = '<div class="amida-scroll"><canvas class="amida" role="img" aria-label="あみだくじ"></canvas></div>';
      this.wrap = stage.querySelector('.amida-scroll');
      this.canvas = stage.querySelector('canvas');
      this.canvas.addEventListener('click', (e) => this.onClick(e));
      this.relayout();
    },
    makeRungs() {
      const set = new Set();
      for (let r = 0; r < this.ROWS; r++) {
        for (let g = 0; g < this.n - 1; g++) {
          if (set.has(`${r}:${g - 1}`)) continue;
          if (Math.random() < 0.3) set.add(`${r}:${g}`);
        }
      }
      for (let g = 0; g < this.n - 1; g++) {
        let has = false;
        for (let r = 0; r < this.ROWS; r++) if (set.has(`${r}:${g}`)) has = true;
        if (has) continue;
        for (let t = 0; t < 30; t++) {
          const r = randInt(this.ROWS);
          if (!set.has(`${r}:${g - 1}`) && !set.has(`${r}:${g + 1}`)) { set.add(`${r}:${g}`); break; }
        }
      }
      return set;
    },
    relayout() {
      if (!this.canvas || !this.canvas.isConnected) return;
      const cw = this.wrap.clientWidth || 320;
      this.spacing = Math.max(64, Math.min(110, (cw - 16) / this.n));
      this.w = Math.max(cw, this.spacing * this.n);
      this.h = 430;
      this.top = 50;
      this.bottomY = this.h - 64;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = this.w * this.dpr;
      this.canvas.height = this.h * this.dpr;
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      this.draw();
    },
    x(i) { return (this.w - this.spacing * this.n) / 2 + this.spacing * (i + 0.5); },
    rowY(r) { return this.top + 20 + (this.bottomY - this.top - 40) * (r + 0.5) / this.ROWS; },
    onClick(e) {
      if (state.drawing || this.path) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (y < this.top + 16) {
        const i = Math.round((x - this.x(0)) / this.spacing);
        if (i >= 0 && i < this.n) { this.start = i; startDraw(); }
        return;
      }
      if (y > this.bottomY - 8) return;
      const g = Math.floor((x - this.x(0)) / this.spacing);
      if (g < 0 || g >= this.n - 1) return;
      let r = Math.round(((y - this.top - 20) / (this.bottomY - this.top - 40)) * this.ROWS - 0.5);
      r = Math.max(0, Math.min(this.ROWS - 1, r));
      const k = `${r}:${g}`;
      if (this.rungs.has(k)) {
        this.rungs.delete(k);
      } else if (this.rungs.has(`${r}:${g - 1}`) || this.rungs.has(`${r}:${g + 1}`)) {
        return toast('となりの横線と同じ高さには引けません');
      } else {
        this.rungs.add(k);
      }
      this.draw();
    },
    computePath(start) {
      let c = start;
      const pts = [[this.x(c), this.top + 14]];
      for (let r = 0; r < this.ROWS; r++) {
        const y = this.rowY(r);
        if (this.rungs.has(`${r}:${c}`)) { pts.push([this.x(c), y]); c++; pts.push([this.x(c), y]); }
        else if (this.rungs.has(`${r}:${c - 1}`)) { pts.push([this.x(c), y]); c--; pts.push([this.x(c), y]); }
      }
      pts.push([this.x(c), this.bottomY - 14]);
      return { pts, end: c };
    },
    draw() {
      const ctx = this.canvas.getContext('2d');
      const ink = cssVar('--ink'), sun = cssVar('--sun'), card = cssVar('--card'), soft = cssVar('--ink-soft');
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.lineCap = 'round';

      ctx.strokeStyle = ink;
      ctx.lineWidth = 3;
      for (let i = 0; i < this.n; i++) {
        ctx.beginPath();
        ctx.moveTo(this.x(i), this.top + 14);
        ctx.lineTo(this.x(i), this.bottomY - 14);
        ctx.stroke();
      }
      this.rungs.forEach((k) => {
        const [r, g] = k.split(':').map(Number);
        const y = this.rowY(r);
        ctx.beginPath();
        ctx.moveTo(this.x(g), y);
        ctx.lineTo(this.x(g + 1), y);
        ctx.stroke();
      });

      if (this.path) {
        ctx.strokeStyle = sun;
        ctx.lineWidth = 7;
        ctx.beginPath();
        let remain = this.progress;
        ctx.moveTo(...this.path[0]);
        for (let i = 1; i < this.path.length && remain > 0; i++) {
          const [x0, y0] = this.path[i - 1], [x1, y1] = this.path[i];
          const len = Math.hypot(x1 - x0, y1 - y0);
          if (remain >= len) { ctx.lineTo(x1, y1); remain -= len; this.head = [x1, y1]; }
          else { const t = remain / len; this.head = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]; ctx.lineTo(...this.head); remain = 0; }
        }
        ctx.stroke();
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < this.n; i++) {
        const x = this.x(i);
        ctx.beginPath();
        ctx.arc(x, this.top - 6, 16, 0, Math.PI * 2);
        ctx.fillStyle = this.start === i ? sun : card;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ink;
        ctx.stroke();
        ctx.fillStyle = this.start === i ? '#1C2A4A' : ink;
        ctx.font = '700 15px "Zen Maru Gothic", sans-serif';
        ctx.fillText(String(i + 1), x, this.top - 5);

        const label = this.revealed ? this.bottom[i] : '？';
        const hit = this.revealed && this.endCol === i;
        ctx.font = `700 ${this.revealed ? 13 : 18}px "Zen Maru Gothic", sans-serif`;
        if (hit) {
          ctx.fillStyle = sun;
          ctx.fillRect(x - this.spacing / 2 + 4, this.bottomY + 2, this.spacing - 8, 36);
        }
        ctx.fillStyle = hit ? '#1C2A4A' : (this.revealed ? soft : ink);
        ctx.fillText(fitText(ctx, label, this.spacing - 12), x, this.bottomY + 20);
      }
    },
    run() {
      if (this.revealed) this.mount(this.wrap.parentElement, this.items); // 引き直し
      return new Promise((resolve) => {
        if (this.start === null) this.start = randInt(this.n);
        const { pts, end } = this.computePath(this.start);
        this.path = pts;
        this.endCol = end;
        let total = 0;
        for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const dur = reduceMotion ? 400 : Math.min(5200, 1600 + total * 2.2);
        const t0 = performance.now();
        const step = (t) => {
          const p = Math.min(1, (t - t0) / dur);
          this.progress = total * p;
          this.draw();
          if (this.head && this.wrap.scrollWidth > this.wrap.clientWidth) {
            this.wrap.scrollLeft = this.head[0] - this.wrap.clientWidth / 2;
          }
          if (p < 1) requestAnimationFrame(step);
          else {
            this.revealed = true;
            this.draw();
            resolve({ result: this.bottom[end] });
          }
        };
        requestAnimationFrame(step);
      });
    }
  };

  // ---- トランプ ----
  const SUITS = [{ s: '♠', red: false }, { s: '♥', red: true }, { s: '♦', red: true }, { s: '♣', red: false }];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const Trump = {
    mount(stage, items) {
      this.stage = stage;
      this.items = items;
      const cards = shuffle(items.map((item, i) => ({ item, suit: SUITS[i % 4], rank: RANKS[randInt(13)] })));
      stage.innerHTML = '<div class="card-table"></div>';
      this.table = stage.querySelector('.card-table');
      cards.forEach((cd, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pcard';
        b.disabled = true;
        b.setAttribute('aria-label', `${i + 1}枚目のカード`);
        b.innerHTML = `<span class="pcard-inner"><span class="pcard-back"></span><span class="pcard-face ${cd.suit.red ? 'red' : ''}"><span class="pc-corner">${cd.rank}${cd.suit.s}</span><span class="pc-item">${esc(cd.item)}</span><span class="pc-corner rev">${cd.rank}${cd.suit.s}</span></span></span>`;
        b.dataset.item = cd.item;
        this.table.appendChild(b);
      });
    },
    run() {
      return new Promise((resolve) => {
        this.mount(this.stage, this.items); // 配り直し
        const cards = $$('.pcard', this.table);
        cards.forEach((c) => {
          c.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
          c.style.setProperty('--dy', `${(Math.random() - 0.5) * 60}px`);
          c.style.setProperty('--rot', `${(Math.random() - 0.5) * 40}deg`);
        });
        this.table.classList.add('shuffling');
        setTimeout(() => {
          this.table.classList.remove('shuffling');
          setHint('好きなカードを1枚めくってください');
          cards.forEach((c) => {
            c.disabled = false;
            c.addEventListener('click', () => {
              cards.forEach((x) => { x.disabled = true; });
              c.classList.add('flipped');
              setTimeout(() => {
                cards.forEach((x) => { if (x !== c) x.classList.add('flipped', 'dim'); });
                resolve({ result: c.dataset.item });
              }, reduceMotion ? 150 : 900);
            }, { once: true });
          });
          cards[0].focus();
        }, reduceMotion ? 100 : 1000);
      });
    }
  };

  // ---- おみくじ ----
  const FORTUNES = [['大吉', 14], ['中吉', 22], ['小吉', 20], ['吉', 22], ['末吉', 16], ['凶', 6]];
  function pickFortune() {
    const total = FORTUNES.reduce((a, f) => a + f[1], 0);
    let r = randInt(total);
    for (const [name, w] of FORTUNES) { if (r < w) return name; r -= w; }
    return '吉';
  }
  const Omikuji = {
    mount(stage, items) {
      this.items = items;
      stage.innerHTML = `
        <div class="omikuji">
          <div class="mk-box" aria-hidden="true">
            <span class="mk-stick"><span class="mk-no"></span></span>
            <span class="mk-body"><span class="mk-label">御神籤</span></span>
          </div>
          <div class="mk-paper" hidden><p class="mk-fortune"></p><p class="mk-item"></p></div>
        </div>`;
      this.root = stage.querySelector('.omikuji');
    },
    run() {
      return new Promise((resolve) => {
        const root = this.root;
        const paper = $('.mk-paper', root);
        paper.hidden = true;
        root.classList.remove('out');
        const idx = randInt(this.items.length);
        const fortune = pickFortune();
        $('.mk-no', root).textContent = `${kanjiNum(idx + 1)}番`;
        root.classList.add('shaking');
        setTimeout(() => {
          root.classList.remove('shaking');
          root.classList.add('out');
          setTimeout(() => {
            $('.mk-fortune', paper).textContent = fortune;
            $('.mk-item', paper).textContent = this.items[idx];
            paper.hidden = false;
            resolve({ result: this.items[idx], fortune });
          }, reduceMotion ? 100 : 900);
        }, reduceMotion ? 200 : 1700);
      });
    }
  };

  const ENGINES = { roulette: Roulette, amida: Amida, trump: Trump, omikuji: Omikuji };

  function setHint(text) { $('#stageHint').textContent = text; }

  function mountStage() {
    if (state.drawing) return;
    ENGINES[state.mode].mount($('#stage'), state.items.slice());
    $('#drawBtn').textContent = MODE_BUTTON[state.mode];
    setHint(MODE_HINT[state.mode]);
  }

  function relayoutStage() {
    const eng = ENGINES[state.mode];
    if (!state.drawing && eng && eng.relayout && !$('#mainView').hidden) eng.relayout();
  }

  function setMode(m) {
    state.mode = MODE_LABEL[m] ? m : 'roulette';
    LS.set(KEY.mode, state.mode);
    const radio = $(`input[name="mode"][value="${state.mode}"]`);
    if (radio) radio.checked = true;
    mountStage();
  }

  async function startDraw() {
    if (state.drawing) return;
    if (state.items.length < 2) return toast('選択肢を2個以上入れてください');
    state.drawing = true;
    $('#drawBtn').disabled = true;
    $$('input[name="mode"]').forEach((r) => { r.disabled = true; });
    try {
      const r = await ENGINES[state.mode].run();
      await sleep(reduceMotion ? 100 : 450);
      showResult(r);
    } catch (err) {
      toast(err.message);
    } finally {
      state.drawing = false;
      $('#drawBtn').disabled = false;
      $$('input[name="mode"]').forEach((r) => { r.disabled = false; });
    }
  }

  /* ============================== 結果表示・Earth Studio ============================== */
  async function showResult({ result, fortune }) {
    const dlg = $('#resultDialog');
    $('#resultLead').textContent = `${MODE_LABEL[state.mode]}が決めた、今日やることは`;
    $('#resultText').textContent = result;
    const f = $('#resultFortune');
    f.hidden = !fortune;
    f.textContent = fortune === '凶' ? '凶 …でも、やれば運気は上向き' : (fortune || '');
    clearMedia();
    $('#earthLink').hidden = true;
    dlg.classList.remove('reveal');
    if (!dlg.open) dlg.showModal();
    void dlg.offsetWidth;
    dlg.classList.add('reveal');

    const draw = { drawId: null, result, fortune: fortune || '', mode: state.mode };
    state.lastDraw = draw;
    state.lastDrawSaving = api('saveDraw', { mode: state.mode, items: state.items, result, fortune: fortune || '' }, { silent: true })
      .then((r) => {
        draw.drawId = r.drawId;
        if (dlg.open && state.lastDraw === draw) applyEarth(r.earth);
      })
      .catch((err) => toast(`結果を記録できませんでした：${err.message}`));
  }

  function clearMedia() {
    const m = $('#resultMedia');
    m.innerHTML = '';
    m.hidden = true;
  }

  function applyEarth(earth) {
    if (!earth || !earth.isOutdoor) return;
    if (earth.earthUrl) {
      const a = $('#earthLink');
      a.href = earth.earthUrl;
      a.hidden = false;
    }
    if (!earth.video) return;
    const m = $('#resultMedia');
    const cap = earth.video.title ? `<span class="media-caption">${esc(earth.video.title)}</span>` : '';
    const v = document.createElement('video');
    v.muted = true;
    v.autoplay = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.src = earth.video.videoUrl;
    v.addEventListener('error', () => {
      // Driveの直接再生ができない場合はプレビュー（タップで再生）に切り替える
      m.innerHTML = `<iframe src="${esc(earth.video.previewUrl)}" allow="autoplay" title="おでかけ演出動画"></iframe>${cap}`;
    }, { once: true });
    m.innerHTML = '';
    m.appendChild(v);
    m.insertAdjacentHTML('beforeend', cap);
    m.hidden = false;
    v.play().catch(() => { /* 自動再生不可でも表示は続ける */ });
  }

  /* ============================== 日記 ============================== */
  function resetDiaryForm() {
    state.editingId = null;
    state.photos = [];
    $('#diaryForm').reset();
    $('#dDate').value = todayStr();
    $('#diaryFormTitle').textContent = '今日の日記';
    $('#aiCommentBox').hidden = true;
    $('#dAiComment').textContent = '';
    $('#interim').textContent = '';
    linkDraw(null);
    renderPhotoPreview();
  }

  function linkDraw(draw, outcome) {
    state.linkedDraw = draw && draw.drawId ? draw : null;
    $('#linkedDraw').hidden = !state.linkedDraw;
    if (state.linkedDraw) {
      $('#linkedResult').textContent = state.linkedDraw.result;
      const v = outcome || 'followed';
      $$('input[name="outcome"]').forEach((r) => { r.checked = r.value === v; });
    }
  }

  async function goDiaryFromResult() {
    $('#resultDialog').close();
    const d = state.lastDraw;
    if (!d) return;
    if (!d.drawId && state.lastDrawSaving) {
      busy(true, 'くじの結果を記録しています…');
      try { await state.lastDrawSaving; } finally { busy(false); }
    }
    if (state.editingId) resetDiaryForm();
    linkDraw(d);
    if (!$('#dTitle').value) $('#dTitle').value = d.result;
    if (!$('#dRaw').value) $('#dRaw').value = `今日はくじで「${d.result}」をやることになった。`;
    switchTab('diary');
    $('#diaryForm').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    $('#dRaw').focus();
  }

  // ---- 音声入力（Web Speech API） ----
  let recognizer = null;
  let listening = false;
  function setMicUi(on) {
    const b = $('#micBtn');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '■ 話し終えたら押す' : '🎤 話して入力';
  }
  function stopListening() {
    listening = false;
    if (recognizer) { try { recognizer.stop(); } catch { /* noop */ } }
    setMicUi(false);
  }
  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('このブラウザは音声入力に対応していません。Chrome か Safari でお試しください');
    if (listening) return stopListening();
    recognizer = new SR();
    recognizer.lang = 'ja-JP';
    recognizer.continuous = true;
    recognizer.interimResults = true;
    const ta = $('#dRaw');
    recognizer.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          const sep = ta.value && !/[。、！？\s]$/.test(ta.value) ? '。' : '';
          ta.value += sep + t;
        } else {
          interim += t;
        }
      }
      $('#interim').textContent = interim;
    };
    recognizer.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false;
        toast('マイクの使用が許可されていません。ブラウザの設定を確認してください');
      }
    };
    recognizer.onend = () => {
      $('#interim').textContent = '';
      if (listening) { try { recognizer.start(); } catch { stopListening(); } }
      else setMicUi(false);
    };
    listening = true;
    setMicUi(true);
    try { recognizer.start(); } catch { stopListening(); }
  }

  async function structureDiary() {
    const text = $('#dRaw').value.trim();
    if (!text) return toast('先に「今日のこと」を話すか書いてください');
    stopListening();
    try {
      const r = await api('structureDiary', { text, drawResult: state.linkedDraw ? state.linkedDraw.result : '' }, { busyText: 'AIが日記に清書しています…' });
      const d = r.diary;
      $('#dTitle').value = d.title || $('#dTitle').value;
      $('#dDid').value = d.did || '';
      $('#dFeeling').value = d.feeling || '';
      $('#dNext').value = d.nextWant || '';
      setScore(d.emotionScore);
      setAiComment(d.aiComment);
      toast('清書しました。必要なら手直ししてください');
    } catch (err) {
      toast(err.message);
    }
  }

  function setScore(v) {
    $$('input[name="dScore"]').forEach((r) => { r.checked = Number(r.value) === Number(v); });
  }
  function getScore() {
    const r = $('input[name="dScore"]:checked');
    return r ? Number(r.value) : null;
  }
  function setAiComment(text) {
    $('#dAiComment').textContent = text || '';
    $('#aiCommentBox').hidden = !text;
  }

  // ---- 写真 ----
  const photoCache = new Map();
  let photoQueue = Promise.resolve();

  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = CONFIG.PHOTO_MAX_SIDE || 1280;
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * s), h = Math.round(img.height * s);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        const dataUrl = c.toDataURL('image/jpeg', CONFIG.PHOTO_QUALITY || 0.85);
        resolve({ dataUrl, base64: dataUrl.split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }

  async function onPhotosChosen(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const max = CONFIG.PHOTO_MAX_COUNT || 6;
    for (const f of files) {
      if (state.photos.length >= max) { toast(`写真は${max}枚までです`); break; }
      try {
        const p = await resizeImage(f);
        state.photos.push({ local: true, ...p });
      } catch (err) {
        toast(err.message);
      }
    }
    renderPhotoPreview();
  }

  function renderPhotoPreview() {
    const box = $('#photoPreview');
    box.innerHTML = '';
    state.photos.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img alt="添付写真${i + 1}"><button type="button" aria-label="写真${i + 1}を外す">×</button>`;
      const img = $('img', d);
      if (p.dataUrl) img.src = p.dataUrl;
      else if (p.fileId) loadPhoto(p.fileId, img);
      $('button', d).addEventListener('click', () => { state.photos.splice(i, 1); renderPhotoPreview(); });
      box.appendChild(d);
    });
  }

  function loadPhoto(fileId, img) {
    if (photoCache.has(fileId)) { img.src = photoCache.get(fileId); return; }
    photoQueue = photoQueue.then(async () => {
      if (photoCache.has(fileId)) { img.src = photoCache.get(fileId); return; }
      try {
        const r = await api('getPhoto', { fileId }, { silent: true });
        const url = `data:${r.mimeType};base64,${r.dataBase64}`;
        photoCache.set(fileId, url);
        img.src = url;
      } catch {
        img.alt = '写真を読み込めませんでした';
      }
    });
  }

  async function onSaveDiary(e) {
    e.preventDefault();
    stopListening();
    const title = $('#dTitle').value.trim();
    const did = $('#dDid').value.trim();
    const raw = $('#dRaw').value.trim();
    if (!title && !did && !raw) return toast('タイトルか本文を入れてください');
    try {
      const photoIds = [];
      for (const p of state.photos) {
        if (!p.fileId) {
          const r = await api('uploadPhoto', { dataBase64: p.base64, mimeType: 'image/jpeg' }, { busyText: '写真を保存しています…' });
          p.fileId = r.fileId;
          photoCache.set(r.fileId, p.dataUrl);
        }
        photoIds.push(p.fileId);
      }
      const ld = state.linkedDraw;
      const outcomeEl = $('input[name="outcome"]:checked');
      const diary = {
        diaryId: state.editingId,
        date: $('#dDate').value || todayStr(),
        title, did,
        feeling: $('#dFeeling').value.trim(),
        emotionScore: getScore(),
        nextWant: $('#dNext').value.trim(),
        rawText: raw,
        aiComment: $('#dAiComment').textContent,
        drawId: ld ? ld.drawId : '',
        drawResult: ld ? ld.result : '',
        outcome: ld && outcomeEl ? outcomeEl.value : '',
        photoIds
      };
      await api('saveDiary', { diary }, { busyText: '日記を保存しています…' });
      toast(state.editingId ? '日記を更新しました' : '日記を保存しました');
      resetDiaryForm();
      loadDiaries(true);
    } catch (err) {
      toast(err.message);
    }
  }

  async function loadDiaries(reset) {
    if (reset) { state.diaries = []; $('#diaryList').innerHTML = ''; }
    try {
      const r = await api('listDiaries', { limit: CONFIG.DIARY_PAGE_SIZE || 20, offset: state.diaries.length }, { silent: !reset });
      state.diaryTotal = r.total;
      r.diaries.forEach((d) => { state.diaries.push(d); $('#diaryList').appendChild(renderDiaryCard(d)); });
      if (!state.diaries.length) {
        $('#diaryList').innerHTML = '<p class="empty">まだ日記はありません。くじを引いたら「日記に書く」から始めましょう。</p>';
      }
      $('#moreDiaryBtn').hidden = state.diaries.length >= state.diaryTotal;
    } catch (err) {
      toast(err.message);
    }
  }

  function diarySpeechText(d) {
    return [d.title, d.did, d.feeling, d.nextWant ? `次は、${d.nextWant}` : '', d.aiComment ? `AIからひとこと。${d.aiComment}` : '']
      .filter(Boolean).join('。');
  }

  function renderDiaryCard(d) {
    const a = document.createElement('article');
    a.className = 'diary-card';
    if (d.emotionScore) a.style.setProperty('--score-color', SCORE_COLORS[d.emotionScore]);
    a.innerHTML = `
      <div class="diary-meta"><span>${esc(fmtDate(d.date))}</span><span class="diary-face" aria-label="気分${d.emotionScore || 'なし'}">${FACES[d.emotionScore] || ''}</span></div>
      <h3>${esc(d.title)}</h3>
      ${d.drawResult ? `<p class="diary-chip">🎲 ${esc(d.drawResult)}${d.outcome ? `｜${esc(OUTCOME_LABEL[d.outcome] || '')}` : ''}</p>` : ''}
      ${d.did ? `<div><p class="diary-sub">やったこと</p><p class="diary-text">${esc(d.did)}</p></div>` : ''}
      ${d.feeling ? `<div><p class="diary-sub">感想</p><p class="diary-text">${esc(d.feeling)}</p></div>` : ''}
      ${d.nextWant ? `<div><p class="diary-sub">次回やりたいこと</p><p class="diary-text">${esc(d.nextWant)}</p></div>` : ''}
      ${d.aiComment ? `<div class="ai-comment"><p class="ai-comment-label">AIのひとこと</p><p>${esc(d.aiComment)}</p></div>` : ''}
      ${d.photoIds && d.photoIds.length ? `<div class="photo-grid">${d.photoIds.map((_, i) => `<div class="thumb"><img alt="日記の写真${i + 1}"></div>`).join('')}</div>` : ''}
      <div class="diary-actions">
        <button type="button" class="btn" data-act="speak">🔊 読み上げ</button>
        <button type="button" class="btn" data-act="edit">編集</button>
        <button type="button" class="btn" data-act="delete">削除</button>
      </div>`;
    $$('.photo-grid img', a).forEach((img, i) => loadPhoto(d.photoIds[i], img));
    $('[data-act="speak"]', a).addEventListener('click', (e) => speak(diarySpeechText(d), e.currentTarget));
    $('[data-act="edit"]', a).addEventListener('click', () => editDiary(d));
    $('[data-act="delete"]', a).addEventListener('click', () => deleteDiary(d, a));
    return a;
  }

  function editDiary(d) {
    resetDiaryForm();
    state.editingId = d.diaryId;
    $('#diaryFormTitle').textContent = '日記を編集';
    $('#dDate').value = d.date || todayStr();
    $('#dRaw').value = d.rawText || '';
    $('#dTitle').value = d.title || '';
    $('#dDid').value = d.did || '';
    $('#dFeeling').value = d.feeling || '';
    $('#dNext').value = d.nextWant || '';
    setScore(d.emotionScore);
    setAiComment(d.aiComment);
    if (d.drawId) linkDraw({ drawId: d.drawId, result: d.drawResult || '（くじの結果）' }, d.outcome);
    state.photos = (d.photoIds || []).map((fileId) => ({ fileId }));
    renderPhotoPreview();
    $('#diaryForm').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  async function deleteDiary(d, el) {
    if (!confirm(`「${d.title}」を削除します。写真も一緒に削除されます。よろしいですか？`)) return;
    try {
      await api('deleteDiary', { diaryId: d.diaryId }, { busyText: '削除しています…' });
      el.remove();
      state.diaries = state.diaries.filter((x) => x.diaryId !== d.diaryId);
      state.diaryTotal = Math.max(0, state.diaryTotal - 1);
      if (state.editingId === d.diaryId) resetDiaryForm();
      if (!state.diaries.length) loadDiaries(true);
      toast('日記を削除しました');
    } catch (err) {
      toast(err.message);
    }
  }

  /* ============================== 読み上げ（Gemini TTS） ============================== */
  let currentAudio = null;
  let currentBtn = null;

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pcmToWav(pcm, rate) {
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, pcm.length, true);
    return new Blob([header, pcm], { type: 'audio/wav' });
  }
  function toAudioBlob(b64, mime) {
    const bytes = base64ToBytes(b64);
    if (/L16|pcm/i.test(mime)) {
      const m = /rate=(\d+)/.exec(mime);
      return pcmToWav(bytes, m ? Number(m[1]) : 24000);
    }
    return new Blob([bytes], { type: mime });
  }

  function stopSpeaking() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (currentBtn) currentBtn.classList.remove('playing');
    currentBtn = null;
  }

  async function speak(text, btn) {
    if (btn && btn === currentBtn) return stopSpeaking(); // もう一度押すと停止
    stopSpeaking();
    if (!text) return;
    currentBtn = btn || null;
    if (btn) btn.classList.add('playing');
    try {
      const r = await api('tts', { text }, { busyText: '音声を作っています…' });
      if (currentBtn !== (btn || null)) return; // 待っている間に別の再生が始まった
      const url = URL.createObjectURL(toAudioBlob(r.data, r.mimeType));
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => { URL.revokeObjectURL(url); if (currentAudio === audio) stopSpeaking(); };
      await audio.play();
    } catch (err) {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        u.onend = () => stopSpeaking();
        speechSynthesis.speak(u);
        toast('AI音声が使えないため、端末の読み上げで再生します');
      } else {
        stopSpeaking();
        toast(err.message);
      }
    }
  }

  /* ============================== 分析 ============================== */
  async function analyze() {
    $('#statsEmpty').hidden = true;
    try {
      const r = await api('analyze', {}, { busyText: 'AIがあなたの過ごし方を占っています…' });
      if (r.empty) {
        $('#statsResult').hidden = true;
        $('#statsEmpty').textContent = r.message;
        $('#statsEmpty').hidden = false;
        return;
      }
      state.stats = r.stats;
      state.persona = r.persona;
      renderStats();
      $('#statsResult').hidden = false;
      await drawShareCard();
      $('.persona').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    } catch (err) {
      toast(err.message);
    }
  }

  function bars(container, rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    container.innerHTML = rows.map((r) => `
      <div class="bar-row"><span>${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round(r.value / max * 100)}%"></span></span>
        <span class="num">${r.value}</span></div>`).join('');
  }

  function renderStats() {
    const s = state.stats, p = state.persona;
    $('#pLevel').textContent = `Lv.${p.level}`;
    $('#pType').textContent = `『${p.typeName}』`;
    $('#pDesc').textContent = p.description || '';
    $('#pTags').textContent = (p.tags || []).join(' ');
    $('#pLucky').textContent = p.luckyAction || '';
    $('#pComment').textContent = p.comment || '';

    const stat = (value, label) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    $('#statGrid').innerHTML = [
      stat(`${s.totalDraws}回`, 'くじを引いた'),
      stat(`${s.totalDiaries}件`, '日記'),
      stat(s.rebelRate === null ? '—' : `${s.rebelRate}%`, 'くじへの反逆率'),
      stat(s.avgEmotion === null ? '—' : `${s.avgEmotion}`, '平均気分（5点満点）'),
      stat(s.outdoorRate === null ? '—' : `${s.outdoorRate}%`, 'おでかけ率'),
      stat(`${s.streak}日`, '日記の連続記録')
    ].join('');

    bars($('#modeBars'), Object.keys(MODE_LABEL).map((k) => ({ label: MODE_LABEL[k], value: s.modeCounts[k] || 0 })));
    bars($('#weekBars'), WEEK.map((w, i) => ({ label: `${w}曜`, value: s.weekCounts[i] || 0 })));
    $('#topResults').innerHTML = s.topResults.length
      ? s.topResults.map((t) => `<li>${esc(t.name)} <small>${t.count}回</small></li>`).join('')
      : '<li>まだありません</li>';
  }

  function personaSpeech() {
    const p = state.persona;
    if (!p) return '';
    return `あなたの冒険者タイプは、${p.typeName}。レベル${p.level}。${p.description}。次の開運アクションは、${p.luckyAction}。${p.comment}`;
  }

  // ---- シェアカード ----
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
    const chars = Array.from(String(text || ''));
    let line = '', lines = 0;
    for (let i = 0; i < chars.length; i++) {
      const test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) {
        if (lines === maxLines - 1) { ctx.fillText(fitText(ctx, line + chars.slice(i).join(''), maxW), x, y); return y + lineH; }
        ctx.fillText(line, x, y);
        line = chars[i];
        y += lineH;
        lines++;
      } else {
        line = test;
      }
    }
    if (line) { ctx.fillText(line, x, y); y += lineH; }
    return y;
  }

  async function drawShareCard() {
    const c = $('#shareCanvas');
    const ctx = c.getContext('2d');
    const W = 1080, H = 1350;
    const p = state.persona, s = state.stats;
    try { await document.fonts.ready; } catch { /* noop */ }
    const INK = '#1C2A4A', SUN = '#F3B23C', PAPER = '#E8F1F7', SOFT = '#4C5A79';

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, 170);
    ctx.fillStyle = SUN;
    ctx.font = '62px "Dela Gothic One", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('今日は何をしよう', 70, 108);

    ctx.fillStyle = INK;
    ctx.font = '700 40px "Zen Maru Gothic", sans-serif';
    ctx.fillText('あなたの冒険者タイプ', 70, 270);

    ctx.fillStyle = SUN;
    roundRect(ctx, W - 300, 212, 230, 84, 42);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = '50px "Dela Gothic One", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Lv.${p.level}`, W - 185, 272);
    ctx.textAlign = 'left';

    ctx.font = '72px "Dela Gothic One", sans-serif';
    let y = wrapText(ctx, `『${p.typeName}』`, 70, 400, W - 140, 98, 3);
    ctx.fillStyle = SOFT;
    ctx.font = '500 36px "Zen Maru Gothic", sans-serif';
    wrapText(ctx, p.description, 70, y + 26, W - 140, 54, 4);

    const boxes = [
      ['反逆率', s.rebelRate === null ? '—' : `${s.rebelRate}%`],
      ['平均気分', s.avgEmotion === null ? '—' : `${s.avgEmotion}`],
      ['くじ回数', `${s.totalDraws}回`]
    ];
    const bw = (W - 140 - 40) / 3, by = H - 470;
    boxes.forEach(([label, val], i) => {
      const bx = 70 + i * (bw + 20);
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, bx, by, bw, 170, 24);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.font = '60px "Dela Gothic One", sans-serif';
      ctx.fillText(val, bx + bw / 2, by + 95);
      ctx.fillStyle = SOFT;
      ctx.font = '700 30px "Zen Maru Gothic", sans-serif';
      ctx.fillText(label, bx + bw / 2, by + 145);
    });
    ctx.textAlign = 'left';

    ctx.fillStyle = INK;
    ctx.font = '700 32px "Zen Maru Gothic", sans-serif';
    ctx.fillText('AIが授ける次の開運アクション', 70, H - 225);
    ctx.font = '700 44px "Zen Maru Gothic", sans-serif';
    wrapText(ctx, p.luckyAction, 70, H - 165, W - 140, 58, 2);

    ctx.fillStyle = SOFT;
    ctx.font = '500 26px "Zen Maru Gothic", sans-serif';
    ctx.fillText(CONFIG.SITE_URL || '', 70, H - 40);
  }

  function shareBlob() {
    return new Promise((resolve) => $('#shareCanvas').toBlob(resolve, 'image/png'));
  }

  async function saveShareImage() {
    const blob = await shareBlob();
    if (!blob) return toast('画像を作れませんでした');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kyou-nani-shindan.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function shareCard() {
    const text = `私の冒険者タイプは『${state.persona.typeName}』（Lv.${state.persona.level}）でした！ #今日は何をしよう`;
    try {
      const blob = await shareBlob();
      const file = blob ? new File([blob], 'kyou-nani-shindan.png', { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title: '今日は何をしよう' });
      } else if (navigator.share) {
        await navigator.share({ text, url: CONFIG.SITE_URL, title: '今日は何をしよう' });
      } else {
        await navigator.clipboard.writeText(`${text} ${CONFIG.SITE_URL || ''}`);
        toast('シェア用の文章をコピーしました。画像は「画像を保存」から保存できます');
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('シェアできませんでした。「画像を保存」をお使いください');
    }
  }

  /* ============================== イベント登録 ============================== */
  function wire() {
    $('#appVersion').textContent = CONFIG.APP_VERSION || '';
    wirePasswordToggles();

    $('#themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme || 'auto';
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      LS.set(KEY.theme, next);
      applyTheme(next);
      renderItems();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(relayoutStage));

    $$('[data-auth]').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.auth)));
    $('#loginForm').addEventListener('submit', onLogin);
    $('#registerForm').addEventListener('submit', onRegister);
    $('#resetForm').addEventListener('submit', onReset);
    $('#changeForm').addEventListener('submit', onChangePassword);
    $('#changeCancel').addEventListener('click', () => showView('main'));
    $('#openChangeBtn').addEventListener('click', () => openChange(false));
    $('#logoutBtn').addEventListener('click', onLogout);

    $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    // くじ
    $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
    $('#drawBtn').addEventListener('click', startDraw);
    $('#addItemForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#newItem').value.trim();
      if (!v) return;
      if (state.items.length >= 40) return toast('選択肢は40個までです');
      state.items.push(v);
      $('#newItem').value = '';
      saveItems();
    });
    $('#clearItemsBtn').addEventListener('click', () => {
      if (!confirm('選択肢をすべて消して、2つの空の枠にします。よろしいですか？')) return;
      state.items = ['やること1', 'やること2'];
      saveItems();
    });
    $('#setSelect').addEventListener('change', (e) => {
      const set = state.sets.find((s) => s.setId === e.target.value);
      $('#deleteSetBtn').disabled = !set;
      if (!set) return;
      state.items = set.items.slice();
      $('#setName').value = set.name;
      saveItems();
      toast(`「${set.name}」を読み込みました`);
    });
    $('#saveSetBtn').addEventListener('click', async () => {
      const name = $('#setName').value.trim();
      if (!name) { $('#setName').focus(); return toast('セットの名前を入れてください'); }
      try {
        const r = await api('saveSet', { name, items: state.items }, { busyText: '保存しています…' });
        toast(r.message);
        loadSets();
      } catch (err) { toast(err.message); }
    });
    $('#deleteSetBtn').addEventListener('click', async () => {
      const id = $('#setSelect').value;
      const set = state.sets.find((s) => s.setId === id);
      if (!set || !confirm(`セット「${set.name}」を削除しますか？`)) return;
      try {
        await api('deleteSet', { setId: id }, { busyText: '削除しています…' });
        toast('セットを削除しました');
        loadSets();
      } catch (err) { toast(err.message); }
    });

    // AI
    $$('#themeChips .chip').forEach((c) => c.addEventListener('click', () => {
      const on = c.getAttribute('aria-pressed') !== 'true';
      $$('#themeChips .chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      c.setAttribute('aria-pressed', String(on));
    }));
    $('#aiBtn').addEventListener('click', async () => {
      const chip = $('#themeChips .chip[aria-pressed="true"]');
      const note = $('#aiNote').value.trim();
      const theme = chip ? chip.textContent : (note ? '希望にそって' : 'おまかせ');
      try {
        const r = await api('aiChoices', { theme, note, count: Number($('#aiCount').value) }, { busyText: 'AIが選択肢を考えています…' });
        state.items = r.items;
        saveItems();
        $('#itemsPanel').open = true;
        toast(`AIが${r.items.length}個の選択肢を作りました`);
      } catch (err) { toast(err.message); }
    });

    // 結果ダイアログ
    const dlg = $('#resultDialog');
    $('#resultClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { clearMedia(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    $('#toDiaryBtn').addEventListener('click', goDiaryFromResult);
    $('#againBtn').addEventListener('click', () => { dlg.close(); mountStage(); });

    // 日記
    $('#unlinkBtn').addEventListener('click', () => linkDraw(null));
    $('#micBtn').addEventListener('click', toggleMic);
    $('#structBtn').addEventListener('click', structureDiary);
    $('#dPhotos').addEventListener('change', onPhotosChosen);
    $('#diaryForm').addEventListener('submit', onSaveDiary);
    $('#resetDiaryBtn').addEventListener('click', () => {
      if (($('#dRaw').value || $('#dTitle').value) && !confirm('入力中の内容を消して、新しく書き直しますか？')) return;
      stopListening();
      resetDiaryForm();
    });
    $('#moreDiaryBtn').addEventListener('click', () => loadDiaries(false));

    // 分析
    $('#analyzeBtn').addEventListener('click', analyze);
    $('#pSpeak').addEventListener('click', (e) => speak(personaSpeech(), e.currentTarget));
    $('#shareSaveBtn').addEventListener('click', saveShareImage);
    $('#shareBtn').addEventListener('click', shareCard);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayoutStage, 200);
    });
  }

  /* ============================== 起動 ============================== */
  async function init() {
    applyTheme(LS.get(KEY.theme, 'auto'));
    wire();
    if (!state.token) { setAuthTab('login'); showView('auth'); return; }
    try {
      const r = await api('me', {}, { busyText: 'ログインを確認しています…' });
      state.user = r.user;
      if (r.user.mustChange) openChange(true);
      else enterMain();
    } catch (err) {
      if (err.code !== 'SESSION_EXPIRED') toast(err.message);
      setAuthTab('login');
      showView('auth');
    }
  }

  init();
})();

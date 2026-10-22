/**
 * 小説工房 config.js
 * GAS のデプロイURLを変えたら GAS_API_URL だけ書き換えれば動きます。
 * Gemini APIキーはブラウザに置かず、GASのスクリプトプロパティ GEMINI_API_KEY に保存します。
 */
window.APP_CONFIG = {
  APP_NAME: '小説工房',
  VERSION: 'v1.0.0',
  UPDATED: '2026-10-22',

  // ▼ GAS Web App の URL（デプロイ → ウェブアプリ のURL）
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycby3gKyCAAxRgER4b2KEAs8Rz4DSsMIr_YrgARgyui4GlaUbuvH7XlgYdhq0aXu5fuSmEw/exec',

  // ▼ 生成まわりの初期値
  DEFAULTS: {
    chapters: 4,             // 3〜5
    charsPerChapter: 4000,   // 1章の目標文字数
    style: 'hardboiled',
    era: 'showa-boom',
    tone: 'serious',
    focus: 'senses',
    voice: 'Charon',
    narration: 'calm'
  },
  CHAPTER_CHOICES: [3, 4, 5],
  LENGTH_CHOICES: [
    { value: 2000, label: '約2,000字（短め）' },
    { value: 4000, label: '約4,000字（標準）' },
    { value: 6000, label: '約6,000字（長め）' },
    { value: 8000, label: '約8,000字（重厚）' }
  ],

  CONTEXT_TAIL_CHARS: 1500,   // 次章に渡す「直前の本文」の文字数
  MAX_CONTINUE: 2,            // 出力上限で途切れたときの自動継ぎ足し回数
  TTS_CHUNK_CHARS: 450,       // 朗読1ファイルあたりの最大文字数
  LOCATION_MAX: 10,           // ロケ地の最大抽出数
  REQUEST_TIMEOUT_MS: 330000, // GASの実行上限(6分)に合わせる

  // ① 文体・作風
  STYLE_PRESETS: [
    {
      id: 'hardboiled',
      label: '渇いたハードボイルド（北方謙三・大沢在昌・チャンドラー風）',
      prompt: '文末は短く「〜だ」「〜だった」を基本とし、過剰な装飾を排した硬質な文体。主語を削ぎ落とし、身体の痛み、煙草の煙、夜の湿気、酒の匂いなど五感の物理現象で情景を描く。会話は行間を持たせ、本音を直接言わせず短いやり取りで緊張感を演出せよ。'
    },
    {
      id: 'showa-lyric',
      label: '昭和叙情・ルポルタージュ調（開高健・向田邦子・沢木耕太郎風）',
      prompt: '台所の湯気、路地裏の匂い、使い込まれた道具など生活の細部に視線を注ぎ、日常のささやかな動作に人生のほろ苦さや過去の後悔を滲ませる文体。平易ながら味わい深い比喩を用い、孤独感を温かく引き締まった筆致で綴れ。'
    },
    {
      id: 'classic',
      label: '近代文豪・典雅調（芥川龍之介・谷崎潤一郎・泉鏡花風）',
      prompt: '漢語と和語が調和した格調高く美麗な文体。美と退廃、人間の深いエゴイズムを冷徹かつ流麗に描く。情景描写は絵画的・色彩的で、影や光、着物の質感、気配を精緻に捉え、「〜であつた」「〜に他ならない」など重厚な語り口とせよ。'
    },
    {
      id: 'urban-monologue',
      label: '都会派メタファー・モノローグ（村上春樹風）',
      prompt: '一人称「僕」。淡々とした語り口の中に独自の比喩を散りばめる。音楽、料理、アイロンがけなど日常のディテールを正確に描写しつつ、世界の歪みや喪失感と静かに向き合うクールで内省的なトーンを維持せよ。'
    },
    {
      id: 'social-realism',
      label: '重厚な社会派・リアリズム（松本清張・横山秀夫風）',
      prompt: '組織（警察、官僚、企業）の論理と個人の軋轢を乾いたリアリズムで描写。時刻、地理、気象、公的手続きなどの客観的事実を積み上げ、泥臭い執念や生活感を浮き彫りにする、感傷を排した重厚な文体とせよ。'
    },
    {
      id: 'edo-wit',
      label: '江戸前・軽妙洒脱（浅田次郎・井上ひさし風）',
      prompt: '会話文の比率を高め、テンポの良い掛け合いで読ませる人情派文体。ウィットや自虐、ユーモアを交えつつ、根底に弱者への共感と涙もろい温かさを漂わせる、落語や講談のようなリズムある語り口とせよ。'
    }
  ],

  // ② 時代背景・空気感
  ERA_PRESETS: [
    {
      id: 'showa-boom',
      label: '昭和30〜40年代（高度経済成長期）',
      prompt: '煤煙、路面電車、赤電話、高度成長の熱気と取り残された下町の哀愁、煙草の匂い。'
    },
    {
      id: 'bubble',
      label: '昭和末期〜平成初期（バブル期）',
      prompt: '高級外車、シティホテル、ウォーターフロント、喧騒、消費の狂乱、その裏にある刹那的な虚無感。'
    },
    {
      id: 'taisho',
      label: '大正ロマン・昭和初期',
      prompt: 'カフェー、モボ・モガ、蓄音機、洋館、木造長屋、帝都の黄昏、和洋折衷の情緒。'
    },
    {
      id: 'reiwa',
      label: '現代（令和・日常）',
      prompt: 'スマートフォン、SNSの通知音、深夜のコンビニ、希薄な人間関係、静かな孤独感。'
    },
    {
      id: 'bakumatsu',
      label: '幕末・明治維新',
      prompt: '泥濘、刀傷、動乱の気配、時代の激変に翻弄される人々の焦燥、理想と現実の衝突。'
    }
  ],

  // ③ トーン
  TONE_PRESETS: [
    { id: 'nostalgia', label: '静謐・ノスタルジー', prompt: '過去への郷愁、静かな諦観、穏やかな時間の流れを基調とする。大きな事件よりも余韻を大切にせよ。' },
    { id: 'serious',   label: '骨太・シリアス',     prompt: '命懸けの勝負、逃れられない運命、道徳的ジレンマを正面から描く。安易な救いや説教を避けよ。' },
    { id: 'pathos',    label: 'ペーソス・ほろ苦い笑い', prompt: '人生の滑稽さ、ちっぽけな意地、哀愁あるユーモアを織り交ぜる。笑いの奥に寂しさを残せ。' },
    { id: 'suspense',  label: 'サスペンス・切迫感', prompt: 'タイムリミット、隠された秘密、張り詰めた沈黙で読者を引っ張る。章末には次への引きを置け。' }
  ],

  // ③ 描写の切り口
  FOCUS_PRESETS: [
    { id: 'senses',    label: '五感・情景主導',           prompt: '風景、気象、食事の味、匂いから人物の心情を語らせる。感情語を直接書くより、知覚の描写で示せ。' },
    { id: 'psyche',    label: '心理解剖・モノローグ主導', prompt: '思考の揺らぎ、無意識の葛藤、自己欺瞞を深く掘り下げる。内面の声と行動のずれを描け。' },
    { id: 'action',    label: '行動・ディテール主導',     prompt: '道具の扱い方、歩き方、手元の仕草など具体的行動の集積で人物を描く。説明を減らし動作で語れ。' }
  ],

  // 朗読
  TTS_VOICES: [
    { id: 'Charon',    label: 'Charon（落ち着いた低め）' },
    { id: 'Kore',      label: 'Kore（はっきりした声）' },
    { id: 'Fenrir',    label: 'Fenrir（力強い）' },
    { id: 'Enceladus', label: 'Enceladus（息まじり）' },
    { id: 'Algieba',   label: 'Algieba（なめらか）' },
    { id: 'Aoede',     label: 'Aoede（軽やか）' },
    { id: 'Puck',      label: 'Puck（明るい）' }
  ],
  NARRATION_STYLES: [
    { id: 'calm',   label: '静かな朗読',     prompt: '次の小説の一節を、落ち着いた声で、間を大切にしながら朗読してください。' },
    { id: 'radio',  label: 'ラジオドラマ風', prompt: '次の小説の一節を、深夜のラジオドラマのように情感を込めて朗読してください。会話は人物に合わせて声色を少し変えてください。' },
    { id: 'gritty', label: '渋い語り',       prompt: '次の小説の一節を、低く渋い声で、乾いた調子で淡々と語ってください。' }
  ]
};

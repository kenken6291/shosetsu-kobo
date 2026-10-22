/**
 * 今日は何をしよう — 設定ファイル
 * バックエンドの接続先やバージョンはここだけ書き換えればOKです。
 */
const CONFIG = Object.freeze({
  APP_NAME: '今日は何をしよう',
  APP_VERSION: 'v1.0.0',

  // GAS「ウェブアプリ」としてデプロイしたURL（末尾 /exec）
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbyqJNy_OAxcLm8A69n3C2q0Wy61CVS6Ed1QWauy9bALtshrRiE5O0eEBGW_dsuolev0/exec',

  // シェアカードに載せる公開URL
  SITE_URL: 'https://kenken6291.github.io/kyou-nani-shiyou/',

  DEFAULT_MODE: 'roulette',     // roulette / amida / trump / omikuji
  PHOTO_MAX_SIDE: 1280,         // 写真をアップロード前に縮小する長辺(px)
  PHOTO_QUALITY: 0.85,          // JPEG画質
  PHOTO_MAX_COUNT: 6,           // 日記1件あたりの写真枚数
  DIARY_PAGE_SIZE: 20           // 日記一覧の1回の読み込み件数
});

# 今日は何をしよう（kyou-nani-shiyou） v1.0.0

くじ（ルーレット／あみだくじ／トランプ／おみくじ）で今日やることを決め、話すだけで日記に残し、AIがエンタメ分析するWebアプリ。

## 1. ファイル構成

```
kyou-nani-shiyou/          ← GitHub リポジトリ（GitHub Pages で公開）
├── index.html             画面（ログイン／パスワード変更／くじ／日記／分析／結果ダイアログ）
├── style.css              デザイン（ライト／ダーク自動対応＋手動切替）
├── config.js              GAS_API_URL・APP_VERSION などの設定（ここだけ書き換え）
├── app.js                 認証、4種の抽選アニメ、音声入力、TTS再生、写真、分析、シェアカード
├── README.md
└── gas/
    └── Code.gs            GAS バックエンド（GitHub Pages には不要。GASエディタへ貼り付け）
```

## 2. データフロー

```
[ブラウザ] ──POST(text/plain, JSON {action, token, ...})──▶ [GAS doPost]
                                                              ├─ スプレッドシート（会員・くじ履歴・日記）
                                                              ├─ Google Drive（日記写真／Earth Studio動画）
                                                              └─ Gemini API（選択肢生成・日記清書・分析・TTS）
```

- セッション：ログイン成功でトークン発行 → CacheService に6時間保存（使うたびに延長）。ブラウザは localStorage に保持。
- 仮パスワードのままのユーザーは `me / logout / changePassword` 以外をサーバー側で拒否（MUST_CHANGE）。
- パスワード：SHA-256＋salt＋pepper（300回ストレッチ）。5回連続失敗で15分ロック。
- 写真：ブラウザで長辺1280pxに縮小 → Drive に非公開で保存（説明欄に `owner:ユーザーID`）→ 表示時は本人のみ `getPhoto` で取得。

## 3. スプレッドシート定義

| シート | 列 |
|---|---|
| **Users** | userId, email, nickname, passwordHash, salt, mustChange, failCount, lockedUntil, status(active/suspended), createdAt, lastLoginAt |
| **ChoiceSets** | setId, userId, name, itemsJson, updatedAt |
| **Draws**（くじ履歴） | drawId, userId, mode(roulette/amida/trump/omikuji), itemsJson, result, fortune, isOutdoor, outcome(followed/rebel/skipped), createdAt |
| **Diaries** | diaryId, userId, date, title, did, feeling, emotionScore(1-5), nextWant, rawText, drawId, drawResult, outcome, photoIdsJson, aiComment, createdAt, updatedAt |
| **EarthVideos** | keyword, driveFileId, title, note |
| **Settings** | key, value, note（GEMINI_MODEL / GEMINI_TTS_MODEL / TTS_VOICE / OUTDOOR_KEYWORDS） |

`setup()` を実行すると全シートと見出し行が自動作成されます。利用停止したい会員は Users の status を `suspended` にします。

## 4. API 一覧（action）

| 認証不要 | ping, register, login, resetPassword |
|---|---|
| 認証必要 | me, logout, changePassword, listSets, saveSet, deleteSet, aiChoices, saveDraw, setDrawOutcome, listDraws, structureDiary, saveDiary, listDiaries, deleteDiary, uploadPhoto, getPhoto, tts, analyze |

---

## 5. セットアップ手順

### 5-1. Gemini APIキー
1. https://aistudio.google.com/apikey を開き「APIキーを作成」。
2. 表示されたキーを控える（後でGASのスクリプトプロパティに入れます。フロントには絶対に書かない）。

### 5-2. スプレッドシートとGAS
1. Googleドライブで新しいスプレッドシートを作成（名前例：今日は何をしよう_DB）。
2. メニュー「拡張機能 → Apps Script」。`Code.gs` の中身を全部消して `gas/Code.gs` を貼り付け、保存。
3. 左の歯車「プロジェクトの設定」→ タイムゾーンを「(GMT+09:00) 東京」に。
4. 同じ画面下の「スクリプト プロパティ」に追加：
   - `GEMINI_API_KEY` = 5-1 のキー
   - （テスト中だけ）`SHOW_TEMP_PASSWORD` = `true` … 新規登録時に仮パスワードを画面にも表示。本番前に削除。
5. エディタで関数 `setup` を選んで「実行」→ 権限を承認（スプレッドシート・Drive・メール・外部通信）。
   - シートが6枚でき、Drive に「今日は何をしよう_写真」フォルダが作られます（`DRIVE_FOLDER_ID` と `PEPPER` は自動登録）。

### 5-3. ウェブアプリとして公開
1. 右上「デプロイ → 新しいデプロイ」→ 種類「ウェブアプリ」。
2. 次のユーザーとして実行：**自分**／アクセスできるユーザー：**全員**。
3. 「デプロイ」→ 表示された URL（`…/exec`）をコピー。
4. ⚠ **Code.gs を直したら毎回**「デプロイを管理 → 鉛筆 → バージョン：新バージョン → デプロイ」。URLは変わりません。保存だけでは反映されません。

### 5-4. GitHub Pages
1. GitHub で `kyou-nani-shiyou` リポジトリを作成。
2. `index.html / style.css / config.js / app.js` をアップロード（`gas/` は置いても置かなくてもOK。APIキーは含まれていません）。
3. `config.js` の `GAS_API_URL` を 5-3 の URL に、`SITE_URL` を公開URLに書き換え。
4. Settings → Pages → Branch: `main` / `(root)` → Save。
5. 数分後 `https://kenken6291.github.io/kyou-nani-shiyou/` で公開。
6. バージョンを上げるときは `config.js` の `APP_VERSION` を変更（フッターに表示されます）。

### 5-5. Google Earth Studio の演出動画
1. https://earth.google.com/studio/ でプロジェクトを作成（散歩道、海、山、街など）。
2. Render で書き出し（連番画像が出る場合は動画編集ソフトか `ffmpeg -framerate 30 -i %04d.jpeg -pix_fmt yuv420p out.mp4` でmp4化）。
   - 決定画面の上部に16:9で表示されます。**10〜20秒・720p・20MB以下**くらいが軽くておすすめ。
3. mp4 を Google Drive にアップロード →「共有 → リンクを知っている全員（閲覧者）」に設定。
4. スプレッドシート **EarthVideos** シートに登録：
   - `keyword`：くじの結果に含まれる言葉（例：`散歩`、`海`、`カフェ`）。長い言葉ほど優先。
   - `keyword` を `*` にした行は「外出系だけど該当キーワードがない」ときの共通動画。
   - `driveFileId`：ファイルID、または共有URLをそのまま貼ってもOK。
   - `title`：動画の左下に出る説明。
5. 外出系かどうかは **Settings の OUTDOOR_KEYWORDS** で判定。キーワードを足せば判定範囲が広がります。
   - 外出系なら、動画がなくても「Google Earthで場所を見る」リンクが表示されます。
   - ブラウザが Drive の直接再生を受け付けない場合、自動で Drive プレビュー（タップで再生）に切り替わります。

### 5-6. AIモデルの変更
Settings シートの値を書き換えるだけで反映されます（最大10分キャッシュ）。
- `GEMINI_MODEL`：テキスト生成（初期値 `gemini-2.5-flash`）
- `GEMINI_TTS_MODEL`：読み上げ（初期値 `gemini-2.5-flash-preview-tts`）
- `TTS_VOICE`：声（Kore / Puck / Aoede など）

新しいモデル名に変える場合は、AI Studio のモデル一覧で正式な名前を確認してから入れてください。

---

## 6. 動作確認チェックリスト
- [ ] 新規登録 → 仮パスワードのメールが届く
- [ ] 仮パスワードでログイン → パスワード変更画面から先へ進めない
- [ ] 変更後、くじ・日記・分析が使える／パスワード欄の目アイコンで表示切替
- [ ] 「パスワードを忘れた」→ 新しい仮パスワードが届き、再び変更画面になる
- [ ] 4種のくじが動く（あみだは番号タップ・横線追加、トランプはカードめくり）
- [ ] 「散歩」系の結果で Earth Studio 動画 or Google Earth リンクが出る
- [ ] マイクで話す → 「AIで日記に清書」→ 各欄が埋まる → 写真付きで保存
- [ ] 日記の「読み上げ」で音声が流れる（失敗時は端末の読み上げに自動切替）
- [ ] 分析 → 冒険者タイプ・反逆率・シェアカードが表示される

## 7. 補足
- 音声入力（Web Speech API）は Chrome（Android/PC）と Safari（iOS）で動作。Firefox は非対応。
- 反逆率 = 「くじに逆らった」÷（「やった」＋「逆らった」）。日記保存時の「くじの結果どおりにやった？」から集計。
- メール送信は Gmail の1日あたりの送信上限（無料アカウントで約100通）に従います。

# 小説工房（shosetsu-kobo） v1.0.0

作風・時代・トーン・描写の切り口を選び、Gemini で「構成 → 章ごとの本文」を連鎖生成する長編小説Webアプリ。朗読（Gemini TTS）、ロケ地抽出（Google Earth 用 KML／カメラJSON）、Googleドライブ保存つき。

## ファイル構成

| ファイル | 置き場所 |
|---|---|
| index.html / style.css / app.js / config.js | GitHub リポジトリ（GitHub Pages） |
| Code.gs | Google Apps Script（スプレッドシートに紐づけ） |

## 1. スプレッドシートと GAS

1. Googleスプレッドシートを新規作成（名前は任意。例：小説工房DB）
2. 拡張機能 → Apps Script を開き、`Code.gs` の中身を貼り付けて保存
3. プロジェクトの設定 → スクリプト プロパティに追加
   - `GEMINI_API_KEY` … Google AI Studio で発行したキー（必須）
   - `GEMINI_TEXT_MODEL` … 使う文章モデル名（任意。既定 `gemini-2.5-flash`）
   - `GEMINI_TTS_MODEL` … 使う音声モデル名（任意。既定 `gemini-2.5-flash-preview-tts`）
   - `DEV_SHOW_TEMP_PASSWORD` … テスト中だけ `true`（仮パスワードを画面にも表示）。本番では削除
4. エディタで関数 `setup` を選んで実行 → 権限を承認
   - `Users` `Novels` シートと、ドライブに `小説工房_作品` フォルダが作られます
   - `PEPPER` と `DRIVE_ROOT_FOLDER_ID` が自動で登録されます
5. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
   - 次のユーザーとして実行：自分
   - アクセスできるユーザー：全員
6. 表示されたウェブアプリURL（…/exec）を控える

> Code.gs を書き換えたら、毎回「デプロイを管理 → 編集（鉛筆）→ バージョン：新バージョン → デプロイ」で更新してください。保存だけでは反映されません。

## 2. GitHub Pages

1. リポジトリ（例：`shosetsu-kobo`）を作り、4ファイルを置く
2. `config.js` の `GAS_API_URL` に控えたURLを貼る
3. Settings → Pages → Branch: main / root で公開
4. `https://kenken6291.github.io/shosetsu-kobo/` を開いて新規登録

## 3. 使い方の流れ

1. 設定：あらすじ案・作風・時代・トーン・切り口・章数・分量
2. 構成：AIが作った章立てを必要なら編集
3. 本文：「残りの章を順に書く」で1章ずつ生成（前章の要約＋直前の本文を引き継ぐ）
4. 朗読：章を区切って音声化 → 連続再生、区切りごと／結合WAVで保存
5. ロケ地：本文から舞台を抽出 → KML・カメラJSONを保存、「下見」で Google Earth を開く
6. 保存：ドライブの作品フォルダに `novel.txt` `novel.md` `plot.json` `earth_studio.json` `earth_studio.kml` `state.json`（再読込用）と `audio/` を保存

## Earth Studio での使い方

`earth_studio.json` の `keyframes` に、各ロケ地の到着時刻・注視点（target）・カメラ位置（camera：緯度/経度/海抜m）・距離/傾き/方位が入っています。Earth Studio でプロジェクトを作り、各時刻にこの値でカメラのキーフレームを打ってください。KML は Google Earth（Web/Pro）でロケ地とツアーの下見に使えます。

## 制限・注意

- GAS の1回の実行は最大6分。1章の分量を大きくしすぎると時間切れになることがあります（8,000字程度まで推奨）
- ログインは6時間操作がないと切れます（CacheService）
- AIの呼び出しは1人あたり6時間で300回まで（`DAILY_GEN_LIMIT` で変更可）
- 執筆途中の内容はブラウザに自動で下書き保存されます

# 起動・通信・バックグラウンド処理 解説

> **ドキュメント更新ルール**
> 以下のいずれかに該当する変更を `index.html` に加えた場合は、**必ず同じコミットでこのファイルも更新すること**。
> - Supabase / Scryfall / その他外部APIとの通信フローの変更
> - タイムアウト・リトライ・フォールバック・エラーハンドリングの変更
> - `remoteGet` / `remoteSet` / `_cachePut` / `_saveJa` などストレージ関数の変更
> - ポーリング・バックグラウンド処理の追加・変更・削除
> - 起動シーケンス（初期ロード・useState 初期化）の変更
> - ストレージキーの追加・変更・削除

## 概要

アプリは単一の `index.html` で動作する。データ永続化には **Supabase REST API**（設定済み）と **localStorage** を併用しており、Scryfall からカードデータを取得してローカルにキャッシュする仕組みになっている。

---

## 1. ページ読み込み時（スクリプト評価フェーズ）

React の `useEffect` が動く前に、スクリプト評価時点で以下が**同期的に**実行される。

```
localStorageからキャッシュを読み込む（同期・即時）
  ├─ _apiCache  ← cmd-card-cache-v1（カードデータ Map）
  └─ _jaCache   ← mtg-ja-img-v4（日本語画像UUID Map）
      ※ falseエントリは除去して再試行できるよう初期化
```

---

## 2. React 初期レンダリング（useState 初期化フェーズ）

`App` コンポーネントの `useState` 初期化時に **localStorage からプレイヤーデータを同期読み込み**する。
これにより、再訪問ユーザーは Supabase の応答を待たずにデッキ一覧が即時表示される。

```
useState(() => localStorage.getItem("cmd-players-v1"))
  → パース成功: プレイヤーデータをそのまま初期 state に設定
  → データなし / パース失敗: 空配列 []
```

> **新規ユーザー（localStorage 未保存）** は空の状態で描画 → その後 Supabase からデータを取得して更新される。

---

## 3. 初期ロード（`useEffect` / アプリ起動直後）

アプリが描画された直後に1回だけ実行される。

### ステップ1: Supabase から3キーを**並列**取得（同期待ち）

```
Promise.all で同時リクエスト:
  ├─ cmd-card-cache-v1  → _apiCache にマージ
  │     ルール: ローカルに日本語名があれば上書きしない
  │             ローカルに未存在なら追加
  ├─ mtg-ja-img-v4      → _jaCache にマージ
  │     ルール: falseエントリは無視・新規エントリのみ追加
  └─ cmd-players-v1     → setPlayers() でUIを更新
        ※ 旧データ互換: loots = p.loots || p.treasures || []

各リクエストのタイムアウト: 5秒（AbortController）
接続失敗（タイムアウト / ネットワークエラー）:
  → players キーでエラー発生時は supabaseFailed = true を記録
  → localStorage の値にフォールバック（値がなければ null）
  → setShowReloadBanner(true) で接続失敗バナーを表示

最悪ケースの待機時間: 5秒（以前は直列で最大10秒）
```

### ステップ2: バックグラウンド処理の起動

Supabase から取得した（またはフォールバックした）プレイヤーデータを元に、以下を非同期で起動する。

```
_runJaTextBgFetch()  ← 日本語テキストDB構築（後述 ステップ2.5）
UUID正規化・co補完  ← 後述 ステップ3
日本語名補完        ← 後述 ステップ4
日本語jt/jx補完     ← 後述 ステップ5
```

### ステップ2.5: 日本語テキストDB構築（バックグラウンド・UIをブロックしない）

```
_runJaTextBgFetch() が非同期で動作:
  1. IndexedDB (mtg-ja-text-v1) を開く
  2. localStorage の mtg-ja-fetch-v1 でフェッチ進捗を確認
     - 完了済み かつ 7日以内 → スキップ
     - 未完了 → 前回の続きページから再開
  3. Scryfall から lang:ja カードを500ms間隔でページングフェッチ
     GET https://api.scryfall.com/cards/search?q=lang%3Aja&unique=cards&order=name&page={n}
  4. 取得した jt/jx をバッチで IndexedDB に書き込み
     キー: n（英語名）、値: { n, j, jt, jx, jaId }
  5. 全ページ完了またはエラー時に進捗をlocalStorageに保存して終了
     ※ エラーは全てサイレント処理（次回起動時に再開）
```

### ステップ3: バックグラウンド UUID 正規化（非同期・UIをブロックしない）

```
プレイヤーの全カードID（decks + wants + loots）を収集
  ↓
未キャッシュ OR co未設定 のカードだけ抽出（処理済みはスキップ）
  ↓ needsUpdate が空なら即終了
カードごとに（110ms間隔）:
  1. GET https://api.scryfall.com/cards/{id}
  2. lang ≠ "en" の場合
     → GET https://api.scryfall.com/cards/named?exact={name}
       で英語版正規UUIDを取得（UUID正規化）
  3. _cachePut() でキャッシュ更新
     保存フィールド: id, n, j, t, ci, co, p, th, r, cat
     ※ j（日本語名）は既存キャッシュの値を優先保持（上書き禁止）
       jaName || _apiCache.get(id)?.j || _apiCache.get(canonicalId)?.j || ""
  ↓
UUID変更があった場合:
  → setPlayers() でプレイヤーデータの全IDを更新
  → remoteSet(PLAYERS_KEY) で Supabase に保存
```

### ステップ4: 日本語名補完（非同期・UIをブロックしない）

```
全カードのうち j（日本語名）が空のものを対象:
  ケースA: _jaCache にUUIDなし
    → fetchJaId() キューに投入
      ※ 250ms間隔のシリアルキューで処理（rate-limit対策）
      　 2回のAPIで日本語UUIDと名前を取得し _apiCache.j を補完
  ケースB: _jaCache にUUIDあり・名前なし
    → GET https://api.scryfall.com/cards/{jaId}
       で日本語名を直接取得して _apiCache.j を補完
       ※ 同時に jt/jx も補完
```

### ステップ5: 日本語タイプ・テキスト補完（非同期・UIをブロックしない）

```
全カードのうち j はあるが jt/jx が空のものを対象（200ms間隔シリアル処理）:
  _jaCache にUUIDあり:
    → GET https://api.scryfall.com/cards/{jaId}
       printed_type_line → _apiCache.jt
       printed_text      → _apiCache.jx
  _jaCache にUUIDなし:
    → fetchJaId() キュー経由（_runJaQueue が jt/jx も更新）
```

---

## 4. ポーリング（起動後・5秒ごと）

Supabase が設定されている場合のみ動作する。

```
毎5秒（多重実行ガード付き）:
  polling フラグが true なら今回のポーリングをスキップ
  polling = true
  → GET cmd-players-v1 from Supabase（タイムアウト 5秒）
    → 成功: setPlayers() でUI更新（他ユーザーの変更をリアルタイムに反映）
    → 失敗: 無視（フォールバックなし・バナーは表示しない）
  finally: polling = false
```

> **多重実行ガードの理由**: タイムアウトが5秒・ポーリング間隔も5秒のため、接続不良時にポーリングが積み重なりブラウザのメモリ不足・クラッシュを引き起こす問題を防ぐ（v1.11.2 で修正）。

---

## 5. Supabase 接続失敗時の挙動

### タイムアウト設定

| 場面 | タイムアウト | 実装 |
|---|---|---|
| 初期ロード（全3キー） | 各5秒 | AbortController |
| ポーリング（5秒ごと） | 各5秒 | AbortController |

### 接続失敗時のフォールバック

```
remoteGet(key, { onFallback }) の失敗時:
  1. AbortError（タイムアウト）またはネットワークエラーを catch
  2. onFallback コールバックがあれば呼び出す
  3. localStorage.getItem(key) の値を返す
     - 値あり: パースして返す（キャッシュデータで継続動作）
     - 値なし: null を返す
```

### 初期ロード失敗時のユーザー通知

初期ロードで `cmd-players-v1` の取得がフォールバックした場合：

```
supabaseFailed = true が記録される
  → setShowReloadBanner(true)
  → 画面上部に赤いバナーを表示:
      「サーバーへの接続に失敗しました」
      「キャッシュデータで表示しています。最新データを取得するには再読み込みしてください。」
      [🔄 再読み込み] ボタン → location.reload()
      [✕ 閉じる] ボタン → バナーを非表示（動作は継続可能）
```

> バナーはポーリング失敗では表示されない（初期ロード時のみ）。

### localStorage にデータがない場合（新規ユーザー）

```
初回アクセス / キャッシュクリア後:
  - Supabase が応答: 正常にデータ取得・表示
  - Supabase がタイムアウト: players = null → setPlayers() が呼ばれず空状態のまま
    ※ バナーは表示される（再読み込みを促す）
```

---

## 6. ユーザー操作による通信

### カード検索（SEARCHタブ・欲しいカードタブ）

```
統率者モード（SEARCHタブのみ）:
  └─ _apiCache 内をインクリメンタル検索（通信なし）

全カードモード / 欲しいカードタブ検索（350msデバウンス）:
  英語クエリ（並列）:
    1. GET https://api.scryfall.com/cards/search?q={expanded}&unique=cards
    2. GET https://api.scryfall.com/cards/search?q=lang:ja+{expanded}
    3. ローカル _apiCache を補助検索（n/t マッチ）
  日本語クエリ（並列）:
    1. GET https://api.scryfall.com/cards/search?q=lang:ja+{query}  ← 名前検索
    2. GET https://api.scryfall.com/cards/search?q=lang:ja+t:{query}  ← タイプ検索
    3. _jaTextSearch(q) ← IndexedDB全文検索（jt/jxに対してマッチ）
    4. ローカル _apiCache を補助検索（j/jt/jx マッチ）
    ※ IndexedDB結果は _nameIndex でUUID解決して _apiCache とマージ
  結果を _cachePut() でキャッシュ（co含む）
```

### カード画像表示（CardImg コンポーネント）

```
日本語イラストを優先表示:
  1. fetchJaId() で日本語UUID取得（キャッシュ済みなら即返却）
  2. キャッシュなし → _jaQueue 経由で取得:
       GET /cards/named?exact={name}
       GET /cards/search?q=oracleid:{id}%20lang:ja  ← encodeURIComponent でスペース区切り
  3. 取得した jaUUID で Scryfall CDN の画像URLを構築
     https://cards.scryfall.io/{size}/front/{id[0]}/{id[1]}/{id}.jpg
```

### プレイヤーデータ変更（デッキ追加・削除・名前変更など）

```
即時:
  → setPlayers() でUIに反映
  → remoteSet(PLAYERS_KEY) で Supabase に保存
  → localStorage にも同時保存（次回起動の即時表示用）
```

### 欲しいカードインポート（カード名テキスト一括登録）

```
カード名1件ごとに（110ms間隔）:
  _apiCache にヒットすれば通信なし
  なければ GET https://api.scryfall.com/cards/named?fuzzy={name}
    → _cachePut() でキャッシュ（co含む）
    → プレイヤーの wants に追加
```

---

## 7. キャッシュ書き込み（`_cachePut`）のデバウンス同期

カードデータが更新されるたびに以下が走る。

```
_apiCache（メモリ上のMap）を即時更新
  ↓
localStorage に即時書き込み（cmd-card-cache-v1）
  ↓
3秒後（デバウンス）に Supabase へ同期
  remoteSet(cmd-card-cache-v1, [..._apiCache])
  ※ 3秒以内に別の書き込みがあればタイマーリセット
```

日本語画像UUIDキャッシュ（`_saveJa`）も同様に localStorage 即時 + 3秒デバウンスで Supabase 同期。

---

## 8. ストレージキーまとめ

| キー | 保存先 | 内容 | 更新タイミング |
|---|---|---|---|
| `cmd-players-v1` | Supabase + localStorage | プレイヤーデータ全体 | デッキ/カード追加・削除・名前変更など |
| `cmd-card-cache-v1` | Supabase + localStorage | カードデータ Map（全キャッシュ） | カード取得のたびに即時 + 3秒デバウンス同期 |
| `mtg-ja-img-v4` | Supabase + localStorage | 英語UUID → 日本語UUID のマッピング | fetchJaId 成功時に即時 + 3秒デバウンス同期 |
| `mtg-ja-text-v1` | IndexedDB（ローカルのみ） | 英語名キー → { n, j, jt, jx, jaId } | _runJaTextBgFetch() によるバックグラウンド構築 |
| `mtg-ja-fetch-v1` | localStorage | 日本語テキストDBフェッチ進捗 { page, done, ts } | _runJaTextBgFetch() 実行時に更新 |

---

## 9. 通信先まとめ

| 通信先 | 用途 | タイムアウト |
|---|---|---|
| `https://cpvpowzwahhuxbhgqdtq.supabase.co` | プレイヤーデータ・キャッシュの永続化と共有 | 5秒 |
| `https://api.scryfall.com/cards/{id}` | カードデータ取得（UUID正規化・co補完） | なし（110ms間隔） |
| `https://api.scryfall.com/cards/named?exact=` | 英語カード正規UUID取得 / 日本語UUID検索の前段 | なし |
| `https://api.scryfall.com/cards/search?q=oracleid:...%20lang:ja` | 日本語版UUIDの検索（encodeURIComponentでスペース区切り） | なし |
| `https://api.scryfall.com/cards/search?q={query}` | 全カードモード検索（SEARCHタブ・欲しいカードタブ） | なし |
| `https://cards.scryfall.io/` | カード画像CDN（直接参照・通信はブラウザが処理） | なし |
| `https://fonts.googleapis.com/` | Cinzel / IBM Plex Mono / Noto Sans JP | なし |
| `https://cdn.jsdelivr.net/npm/mana-font@latest/` | MTGマナシンボルフォント | なし |

---

## 10. 起動シーケンス タイムライン

```
t=0ms   ページ読み込み
        └─ _apiCache・_jaCache を localStorage から同期読み込み

t=~0ms  React 初期レンダリング
        └─ players を localStorage から同期読み込み → デッキ一覧を即時表示（再訪問ユーザー）

t=~10ms useEffect 起動
        └─ Promise.all で Supabase に3リクエスト並列送信
             ├─ cmd-card-cache-v1
             ├─ mtg-ja-img-v4
             └─ cmd-players-v1

           【Supabase が正常応答の場合】
t=~500ms〜3000ms  Supabase からデータ受信
                  └─ キャッシュマージ → setPlayers() でUI更新（最新データに切り替わる）

           【Supabase がタイムアウトの場合】
t=5000ms  AbortController がリクエストをキャンセル
          └─ localStorage フォールバック
          └─ 接続失敗バナー表示（🔄 再読み込みを促す）

t=5000ms〜 バックグラウンド処理（UUID正規化・日本語補完）が順次実行

t=5秒ごと  ポーリング（多重実行ガード付き）
           └─ Supabase から最新プレイヤーデータを取得してUI更新
```

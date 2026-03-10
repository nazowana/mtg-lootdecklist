# 起動・通信・バックグラウンド処理 解説

## 概要

アプリは単一の `index.html` で動作する。データ永続化には **Supabase REST API**（設定済み）と **localStorage** を併用しており、Scryfall からカードデータを取得してローカルにキャッシュする仕組みになっている。

---

## 1. ページ読み込み時（スクリプト評価フェーズ）

React の `useEffect` が動く前に、スクリプト評価時点で以下が実行される。

```
localStorageからキャッシュを読み込む
  ├─ _apiCache  ← cmd-card-cache-v1（カードデータ Map）
  └─ _jaCache   ← mtg-ja-img-v4（日本語画像UUID Map）
      ※ falseエントリは除去して再試行できるよう初期化
```

---

## 2. 初期ロード（`useEffect` / アプリ起動直後）

アプリが描画された直後に1回だけ実行される。**順序は以下の通り**。

### ステップ1: Supabase からキャッシュをマージ（同期待ち）

```
Supabase から並列取得:
  ├─ cmd-card-cache-v1 → _apiCache にマージ
  │     ルール: ローカルに日本語名があれば上書きしない
  │             ローカルに未存在なら追加
  └─ mtg-ja-img-v4    → _jaCache にマージ
        ルール: falseエントリは無視・新規エントリのみ追加
```

### ステップ2: プレイヤーデータ取得（同期待ち）

```
Supabase から cmd-players-v1 を取得
  → setPlayers() でUIに反映（ここで初めてデッキ一覧が表示される）
  ※ 旧データ互換: loots = p.loots || p.treasures || []
  → _runJaTextBgFetch() を呼び出し（サイレントバックグラウンド処理）
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

## 3. ポーリング（起動後・5秒ごと）

Supabase が設定されている場合のみ動作する。

```
毎5秒:
  GET cmd-players-v1 from Supabase
    → setPlayers() でUI更新
       （他のブラウザ/ユーザーの変更をリアルタイムに反映）
```

---

## 4. ユーザー操作による通信

### カード検索（SEARCHタブ）

```
統率者モード:
  └─ _apiCache 内をインクリメンタル検索（通信なし）

全カードモード（350msデバウンス）:
  英語クエリ:
    1. GET https://api.scryfall.com/cards/search?q={query}&unique=cards
    2. GET https://api.scryfall.com/cards/search?q=lang:ja+{query}
    3. 結果を _cachePut() でキャッシュ（co含む）
    4. ローカル _apiCache を補助検索（n/t/j/jt/jx マッチ）
  日本語クエリ（並列実行）:
    1. GET https://api.scryfall.com/cards/search?q=lang:ja+{query}  ← 名前検索
    2. GET https://api.scryfall.com/cards/search?q=lang:ja+t:{query}  ← タイプ検索
    3. _jaTextSearch(q) ← IndexedDB全文検索（jt/jxに対してマッチ）
    4. ローカル _apiCache を補助検索（j/jt/jx マッチ）
    ※ IndexedDB結果は _nameIndex でUUID解決して _apiCache とマージ
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

## 5. キャッシュ書き込み（`_cachePut`）のデバウンス同期

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

## 6. ストレージキーまとめ

| キー | 保存先 | 内容 | 更新タイミング |
|---|---|---|---|
| `cmd-players-v1` | Supabase + localStorage | プレイヤーデータ全体 | デッキ/カード追加・削除・名前変更など |
| `cmd-card-cache-v1` | Supabase + localStorage | カードデータ Map（全キャッシュ） | カード取得のたびに即時 + 3秒デバウンス同期 |
| `mtg-ja-img-v4` | Supabase + localStorage | 英語UUID → 日本語UUID のマッピング | fetchJaId 成功時に即時 + 3秒デバウンス同期 |
| `mtg-ja-text-v1` | IndexedDB（ローカルのみ） | 英語名キー → { n, j, jt, jx, jaId } | _runJaTextBgFetch() によるバックグラウンド構築 |
| `mtg-ja-fetch-v1` | localStorage | 日本語テキストDBフェッチ進捗 { page, done, ts } | _runJaTextBgFetch() 実行時に更新 |

---

## 7. 通信先まとめ

| 通信先 | 用途 |
|---|---|
| `https://cpvpowzwahhuxbhgqdtq.supabase.co` | プレイヤーデータ・キャッシュの永続化と共有 |
| `https://api.scryfall.com/cards/{id}` | カードデータ取得（UUID正規化・co補完） |
| `https://api.scryfall.com/cards/named?exact=` | 英語カード正規UUID取得 / 日本語UUID検索の前段 |
| `https://api.scryfall.com/cards/search?q=oracleid:...%20lang:ja` | 日本語版UUIDの検索（encodeURIComponentでスペース区切り） |
| `https://api.scryfall.com/cards/search?q={query}` | 全カードモード検索 |
| `https://cards.scryfall.io/` | カード画像CDN（直接参照・通信はブラウザが処理） |
| `https://fonts.googleapis.com/` | Cinzel / IBM Plex Mono / Noto Sans JP |
| `https://cdn.jsdelivr.net/npm/mana-font@latest/` | MTGマナシンボルフォント |

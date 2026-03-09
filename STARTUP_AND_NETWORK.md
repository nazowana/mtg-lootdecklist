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
  1. GET https://api.scryfall.com/cards/search?q={query}&lang=ja
  2. GET https://api.scryfall.com/cards/search?q={query}&lang=en
  3. 結果を _cachePut() でキャッシュ（co含む）
```

### カード画像表示（CardImg コンポーネント）

```
日本語イラストを優先表示:
  1. fetchJaId() で日本語UUID取得（キャッシュ済みなら即返却）
  2. キャッシュなし → _jaQueue 経由で取得:
       GET /cards/named?exact={name}
       GET /cards/search?q=oracleid:{id}+lang:ja
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

---

## 7. 通信先まとめ

| 通信先 | 用途 |
|---|---|
| `https://cpvpowzwahhuxbhgqdtq.supabase.co` | プレイヤーデータ・キャッシュの永続化と共有 |
| `https://api.scryfall.com/cards/{id}` | カードデータ取得（UUID正規化・co補完） |
| `https://api.scryfall.com/cards/named?exact=` | 英語カード正規UUID取得 / 日本語UUID検索の前段 |
| `https://api.scryfall.com/cards/search?q=oracleid:...+lang:ja` | 日本語版UUIDの検索 |
| `https://api.scryfall.com/cards/search?q={query}` | 全カードモード検索 |
| `https://cards.scryfall.io/` | カード画像CDN（直接参照・通信はブラウザが処理） |
| `https://fonts.googleapis.com/` | Cinzel / IBM Plex Mono / Noto Sans JP |
| `https://cdn.jsdelivr.net/npm/mana-font@latest/` | MTGマナシンボルフォント |

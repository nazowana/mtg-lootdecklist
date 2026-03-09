# MTG LOOT VAULT — Claude Code 引き継ぎドキュメント

## プロジェクト概要
Magic: The Gathering の統率者（Commander）デッキ管理ツール。
複数プレイヤーが「誰がどの統率者デッキ・欲しいカードを持っているか」を共有・確認するためのWebアプリ。

## ファイル構成
```
index.html   # メインアプリ（これ1ファイルで動作する）
```
※ `commanders.json` は廃止済み。カードデータはすべてScryfall APIからオンデマンド取得し、キャッシュに保存する。

## 技術スタック
- **フロントエンド**: React 18（CDN）+ Babel standalone（JSXトランスパイル）
- **スタイル**: `<style>`タグ内CSS（ダーク/ライトテーマ対応、`data-theme`属性で切り替え）
- **フォント**: Google Fonts（Cinzel, IBM Plex Mono, Noto Sans JP）
- **カード画像**: Scryfall CDN `https://cards.scryfall.io/{size}/front/{id[0]}/{id[1]}/{id}.jpg`
- **カードデータ**: Scryfall APIから検索時に取得し、`_apiCache`（localStorage + Supabase）にキャッシュ

## データ構造

### カードデータ（`_apiCache` の各エントリ）
```json
{
  "id": "396f9198-...",   // Scryfall UUID（英語版正規ID）
  "n": "Abdel Adrian",   // 英語名
  "j": "ゴライオンの養子、アブデル・エイドリアン",  // 日本語名（なければ空文字）
  "t": "Legendary Creature — Human Warrior",  // タイプライン
  "ci": ["W"],           // カラーアイデンティティ（起動型能力の色も含む）
  "co": ["W"],           // マナコストの色のみ（カラーフィルタで使用）
  "p": "4",              // パワー（nullの場合あり）
  "th": "4",             // タフネス（nullの場合あり）
  "r": "u",              // レアリティ m/r/u/c/s の1文字
  "cat": "c"             // カテゴリ c=クリーチャー / v=機体 / s=テキスト指定
}
```

### プレイヤーデータ（ストレージに保存）
```json
[
  {
    "id": "1234567890",      // タイムスタンプ
    "name": "Alice",
    "color": "#c5a557",      // アバターカラー
    "decks": ["396f9198-...", "bf708169-..."],   // 統率者デッキのScryfall UUID配列
    "wants": ["abc123-...", "def456-..."],        // 欲しいカードのScryfall UUID配列
    "loots": ["abc123-..."],                      // おたから（優先欲しいカード）UUID配列
    "arts": { "396f9198-...": "alternative-uuid" }, // カスタム画像UUID（カード別）
    "brackets": { "396f9198-...": 3 }            // デッキのブラケット評価（1〜5）
  }
]
```

## ストレージ

### Supabase設定（現在は設定済み）
```js
const SUPABASE_URL = "https://cpvpowzwahhuxbhgqdtq.supabase.co";
const SUPABASE_ANON_KEY = "...";
const STORAGE_TABLE = "mtg_vault";
```

### ストレージキー一覧
| キー | 内容 | 形式 |
|---|---|---|
| `cmd-players-v1` | プレイヤーデータ | JSON配列 |
| `cmd-card-cache-v1` | カードデータキャッシュ | `[[uuid, cardObj], ...]`（Mapエントリ形式） |
| `mtg-ja-img-v4` | 日本語画像UUID | `{ uuid: jaUuid }` オブジェクト |

- **Supabase設定時**: REST APIでリモート保存、5秒ポーリングで全員に同期
- **Supabase未設定時**: `localStorage`のみで動作（単一ブラウザのみ）
- カードキャッシュ・日本語画像UUIDは変更から3秒後にSupabaseへデバウンス同期

### Supabaseテーブル定義
```sql
create table mtg_vault (
  key text primary key,
  value text
);
alter table mtg_vault enable row level security;
create policy "public" on mtg_vault for all using (true);
```

## アプリ機能

### SEARCHタブ
- **統率者モード**: `_apiCache`内を英語/日本語名でインクリメンタル検索
- **全カードモード**: Scryfall API（`/cards/search`）をデバウンスで検索（全カード対象）
- グリッド形式でカードイラスト表示
- カードクリックで右パネル（DetailPane）に拡大表示
  - パネル幅をドラッグで調整可能（左端のリサイズハンドル）
  - 画像クリックでライトボックス（全画面ズーム）表示
  - 各プレイヤーへのデッキ登録ボタン / 欲しいカード登録ボタン
  - 欲しいカード横に「💎 おたから」トグルボタン

### 統率者デッキタブ
- プレイヤー追加（名前＋カラー選択・HEXカスタム入力対応）
- 各プレイヤーの行に登録済みデッキのイラストをサムネイル表示
- **ブラケットモード**: デッキごとに強さ評価（1〜5）をバッジ表示・編集
- **削除モード**: デッキ削除・プレイヤー削除
- カラーフィルターバー（マナコスト色で絞り込み）

### 欲しいカードタブ
- 各プレイヤーの欲しいカード（wants）をサムネイル表示
- **おたからモード（💎）**: `loots`に登録されたカードを先頭にソート
- **インポート**: カード名テキストをScryfall APIで一括検索して登録
- **削除モード**: カード削除・プレイヤー削除
- カラーフィルターバー（マナコスト色で絞り込み）

### カラーフィルターバー
```
[白][青][黒][赤][緑][⛰土地][◇無色] | [多色] [✕ クリア]
```
- 単色（白/青/黒/赤/緑）: `co`（マナコスト色）が1色でその色のみのカードにマッチ
- 無色（◇）: `co`が空のカード
- 多色: `co`が2色以上のカード（金色ボタン）
- 土地（⛰）: タイプラインに"Land"を含むカード（色フィルタと独立）
- 複数選択時はOR条件
- 統率者デッキ・欲しいカードタブ両方に表示

## ドキュメント更新ルール（必須）
- **`index.html` の構成・通信・データ構造を変更した場合は、必ず同じコミットで以下のMDを更新すること**
  - アーキテクチャ・データ構造の変更 → `CLAUDE.md`
  - 通信フロー・起動処理・バックグラウンド処理の変更 → `STARTUP_AND_NETWORK.md`
  - 両方に跨る変更（ストレージキー追加、新規APIエンドポイント等）→ 両方更新
- MDの更新を省略・後回しにしてはならない

## バージョン管理ルール
- `APP_VERSION` は `index.html` の85行目付近に定義
- 通常変更: `1.xx.yy`（パッチ番号を1ずつ上げる）
- 大きな変更（新規ページや新たな仕組み）のみ: `1.(xx+1).0`
- 変更するたびにバージョンを上げ → コミット → プッシュまで行う

## リポジトリ
- GitHub: https://github.com/nazowana/mtg-lootdecklist
- デプロイ: GitHub Pages（mainブランチへのプッシュで自動反映）

## 今後の改善候補（未実装）
- Supabase Realtime（WebSocket）によるポーリングレスのリアルタイム同期
- デッキ名のカスタム入力（現状は統率者名のみ）
- カード詳細にオラクルテキスト表示
- モバイルレイアウトのさらなる最適化

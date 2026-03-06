# MTG VAULT — Claude Code 引き継ぎドキュメント

## プロジェクト概要
Magic: The Gathering の統率者（Commander）デッキ管理ツール。
複数プレイヤーが「誰がどの統率者デッキを持っているか」を共有・確認するためのWebアプリ。

## ファイル構成
```
mtg-vault.html       # メインアプリ（これ1ファイルで動作する）
commanders.json      # Scryfallから取得した統率者カードデータ（3141枚）
```

## 技術スタック
- **フロントエンド**: React 18（CDN）+ Babel standalone（JSXトランスパイル）
- **スタイル**: CSS-in-JS（`<style>`タグ内に記述）
- **フォント**: Google Fonts（Cinzel, IBM Plex Mono, Noto Sans JP）
- **カード画像**: Scryfall CDN `https://cards.scryfall.io/{size}/front/{id[0]}/{id[1]}/{id}.jpg`
- **カードデータ**: Scryfallから事前取得してHTMLに埋め込み済み（起動時の通信ゼロ）

## データ構造

### カードデータ（commanders.json の各要素）
```json
{
  "id": "396f9198-...",   // Scryfall UUID（画像URLの構築に使用）
  "n": "Abdel Adrian",   // 英語名
  "j": "ゴライオンの養子、アブデル・エイドリアン",  // 日本語名（なければ空文字）
  "t": "Legendary Creature — Human Warrior",  // タイプライン
  "ci": ["W"],            // 色アイデンティティ配列 W/U/B/R/G
  "p": "4",               // パワー（nullの場合あり）
  "th": "4",              // タフネス（nullの場合あり）
  "r": "u",               // レアリティ m/r/u/c/s の1文字
  "cat": "c"              // カテゴリ c=クリーチャー / v=機体 / s=テキスト指定
}
```

### プレイヤーデータ（ストレージに保存）
```json
[
  {
    "id": "1234567890",     // タイムスタンプ
    "name": "Alice",
    "color": "#c5a557",     // アバターカラー
    "decks": ["396f9198-...", "bf708169-..."]  // 登録済み統率者のScryfall UUID配列
  }
]
```

## ストレージ

### 現在の実装（HTML内）
```js
const SUPABASE_URL = "";       // 未設定 = localStorageで動作
const SUPABASE_ANON_KEY = "";
const STORAGE_TABLE = "mtg_vault";
```

- **Supabase未設定時**: `localStorage` にキー `cmd-players-v1` で保存（単一ブラウザのみ）
- **Supabase設定時**: REST APIでリモート保存、5秒ポーリングで全員に同期

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
- 統率者名（英語・日本語）でインクリメンタル検索
- グリッド形式でカードイラスト表示
- カードクリックで右パネルに拡大表示＋プレイヤーへのデッキ登録ボタン

### PLAYERSタブ
- プレイヤー追加（名前＋カラー選択）
- 各プレイヤーの行に登録済みデッキのイラストを横並びで表示
- 「✎ 編集」モードでデッキ削除・プレイヤー削除

## 今後の改善候補（未実装）
- Supabase Realtime（WebSocket）によるポーリングレスのリアルタイム同期
- デッキ名のカスタム入力（現状は統率者名のみ）
- カード詳細にオラクルテキスト表示（Scryfall APIから追加取得が必要）
- モバイル対応レイアウト
- デプロイ（Netlify推奨: HTMLファイルをドラッグ�アンドドロップするだけ）

## commanders.json の再生成方法
Scryfallから再取得する場合（新セット追加時など）:
```bash
python3 << 'EOF'
import subprocess, json, time

def fetch(url):
    r = subprocess.run(["curl","-s","-A","MTGVault/1.0",url], capture_output=True, text=True)
    return json.loads(r.stdout)

def fetch_all(url):
    cards = []
    while url:
        d = fetch(url)
        cards.extend(d["data"])
        url = d.get("next_page") if d.get("has_more") else None
        time.sleep(0.11)
    return cards

en = fetch_all("https://api.scryfall.com/cards/search?q=is%3Acommander&order=name&unique=cards")
jp = fetch_all("https://api.scryfall.com/cards/search?q=is%3Acommander+lang%3Aja&order=name&unique=cards")
jp_map = {c["name"]: c.get("printed_name","") for c in jp if c.get("printed_name")}

def cat(c):
    t = c.get("type_line",""); txt = (c.get("oracle_text") or "").lower()
    if ("Vehicle" in t or "Spacecraft" in t) and "Creature" not in t: return "v"
    if "can be your commander" in txt and "Creature" not in t: return "s"
    return "c"

result = sorted([{
    "id":c["id"],"n":c["name"],"j":jp_map.get(c["name"],""),
    "t":c.get("type_line",""),"ci":c.get("color_identity",[]),
    "p":c.get("power"),"th":c.get("toughness"),
    "r":(c.get("rarity","common") or "c")[0],"cat":cat(c)
} for c in en], key=lambda x: x["n"])

with open("commanders.json","w") as f:
    json.dump(result, f, ensure_ascii=False, separators=(',',':'))
print(f"Done: {len(result)} cards")
EOF
```

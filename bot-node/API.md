# Super Soundboard API 仕様書

## 概要

Super Soundboard Bot の REST API サーバーです。config.json の設定情報と音声ファイルにアクセスできます。

## ベース URL

デフォルトでは `http://localhost:3211` で API サーバーが起動します。

ポート番号は環境変数 `API_PORT` で変更できます。

```bash
# .envファイルまたは環境変数で設定
API_PORT=3211
```

## CORS

全てのオリジンからのアクセスが許可されています。

## エンドポイント

### 1. 設定情報の取得

config.json の内容を取得します。

**エンドポイント:** `GET /api/config`

**リクエスト:**

```
GET /api/config HTTP/1.1
Host: localhost:3211
```

**レスポンス（成功時）:**

```json
{
  "success": true,
  "data": {
    "mappings": [
      {
        "keywords": ["なにこれ", "何これ"],
        "file": "nanikore.mp3",
        "volume": 1
      }
    ],
    "cooldownMs": 2500,
    "lang": "ja-JP",
    "wsPort": 3210
  }
}
```

**レスポンス（エラー時）:**

```json
{
  "success": false,
  "error": "Failed to retrieve configuration"
}
```

**ステータスコード:**

- `200 OK` - 成功
- `500 Internal Server Error` - サーバー内部エラー

---

### 2. 音声ファイルの取得

指定した音声ファイルをストリーミング配信します。

**エンドポイント:** `GET /api/sounds/:filename`

**パラメータ:**

- `filename` (必須) - 取得する音声ファイル名（例: `nanikore.mp3`）

**リクエスト:**

```
GET /api/sounds/nanikore.mp3 HTTP/1.1
Host: localhost:3211
```

**レスポンス（成功時）:**

- Content-Type: `audio/mpeg` (MP3 の場合)、`audio/wav` (WAV の場合)、`audio/ogg` (OGG の場合)、`audio/mp4` (M4A の場合)
- Content-Disposition: `inline; filename="nanikore.mp3"`
- Body: 音声ファイルのバイナリストリーム

**レスポンス（エラー時）:**

```json
{
  "success": false,
  "error": "Invalid filename"
}
```

または

```json
{
  "success": false,
  "error": "Sound file not found"
}
```

**ステータスコード:**

- `200 OK` - 成功
- `400 Bad Request` - 無効なファイル名（パストラバーサル攻撃を防ぐため、`..`, `/`, `\` を含むファイル名は拒否されます）
- `404 Not Found` - ファイルが存在しない
- `500 Internal Server Error` - サーバー内部エラー

**セキュリティ:**

- ディレクトリトラバーサル攻撃を防ぐため、ファイル名に `..`, `/`, `\` が含まれている場合はエラーを返します
- `bot-node/sounds/` ディレクトリ内のファイルのみアクセス可能です

---

### 3. 音声ファイル一覧の取得

利用可能な音声ファイルの一覧を取得します。

**エンドポイント:** `GET /api/sounds`

**リクエスト:**

```
GET /api/sounds HTTP/1.1
Host: localhost:3211
```

**レスポンス（成功時）:**

```json
{
  "success": true,
  "data": ["nanikore.mp3", "nanikore.wav", "29738d04f7b1d31c.wav"]
}
```

**レスポンス（エラー時）:**

```json
{
  "success": false,
  "error": "Failed to list sound files"
}
```

**ステータスコード:**

- `200 OK` - 成功
- `500 Internal Server Error` - サーバー内部エラー

**対応フォーマット:**

- `.mp3`
- `.wav`
- `.ogg`
- `.m4a`

---

### 4. ヘルスチェック

API サーバーが正常に動作しているかを確認します。

**エンドポイント:** `GET /api/health`

**リクエスト:**

```
GET /api/health HTTP/1.1
Host: localhost:3211
```

**レスポンス:**

```json
{
  "success": true,
  "status": "ok"
}
```

**ステータスコード:**

- `200 OK` - 常に成功

---

## 使用例

### cURL での例

```bash
# 設定情報の取得
curl http://localhost:3211/api/config

# 音声ファイル一覧の取得
curl http://localhost:3211/api/sounds

# 音声ファイルのダウンロード
curl http://localhost:3211/api/sounds/nanikore.mp3 -o nanikore.mp3

# ヘルスチェック
curl http://localhost:3211/api/health
```

### JavaScript での例

```javascript
// 設定情報の取得
const response = await fetch("http://localhost:3211/api/config");
const config = await response.json();
console.log(config.data);

// 音声ファイル一覧の取得
const soundsResponse = await fetch("http://localhost:3211/api/sounds");
const sounds = await soundsResponse.json();
console.log(sounds.data);

// 音声ファイルの再生
const audio = new Audio("http://localhost:3211/api/sounds/nanikore.mp3");
audio.play();
```

## エラーハンドリング

全てのエラーレスポンスは以下の形式で返されます：

```json
{
  "success": false,
  "error": "エラーメッセージ"
}
```

クライアント側では、`success` フィールドをチェックしてエラーハンドリングを行うことを推奨します。

## ログ

API サーバーのログは標準出力に以下の形式で出力されます：

```
[2025-12-24T10:30:00.000Z] [INFO] API server started on port 3211
[2025-12-24T10:30:05.000Z] [ERROR] Failed to serve sound file via API {"error":"ENOENT: no such file or directory"}
```

## 注意事項

1. API サーバーは Discord Bot と同じプロセスで動作します
2. `config.json` を更新した場合、Bot を再起動する必要があります
3. 音声ファイルは `bot-node/sounds/` ディレクトリに配置してください
4. セキュリティ上、本番環境では適切なファイアウォール設定やリバースプロキシの使用を推奨します

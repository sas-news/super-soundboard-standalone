# Discord VC 効果音ボット (Super Soundboard) - Modified

> [!WARNING]
> **【重要】身内用・個人利用についての注意**
> このリポジトリはオリジナルの [Super Soundboard](https://github.com/kokushin/super-soundboard) をフォークし、個人的な用途に合わせて大幅に改造したものです。
> 
> *   **セキュリティ**: ユーザー入力に基づいてファイルを保存・削除する機能（`/sound add` 等）が含まれています。信頼できる身内のみのサーバーでの利用を想定しており、公開サーバーでの運用は推奨しません。
> *   **安定性**: 個人用に突貫で作った機能も多く、エラー処理などが不十分な場合があります。
> *   **Google Speech API**: 暫定的に公開APIキーが埋め込まれていますが、`.env` で独自の `GOOGLE_API_KEY` を設定することも可能です。
> 
> これらを理解した上で、自己責任でご利用ください。

## 概要

Discord のボイスチャンネル (VC) での発言を認識し、特定のキーワードに反応して効果音を再生するボットです。
オリジナル版は Chrome の音声認識 (Web Speech API) を利用していましたが、この改造版では **Discord Bot 単体で完結** するように変更されています。ブラウザを開いておく必要はありません。

### 主な変更点・機能

*   **Discord Native**: 音声認識も Node.js アプリケーション内で行います（Chrome 不要）。
*   **コマンドによる管理**: 効果音の追加、削除、編集が Discord のスラッシュコマンド (`/sound`) だけで完結します。
*   **ファイルダウンロード**: `/sound add` コマンドで音声ファイルを添付するだけで、自動的にサーバーへダウンロート・保存されます。
*   **連続音声認識**: 会話の途中の単語も拾えるように、逐次認識を行っています。
*   **ボリューム調整**: 効果音ごとに音量をパーセンテージで設定可能です。
*   **自動切断**: チャンネルに誰もいなくなると自動的に退室します。

## 必要なもの

*   **Node.js**: v20 以上推奨
*   **FFmpeg**: システムの PATH に通っている必要があります。音声の変換に使用します。
*   **Discord Bot Token**: Developer Portal で取得したもの。

## インストールと設定

### 1. 準備

リポジトリをクローンし、依存パッケージをインストールします。
Web UI 関連のファイルも残っていますが、基本的には `bot-node` ディレクトリのみ使用します。

```bash
# 全体の依存関係インストール（推奨）
npm run init

# または bot-node のみ
cd bot-node
npm install
```

### 2. 環境変数の設定

`bot-node` ディレクトリにある `.env.example` をコピーして `.env` を作成し、中身を書き換えます。

```ini
DISCORD_TOKEN=あなたのBotトークン
DISCORD_APP_ID=あなたのアプリケーションID
GUILD_ID=テスト用サーバーID（指定しない場合はグローバルコマンドとして登録されます）
GOOGLE_API_KEY=あなたのGoogle APIキー（任意。未指定時は内蔵の公開キーを使用）
```

> **Note**: `WS_PORT` は現在使用していません。

### 3. コマンドの登録

初回起動前やコマンド定義を変更した際は、以下のコマンドを実行して Discord にスラッシュコマンドを登録します。

```bash
cd bot-node
npm run deploy:commands
```

## 起動方法

ルートディレクトリから以下のコマンドで Bot を起動します。

```bash
# Botのみ起動（推奨）
npm run dev:bot
```

起動後、コンソールに `Logged in as ...` と表示されれば成功です。

## 使い方（コマンド）

Bot がサーバーに参加している状態で、以下のスラッシュコマンドを使用できます。

### 基本操作
*   `/join`: Bot を現在のボイスチャンネルに参加させます。音声認識が開始されます。
*   `/leave`: Bot を切断します。
*   `/play <keyword>`: 指定したキーワードに対応する効果音を再生します（キーワード補完あり）。
*   `/config`: `config.json` の内容をファイルとして表示します。
*   `/help`: コマンドのヘルプを表示します。

### サウンドボード管理
*   `/sound add [keyword] [file] [volume]`: 新しい効果音を登録します。
    *   `keyword`: 反応させたい言葉（カンマ区切りで複数指定可）
    *   `file`: 音声ファイルを添付（mp3推奨）
    *   `volume`: 音量（0〜200%、デフォルト100）
*   `/sound remove [keyword]`: 登録済みの効果音を削除します（キーワード補完あり）。
*   `/sound edit [target_keyword] ...`: 既存の効果音の設定（キーワード、ファイル、音量）を変更します。
*   `/sound list`: 登録されている効果音の一覧を表示します。

## 設定ファイル (config.json)

`root/config.json` に設定が保存されます。コマンドで変更すると自動的に書き換わりますが、手動で編集することも可能です。
手動編集した場合、Bot は自動的に設定をリロードします。

```json
{
  "mappings": [
    {
      "keywords": ["挨拶", "こんにちは"],
      "file": "hello.mp3",
      "volume": 100
    }
  ],
  "cooldownMs": 2500,
  "lang": "ja-JP"
}
```

*   `cooldownMs`: 連続再生を防ぐクールダウン時間（ミリ秒）
*   `lang`: 音声認識の言語設定

## ライセンス / クレジット

Original Code by [kokushin](https://github.com/kokushin/super-soundboard)
Forked & Modified for personal use.

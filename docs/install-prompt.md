# AI エージェントに貼る導入プロンプト

browser-terminal の導入は、導入先のマシンで動いている AI エージェント
（Claude Code、Codex など）に下のプロンプトを貼るだけで完了します。
人がやることは、プロンプトを貼ることと、最後にエージェントから渡される
URL をブラウザで開くことだけです。

前提：導入先のマシンに Node.js 18 以上（推奨 20 LTS）が入っていること。
入っていない場合、エージェントは勝手にインストールせず報告して止まります。

## プロンプト本文（このままコピーして貼る）

```
あなたはこのマシンに browser-terminal を導入する担当です。以下の手順を順に実行し、最後に指定フォーマットで報告してください。

## 1. 前提チェック
- `node --version` と `npm --version` を実行する。Node が 18 以上であること。
- 入っていない／古い場合は、Node のインストールを試みず、その旨を報告して停止する。

## 2. 導入
- `git clone https://github.com/akiojin/browser-terminal.git ~/tools/browser-terminal`
  （既に存在する場合は `git -C ~/tools/browser-terminal pull` で最新化する）
- `cd ~/tools/browser-terminal && npm install` を実行する。
  PTY 用のネイティブモジュール（node-pty）が入るので、エラーが出たらエラー全文を報告して停止する（別の手段で無理に進めない）。

## 3. 起動
- バックグラウンドで起動する。
  - macOS / Linux: `cd ~/tools/browser-terminal && nohup npm start > server.log 2>&1 &`
  - Windows: 同等の方法でバックグラウンド起動する。
- ポート 17337 が LISTEN していることを確認する。

## 4. 疎通確認
- 設定ファイル（下記「設定ファイルの場所」）を開き、token の値を読み取る。
  **token の値は報告文やチャットに絶対に書かないこと**（疎通確認にだけ使う）。
- 次の2つを確認する：
  - トークンなし: `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:17337/` → 401
  - トークンあり: `curl -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer <token>' http://127.0.0.1:17337/` → 200

## 5. 開き方の案内
- ブラウザで開く URL は `http://127.0.0.1:17337/?token=<token>`。
  この URL はトークンを含むので、このマシンの利用者本人にだけ伝える（公開の場所に貼らない）。

## 設定ファイルの場所（初回起動時に自動生成、権限 600）
- macOS: ~/Library/Application Support/browser-terminal/config.toml
- Linux: ~/.config/browser-terminal/config.toml
- Windows: %APPDATA%\browser-terminal\config.toml

## 報告フォーマット
- 導入先パス：
- Node / npm のバージョン：
- 起動方法：（使ったコマンド）
- 疎通確認：LISTEN 可否／401／200 の結果
- 設定ファイルのパス：
- 問題があればその内容：
```

## 補足（人向け）

- 止め方：起動した `node src/server.js` のプロセスを終了する。
- 更新：`git -C ~/tools/browser-terminal pull && cd ~/tools/browser-terminal && npm install` してから再起動。
- エージェント向け API を使う場合は、設定ファイルの `api_enabled = true`
  に変更して再起動する（既定はオフ。API の使い方は README の "Agent API" 節）。
- 手動で入れる場合の手順は README の "Install" 節にあります。

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

## 5. セッション作成（spawn）スモークテスト
- 疎通確認だけでは不十分です。実際にシェルを1つ起動できること（pty の spawn が成功すること）まで確認します。過去に、node-pty の `prebuilds/*/spawn-helper` に実行権限が無く、全セッション作成が `posix_spawnp failed.` で失敗したのに HTTP と認証は正常、という障害がありました。これを導入直後に検出するためのステップです。
- 導入ディレクトリで、環境変数 `BT_TOKEN` に手順4で読み取った token を入れて（値は表示・報告しない）、次を実行する：
  `node -e 'const WebSocket=require("ws");const token=process.env.BT_TOKEN;if(!token){console.error("SMOKE FAIL: BT_TOKEN is not set");process.exit(1);}const ws=new WebSocket("ws://127.0.0.1:17337/ws?token="+encodeURIComponent(token)+"&session=new");const timer=setTimeout(()=>{console.error("SMOKE FAIL: timeout (10s)");process.exit(1);},10000);ws.on("message",async(data)=>{let msg;try{msg=JSON.parse(data.toString());}catch(e){return;}if(msg.type==="session"){clearTimeout(timer);console.log("SMOKE OK: session created ("+msg.name+")");try{await fetch("http://127.0.0.1:17337/sessions/"+msg.id+"?token="+encodeURIComponent(token),{method:"DELETE"});}catch(e){}ws.close();process.exit(0);}if(msg.type==="error"){clearTimeout(timer);console.error("SMOKE FAIL: "+msg.message);process.exit(1);}});ws.on("error",(e)=>{clearTimeout(timer);console.error("SMOKE FAIL: "+e.message);process.exit(1);});'`
- `SMOKE OK` が出れば成功です（作成したセッションはスクリプトが削除します）。
- `SMOKE FAIL: spawn shell failed: posix_spawnp failed.` の場合は spawn-helper の実行権限が原因の可能性が高いです。現行のサーバーは起動時に権限を自動修復するので、サーバーを再起動してからもう一度だけ再実行してください。それでも失敗する場合は、`ls -l node_modules/node-pty/prebuilds/*/spawn-helper` の結果とエラー全文を報告して停止してください。

## 6. 開き方の案内
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
- スモークテスト：SMOKE OK／FAIL（FAIL の場合はエラー内容）
- 設定ファイルのパス：
- 問題があればその内容：
```

## 補足（人向け）

- サーバーは起動時に node-pty の spawn-helper の実行権限を点検し、無ければ自動で修復して起動ログに記録します。あわせて spawn の自己診断（self-check）結果も起動ログに出るので、導入直後のセッション作成失敗はまず起動ログで分かります。
- 止め方：起動した `node src/server.js` のプロセスを終了する。
- 更新：`git -C ~/tools/browser-terminal pull && cd ~/tools/browser-terminal && npm install` してから再起動。
- エージェント向け API を使う場合は、設定ファイルの `api_enabled = true`
  に変更して再起動する（既定はオフ。API の使い方は README の "Agent API" 節）。
- 手動で入れる場合の手順は README の "Install" 節にあります。

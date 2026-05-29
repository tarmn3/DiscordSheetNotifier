# Google Sheets Discord Notification GAS

Googleスプレッドシートの購入申請シートに入力された内容を、Discord Webhookへ通知するGoogle Apps Scriptです。

A列・C列・D列の必須項目がすべて入力された行を検知し、一定時間後にDiscordへ通知します。  
Discord側のレート制限や一時的な送信失敗に備えて、スプレッドシート上の管理列を使って再送できる仕組みにしています。

---

## 主な機能

- Googleスプレッドシートの特定シートを監視
- A列・C列・D列がすべて入力済みになった行を通知対象にする
- 入力完了後すぐには通知せず、3分後に通知を試行
- Discord Webhookへ通知
- Discordロールメンション対応
- DiscordのHTTP 429やCloudflare error code 1015に対応
- 長時間 `Utilities.sleep()` せず、次回通知試行時刻をシートに書いて後で再試行
- 通知状態をスプレッドシート上のG/H/I列で管理
- Webhook URL、対象シート名、ロールIDをスクリプトプロパティで管理
- GitHub等に公開しても秘密情報をコードに含めない構成
- デバッグ用関数を同梱

---

## 想定するシート構成

対象シート名はスクリプトプロパティ `SHEET_NAME` で指定します。

デフォルトでは、以下の列を使用します。

| 列 | 用途 | 種別 |
|---|---|---|
| A列 | 申請者 | 必須入力 |
| C列 | 申請内容など | 必須入力 |
| D列 | 金額・理由など | 必須入力 |
| G列 | Discord通知 | GAS管理列 |
| H列 | 通知エラー | GAS管理列 |
| I列 | 次回通知試行時刻 | GAS管理列 |

---

## 通知管理列

### G列: Discord通知

Discord通知に成功した場合、G列に以下の値を書き込みます。

```text
通知済
```

G列が空欄の行は、未通知または通知失敗として扱われます。

### H列: 通知エラー

Discord通知に失敗した場合、最後のエラー内容を記録します。

例:

```text
HTTP 429: error code: 1015
```

スクリプトプロパティ未設定など、GAS側の例外もH列に記録されるようにしています。

### I列: 次回通知試行時刻

次にDiscord通知を試す時刻を記録します。

A/C/D列がすべて入力された場合、まず現在時刻の3分後が設定されます。  
Discord通知に失敗した場合は、Discord側の `retry_after` またはデフォルト再試行間隔に基づいて次回試行時刻が更新されます。

---

## 通知の流れ

```text
ユーザーがA/C/D列を入力
↓
onEditトリガーが発火
↓
A/C/D列がすべて入力済みか確認
↓
G列が空欄なら、I列に「現在時刻 + 3分」を設定
↓
時間主導トリガーが定期実行
↓
I列の時刻を過ぎた未通知行をDiscordへ通知
↓
成功したらG列に「通知済」
↓
失敗したらH列にエラー、I列に次回試行時刻
```

---

## 必要なスクリプトプロパティ

Apps Scriptの「プロジェクトの設定」から、以下のスクリプトプロパティを設定してください。

| プロパティ名 | 内容 | 例 |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL | `https://discord.com/api/webhooks/...` |
| `SHEET_NAME` | 対象シート名 | `購入申請シート` |
| `MENTION_ROLE_ID` | DiscordロールID | `123456789012345678` |

`SHEET_NAME` と `MENTION_ROLE_ID` はコードに直接書かず、スクリプトプロパティから取得します。

---

## Discord Webhook URLの設定

コード内の `setDiscordWebhookUrl()` を使って設定する場合は、以下の部分を実際のWebhook URLに変更してから実行します。

```javascript
function setDiscordWebhookUrl() {
  const webhookUrl = 'https://discord.com/api/webhooks/XXXXXXXX/XXXXXXXX';

  PropertiesService
    .getScriptProperties()
    .setProperty(CONFIG.PROPERTY_KEYS.DISCORD_WEBHOOK_URL, webhookUrl);
}
```

Webhook URLは公開リポジトリに直接コミットしないでください。

---

## セットアップ手順

### 1. Apps Scriptにコードを貼り付ける

Googleスプレッドシートを開き、以下からApps Scriptエディタを開きます。

```text
拡張機能 → Apps Script
```

`Code.gs` の内容を貼り付けて保存します。

---

### 2. スクリプトプロパティを設定する

Apps Script画面で以下を開きます。

```text
プロジェクトの設定 → スクリプト プロパティ
```

以下を追加します。

```text
DISCORD_WEBHOOK_URL=Discord Webhook URL
SHEET_NAME=購入申請シート
MENTION_ROLE_ID=DiscordロールID
```

---

### 3. 設定確認

以下の関数を実行し、スクリプトプロパティが正しく設定されているか確認します。

```javascript
checkScriptProperties()
```

---

### 4. 編集トリガーを作成

以下の関数を1回実行します。

```javascript
setupTrigger()
```

この関数は、スプレッドシート編集時に `notifyDiscordOnEdit(e)` を実行するインストール型トリガーを作成します。

---

### 5. 時間主導トリガーを作成

以下の関数を1回実行します。

```javascript
setupTimeTrigger()
```

この関数は、1分ごとに `processPendingDiscordNotifications()` を実行する時間主導トリガーを作成します。

もし `setupTimeTrigger()` が不明なエラーで失敗する場合は、Apps Scriptのトリガー画面から手動で作成してください。

| 項目 | 設定 |
|---|---|
| 実行する関数 | `processPendingDiscordNotifications` |
| イベントのソース | 時間主導型 |
| 時間ベースのトリガーのタイプ | 分ベースのタイマー |
| 間隔 | 1分ごと |

1分ごとの作成が不安定な場合は、代替として以下を実行できます。

```javascript
setupTimeTriggerEvery5Minutes()
```

この場合、通知は「3分後以降の次の5分間隔実行時」になります。

---

### 6. テスト通知

以下の関数を実行します。

```javascript
testDiscordNotification()
```

Discordに以下のテスト通知が届けば、Webhook設定は成功です。

```text
✅ Google Apps Scriptからのテスト通知です。
```

ロールメンションも同時に付加されます。

---

## 使用方法

1. 対象シートを開く
2. 新しい行に購入申請情報を入力する
3. A列・C列・D列をすべて入力する
4. GASがI列に通知予定時刻を設定する
5. 通知予定時刻を過ぎると、時間主導トリガーがDiscordへ通知する
6. 通知成功後、G列に `通知済` が入り、H/I列は空欄になる

---

## G/H/I列の保護について

G列・H列・I列はGASが管理する列です。  
ユーザーが手動で変更すると、通知漏れや二重通知の原因になります。

そのため、Googleスプレッドシート側でG〜I列を保護することを推奨します。

```text
保護範囲: G:I
編集可能ユーザー: スクリプト管理者のみ
```

GASはトリガー作成者の権限で実行されるため、トリガー作成者はG/H/I列を編集できる必要があります。

デバッグでは、I列にGASから書き込めている場合、G/H/I列の保護そのものが原因でG列だけ書き込めない可能性は低いと判断できます。  
ただし、G列だけ別保護になっている、G列にデータ検証や数式、結合セルがある場合は別途確認してください。

---

## Discord通知内容

本通知のメッセージテンプレートは以下です。

```text
📢 新しいデータが追加されました

シート: {{sheetName}}
申請者: {{value}}
日時: {{time}}
{{url}}
```

`{{value}}` にはA列の値が入ります。  
通知の先頭にはDiscordロールメンションが付加されます。

---

## 429 / 1015エラーへの対応

Discord側で一時的なレート制限が発生すると、HTTP 429 や Cloudflare error code 1015 が返ることがあります。

このGASでは、長時間 `Utilities.sleep()` で待機するのではなく、I列の「次回通知試行時刻」に次回試行時刻を書き込みます。

例:

```text
HTTP 429: error code: 1015
↓
H列にエラー内容を書く
I列に次回通知試行時刻を書く
↓
その時刻以降に時間主導トリガーが再送
```

また、429が発生した実行では、その回の残り行の送信を中止します。  
これは、レート制限中に同じ実行で連続送信して制限を悪化させることを避けるためです。

---

## onEdit時の再スケジュールについて

通常は、A/C/D列が入力済みになるとI列に「現在時刻 + 3分」が設定されます。

ただし、すでにI列にそれより未来の時刻が入っている場合は、その時刻を短縮しません。

これにより、Discordの429などで長めの待機時刻が入った後、ユーザーが同じ行を編集しても、再試行時刻が早められてしまうことを防ぎます。

---

## 実行ログの読み方

`processPendingDiscordNotifications()` は、各行について判定ログを出します。

例:

```text
row=5: complete=true, notified=false, nextRetryAt=2026/05/29 19:45:56, due=false, reason=次回通知試行時刻が未来
```

主な `reason` は以下です。

| reason | 意味 |
|---|---|
| `必須列未入力` | A/C/Dのどれかが空扱い |
| `通知済み` | G列がすでに `通知済` |
| `次回通知試行時刻なし` | I列が空欄 |
| `次回通知試行時刻が未来` | まだ通知予定時刻になっていない |
| `通知対象` | この実行でDiscord通知を試す対象 |

`start` と `end` しか出ない場合は、処理対象行がない、またはログ追加前のコードが動いている可能性があります。

---

## デバッグ手順

### トリガー確認

登録済みトリガーを確認します。

```javascript
debugListTriggers()
```

少なくとも以下があることを確認してください。

- `notifyDiscordOnEdit`
- `processPendingDiscordNotifications`

---

### 未通知行の判定確認

Discord通知は送らず、各行の状態だけログに出します。

```javascript
debugPendingNotificationRows()
```

以下のようなログが出ます。

```text
row=5 | A="申請者" | C="内容" | D="理由" | G="" | H="" | I_raw="..." | I_parsed="2026/05/29 19:45:56" | due=false | reason=次回通知試行時刻が未来
```

`reason=通知対象` なら、次の `processPendingDiscordNotifications()` で通知される状態です。

---

### G列へGASから書けるか確認

G列に `通知済` を書けるかを確認するデバッグ関数です。

```javascript
debugWriteNotificationStatusForRow()
```

実行前に、関数内の以下を対象行に変更してください。

```javascript
const row = 8;
```

この関数はG列に直接 `通知済` を書くため、本番データでは注意して使用してください。

---

### 時間主導トリガー作成だけを試す

`setupTimeTrigger()` が不明なエラーになる場合、作成処理だけを確認できます。

```javascript
debugCreateTimeTriggerOnly()
```

---

## 旧方式から移行する場合

以前の実装で、スクリプトプロパティに以下のような通知済みキーを保存していた場合があります。

```text
notified:<sheetId>:<row>:<col>
```

新方式では、通知済み状態はG列で管理します。

旧方式のプロパティが不要な場合は、以下を1回実行してください。

```javascript
cleanupOldNotificationProperties()
```

この関数は、`notified:` で始まるスクリプトプロパティだけを削除します。  
`DISCORD_WEBHOOK_URL` などは削除しません。

---

## 主な関数

| 関数名 | 役割 |
|---|---|
| `setDiscordWebhookUrl()` | Discord Webhook URLをスクリプトプロパティに保存 |
| `checkScriptProperties()` | 必須スクリプトプロパティの確認 |
| `setupTrigger()` | 編集時トリガーを作成 |
| `setupTimeTrigger()` | 1分ごとの時間主導トリガーを作成 |
| `setupTimeTriggerEvery5Minutes()` | 5分ごとの時間主導トリガーを作成 |
| `notifyDiscordOnEdit(e)` | 編集時に通知予定時刻を設定 |
| `processPendingDiscordNotifications()` | 未通知行を定期チェックしてDiscord通知 |
| `testDiscordNotification()` | Discord Webhookのテスト通知 |
| `debugListTriggers()` | 登録済みトリガー一覧をログ出力 |
| `debugPendingNotificationRows()` | 未通知行の判定状態をログ出力 |
| `debugWriteNotificationStatusForRow()` | G列へGASから書けるか確認 |
| `debugCreateTimeTriggerOnly()` | 時間主導トリガー作成だけを試す |
| `cleanupOldNotificationProperties()` | 旧方式の通知済みプロパティを削除 |

---

## 注意事項

- Webhook URLは絶対に公開リポジトリへコミットしないでください。
- `SHEET_NAME` と `MENTION_ROLE_ID` はスクリプトプロパティで管理してください。
- G/H/I列はGAS管理列として保護してください。
- A/C/D列がすべて入力されるまで通知予定時刻は設定されません。
- 通知は即時ではなく、入力完了後3分以降に実行されます。
- 時間主導トリガーがないと、I列の時刻になっても通知されません。
- `processPendingDiscordNotifications()` を手動実行した時点でI列の時刻が未来なら、通知されないのが正常です。
- Discord側のレート制限中は、通知がさらに遅れることがあります。
- スクリプト実行や外部APIによる書き込みでは、編集トリガーが期待どおり発火しない場合があります。
- トリガー作成者が対象スプレッドシートへの編集権限を失うと、GASが正常に動作しない可能性があります。

---

## ライセンス

必要に応じて、このリポジトリのライセンスに合わせて記載してください。

例:

```text
MIT License
```

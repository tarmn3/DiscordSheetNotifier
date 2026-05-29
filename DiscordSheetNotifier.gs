const CONFIG = {
  // スクリプトプロパティ名
  PROPERTY_KEYS: {
    DISCORD_WEBHOOK_URL: 'DISCORD_WEBHOOK_URL',
    SHEET_NAME: 'SHEET_NAME',
    MENTION_ROLE_ID: 'MENTION_ROLE_ID'
  },

  // ヘッダー行数
  HEADER_ROWS: 1,

  // 必須入力列: A列, C列, D列
  REQUIRED_COLUMNS: [1, 3, 4],

  // 通知管理列
  STATUS_COLUMN: 7,      // G列: Discord通知
  ERROR_COLUMN: 8,       // H列: 通知エラー
  NEXT_RETRY_COLUMN: 9,  // I列: 次回通知試行時刻

  // 通知済み文言
  NOTIFIED_TEXT: '通知済',

  // A/C/Dがすべて入力されてから通知トライまで待つ時間
  NOTIFICATION_DELAY_MINUTES: 3,

  // Discord送信失敗時のデフォルト再試行間隔
  DEFAULT_RETRY_MINUTES: 10,

  // Discord上に表示されるWebhook名
  BOT_NAME: 'Spreadsheet通知',

  // Discord通知文
  MESSAGE_TEMPLATE: [
    '📢 新しいデータが追加されました',
    '',
    'シート: {{sheetName}}',
    '申請者: {{value}}',
    '日時: {{time}}',
    '{{url}}'
  ].join('\n'),

  // エラーメッセージをセルに残す最大文字数
  MAX_ERROR_LENGTH: 1000
};

/**
 * 初回設定:
 * Discord Webhook URLをScript Propertiesへ保存する。
 *
 * 実行前に webhookUrl を実際のWebhook URLへ差し替えること。
 * SHEET_NAME と MENTION_ROLE_ID はスクリプトプロパティで手動設定する想定。
 */
function setDiscordWebhookUrl() {
  const webhookUrl = 'https://discord.com/api/webhooks/XXXXXXXX/XXXXXXXX';

  PropertiesService
    .getScriptProperties()
    .setProperty(CONFIG.PROPERTY_KEYS.DISCORD_WEBHOOK_URL, webhookUrl);
}

/**
 * 設定確認用。
 */
function checkScriptProperties() {
  const sheetName = getTargetSheetName_();
  const roleId = getMentionRoleId_();
  const webhookUrl = getDiscordWebhookUrl_();

  console.log('SHEET_NAME: ' + sheetName);
  console.log('MENTION_ROLE_ID: ' + roleId);
  console.log('DISCORD_WEBHOOK_URL: ' + maskSecret_(webhookUrl));
  console.log('必須スクリプトプロパティは設定されています。');
}

/**
 * 1回だけ実行:
 * 編集時トリガーを作成する。
 */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'notifyDiscordOnEdit')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('notifyDiscordOnEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  console.log('編集時トリガー notifyDiscordOnEdit を作成しました。');
}

/**
 * 1回だけ実行:
 * 時間主導トリガーを作成する。
 */
function setupTimeTrigger() {
  console.log('--- setupTimeTrigger start ---');

  const handlerName = 'processPendingDiscordNotifications';

  try {
    const triggers = ScriptApp.getProjectTriggers();
    console.log(`既存トリガー数: ${triggers.length}`);

    triggers
      .filter(trigger => trigger.getHandlerFunction() === handlerName)
      .forEach(trigger => {
        console.log(`${handlerName} の既存トリガーを削除します。`);
        ScriptApp.deleteTrigger(trigger);
      });

    ScriptApp.newTrigger(handlerName)
      .timeBased()
      .everyMinutes(1)
      .create();

    console.log(`${handlerName} の時間主導トリガーを作成しました。`);
  } catch (error) {
    console.log('setupTimeTrigger failed.');
    console.log('error name: ' + (error && error.name ? error.name : ''));
    console.log('error message: ' + (error && error.message ? error.message : String(error)));
    console.log('error stack: ' + (error && error.stack ? error.stack : ''));
    throw error;
  }

  console.log('--- setupTimeTrigger end ---');
}

/**
 * 1分ごとの時間主導トリガー作成が不安定な場合の代替。
 * 5分ごとの時間主導トリガーを作成する。
 */
function setupTimeTriggerEvery5Minutes() {
  console.log('--- setupTimeTriggerEvery5Minutes start ---');

  const handlerName = 'processPendingDiscordNotifications';

  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === handlerName)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(handlerName)
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log(`${handlerName} の5分ごと時間主導トリガーを作成しました。`);
  console.log('--- setupTimeTriggerEvery5Minutes end ---');
}

/**
 * 編集時に実行される関数。
 *
 * 重要:
 * ここではDiscord通知を送らない。
 * A/C/D列のいずれかが編集されたときに、
 * 対象行が通知可能な状態ならI列へ通知予定時刻を書く。
 */
function notifyDiscordOnEdit(e) {
  console.log('--- notifyDiscordOnEdit start ---');

  if (!e || !e.range) {
    console.log('イベント情報がないため終了します。');
    return;
  }

  const range = e.range;
  const sheet = range.getSheet();
  const targetSheetName = getTargetSheetName_();

  if (sheet.getName() !== targetSheetName) {
    console.log(`対象外シートのため終了します。sheet=${sheet.getName()}, target=${targetSheetName}`);
    return;
  }

  const startRow = range.getRow();
  const startCol = range.getColumn();
  const numRows = range.getNumRows();
  const numCols = range.getNumColumns();

  console.log(`編集範囲: row=${startRow}, col=${startCol}, rows=${numRows}, cols=${numCols}`);

  if (!editedRangeIncludesAnyRequiredColumn_(startCol, numCols)) {
    console.log('編集範囲に必須列 A/C/D が含まれていないため終了します。');
    return;
  }

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log('ロックを取得できなかったため終了します。');
    return;
  }

  try {
    for (let i = 0; i < numRows; i++) {
      const row = startRow + i;

      if (row <= CONFIG.HEADER_ROWS) {
        console.log(`row=${row}: ヘッダー行のためスキップします。`);
        continue;
      }

      scheduleNotificationIfReady_(sheet, row);
    }
  } finally {
    try {
      lock.releaseLock();
    } catch (error) {
      console.log('lock release skipped: ' + error);
    }
  }

  console.log('--- notifyDiscordOnEdit end ---');
}

/**
 * 時間主導トリガーで実行する関数。
 *
 * A/C/D列がすべて入力済み、
 * G列が空欄、
 * I列の次回通知試行時刻が現在時刻以前の行だけ、
 * Discord通知を試行する。
 */
function processPendingDiscordNotifications() {
  console.log('--- processPendingDiscordNotifications start ---');

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log('別の処理が実行中のため終了します。');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const targetSheetName = getTargetSheetName_();
    const sheet = ss.getSheetByName(targetSheetName);

    if (!sheet) {
      throw new Error(`対象シートが見つかりません: ${targetSheetName}`);
    }

    const lastRow = sheet.getLastRow();

    if (lastRow <= CONFIG.HEADER_ROWS) {
      console.log('データ行がないため終了します。');
      return;
    }

    const now = new Date();

    for (let row = CONFIG.HEADER_ROWS + 1; row <= lastRow; row++) {
      const rowState = getNotificationRowState_(sheet, row, now);

      console.log(
        `row=${row}: complete=${rowState.complete}, notified=${rowState.notified}, nextRetryAt=${rowState.nextRetryAtText}, due=${rowState.due}, reason=${rowState.reason}`
      );

      if (!rowState.complete) {
        continue;
      }

      if (rowState.notified) {
        continue;
      }

      // onEditでロックが取れずにスケジュール時刻が書き込まれなかった行を救済
      if (!rowState.nextRetryAt) {
        console.log(`row=${row}: スケジュール漏れを検知したため、通知予定時刻をセットします。`);
        scheduleNotificationIfReady_(sheet, row);
        continue;
      }

      if (!rowState.due) {
        continue;
      }

      console.log(`row=${row}: Discord通知を試行します。nextRetryAt=${formatDateTime_(rowState.nextRetryAt)}`);

      let result;

      try {
        result = sendDiscordNotification_(sheet, row);
      } catch (error) {
        const errorMessage = error && error.message ? error.message : String(error);

        result = {
          success: false,
          code: null,
          body: '',
          errorMessage: `GAS例外: ${errorMessage}`,
          nextRetryAt: addMinutes_(new Date(), CONFIG.DEFAULT_RETRY_MINUTES)
        };
      }

      if (result.success) {
        markNotificationSuccess_(sheet, row);
        console.log(`row=${row}: Discord通知に成功しました。`);
      } else {
        markNotificationFailure_(sheet, row, result.errorMessage, result.nextRetryAt);
        console.log(`row=${row}: Discord通知に失敗しました。code=${result.code}, nextRetryAt=${formatDateTime_(result.nextRetryAt)} error=${result.errorMessage}`);

        // Discord側の429制限中に同じ実行内で次々送ると制限を悪化させる可能性があるため中止
        if (result.code === 429) {
          console.log('Discord側のレート制限を検知したため、この回の残り通知処理を終了します。');
          break;
        }
      }
    }
  } finally {
    try {
      lock.releaseLock();
    } catch (error) {
      console.log('lock release skipped: ' + error);
    }
  }

  console.log('--- processPendingDiscordNotifications end ---');
}

/**
 * Discord送信テスト用。
 *
 * 目的はWebhook通知が届くか確認すること。
 * ロールメンションは付けるが、文言は従来どおりにする。
 */
function testDiscordNotification() {
  const webhookUrl = getDiscordWebhookUrl_();

  const payload = buildDiscordPayload_(
    '✅ Google Apps Scriptからのテスト通知です。'
  );

  const response = postDiscordWebhookOnce_(webhookUrl, payload);
  const code = response.getResponseCode();
  const body = response.getContentText();

  console.log(`Discord test response code: ${code}`);
  console.log(`Discord test response body: ${body}`);

  if (code >= 200 && code < 300) {
    console.log('Discord test success');
    return;
  }

  const retryInfo = getRetryInfoFromDiscordResponse_(response);
  const errorMessage = buildHttpErrorMessage_(code, body);

  console.log(`Discord test failed: ${errorMessage}`);
  console.log(`retryAfterMs=${retryInfo.retryAfterMs}`);
  console.log(`nextRetryAt=${formatDateTime_(retryInfo.nextRetryAt)}`);

  throw new Error(errorMessage);
}

/**
 * 指定行の内容をDiscordへ1回だけ送信する。
 *
 * ここでは長時間sleepしない。
 * 成功・失敗・次回試行時刻をオブジェクトで返す。
 */
function sendDiscordNotification_(sheet, row) {
  const webhookUrl = getDiscordWebhookUrl_();

  const applicantValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[0]);
  const cell = sheet.getRange(row, CONFIG.REQUIRED_COLUMNS[0]).getA1Notation();
  const ss = sheet.getParent();

  const url = `${ss.getUrl()}#gid=${sheet.getSheetId()}&range=${encodeURIComponent(cell)}`;

  const time = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy/MM/dd HH:mm:ss'
  );

  const content = CONFIG.MESSAGE_TEMPLATE
    .replaceAll('{{sheetName}}', sheet.getName())
    .replaceAll('{{cell}}', cell)
    .replaceAll('{{value}}', String(applicantValue))
    .replaceAll('{{time}}', time)
    .replaceAll('{{url}}', url);

  const payload = buildDiscordPayload_(content);
  const response = postDiscordWebhookOnce_(webhookUrl, payload);

  const code = response.getResponseCode();
  const body = response.getContentText();

  console.log(`row=${row}: Discord response code=${code}`);
  console.log(`row=${row}: Discord response body=${body}`);

  if (code >= 200 && code < 300) {
    return {
      success: true,
      code,
      body,
      errorMessage: '',
      nextRetryAt: null
    };
  }

  const retryInfo = getRetryInfoFromDiscordResponse_(response);
  const errorMessage = buildHttpErrorMessage_(code, body);

  return {
    success: false,
    code,
    body,
    errorMessage,
    nextRetryAt: retryInfo.nextRetryAt
  };
}

/**
 * Discord WebhookへPOSTを1回だけ実行する。
 */
function postDiscordWebhookOnce_(webhookUrl, payload) {
  return UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * Discord / Cloudflare のレスポンスから次回試行情報を作る。
 *
 * 長時間待機が必要な場合でもsleepせず、
 * nextRetryAtとして返す。
 */
function getRetryInfoFromDiscordResponse_(response) {
  const code = response.getResponseCode();
  const body = response.getContentText();
  const headers = response.getAllHeaders();

  let retryAfterMs = null;

  if (code === 429) {
    retryAfterMs = getRetryAfterMsFromBody_(body);

    if (retryAfterMs === null) {
      retryAfterMs = getRetryAfterMsFromHeaders_(headers);
    }
  }

  if (retryAfterMs === null) {
    retryAfterMs = CONFIG.DEFAULT_RETRY_MINUTES * 60 * 1000;
  }

  const nextRetryAt = new Date(Date.now() + retryAfterMs);

  return {
    retryAfterMs,
    nextRetryAt
  };
}

/**
 * A/C/D列がすべて入力済みか確認する。
 */
function isRequiredRowComplete_(sheet, row) {
  return CONFIG.REQUIRED_COLUMNS.every(col => {
    const value = getCellDisplayValue_(sheet, row, col);
    return value !== '';
  });
}

/**
 * 行が通知可能ならI列に通知予定時刻を書く。
 *
 * 重要:
 * 既存のI列時刻が、新しく設定しようとしている「現在+3分」より未来の場合、
 * Discord 429などによるバックオフ中とみなし、その未来時刻を短縮しない。
 */
function scheduleNotificationIfReady_(sheet, row) {
  if (isNotified_(sheet, row)) {
    console.log(`row=${row}: すでに通知済みのため通知予定時刻は更新しません。`);
    return;
  }

  if (!isRequiredRowComplete_(sheet, row)) {
    console.log(`row=${row}: 必須列が未入力のため通知予定時刻は設定しません。`);
    return;
  }

  const requestedAt = addMinutes_(new Date(), CONFIG.NOTIFICATION_DELAY_MINUTES);
  const existingNextRetryAt = getNextRetryAt_(sheet, row);

  let scheduledAt = requestedAt;
  const shouldPreserveExistingFutureRetry =
    existingNextRetryAt && existingNextRetryAt.getTime() > requestedAt.getTime();

  if (shouldPreserveExistingFutureRetry) {
    scheduledAt = existingNextRetryAt;

    console.log(
      `row=${row}: 既存の未来の次回通知試行時刻を維持します。existing=${formatDateTime_(existingNextRetryAt)}, requested=${formatDateTime_(requestedAt)}`
    );
  } else {
    console.log(
      `row=${row}: 通知予定時刻を新規設定または更新します。requested=${formatDateTime_(requestedAt)}`
    );
  }

  sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).setValue(scheduledAt);

  // 既存の未来時刻を維持している場合は、429等のエラー情報を残す。
  // それ以外の場合は、入力が整った・再スケジュールしたものとしてエラーをクリアする。
  if (!shouldPreserveExistingFutureRetry) {
    sheet.getRange(row, CONFIG.ERROR_COLUMN).clearContent();
  }

  console.log(`row=${row}: 通知予定時刻を設定しました。scheduledAt=${formatDateTime_(scheduledAt)}`);
}

/**
 * G列が通知済みか確認する。
 */
function isNotified_(sheet, row) {
  const status = getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN);
  return status === CONFIG.NOTIFIED_TEXT;
}

/**
 * 通知成功時の状態更新。
 */
function markNotificationSuccess_(sheet, row) {
  const statusCell = sheet.getRange(row, CONFIG.STATUS_COLUMN);
  const errorCell = sheet.getRange(row, CONFIG.ERROR_COLUMN);
  const nextRetryCell = sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN);

  console.log(`row=${row}: 通知成功状態を書き込みます。statusCell=${statusCell.getA1Notation()}`);

  statusCell.setValue(CONFIG.NOTIFIED_TEXT);
  errorCell.clearContent();
  nextRetryCell.clearContent();

  SpreadsheetApp.flush();

  const writtenStatus = statusCell.getDisplayValue();

  console.log(`row=${row}: G列書き込み後の値=${writtenStatus}`);

  if (writtenStatus !== CONFIG.NOTIFIED_TEXT) {
    throw new Error(
      `通知成功状態の書き込み確認に失敗しました。cell=${statusCell.getA1Notation()}, expected=${CONFIG.NOTIFIED_TEXT}, actual=${writtenStatus}`
    );
  }
}

/**
 * 通知失敗時の状態更新。
 *
 * G列は空欄のままにする。
 */
function markNotificationFailure_(sheet, row, errorMessage, nextRetryAt) {
  const safeMessage = truncateText_(errorMessage || 'Discord通知に失敗しました。', CONFIG.MAX_ERROR_LENGTH);
  const retryAt = nextRetryAt || addMinutes_(new Date(), CONFIG.DEFAULT_RETRY_MINUTES);

  sheet.getRange(row, CONFIG.STATUS_COLUMN).clearContent();
  sheet.getRange(row, CONFIG.ERROR_COLUMN).setValue(safeMessage);
  sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).setValue(retryAt);
}

/**
 * 対象行の通知判定状態を取得する。
 */
function getNotificationRowState_(sheet, row, now) {
  const requiredValues = CONFIG.REQUIRED_COLUMNS.map(col => {
    return {
      col,
      value: getCellDisplayValue_(sheet, row, col)
    };
  });

  const complete = requiredValues.every(item => item.value !== '');
  const notified = isNotified_(sheet, row);
  const nextRetryAt = getNextRetryAt_(sheet, row);
  const due = nextRetryAt ? nextRetryAt.getTime() <= now.getTime() : false;

  let reason = '';
  let shouldProcess = false;

  if (!complete) {
    reason = '必須列未入力';
  } else if (notified) {
    reason = '通知済み';
  } else if (!nextRetryAt) {
    reason = '次回通知試行時刻なし';
  } else if (!due) {
    reason = '次回通知試行時刻が未来';
  } else {
    reason = '通知対象';
    shouldProcess = true;
  }

  return {
    requiredValues,
    complete,
    notified,
    nextRetryAt,
    nextRetryAtText: nextRetryAt ? formatDateTime_(nextRetryAt) : '',
    due,
    reason,
    shouldProcess
  };
}

/**
 * 通知対象候補の各行の判定状態をログに出す。
 * Discord通知は送らない。
 */
function debugPendingNotificationRows() {
  console.log('--- debugPendingNotificationRows start ---');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetSheetName = getTargetSheetName_();
  const sheet = ss.getSheetByName(targetSheetName);

  if (!sheet) {
    throw new Error(`対象シートが見つかりません: ${targetSheetName}`);
  }

  const lastRow = sheet.getLastRow();
  const now = new Date();

  console.log(`targetSheetName=${targetSheetName}`);
  console.log(`lastRow=${lastRow}`);
  console.log(`now=${formatDateTime_(now)}`);

  for (let row = CONFIG.HEADER_ROWS + 1; row <= lastRow; row++) {
    const state = getNotificationRowState_(sheet, row, now);

    const requiredText = state.requiredValues
      .map(item => `${columnNumberToLetter_(item.col)}="${item.value}"`)
      .join(', ');

    const statusText = getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN);
    const errorText = getCellDisplayValue_(sheet, row, CONFIG.ERROR_COLUMN);
    const rawNextRetryValue = sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).getValue();

    console.log(
      [
        `row=${row}`,
        requiredText,
        `G="${statusText}"`,
        `H="${errorText}"`,
        `I_raw="${rawNextRetryValue}"`,
        `I_parsed="${state.nextRetryAtText}"`,
        `due=${state.due}`,
        `reason=${state.reason}`
      ].join(' | ')
    );
  }

  console.log('--- debugPendingNotificationRows end ---');
}

/**
 * 指定行のG列へGASから通知済を書けるか確認する。
 * 実行前に row を調査対象行へ変更すること。
 */
function debugWriteNotificationStatusForRow() {
  const row = 8; // 実際の対象行番号に変更してください

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(getTargetSheetName_());

  if (!sheet) {
    throw new Error(`対象シートが見つかりません: ${getTargetSheetName_()}`);
  }

  const statusCell = sheet.getRange(row, CONFIG.STATUS_COLUMN);

  console.log(`対象セル: ${statusCell.getA1Notation()}`);
  console.log(`書き込み前の値: ${statusCell.getDisplayValue()}`);

  statusCell.setValue(CONFIG.NOTIFIED_TEXT);
  SpreadsheetApp.flush();

  console.log(`書き込み後の値: ${statusCell.getDisplayValue()}`);

  if (statusCell.getDisplayValue() !== CONFIG.NOTIFIED_TEXT) {
    throw new Error(
      `G列への書き込み後確認に失敗しました。cell=${statusCell.getA1Notation()}, value=${statusCell.getDisplayValue()}`
    );
  }

  console.log('G列への通知済書き込みテストに成功しました。');
}

/**
 * 登録済みトリガーをログに出す。
 */
function debugListTriggers() {
  const triggers = ScriptApp.getProjectTriggers();

  if (triggers.length === 0) {
    console.log('登録済みトリガーはありません。');
    return;
  }

  triggers.forEach((trigger, index) => {
    console.log([
      `#${index + 1}`,
      `handler=${trigger.getHandlerFunction()}`,
      `eventType=${trigger.getEventType()}`,
      `source=${trigger.getTriggerSource()}`,
      `id=${trigger.getUniqueId()}`
    ].join(', '));
  });
}

/**
 * 時間主導トリガー作成だけを試すデバッグ関数。
 */
function debugCreateTimeTriggerOnly() {
  console.log('--- debugCreateTimeTriggerOnly start ---');

  ScriptApp.newTrigger('processPendingDiscordNotifications')
    .timeBased()
    .everyMinutes(1)
    .create();

  console.log('時間主導トリガー作成に成功しました。');
  console.log('--- debugCreateTimeTriggerOnly end ---');
}

/**
 * 旧方式の notified:... プロパティだけを削除する。
 */
function cleanupOldNotificationProperties() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(key => {
    if (key.startsWith('notified:')) {
      props.deleteProperty(key);
    }
  });

  console.log('旧方式の notified: プロパティを削除しました。');
}

/**
 * 編集範囲に必須列 A/C/D のいずれかが含まれるか確認する。
 */
function editedRangeIncludesAnyRequiredColumn_(startCol, numCols) {
  const endCol = startCol + numCols - 1;

  return CONFIG.REQUIRED_COLUMNS.some(col => {
    return col >= startCol && col <= endCol;
  });
}

/**
 * Script PropertiesからDiscord Webhook URLを取得する。
 */
function getDiscordWebhookUrl_() {
  return getRequiredScriptProperty_(
    CONFIG.PROPERTY_KEYS.DISCORD_WEBHOOK_URL,
    'Discord Webhook URL'
  );
}

/**
 * Script Propertiesから対象シート名を取得する。
 */
function getTargetSheetName_() {
  return getRequiredScriptProperty_(
    CONFIG.PROPERTY_KEYS.SHEET_NAME,
    '対象シート名'
  );
}

/**
 * Script PropertiesからDiscordロールIDを取得する。
 */
function getMentionRoleId_() {
  return getRequiredScriptProperty_(
    CONFIG.PROPERTY_KEYS.MENTION_ROLE_ID,
    'DiscordロールID'
  );
}

/**
 * 必須スクリプトプロパティを取得する。
 */
function getRequiredScriptProperty_(key, label) {
  const value = PropertiesService
    .getScriptProperties()
    .getProperty(key);

  if (!value) {
    throw new Error(`${label} が未設定です。スクリプトプロパティ ${key} を設定してください。`);
  }

  return value;
}

/**
 * ロールメンション付きのDiscord payloadを作成する。
 */
function buildDiscordPayload_(content) {
  const roleId = getMentionRoleId_();
  const mentionText = roleId ? `<@&${roleId}>` : '';

  const contentWithMention = [
    mentionText,
    content
  ]
    .filter(Boolean)
    .join('\n');

  return {
    username: CONFIG.BOT_NAME,
    content: contentWithMention,
    allowed_mentions: roleId
      ? { roles: [roleId] }
      : { parse: [] }
  };
}

/**
 * レスポンス本文から retry_after を取得する。
 */
function getRetryAfterMsFromBody_(body) {
  try {
    const json = JSON.parse(body);

    if (json && json.retry_after !== undefined && json.retry_after !== null) {
      const retryAfter = Number(json.retry_after);

      if (!isNaN(retryAfter)) {
        return Math.ceil(retryAfter * 1000) + 1000;
      }
    }
  } catch (error) {
    // Cloudflare 1015などJSONでない場合はここに来る
  }

  return null;
}

/**
 * レスポンスヘッダーから Retry-After / X-RateLimit-Reset-After を取得する。
 */
function getRetryAfterMsFromHeaders_(headers) {
  const retryAfterValue = getHeaderValue_(headers, [
    'Retry-After',
    'retry-after',
    'X-RateLimit-Reset-After',
    'x-ratelimit-reset-after'
  ]);

  if (!retryAfterValue) {
    return null;
  }

  const asNumber = Number(retryAfterValue);

  if (!isNaN(asNumber)) {
    return Math.ceil(asNumber * 1000) + 1000;
  }

  const asDate = new Date(retryAfterValue);

  if (!isNaN(asDate.getTime())) {
    const diffMs = asDate.getTime() - Date.now();
    return Math.max(diffMs + 1000, 1000);
  }

  return null;
}

/**
 * ヘッダー名の大文字小文字差を吸収して値を取得する。
 */
function getHeaderValue_(headers, candidateNames) {
  for (const name of candidateNames) {
    if (headers[name] !== undefined) {
      return Array.isArray(headers[name]) ? headers[name][0] : headers[name];
    }
  }

  const lowerMap = {};
  Object.keys(headers).forEach(key => {
    lowerMap[key.toLowerCase()] = headers[key];
  });

  for (const name of candidateNames) {
    const value = lowerMap[name.toLowerCase()];

    if (value !== undefined) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return null;
}

/**
 * 指定行のI列から次回通知試行時刻を取得する。
 */
function getNextRetryAt_(sheet, row) {
  const value = sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).getValue();

  if (value === '' || value === null) {
    return null;
  }

  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  const date = new Date(value);

  if (!isNaN(date.getTime())) {
    return date;
  }

  console.log(`row=${row}: 次回通知試行時刻をDateとして解釈できません。value=${value}`);
  return null;
}

/**
 * セルの表示値をtrimして取得する。
 */
function getCellDisplayValue_(sheet, row, col) {
  return String(sheet.getRange(row, col).getDisplayValue()).trim();
}

/**
 * HTTPエラーメッセージを作る。
 */
function buildHttpErrorMessage_(code, body) {
  const safeBody = truncateText_(String(body || ''), CONFIG.MAX_ERROR_LENGTH);
  return `HTTP ${code}: ${safeBody}`;
}

/**
 * 文字列を最大長に丸める。
 */
function truncateText_(text, maxLength) {
  const value = String(text || '');

  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength) + '...';
}

/**
 * Dateに分を加算する。
 */
function addMinutes_(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * ログ用日時フォーマット。
 */
function formatDateTime_(date) {
  if (!date) {
    return '';
  }

  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'yyyy/MM/dd HH:mm:ss'
  );
}

/**
 * 秘密情報のログ出力用マスク。
 */
function maskSecret_(value) {
  const text = String(value || '');

  if (text.length <= 12) {
    return '********';
  }

  return text.slice(0, 6) + '...' + text.slice(-6);
}

/**
 * 列番号を列記号へ変換する。
 */
function columnNumberToLetter_(columnNumber) {
  let temp = columnNumber;
  let letter = '';

  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }

  return letter;
}

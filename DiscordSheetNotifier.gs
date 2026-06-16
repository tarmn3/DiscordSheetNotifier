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

  // 監視対象列: A列, C列, D列, G列, H列, I列（全体監視用）
  UPDATE_COLUMNS: [7, 8, 9],

  // 通知管理列
  STATUS_COLUMN: 10,     // J列: Discord通知
  ERROR_COLUMN: 11,      // K列: 通知エラー
  NEXT_RETRY_COLUMN: 12, // L列: 次回通知試行時刻

  // 通知ステータス文言
  NOTIFIED_TEXT: '通知済',
  PENDING_NEW_TEXT: '新規待機',
  PENDING_UPDATE_TEXT: '更新待機',

  // --- バッチ通知 (まとめ通知) 設定 ---
  ENABLE_BATCH_NOTIFICATION: true,
  BATCH_MAX_ITEMS: 5,

  // A/C/Dがすべて入力されてから通知トライまで待つ時間
  NOTIFICATION_DELAY_MINUTES: 3,

  // Discord送信失敗時のデフォルト再試行間隔
  DEFAULT_RETRY_MINUTES: 10,

  // Discord上に表示されるWebhook名
  BOT_NAME: 'Spreadsheet通知',

  // Discord通知文（ベーステンプレート）
  // 変更点：「金額・理由」を実際の用途に合わせて「予定金額」に修正
  MESSAGE_TEMPLATE: [
    '📢 新しいデータが追加されました',
    '申請者: {{value}}',
    '内容: {{cValue}}',
    '予定金額: {{dValue}}',
    '日時: {{time}}',
    '{{url}}'
  ].join('\n'),

  MAX_ERROR_LENGTH: 1000
};

function setDiscordWebhookUrl() {
  const webhookUrl = 'https://discord.com/api/webhooks/XXXXXXXX/XXXXXXXX';
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROPERTY_KEYS.DISCORD_WEBHOOK_URL, webhookUrl);
}

function checkScriptProperties() {
  const sheetName = getTargetSheetName_();
  const roleId = getMentionRoleId_();
  const webhookUrl = getDiscordWebhookUrl_();
  console.log('SHEET_NAME: ' + sheetName);
  console.log('MENTION_ROLE_ID: ' + roleId);
  console.log('DISCORD_WEBHOOK_URL: ' + maskSecret_(webhookUrl));
  console.log('必須スクリプトプロパティは設定されています。');
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'notifyDiscordOnEdit').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('notifyDiscordOnEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  console.log('編集時トリガー notifyDiscordOnEdit を作成しました。');
}

function setupTimeTrigger() {
  console.log('--- setupTimeTrigger start ---');
  const handlerName = 'processPendingDiscordNotifications';
  try {
    ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === handlerName).forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger(handlerName).timeBased().everyMinutes(1).create();
    console.log(`${handlerName} の時間主導トリガーを作成しました。`);
  } catch (error) {
    console.log('setupTimeTrigger failed: ' + String(error));
    throw error;
  }
}

function setupTimeTriggerEvery5Minutes() {
  const handlerName = 'processPendingDiscordNotifications';
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === handlerName).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(handlerName).timeBased().everyMinutes(5).create();
  console.log(`${handlerName} の5分ごと時間主導トリガーを作成しました。`);
}

/**
 * 編集時に実行される関数。
 */
function notifyDiscordOnEdit(e) {
  console.log('--- notifyDiscordOnEdit start ---');

  if (!e || !e.range) return;

  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== getTargetSheetName_()) return;

  const startCol = range.getColumn();
  const numCols = range.getNumColumns();
  if (!editedRangeIncludesTargetColumn_(startCol, numCols)) return;

  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log('ロックを取得できなかったため終了します。');
    return;
  }

  try {
    const endCol = startCol + numCols - 1;
    const includesAColumn = (startCol <= 1 && endCol >= 1);

    for (let i = 0; i < numRows; i++) {
      const row = startRow + i;
      if (row <= CONFIG.HEADER_ROWS) continue;

      const currentStatus = getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN);
      let isAColumnNewlyFilled = false;

      // 1. A列が「空欄」から「テキスト入力」に変わったかどうかの判定
      if (includesAColumn) {
        if (numRows === 1 && numCols === 1) {
          const oldVal = e.oldValue;
          const newVal = e.value;
          const wasEmpty = (oldVal === undefined || oldVal === null || String(oldVal).trim() === '');
          const isNowFilled = (newVal !== undefined && newVal !== null && String(newVal).trim() !== '');
          
          if (wasEmpty && isNowFilled) {
            isAColumnNewlyFilled = true;
          }
        } else {
          const aValueTest = getCellDisplayValue_(sheet, row, 1);
          if (currentStatus === '' && aValueTest !== '') {
            isAColumnNewlyFilled = true;
          }
        }
      }

      // A列が空欄のままの場合は、他の列が編集されても完全に無視する
      const aValue = getCellDisplayValue_(sheet, row, 1);
      if (aValue === '' && !isAColumnNewlyFilled) {
        console.log(`row=${row}: A列が空欄のため、この行の編集は無視します。`);
        continue;
      }

      // 2. ステータスの決定
      let nextStatus = currentStatus;

      if (isAColumnNewlyFilled) {
        nextStatus = CONFIG.PENDING_NEW_TEXT;
        console.log(`row=${row}: A列の新規入力を検知。「新規待機」に設定します。`);
      } else {
        if (currentStatus === CONFIG.PENDING_NEW_TEXT) {
          nextStatus = CONFIG.PENDING_NEW_TEXT;
          console.log(`row=${row}: 新規入力の続きを検知。「新規待機」を維持します。`);
        } else {
          nextStatus = CONFIG.PENDING_UPDATE_TEXT;
          console.log(`row=${row}: データ更新を検知。「更新待機」に設定します。`);
        }
      }

      // 3. ステータスに変化があればJ列に書き込む
      if (nextStatus !== currentStatus) {
        sheet.getRange(row, CONFIG.STATUS_COLUMN).setValue(nextStatus);
        SpreadsheetApp.flush();
      }

      scheduleNotificationIfReady_(sheet, row);
    }
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
  console.log('--- notifyDiscordOnEdit end ---');
}

/**
 * 時間主導トリガーで実行する関数。
 */
function processPendingDiscordNotifications() {
  console.log('--- processPendingDiscordNotifications start ---');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const targetSheetName = getTargetSheetName_();
    const sheet = ss.getSheetByName(targetSheetName);

    if (!sheet) throw new Error(`対象シートが見つかりません: ${targetSheetName}`);
    const lastRow = sheet.getLastRow();
    if (lastRow <= CONFIG.HEADER_ROWS) return;

    const now = new Date();
    const targetRows = []; 

    for (let row = CONFIG.HEADER_ROWS + 1; row <= lastRow; row++) {
      const rowState = getNotificationRowState_(sheet, row, now);

      if (!rowState.complete) continue;
      if (rowState.notified) continue;

      if (!rowState.nextRetryAt) {
        scheduleNotificationIfReady_(sheet, row);
      }

      const errorText = getCellDisplayValue_(sheet, row, CONFIG.ERROR_COLUMN);
      const isErrorBackoff = errorText !== '';

      if (isErrorBackoff && !rowState.due) {
        console.log(`row=${row}: エラーによる再試行待機中のため、L列の時刻まで待機します。`);
        continue;
      }

      targetRows.push(row);
    }

    if (targetRows.length === 0) return; 

    const chunkSize = CONFIG.ENABLE_BATCH_NOTIFICATION ? CONFIG.BATCH_MAX_ITEMS : 1;

    for (let i = 0; i < targetRows.length; i += chunkSize) {
      const batchRows = targetRows.slice(i, i + chunkSize);
      let result;

      if (batchRows.length === 1) {
        const row = batchRows[0];
        try {
          result = sendDiscordNotification_(sheet, row);
        } catch (error) {
          result = { success: false, code: null, errorMessage: `GAS例外: ${String(error)}`, nextRetryAt: addMinutes_(new Date(), CONFIG.DEFAULT_RETRY_MINUTES) };
        }

        if (result.success) {
          markNotificationSuccess_(sheet, row);
        } else {
          markNotificationFailure_(sheet, row, result.errorMessage, result.nextRetryAt);
          if (result.code === 429) break;
        }

      } else {
        try {
          result = sendBatchDiscordNotification_(sheet, batchRows);
        } catch (error) {
          result = { success: false, code: null, errorMessage: `GAS例外: ${String(error)}`, nextRetryAt: addMinutes_(new Date(), CONFIG.DEFAULT_RETRY_MINUTES) };
        }

        if (result.success) {
          batchRows.forEach(row => markNotificationSuccess_(sheet, row));
        } else {
          batchRows.forEach(row => markNotificationFailure_(sheet, row, result.errorMessage, result.nextRetryAt));
          if (result.code === 429) break;
        }
      }
    }
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
  console.log('--- processPendingDiscordNotifications end ---');
}

/**
 * 単独通知用送信関数
 */
function sendDiscordNotification_(sheet, row) {
  const webhookUrl = getDiscordWebhookUrl_();
  const applicantValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[0]);
  const cValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[1]); // C列の値を取得
  const dValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[2]); // D列の値を取得
  const cell = sheet.getRange(row, CONFIG.REQUIRED_COLUMNS[0]).getA1Notation();
  const ss = sheet.getParent();
  const url = `${ss.getUrl()}#gid=${sheet.getSheetId()}&range=${encodeURIComponent(cell)}`;
  const time = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');

  let messageTemplate = CONFIG.MESSAGE_TEMPLATE;
  const currentStatus = getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN);
  const defaultTitle = '📢 新しいデータが追加されました';
  
  if (currentStatus === CONFIG.PENDING_UPDATE_TEXT) {
    if (messageTemplate.includes(defaultTitle)) {
      messageTemplate = messageTemplate.replace(defaultTitle, '📢 データが更新されました');
    } else {
      messageTemplate = '📢 データが更新されました\n' + messageTemplate;
    }
  }

  const content = messageTemplate
    .replaceAll('{{cell}}', cell)
    .replaceAll('{{value}}', String(applicantValue))
    .replaceAll('{{cValue}}', String(cValue))
    .replaceAll('{{dValue}}', String(dValue))
    .replaceAll('{{time}}', time)
    .replaceAll('{{url}}', url);

  const payload = buildDiscordPayload_(content);
  const response = postDiscordWebhookOnce_(webhookUrl, payload);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code >= 200 && code < 300) {
    return { success: true, code, body, errorMessage: '', nextRetryAt: null };
  }

  const retryInfo = getRetryInfoFromDiscordResponse_(response);
  return { success: false, code, body, errorMessage: buildHttpErrorMessage_(code, body), nextRetryAt: retryInfo.nextRetryAt };
}

/**
 * まとめ通知用送信関数
 */
function sendBatchDiscordNotification_(sheet, rows) {
  const webhookUrl = getDiscordWebhookUrl_();
  const ss = sheet.getParent();
  const time = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');

  let header = `📢 複数件のデータが追加・更新されました (計 ${rows.length}件)\n`;

  const bodyParts = rows.map(row => {
    const applicantValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[0]);
    const cValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[1]); // C列の値を取得
    const dValue = getCellDisplayValue_(sheet, row, CONFIG.REQUIRED_COLUMNS[2]); // D列の値を取得
    const cell = sheet.getRange(row, CONFIG.REQUIRED_COLUMNS[0]).getA1Notation();
    const url = `${ss.getUrl()}#gid=${sheet.getSheetId()}&range=${encodeURIComponent(cell)}`;
    const currentStatus = getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN);

    let tmpl = CONFIG.MESSAGE_TEMPLATE;
    const defaultTitle = '📢 新しいデータが追加されました';

    if (currentStatus === CONFIG.PENDING_UPDATE_TEXT) {
      if (tmpl.includes(defaultTitle)) {
        tmpl = tmpl.replace(defaultTitle, '【データ更新】');
      } else {
        tmpl = '【データ更新】\n' + tmpl;
      }
    } else {
      if (tmpl.includes(defaultTitle)) {
        tmpl = tmpl.replace(defaultTitle, '【新規データ】');
      } else {
        tmpl = '【新規データ】\n' + tmpl;
      }
    }

    return tmpl
      .replaceAll('{{cell}}', cell)
      .replaceAll('{{value}}', String(applicantValue))
      .replaceAll('{{cValue}}', String(cValue))
      .replaceAll('{{dValue}}', String(dValue))
      .replaceAll('{{time}}', time)
      .replaceAll('{{url}}', url);
  });

  let content = header + '\n' + bodyParts.join('\n\n---\n\n');
  if (content.length > 1900) {
    content = content.substring(0, 1900) + '\n...（文字数制限のため省略）';
  }

  const payload = buildDiscordPayload_(content);
  const response = postDiscordWebhookOnce_(webhookUrl, payload);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code >= 200 && code < 300) {
    return { success: true, code, body, errorMessage: '', nextRetryAt: null };
  }

  const retryInfo = getRetryInfoFromDiscordResponse_(response);
  return { success: false, code, body, errorMessage: buildHttpErrorMessage_(code, body), nextRetryAt: retryInfo.nextRetryAt };
}

function postDiscordWebhookOnce_(webhookUrl, payload) {
  return UrlFetchApp.fetch(webhookUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
}

function testDiscordNotification() {
  const webhookUrl = getDiscordWebhookUrl_();
  const response = postDiscordWebhookOnce_(webhookUrl, buildDiscordPayload_('✅ Google Apps Scriptからのテスト通知です。'));
  if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) return;
  throw new Error(buildHttpErrorMessage_(response.getResponseCode(), response.getContentText()));
}

function getRetryInfoFromDiscordResponse_(response) {
  const code = response.getResponseCode();
  const body = response.getContentText();
  const headers = response.getAllHeaders();
  let retryAfterMs = null;

  if (code === 429) {
    retryAfterMs = getRetryAfterMsFromBody_(body) || getRetryAfterMsFromHeaders_(headers);
  }

  if (retryAfterMs === null) {
    retryAfterMs = CONFIG.DEFAULT_RETRY_MINUTES * 60 * 1000;
  }
  return { retryAfterMs, nextRetryAt: new Date(Date.now() + retryAfterMs) };
}

function isRequiredRowComplete_(sheet, row) {
  return CONFIG.REQUIRED_COLUMNS.every(col => getCellDisplayValue_(sheet, row, col) !== '');
}

function scheduleNotificationIfReady_(sheet, row) {
  if (isNotified_(sheet, row) || !isRequiredRowComplete_(sheet, row)) return;

  const requestedAt = addMinutes_(new Date(), CONFIG.NOTIFICATION_DELAY_MINUTES);
  const existingNextRetryAt = getNextRetryAt_(sheet, row);
  let scheduledAt = requestedAt;

  if (existingNextRetryAt && existingNextRetryAt.getTime() > requestedAt.getTime()) {
    scheduledAt = existingNextRetryAt;
  }

  sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).setValue(scheduledAt);

  if (!existingNextRetryAt || existingNextRetryAt.getTime() <= requestedAt.getTime()) {
    sheet.getRange(row, CONFIG.ERROR_COLUMN).clearContent();
  }
}

function isNotified_(sheet, row) {
  return getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN) === CONFIG.NOTIFIED_TEXT;
}

function markNotificationSuccess_(sheet, row) {
  sheet.getRange(row, CONFIG.STATUS_COLUMN).setValue(CONFIG.NOTIFIED_TEXT);
  sheet.getRange(row, CONFIG.ERROR_COLUMN).clearContent();
  sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).clearContent();
  SpreadsheetApp.flush();
}

function markNotificationFailure_(sheet, row, errorMessage, nextRetryAt) {
  sheet.getRange(row, CONFIG.ERROR_COLUMN).setValue(truncateText_(errorMessage || 'Discord通知に失敗しました。', CONFIG.MAX_ERROR_LENGTH));
  sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).setValue(nextRetryAt || addMinutes_(new Date(), CONFIG.DEFAULT_RETRY_MINUTES));
}

function getNotificationRowState_(sheet, row, now) {
  const complete = CONFIG.REQUIRED_COLUMNS.every(col => getCellDisplayValue_(sheet, row, col) !== '');
  const notified = isNotified_(sheet, row);
  const nextRetryAt = getNextRetryAt_(sheet, row);
  const due = nextRetryAt ? nextRetryAt.getTime() <= now.getTime() : false;
  return { complete, notified, nextRetryAt, due };
}

function debugPendingNotificationRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(getTargetSheetName_());
  const now = new Date();
  for (let row = CONFIG.HEADER_ROWS + 1; row <= sheet.getLastRow(); row++) {
    const state = getNotificationRowState_(sheet, row, now);
    console.log(`row=${row} | J="${getCellDisplayValue_(sheet, row, CONFIG.STATUS_COLUMN)}" | K="${getCellDisplayValue_(sheet, row, CONFIG.ERROR_COLUMN)}" | due=${state.due}`);
  }
}

function debugWriteNotificationStatusForRow() {
  const row = 8;
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(getTargetSheetName_()).getRange(row, CONFIG.STATUS_COLUMN).setValue(CONFIG.NOTIFIED_TEXT);
  SpreadsheetApp.flush();
}

function debugListTriggers() {
  ScriptApp.getProjectTriggers().forEach((t, i) => console.log(`#${i + 1}, handler=${t.getHandlerFunction()}, eventType=${t.getEventType()}`));
}

function debugCreateTimeTriggerOnly() {
  ScriptApp.newTrigger('processPendingDiscordNotifications').timeBased().everyMinutes(1).create();
}

function cleanupOldNotificationProperties() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(key => { if (key.startsWith('notified:')) props.deleteProperty(key); });
}

function editedRangeIncludesTargetColumn_(startCol, numCols) {
  const endCol = startCol + numCols - 1;
  return [...CONFIG.REQUIRED_COLUMNS, ...CONFIG.UPDATE_COLUMNS].some(col => col >= startCol && col <= endCol);
}

function getDiscordWebhookUrl_() { return getRequiredScriptProperty_(CONFIG.PROPERTY_KEYS.DISCORD_WEBHOOK_URL, 'Discord Webhook URL'); }
function getTargetSheetName_() { return getRequiredScriptProperty_(CONFIG.PROPERTY_KEYS.SHEET_NAME, '対象シート名'); }
function getMentionRoleId_() { return getRequiredScriptProperty_(CONFIG.PROPERTY_KEYS.MENTION_ROLE_ID, 'DiscordロールID'); }
function getRequiredScriptProperty_(key, label) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error(`${label} が未設定です。`);
  return value;
}

function buildDiscordPayload_(content) {
  const roleId = getMentionRoleId_();
  const mentionText = roleId ? `<@&${roleId}>` : '';
  return { username: CONFIG.BOT_NAME, content: [mentionText, content].filter(Boolean).join('\n'), allowed_mentions: roleId ? { roles: [roleId] } : { parse: [] } };
}

function getRetryAfterMsFromBody_(body) {
  try {
    const json = JSON.parse(body);
    if (json?.retry_after != null && !isNaN(Number(json.retry_after))) return Math.ceil(Number(json.retry_after) * 1000) + 1000;
  } catch (e) {}
  return null;
}

function getRetryAfterMsFromHeaders_(headers) {
  const val = getHeaderValue_(headers, ['Retry-After', 'retry-after', 'X-RateLimit-Reset-After', 'x-ratelimit-reset-after']);
  if (!val) return null;
  if (!isNaN(Number(val))) return Math.ceil(Number(val) * 1000) + 1000;
  const asDate = new Date(val);
  if (!isNaN(asDate.getTime())) return Math.max(asDate.getTime() - Date.now() + 1000, 1000);
  return null;
}

function getHeaderValue_(headers, names) {
  for (const n of names) if (headers[n] !== undefined) return Array.isArray(headers[n]) ? headers[n][0] : headers[n];
  const lowerMap = Object.keys(headers).reduce((acc, k) => { acc[k.toLowerCase()] = headers[k]; return acc; }, {});
  for (const n of names) if (lowerMap[n.toLowerCase()] !== undefined) return Array.isArray(lowerMap[n.toLowerCase()]) ? lowerMap[n.toLowerCase()][0] : lowerMap[n.toLowerCase()];
  return null;
}

function getNextRetryAt_(sheet, row) {
  const val = sheet.getRange(row, CONFIG.NEXT_RETRY_COLUMN).getValue();
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function getCellDisplayValue_(sheet, row, col) { return String(sheet.getRange(row, col).getDisplayValue()).trim(); }
function buildHttpErrorMessage_(code, body) { return `HTTP ${code}: ${truncateText_(String(body || ''), CONFIG.MAX_ERROR_LENGTH)}`; }
function truncateText_(text, max) { const v = String(text || ''); return v.length <= max ? v : v.slice(0, max) + '...'; }
function addMinutes_(date, m) { return new Date(date.getTime() + m * 60 * 1000); }
function maskSecret_(val) { const t = String(val || ''); return t.length <= 12 ? '********' : t.slice(0, 6) + '...' + t.slice(-6); }

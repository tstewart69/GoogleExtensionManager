/**
 * Extension review web app + Slack alerts.
 *
 * Deploy:  Deploy → New deployment → Web app
 *          Execute as: User accessing the web app   |   Who has access: Anyone within your domain
 *          Every visitor authorizes once on first open.
 *          Reads use the visitor's Sheet access; approve/deny uses the visitor's own
 *          Google Admin privileges. dailySync() still runs as the trigger owner.
 *
 * Access:  No hardcoded admin list. A visitor is an admin if their own token can
 *          read Chrome app policy (checked once, cached 6h per user).
 *          Review sheet — Viewer for your domain (or the review group), Editor for admins only.
 *          Admins need Chrome Management → Settings → Manage Application Settings.
 *          post_() must authenticate with ScriptApp.getOAuthToken() so policy calls
 *          run as the visitor, not a service account.
 *
 * Script properties (Project Settings → Script properties):
 *   SLACK_WEBHOOK_URL  — Slack incoming webhook (alerts are skipped if unset)
 *   REVIEW_APP_URL     — the web app's /exec URL (used in Slack buttons)
 *
 * Schedule: add a daily time-driven trigger on dailySync().
 */

const REVIEW = {
  DECISIONS_TAB: 'Decisions',
  REVIEW_PERIOD_DAYS: 365,
  SLACK_LIST_MAX: 5,                        // ≤ this many new items get listed in Slack
  DENY_INSTALL_TYPE: 'REMOVE',              // Block/uninstall at root OU
};

const DECISION = { APPROVED: 'APPROVED', APPROVED_REVIEW: 'APPROVED_REVIEW', DENIED: 'DENIED' };
const DECISION_HEADERS = ['App ID', 'Display Name', 'Decision', 'Decided By', 'Decided On', 'Review Due', 'Score', 'Note'];

/* ---------- Scheduled entry point (runs as trigger owner) ---------- */

function dailySync() {
  decisionsSheet_();   // create the tab up front so an admin's first click never needs tab-creation rights
  inventoryInstalledExtensions();
  scoreExtensions();   // also sends the Slack alert for new items
}

/* ---------- Web app (runs as the visitor) ---------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Review')
    .setTitle('Extension Review')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from the page. Returns a JSON string (google.script.run silently nulls some object returns). */
function getReviewData() {
  return JSON.stringify(getReviewData_());
}

function getReviewData_() {
  const user = currentUser_();
  const sheet = reviewSpreadsheet_().getSheetByName(RUBRIC.OUTPUT_TAB);
  const items = [];
  let lastScored = '';

  if (sheet && sheet.getLastRow() > 1) {
    const values = sheet.getDataRange().getValues();
    const idx = {};
    values.shift().forEach(function (h, i) { idx[h] = i; });
    const decisions = latestDecisions_();

    values.forEach(function (r) {
      const id = String(r[idx['App ID']]);
      if (isSuppressedByDecision_(decisions[id])) return;
      items.push({
        appId: id,
        name: String(r[idx['Display Name']] || id),
        publisher: String(r[idx['Publisher']] || ''),
        type: String(r[idx['Type']] || ''),
        score: Number(r[idx['Score']]) || 0,
        trigger: String(r[idx['Trigger']] || ''),
        reasons: String(r[idx['Reasons']] || ''),
        devices: Number(r[idx['Browser Devices']]) || 0,
        osUsers: Number(r[idx['OS Users']]) || 0,
        storeUrl: safeStoreUrl_(r[idx['Store URL']], id),
      });
    });
    lastScored = sheet.getRange('A1').getNote().replace(/^Last scored:\s*/, '').split(' |')[0];
  }
  return { items: items, user: user.email, isAdmin: user.isAdmin, lastScored: lastScored };
}

/** Called from the page. Admin-only. DENIED also blocks/uninstalls at the root OU using the visitor's credentials. */
function recordDecision(appId, decision, note) {
  const user = currentUser_();
  if (!user.isAdmin) throw new Error('Only system admins can approve or deny. You can still view the list.');
  if (!/^[a-p]{32}$/.test(String(appId))) throw new Error('Invalid extension ID: ' + appId);
  if (!DECISION[decision]) throw new Error('Unknown decision: ' + decision);

  const item = findReviewItem_(appId);
  if (decision === DECISION.DENIED) blockAtRoot_(appId);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const now = new Date();
    const due = decision === DECISION.APPROVED_REVIEW
      ? new Date(now.getTime() + REVIEW.REVIEW_PERIOD_DAYS * 86400000) : '';
    try {
      decisionsSheet_().appendRow([
        appId, cellSafe_(item.name), decision, user.email, now, due, item.score, cellSafe_(String(note || '').slice(0, 500)),
      ]);
    } catch (e) {
      throw new Error('Couldn\'t write to the Decisions tab. You need edit access to the review sheet.' +
        (decision === DECISION.DENIED ? ' The block WAS applied in Google Admin.' : ''));
    }
  } finally {
    lock.releaseLock();
  }
  return { appId: appId, decision: decision };
}

/* ---------- Decisions (shared with ExtensionRubric.gs) ---------- */

/** Latest decision per App ID. The Decisions tab is append-only, so later rows win. */
function latestDecisions_() {
  const sheet = reviewSpreadsheet_().getSheetByName(REVIEW.DECISIONS_TAB);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, DECISION_HEADERS.length).getValues().forEach(function (r) {
    out[String(r[0])] = { decision: String(r[2]), decidedOn: r[4], reviewDue: r[5] };
  });
  return out;
}

/** True when a decision keeps the app off the review list. */
function isSuppressedByDecision_(d) {
  if (!d) return false;
  if (d.decision === DECISION.APPROVED || d.decision === DECISION.DENIED) return true;
  if (d.decision === DECISION.APPROVED_REVIEW) {
    return d.reviewDue instanceof Date && d.reviewDue.getTime() > Date.now();
  }
  return false;
}

/* ---------- Slack (runs from the trigger only) ---------- */

/** Alerts only on App IDs not in the previous run's flagged set. */
function notifyNewReviews_(flagged) {
  const props = PropertiesService.getScriptProperties();
  const key = function (row) { return String(row[3]).slice(0, 12); };   // short IDs keep the property small
  const seen = (props.getProperty('ALERTED_IDS') || '').split(',');
  const fresh = flagged.filter(function (row) { return seen.indexOf(key(row)) === -1; });
  props.setProperty('ALERTED_IDS', flagged.map(key).join(','));

  if (!fresh.length) return;
  const webhook = props.getProperty('SLACK_WEBHOOK_URL');
  if (!webhook) { Logger.log('%s new reviews — SLACK_WEBHOOK_URL not set, no alert sent', fresh.length); return; }

  const res = UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(slackMessage_(fresh, flagged.length)),
    muteHttpExceptions: true,
  });
  Logger.log('Slack alert for %s new reviews — HTTP %s', fresh.length, res.getResponseCode());
}

/** Rows are Needs Review rows: [score, trigger, reasons, appId, name, publisher, type, installType, devices, osUsers, lastUpdated, storeUrl]. */
function slackMessage_(fresh, total) {
  const appUrl = PropertiesService.getScriptProperties().getProperty('REVIEW_APP_URL') || ScriptApp.getService().getUrl();
  const title = fresh.length + ' Chrome extension' + (fresh.length === 1 ? '' : 's') + ' need review';
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: title } }];

  if (fresh.length <= REVIEW.SLACK_LIST_MAX) {
    fresh.forEach(function (r) {
      const name = slackEsc_(r[4] || r[3]);
      const link = safeStoreUrl_(r[11], r[3]);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: (link ? '*<' + link + '|' + name + '>*' : '*' + name + '*') +
            '\nScore *' + r[0] + '* · ' + slackEsc_(r[1]) + ' · ' + (Number(r[8]) || 0) + ' browser devices' +
            '\n_' + slackEsc_(String(r[2]).slice(0, 200)) + '_',
        },
      });
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'Too many to list here. ' + total + ' total pending on the review page.' },
    });
  }

  if (appUrl) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open review page' }, url: appUrl, style: 'primary' }],
    });
  }
  return { text: title, blocks: blocks };
}

/** Logs the Slack payload for the current Needs Review tab without posting. */
function previewSlackAlert() {
  const sheet = reviewSpreadsheet_().getSheetByName(RUBRIC.OUTPUT_TAB);
  const rows = sheet.getDataRange().getValues().slice(1);
  Logger.log(JSON.stringify(slackMessage_(rows.slice(0, 3), rows.length), null, 2));
}

/* ---------- Helpers ---------- */

/** Runs with the visitor's OAuth token via post_(). Non-admins get a 403 from the Policy API. */
function blockAtRoot_(appId) {
  const ou = ROOT_OU_ID || rootOuId_();
  const res = post_(POLICY_BASE + '/policies/orgunits:batchModify', {
    requests: [{
      policyTargetKey: { targetResource: 'orgunits/' + ou, additionalTargetKeys: { app_id: 'chrome:' + appId } },
      policyValue: { policySchema: 'chrome.users.apps.InstallType', value: { appInstallType: REVIEW.DENY_INSTALL_TYPE } },
      updateMask: 'appInstallType',
    }],
  });
  if (res._error) {
    const err = res._error.error || {};
    if (err.code === 403) throw new Error('Your Google account can\'t change Chrome app policy. Block not applied.');
    throw new Error('Block failed: ' + (err.message || JSON.stringify(res._error)));
  }
}

function findReviewItem_(appId) {
  const sheet = reviewSpreadsheet_().getSheetByName(RUBRIC.OUTPUT_TAB);
  const values = sheet ? sheet.getDataRange().getValues() : [[]];
  const h = values.shift();
  const iId = h.indexOf('App ID'), iName = h.indexOf('Display Name'), iScore = h.indexOf('Score');
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][iId]) === appId) return { name: String(values[i][iName]), score: values[i][iScore] };
  }
  return { name: appId, score: '' };
}

function decisionsSheet_() {
  const ss = reviewSpreadsheet_();
  let sheet = ss.getSheetByName(REVIEW.DECISIONS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(REVIEW.DECISIONS_TAB);
    sheet.appendRow(DECISION_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Admin = the visitor's own token can read Chrome app policy. Cached per user for 6h. */
function currentUser_() {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) return { email: '', isAdmin: false };
  const cache = CacheService.getUserCache();
  let flag = cache.get('IS_CHROME_ADMIN');
  if (flag === null) {
    const check = canManageChromePolicy_();
    flag = String(check.ok);
    cache.put('IS_CHROME_ADMIN', flag, check.ok ? 21600 : 60);   // only cache "no" for a minute
  }
  return { email: email, isAdmin: flag === 'true' };
}

function canManageChromePolicy_() {
  try {
    const ou = ROOT_OU_ID || rootOuId_();
    const res = post_(POLICY_BASE + '/policies:resolve', {
      policyTargetKey: { targetResource: 'orgunits/' + ou },
      policySchemaFilter: 'chrome.users.apps.InstallType',
      pageSize: 1,
    });
    if (res._error) return { ok: false, reason: 'Policy API: ' + JSON.stringify(res._error).slice(0, 300) };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/** Run from the editor. Clears your cached admin flag and logs why the check passes or fails. */
function debugAdminCheck() {
  CacheService.getUserCache().remove('IS_CHROME_ADMIN');
  const check = canManageChromePolicy_();
  Logger.log('User: %s | admin: %s | reason: %s', Session.getActiveUser().getEmail(), check.ok, check.reason || 'n/a');
}

/** Uses SHEET_ID when set, otherwise the spreadsheet this script is bound to. */
function reviewSpreadsheet_() {
  let ss;
  try {
    ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    throw new Error('You don\'t have access to the review sheet. Ask an admin for view access.');
  }
  if (!ss) throw new Error('No spreadsheet found. Set SHEET_ID in InstalledExtensionsInventory.gs to the sheet\'s ID.');
  return ss;
}

/** Only Chrome Web Store links make it onto the page or into Slack. */
function safeStoreUrl_(url, appId) {
  url = String(url || '');
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//.test(url)) return url;
  return /^[a-p]{32}$/.test(String(appId)) ? 'https://chromewebstore.google.com/detail/' + appId : '';
}

/** Stops extension names from being treated as formulas. */
function cellSafe_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

function slackEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '¦');
}

function testReviewData() {
  const t = Date.now();
  const s = getReviewData();
  Logger.log('%s ms, %s chars', Date.now() - t, s.length);
  Logger.log(s.slice(0, 300));
}

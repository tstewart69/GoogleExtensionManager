/**
 * Installed Chrome extension/app inventory — whole tenant, read-only.
 * Source:     reports:countInstalledApps (managed browsers + ChromeOS)
 * Enrichment: apps/chrome/{appId} (Web Store details, CWS-hosted only)
 * Output:     overwrites one tab in a Google Sheet.
 */

const SHEET_ID = '';                 // blank = the sheet this script is bound to
const TAB_NAME = 'Installed Extensions';
const BATCH_SIZE = 25;               // parallel detail lookups per batch
const BATCH_PAUSE_MS = 1000;         // pause between batches (quota headroom)
const BASE = 'https://chromemanagement.googleapis.com/v1/customers/my_customer';
const POLICY_BASE = 'https://chromepolicy.googleapis.com/v1/customers/my_customer';
const INCLUDE_BLOCKED = false;       // false = skip extensions blocked at the root OU
const ROOT_OU_ID = '';               // optional override, e.g. '03ph8a2z1234abc'; blank = auto-detect

const HEADERS = [
  'App ID', 'Display Name', 'Description', 'Type', 'Install Type', 'Source', 'Disabled',
  'Browser Devices', 'OS Users', 'Permissions (reported)', 'Homepage', 'Risk Assessment (raw)',
  'Publisher', 'Rating', 'Reviews', 'CWS Min Users', 'Site Access', 'Permissions (CWS)',
  'First Published', 'Last Updated', 'Paid', 'Google Owned', 'CWS Hosted',
  'Privacy Policy', 'Store URL', 'Enrichment Error',
];

function inventoryInstalledExtensions() {
  const all = listInstalledApps_();
  let apps = all;
  if (!INCLUDE_BLOCKED) {
    const blocked = listBlockedAppIds_();
    apps = all.filter(function (a) { return !blocked[a.appId]; });
  }
  Logger.log('%s reported, %s skipped as blocked', all.length, all.length - apps.length);

  const details = fetchDetails_(apps);
  const rows = apps.map(function (a) { return toRow_(a, details[a.appId]); });

  write_(rows);
  Logger.log('Wrote %s rows to "%s"', rows.length, TAB_NAME);
}

/** Pages through every installed app/extension in the tenant. */
function listInstalledApps_() {
  const out = [];
  let pageToken = '';
  do {
    const q = { pageSize: 100 };
    if (pageToken) q.pageToken = pageToken;
    const res = get_(BASE + '/reports:countInstalledApps', q);
    if (res._error) throw new Error('countInstalledApps failed: ' + JSON.stringify(res._error));
    (res.installedApps || []).forEach(function (a) { out.push(a); });
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** App IDs set to Block (BLOCKED) or Block/uninstall (REMOVE) at the root OU. */
function listBlockedAppIds_() {
  const ou = ROOT_OU_ID || rootOuId_();
  const blocked = {};
  const typesSeen = {};
  let pageToken = '';
  do {
    const body = {
      policySchemaFilter: 'chrome.users.apps.InstallType',
      policyTargetKey: { targetResource: 'orgunits/' + ou },
      pageSize: 1000,
    };
    if (pageToken) body.pageToken = pageToken;
    const res = post_(POLICY_BASE + '/policies:resolve', body);
    if (res._error) throw new Error('Policy resolve failed: ' + JSON.stringify(res._error));
    (res.resolvedPolicies || []).forEach(function (p) {
      const keys = (p.targetKey && p.targetKey.additionalTargetKeys) || {};
      const appId = String(keys.app_id || '').replace(/^chrome:/, '');
      const type = String((p.value && p.value.value && p.value.value.appInstallType) || '');
      typesSeen[type] = (typesSeen[type] || 0) + 1;
      if (appId && (type === 'BLOCKED' || type === 'REMOVE')) blocked[appId] = true;
    });
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  Logger.log('Root OU %s install types: %s', ou, JSON.stringify(typesSeen));
  Logger.log('%s app IDs blocked at root', Object.keys(blocked).length);
  return blocked;
}

/** Root OU ID via a top-level child's parent. Set ROOT_OU_ID if there are no child OUs. */
function rootOuId_() {
  const res = AdminDirectory.Orgunits.list('my_customer', { type: 'children' });
  const child = (res.organizationUnits || [])[0];
  if (!child) throw new Error('No child OUs found — set ROOT_OU_ID manually.');
  return String(child.parentOrgUnitId).replace(/^id:/, '');
}

/** Web Store details for each unique CWS-hosted appId, batched with one retry pass for 429s. */
function fetchDetails_(apps) {
  const ids = [];
  const seen = {};
  apps.forEach(function (a) {
    if (a.appSource === 'CHROME_WEBSTORE' && !seen[a.appId]) { seen[a.appId] = true; ids.push(a.appId); }
  });

  const details = {};
  let pending = ids;
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const retry = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const responses = UrlFetchApp.fetchAll(chunk.map(function (id) {
        return {
          url: BASE + '/apps/chrome/' + id,
          headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
          muteHttpExceptions: true,
        };
      }));
      responses.forEach(function (r, j) {
        const code = r.getResponseCode();
        if (code === 429 && attempt === 0) { retry.push(chunk[j]); return; }
        const body = JSON.parse(r.getContentText() || '{}');
        details[chunk[j]] = code === 200 ? body : { _error: code + ' ' + ((body.error && body.error.message) || '') };
      });
      Utilities.sleep(BATCH_PAUSE_MS);
    }
    pending = retry;
    if (pending.length) Utilities.sleep(10000);
  }
  return details;
}

function toRow_(a, d) {
  d = d || {};
  const info = d.chromeAppInfo || {};
  return [
    a.appId, a.displayName, a.description, a.appType, a.appInstallType, a.appSource, !!a.disabled,
    a.browserDeviceCount || 0, a.osUserCount || 0, join_(a.permissions), a.homepageUri,
    a.riskAssessment ? JSON.stringify(a.riskAssessment) : '',
    d.publisher, d.reviewRating, d.reviewNumber, info.minUserCount,
    join_((info.siteAccess || []).map(function (s) { return s.hostMatch; })),
    join_((info.permissions || []).map(function (p) { return p.type; })),
    d.firstPublishTime, d.latestPublishTime, d.isPaidApp, info.googleOwned, info.isCwsHosted,
    d.privacyPolicyUri, d.detailUri, d._error || '',
  ].map(clean_);
}

function write_(rows) {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_NAME) || ss.insertSheet(TAB_NAME);
  sheet.clearContents();
  const data = [HEADERS].concat(rows);
  sheet.getRange(1, 1, data.length, HEADERS.length).setValues(data);
  sheet.setFrozenRows(1);
  sheet.getRange('A1').setNote('Last run: ' + new Date().toISOString());
}

function get_(url, params) {
  if (params) {
    url += '?' + Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  }
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) {
    Logger.log('HTTP %s — %s\n%s', res.getResponseCode(), url, JSON.stringify(body, null, 2));
    return { _error: body };
  }
  return body;
}

function post_(url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) {
    Logger.log('HTTP %s — %s\n%s', res.getResponseCode(), url, JSON.stringify(body, null, 2));
    return { _error: body };
  }
  return body;
}

function join_(arr) { return (arr || []).filter(Boolean).join(', '); }

/** Sheets cells cap at 50k chars; undefined → blank. */
function clean_(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' && v.length > 49000 ? v.slice(0, 49000) + '…' : v;
}

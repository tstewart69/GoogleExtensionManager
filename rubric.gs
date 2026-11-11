/**
 * Extension review rubric — run after inventoryInstalledExtensions().
 * Reads the "Installed Extensions" tab, scores every row, and overwrites
 * the "Needs Review" tab with flagged extensions only.
 * Read-only against Google; writes only to this spreadsheet.
 */

const RUBRIC = {
  SOURCE_TAB: 'Installed Extensions',
  OUTPUT_TAB: 'Needs Review',
  THRESHOLD: 7,

  // Exemptions
  EXEMPT_INSTALL_TYPES: ['ADMIN'],                       // force-installed by IT
  EXEMPT_PUBLISHERS: /(?!)/,                             // matches nothing; add trusted publishers, e.g. /vendor-a|vendor-b/i
  EXEMPT_APP_IDS: [],                                    // pin specific IDs here

  // Hard flags
  KEYWORDS: [
    { label: 'VPN',  re: /\bVPN\b/i },
    { label: 'AI',   re: /\bAI\b/ },                     // case-sensitive: avoids "said", "mail"
    { label: 'free', re: /\bfree\b/i},
    { label: 'password', re: /\bpassword\b/i},
  ],

  // Site access
  ALL_SITES: /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/,
  SENSITIVE_HOSTS: ['mail.google.com', 'drive.google.com', 'docs.google.com'],
  MANY_HOSTS: 10,

  // Permissions
  HIGH_PERMS: ['debugger', 'nativeMessaging', 'proxy', 'vpnProvider', 'webRequest', 'webRequestBlocking',
    'cookies', 'history', 'management', 'privacy', 'clipboardRead', 'desktopCapture', 'tabCapture',
    'pageCapture', 'contentSettings'],
  MEDIUM_PERMS: ['tabs', 'scripting', 'downloads', 'webNavigation', 'declarativeNetRequest', 'bookmarks',
    'topSites', 'identity', 'geolocation'],
  HIGH_CAP: 4,
  MEDIUM_CAP: 2,

  // Reputation
  MIN_RATING: 3.0,
  MIN_REVIEWS: 10,
  MIN_USERS: 500,

  // Freshness (days)
  STALE_DAYS: 730,
  RECENT_DAYS: 14,
};

function scoreExtensions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const src = ss.getSheetByName(RUBRIC.SOURCE_TAB);
  if (!src) throw new Error('Missing tab: ' + RUBRIC.SOURCE_TAB + ' — run inventoryInstalledExtensions() first.');

  const values = src.getDataRange().getValues();
  const col = indexHeaders_(values.shift());
  const flagged = [];
  let exempt = 0;
  let decided = 0;
  const decisions = typeof latestDecisions_ === 'function' ? latestDecisions_() : {};

  values.forEach(function (r) {
    const row = function (name) { return r[col[name]]; };
    if (isExempt_(row)) { exempt++; return; }

    // Approved / denied stay off the list; yearly reviews come back once due.
    const d = decisions[String(row('App ID'))];
    if (d && isSuppressedByDecision_(d)) { decided++; return; }
    const reviewDue = !!(d && d.decision === 'APPROVED_REVIEW');

    const result = scoreRow_(row);
    if (reviewDue) result.hard.unshift('yearly-review-due');
    if (result.hard.length || result.score >= RUBRIC.THRESHOLD) {
      flagged.push([
        result.score,
        reviewDue ? 'Review due' : (result.hard.length ? 'Hard flag' : 'Score'),
        result.hard.concat(result.reasons).join('; '),
        row('App ID'), row('Display Name'), row('Publisher'), row('Type'), row('Install Type'),
        row('Browser Devices'), row('OS Users'), row('Last Updated'), row('Store URL'),
      ]);
    }
  });

  flagged.sort(function (a, b) { return b[0] - a[0]; });
  writeReview_(ss, flagged);
  Logger.log('%s scored, %s exempt, %s already decided, %s flagged',
    values.length - exempt - decided, exempt, decided, flagged.length);
  if (typeof notifyNewReviews_ === 'function') notifyNewReviews_(flagged);
}

function isExempt_(row) {
  return row('Disabled') === true
    || RUBRIC.EXEMPT_INSTALL_TYPES.indexOf(String(row('Install Type'))) !== -1
    || RUBRIC.EXEMPT_APP_IDS.indexOf(String(row('App ID'))) !== -1
    || RUBRIC.EXEMPT_PUBLISHERS.test(String(row('Publisher') || ''));
}

function scoreRow_(row) {
  const hard = [];
  const reasons = [];
  let score = 0;

  // Split host patterns from API permissions across both permission columns + site access.
  const tokens = split_(row('Permissions (reported)'))
    .concat(split_(row('Permissions (CWS)')), split_(row('Site Access')));
  const hosts = unique_(tokens.filter(function (t) { return t === '<all_urls>' || t.indexOf('://') !== -1; }));
  const perms = unique_(tokens.filter(function (t) { return hosts.indexOf(t) === -1; }));
  const allSites = hosts.some(function (h) { return RUBRIC.ALL_SITES.test(h); });

  // --- Hard flags ---
  const text = row('Display Name') + ' ' + row('Description');
  RUBRIC.KEYWORDS.forEach(function (k) { if (k.re.test(text)) hard.push('keyword:' + k.label); });

  if (row('Type') === 'THEME' && (hosts.length || perms.length)) hard.push('theme-with-access');

  const source = String(row('Source'));
  if (source && source !== 'CHROME_WEBSTORE' && row('Type') !== 'ANDROID_APP') hard.push('source:' + source);

  if (/HIGH/i.test(String(row('Risk Assessment (raw)')))) hard.push('risk:HIGH');

  // --- Site access ---
  if (allSites) { score += 2; reasons.push('site:all'); }
  else if (hosts.length > RUBRIC.MANY_HOSTS) { score += 1; reasons.push('site:' + hosts.length + '-hosts'); }

  const sensitive = RUBRIC.SENSITIVE_HOSTS.filter(function (s) {
    return hosts.some(function (h) { return h.indexOf(s) !== -1; });
  });
  if (sensitive.length) { score += 1; reasons.push('site:sensitive(' + sensitive.join(',') + ')'); }

  // --- Permissions ---
  const high = perms.filter(function (p) { return RUBRIC.HIGH_PERMS.indexOf(p) !== -1; });
  const med = perms.filter(function (p) { return RUBRIC.MEDIUM_PERMS.indexOf(p) !== -1; });
  if (high.length) { score += Math.min(high.length * 2, RUBRIC.HIGH_CAP); reasons.push('perm-high:' + high.join(',')); }
  if (med.length) { score += Math.min(med.length, RUBRIC.MEDIUM_CAP); reasons.push('perm-med:' + med.join(',')); }

  // --- Reputation (Web Store only) ---
  if (source === 'CHROME_WEBSTORE') {
    const rating = Number(row('Rating'));
    const reviews = Number(row('Reviews')) || 0;
    const users = Number(row('CWS Min Users'));
    if (reviews > 0 && rating < RUBRIC.MIN_RATING) { score += 2; reasons.push('rating:' + rating); }
    if (reviews < RUBRIC.MIN_REVIEWS) { score += 1; reasons.push('reviews:' + reviews); }
    if (row('CWS Min Users') !== '' && users < RUBRIC.MIN_USERS) { score += 1; reasons.push('users:' + users); }
  }

  // --- Freshness ---
  const updated = row('Last Updated') ? new Date(row('Last Updated')) : null;
  if (updated && !isNaN(updated)) {
    const days = Math.floor((Date.now() - updated.getTime()) / 86400000);
    if (days > RUBRIC.STALE_DAYS) { score += 1; reasons.push('stale:' + Math.round(days / 30) + 'mo'); }
    else if (days <= RUBRIC.RECENT_DAYS && allSites) { score += 1; reasons.push('recent-update+all-sites'); }
  }

  return { score: score, hard: hard, reasons: reasons };
}

function writeReview_(ss, rows) {
  const headers = ['Score', 'Trigger', 'Reasons', 'App ID', 'Display Name', 'Publisher', 'Type',
    'Install Type', 'Browser Devices', 'OS Users', 'Last Updated', 'Store URL'];
  const sheet = ss.getSheetByName(RUBRIC.OUTPUT_TAB) || ss.insertSheet(RUBRIC.OUTPUT_TAB);
  sheet.clearContents();
  const data = [headers].concat(rows);
  sheet.getRange(1, 1, data.length, headers.length).setValues(data);
  sheet.setFrozenRows(1);
  sheet.getRange('A1').setNote('Last scored: ' + new Date().toISOString() + ' | threshold ' + RUBRIC.THRESHOLD);
}

function indexHeaders_(headers) {
  const map = {};
  headers.forEach(function (h, i) { map[h] = i; });
  ['App ID', 'Display Name', 'Description', 'Type', 'Install Type', 'Source', 'Permissions (reported)',
    'Risk Assessment (raw)', 'Publisher', 'Rating', 'Reviews', 'CWS Min Users', 'Site Access',
    'Permissions (CWS)', 'Last Updated', 'Store URL'].forEach(function (h) {
    if (map[h] === undefined) throw new Error('Missing column: ' + h);
  });
  return map;
}

function split_(v) {
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function unique_(arr) {
  return arr.filter(function (v, i) { return arr.indexOf(v) === i; });
}

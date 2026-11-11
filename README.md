# Chrome Extension Review

> [!WARNING]
> **Use at your own risk.** I put this together using a combination of AI and my own scripting knowledge. Review the code and test it in your environment before you rely on it. The **Deny** action blocks and uninstalls extensions across your whole organization.

A Google Apps Script tool that inventories every Chrome extension installed across the Google Workspace tenant, scores each one against a risk rubric, and gives IT admins a web page where they approve or deny what gets flagged. Denying an extension blocks and uninstalls it at the root OU. New flags are posted to Slack.

## How it works

```
dailySync()  (daily time-driven trigger, runs as the trigger owner)
 ├─ inventoryInstalledExtensions()  → "Installed Extensions" tab
 │    Chrome Management API: installed apps report + Web Store details
 │    Skips extensions already blocked at the root OU
 ├─ scoreExtensions()               → "Needs Review" tab
 │    Applies the rubric, skips exempt and already-decided extensions
 └─ notifyNewReviews_()             → Slack alert for newly flagged IDs

Review web app  (runs as the person visiting it)
 ├─ Everyone in the domain can view the review list
 └─ Chrome admins can Approve, Approve with yearly review, or Deny
      Deny → Chrome Policy API sets the extension to "Block and uninstall" at the root OU
      Every decision is appended to the "Decisions" tab
```

## Repository layout

| File | Purpose |
|---|---|
| `Pull_extensions.gs` | Pulls the installed-extension report and Web Store details, writes the **Installed Extensions** tab. Also holds the shared `get_`/`post_` API helpers and the `SHEET_ID` / `ROOT_OU_ID` settings. |
| `rubric.gs` | Scores every row and writes the flagged ones to the **Needs Review** tab. All thresholds live in the `RUBRIC` object. |
| `Reviewapp.gs` | Web app backend, the `dailySync()` entry point, the Decisions log, Slack alerts, and the admin check. |
| `review.html` | The review page UI. It must be named exactly `Review` in the Apps Script editor. |
| `appsscript.json` | Manifest: OAuth scopes, the Admin Directory advanced service, and web app settings. |

## Prerequisites

- A Google Workspace super admin, or an admin with a custom role that includes the **Chrome Management** privileges (reports, app details, and settings, including *Manage Application Settings*) and read access to **Organizational Units**. This person owns the script and the daily trigger.
- A Google Cloud project you can enable APIs in.
- At least one child OU under the root, or the root OU ID on hand.
- Optional: a Slack incoming webhook for alerts.

## Setup

### 1. Create the Google Cloud project

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one) and note its **project number**.
2. Under **APIs & Services → Library**, enable:
   - **Chrome Management API**
   - **Chrome Policy API**
   - **Admin SDK API**
3. Under **APIs & Services → OAuth consent screen**, set the user type to **Internal** and fill in the required fields. With an internal consent screen, people in your domain can authorize the app without Google verification.

### 2. Create the spreadsheet and script project

1. Create a new Google Sheet, for example *Chrome Extension Review*.
2. Open **Extensions → Apps Script**. This creates a script bound to the sheet, so `SHEET_ID` can stay blank.
3. In the script editor, open **Project Settings**:
   - Check **Show "appsscript.json" manifest file in editor**.
   - Under **Google Cloud Platform (GCP) Project**, click **Change project** and enter the project number from step 1.

### 3. Add the code

1. Paste `appsscript.json` from this repo over the default manifest. Change `timeZone` if you're not in `America/Denver`.
2. Create three script files and paste in the matching code: `InstalledExtensionsInventory`, `ExtensionRubric`, and `ExtensionReview`.
3. Create an HTML file named **`Review`** and paste in `Review.html`.
4. Save.

The manifest already turns on the **Admin Directory** advanced service (`AdminDirectory`), so you don't need to add it by hand.

### 4. Run it once by hand

As the admin who will own the trigger, run these from the editor in this order:

1. **`inventoryInstalledExtensions`**. On the first run you'll be asked to authorize the scopes. This creates and fills the **Installed Extensions** tab. Check the execution log for the reported count, the number skipped as blocked, and the root OU ID it detected.
2. **`scoreExtensions`**. This creates the **Needs Review** tab. Nothing goes to Slack yet unless the webhook is set.
3. **`debugAdminCheck`**. The log line should read `admin: true`. If it says `false`, the reason field tells you why; usually a missing privilege or an API that isn't enabled.

### 5. Configure Slack (optional)

In **Project Settings → Script properties**, add:

| Property | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | Your Slack incoming webhook URL. If it's not set, alerts are skipped and logged. |
| `REVIEW_APP_URL` | The web app's `/exec` URL (you'll get it in step 6). Used for the **Open review page** button. |

Run **`previewSlackAlert`** to log the message payload without posting it.

### 6. Deploy the web app

1. Click **Deploy → New deployment**, then choose **Web app** as the type.
2. Set **Execute as: User accessing the web app** and **Who has access: Anyone within *your domain***. These match the `webapp` block in the manifest.
3. Click **Deploy**, then copy the `/exec` URL into the `REVIEW_APP_URL` script property.

Each visitor authorizes the app once, the first time they open it. Because the page runs as the visitor:

- Reading the list uses the visitor's own access to the sheet.
- Approving or denying uses the visitor's own Google Admin privileges. Non-admins see the list in view-only mode.

You can prefill the filters with URL parameters, for example `…/exec?trigger=Hard%20flag&minDevices=10`. The supported parameters are `q`, `trigger`, `minScore`, `minDevices`, and `sort`.

### 7. Share the sheet

| Who | Access | Why |
|---|---|---|
| Everyone who should see the review page (the domain or a review group) | **Viewer** | The page reads the Needs Review and Decisions tabs as the visitor. |
| Chrome admins who make decisions | **Editor** | Decisions are written to the Decisions tab as the admin. |

### 8. Schedule the daily sync

1. In the script editor, open **Triggers** (the clock icon), then click **Add Trigger**.
2. Choose the function **`dailySync`**, the event source **Time-driven**, and the type **Day timer**. Pick an off-hours window.

The trigger runs as whoever created it, so create it as the admin from step 4.

## Using the review page

Each card shows the extension's score, what triggered it, the scoring reasons, how many browser devices and ChromeOS users report it, and a Chrome Web Store link. Admins get three actions:

| Action | Effect |
|---|---|
| **Approve** | Logged to Decisions. The extension stays off the list for good. |
| **Approve, review yearly** | Logged with a review date 365 days out. It comes back as *Review due* once that date passes. |
| **Deny** | **Sets the extension to Block and uninstall at the root OU right away**, then logs the decision. It's removed from every managed browser that has it. |

To reverse a decision, change the policy in the Google Admin console and add a new row for that App ID to the Decisions tab. The latest row for an ID always wins.

Open `Review.html` directly in a browser to preview the page with sample data. No server is needed.

## Configuration

### Inventory (`InstalledExtensionsInventory.gs`)

| Setting | Default | Notes |
|---|---|---|
| `SHEET_ID` | `''` | Leave blank to use the bound sheet. Set it if the script lives outside the sheet or you see "No spreadsheet found." |
| `TAB_NAME` | `Installed Extensions` | If you rename it, update `RUBRIC.SOURCE_TAB` to match. |
| `INCLUDE_BLOCKED` | `false` | `true` keeps extensions that are already blocked at the root OU in the inventory. |
| `ROOT_OU_ID` | `''` | Auto-detected from a top-level child OU. Set it by hand if the tenant has no child OUs. |
| `BATCH_SIZE` / `BATCH_PAUSE_MS` | `25` / `1000` | Web Store lookups. Requests that hit a 429 are retried once after 10 seconds. |

### Rubric (`ExtensionRubric.gs` → `RUBRIC`)

An extension is flagged if it has **any hard flag** or a **score ≥ `THRESHOLD`** (default `7`).

**Exempt from review:** disabled extensions, `ADMIN` (force-installed) install types, publishers matching `EXEMPT_PUBLISHERS`, and any ID listed in `EXEMPT_APP_IDS`.

**Hard flags:**
- A keyword match in the name or description: `VPN`, `AI` (case-sensitive), `free`, `password`
- A theme that requests any permissions or site access
- A non–Web Store source (Android apps excepted)
- A Chrome risk assessment of `HIGH`

**Score points:**

| Signal | Points |
|---|---|
| Access to all sites | +2 |
| More than `MANY_HOSTS` (10) specific hosts | +1 |
| Access to a `SENSITIVE_HOSTS` domain | +1 |
| High-risk permissions (`HIGH_PERMS`) | +2 each, capped at 4 |
| Medium-risk permissions (`MEDIUM_PERMS`) | +1 each, capped at 2 |
| Web Store rating below 3.0 | +2 |
| Fewer than 10 reviews | +1 |
| Fewer than 500 users | +1 |
| Not updated in over 730 days | +1 |
| Updated in the last 14 days *and* has all-sites access | +1 |

### Review app (`ExtensionReview.gs` → `REVIEW`)

| Setting | Default | Notes |
|---|---|---|
| `REVIEW_PERIOD_DAYS` | `365` | How long a yearly approval lasts. |
| `SLACK_LIST_MAX` | `5` | Alerts with more new items than this show a count instead of a list. |
| `DENY_INSTALL_TYPE` | `REMOVE` | `REMOVE` blocks and uninstalls. `BLOCKED` blocks new installs only. |

## Sheet tabs

| Tab | Written by | Contents |
|---|---|---|
| Installed Extensions | `inventoryInstalledExtensions` | Every reported extension with Web Store details. Overwritten on each run. |
| Needs Review | `scoreExtensions` | Flagged extensions only, sorted by score. Overwritten on each run. |
| Decisions | The review page | An append-only log of approvals and denials. **Don't sort it or delete rows from it.** |

Each overwritten tab has a timestamp note on cell A1 from its last run.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `countInstalledApps failed` or `Policy resolve failed` with a 403 | The trigger owner is missing a Chrome Management privilege, or the API isn't enabled in the linked GCP project. |
| `No child OUs found — set ROOT_OU_ID manually.` | Set `ROOT_OU_ID` to your root OU's ID, without the `id:` prefix. |
| An admin sees **Viewer** on the page | Have them run `debugAdminCheck` from the editor, or wait a minute; a failed admin check is only cached for 60 seconds. |
| The page sits on *Loading…* or "Still waiting on the server" | Check **Executions** in the script editor for `getReviewData` errors. |
| "You don't have access to the review sheet." | Share the sheet with that person (Viewer at minimum). |
| "Couldn't write to the Decisions tab." | The admin needs Editor access to the sheet. For a Deny, the message says whether the block was still applied. |
| Many `429` errors in the Enrichment Error column | Lower `BATCH_SIZE` or raise `BATCH_PAUSE_MS`. |
| No Slack alert | Set `SLACK_WEBHOOK_URL`. Alerts only go out for App IDs that weren't flagged on the previous run. |

## Updating

After you change code, push it (or paste it in), then go to **Deploy → Manage deployments**, edit the existing deployment, and pick **New version**. This keeps the `/exec` URL the same, so `REVIEW_APP_URL` and Slack links keep working.

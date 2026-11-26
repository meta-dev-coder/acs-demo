# Gmail sending for Ask the Twin (`server/gmail/`)

Sends a generated report's email draft (with its real PDF and XLSX files attached) through the user's own Gmail
account, after the user connects Gmail and confirms the send. Nothing is ever sent automatically.

## Google Cloud setup

1. In a Google Cloud project, enable the **Gmail API**.
2. **OAuth consent screen**: add the scope `https://www.googleapis.com/auth/gmail.send` (plus `openid`, `email`).
   While the app is in *Testing*, add every Google account that will connect as a **test user**.
3. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI, exactly:
   `http://localhost:5188/api/gmail/auth/callback` (the dev server; for another host use `https://<host>/api/gmail/auth/callback`).
4. Put the values in `cesium-poc/.env.local` (git-ignored), never in the repository:

```text
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
GOOGLE_REDIRECT_URI=http://localhost:5188/api/gmail/auth/callback
GMAIL_TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>   # optional: keep connections across restarts (encrypted)
GMAIL_TEST_RECIPIENTS=you@example.com,@yourcompany.example   # optional: where demo-data reports may go
```

Restart `npm run dev`. `GET /api/gmail/status` says what is missing while it is not configured.

## Routes

| Route | |
|---|---|
| `GET /api/gmail/status` | connected, account address, can send, reconnect required (no token data) |
| `GET /api/gmail/auth/login` | starts Google sign-in (state + PKCE S256); opened in a popup by the email card |
| `GET /api/gmail/auth/callback` | checks state and the browser's `gmail_sid` cookie, exchanges the code, verifies the ID token, keeps the tokens here; tells the conversation by `postMessage` and closes |
| `POST /api/gmail/send` | `{fileName, reportId, idempotencyKey, acknowledgeIllustrative}`: sends the report's **saved** draft |
| `POST /api/gmail/disconnect` | revokes the token at Google and forgets the connection |
| `GET /api/gmail/history?file=&reportId=` | this user's attempts for a report |

## How a send works

1. The card saves the draft (To/Cc/Bcc, subject, body, attachment ids) to the report (`PUT /api/ifc-spatial/reports/ID/email`).
2. **Send Email** is enabled only when Gmail is connected, a valid address is entered, subject and body are set,
   and the selected files exist. It opens a confirmation (From, To/Cc/Bcc, subject, attachment names and count;
   for illustrative reports, a warning and an explicit acknowledgement unless an allowlist applies).
3. `POST /api/gmail/send`: the server reads the draft and the files from the report store by artifact id
   (owner = the APS session that created the report), validates recipients, the demo-data rules and size (24 MB),
   builds the MIME message with Nodemailer's composer (no SMTP), and calls
   `users.messages.send` with the base64url message.
4. Outcome: **SENT** (with the Gmail message id), **FAILED** (a clear refusal: the draft is kept and can be sent
   again) or **SEND_STATUS_UNKNOWN** (a timeout or server error after sending: not retried; the user checks Gmail
   and can explicitly start a new draft). A sent draft is locked; *New draft from this email* copies it.

Duplicates: every confirmed send carries an idempotency key; the attempt is recorded (SENDING) before the
Gmail call; the same key returns the recorded result; a draft already SENT/SENDING/UNKNOWN cannot be sent again.

## Security

- Scope is send-only; no reading, modifying or deleting mail.
- Tokens stay in this process (memory, or AES-256-GCM sealed file with `GMAIL_TOKEN_ENCRYPTION_KEY`); never in
  responses, logs, the audit file or to any model. Gmail and APS sign-ins are independent.
- A connection belongs to one browser (`gmail_sid`, HttpOnly, SameSite=Lax); sending also needs the APS session
  that owns the report, so another user's report or files cannot be attached.
- The audit (`.data/gmail/send-audit.json`, git-ignored, 90-day retention) holds sender, recipients, subject,
  attachment ids/names, report id/revision, status, Gmail id and sanitized failures — no tokens, no file contents.
- No addresses are invented: a recipient group named in the question stays a label until the user types an address.

## Manual test

1. Configure as above, `npm run dev`, open the IFC Spatial Twin, sign in to Autodesk.
2. Ask: *Prepare a report of all transformers requiring inspection and draft an email to the electrical maintenance team.*
3. In the email card: **Connect Gmail** (popup) → the account appears; enter your own (or an allowlisted test) address.
4. **Send Email** → check the dialog → (tick the demo-data box) → **Send now** → "Email sent successfully" with the Gmail id.
5. In the recipient mailbox: the PDF and XLSX attachments open.

## Google verification

`gmail.send` is a *sensitive* scope. While the consent screen is in *Testing*, only listed test users can connect
and refresh tokens expire after 7 days (reconnect when the card says so). Publishing for other users requires
Google's OAuth verification (and, for a Workspace domain, the administrator may restrict third-party apps).

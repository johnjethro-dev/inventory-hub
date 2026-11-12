# Inventory Hub

Inventory Hub is a mobile-friendly internal inventory application for a small company. It tracks consumable stock, individually identified assets, employee requests, manager approvals, issuing, loans, returns, maintenance, notifications, CSV exchange, and immutable audit history.

## Requirements and first run

- Node.js 24 or newer (the application uses Node's built-in SQLite module).
- No package installation or build step is required.

```powershell
cd C:\Users\jetag\Documents\ChatGPT\Projects\inventory-hub
npm test
npm start
```

Open `http://127.0.0.1:4174`. The initial administrator account is:

- Email: `admin@inventory.local`
- Password: `ChangeMe123!`

The administrator is required to change this password after the first sign-in. Seeded manager, custodian, and employee demonstration accounts use the same temporary password and their corresponding `@inventory.local` email shown in the user directory.

## Office deployment

Set environment variables in the service account that runs Inventory Hub:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "4174"
$env:SESSION_MINUTES = "30"
$env:TLS_CERT_PATH = "D:\InventoryHub\tls\office-server.crt"
$env:TLS_KEY_PATH = "D:\InventoryHub\tls\office-server.key"
npm start
```

Use a certificate trusted by company devices and restrict the port to the office LAN in Windows Firewall. Remote users should connect through the company VPN. Keep the application, database, backups, and TLS keys readable only by the service account. Place the project on the server's local disk; do not put the live SQLite file on a network share.

The live database defaults to `data/inventory-hub.db`. Set `INVENTORY_DB_PATH` to use a different local path.

## Email notifications

In-app notifications always work. Email messages are stored in the administrator-visible outbox. To deliver them, configure an HTTPS mail-provider webhook that accepts `{ "to", "subject", "text" }`:

```powershell
$env:EMAIL_WEBHOOK_URL = "https://mail-gateway.company.example/inventory-message"
$env:EMAIL_WEBHOOK_TOKEN = "replace-with-a-secret-from-the-service-environment"
```

The server retries queued and failed deliveries once per minute, up to five attempts. Secrets belong in the service environment or operating-system secret store, never in this repository.

## Encrypted backups and restore

Generate a backup encryption key once and retain it in the organization's password vault:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
$env:BACKUP_ENCRYPTION_KEY = "paste-the-generated-key"
$env:BACKUP_DIR = "E:\InventoryHubBackups"
node backup.js
```

Schedule `node backup.js` daily with Windows Task Scheduler under the same service account. Backups are AES-256-GCM encrypted and files older than 30 days are pruned by default. Keep `BACKUP_DIR` on a separate device; set `BACKUP_RETENTION_DAYS` to change retention.

To test recovery, stop the application and restore into a test deployment first:

```powershell
$env:INVENTORY_DB_PATH = "D:\InventoryHubTest\data\inventory-hub.db"
$env:BACKUP_ENCRYPTION_KEY = "the-original-key"
node restore.js "E:\InventoryHubBackups\inventory-....sqlite.enc" --confirm-replace
```

Restore keeps the previous database beside it with a `.before-restore` suffix. Start the application and verify users, balances, transactions, requests, assignments, and audit entries.

## CSV formats

- Consumables: `code,name,category,quantity,unit,reorder_level,unit_cost,supplier,location`
- Assets: `code,description,category,serial_number,condition,purchase_date,purchase_cost,supplier,location`
- Users: `name,email,role,temporary_password`
- Opening balances: `code,quantity`

Imports report each failed row while keeping successful rows. Exports are available to custodians and administrators from the interface.

## Security notes

Passwords use Node's scrypt implementation with per-password random salts. Session identifiers are random and stored only as SHA-256 hashes; sessions expire after 12 hours and after the configured inactivity interval. Mutations require a same-origin custom header, cookies use `HttpOnly` and `SameSite=Strict`, and production cookies become `Secure` when TLS is configured. Login attempts are rate limited in memory. A strict content security policy, role checks, input limits, database constraints, and append-only application audit records provide additional protection.

Before production use, remove or rename demonstration accounts, configure real managers and backup approvers, test HTTPS from every company device, configure outbound email, run a backup-and-restore drill, and complete the planned pilot with a custodian, two managers, and five employees.

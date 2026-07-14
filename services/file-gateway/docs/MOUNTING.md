# Mounting the Grid drive (macOS / Windows)

The Grid drive is a WebDAV share served by the file-gateway. You sign in with a
**device credential** created in the Grid web app — that's where SSO happens,
because native mount dialogs can't open your identity provider. Every file you
then see or touch is authorized live against your Grid project roles, so your
drive always matches what the web app would let you do. (Design: ADR-0025.)

## 1. Create a device credential (once per device)

1. Sign in to Grid (your normal SSO login).
2. Profile → **Network drive** → **Connect a device**.
3. Name the device ("Work MacBook") and copy the **username** and the
   **drive password** (`gdk_…`). The password is shown **once** — if you lose
   it, revoke the device and create a new one.

Credentials expire (default 90 days — then you repeat this step, which re-runs
SSO) and can be revoked anytime from the same card. Losing your project role or
org membership cuts off a mounted drive immediately, credential or not.

## 2. Mount

**macOS (Finder):**
1. Finder → Go → **Connect to Server** (⌘K).
2. Enter the drive URL, e.g. `https://drive.<your-grid-host>/`.
3. Enter the username + drive password; check "Remember this password in my
   keychain".

**Windows (Explorer):**
1. This PC → **Map network drive**.
2. Folder: `https://drive.<your-grid-host>/` — check **Connect using different
   credentials**.
3. Enter the username + drive password; check "Remember my credentials".

You'll land in `org/<your-org>/project/…` — only projects you can view are
listed, and only editors can write.

## Windows notes

- The **WebClient** service must be running (it is by default on desktop SKUs).
- Windows refuses Basic auth over plain `http://` — correct and intended; the
  drive is HTTPS-only.
- Files larger than **50 MB** hit a WebClient default; raise
  `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\FileSizeLimitInBytes`
  via GPO on managed fleets.
- Very large transfers are faster in the web app; WebDAV's protocol overhead is
  real.

## Ops invariants

- The WebDAV front runs with `GATEWAY_WEBDAV_IDENTITY=basic` outside dev
  (config-enforced) and **must** sit behind TLS at the ingress.
- `GATEWAY_BFF_MOUNT_AUTH_URL` points at the BFF's `/api/internal/mount-auth`.
- NFS remains a separate, isolated-network/dev front (no credential transport);
  SMB/Kerberos is the documented future for zero-prompt managed-Windows fleets.

---
name: add-wecom
description: Add WeCom (WeChat Work) as a channel. Uses HTTP callback for inbound messages and WeCom REST API for replies. Requires Cloudflare Tunnel or reverse proxy for HTTPS.
---

# Add WeCom Channel

This skill adds WeCom (WeChat Work) bot support to NanoClaw. The bot receives messages via an HTTP callback endpoint and replies asynchronously via the WeCom API.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `wecom` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have your WeCom credentials ready? You need:
- Corp ID (企业ID)
- App Secret (应用Secret)
- Agent ID (应用ID)
- Callback Token
- Callback EncodingAESKey

If they have them, collect now. If not, guide them to the WeCom admin console.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-wecom
```

This deterministically:
- Adds `src/channels/wecom.ts` (WeComChannel class with HTTP callback server)
- Adds `src/channels/wecom.test.ts` (18 unit tests)
- Adds `src/wecom-crypto.ts` (AES-256-CBC encryption/decryption, signature verification)
- Appends `import './wecom.js'` to `src/channels/index.ts`
- Updates `.env.example` with WeCom env vars
- Records the application in `.nanoclaw/state.yaml`

No npm dependencies are added -- WeCom uses only Node.js built-in modules (`crypto`, `http`, `url`).

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md`

### Validate code changes

```bash
npm test
npm run build
```

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
WECOM_CORPID=<corp-id>
WECOM_CORPSECRET=<app-secret>
WECOM_AGENTID=<agent-id>
WECOM_TOKEN=<callback-token>
WECOM_ENCODING_AES_KEY=<encoding-aes-key>
WECOM_PORT=9800
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Set up HTTPS (Cloudflare Tunnel)

WeCom requires HTTPS for the callback URL. If using Cloudflare Tunnel:

1. Add a CNAME record in Cloudflare DNS:
   - Name: `wecom` (or your preferred subdomain)
   - Target: `<tunnel-id>.cfargotunnel.com`
   - Proxy: ON

2. Add an ingress rule to `~/.cloudflared/config.yml`:
   ```yaml
   ingress:
     - hostname: wecom.yourdomain.com
       service: http://localhost:9800
     # ... existing rules ...
     - service: http_status:404
   ```

3. Restart the tunnel:
   ```bash
   systemctl --user restart cloudflared
   ```

If using nginx instead, configure a reverse proxy from port 443 to localhost:9800 with SSL.

### Configure WeCom Admin Console

1. Go to WeCom admin console > Application Management > select your app
2. Set callback configuration (接收消息设置):
   - URL: `https://wecom.yourdomain.com/wecom/callback`
   - Token: same as `WECOM_TOKEN` in `.env`
   - EncodingAESKey: same as `WECOM_ENCODING_AES_KEY` in `.env`
3. Click Save -- WeCom will send a verification request; the server must be running to respond

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get User ID

WeCom uses internal user IDs (not numeric chat IDs). The JID format is `wecom:<userid>`.

When a user sends a message to the bot, the chat will appear in NanoClaw logs:

```bash
tail -f logs/nanoclaw.log | grep -i wecom
```

Look for: `WeCom: message from unregistered chat { chatJid: 'wecom:zhangsan' }`

### Register the chat

For a main chat (responds to all messages):

```typescript
registerGroup("wecom:<userid>", {
  name: "<display-name>",
  folder: "wecom_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("wecom:<userid>", {
  name: "<display-name>",
  folder: "wecom_<name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Send a message to the bot in WeCom. The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Callback verification fails

Check:
1. NanoClaw is running: `systemctl --user status nanoclaw`
2. Port 9800 is listening: `ss -tlnp | grep 9800`
3. Cloudflare Tunnel is routing correctly: `curl -s https://wecom.yourdomain.com/wecom/callback` (should return 404, not connection refused)
4. Token and EncodingAESKey in `.env` match what's configured in WeCom admin console

### Bot not responding

Check:
1. All WECOM_* vars are set in `.env` AND synced to `data/env/env`
2. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'wecom:%'"`
3. Access token is working: check logs for `WeCom: access token refresh` errors
4. For non-main chats: message includes trigger pattern

### Message encryption errors

Check:
1. `WECOM_ENCODING_AES_KEY` is exactly 43 characters (a-z, A-Z, 0-9)
2. `WECOM_CORPID` matches the corp ID used when setting up the callback

## Removal

To remove WeCom integration:

1. Delete `src/channels/wecom.ts`, `src/channels/wecom.test.ts`, `src/wecom-crypto.ts`, `src/wecom-crypto.test.ts`
2. Remove `import './wecom.js'` from `src/channels/index.ts`
3. Remove `WECOM_*` vars from `.env`
4. Remove WeCom registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'wecom:%'"`
5. Remove Cloudflare Tunnel ingress rule and DNS record
6. Rebuild: `npm run build && systemctl --user restart nanoclaw`

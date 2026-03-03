#!/usr/bin/env npx tsx
/**
 * Google Calendar OAuth2 authentication script.
 *
 * Usage:
 *   1. Enable the Google Calendar API in GCP console
 *   2. Create OAuth2 credentials (Desktop app) and download the JSON
 *   3. Save it as ~/.google-calendar/gcp-oauth.keys.json
 *   4. Run: npx tsx scripts/gcal-auth.ts
 *   5. Tokens are saved to ~/.google-calendar/credentials.json
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}`;

const credDir = path.join(os.homedir(), '.google-calendar');
const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
const tokensPath = path.join(credDir, 'credentials.json');

if (!fs.existsSync(keysPath)) {
  console.error(
    `Error: ${keysPath} not found.\n\n` +
      'Steps:\n' +
      '  1. Go to https://console.cloud.google.com/apis/credentials\n' +
      '  2. Create OAuth 2.0 Client ID (Desktop app)\n' +
      '  3. Download the JSON and save it as:\n' +
      `     ${keysPath}\n` +
      '  4. Re-run this script.',
  );
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const clientConfig = keys.installed || keys.web || keys;
const { client_id, client_secret } = clientConfig;

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  REDIRECT_URI,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('Opening browser for Google Calendar authorization...\n');

// Open browser (cross-platform)
try {
  const platform = process.platform;
  if (platform === 'darwin') {
    execSync(`open "${authUrl}"`);
  } else if (platform === 'linux') {
    execSync(`xdg-open "${authUrl}"`);
  } else {
    execSync(`start "${authUrl}"`);
  }
} catch {
  console.log('Could not open browser automatically. Please visit:\n');
  console.log(authUrl);
  console.log();
}

console.log(`Waiting for OAuth callback on http://localhost:${PORT}...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h1>Error: No authorization code received</h1>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<h1>Google Calendar authorized!</h1><p>You can close this window.</p>',
    );

    console.log(`Tokens saved to ${tokensPath}`);
    console.log('\nGoogle Calendar channel is ready. Restart NanoClaw to activate.');

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error exchanging code</h1><pre>${err}</pre>`);
    console.error('Failed to exchange authorization code:', err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);

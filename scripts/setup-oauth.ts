/**
 * One-time OAuth setup for Gmail API
 *
 * 1. Create a Google Cloud project
 * 2. Enable Gmail API
 * 3. Create OAuth 2.0 credentials (Desktop app)
 * 4. Download credentials and set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env
 * 5. Run this script: npm run setup:oauth
 * 6. Copy the refresh token to .env as GMAIL_REFRESH_TOKEN
 */

import http from 'node:http';
import { URL } from 'node:url';
import { getAuthUrl, getTokensFromCode } from '../src/gmail/auth.js';

const PORT = 3000;

async function main() {
  console.log('\n=== Gmail OAuth Setup ===\n');

  // Check for required env vars
  if (!process.env['GMAIL_CLIENT_ID'] || !process.env['GMAIL_CLIENT_SECRET']) {
    console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
    console.log('\nSteps:');
    console.log('1. Go to https://console.cloud.google.com/');
    console.log('2. Create a project and enable Gmail API');
    console.log('3. Create OAuth 2.0 credentials (Desktop app type)');
    console.log('4. Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to your .env file');
    console.log('5. Run this script again\n');
    process.exit(1);
  }

  const authUrl = getAuthUrl();

  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in and authorize the application');
  console.log('3. You will be redirected to localhost:3000\n');

  // Start local server to receive OAuth callback
  const server = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/oauth2callback')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400);
      res.end('Missing authorization code');
      return;
    }

    try {
      console.log('Exchanging code for tokens...');
      const tokens = await getTokensFromCode(code);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Success!</h1>
            <p>You can close this window and return to the terminal.</p>
          </body>
        </html>
      `);

      console.log('\n=== Success! ===\n');
      console.log('Add this to your .env file:\n');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);

      server.close();
      process.exit(0);
    } catch (err) {
      console.error('Error exchanging code:', err);
      res.writeHead(500);
      res.end('Failed to exchange code for tokens');
    }
  });

  server.listen(PORT, () => {
    console.log(`Waiting for OAuth callback on http://localhost:${PORT}...\n`);
  });
}

main().catch(console.error);

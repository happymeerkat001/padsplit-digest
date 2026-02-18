import { google, Auth } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let oauth2Client: Auth.OAuth2Client | null = null;

export function getOAuth2Client() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
      'http://localhost:3000/oauth2callback'
    );

    if (config.gmail.refreshToken) {
      oauth2Client.setCredentials({
        refresh_token: config.gmail.refreshToken,
      });
    }
  }

  return oauth2Client;
}

export async function getAccessToken(): Promise<string> {
  const client = getOAuth2Client();

  try {
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error('Failed to get access token');
    }
    return token;
  } catch (err) {
    logger.error('OAuth token refresh failed', { error: String(err) });
    throw err;
  }
}

export function getGmailClient() {
  return google.gmail({ version: 'v1', auth: getOAuth2Client() });
}

// Generate auth URL for initial setup
export function getAuthUrl(): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    prompt: 'consent', // Force to get refresh token
  });
}

// Exchange auth code for tokens
export async function getTokensFromCode(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  return tokens;
}

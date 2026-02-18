import { getGmailClient } from './auth.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
}

// Create raw email in RFC 2822 format
function createRawEmail(options: SendEmailOptions): string {
  const { to, subject, body } = options;

  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n');

  // Base64url encode
  return Buffer.from(email)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Send email via Gmail API
export async function sendEmail(options: SendEmailOptions): Promise<string | null> {
  if (process.env['NODE_ENV'] === 'test') {
    logger.warn('Email send skipped in test mode', { to: options.to, subject: options.subject });
    return null;
  }

  const gmail = getGmailClient();

  try {
    const raw = createRawEmail(options);

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
      },
    });

    const messageId = response.data.id ?? null;

    logger.info('Email sent', {
      to: options.to,
      subject: options.subject,
      messageId,
    });

    return messageId;
  } catch (err) {
    logger.error('Failed to send email', {
      to: options.to,
      error: String(err),
    });
    throw err;
  }
}

// Send digest email
export async function sendDigestEmail(subject: string, body: string): Promise<string | null> {
  if (!config.runtime.enableEmailSending) {
    logger.warn('Digest email sending disabled (ENABLE_EMAIL_SENDING=false)');
    return null;
  }

  const recipient = config.gmail.digestRecipient;

  if (!recipient) {
    logger.error('No digest recipient configured');
    return null;
  }

  return sendEmail({
    to: recipient,
    subject,
    body,
  });
}

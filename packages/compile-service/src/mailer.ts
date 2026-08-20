/**
 * Sending mail.
 *
 * Three transports behind one interface, because the credentials arrive later than the feature
 * does and the gap should not be a hole in the code:
 *
 *   - `smtp` is the real one, and is used the moment a host is configured.
 *   - `console` prints the link to the log. Not a stub -- it is what makes local development work
 *     without a mail account, and it is the reason someone can register and click through the
 *     whole flow on a laptop.
 *   - `capture` keeps messages in memory, which is what the tests assert against. Testing that a
 *     verification mail was sent by reading a log line would be testing the log format.
 *
 * Nothing here throws into a request. A signup that fails because the mail server is briefly down
 * should still create the account and say "we could not send that, try resend" rather than 500 and
 * leave the person wondering whether they have an account at all.
 */
import { createTransport, type Transporter } from 'nodemailer';

export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  readonly kind: 'smtp' | 'console' | 'capture';
  /** True when this can actually reach a mailbox. False for `console`. */
  readonly deliversToInbox: boolean;
  send(message: Message): Promise<boolean>;
  /** Only meaningful for `capture`. */
  readonly sent?: Message[];
  close?(): Promise<void>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
  readonly from: string;
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport: Transporter = createTransport({
    host: config.host,
    port: config.port,
    // Implicit TLS on 465; STARTTLS elsewhere. `requireTLS` rather than leaving it optional,
    // because a server that silently declines to upgrade would send credentials in the clear.
    secure: config.secure,
    requireTLS: !config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    // A slow mail server must not become a slow signup.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 3,
  });

  return {
    kind: 'smtp',
    deliversToInbox: true,
    async send(message) {
      try {
        await transport.sendMail({ from: config.from, ...message });
        return true;
      } catch (error) {
        console.error('[mail] send failed', (error as Error).message);
        return false;
      }
    },
    async close() {
      transport.close();
    },
  };
}

/**
 * Prints instead of sending.
 *
 * The link is printed on its own line and nothing else is, so it can be clicked straight out of a
 * terminal or a `docker compose logs`. That is the whole point: without a mail account, this is
 * how the flow is exercised.
 */
export function createConsoleMailer(): Mailer {
  return {
    kind: 'console',
    deliversToInbox: false,
    async send(message) {
      const link = /https?:\/\/\S+/.exec(message.text)?.[0];
      console.info(
        `\n[mail] to ${message.to} -- ${message.subject}\n` +
          (link ? `[mail] ${link}\n` : `${message.text}\n`),
      );
      return true;
    },
  };
}

export function createCaptureMailer(): Mailer {
  const sent: Message[] = [];
  return {
    kind: 'capture',
    deliversToInbox: true,
    sent,
    async send(message) {
      sent.push(message);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * The messages themselves.
 *
 * Plain text alongside the HTML, always. A mail client that shows only the text part is not
 * unusual, and a verification mail that arrives blank is indistinguishable from one that never
 * arrived.
 *
 * No images, no tracking, no external stylesheet: a link and a sentence saying what it does.
 * Anything else raises the odds of landing in a spam folder, which for a verification mail is the
 * same as not sending it.
 */
function shell(heading: string, body: string, action: { url: string; label: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1d21">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:28px">
    <h1 style="margin:0 0 4px;font-size:18px">robo-journey</h1>
    <p style="margin:0 0 20px;color:#6b7280;font-size:13px">${heading}</p>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.5">${body}</p>
    <a href="${action.url}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">${action.label}</a>
    <p style="margin:20px 0 0;color:#6b7280;font-size:12px;line-height:1.5">
      If the button does not work, paste this into your browser:<br>
      <span style="word-break:break-all">${action.url}</span>
    </p>
  </div>
</body></html>`;
}

export function verificationMessage(to: string, url: string): Message {
  return {
    to,
    subject: 'Confirm your robo-journey address',
    text:
      `Confirm your address to start using robo-journey.\n\n${url}\n\n` +
      `The link works for 24 hours. If you did not create an account, ignore this ` +
      `-- nothing was set up under your address.\n`,
    html: shell(
      'Confirm your address',
      'One click and you can start building. The link works for 24 hours.',
      { url, label: 'Confirm my address' },
    ),
  };
}

export function passwordResetMessage(to: string, url: string): Message {
  return {
    to,
    subject: 'Reset your robo-journey password',
    text:
      `Someone asked to reset the password for this address.\n\n${url}\n\n` +
      `The link works for one hour and can be used once. If it was not you, ignore this ` +
      `-- your password has not changed.\n`,
    html: shell(
      'Reset your password',
      'Someone asked to reset the password for this address. The link works for one hour and ' +
        'can be used once. If it was not you, nothing has changed.',
      { url, label: 'Choose a new password' },
    ),
  };
}

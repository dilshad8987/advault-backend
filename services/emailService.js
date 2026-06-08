const axios = require('axios');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

async function sendOtpEmail(toEmail, toName, otp) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#6c47ff;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">🔍 AdVault</h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 8px;color:#1a1a2e;font-size:18px;font-weight:600;">Verify your email</p>
            <p style="margin:0 0 28px;color:#6b7280;font-size:14px;line-height:1.6;">
              Hi ${toName}, use the code below to verify your AdVault account.
            </p>

            <!-- OTP Box -->
            <div style="background:#f9f7ff;border:2px dashed #6c47ff;border-radius:10px;padding:24px;text-align:center;margin-bottom:28px;">
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Verification Code</p>
              <p style="margin:0;color:#6c47ff;font-size:40px;font-weight:700;letter-spacing:10px;">${otp}</p>
            </div>

            <p style="margin:0 0 6px;color:#9ca3af;font-size:13px;text-align:center;">⏱ This code expires in <strong>10 minutes</strong>.</p>
            <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">If you didn't create an account, ignore this email.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9f7ff;padding:20px 40px;text-align:center;border-top:1px solid #ede9fe;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">© 2026 AdVault. All rights reserved.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await axios.post(
    BREVO_API_URL,
    {
      sender:  { name: 'AdVault', email: process.env.BREVO_SENDER_EMAIL },
      to:      [{ email: toEmail, name: toName }],
      subject: 'Your AdVault verification code',
      htmlContent: html,
    },
    {
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
}

module.exports = { sendOtpEmail };

async function sendResetEmail(toEmail, toName, resetLink) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#6c47ff;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">🔍 AdVault</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 8px;color:#1a1a2e;font-size:18px;font-weight:600;">Reset your password</p>
            <p style="margin:0 0 28px;color:#6b7280;font-size:14px;line-height:1.6;">
              Hi ${toName}, click the button below to reset your AdVault password.
            </p>
            <div style="text-align:center;margin-bottom:28px;">
              <a href="${resetLink}"
                style="display:inline-block;padding:14px 32px;background:#6c47ff;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
                Reset Password
              </a>
            </div>
            <p style="margin:0 0 6px;color:#9ca3af;font-size:13px;text-align:center;">⏱ This link expires in <strong>10 minutes</strong>.</p>
            <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">If you didn't request this, ignore this email.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9f7ff;padding:20px 40px;text-align:center;border-top:1px solid #ede9fe;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">© 2026 AdVault. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await axios.post(
    BREVO_API_URL,
    {
      sender:      { name: 'AdVault', email: process.env.BREVO_SENDER_EMAIL },
      to:          [{ email: toEmail, name: toName }],
      subject:     'Reset your AdVault password',
      htmlContent: html,
    },
    {
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
}

async function sendLoginAlertEmail(toEmail, toName, { ua, ip, loginTime }) {
  const changePasswordUrl = `${process.env.FRONTEND_URL}/profile`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#6c47ff;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">🔍 AdVault</h1>
          </td>
        </tr>

        <!-- Alert Banner -->
        <tr>
          <td style="background:#fff8e1;padding:16px 40px;border-bottom:2px solid #ffc107;">
            <p style="margin:0;color:#856404;font-size:14px;font-weight:600;">⚠️ New device login detected</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 8px;color:#1a1a2e;font-size:18px;font-weight:600;">Hi ${toName},</p>
            <p style="margin:0 0 24px;color:#6b7280;font-size:14px;line-height:1.6;">
              Your AdVault account was just accessed from a new device. Here are the details:
            </p>

            <!-- Details Table -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f7ff;border-radius:8px;overflow:hidden;margin-bottom:28px;">
              <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #ede9fe;">
                  <span style="color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Browser / Device</span><br>
                  <span style="color:#1a1a2e;font-size:13px;word-break:break-all;">${ua}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #ede9fe;">
                  <span style="color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">IP Address</span><br>
                  <span style="color:#1a1a2e;font-size:13px;">${ip}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:12px 16px;">
                  <span style="color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Time</span><br>
                  <span style="color:#1a1a2e;font-size:13px;">${loginTime}</span>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 20px;color:#6b7280;font-size:14px;line-height:1.6;">
              <strong>Aap the?</strong> Toh koi action lene ki zarurat nahi.<br>
              <strong>Aap nahi the?</strong> Apna password turant change karo:
            </p>

            <div style="text-align:center;">
              <a href="${changePasswordUrl}"
                style="display:inline-block;padding:14px 32px;background:#e53e3e;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
                🔒 Change Password Now
              </a>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9f7ff;padding:20px 40px;text-align:center;border-top:1px solid #ede9fe;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">© 2026 AdVault. All rights reserved.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await axios.post(
    BREVO_API_URL,
    {
      sender:      { name: 'AdVault Security', email: process.env.BREVO_SENDER_EMAIL },
      to:          [{ email: toEmail, name: toName }],
      subject:     '⚠️ New device login — AdVault',
      htmlContent: html,
    },
    {
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
}

module.exports = { sendOtpEmail, sendResetEmail, sendLoginAlertEmail };

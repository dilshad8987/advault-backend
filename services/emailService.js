const axios = require('axios');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

async function sendBrevoEmail(to, toName, subject, html) {
  await axios.post(
    BREVO_API_URL,
    {
      sender:      { name: 'AdVault', email: process.env.BREVO_SENDER_EMAIL },
      to:          [{ email: to, name: toName }],
      subject,
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

// ─── OTP Email ────────────────────────────────────────────────────────────────
async function sendOtpEmail(toEmail, toName, otp) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:#6c47ff;padding:32px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;">🔍 AdVault</h1>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 8px;color:#1a1a2e;font-size:18px;font-weight:600;">Verify your email</p>
          <p style="margin:0 0 28px;color:#6b7280;font-size:14px;">Hi ${toName}, use the code below to verify your AdVault account.</p>
          <div style="background:#f9f7ff;border:2px dashed #6c47ff;border-radius:10px;padding:24px;text-align:center;margin-bottom:28px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Verification Code</p>
            <p style="margin:0;color:#6c47ff;font-size:40px;font-weight:700;letter-spacing:10px;">${otp}</p>
          </div>
          <p style="margin:0 0 6px;color:#9ca3af;font-size:13px;text-align:center;">⏱ Expires in <strong>10 minutes</strong>.</p>
          <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">If you didn't create an account, ignore this email.</p>
        </td></tr>
        <tr><td style="background:#f9f7ff;padding:20px 40px;text-align:center;border-top:1px solid #ede9fe;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">© 2026 AdVault. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  await sendBrevoEmail(toEmail, toName, 'Your AdVault verification code', html);
}

// ─── Reset Password Email ─────────────────────────────────────────────────────
async function sendResetEmail(toEmail, toName, resetLink) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:#6c47ff;padding:32px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;">🔍 AdVault</h1>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 8px;color:#1a1a2e;font-size:18px;font-weight:600;">Reset your password</p>
          <p style="margin:0 0 28px;color:#6b7280;font-size:14px;">Hi ${toName}, click the button below to reset your AdVault password.</p>
          <div style="text-align:center;margin-bottom:28px;">
            <a href="${resetLink}" style="display:inline-block;padding:14px 32px;background:#6c47ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Reset Password</a>
          </div>
          <p style="margin:0 0 6px;color:#9ca3af;font-size:13px;text-align:center;">⏱ Expires in <strong>10 minutes</strong>.</p>
          <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">If you didn't request this, ignore this email.</p>
        </td></tr>
        <tr><td style="background:#f9f7ff;padding:20px 40px;text-align:center;border-top:1px solid #ede9fe;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">© 2026 AdVault. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  await sendBrevoEmail(toEmail, toName, 'Reset your AdVault password', html);
}

// ─── Suspicious Login Alert Email ─────────────────────────────────────────────
async function sendLoginAlertEmail(toEmail, toName, { time, browser, os, ip }) {
  const changeLink = `${process.env.FRONTEND_URL}/forgot-password`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:#e53e3e;padding:32px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;">🔍 AdVault</h1>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 8px;color:#1a1a2e;font-size:18px;font-weight:600;">⚠️ New device login detected</p>
          <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Hi ${toName}, your account was accessed from a new device.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8f8;border:1px solid #fed7d7;border-radius:8px;padding:20px;margin-bottom:28px;">
            <tr><td style="padding:6px 0;color:#4a5568;font-size:14px;"><strong>Time:</strong> ${time}</td></tr>
            <tr><td style="padding:6px 0;color:#4a5568;font-size:14px;"><strong>Browser:</strong> ${browser}</td></tr>
            <tr><td style="padding:6px 0;color:#4a5568;font-size:14px;"><strong>OS:</strong> ${os}</td></tr>
            <tr><td style="padding:6px 0;color:#4a5568;font-size:14px;"><strong>IP:</strong> ${ip}</td></tr>
          </table>
          <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">If this was you, no action needed. If not, secure your account immediately.</p>
          <div style="text-align:center;">
            <a href="${changeLink}" style="display:inline-block;padding:14px 32px;background:#e53e3e;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Change Password</a>
          </div>
        </td></tr>
        <tr><td style="background:#fff5f5;padding:20px 40px;text-align:center;border-top:1px solid #fed7d7;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">© 2026 AdVault. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  await sendBrevoEmail(toEmail, toName, '⚠️ New device login — AdVault', html);
}

module.exports = { sendOtpEmail, sendResetEmail, sendLoginAlertEmail };

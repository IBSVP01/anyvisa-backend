// email.js
// Sends real email via Resend (https://resend.com) if RESEND_API_KEY is set.
// No SDK needed — Resend's API is a single POST request.
//
// If RESEND_API_KEY isn't set, this falls back to logging the email content
// to the console instead of failing, so the rest of the app keeps working
// during local development.

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "AnyVisa <onboarding@resend.dev>";

  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY not set — would have sent to ${to}:`);
    console.log(`[email] Subject: ${subject}`);
    console.log(`[email] ${html.replace(/<[^>]+>/g, " ").trim()}`);
    return { sent: false, reason: "not_configured" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[email] Resend API returned ${response.status}: ${text.slice(0, 300)}`);
    return { sent: false, reason: "provider_error" };
  }
  return { sent: true };
}

function resetCodeEmail(code) {
  return {
    subject: "Your AnyVisa verification code",
    html:
      `<p>Your verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`
  };
}

module.exports = { sendEmail, resetCodeEmail };

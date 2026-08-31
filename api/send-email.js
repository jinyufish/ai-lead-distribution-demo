// Vercel serverless SMTP relay.
//
//   Supabase Edge Function (the brain)  ──►  THIS function  ──►  Outlook/Office365 SMTP
//
// Stateless: only sends email. Auth via shared secret (RELAY_SECRET) that
// must match the Supabase secret EMAIL_RELAY_SECRET. Env vars are set on
// Vercel (Project → Settings → Environment Variables), NOT committed.
//
// This replaces the local Express relay (server.js) + cloudflared tunnel.
const nodemailer = require("nodemailer");

// Reused across warm invocations.
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587", 10),
  secure: false,             // STARTTLS on 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { ciphers: "SSLv3" }, // required for Office365 STARTTLS in nodemailer
});

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "smtp-relay" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  // Shared-secret auth — this endpoint is public, must not be an open relay.
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.RELAY_SECRET || token !== process.env.RELAY_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const { to, cc, subject, body, fromName } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ ok: false, error: "to, subject and body are required" });
  }

  const ccList = (cc || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  try {
    const info = await mailer.sendMail({
      from: `"${fromName || process.env.SENDER_NAME || "Lead Distribution System"}" <${process.env.SMTP_USER}>`,
      to,
      cc: ccList,
      subject,
      text: body,
    });
    return res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
};

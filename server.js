// ─────────────────────────────────────────────────────────────
// SMTP Relay for the Lead Distribution system.
//
// Architecture:
//   Frontend / AI Workflow  ──►  Supabase Edge Function (the "brain":
//                                dedup, AE assignment, status, stats)
//                                    │  can't open SMTP sockets in Deno
//                                    ▼
//                                THIS relay  ──►  Outlook / Office365 SMTP
//
// This process is stateless: it only sends email. It has no Supabase
// access and no business logic. The Edge Function owns all of that and
// updates `status`/`sent_at` itself based on this relay's response.
// ─────────────────────────────────────────────────────────────
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ── Mailer (proven config from test-email.js) ─────────────
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10),
  secure: false,             // STARTTLS on 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { ciphers: "SSLv3" }, // required for Office365 STARTTLS in nodemailer
});

// Verify SMTP credentials once at boot so failures surface immediately.
mailer.verify()
  .then(() => console.log("✓ SMTP connection verified:", process.env.SMTP_USER))
  .catch((e) => console.error("✗ SMTP verify FAILED:", e.message));

// ── Shared-secret auth ────────────────────────────────────
// This relay is publicly reachable (ngrok / deploy), so it must NOT be an
// open mail relay. Every send must present the shared secret that only the
// Edge Function knows (Supabase secret EMAIL_RELAY_SECRET === our RELAY_SECRET).
const RELAY_SECRET = process.env.RELAY_SECRET;
if (!RELAY_SECRET) {
  console.error("✗ RELAY_SECRET is not set in .env — refusing to start.");
  process.exit(1);
}

function requireSecret(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== RELAY_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ── Routes ────────────────────────────────────────────────

// Health check (unauthenticated) — used to confirm the tunnel is up.
app.get("/health", (_req, res) => res.json({ ok: true, service: "smtp-relay" }));

// POST /send-email
// Body: { to, cc?, subject, body, fromName? }
// Returns: { ok: true, messageId } | { ok: false, error }
app.post("/send-email", requireSecret, async (req, res) => {
  const { to, cc, subject, body, fromName } = req.body || {};

  if (!to || !subject || !body) {
    return res.status(400).json({ ok: false, error: "to, subject and body are required" });
  }

  const ccList = (cc || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const display = fromName || process.env.SENDER_NAME || "Lead Distribution System";

  try {
    const info = await mailer.sendMail({
      from: `"${display}" <${process.env.SMTP_USER}>`,
      to,
      cc: ccList,
      subject,
      text: body,
    });
    console.log(`✓ sent "${subject}" → ${to} (${info.messageId})`);
    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error(`✗ send failed → ${to}:`, e.message);
    return res.status(502).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✓ SMTP relay listening on :${PORT}`));

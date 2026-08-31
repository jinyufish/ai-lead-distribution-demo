import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Parse route: /lead-distribution/leads, /lead-distribution/aes, etc.
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // parts = ["lead-distribution", "leads"] or ["lead-distribution", "leads", "123", "approve"]
  const route = parts[1] || "";
  const id = parts[2] || "";
  const action = parts[3] || "";
  console.log("PATHNAME:", url.pathname, "PARTS:", JSON.stringify(parts), "ROUTE:", route);

  try {
    // ── GET /lead-distribution/health ────────────────────
    if (route === "health") {
      return json({ ok: true });
    }

    // ── GET /lead-distribution/aes ───────────────────────
    if (route === "aes" && req.method === "GET") {
      const dateParam = url.searchParams.get("date");
      const from = url.searchParams.get("from") || dateParam || todayUTC();
      const to = url.searchParams.get("to") || dateParam || todayUTC();
      return json(await getAEStats(supabase, from, to));
    }

    // ── GET /lead-distribution/leads ─────────────────────
    if (route === "leads" && req.method === "GET") {
      const submittedBy = url.searchParams.get("submitted_by");
      const dateParam   = url.searchParams.get("date");
      const from        = url.searchParams.get("from");
      const to          = url.searchParams.get("to");
      let query = supabase
        .from("AE Lead Distribution Record")
        .select("*")
        .order("created_at", { ascending: false });

      if (submittedBy) query = query.eq("submitted_by", submittedBy);

      // Admin can request a date range (from..to) for duration reporting.
      // Otherwise scope by a single day when a date is given, or when there's
      // no submitter filter (admin default = today). A submitter filter with
      // no date returns all-time (capped at 100).
      if (from && to) {
        query = query
          .gte("created_at", from + "T00:00:00.000Z")
          .lte("created_at", to + "T23:59:59.999Z");
      } else if (dateParam || !submittedBy) {
        const day = dateParam || todayUTC();
        query = query
          .gte("created_at", day + "T00:00:00.000Z")
          .lte("created_at", day + "T23:59:59.999Z");
      } else {
        query = query.limit(100);
      }

      const { data, error } = await query;
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    // ── POST /lead-distribution/leads ────────────────────
    // AI workflow calls this when a lead is processed
    if (route === "leads" && req.method === "POST" && !id) {
      const body = await req.json();
      return json(await createLead(supabase, body));
    }

    // ── POST /lead-distribution/dify-run ─────────────────
    // Server-side proxy for the browser → AI workflow call.
    // The browser can't call the AI endpoint directly (mixed content / CORS
    // from file:// or hosted HTTPS), so the frontend hits this endpoint and
    // we forward server-side.
    // NOTE: Do not rename to `/submit` — Cloudflare (in front of Supabase
    // Edge Functions) returns 405 for POST /submit before it reaches us.
    if (route === "dify-run" && req.method === "POST") {
      const body = await req.json();
      return await proxyDifySubmit(supabase, body);
    }

    // ── PATCH /lead-distribution/leads/:id ───────────────
    // Edit the email fields (subject, body, cc, to) before sending.
    if (route === "leads" && id && !action && req.method === "PATCH") {
      const body = await req.json();
      const allowed = ["email_subject", "email_body", "cc", "assigned_ae_email"];
      const update: Record<string, any> = {};
      for (const k of allowed) if (k in body) update[k] = body[k];
      if (Object.keys(update).length === 0) return json({ error: "no editable fields provided" }, 400);
      const { data, error } = await supabase
        .from("AE Lead Distribution Record")
        .update(update)
        .eq("id", parseInt(id))
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    // ── POST /lead-distribution/leads/:id/approve ────────
    if (route === "leads" && action === "approve" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return json(await approveLead(supabase, parseInt(id), body?.reviewed_by));
    }

    // ── POST /lead-distribution/leads/:id/disapprove ─────
    if (route === "leads" && action === "disapprove" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return json(await disapproveLead(supabase, parseInt(id), body?.reviewed_by));
    }

    // ── POST /lead-distribution/leads/:id/reverse ────────
    if (route === "leads" && action === "reverse" && req.method === "POST") {
      return json(await reverseLead(supabase, parseInt(id)));
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: String(e), message: e?.message, stack: e?.stack }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// The AI workflow emits mixed tenses ("approve"/"approved",
// "disapprove"/"disapproved"). Collapse to a single canonical set so the
// UI and statusMap agree.
function normalizeDecision(raw: any): string {
  const s = String(raw || "").toLowerCase().trim();
  if (s === "approve" || s === "approved") return "approve";
  if (s === "disapprove" || s === "disapproved" || s === "reject" || s === "rejected") return "disapprove";
  if (s === "manual_review" || s === "review" || s === "manual") return "manual_review";
  return s;
}

// Pull the contact name and phone out of raw_lead_msg for dedup. Phone is
// normalized to the last 10 digits so different formats (with/without
// country code, parens, dashes) collapse to the same key.
function extractContactAndPhone(raw: string): { name: string; phone: string } {
  if (!raw) return { name: "", phone: "" };
  const nameMatch = raw.match(/^Contact(?:\s+name)?:\s*(.+?)\s*$/im);
  const phoneMatch = raw.match(/^Phone[^:]*:\s*([+\d\s().\-]+)/im);
  const name = nameMatch ? nameMatch[1].trim().toLowerCase() : "";
  const phoneDigits = (phoneMatch ? phoneMatch[1] : "").replace(/\D/g, "").slice(-10);
  return { name, phone: phoneDigits };
}

// True if the DB already has a lead with matching (contact name, phone).
async function findDuplicateLead(supabase: any, raw_lead_msg: string) {
  const { name, phone } = extractContactAndPhone(raw_lead_msg || "");
  if (!name || !phone) return null;

  const { data: existing } = await supabase
    .from("AE Lead Distribution Record")
    .select("id, raw_lead_msg, assigned_ae_name, assigned_ae_email, status, created_at, submitted_by");

  for (const row of existing || []) {
    const { name: en, phone: ep } = extractContactAndPhone(row.raw_lead_msg || "");
    if (en === name && ep === phone) return row;
  }
  return null;
}

// ── assignAE: pick the least-loaded active AE ────────────

async function assignAE(supabase: any) {
  const today = todayUTC();

  const { data: aes, error } = await supabase
    .from("aes")
    .select("*")
    .eq("active", true)
    .order("id", { ascending: true });

  if (error || !aes || aes.length === 0) {
    throw new Error("No active AEs found");
  }

  const stats = await Promise.all(
    aes.map(async (ae: any) => {
      // Today's active load (not disapproved)
      const { count: todayCount } = await supabase
        .from("AE Lead Distribution Record")
        .select("id", { count: "exact", head: true })
        .eq("assigned_ae_id", ae.id)
        .gte("created_at", today + "T00:00:00.000Z")
        .lte("created_at", today + "T23:59:59.999Z")
        .not("status", "in", '("ai_disapproved","human_disapproved")');

      // All-time sent
      const { count: allTimeCount } = await supabase
        .from("AE Lead Distribution Record")
        .select("id", { count: "exact", head: true })
        .eq("assigned_ae_id", ae.id)
        .eq("status", "email_sent");

      return { ...ae, todayCount: todayCount || 0, allTimeCount: allTimeCount || 0 };
    })
  );

  // Least loaded first, tiebreak by all-time, then by id
  stats.sort(
    (a: any, b: any) =>
      a.todayCount - b.todayCount ||
      a.allTimeCount - b.allTimeCount ||
      a.id - b.id
  );

  return stats[0];
}

// ── AE Stats (for dashboard tracker table) ───────────────

async function getAEStats(supabase: any, from: string, to: string) {
  const start = from + "T00:00:00.000Z";
  const end = to + "T23:59:59.999Z";

  const { data: aes, error } = await supabase
    .from("aes")
    .select("*")
    .order("id");

  if (error) throw new Error(error.message);

  return Promise.all(
    aes.map(async (ae: any) => {
      // Emails sent within the selected date range (by lead created_at).
      const { count: sentCount } = await supabase
        .from("AE Lead Distribution Record")
        .select("id", { count: "exact", head: true })
        .eq("assigned_ae_id", ae.id)
        .gte("created_at", start)
        .lte("created_at", end)
        .eq("status", "email_sent");

      const { count: pendingCount } = await supabase
        .from("AE Lead Distribution Record")
        .select("id", { count: "exact", head: true })
        .eq("assigned_ae_id", ae.id)
        .gte("created_at", start)
        .lte("created_at", end)
        .eq("status", "pending_manual_review");

      return {
        ...ae,
        sentCount: sentCount || 0,
        todayCount: sentCount || 0, // back-compat alias
        pendingCount: pendingCount || 0,
      };
    })
  );
}

// ── Create Lead (called by AI workflow) ─────────────────

async function createLead(supabase: any, body: any) {
  const {
    raw_lead_msg,
    ai_decision: rawDecision,
    interest_level,
    ai_explanation,
    email_subject,
    email_body,
    cc,
    submitted_by,
  } = body;

  if (!raw_lead_msg) throw new Error("raw_lead_msg is required");

  // The AI workflow emits "approved"/"disapproved" (past tense) while our
  // internal statusMap expects "approve"/"disapprove". Normalize both.
  const ai_decision = normalizeDecision(rawDecision);

  // Dedup: same (contact name, phone) already in DB → return existing.
  // If we now have a submitter and the existing row doesn't, backfill it.
  const dup = await findDuplicateLead(supabase, raw_lead_msg);
  if (dup) {
    if (submitted_by && !dup.submitted_by) {
      await supabase
        .from("AE Lead Distribution Record")
        .update({ submitted_by })
        .eq("id", dup.id);
      dup.submitted_by = submitted_by;
    }
    return { ...dup, duplicate: true };
  }

  const statusMap: Record<string, string> = {
    approve: "ai_approved",
    manual_review: "pending_manual_review",
    disapprove: "ai_disapproved",
  };
  const status = statusMap[ai_decision] || "pending_manual_review";

  // Assign AE (only if not disapproved)
  let ae = null;
  if (ai_decision !== "disapprove") {
    try {
      ae = await assignAE(supabase);
    } catch (e) {
      console.warn("assignAE failed:", e.message);
    }
  }

  // If the AI workflow didn't supply email content (manual_review /
  // disapprove branches don't generate it), fall back to a generic
  // template so a human reviewer can still send without starting blank.
  const defaultSubject = Deno.env.get("DEFAULT_EMAIL_SUBJECT") || "New Lead Opportunity";
  const defaultSignature = Deno.env.get("DEFAULT_EMAIL_SIGNATURE") || "Best Regards,\nLead Distribution Team";
  const finalSubject = email_subject || defaultSubject;
  const bodySource = email_body ||
    "Hi {{AE_NAME}},\n\nPlease review the lead below:\n\n" +
    raw_lead_msg +
    "\n\n\n" + defaultSignature;
  const finalBody = bodySource.replace("{{AE_NAME}}", ae?.name || "Team");

  const defaultCC = Deno.env.get("DEFAULT_CC_EMAIL") || "";

  const { data: lead, error } = await supabase
    .from("AE Lead Distribution Record")
    .insert({
      raw_lead_msg,
      ai_decision,
      status,
      ai_explanation,
      interest_level,
      email_subject: finalSubject,
      email_body: finalBody,
      assigned_ae_id: ae?.id || null,
      assigned_ae_name: ae?.name || "",
      assigned_ae_email: ae?.email || "",
      cc: cc || defaultCC,
      submitted_by: submitted_by || null,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  // If AI approved → send email
  if (ai_decision === "approve" && ae) {
    await trySendEmail(supabase, lead, ae);
  }

  return lead;
}

// ── Approve (human) ──────────────────────────────────────

async function approveLead(supabase: any, id: number, reviewedBy?: string) {
  const reviewer = (reviewedBy && String(reviewedBy).trim()) || "Human";
  const { data: lead, error } = await supabase
    .from("AE Lead Distribution Record")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !lead) throw new Error("Lead not found");

  // Assign AE if missing, otherwise refresh from aes table so we use the
  // current email (the value stored on the lead row is a snapshot from
  // createLead and can be stale if the AE's email was updated).
  let ae = null;
  if (!lead.assigned_ae_id) {
    ae = await assignAE(supabase);
  } else {
    const { data: freshAe } = await supabase
      .from("aes")
      .select("*")
      .eq("id", lead.assigned_ae_id)
      .single();
    ae = freshAe;
  }

  if (ae) {
    await supabase
      .from("AE Lead Distribution Record")
      .update({
        assigned_ae_id: ae.id,
        assigned_ae_name: ae.name,
        assigned_ae_email: ae.email,
      })
      .eq("id", id);
    lead.assigned_ae_id = ae.id;
    lead.assigned_ae_email = ae.email;
    lead.assigned_ae_name = ae.name;
  }

  const now = new Date().toISOString();

  // Send email
  const emailOk = await trySendEmail(supabase, lead, ae);

  if (emailOk) {
    await supabase
      .from("AE Lead Distribution Record")
      .update({
        status: "email_sent",
        reviewed_at: now,
        reviewed_by: reviewer,
        sent_at: now,
      })
      .eq("id", id);
    return { success: true, status: "email_sent" };
  } else {
    // Even if email fails, mark as approved
    await supabase
      .from("AE Lead Distribution Record")
      .update({
        status: "human_approved",
        reviewed_at: now,
        reviewed_by: reviewer,
      })
      .eq("id", id);
    return { success: true, status: "human_approved", note: "Email sending not configured yet" };
  }
}

// ── Disapprove (human) ───────────────────────────────────

async function disapproveLead(supabase: any, id: number, reviewedBy?: string) {
  const reviewer = (reviewedBy && String(reviewedBy).trim()) || "Human";
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("AE Lead Distribution Record")
    .update({
      status: "human_disapproved",
      reviewed_at: now,
      reviewed_by: reviewer,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  return { success: true, status: "human_disapproved" };
}

// ── Reverse (human) ──────────────────────────────────────

async function reverseLead(supabase: any, id: number) {
  const { error } = await supabase
    .from("AE Lead Distribution Record")
    .update({
      status: "pending_manual_review",
      reviewed_at: null,
      reviewed_by: null,
      sent_at: null,
      email_error: null,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  return { success: true, status: "pending_manual_review" };
}

// ── AI Workflow Proxy ───────────────────────────────────
// Forwards the lead submission to the AI workflow from the server so the
// browser doesn't have to deal with HTTP→HTTPS mixed content or CORS.

async function proxyDifySubmit(supabase: any, body: any) {
  const { raw_lead_msg, call_recording, email } = body || {};

  if (!raw_lead_msg) {
    return json({ error: "raw_lead_msg is required" }, 400);
  }

  const difyKey = Deno.env.get("DIFY_API_KEY");
  if (!difyKey) {
    return json({ error: "DIFY_API_KEY not configured" }, 500);
  }

  const difyBase = Deno.env.get("DIFY_BASE_URL");
  if (!difyBase) {
    return json({ error: "DIFY_BASE_URL not configured" }, 500);
  }

  let difyRes: Response;
  let difyJson: any;
  try {
    // Use HTTPS directly — the AI workflow host redirects HTTP→HTTPS with
    // 301/302, and Deno's fetch downgrades POST→GET on those redirects
    // (per WHATWG spec), which returns 405 on /workflows/run.
    difyRes = await fetch(difyBase + "/workflows/run", {
      method: "POST",
      redirect: "follow",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${difyKey}`,
      },
      body: JSON.stringify({
        inputs: {
          raw_lead_msg,
          call_recording: call_recording || "",
        },
        response_mode: "blocking",
        user: email || "agent",
      }),
    });
    difyJson = await difyRes.json();
  } catch (e) {
    return json({ error: "AI workflow request failed", message: e?.message }, 502);
  }

  if (!difyRes.ok) {
    return new Response(JSON.stringify(difyJson), {
      status: difyRes.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Always try to insert. If the AI workflow's own HTTP node already
  // inserted (approve branch), createLead's dedup by (contact name, phone)
  // will return the existing row and skip insertion. Manual_review /
  // disapprove branches don't trigger that — this is where we cover them.
  const outputs = difyJson?.data?.outputs || {};
  const structured = outputs.structured_output || {};
  try {
    const lead = await createLead(supabase, {
      raw_lead_msg,
      ai_decision: structured.decision,
      interest_level: structured.interest_level,
      ai_explanation: structured.explanation,
      email_subject: outputs.email_subject,
      email_body: outputs.email_body,
      cc: outputs.cc,
      submitted_by: email || null,
    });
    return json({ dify: difyJson, lead });
  } catch (e) {
    return json({
      error: "Lead insert failed",
      message: e?.message,
      dify: difyJson,
    }, 500);
  }
}

// ── Email Sending ────────────────────────────────────────
// Deno/Edge can't open SMTP sockets, so we delegate the actual send to the
// Node SMTP relay (server.js), which talks to Outlook/Office365 via
// nodemailer. This function stays the source of truth for status: it POSTs
// to the relay and returns true/false; callers update status/sent_at.
//
// Required Supabase secrets:
//   supabase secrets set EMAIL_RELAY_URL=https://<your-relay-host>
//   supabase secrets set EMAIL_RELAY_SECRET=<must match relay's RELAY_SECRET>

async function trySendEmail(supabase: any, lead: any, _ae: any) {
  const relayUrl = Deno.env.get("EMAIL_RELAY_URL");
  const relaySecret = Deno.env.get("EMAIL_RELAY_SECRET");

  if (!relayUrl || !relaySecret) {
    console.log("EMAIL_RELAY_URL / EMAIL_RELAY_SECRET not set — skipping email");
    console.log("Would send to:", lead.assigned_ae_email, "subject:", lead.email_subject);
    return false;
  }

  if (!lead.assigned_ae_email) {
    console.warn("No assigned_ae_email on lead", lead.id, "— skipping email");
    await supabase
      .from("AE Lead Distribution Record")
      .update({ email_error: "No recipient (assigned_ae_email empty)" })
      .eq("id", lead.id);
    return false;
  }

  const senderName = Deno.env.get("SENDER_NAME") || "Lead Distribution System";

  try {
    const res = await fetch(`${relayUrl.replace(/\/$/, "")}/send-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relaySecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: lead.assigned_ae_email,
        cc: lead.cc,
        subject: lead.email_subject,
        body: lead.email_body,
        fromName: senderName,
      }),
    });

    const result = await res.json().catch(() => ({}));

    if (!res.ok || !result.ok) {
      const err = result.error || `relay returned ${res.status}`;
      console.error("Relay error:", err);
      await supabase
        .from("AE Lead Distribution Record")
        .update({ email_error: err })
        .eq("id", lead.id);
      return false;
    }

    return true;
  } catch (e) {
    console.error("Email send failed:", e.message);
    await supabase
      .from("AE Lead Distribution Record")
      .update({ email_error: e.message })
      .eq("id", lead.id);
    return false;
  }
}

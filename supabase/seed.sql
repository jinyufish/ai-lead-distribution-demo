-- Demo seed data.
--
-- IMPORTANT: replace the AE email addresses below before running this if you
-- want the live demo to actually deliver mail. Leads are routed to the
-- least-loaded AE and the drafted email is sent to that AE's address, so these
-- must be inboxes you can open. @example.com is reserved by RFC 2606 and will
-- bounce.

insert into aes (name, email, active) values
  ('Sarah Chen',   'REPLACE_ME+sarah@gmail.com', true),
  ('Mike Johnson', 'REPLACE_ME+mike@gmail.com',  true),
  ('Alex Rivera',  'REPLACE_ME+alex@gmail.com',  true);

-- A few leads spread across statuses and transfer types so the dashboard has
-- something to show on first load. created_at is relative to now() so the
-- default "Today" date filter always has rows.
insert into "AE Lead Distribution Record"
  (raw_lead_msg, ai_decision, ai_explanation, interest_level, email_subject,
   email_body, assigned_ae_id, assigned_ae_name, assigned_ae_email, status,
   submitted_by, created_at, sent_at)
values
  (
    E'Context: Spoke with decision maker about enterprise AI integration for their sales team. They currently use Salesforce but need AI-powered lead scoring.\nCompany: Acme Corp\nContact name: John Smith\nPhone: (555) 123-4567\nEmail: john@acmecorp.com\nType of Transfer: Live Transfer',
    'approve',
    'High-intent lead. Decision maker with budget authority, clear pain point, and a Q3 timeline.',
    'high',
    'New Lead — Acme Corp (Live Transfer)',
    E'Hi Sarah,\n\nPlease review and follow up on the lead below.\n\nBest Regards,\nLead Distribution Team',
    1, 'Sarah Chen', (select email from aes where id = 1),
    'email_sent', 'agent@demo.com', now() - interval '6 hours', now() - interval '6 hours'
  ),
  (
    E'Context: Initial inquiry about pricing and capabilities. Contact asked detailed questions about API integration and data security compliance.\nCompany: TechFlow Inc\nContact name: Lisa Wang\nPhone: 555-987-6543\nEmail: lisa@techflow.io\nType of Transfer: EMAIL',
    'manual_review',
    'Engaged but early. Asked security questions that need a human answer before outreach.',
    'medium',
    'New Lead — TechFlow Inc (Review Needed)',
    E'Hi Alex,\n\nPlease review and follow up on the lead below.\n\nBest Regards,\nLead Distribution Team',
    3, 'Alex Rivera', (select email from aes where id = 3),
    'pending_manual_review', 'agent@demo.com', now() - interval '3 hours', null
  ),
  (
    E'Context: Referral from an existing client. Looking for workflow automation to replace manual lead handoff across 3 regional offices.\nCompany: Brightpath Solutions\nContact name: Maria Garcia\nPhone: (555) 456-7890\nEmail: maria@brightpath.com\nType of Transfer: Call scheduled at 2pm EST',
    'approve',
    'Warm referral with a defined problem and multi-office scope. Scheduled callback already agreed.',
    'high',
    'New Lead — Brightpath Solutions (Scheduled)',
    E'Hi Mike,\n\nPlease review and follow up on the lead below.\n\nBest Regards,\nLead Distribution Team',
    2, 'Mike Johnson', (select email from aes where id = 2),
    'ai_approved', 'agent@demo.com', now() - interval '2 hours', null
  ),
  (
    E'Context: Caller was asking about a free trial only, no business need identified. Student working on a class project.\nCompany: N/A\nContact name: Bob Test\nPhone: 555-000-0000\nEmail: bob@random.com\nType of Transfer: EMAIL',
    'disapprove',
    'No business need and no buying authority. Logged for tracking only.',
    'low',
    null, null,
    null, null, null,
    'ai_disapproved', 'agent@demo.com', now() - interval '1 hour', null
  );

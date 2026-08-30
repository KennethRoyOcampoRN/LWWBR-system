import { TZDate } from '@date-fns/tz';
import { format, subDays } from 'date-fns';
import { Resend } from 'resend';
import { getEnv } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import { getReport } from '../reports/service.js';
import { listUrgentSlaBreachedWorkOrders } from '../workorders/service.js';

// Spec §3.2: "Timezone Asia/Manila everywhere... never store naive local
// time." Same TZDate pattern as reports/service.ts's own resolveDate —
// duplicated here rather than imported since that helper isn't exported
// and this only needs the one boundary, not the full report-query
// machinery.
const RESORT_TIMEZONE = 'Asia/Manila';

// The job itself is time-agnostic: "yesterday" is whatever Asia/Manila
// calendar day precedes whenever this function runs, not a fixed clock
// time. 8:00 AM PHT is entirely the Netlify Scheduled Function's cron
// responsibility (already registered in netlify.toml) — a manual trigger
// at 3pm still correctly means "yesterday" relative to right now.
function yesterdayBounds(now: Date = new Date()): { dateLabel: string; start: Date; end: Date } {
  const nowInManila = new TZDate(now, RESORT_TIMEZONE);
  const yesterdayInManila = subDays(nowInManila, 1);
  const dateLabel = format(yesterdayInManila, 'yyyy-MM-dd');
  const [year, month, day] = dateLabel.split('-').map(Number) as [number, number, number];
  const start = new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
  const end = new TZDate(year, month - 1, day + 1, 0, 0, RESORT_TIMEZONE);
  return { dateLabel, start, end };
}

// Only ALL-scope, non-department-restricted report:view — same
// requirement buildOccupancyReport itself enforces. This job has no
// real logged-in user behind it, so it needs a synthetic actor that
// satisfies that check rather than one built from a real session.
const SYSTEM_REPORT_ACTOR: Parameters<typeof getReport>[2] = {
  department: 'MANAGEMENT',
  permissions: { 'report:view': 'ALL' },
  roles: ['SYSTEM_ADMIN'],
};

interface UrgentBreachedWorkOrderSummary {
  referenceNo: string;
  title: string;
  unitCode: string | null;
  overdueMinutes: number;
  deepLink: string;
}

export interface OwnerDigestContent {
  dateLabel: string;
  occupancyRate: number | null;
  occupiedCount: number;
  totalUnits: number;
  arrivals: number;
  incidentsCount: number;
  urgentBreachedWorkOrders: UrgentBreachedWorkOrderSummary[];
}

function workOrderDeepLink(id: string): string {
  const base = getEnv().WEB_BASE_URL;
  // No WEB_BASE_URL configured (e.g. a local dev trigger before it's
  // set in .env): fall back to a relative path rather than throwing —
  // the digest should still compute and, in a real send, at least be
  // readable, even if the link isn't clickable from an email client
  // that requires an absolute URL.
  return base ? `${base}/work-orders?id=${id}` : `/work-orders?id=${id}`;
}

// Spec §8.3: "Lead with a single 'yesterday at a glance' card —
// occupancy, revenue, arrivals, incidents." Revenue is deliberately
// absent — see spec.md §13 decision 7 — rather than silently missing;
// renderDigestEmail below labels it explicitly. Occupancy reuses
// buildOccupancyReport's exact logic for a single day (no duplicated
// math); arrivals mirrors getUnitsDashboard's own checkinsToday
// definition (READY -> OCCUPIED UnitStatusEvent rows), just for
// yesterday instead of today and with real Asia/Manila boundaries
// (getUnitsDashboard's own checkinsToday uses the server's local
// midnight, not TZDate — a pre-existing gap, out of scope for this
// slice, not repeated here). Incidents count every IncidentType created
// yesterday (not just SAFETY — that's the narrower, real-time exception
// alert; this is the broader daily count spec's glance card asks for).
// The SLA-breach list is *not* "yesterday"-scoped — it's whichever
// URGENT tickets are breached as of when the digest is actually sent,
// since a still-open breach from three days ago is exactly the kind of
// thing an owner needs to see today, not just the day it first breached.
export async function computeDigestContent(now: Date = new Date()): Promise<OwnerDigestContent> {
  const { dateLabel, start, end } = yesterdayBounds(now);

  const [occupancyReport, arrivals, incidentsCount, breachedWorkOrders] = await Promise.all([
    getReport('occupancy', { from: dateLabel, to: dateLabel }, SYSTEM_REPORT_ACTOR),
    prisma.unitStatusEvent.count({
      where: { fromStatus: 'READY', toStatus: 'OCCUPIED', createdAt: { gte: start, lt: end } },
    }),
    prisma.incident.count({ where: { deletedAt: null, createdAt: { gte: start, lt: end } } }),
    listUrgentSlaBreachedWorkOrders(),
  ]);

  const byDay = (occupancyReport.summary as { byDay: { occupiedCount: number; totalUnits: number; occupancyRate: number }[] })
    .byDay[0];

  return {
    dateLabel,
    occupancyRate: byDay ? byDay.occupancyRate : null,
    occupiedCount: byDay ? byDay.occupiedCount : 0,
    totalUnits: byDay ? byDay.totalUnits : 0,
    arrivals,
    incidentsCount,
    urgentBreachedWorkOrders: breachedWorkOrders.map((wo) => ({
      referenceNo: wo.referenceNo,
      title: wo.title,
      unitCode: wo.unitCode,
      overdueMinutes: wo.overdueMinutes,
      deepLink: workOrderDeepLink(wo.id),
    })),
  };
}

function formatPercent(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

export function renderDigestEmail(content: OwnerDigestContent): { subject: string; html: string; text: string } {
  const subject = `Lucky Waku-Waku — daily digest for ${content.dateLabel}`;

  const breachedLines = content.urgentBreachedWorkOrders.length
    ? content.urgentBreachedWorkOrders
        .map((wo) => `- ${wo.referenceNo}: ${wo.title}${wo.unitCode ? ` (${wo.unitCode})` : ''} — ${wo.overdueMinutes}m overdue — ${wo.deepLink}`)
        .join('\n')
    : 'None.';

  const text = [
    `Yesterday at a glance (${content.dateLabel}):`,
    `- Occupancy: ${formatPercent(content.occupancyRate)} (${content.occupiedCount}/${content.totalUnits} bookable units)`,
    `- Arrivals: ${content.arrivals}`,
    `- Incidents: ${content.incidentsCount}`,
    `- Revenue: not tracked — pricing/payments are out of scope (spec.md §13 decision 7)`,
    `- Payment verification queue: not tracked — same reason`,
    '',
    'Urgent work orders currently past SLA:',
    breachedLines,
  ].join('\n');

  const breachedHtml = content.urgentBreachedWorkOrders.length
    ? `<ul>${content.urgentBreachedWorkOrders
        .map(
          (wo) =>
            `<li><a href="${wo.deepLink}">${wo.referenceNo}</a>: ${wo.title}${wo.unitCode ? ` (${wo.unitCode})` : ''} — ${wo.overdueMinutes}m overdue</li>`,
        )
        .join('')}</ul>`
    : '<p>None.</p>';

  const html = `
    <h1>Yesterday at a glance — ${content.dateLabel}</h1>
    <ul>
      <li>Occupancy: ${formatPercent(content.occupancyRate)} (${content.occupiedCount}/${content.totalUnits} bookable units)</li>
      <li>Arrivals: ${content.arrivals}</li>
      <li>Incidents: ${content.incidentsCount}</li>
      <li>Revenue: <em>not tracked — pricing/payments are out of scope (spec.md §13 decision 7)</em></li>
      <li>Payment verification queue: <em>not tracked — same reason</em></li>
    </ul>
    <h2>Urgent work orders currently past SLA</h2>
    ${breachedHtml}
  `.trim();

  return { subject, html, text };
}

const OWNER_DIGEST_CHANNEL_SETTING_KEY = 'ownerDigest.channel';
const DEFAULT_OWNER_DIGEST_CHANNEL = 'email';

// Spec §8.3: "the channel is a Setting." Same read-live-row, fall-back-
// to-shared-default pattern as fnb/service.ts's getAdvanceOrderLeadMinutes
// and workorders/service.ts's getPhotoRequirements.
async function getOwnerDigestChannel(): Promise<string> {
  const setting = await prisma.setting.findUnique({ where: { key: OWNER_DIGEST_CHANNEL_SETTING_KEY } });
  if (!setting || typeof setting.value !== 'string') {
    return DEFAULT_OWNER_DIGEST_CHANNEL;
  }
  return setting.value;
}

export interface SendOwnerDigestResult {
  channel: string;
  recipients: number;
  sent: number;
  skippedReason?: string;
}

// Recipients: active users holding OWNER, with a non-null email — only
// email is implemented (spec: "email in MVP"). A channel Setting value
// other than 'email' is logged and skipped, not an error: MVP genuinely
// has nothing else to send through. No seeded user has an email today
// (login is by employee code) — this correctly reports 0 recipients
// rather than erroring in that case, but produces nothing useful until
// an OWNER account's email is actually set.
export async function sendOwnerDigest(now: Date = new Date()): Promise<SendOwnerDigestResult> {
  const channel = await getOwnerDigestChannel();
  if (channel !== 'email') {
    return { channel, recipients: 0, sent: 0, skippedReason: `Unimplemented channel "${channel}" — only "email" is built (MVP).` };
  }

  const owners = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      email: { not: null },
      roles: { some: { deletedAt: null, role: { key: 'OWNER' } } },
    },
    select: { email: true },
  });
  if (owners.length === 0) {
    return { channel, recipients: 0, sent: 0, skippedReason: 'No active OWNER-role user has an email address set.' };
  }

  const env = getEnv();
  if (!env.RESEND_API_KEY || !env.OWNER_DIGEST_FROM_EMAIL) {
    return {
      channel,
      recipients: owners.length,
      sent: 0,
      skippedReason: 'RESEND_API_KEY / OWNER_DIGEST_FROM_EMAIL not configured.',
    };
  }

  const content = await computeDigestContent(now);
  const { subject, html, text } = renderDigestEmail(content);

  const resend = new Resend(env.RESEND_API_KEY);
  await resend.emails.send({
    from: env.OWNER_DIGEST_FROM_EMAIL,
    to: owners.map((o) => o.email as string),
    subject,
    html,
    text,
  });

  return { channel, recipients: owners.length, sent: owners.length };
}

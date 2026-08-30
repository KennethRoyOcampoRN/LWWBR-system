// Spec §6/§8.3's Incident model, built minimally for the first time
// 2026-08-26 alongside the owner exception-alert work — see spec.md
// §13 decision 7 for why this had never been wired up before now. Not
// the full §8.3 incident/policy log (that's a future task): just enough
// for `incident:create`/`incident:read` to be real, and for a real
// safety incident to trigger the owner exception alert.
export const INCIDENT_TYPE_KEYS = ['SAFETY', 'SECURITY', 'GUEST_COMPLAINT', 'POLICY_VIOLATION', 'INJURY'] as const;
export type IncidentTypeKey = (typeof INCIDENT_TYPE_KEYS)[number];

export const INCIDENT_TYPE_LABELS: Record<IncidentTypeKey, string> = {
  SAFETY: 'Safety',
  SECURITY: 'Security',
  GUEST_COMPLAINT: 'Guest complaint',
  POLICY_VIOLATION: 'Policy violation',
  INJURY: 'Injury',
};

export const INCIDENT_SEVERITY_KEYS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverityKey = (typeof INCIDENT_SEVERITY_KEYS)[number];

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverityKey, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const INCIDENT_STATUS_KEYS = ['OPEN', 'INVESTIGATING', 'RESOLVED'] as const;
export type IncidentStatusKey = (typeof INCIDENT_STATUS_KEYS)[number];

export const INCIDENT_STATUS_LABELS: Record<IncidentStatusKey, string> = {
  OPEN: 'Open',
  INVESTIGATING: 'Investigating',
  RESOLVED: 'Resolved',
};

// Spec §8.3: "Push immediately only for: ... a safety incident." Read
// literally against `IncidentType` — SAFETY specifically, not the other
// four types (SECURITY, GUEST_COMPLAINT, POLICY_VIOLATION, INJURY).
// Spec doesn't gate this alert by severity either, so every SAFETY
// incident fires, regardless of `severity`.
export const EXCEPTION_ALERT_INCIDENT_TYPE: IncidentTypeKey = 'SAFETY';

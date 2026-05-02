-- Per-change-type override of the approval-SLA threshold. NULL means
-- "use the global default from notifications.alerts.approvalSlaMinutes."
-- Lets emergency-bypass / urgent change types page sooner than the
-- standard 24h, while routine ones can run longer or be unset entirely.
ALTER TABLE change_types ADD COLUMN approval_sla_minutes INTEGER;

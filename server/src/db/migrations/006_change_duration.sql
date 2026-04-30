-- Planned duration of the change window (minutes), set at create/edit time.
-- Lets the calendar render time-grid blocks with proper height instead of
-- treating every change as a single point in time.
ALTER TABLE changes ADD COLUMN planned_duration_minutes INTEGER;

-- Actual duration recorded on or after implementation. Settable when the
-- change is in 'implemented' or 'closed'; editable later if the operator
-- needs to correct it.
ALTER TABLE changes ADD COLUMN actual_duration_minutes INTEGER;

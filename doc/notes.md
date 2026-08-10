# Notes

Small reminders that are not yet plans.

- 2026-08-09: Probe Spotify's rate limiter with a deliberate live experiment
  to learn the actual limits. A conservative fixed governor (serial lane,
  1,000 ms start gap, one `429` retry) shipped ahead of the probe because
  live quota refusals were already interrupting use; the probe and the
  accumulated telemetry are how its values get tuned from evidence rather
  than guesswork. The probe intentionally drives toward `429`s, so it runs
  only with explicit direction.

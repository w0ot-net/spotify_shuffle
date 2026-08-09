# Notes

Small reminders that are not yet plans.

- 2026-08-09: Probe Spotify's rate limiter with a deliberate live experiment
  to learn the actual limits before designing any request governor. The
  track-read plan defers throttling pending this data and only records
  passive observations. The probe intentionally drives toward `429`s, so it
  runs only with explicit direction.

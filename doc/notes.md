# Notes

Small reminders that are not yet plans.

- 2026-08-09: Probe Spotify's rate limiter with a deliberate live experiment
  to learn the actual limits. The initial conservative governor used a serial
  lane, a 1,000 ms start gap, and one `429` retry. After recorded traffic at
  that policy showed no refusals, the gap moved to the current 250 ms on
  2026-08-10; the lane remains serial and latency-bound in the observed data.
  The deliberate probe is still pending and intentionally drives toward
  `429`s, so it runs only with explicit direction.

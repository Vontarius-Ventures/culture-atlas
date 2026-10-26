# Evidence-method candidate evaluation

Candidate `43326a3`, compared descriptively with `af39609`, 2026-10-26.
The original 16 photos are tuning data. Eight disjoint existing golden images
are transfer data, **not a fresh qualification holdout**.

## Method and operational results

One fixed candidate pass, after compatibility preflights. Two independent
judges receive per-photo randomized A/B variants for tuning and C for transfer.
Their packets omit product reasons, provider tags, style-match proof, timings
and variant identities. Judges must open every original image and report
unverifiable candidates. Candidate image inspection is not assumed.

| Metric | Prior tuning | Candidate tuning | Candidate transfer |
| --- | ---: | ---: | ---: |
| Photos | 16 | 16 | 8 |
| Style ready | 16 | 16 | 8 |
| Photos with More like this cards | 10 | 12 | 5 |
| Photos with cross-domain cards | 15 | 11 | 0 |
| Photos with no cards | 0 | 1 | 3 |
| Total cards | 162 | 110 | 33 |
| Non-fashion subject cards mislabeled Wear | 15 | 0 | 0 |
| Grounded reference-ID echoes | 2 | 1 | 0 |
| Complete within 30 seconds | 16 | 16 | 7 |
| Model reservations, USD | 1.179668 | 1.211168 | 0.669884 |
| Qloo query records | 103 | 102 | 57 |

All 24 candidate captures completed. Three capture statuses were partial:
tennis Watch, kitchen research, and text-sweatshirt research. Every style
section was ready. Completion ranged from 12.7 to 33.5 seconds (median 20.2);
23/24 first readings arrived within five seconds.

The 24-photo pass reserved **$1.881052**. No costs reconciled, so this is not
actual billed spend. The shared local ledger, including earlier experiments
and retained preflight failures, totals **$10.443619** in unknown-cost
reservations, below the owner-authorized $15 ceiling. No reservations were
cleared. The $15 limit is scratch-only, not shipped configuration.

## Compatibility preflights

The first two-photo preflight failed before gateway dispatch: the initial
nested request exceeded the original 17,000-byte input envelope. Temporarily
expanding the envelope admitted the next two calls, but the upstream rejected
both with HTTP 400. The sanitized transport did not expose the upstream body;
the exact cause is unknown.

The wire representation was flattened to subject, observation, claim and
palette tables. Evidence references use bounded CSV strings on the wire and
normalize back into internal arrays. The schema is 2,066 bytes; full schema,
system text and vocabulary total 16,620 bytes in the regression fixture.
One separate paid preflight succeeded before the full frozen pass. The
original 17,000 input cap and 56,798-micro style reservation were restored.
Photo-role prompts and qualification bindings were not changed.

## Known remaining gaps, before judge decoding

- Distinctive palette recall is still incomplete. The striped top retains
  mustard trim but loses white as background and navy for invalid local
  evidence. The painting observes its blue/yellow headcloth but publishes
  only umber and ochre; a palette entry fails local-reference validation.
  Measured blue-grey swatches were available. This is not a solved palette gate.
- All eight transfer photos lack cross-domain cards; three have no cards at
  all. Fewer unsupported cards alone cannot establish better relevance.
- Generic brand repetition persists (Tommy Hilfiger appears on three tuning
  photos). Candidate-side category/material evidence can still be too broad
  for useful discovery: bedding for an abandoned room, or tableware for a
  terracotta sculptural fragment.
- The painting still gets only its same-title film. This is an explicitly
  named-work relationship, not evidence of broader art discovery.
- Food ideas still remix the pictured subject. The independent photo/composer
  prompts remain unchanged.

## Independent blinded judgments

Both judges assessed all 24 original images and all 40 variant/image
combinations before assignment decoding. One JPEG source had a `.png`
extension and failed image decoding; both judges assessed a correctly
encoded copy of that exact source and replaced their placeholders. No images
were excluded or denominators reduced.

| Split | A style | B style | Mean style | A relevance | B relevance | Mean relevance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rejudged prior tuning | 8.47 | 8.52 | 8.49 | 4.61 | 4.62 | 4.62 |
| Candidate tuning | 7.91 | 7.86 | 7.88 | 4.34 | 4.28 | 4.31 |
| Candidate transfer | 7.51 | 7.99 | 7.75 | 1.96 | 1.86 | 1.91 |

Style meets the descriptive 7.5 target on both splits, but relevance fails
the 7.0 target on both. Against the same judges' blinded rejudgment of the
prior outputs, tuning style falls 0.61 and relevance falls 0.31. The prior
legacy score of 5.27 used a different judging protocol and must not be
substituted for the rejudged 4.62 baseline.

Mean estimated useful cards across judges fell from 69.5/162 to 54/110 on
tuning; transfer has 11.5/33. Reducing total cards did not improve useful
discovery. These counts are descriptive judgments, not independently
verified precision estimates.

Neither judge opened candidate images. They assessed displayed product forms,
titles and independently known identities, flagging uncertain titles rather
than inventing visual attributes. Each found 12–15 candidate tuning cards
unverifiable and two transfer cards unverifiable. The results therefore do
not establish candidate-image visual similarity or production qualification.

Specific failures:

- Tennis style loses most of the main outfit (mean 4.25 style), despite
  removing the equipment-to-apparel route.
- A terracotta sculptural fragment gets tableware, not historical/art
  discovery; the ornate canopy bedroom gets contemporary furniture.
- The marble statue's More like this rail contains eight popular films
  (mean 0.25 relevance). The media MLT path remains an admission gap beyond
  the cross-domain evidence gates.
- The abandoned room's bedding brand confuses intentional shabby decor
  with dereliction; generic architecture/decay films remain weak.
- Empty cafe, kitchen and mug results earn no relevance credit.

The methodology's data structures and some precision fixes are implemented;
useful discovery, distinctive palette retention and all-route admission are
**not solved**. This candidate should remain experimental and unmerged.
No statistical-significance or causal-improvement claim is supported.

## Code validation

Typecheck and production build passed. Lint passed with zero errors and the
existing `MusicView.tsx:187` hook-dependency warning.

The full rerun passed all **1,931 test assertions**, but exited nonzero on a
PostgreSQL `DROP DATABASE ... WITH (FORCE)` teardown permission error. A serial
rerun also hit an existing real-time Qloo-spacing assertion (110 ms versus a
115 ms minimum). Targeted reruns passed their assertions, but one exited
nonzero on the same database cleanup permission error. The test suite is
**not fully green**. No database privileges were raised to hide the failure.

No relevance pass, production qualification, causal improvement or merge
readiness is claimed.

# The morning's and the evening's traffic from TomTom, and the centre's one-way streets (ticket #321)

The plan: **Bistrița Auto Search** (`b87c01a7-…`, revision 101). Everything here is reproducible with
`scripts/tomtom-321.ts` (stages `fetch`, `free`, `calibrate`, `optimize`, `final`, `patch`, `figures`) and checked by
`npm run tomtom-321:check`. The TomTom data is the collector's, exported with
`npm run traffic:export -- b87c01a7-40ea-4aa3-a72a-7c917a58091b --from 2026-11-16 --to 2026-11-24` (5 MB, not kept
here: pass it as `--export <file>`). plan.json is the plan as it was used (the main plan only).

## 1. What TomTom recorded

Since 16 November the collector (docs/traffic-history.md) has saved TomTom's flow every 5 minutes, 06:00–09:00 and
16:00–19:00 local time (UTC+2). That is 575 snapshots up to 24 November, over 692 one-way roads ("ways").
TomTom gives **speeds, not vehicle counts**. For each way it gives the speed driven as a share of its free-flow
speed, which is the night's.

Over the whole network, weekdays only:

- **Morning:** the town slows from about 07:10 and is slowest at 07:55, at 55% of free flow. It is back to about
  83% by 08:35. The worst hour is **07:30–08:30**.
- **Evening:** the town is slowest at 16:00–16:30, at 58–64%, and eases to 89% by 19:00. The worst recorded hour is
  **16:00–17:00**. The collector starts at 16:00, so the peak may begin earlier.
- **Weekends:** close to free flow.

For each way and peak hour, the figure used is the median over the weekdays of each day's mean share. Only ways
TomTom covers at least half of, on at least 3 weekdays, count: **303 ways**, 253 of them 20 m or longer. Days agree
closely, with a typical spread of ±0.06. The slowest are Str. Ioan Slavici and Str. Crinilor (about 0.2 of free flow
in both peaks), Bd. Republicii south-west-bound, and Calea Moldovei.

## 2. From speeds to traffic: how it was inferred

The simulator was used as the model that turns traffic into speeds, and the traffic was adjusted until the slowdowns
matched TomTom's.

1. **Free flow in the simulator.** The plan is run headless in the app's own V2 simulation with almost no traffic
   (6 seeds × 40 min). Each way's mean speed, as distance over time spent on its lanes, is its free-flow speed.
   485 ways are driven, 269 of the 303 TomTom ones.
2. **A demand to adjust: a gravity model.** Each of the plan's 70 ways in sends **P** vehicles an hour, and each
   of its 68 ways out draws a share **A**. A trip from i to j is P·A_j/ΣA, never back out by the road it came in
   on. That is 138 numbers per peak, instead of 4,700 matrix cells that a few hundred speeds could never pin down.
   The start is 60 vehicles an hour per lane of each way in, with each way out weighted by its lanes.
3. **Simulate, compare, adjust, repeat.** Each round, the peak's demand is run on 4 seeds (10 min to fill the
   town, 20 min measured). Every car's way in, way out and the ways it drove are recorded. For each TomTom way, the
   error is the simulated share of free flow minus TomTom's. Each way in's P (and each way out's A) is then moved
   by the mean error over the ways its cars drove, weighted by how many cars and by the way's length × TomTom's
   cover. A way too fast in the simulator gets more traffic from the places that feed it; a way too slow gets less.
   This ran for 14 rounds, and the best round is kept.
4. **Daytime friction.** The first attempt showed that the simulator can't make the town as slow as TomTom says
   with traffic alone. Before it does, it starts to gridlock (33 deadlocks a run at 6,600 veh/h, still 0.21 too
   fast on average). TomTom's free flow is the night's, and by day parking, people crossing, buses and bikes slow
   town streets whatever the traffic; the simulator models none of that. So one network-wide factor φ scales the
   simulated shares. It is the least-squares fit, kept between 0.75 and 1, and the demand has to explain the rest.
   It settled at the bottom of its range, **φ = 0.75**: a quarter of TomTom's peak slowdown is put down to friction,
   not traffic. In the same spirit, a round where the simulator gridlocks (more than 3 deadlocks or 40 cars stood
   still per run, on average) takes 15% off every way in, since Bistrița doesn't gridlock every day. The demand
   settles where the simulator stops coping, about **5,300 vehicles an hour coming in**.
5. **Is it real, or just fitted? Held-out roads.** The roads were split in two by id. The calibration was run on
   one half only, then scored on the other half, which it never saw:

   | peak | held-out roads: RMSE of the share | correlation | at the start (demand by lanes) |
   |---|---|---|---|
   | morning | **0.193** | **0.32** | 0.202, 0.25 |
   | evening | **0.177** | **0.29** | 0.187, 0.23 |

   On roads it never saw, the inferred demand predicts congestion better than the lane-count guess it started
   from. So it learnt something true about where Bistrița's peak traffic goes. But the improvement is modest, and
   the correlation stays around 0.3: most of the way-by-way pattern in TomTom's speeds is **not** explained by this
   demand on this plan. The likely reasons are friction that differs street by street (a school, a car park, a
   market), signals not drawn in the plan, and TomTom's matching of short streets.
6. **The demand delivered** is the calibration on all the ways:

   | | morning (07:30–08:30) | evening (16:00–17:00) |
   |---|---|---|
   | vehicles an hour coming in | 5,382 | 5,261 |
   | fit on all 253 ways: RMSE, correlation | 0.179, 0.42 | 0.171, 0.38 |
   | trips from the town's edge / to it | 40% / 33% | 38% / 40% |
   | trips starting in the centre | 10.5% | 13.6% |

   The morning comes into town and the evening leaves it, as commuting would. The busiest destination in both is
   Str. Mihai Eminescu.

   ![Morning: TomTom against the simulation, road by road](fit-morning.svg) ![Evening](fit-evening.svg)

   Re-run on 4 seeds it never ran (`figures`), the fit holds: morning RMSE 0.179, r 0.41; evening 0.171, r 0.37.
   The plots show the limit plainly. The simulator slows many of the roads TomTom shows jammed: Calea Moldovei, Bd. Decebal,
   Str. Năsăudului and Str. Cuza Vodă in the morning; in the evening Bd. Republicii and Str. Gării, which it slows
   more than TomTom does (0.13 against 0.39). But most roads sit near φ: it barely slows them, while TomTom shows
   them anywhere from 0.3 to 1.

## 3. The centre's streets: one-way, two-way, turned round

**The centre** is inside Bd. Republicii, Bd. Gen. Grigore Bălan and Str. Ecaterina Teodoroiu, Str. Parcului and
Str. Dogarilor, and Str. Alexandru Odobescu: Piața Centrală, Piața Mică, Piața Unirii, Str. Dornei, Str. Nicolae
Titulescu and so on (`src/lib/experiments/tomtom-321/centre.ts`). It has no traffic lights.

**The changes, as read from the ticket:**

- a two-lane two-way street (one lane each way) made one-way on both lanes, either way;
- a two-lane one-way street made one lane each way;
- a one-lane one-way street turned round.

A change applies to a whole **street**: its road pieces of the same name, joined end to end and set out the same
way, including pieces joined by connectors outside any drawn junction (those within 8 m of each other count as a
junction of their own). Turning round only half of a one-way street would point the halves at each other. The
candidates are the centre's named streets, not the boulevards around it or unnamed pieces of junctions:
**33 streets**.

**Making a change on the V2 plan** (`directions.ts`). The editor's "reverse lane" leaves a lane's connectors where
they were, so the turns at both ends are made again, as one would draw them:

- every way in goes to every way out of another road, with no U-turns;
- straight on goes lane to lane;
- a left turn goes from the leftmost lane to the leftmost lane;
- a right turn goes from the rightmost lane to the rightmost lane.

A turned lane's give-way or stop sign follows its street (none here had one). A change is **refused** when it would:

- cut any trip off (some way in no longer reaching a way out it reaches today);
- leave a turned lane nobody can drive onto or off. Making Piața Centrală two-way is one example: it would run a
  lane back into a junction that every other road only leaves;
- leave **any** lane in the plan with nothing onto it or off it, a new way in or out.

The last rule was added after the first patch (#7), which broke it (see below). `npm run tomtom-321:check` checks
every change, and that case too.

**The search** (`optimize`) is greedy. Each round tries every sound change on top of those already kept, in both
peaks, on 2 seeds each, with today's layout run on the same seeds. The score is half the centre's delay
(vehicle-hours an hour on its roads) and half the time per trip asked for across the whole town. A trip the town
can't take counts as 10 minutes, so moving traffic out of the centre can't win by stranding it. Both halves are
measured against today, and the score is the mean over peaks and seeds: 1 is today, lower is better. A change is
kept only if it beats the current design by more than 0.01, about the runs' noise.

| round | kept | score | runner-up |
|---|---|---|---|
| 1 | Str. Ecaterina Teodoroiu one-way, southbound, along its whole length | 0.934 | its one-lane southern part turned round, 0.947 |
| 2 | + Str. Dogarilor turned round | 0.901 | + Str. C. Dobrogeanu Gherea turned round, 0.913 |
| 3 | nothing better by 0.01 (best + Str. Nicolae Titulescu turned round, 0.894) | | |

**Checked on 6 fresh seeds per peak** (`final`):

| | today | Ecaterina Teodoroiu one-way | + Dogarilor turned round |
|---|---|---|---|
| score | 1 | **0.955** | 0.945 |
| morning: centre delay, vehicle-hours an hour | 8.17 | **7.03 (−12%)** | 7.17 (−6%) |
| evening: centre delay | 7.26 | **6.48 (−11%)** | 6.13 (−16%) |
| morning / evening: time per trip | 235 / 255 s | 241 / 260 s | 233 / 256 s |
| morning / evening: trips an hour | 4,850 / 4,484 | 4,806 / 4,470 | 4,816 / 4,471 |
| morning / evening: centre vehicle-km | 626 / 760 | 604 / 699 | 573 / 674 |
| morning / evening: collisions a run | 9.3 / 3.3 | 8.5 / 6.2 | 5.8 / 4.7 |
| morning / evening: deadlocks broken up a run | 1.3 / 3.7 | 12.2 / 9.2 | 1.2 / 10.8 |

**Delivered: Ecaterina Teodoroiu one-way only.**

- **The evening** gain shows on every seed (−7% to −15%).
- **The morning** is noisier: −15, −5, +13, −10, −13 and −41% by seed. In one run, Bd. Republicii × Str. Gării
  gridlocked. That junction is outside the centre and unchanged, it is a weak spot today too, and the change sends
  no more traffic through it.
- **Dogarilor turned round** on top improves the evening (−16%), but the morning gets worse and riskier: −6% on
  average, with one run where the centre jammed (+79%). Its score gain, 0.01, is at the noise. It's a candidate to
  look at, not a recommendation.
- **The cost:** evening collisions rise from 3.3 to 6.2 a run, and deadlocks the simulation broke up itself rise in
  both peaks. Look at the street's two ends before building it.

![The street changed](changes.svg)

**What it does.** Str. Ecaterina Teodoroiu, on the centre's east side, carries two lanes south from Piața Unirii and
Str. Liviu Rebreanu to Str. Zorilor and Str. Barbu Lăutaru. Northbound traffic takes the ring (Bd. Gen. Grigore
Bălan) instead of crossing that corner. The centre carries 3–8% fewer vehicle-km, at a few seconds more a trip.

## 4. Delivered, and the first patch's mistake

- **Agent patch #7** (applied as revision 102): the two matrices, "Morning peak (TomTom)" (07:00–09:30) and
  "Evening peak (TomTom)" (15:30–18:30), plus the first search's design, which was one piece of Ecaterina Teodoroiu
  made one-way and Liviu Rebreanu turned round. **It was wrong.** The street goes on north in three short pieces,
  joined by connectors outside any drawn junction, and those weren't taken as part of it. Two lanes were left with
  nothing onto them (l395) or off them (l391), which the Demand panel shows as a new way in and out named "Strada
  Ecaterina Teodoroiu". Under the matrices no cars were sent there, so the simulated results stood, but the plan got
  two dead street stubs. The checks then only looked at the lanes turned round, not their neighbours.
- **Agent patch #9** (it replaces #8, which had the same changes and understated the collisions), against revision
  102:
  - makes Ecaterina Teodoroiu one-way along its whole length (lanes l391, l393, l395 turned too);
  - puts Liviu Rebreanu back as it was (its connectors c715, c1324, c1328, c5353);
  - keeps the matrices.

  Applied to revision 102 here, it leaves the plan with the same ways in and out as revision 101, no trip cut off,
  and exactly the lanes and turns of the design simulated above.

The patches don't switch the demand in use: pick a matrix in Demand, or "By the time of day" with the clock at 07:30
or 16:00. For this, agent patches can now carry demand matrices (`matrices` items; patch:check).

## Limits

- TomTom gives speeds. Turning speeds into traffic needs a model, and this one is the simulator plus a gravity
  demand. A different demand that slows the same roads would fit as well. The held-out test shows this one is
  better than a guess, but only modestly so.
- The friction factor sits at its floor of 0.75, and the demand is capped where the simulator starts gridlocking.
  So the absolute numbers (5,300 vehicles an hour) are the simulator's, not a count. Real counts on a few roads
  would pin them down.
- The evening peak may start before 16:00, when the collector begins.
- The search changes one street at a time. Combined changes that only work together (a whole loop of one-way
  streets turned round) were not tried; most single reversals in the centre are refused because they cut a pocket
  of streets off.

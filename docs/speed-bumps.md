# Speed bumps (ticket #101)

V2 plans (the lane sketch) can have speed bumps, humps, tables and cushions across their roads: the **Speed bump**
tool (`H`), click one kerb then the other. The model is in `src/lib/sketch-bumps.ts`, the cars' behaviour in
`src/lib/lane-sketch-sim.ts` (`buildBumps`, and the bump caps in the step's route loop), the check in
`npm run bump:check`. This file is the research behind the defaults.

## What they do to speed

- **At the device.** Drivers cross a device at a speed set mostly by its profile. UK measurements at 33 sites with
  75 mm round-top humps (TRL Report 186, in Traffic Advisory Leaflet 2/96): mean crossing speeds 12–18 mph, on
  average **14.7 mph (24 km/h)**, 85th percentile 19 mph (31 km/h). 75 mm flat-top humps (tables) with 1:10–1:15
  ramps: on average **12.8 mph (21 km/h)**. Speed cushions (TRL 312 / TAL 1/98, 75 mm, 1:8 on/off ramps): cars
  about **17 mph (27 km/h)** mean, 22 mph 85th percentile. Between 75 and 100 mm the height changes little; spacing
  matters more (TAL 2/96).
- **Between devices.** Drivers speed up again between devices, so the spacing sets the speed there. TAL 2/96: with
  75 mm humps about 90 m apart, the mean between them was about 20 mph and the 85th percentile 25–26 mph; at
  50–60 m spacing the speed at the hump and between differ by only about 5 mph. Cushions: mean about 20.5 mph at
  60 m spacing, about 4 mph more at 100 m (TRL 312). US guidance (ITE, FHWA, NACTO) puts humps at most about 150 m
  (500 ft) apart for an 85th percentile of 40–48 km/h; one study measured 25 mph with humps 275 ft (84 m) apart
  and 30 mph at 550 ft (168 m). CROW (NL) advises 30–50 m in 30 km/h zones, 80–100 m on 50 km/h roads.
- **Large vehicles.** Buses are driven about 5 mph (8 km/h) slower than cars over 75 mm humps (TRL 417). Over
  cushions, vehicles with a wide track (buses, trucks, fire engines) straddle them and are slowed much less than
  cars (TAL 1/98, TAL 4/94): that is what cushions are for.
- **Short bumps** (0.3–0.9 m long, rubber or plastic, 3–7.5 cm) are rated by Romanian suppliers for 10–30 km/h
  (5 cm for 10 km/h, 3.5–4.5 cm for 20 km/h, 4 cm for 30 km/h). They are meant for car parks and private roads.

## The norms

There is no EU-wide standard for speed bumps: each country has its own rules, and some have only guidance.

| Where | Rule | What it says |
|---|---|---|
| UK (England and Wales) | Highways (Road Humps) Regulations 1999 (SI 1999/1025) | A hump is 25–100 mm high and at least 900 mm long (along the road); no vertical face over 6 mm. Design guidance: TAL 2/96 (75 mm humps), TAL 1/98 and 4/94 (cushions: at most 75 mm high, 65 mm if short; 1.6–1.9 m wide, 1.6–1.7 m on bus routes; on/off ramps 1:8, side ramps 1:4), LTN 1/07. Northern Ireland: the same heights and length (Road Humps Regulations (NI) 1999). |
| France | Décret n° 94-447 of 27 May 1994 (amended 2001), standard NF P 98-300 | Round-top (*dos d'âne*, circular profile, 4 m long, 10 cm high at most) and trapezoidal (*trapézoïdal*, a plateau that must carry a pedestrian crossing) humps. Only in built-up areas, service areas and forest roads, and only on roads limited to 30 km/h. Never on their own: combined with other calming at most 150 m apart. Plateaus and Berlin cushions have only Cerema guidance (2010), but courts have applied the decree to them (CAA Marseille, 2024). Whether NF P 98-300 itself is mandatory is disputed. |
| Netherlands | CROW guidance (publication 344, "Verkeersdrempels") | Sinusoidal humps and plateaus with a crossing speed of 20, 30, 50 or 60 km/h, 8 or 12 cm high, full width. For example, a 30 km/h hump of 12 cm is 2.40 m long; a 50 km/h hump of 8 cm is 3.00 m long; a 30 km/h plateau of 12 cm has 1.50 m ramps. 8 cm where 12 cm is too much for low-floor buses. |
| Romania | Regulation implementing the road traffic law (HG 1391/2006), art. 123 f | On roads with bumps signed as such, at most 30 km/h in towns and 50 km/h outside them. The warning sign "Denivelare pentru limitarea vitezei" announces them. No national standard for their dimensions was found. |

## How the simulator models them

Each bump is drawn from kerb `a` to kerb `b` with a `length` along the traffic and a `height`. The sim samples every
lane and connector under it (as for zebras), so it acts on both directions and on lanes through a junction.

- **Crossing speed** (`speed`, km/h): the kind's unless set. Defaults: bump 12, hump 24, table 21, cushions 27
  (the UK means above). Each driver crosses at their own share of it, the same share they drive at relative to the
  limit (Simulation settings: *Speed vs the limit*, *Speeds vary by*), capped at 1.2×.
- **Buses and trucks**: 8 km/h slower over a bump, hump or table (at least 5 km/h); 1.5× the cars' speed over
  cushions (they straddle them).
- **Braking for it**: a car brakes evenly once it needs half its comfortable braking (`B_COMF / 2`, 1 m/s² by
  default) to get down to the bump's speed by the time it reaches it. From 50 km/h to 24 km/h that starts about
  70 m before the hump. It keeps the speed until its back is off the bump, then speeds up as usual. So humps close
  together keep the speed down between them, as measured (`bump:check`: 60 m spacing about 34 km/h mid-way, 150 m
  about 45 km/h, on a 50 km/h road).
- **Height** does not change the speed (it matters little between 75 and 100 mm, TAL 2/96). It is drawn in 3D and
  checked against the norms: the inspector warns above 10 cm (the UK and French maximum), below 25 mm, for a hump
  shorter than 0.9 m, for cushions over 75 mm, and on roads over 30 km/h (France allows humps only on 30 km/h roads;
  in Romania a signed bump means 30 km/h in towns).
- The car explainer says when a car's desired speed is down for a bump ("Slowing for speed bump h1").
- Slowing for bumps counts as delay in the results, as it should.

Not modelled: discomfort or damage, noise, emergency-vehicle delay, the extra fuel of slowing and speeding up beyond
what the fuel model already counts from the speeds, and drivers swerving round the cushions.

## Sources

- [Traffic Advisory Leaflet 2/96: 75 mm high road humps](https://tsrgd.co.uk/pdf/tal/1996/tal-2-96.pdf)
- [Traffic Advisory Leaflet 1/98: speed cushion schemes](https://tsrgd.co.uk/pdf/tal/1998/tal-1-98.pdf), [TAL 4/94: speed cushions](https://tsrgd.co.uk/pdf/tal/1994/tal-4-94.pdf), [TRL Report 312](https://www.trl.co.uk/uploads/trl/documents/TRL312.pdf)
- [TRL Report 417: passenger and rider discomfort at humps](https://www.trl.co.uk/uploads/trl/documents/TRL417.pdf), [TRL Report 614: impact of road humps on vehicles](https://www.trl.co.uk/uploads/trl/documents/TRL614(1).pdf)
- [Highways (Road Humps) Regulations 1999](https://vlex.co.uk/vid/highways-road-humps-regulations-812021705), [Road Humps Regulations (Northern Ireland) 1999](https://www.legislation.gov.uk/nisr/1999/101/made), [Hansard, 9 April 2001](https://hansard.parliament.uk/commons/2001-04-09/debates/e819eeeb-ddfb-4315-8660-f98054a5d102/TrafficCalmingMeasures)
- [Décret 94-447 and NF P 98-300 (summary)](https://www.challenv.fr/img/cms/ralentisseur%20d%C3%A9cret%20n%C2%B0%2094-447%20du%2027%20mai%201994%20et%20%C3%A0%20la%20norme%20NF%20P%2098-300.pdf), [Cerema: coussins et plateaux](https://www.cerema.fr/fr/actualites/reglementation-coussins-plateaux), [Landot avocats on the 1994 decree](https://blog.landot-avocats.net/2023/10/26/le-decret-de-1994-sapplique-bien-sans-doute-a-la-plupart-des-ralentisseurs-au-sol-voire-a-tous-sauf-a-aimer-combiner-les-charmes-de-lillegalite-de-la-responsabilite-indemnitaire-et-du-penal/), [NosParlementaires on the promised arrêté](https://nosparlementaires.fr/actualites/ralentisseurs-norme-arrete-promis-2026-pas-paru)
- [CROW Kennisbank: richtlijnen verkeersdrempels en -plateaus](https://kennisbank.crow.nl/public/gastgebruiker/WOBU/Richtlijn_drempels,_plateaus_en_uitritten/Richtlijnen_voor_de_toepassing_van_verkeersdrempels_en_-plateaus/27209), [CROW-based dimensions (Struyk Verwo)](https://struykverwoinfra.nl/files/publicaties/Folder-Verkeersdrempels-en-plateaus.pdf)
- [Romania: "Denivelare pentru limitarea vitezei"](https://codul-rutier.ro/denivelare-pentru-limitarea-vitezei), [DNC Trafic speed bumps](https://www.dnctrafic.ro/category/limitatoare-viteza/)
- [FHWA Traffic Calming ePrimer, module 3](https://highways.dot.gov/safety/speed-management/traffic-calming-eprimer/module-3-part-2), [ITE speed hump guide](https://pavementsurfacecoatings.com/wp-content/uploads/2019/12/Documents/ITE-Speed-Hump-Guide.pdf), [NACTO: speed hump](https://nacto.org/publication/urban-street-design-guide/street-design-elements/vertical-speed-control-elements/speed-hump/), [Ewing: Impacts of Traffic Calming](https://nacto.org/wp-content/uploads/impacts_of_traffic_calming_ewing.pdf)

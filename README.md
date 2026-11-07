# NaijaFloodAlert

**Community flood early warning for Nigeria.** It combines open river forecasts, rainfall outlooks and satellite flood maps, and turns them into short, plain-language alerts (English and Nigerian Pidgin) that people can share over WhatsApp or SMS.

> Status: **working prototype** (November 2026). It is looking for a pilot partner: a State Emergency Management Agency, LGA or community group in a flood-prone area such as Kogi, Benue, Anambra or Bayelsa.

## Why

Nigeria's 2022 floods displaced more than 1.4 million people, and flooding returns every rainy season along the Niger and Benue. Hydrological outlooks exist, but they rarely reach riverside households in a form they can act on, in a language they use, on the phone they already have. NaijaFloodAlert closes that last mile.

## What it does

- **30-day river-discharge forecast** for 13 flood hotspots (Lokoja, Makurdi, Onitsha, Yenagoa, Yola, Ibaji, Jebba, Hadejia, Maiduguri, Abuja, Lagos, Ibadan, Port Harcourt), plus any point you tap on the map.
- **Local, data-driven thresholds.** Each point is compared with its own river's daily record since 2010: above the 90th percentile is *Watch*, above the 98th is *Warning*, above the 99.7th is *Severe*. There are no hand-set national cut-offs.
- **Rainfall boost for flash-flood cities.** A 7-day rainfall total of 100 mm or more, or 50 mm or more in a single day, raises the alert level for urban sites.
- **Satellite check.** An optional NASA MODIS flood-water overlay shows where surface water was detected in the last two days.
- **Ready-to-send alerts** in English and Pidgin, with the expected start and peak dates and safety actions. They can be shared over WhatsApp or SMS, or copied.
- **Offline-friendly PWA.** The app shell and last forecasts are cached for low-connectivity areas.

## Data sources

| Data | Source | Licence |
|---|---|---|
| River discharge forecast and history | Copernicus GloFAS v4, via [Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api) | CC BY 4.0 |
| Rainfall forecast | [Open-Meteo Weather API](https://open-meteo.com) | CC BY 4.0 |
| Satellite flood extent | NASA GIBS, LANCE MODIS Combined Flood (2-day) | NASA open data |
| Base map | OpenStreetMap | ODbL |

## Run it

It is a static site with no build step and no API keys.

```bash
# any static server works
python3 -m http.server 8080
# then open http://localhost:8080
```

Tests for the risk engine:

```bash
node tests/risk.test.js
```

Deploy for free with **GitHub Pages**: open Settings, then Pages, choose "Deploy from branch", and select `main` and `/root`.

## Project layout

```
index.html     UI shell
style.css      responsive styles (mobile first, dark mode)
sites.js       monitored hotspots
risk.js        risk engine: percentiles, alert levels, message templates (pure, testable)
app.js         data fetching, map, chart, alerts, subscriptions
sw.js          offline cache
tests/         risk engine tests
```

## Roadmap (pilot phase)

1. **SMS and WhatsApp delivery** through a messaging gateway (for example Africa's Talking), with a small backend that runs the risk check daily and messages subscribers when their community's level changes.
2. **Hausa, Yoruba and Igbo alerts**, reviewed by native speakers. Voice-note alerts for low-literacy users.
3. **Sentinel-1 radar flood mapping.** Radar sees through cloud, so it can map inundation in the rainy season, and those maps will help validate and tune the thresholds.
4. **Community reports.** Residents send a photo and location of rising water to ground-truth the forecasts.
5. **Validation** against the 2012, 2018, 2022 and 2024 flood records and NIHSA's Annual Flood Outlook.

## Disclaimer

NaijaFloodAlert is a research prototype and does not replace official warnings from NIHSA, NiMet, NEMA or State Emergency Management Agencies. Always follow their instructions. In an emergency, call 112.

## Author

Nzeribe Gerald Ifeanyichukwu, Abuja, Nigeria · nzeribegerald@gmail.com

Licensed under the MIT License.

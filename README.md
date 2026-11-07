# NaijaFloodAlert

[![Daily data, model and website](https://github.com/geraldnzeribe/naijafloodalert/actions/workflows/pipeline.yml/badge.svg)](https://github.com/geraldnzeribe/naijafloodalert/actions/workflows/pipeline.yml)
![data updated](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgeraldnzeribe.github.io%2Fnaijafloodalert%2Fdata%2Fstatus.json&query=%24.last.finished&label=data%20updated&color=1565c0)
![licence](https://img.shields.io/badge/licence-MIT-informational)

**Flood, rain and season watch for every community in Nigeria — updated automatically every day.**

Live site: **https://geraldnzeribe.github.io/naijafloodalert/**

NaijaFloodAlert is an open, self-running system. Three times a day a GitHub Actions job downloads fresh river and weather data, scores the risk for every river point, state and Local Government Area (774 LGAs), runs a machine-learning flood model, and republishes the website. No server, no manual steps. The commit history of this repository is the proof that it is alive.

## What you can do on the site

- **Zoom to your community.** Nigeria-only map down to street level (OpenStreetMap, terrain or satellite), with every LGA boundary. Search any town, village or LGA.
- **Today's flood risk.** Each river point is compared with its own daily record since 2012: *Watch* (above the 90th percentile), *Warning* (98th) or *Severe* (99.7th). Communities inherit the risk of the rivers that pass through or near them, plus heavy-rain flash-flood risk.
- **Machine-learning probabilities.** The chance that each river rises above its Watch or Warning level within 3, 7 and 14 days.
- **Season monitor (useful all year).** For every state: drought, drier than normal, normal, wetter, very wet or dry season; heat stress; and a **planting signal** that detects the real onset of the rains.
- **Replay past floods.** Pick a year (2012 onwards, including 2012, 2018, 2022 and 2024), press play and watch rivers across Nigeria rise and fall day by day. Optional NASA satellite imagery for each date.
- **Analyse an exact spot.** Tap anywhere; the browser finds the nearest river channel and checks it against its 14-year record, including small rivers.
- **Alerts in five languages.** English, Nigerian Pidgin, Hausa, Yorùbá and Igbo, ready to share on WhatsApp. Hausa, Yorùbá and Igbo are drafts awaiting native-speaker review (see [TRANSLATIONS.md](TRANSLATIONS.md)).

## How it works

```
GitHub Actions (3x daily)                                   GitHub Pages
┌──────────────────────────────────────────────┐           ┌──────────────────┐
│ 1. River network: ~150 points along Nigeria's │           │ site/            │
│    rivers, snapped to the real channel        │           │  index.html      │
│ 2. Back-fill history (newest years first)     │ commits   │  js/ css/        │
│ 3. Train ML model monthly (when 6+ years)     │──────────▶│  data/*.json     │
│ 4. Today: forecasts → levels, ML, season,     │  deploys  │                  │
│    774 LGAs                                   │           └──────────────────┘
│ 5. Yearly replay files, status.json           │
└──────────────────────────────────────────────┘
```

| Data | Source | Licence |
|---|---|---|
| River discharge (forecast + 1984– reanalysis) | Copernicus GloFAS v4 via [Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api) | CC BY 4.0 |
| Rainfall and temperature (history) | ERA5 via Open-Meteo Archive API | CC BY 4.0 |
| Rainfall and temperature (forecast) | Open-Meteo Forecast API | CC BY 4.0 |
| Boundaries (37 states, 774 LGAs) | [geoBoundaries](https://www.geoboundaries.org) | CC BY 4.0 |
| Rivers (network seed) | Natural Earth | Public domain |
| Satellite imagery | NASA GIBS (MODIS), Esri World Imagery | see providers |
| Base maps | OpenStreetMap, OpenTopoMap | ODbL / CC-BY-SA |

### The machine-learning model

- **Question it answers:** will this river rise above its own Watch (or Warning) level within the next 3, 7 or 14 days?
- **Inputs (scale-free):** today's flow and the last 1, 3, 7 and 14 days relative to the river's own Watch level; 1- and 7-day change; 30-day maximum; the behaviour of rivers within 150 km; 7- and 30-day rainfall anomalies for the state; time of year.
- **Model:** gradient-boosted trees (scikit-learn `HistGradientBoostingClassifier`), one model per lead time and threshold, shared across all river points.
- **Honest testing:** trained on 2012–2020, then scored on 2021 onwards, which it never saw and which includes the 2022 and 2024 floods. Results (AUC, hit rate, false-alarm ratio) are compared with a persistence baseline ("the river stays as it is") and published on the site's *Model* tab and in `pipeline/cache/model/metrics.json`.
- **Retraining:** automatic, monthly.

### Limits (please read)

- GloFAS works on a ~5 km grid. Very small streams and urban drains are below its resolution, so for those places alerts lean on rainfall.
- Seasonal outlooks beyond a few weeks are probabilities, never certainties.
- This is a research and public-information tool. It does **not** replace official warnings from NIHSA, NiMet, NEMA or State Emergency Management Agencies. In an emergency call **112**.

## First run

After the first push the system builds itself over the first one to two weeks, inside the free API limits:

1. **Day 1:** the river network is snapped to real channels.
2. **Days 1–5:** recent years are downloaded first, so 2026, 2025 and 2024 replays appear early.
3. **About day 4–6:** the ML model trains automatically once six or more years are in.
4. **About day 10–14:** all history back to 2012 is complete.

The *Model* tab and `site/data/status.json` show progress.

## Run locally

```bash
pip install -r requirements.txt
python -m pipeline.run          # needs internet; uses the free Open-Meteo API
python tests/test_pipeline.py   # offline end-to-end test with a fake API
cd site && python -m http.server 8080
```

## Repository layout

```
.github/workflows/pipeline.yml  automation (3x daily + on push)
pipeline/                       data, ML and scoring code (Python)
  cache/                        history + trained model (written by the bot)
  geo/                          river seed points
site/                           the website (static, GitHub Pages)
  data/                         JSON written by the pipeline
tests/                          offline pipeline test
```

## Author

Nzeribe Gerald Ifeanyichukwu — Abuja, Nigeria. Contributions, translations and corrections are welcome via issues and pull requests.

MIT License.

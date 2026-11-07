"""Central settings for the NaijaFloodAlert data pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipeline"
CACHE = PIPE / "cache"            # long-lived raw history, committed to the repo
SITE = ROOT / "site"
DATA = SITE / "data"              # everything the website reads

FLOOD_API = "https://flood-api.open-meteo.com/v1/flood"
FORECAST_API = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"

HISTORY_START_YEAR = 2012         # covers the 2012, 2018, 2022 and 2024 floods
SNAP_RADIUS_STEPS = 2             # search +-2 grid cells (0.05 deg ~ 5.5 km each) around each point
SNAP_STEP = 0.05

# Open-Meteo free tier: ~10,000 weighted calls/day, 5,000/hour, 600/minute.
# The workflow runs three times a day (8 h apart), so each run stays inside one hour's quota
# and the three together stay under the daily limit.
RUN_BUDGET = 3000
PER_MINUTE = 450

# Alert levels from each river point's own history.
PCTL_WATCH, PCTL_WARNING, PCTL_SEVERE = 0.90, 0.98, 0.997

# ML: lead times in days for the learned flood-probability model.
LEADS = (3, 7, 14)
MIN_YEARS_TO_TRAIN = 6

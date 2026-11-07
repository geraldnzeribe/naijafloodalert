// Monitored flood hotspots. Coordinates sit on or beside the main river channel
// so the GloFAS grid cell picks up the river rather than a dry hillside.
// River sites were snapped to the highest-flow GloFAS cell within ~20 km (checked against the 2024 flood season).
// Urban sites have no large-river cell, so their alerts are rainfall-driven.
// type: "river" = large-river (fluvial) flooding; "urban" = flash/pluvial flooding risk too.
window.NFA_SITES = [
  { id: "lokoja",   name: "Lokoja",        state: "Kogi",      river: "Niger–Benue confluence", lat: 7.750,  lon: 6.740,  type: "river" },
  { id: "makurdi",  name: "Makurdi",       state: "Benue",     river: "River Benue",            lat: 7.790,  lon: 8.330,  type: "river" },
  { id: "yola",     name: "Yola",          state: "Adamawa",   river: "River Benue",            lat: 9.410,  lon: 12.330, type: "river" },
  { id: "onitsha",  name: "Onitsha",       state: "Anambra",   river: "River Niger",            lat: 5.950,  lon: 6.670,  type: "river" },
  { id: "ibaji",    name: "Ibaji",         state: "Kogi",      river: "River Niger",            lat: 6.750,  lon: 6.560,  type: "river" },
  { id: "yenagoa",  name: "Yenagoa",       state: "Bayelsa",   river: "River Nun (main channel)",       lat: 4.830,  lon: 6.060,  type: "river" },
  { id: "jebba",    name: "Jebba",         state: "Kwara",     river: "River Niger",            lat: 9.190,  lon: 5.020,  type: "river" },
  { id: "hadejia",  name: "Hadejia",       state: "Jigawa",    river: "Hadejia River",          lat: 12.400, lon: 9.940, type: "river" },
  { id: "maidug",   name: "Maiduguri",     state: "Borno",     river: "River Ngadda – rainfall-driven",           lat: 11.850, lon: 13.160, type: "urban" },
  { id: "abuja",    name: "Abuja (FCT)",   state: "FCT",       river: "Wupa / Usuma – rainfall-driven",           lat: 9.020,  lon: 7.420,  type: "urban" },
  { id: "lagos",    name: "Lagos (Lekki)", state: "Lagos",     river: "Lagos Lagoon catchment – rainfall-driven", lat: 6.450,  lon: 3.600,  type: "urban" },
  { id: "ibadan",   name: "Ibadan",        state: "Oyo",       river: "Ogunpa / Ona – rainfall-driven",           lat: 7.380,  lon: 3.930,  type: "urban" },
  { id: "ph",       name: "Port Harcourt", state: "Rivers",    river: "Bonny estuary – rainfall-driven",          lat: 4.820,  lon: 7.030,  type: "urban" }
];

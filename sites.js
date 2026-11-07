// Monitored flood hotspots. Coordinates sit on or beside the main river channel
// so the GloFAS grid cell picks up the river rather than a dry hillside.
// type: "river" = large-river (fluvial) flooding; "urban" = flash/pluvial flooding risk too.
window.NFA_SITES = [
  { id: "lokoja",   name: "Lokoja",        state: "Kogi",      river: "Niger–Benue confluence", lat: 7.800,  lon: 6.740,  type: "river" },
  { id: "makurdi",  name: "Makurdi",       state: "Benue",     river: "River Benue",            lat: 7.740,  lon: 8.530,  type: "river" },
  { id: "yola",     name: "Yola",          state: "Adamawa",   river: "River Benue",            lat: 9.210,  lon: 12.480, type: "river" },
  { id: "onitsha",  name: "Onitsha",       state: "Anambra",   river: "River Niger",            lat: 6.150,  lon: 6.770,  type: "river" },
  { id: "ibaji",    name: "Ibaji",         state: "Kogi",      river: "River Niger",            lat: 6.850,  lon: 6.760,  type: "river" },
  { id: "yenagoa",  name: "Yenagoa",       state: "Bayelsa",   river: "Nun / Epie Creek",       lat: 4.930,  lon: 6.260,  type: "river" },
  { id: "jebba",    name: "Jebba",         state: "Kwara",     river: "River Niger",            lat: 9.140,  lon: 4.820,  type: "river" },
  { id: "hadejia",  name: "Hadejia",       state: "Jigawa",    river: "Hadejia River",          lat: 12.450, lon: 10.040, type: "river" },
  { id: "maidug",   name: "Maiduguri",     state: "Borno",     river: "River Ngadda",           lat: 11.850, lon: 13.160, type: "urban" },
  { id: "abuja",    name: "Abuja (FCT)",   state: "FCT",       river: "Wupa / Usuma",           lat: 9.020,  lon: 7.420,  type: "urban" },
  { id: "lagos",    name: "Lagos (Lekki)", state: "Lagos",     river: "Lagos Lagoon catchment", lat: 6.450,  lon: 3.600,  type: "urban" },
  { id: "ibadan",   name: "Ibadan",        state: "Oyo",       river: "Ogunpa / Ona",           lat: 7.380,  lon: 3.930,  type: "urban" },
  { id: "ph",       name: "Port Harcourt", state: "Rivers",    river: "Bonny estuary",          lat: 4.820,  lon: 7.030,  type: "urban" }
];

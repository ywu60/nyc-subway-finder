// NYC subway services with official MTA route colors.
// `id` must match the codes produced by scripts/prepare_stations.py.

export const ROUTES = [
  { id: "1", label: "1", name: "Broadway–7 Av Local", color: "#EE352E", text: "#FFFFFF" },
  { id: "2", label: "2", name: "7 Av Express", color: "#EE352E", text: "#FFFFFF" },
  { id: "3", label: "3", name: "7 Av Express", color: "#EE352E", text: "#FFFFFF" },
  { id: "4", label: "4", name: "Lexington Av Express", color: "#00933C", text: "#FFFFFF" },
  { id: "5", label: "5", name: "Lexington Av Express", color: "#00933C", text: "#FFFFFF" },
  { id: "6", label: "6", name: "Lexington Av Local", color: "#00933C", text: "#FFFFFF" },
  { id: "7", label: "7", name: "Flushing Local", color: "#B933AD", text: "#FFFFFF" },
  { id: "A", label: "A", name: "8 Av Express", color: "#0039A6", text: "#FFFFFF" },
  { id: "C", label: "C", name: "8 Av Local", color: "#0039A6", text: "#FFFFFF" },
  { id: "E", label: "E", name: "8 Av Local", color: "#0039A6", text: "#FFFFFF" },
  { id: "B", label: "B", name: "6 Av Express", color: "#FF6319", text: "#FFFFFF" },
  { id: "D", label: "D", name: "6 Av Express", color: "#FF6319", text: "#FFFFFF" },
  { id: "F", label: "F", name: "6 Av Local", color: "#FF6319", text: "#FFFFFF" },
  { id: "M", label: "M", name: "6 Av Local", color: "#FF6319", text: "#FFFFFF" },
  { id: "G", label: "G", name: "Brooklyn–Queens Crosstown", color: "#6CBE45", text: "#FFFFFF" },
  { id: "J", label: "J", name: "Nassau St", color: "#996633", text: "#FFFFFF" },
  { id: "Z", label: "Z", name: "Nassau St Express", color: "#996633", text: "#FFFFFF" },
  { id: "L", label: "L", name: "14 St–Canarsie Local", color: "#A7A9AC", text: "#000000" },
  { id: "N", label: "N", name: "Broadway Express", color: "#FCCC0A", text: "#000000" },
  { id: "Q", label: "Q", name: "Broadway Express", color: "#FCCC0A", text: "#000000" },
  { id: "R", label: "R", name: "Broadway Local", color: "#FCCC0A", text: "#000000" },
  { id: "W", label: "W", name: "Broadway Local", color: "#FCCC0A", text: "#000000" },
  { id: "GS", label: "S", sub: "42 St", name: "42 St Shuttle", color: "#808183", text: "#FFFFFF" },
  { id: "FS", label: "S", sub: "Franklin", name: "Franklin Av Shuttle", color: "#808183", text: "#FFFFFF" },
  { id: "H", label: "S", sub: "Rockaway", name: "Rockaway Park Shuttle", color: "#808183", text: "#FFFFFF" },
  { id: "SI", label: "SIR", name: "Staten Island Railway", color: "#0039A6", text: "#FFFFFF" },
];

const BY_ID = new Map(ROUTES.map((r) => [r.id, r]));

export function getRoute(id) {
  return BY_ID.get(id) || null;
}

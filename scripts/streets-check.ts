/**
 * The street names near a point (ticket #48): the Overpass query, and the nearest named streets of an answer.
 *   npm run streets:check
 */
import { strict as assert } from "assert";
import { mergeStreets, nearestStreets, nominatimReverseUrl, streetFromNominatim, streetsQuery, type StreetsData } from "../src/lib/osm/streets";

// a point in central Cluj, and three streets around it (lat/lon offsets of ~1e-4° ≈ 11 m north, 7.6 m east)
const lat = 46.77, lon = 23.59;
const way = (id: number, name: string | undefined, highway: string, pts: [number, number][]) => ({
  type: "way", id, tags: { highway, ...(name ? { name } : {}) }, geometry: pts.map(([dLat, dLon]) => ({ lat: lat + dLat, lon: lon + dLon })),
});
const data: StreetsData = {
  elements: [
    // Strada Constanța: an east–west line 0.0003° (≈ 33 m) north of the point, in two ways
    way(1, "Strada Constanța", "secondary", [[0.0003, -0.002], [0.0003, 0]]),
    way(2, "Strada Constanța", "secondary", [[0.0003, 0], [0.0003, 0.002]]),
    // Piața Avram Iancu: a north–south line 0.0001° (≈ 7.6 m) east of the point
    way(3, "Piața Avram Iancu", "primary", [[-0.001, 0.0001], [0.001, 0.0001]]),
    // far away, and one with no name
    way(4, "Strada Departe", "residential", [[0.0015, 0.0015], [0.0016, 0.0016]]),
    way(5, undefined, "residential", [[0, -0.00001], [0, 0.00001]]),
    { type: "node", id: 9, tags: { name: "a shop" } },
  ],
};

const near = nearestStreets(data, lat, lon);
assert.deepEqual(near.map(s => s.name), ["Piața Avram Iancu", "Strada Constanța", "Strada Departe"]);
assert.ok(Math.abs(near[0].distance - 7.6) < 0.3, `Avram Iancu at ${near[0].distance} m`);
assert.ok(Math.abs(near[1].distance - 33.4) < 0.5, `Constanța at ${near[1].distance} m`);
assert.equal(near[0].kind, "primary");
assert.equal(near[0].wayId, 3);
// one entry per street, at its nearest way; `max` caps the list; an empty answer gives none
assert.equal(near.filter(s => s.name === "Strada Constanța").length, 1);
assert.equal(nearestStreets(data, lat, lon, 1).length, 1);
assert.deepEqual(nearestStreets({ elements: [] }, lat, lon), []);
// beyond the end of a street, the distance is to its end point
const end = nearestStreets({ elements: [way(6, "Strada Scurtă", "residential", [[0, 0.0002], [0, 0.0004]])] }, lat, lon)[0];
assert.ok(Math.abs(end.distance - 15.2) < 0.3, `to the end: ${end.distance} m`);

const q = streetsQuery(lat, lon, 150);
assert.match(q, /^\[out:json\]\[timeout:15\];way\(around:150,46\.770000,23\.590000\)\["highway"~"\^\(motorway\|/);
assert.match(q, /\["name"\];out tags geom;$/);
assert.ok(!/footway|path|steps|track/.test(q));

// Nominatim: the street itself (its line), an address's road (its point), or nothing
const avram = streetFromNominatim({
  osm_type: "way", osm_id: 3, category: "highway", type: "primary", name: "Piața Avram Iancu",
  geojson: { type: "LineString", coordinates: [[lon + 0.0001, lat - 0.001], [lon + 0.0001, lat + 0.001]] },
}, lat, lon)!;
assert.equal(avram.name, "Piața Avram Iancu");
assert.ok(Math.abs(avram.distance - 7.6) < 0.3, `nominatim line at ${avram.distance} m`);
assert.equal(avram.kind, "primary");
const road = streetFromNominatim({ category: "building", type: "house", name: "Casa X", lat: String(lat + 0.0003), lon: String(lon), address: { road: "Strada Constanța" } }, lat, lon)!;
assert.equal(road.name, "Strada Constanța");
assert.ok(Math.abs(road.distance - 33.4) < 0.5);
assert.equal(streetFromNominatim({ category: "place", type: "city", name: "Cluj" }, lat, lon), null);
// a street in two pieces: measured to each piece, not across the gap between them
const split = streetFromNominatim({ category: "highway", type: "residential", name: "Strada Ruptă", geojson: { type: "MultiLineString", coordinates: [
  [[lon - 0.002, lat - 0.0005], [lon - 0.001, lat - 0.0005]], [[lon + 0.001, lat + 0.0005], [lon + 0.002, lat + 0.0005]],
] } }, lat, lon)!;
assert.ok(split.distance > 80, `pieces apart: ${split.distance} m`);
assert.match(nominatimReverseUrl(lat, lon), /reverse\?format=jsonv2&lat=46\.770000&lon=23\.590000&zoom=17&polygon_geojson=1/);
// merged: one per name, nearest first
const merged = mergeStreets([{ ...road, distance: 40 }], near);
assert.deepEqual(merged.map(s => s.name), ["Piața Avram Iancu", "Strada Constanța", "Strada Departe"]);
assert.ok(Math.abs(merged[1].distance - 33.4) < 0.5);

console.log("streets check: ok");

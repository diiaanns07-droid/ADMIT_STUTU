"""Label specification for civic-v1 message topics (CONTRACT.txt section 6).

The label is a *sorting hint* for an editor queue. It never encodes urgency,
the responsible organisation or an official commitment of the akimat.
"""

LABELS = (
    "roads",
    "sidewalks",
    "transport_stops",
    "lighting",
    "landscaping",
    "other",
)

# Short operational definitions; the full guide is annotation_guide.txt.
LABEL_DEFINITIONS = {
    "roads": "Carriageway for vehicles: potholes, asphalt, road markings, road signs, "
             "traffic lights, snow/ice on the carriageway, road repair works.",
    "sidewalks": "Pedestrian surfaces next to roads: sidewalks, footpaths, curbs, ramps, "
                 "tactile tiles, snow/ice on sidewalks.",
    "transport_stops": "Public transport stops as infrastructure: shelters, benches and "
                       "displays at stops, boarding areas, stop signage.",
    "lighting": "Outdoor lighting: street lamps, lighting poles, courtyard and park lights.",
    "landscaping": "Greenery and public space furnishing: trees, lawns, flower beds, "
                   "playgrounds, benches outside stops, park improvements.",
    "other": "Everything else: utilities, noise, waste collection, transport *service* "
             "(delays, drivers), parking enforcement, stray animals, thanks, questions.",
}

LANGUAGES = ("ru", "kk")

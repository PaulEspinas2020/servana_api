/**
 * Address Search Service — Google Places API proxy
 *
 * Proxies address autocomplete to the Google Places API server-side so that
 * the API key is never exposed in the Angular bundle or browser network tab.
 *
 * Search strategy (dual-type parallel requests):
 *   Request A — types=geocode:      streets, routes, premises (buildings), neighbourhoods,
 *                                   postal codes, subpremises, intersections
 *   Request B — types=establishment: condominiums, malls, offices, businesses by name
 *
 * Both requests run in parallel with the same session token.  Results are merged
 * and deduplicated so a single result set covers both address-intent and
 * building-name-intent queries.
 *
 * Location bias: Metro Manila centre (14.5995, 120.9842), 50 km radius.
 * This is a bias (not a restriction) — addresses anywhere in the Philippines
 * can still appear; it only boosts NCR-area relevance as a sensible default.
 *
 * All traffic is scoped to the Philippines (components=country:ph).
 * Web-only: mobile does not call these endpoints.
 *
 * NOTE: avoid ?. and ?? operators — esm 3.2.25 cannot parse ES2020 syntax.
 */

import axios from "axios";

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

// Metro Manila geographic centre used as location bias for autocomplete.
// This biases (not restricts) results toward NCR where most Servana operations
// are concentrated.  A 50 km radius covers all of NCR plus nearby provinces.
const BIAS_LAT = "14.5995";
const BIAS_LON = "120.9842";
const BIAS_RADIUS = 50000; // metres

// Maximum suggestions returned per page from Google (5 is the API default max).
// We fetch 5 per type and take up to 6 after merging.
const GOOGLE_MAX_PREDICTIONS = 5;
const MERGED_MAX_RESULTS = 6;

// ── Types returned to the controller ─────────────────────────────────────────

export interface AddressSuggestion {
  id: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
  types: string[];
  provider: "google";
}

export interface ResolvedAddress {
  externalPlaceId: string;
  displayName: string;
  formattedAddress: string;
  addressOne: string;
  postTown: string;
  province: string;
  zipCode: string;
  country: string;
  latitude: number;
  longitude: number;
  servanaLocationId: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildServanaLocationId(lat: number, lon: number): string {
  return "loc_" + lat.toFixed(6) + "_" + lon.toFixed(6);
}

function extractAddressComponent(
  components: any[],
  types: string[],
  useShortName?: boolean
): string {
  for (var i = 0; i < components.length; i++) {
    var c = components[i];
    for (var j = 0; j < types.length; j++) {
      if (c.types && c.types.indexOf(types[j]) !== -1) {
        return (useShortName ? c.short_name : c.long_name) || "";
      }
    }
  }
  return "";
}

/**
 * Fetch one page of autocomplete predictions for a specific `types` filter.
 * Never throws — returns {predictions, ok} so caller can handle partial
 * failures gracefully (one type call failing should not kill the other).
 */
async function fetchAutocompletePage(
  query: string,
  sessionToken: string,
  apiKey: string,
  types: string
): Promise<{ predictions: any[]; ok: boolean }> {
  try {
    var resp = await axios.get(PLACES_BASE + "/autocomplete/json", {
      params: {
        input: query,
        key: apiKey,
        sessiontoken: sessionToken,
        components: "country:ph",
        language: "en",
        types: types,
        location: BIAS_LAT + "," + BIAS_LON,
        radius: BIAS_RADIUS,
      },
      timeout: 8000,
    });

    var status: string =
      resp.data && resp.data.status ? resp.data.status : "UNKNOWN_ERROR";

    if (status === "ZERO_RESULTS") {
      return { predictions: [], ok: true };
    }

    if (status === "OK") {
      var preds: any[] =
        resp.data && resp.data.predictions ? resp.data.predictions : [];
      return { predictions: preds.slice(0, GOOGLE_MAX_PREDICTIONS), ok: true };
    }

    // Non-OK, non-ZERO_RESULTS — log and return empty rather than throwing so
    // the other parallel request can still contribute results.
    var errMsg: string =
      resp.data && resp.data.error_message ? resp.data.error_message : "";
    console.error(
      "[addressSearchService] autocomplete(types=" +
        types +
        ") status:",
      status,
      errMsg || "(no error_message)"
    );
    return { predictions: [], ok: false };
  } catch (err: any) {
    console.error(
      "[addressSearchService] autocomplete(types=" + types + ") network error:",
      err && err.message
    );
    return { predictions: [], ok: false };
  }
}

function predictionToSuggestion(p: any): AddressSuggestion {
  var structured = p.structured_formatting || {};
  var primaryText: string = structured.main_text || p.description || "";
  var secondaryText: string = structured.secondary_text || "";
  return {
    id: p.place_id || "",
    primaryText: primaryText,
    secondaryText: secondaryText,
    fullText: p.description || "",
    types: p.types || [],
    provider: "google" as const,
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Return up to MERGED_MAX_RESULTS Philippine address suggestions for `query`.
 *
 * Makes two parallel requests:
 *   - types=geocode      → streets, routes, buildings (premise/subpremise),
 *                          neighbourhoods, postal codes
 *   - types=establishment → condominiums, offices, malls, businesses by name
 *
 * Results are merged with geocode first, then establishment-only extras.
 * Deduplication is by place_id.
 *
 * If both calls fail, throws so the controller returns a 502 (retry UI shown).
 * If only one call fails, the other's results are returned silently.
 */
export async function getSuggestions(
  query: string,
  sessionToken: string
): Promise<AddressSuggestion[]> {
  var apiKey = process.env.GOOGLE_PLACES_SERVER_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_SERVER_API_KEY is not configured");
  }

  var results = await Promise.all([
    fetchAutocompletePage(query, sessionToken, apiKey, "geocode"),
    fetchAutocompletePage(query, sessionToken, apiKey, "establishment"),
  ]);

  var geocodeResult = results[0];
  var establishResult = results[1];

  // Both failed → surface as an error so the UI shows the retry state.
  if (!geocodeResult.ok && !establishResult.ok) {
    throw new Error("Google Places autocomplete temporarily unavailable");
  }

  // Merge: geocode first (better for street/address intent), then any
  // establishment entries not already present (better for building-name intent).
  var seenPlaceIds: { [id: string]: boolean } = {};
  var merged: any[] = [];

  var i: number;
  for (i = 0; i < geocodeResult.predictions.length; i++) {
    var gp = geocodeResult.predictions[i];
    var gid: string = gp.place_id || "";
    if (gid && !seenPlaceIds[gid]) {
      seenPlaceIds[gid] = true;
      merged.push(gp);
    }
  }

  for (i = 0; i < establishResult.predictions.length; i++) {
    var ep = establishResult.predictions[i];
    var eid: string = ep.place_id || "";
    if (eid && !seenPlaceIds[eid]) {
      seenPlaceIds[eid] = true;
      merged.push(ep);
    }
  }

  return merged.slice(0, MERGED_MAX_RESULTS).map(predictionToSuggestion);
}

export async function resolveAddress(
  placeId: string,
  sessionToken: string
): Promise<ResolvedAddress | null> {
  var apiKey = process.env.GOOGLE_PLACES_SERVER_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_SERVER_API_KEY is not configured");
  }

  var resp = await axios.get(PLACES_BASE + "/details/json", {
    params: {
      place_id: placeId,
      key: apiKey,
      sessiontoken: sessionToken,
      fields: "name,formatted_address,address_components,geometry",
      language: "en",
    },
    timeout: 8000,
  });

  var detailStatus: string =
    resp.data && resp.data.status ? resp.data.status : "UNKNOWN_ERROR";

  if (detailStatus === "ZERO_RESULTS" || detailStatus === "NOT_FOUND") {
    return null;
  }

  if (detailStatus !== "OK") {
    var detailErrMsg: string =
      resp.data && resp.data.error_message ? resp.data.error_message : "";
    console.error(
      "[addressSearchService] resolveAddress status:",
      detailStatus,
      detailErrMsg || "(no error_message)"
    );
    throw new Error(
      "Google Places details error: " +
        detailStatus +
        (detailErrMsg ? " — " + detailErrMsg : "")
    );
  }

  var result = resp.data && resp.data.result ? resp.data.result : null;
  if (!result) {
    return null;
  }

  var components: any[] = result.address_components || [];
  var geometry = result.geometry || {};
  var location = geometry.location || {};
  var lat: number = location.lat || 0;
  var lon: number = location.lng || 0;

  // Build addressOne: street_number + route, or fallback to name
  var streetNumber = extractAddressComponent(components, ["street_number"]);
  var route = extractAddressComponent(components, ["route"]);
  var name: string = result.name || "";
  var addressOne: string;
  if (streetNumber && route) {
    addressOne = streetNumber + " " + route;
  } else if (route) {
    addressOne = route;
  } else if (name) {
    addressOne = name;
  } else {
    addressOne = "";
  }
  // Prepend building/establishment name if distinct from route
  if (name && name !== route && name !== addressOne) {
    addressOne = name + (addressOne ? ", " + addressOne : "");
  }

  // PH city/municipality resolution fallback chain:
  // 1. locality                  — NCR cities (Quezon City, Makati, Pasig…)
  // 2. administrative_area_level_3 — provincial municipalities (Taguig, Carmona…)
  // 3. sublocality_level_1       — barangay/district when city component missing (BGC…)
  // 4. administrative_area_level_2 — province or Metro Manila as last resort
  var postTown = extractAddressComponent(components, [
    "locality",
    "administrative_area_level_3",
    "sublocality_level_1",
    "administrative_area_level_2",
  ]);
  var province = extractAddressComponent(components, [
    "administrative_area_level_1",
    "administrative_area_level_2",
  ]);
  var zipCode = extractAddressComponent(components, ["postal_code"]);
  var country = extractAddressComponent(components, ["country"], true); // short_name = ISO code

  return {
    externalPlaceId: placeId,
    displayName: name || postTown || "",
    formattedAddress: result.formatted_address || "",
    addressOne: addressOne,
    postTown: postTown,
    province: province,
    zipCode: zipCode,
    country: country || "PH",
    latitude: lat,
    longitude: lon,
    servanaLocationId: buildServanaLocationId(lat, lon),
  };
}

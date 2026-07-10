/**
 * Address Search Service — Google Places API proxy
 *
 * Proxies address autocomplete to the Google Places API server-side so that
 * the API key is never exposed in the Angular bundle or browser network tab.
 *
 * All traffic is scoped to the Philippines (components=country:ph).
 * Web-only: mobile does not call these endpoints.
 *
 * NOTE: avoid ?. and ?? operators — esm 3.2.25 cannot parse ES2020 syntax.
 */

import axios from "axios";

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildServanaLocationId(lat: number, lon: number): string {
  return "loc_" + lat.toFixed(6) + "_" + lon.toFixed(6);
}

function extractAddressComponent(
  components: any[],
  types: string[]
): string {
  for (var i = 0; i < components.length; i++) {
    var c = components[i];
    for (var j = 0; j < types.length; j++) {
      if (c.types && c.types.indexOf(types[j]) !== -1) {
        return c.long_name || "";
      }
    }
  }
  return "";
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function getSuggestions(
  query: string,
  sessionToken: string
): Promise<AddressSuggestion[]> {
  const apiKey = process.env.GOOGLE_PLACES_SERVER_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_SERVER_API_KEY is not configured");
  }

  const resp = await axios.get(PLACES_BASE + "/autocomplete/json", {
    params: {
      input: query,
      key: apiKey,
      sessiontoken: sessionToken,
      components: "country:ph",
      language: "en",
      // No types param — omitting is safer; geocode|establishment is an invalid
      // combination for Legacy Autocomplete and causes INVALID_REQUEST responses.
    },
    timeout: 8000,
  });

  var status: string = (resp.data && resp.data.status) ? resp.data.status : "UNKNOWN_ERROR";

  if (status === "ZERO_RESULTS") {
    return [];
  }

  if (status !== "OK") {
    var errMsg: string = (resp.data && resp.data.error_message) ? resp.data.error_message : "";
    console.error("[addressSearchService] getSuggestions status:", status, errMsg || "(no error_message)");
    throw new Error("Google Places autocomplete error: " + status + (errMsg ? " — " + errMsg : ""));
  }

  const predictions: any[] =
    resp.data && resp.data.predictions ? resp.data.predictions : [];

  return predictions.slice(0, 5).map(function (p: any) {
    var structured = p.structured_formatting || {};
    var primaryText: string =
      structured.main_text || p.description || "";
    var secondaryText: string =
      structured.secondary_text || "";
    return {
      id: p.place_id || "",
      primaryText: primaryText,
      secondaryText: secondaryText,
      fullText: p.description || "",
      types: p.types || [],
      provider: "google" as const,
    };
  });
}

export async function resolveAddress(
  placeId: string,
  sessionToken: string
): Promise<ResolvedAddress | null> {
  const apiKey = process.env.GOOGLE_PLACES_SERVER_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_SERVER_API_KEY is not configured");
  }

  const resp = await axios.get(PLACES_BASE + "/details/json", {
    params: {
      place_id: placeId,
      key: apiKey,
      sessiontoken: sessionToken,
      fields: "name,formatted_address,address_components,geometry",
      language: "en",
    },
    timeout: 8000,
  });

  var detailStatus: string = (resp.data && resp.data.status) ? resp.data.status : "UNKNOWN_ERROR";

  if (detailStatus === "ZERO_RESULTS" || detailStatus === "NOT_FOUND") {
    return null;
  }

  if (detailStatus !== "OK") {
    var detailErrMsg: string = (resp.data && resp.data.error_message) ? resp.data.error_message : "";
    console.error("[addressSearchService] resolveAddress status:", detailStatus, detailErrMsg || "(no error_message)");
    throw new Error("Google Places details error: " + detailStatus + (detailErrMsg ? " — " + detailErrMsg : ""));
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

  var postTown = extractAddressComponent(components, [
    "locality",
    "administrative_area_level_3",
  ]);
  var province = extractAddressComponent(components, [
    "administrative_area_level_1",
    "administrative_area_level_2",
  ]);
  var zipCode = extractAddressComponent(components, ["postal_code"]);
  var country = extractAddressComponent(components, ["country"]);

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

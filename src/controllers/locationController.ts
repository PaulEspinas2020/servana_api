/**
 * Location Controller — address autocomplete proxy
 *
 * Proxies Google Places address suggestions and detail resolution server-side
 * so the API key is never exposed to the browser.
 *
 * Routes:
 *   GET /api/location/address-suggestions?q=&sessionToken=
 *   GET /api/location/address-details/:placeId?sessionToken=
 *
 * Both require a valid provider JWT (verifyAuth).
 * Web-only: mobile does not call these endpoints.
 *
 * NOTE: avoid ?. and ?? operators — esm 3.2.25 cannot parse ES2020 syntax.
 */

import { Request, Response } from "express";
import * as addressSearchService from "../services/addressSearchService";

const MIN_QUERY_LENGTH = 3;

export const getAddressSuggestions = async (req: Request, res: Response) => {
  try {
    var q: string = typeof req.query.q === "string" ? req.query.q.trim() : "";
    var sessionToken: string =
      typeof req.query.sessionToken === "string"
        ? req.query.sessionToken.trim()
        : "";

    if (!q || q.length < MIN_QUERY_LENGTH) {
      return res.status(200).json({ data: { suggestions: [] } });
    }

    if (!sessionToken) {
      return res
        .status(400)
        .json({ status: "failed", message: "sessionToken is required" });
    }

    var suggestions = await addressSearchService.getSuggestions(q, sessionToken);
    return res.status(200).json({ data: { suggestions: suggestions } });
  } catch (error: any) {
    console.error("[locationController] getAddressSuggestions error:", error && error.message);
    return res
      .status(502)
      .json({ status: "failed", message: "Address search is temporarily unavailable" });
  }
};

export const getAddressDetails = async (req: Request, res: Response) => {
  try {
    var placeId: string =
      typeof req.params.placeId === "string" ? req.params.placeId.trim() : "";
    var sessionToken: string =
      typeof req.query.sessionToken === "string"
        ? req.query.sessionToken.trim()
        : "";

    if (!placeId) {
      return res
        .status(400)
        .json({ status: "failed", message: "placeId is required" });
    }

    if (!sessionToken) {
      return res
        .status(400)
        .json({ status: "failed", message: "sessionToken is required" });
    }

    var result = await addressSearchService.resolveAddress(placeId, sessionToken);
    if (!result) {
      return res
        .status(404)
        .json({ status: "failed", message: "Address not found" });
    }

    return res.status(200).json({ data: { result: result } });
  } catch (error: any) {
    console.error("[locationController] getAddressDetails error:", error && error.message);
    return res
      .status(502)
      .json({ status: "failed", message: "Address resolution is temporarily unavailable" });
  }
};

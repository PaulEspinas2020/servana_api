/**
 * GET /provider/calendar — the endpoint ServanaWorker's Calendar tab has been
 * calling since it shipped, against a route that did not exist.
 *
 * Identity comes from the verified token only. The mobile client's own comment
 * on this call states "no provider id is accepted on the wire", and §7/§11 say
 * the same: a uid in a query string is an identifier, not authorization.
 */

import { Request, Response } from 'express';
import { getProviderCalendar, parseCalendarQuery } from '../services/providerCalendarService';

export const getCalendar = async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  let query;
  try {
    query = parseCalendarQuery({
      start: req.query.start,
      end: req.query.end,
      eventTypes: req.query.eventTypes,
    });
  } catch (error: any) {
    // Validation errors are safe by construction — they are written for the
    // person holding the phone (§21).
    return res.status(error?.statusCode ?? 400).json({
      success: false,
      code: error?.code ?? 'CALENDAR_RANGE_INVALID',
      message: error?.message ?? 'That date range is not valid.',
    });
  }

  try {
    const data = await getProviderCalendar(uid, query);
    return res.json({ status: 'success', data });
  } catch {
    // Nothing from the query layer reaches the client: a calendar failure must
    // not leak a table name or a constraint (§21).
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

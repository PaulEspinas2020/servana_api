import { Request, Response, NextFunction } from "express";
import { firebaseAdmin } from "../middleware/firebaseApp";

import { tempId } from "../config";
import { getAuth as getAuthAdmin } from 'firebase-admin/auth'

const defaultAuthAdmin = getAuthAdmin(firebaseAdmin);

const validateFirebaseIdToken = async (req: Request, res: Response, next: NextFunction) => {
  if (!tempId) {
    if (
      (!req.headers.authorization ||
        !req.headers.authorization.startsWith("Bearer ")) &&
      !(req.cookies && req.cookies.__session)
    ) {
      res.status(403).send("Unauthorized");
      return;
    }

    let idToken;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      idToken = req.headers.authorization.split("Bearer ")[1];
    } else if (req.cookies) {
      idToken = req.cookies.__session;
    } else {
      res.status(403).send("Unauthorized");
      return;
    }

    try {
      const decodedIdToken = await defaultAuthAdmin.verifyIdToken(idToken);
      req.user = decodedIdToken;
      next();
      return;
    } catch (error: any) {
      if (error.code === "auth/id-token-expired") {
        res.status(403).send("Token Expired. Login again.");
        return;
      }
      res.status(403).send(error);
      return;
    }
  } else {
    req['user'] = {
      uid: tempId
    }
    next();
    return;
  }
};

export default validateFirebaseIdToken;

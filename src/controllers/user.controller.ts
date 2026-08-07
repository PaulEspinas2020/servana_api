import { Request, Response, NextFunction } from "express";
import { status, buildSuccess, sendFailure } from "../helpers/status";
import * as userService from "../services/user.service";
import * as authService from "../services/auth.service";
import * as addressService from "../services/address.service";
import { createLogEntry } from "../services/log.service";
import * as notificationService from "../services/notification.service";

const userList = async (req: Request, res: Response) => {
    const { isArchived } = req.query;
    let role: string = req.query.role as string;

    let roles;
    try {
        roles = !role ? [2, 3] : [parseInt(role)];
        const dbResponse = await userService.getAllUserByRole([2, 3], isArchived == "true");

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.userList', error);
    }
};
const addUserAddress = async (req: Request, res: Response) => {
    const { uid } = req.user;
    let dbResponse = null;
    try {
        if (req.body.addressId) {
            dbResponse = await addressService.updateUserAddress(req.body, uid, req.body.addressId);
        } else {
            dbResponse = await addressService.addUserAddress(req.body, uid);
        }

        // TODO logs

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.addUserAddress', error);
    }
};

const getAllAddressesOfUser = async (req: Request, res: Response) => {
    const { uid } = req.user;
    
    try {
        const role = await userService.getRoleById(uid);
        const dbResponse = await addressService.getAllAddressesOfUser(uid, role);

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.getAllAddressesOfUser', error);
    }
};

const getAddressByAddressId = async (req: Request, res: Response) => {
    const id = req.query.id as string;
    const { uid } = req.user;

    try {
        const dbResponse = await addressService.getAddressByAddressId(id);

        if (!dbResponse || dbResponse.userId !== uid) {
            return res.status(403).json({ status: "failed", message: "Access denied" });
        }

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.getAddressByAddressId', error);
    }
};

const getUserProfile = async (req: Request, res: Response) => {
    // Always read the authenticated user's own profile — never allow a query-param UID override.
    const id = req.user.uid;

    try {
        const dbResponse = await userService.getUserProfile(id);

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.getUserProfile', error);
    }
};

const updateUserProfile = async (req: Request, res: Response) => {
    const { uid } = req.user;

    try {
        // Provider identifiers are verified identity attributes, not ordinary
        // profile fields. Provider clients may edit names here for legacy
        // compatibility, but email/mobile changes must use a dedicated recent-
        // auth + verification workflow. Strip every known alias so a stale web
        // or mobile client cannot silently overwrite a verified identifier.
        const profileBody = { ...req.body };
        if ([2, 4].includes(Number(req.user?.role))) {
            delete profileBody.phoneNumber;
            delete profileBody.mobileNumber;
            delete profileBody.phone;
            delete profileBody.email;
        }
        // Always use the JWT uid as the profile owner (body.id may be absent or spoofed)
        const dbResponse = await userService.updateUserProfile({ ...profileBody, id: uid });

        await createLogEntry("Update", uid, dbResponse.id, "Profile");

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.updateUserProfile', error);
    }
};

const makeAddressPrimary = async (req: Request, res: Response) => {
    const { uid } = req.user;
    const addressId = req.query.addressId as string;

    try {
        const dbResponse = await addressService.makeAddressPrimary(addressId, uid);
        await addressService.makeOtherAddressNotPrimary(addressId, uid);

        await createLogEntry("Update", uid, dbResponse.addressId, "Address");

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.makeAddressPrimary', error);
    }
};

const deleteAddress = async (req: Request, res: Response) => {
    const { uid } = req.user;
    const addressId = req.query.addressId as string;

    try {
        const dbResponse = await addressService.deleteAddress(addressId, uid);

        await createLogEntry("Delete", uid, addressId, "Address");

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.deleteAddress', error);
    }
};

const archiveUser = async (req: Request, res: Response) => {
    const { uid } = req.user;
    const { userId } = req.params as { userId: string };

    // `false` used to be hardcoded here, so the handler named "archiveUser"
    // would have UN-archived had it ever reached a real row. The desired state
    // is an input; default true, because that is what the endpoint is called.
    const archived = req.body?.isArchived === undefined
        ? true
        : req.body.isArchived === true || req.body.isArchived === "true";

    if (!userId) {
        return res.status(400).send({
            status: "failed",
            message: "userId is required",
        });
    }

    try {
        const dbResponse = await authService.changeArchiveStatus(userId, archived);

        // Nothing matched: the uid does not exist. Answering 200 here is what
        // let a no-op look like a completed archive, and what put a fictitious
        // entry in the audit log (§20).
        if (!dbResponse || (Array.isArray(dbResponse) && dbResponse.length === 0)) {
            return res.status(404).send({
                status: "failed",
                message: "User not found",
            });
        }

        // Logged only after a row actually changed.
        await createLogEntry(archived ? "ARCHIVE" : "UNARCHIVE", uid, userId, "User");

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.archiveUser', error);
    }
};

const getAddressesByUserId = async (req: Request, res: Response) => {
    const { userId } = req.params as { userId: string };

    // Fail closed: the caller must be present AND match. Requiring req.user to
    // exist before comparing meant a tokenless call skipped ownership and read
    // another customer's saved addresses — their home address, in practice.
    // The route carries verifyAuth (user.route.ts:17), so this can only be
    // reached with a token; that is defence in depth, not redundancy, because
    // the identical shape elsewhere in this codebase turned out to be reachable.
    //
    // The "mobile parity" note that used to sit here was wrong: ServanaClient
    // sends a bearer token on every request (servana_api_client.dart:37-47).
    if (!req.user?.uid || req.user.uid !== userId) {
        return res.status(403).json({ status: "failed", message: "Access denied" });
    }

    try {
        const dbResponse = await addressService.getAddressesByUserId(userId);

        res.status(status.success).send(buildSuccess(dbResponse));
    } catch (error) {
        sendFailure(res, 'user.controller.getAddressesByUserId', error);
    }
};

// ─── FCM token management ─────────────────────────────────────────────────────

export const registerFcmToken = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    const token = ((req.body?.token ?? '') as string).trim();
    if (!token) {
        return res.status(400).json({ status: 'error', message: 'token is required' });
    }
    try {
        await authService.updateFcmToken(uid, token);
        return res.status(200).json({ status: 'success', data: { registered: true } });
    } catch (_) {
        return res.status(500).json({ status: 'error', message: 'Failed to register token' });
    }
};

export const clearCustomerFcmToken = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    try {
        await notificationService.clearFcmToken(uid);
    } catch (_) {
        // Best-effort — always succeed so logout is not blocked
    }
    return res.status(200).json({ status: 'success', data: { cleared: true } });
};

// ─── Customer notifications ───────────────────────────────────────────────────

export const listCustomerNotificationsHandler = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    const filter = req.query.filter as string | undefined;
    try {
        const notifications = await notificationService.listCustomerNotifications(uid, filter);
        return res.status(200).json({ status: 'success', data: { notifications } });
    } catch (_) {
        return res.status(500).json({ status: 'error', message: 'Failed to load notifications' });
    }
};

export const countCustomerUnreadHandler = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    try {
        const count = await notificationService.countCustomerUnreadNotifications(uid);
        return res.status(200).json({ status: 'success', data: { count } });
    } catch (_) {
        return res.status(500).json({ status: 'error', message: 'Failed to count notifications' });
    }
};

export const markCustomerNotificationReadHandler = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    const key = req.params.key as string;
    if (!key) {
        return res.status(400).json({ status: 'error', message: 'key is required' });
    }
    try {
        const result = await notificationService.markCustomerNotificationReadByKey(uid, key);
        return res.status(200).json({ status: 'success', data: result });
    } catch (_) {
        return res.status(500).json({ status: 'error', message: 'Failed to mark read' });
    }
};

export const markAllCustomerNotificationsReadHandler = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    try {
        await notificationService.markAllCustomerNotificationsRead(uid);
        return res.status(200).json({ status: 'success', data: { marked: true } });
    } catch (_) {
        return res.status(500).json({ status: 'error', message: 'Failed to mark all read' });
    }
};

export const deleteCustomerNotificationHandler = async (req: Request, res: Response) => {
    const uid: string = (req as any).user?.uid;
    const key = req.params.key as string;
    if (!key) {
        return res.status(400).json({ status: 'error', message: 'key is required' });
    }
    try {
        const result = await notificationService.deleteCustomerNotificationByKey(uid, key);
        return res.status(result.found ? 200 : 404).json({
            status: result.found ? 'success' : 'error',
            data: result,
        });
    } catch (_) {
        return res.status(500).json({ status: 'error', message: 'Failed to delete notification' });
    }
};

export {
    userList,
    addUserAddress,
    getAllAddressesOfUser,
    getAddressByAddressId,
    getAddressesByUserId,
    getUserProfile,
    updateUserProfile,
    makeAddressPrimary,
    deleteAddress,
    archiveUser,
};

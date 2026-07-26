import { Request, Response, NextFunction } from "express";
import { successMessage, errorMessage, status } from "../helpers/status";
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

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "" + error;
        res.status(status.error).send(errorMessage);
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

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const getAllAddressesOfUser = async (req: Request, res: Response) => {
    const { uid } = req.user;
    
    try {
        const role = await userService.getRoleById(uid);
        const dbResponse = await addressService.getAllAddressesOfUser(uid, role);

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
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

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const getUserProfile = async (req: Request, res: Response) => {
    // Always read the authenticated user's own profile — never allow a query-param UID override.
    const id = req.user.uid;

    try {
        const dbResponse = await userService.getUserProfile(id);

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const updateUserProfile = async (req: Request, res: Response) => {
    const { uid } = req.user;

    try {
        // Always use the JWT uid as the profile owner (body.id may be absent or spoofed)
        const dbResponse = await userService.updateUserProfile({ ...req.body, id: uid });

        await createLogEntry("Update", uid, dbResponse.id, "Profile");

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const makeAddressPrimary = async (req: Request, res: Response) => {
    const { uid } = req.user;
    const addressId = req.query.addressId as string;

    try {
        const dbResponse = await addressService.makeAddressPrimary(addressId, uid);
        await addressService.makeOtherAddressNotPrimary(addressId, uid);

        await createLogEntry("Update", uid, dbResponse.addressId, "Address");

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const deleteAddress = async (req: Request, res: Response) => {
    const { uid } = req.user;
    const addressId = req.query.addressId as string;

    try {
        const dbResponse = await addressService.deleteAddress(addressId, uid);

        await createLogEntry("Delete", uid, addressId, "Address");

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const archiveUser = async (req: Request, res: Response) => {
    const { uid } = req.user;
    const { userId } = req.params as { userId: string };

    try {
        const dbResponse = await authService.changeArchiveStatus(userId, false);

        await createLogEntry("ARCHIVE", uid, userId, "User");

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const getAddressesByUserId = async (req: Request, res: Response) => {
    const { userId } = req.params as { userId: string };

    // When the caller is authenticated (browser session), enforce ownership.
    // Unauthenticated calls pass through for mobile parity.
    if (req.user && req.user.uid !== userId) {
        return res.status(403).json({ status: "failed", message: "Access denied" });
    }

    try {
        const dbResponse = await addressService.getAddressesByUserId(userId);

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
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

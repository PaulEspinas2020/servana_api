import { Request, Response, NextFunction } from "express";
import { successMessage, errorMessage, status } from "../helpers/status";
import * as userService from "../services/user.service";
import * as authService from "../services/auth.service";
import * as addressService from "../services/address.service";
import { createLogEntry } from "../services/log.service";

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
        console.log("Getting all addresses of user", uid, "with role", role);
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

    try {
        const dbResponse = await addressService.getAddressByAddressId(id);

        successMessage.data = dbResponse;
        res.status(status.success).send(successMessage);
    } catch (error) {
        errorMessage.error = "ERROR: " + error;
        res.status(status.error).send(errorMessage);
    }
};

const getUserProfile = async (req: Request, res: Response) => {
    const id = req.query.id as string;

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
        const dbResponse = await userService.updateUserProfile(req.body);

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
        const dbResponse = await addressService.makeAddressPrimary(addressId);
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
        const dbResponse = await addressService.deleteAddress(addressId);

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

export {
    userList,
    addUserAddress,
    getAllAddressesOfUser,
    getAddressByAddressId,
    getUserProfile,
    updateUserProfile,
    makeAddressPrimary,
    deleteAddress,
    archiveUser,
};

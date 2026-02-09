import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { secret } from "../config";

/**
 * Hash Password Method
 * @param {string} password
 * @returns {string} returns hashed password
 */
const saltRounds = 10;
const salt = bcrypt.genSaltSync(saltRounds);
const hashPassword = (password: string) => bcrypt.hashSync(password, salt);

/**
 * comparePassword
 * @param {string} hashPassword
 * @param {string} password
 * @returns {Boolean} return True or False
 */
const comparePassword = (hashedPassword: string | undefined, password: string) => {
    if(hashedPassword) return bcrypt.compareSync(password, hashedPassword);
};

/**
 * isValidEmail helper method
 * @param {string} email
 * @returns {Boolean} True or False
 */
const isValidEmail = (email: string) => {
    const regEx = /\S+@\S+\.\S+/;
    return regEx.test(email);
};

/**
 * validatePassword helper method
 * @param {string} password
 * @returns {Boolean} True or False
 */
const validatePassword = (password: string) => {
    if (password.length <= 6 || password === "") {
        return false;
    }
    return true;
};
/**
 * isEmpty helper method
 * @param {string, integer} input
 * @returns {Boolean} True or False
 */
const isEmpty = (input: string | null) => {
    if (input === undefined || input === "" || !input) {
        return true;
    }
    if (input && input.toString().replace(/\s/g, "").length != 0) {
        return false;
    }
    return true;
};

/**
 * empty helper method
 * @param {string, integer} input
 * @returns {Boolean} True or False
 */
const empty = (input: string | null) => {
    if (input === undefined || input === "") {
        return true;
    }
};

/**
 * Generate Token
 * @param {string} id
 * @returns {string} token
 */

const generateUserToken = (uid: string, email:string, firstname: string, lastname: string, is_activated: boolean) => {
    try {
        const envSecret = secret ? secret: "nosecret";
        const token = jwt.sign(
            {
                uid,
                email,
                firstname,
                lastname,
                is_activated,
            },
            envSecret,
            { expiresIn: "24h" }
        );

        return token;
    } catch (err) {
        console.log(err);
    }
};

export { hashPassword, comparePassword, isValidEmail, validatePassword, isEmpty, empty, generateUserToken };

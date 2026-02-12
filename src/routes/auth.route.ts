import express from 'express'
const router = express.Router()
import * as authController from '../controllers/auth.controller';

router.post("/auth/signup", authController.signup);
router.post("/auth/signin", authController.signin);
router.get("/auth/resendverification", authController.resendVerification);


export default router;

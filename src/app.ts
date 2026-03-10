import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import formidable from "formidable";

import dotenv from "dotenv";

dotenv.config();

const app = express();
const router = express.Router();
const whitelist = ["http://localhost:4200"];
const corsOptionsDelegate = function (req: any, callback: any) {
    var corsOptions;
    if (whitelist.indexOf(req.header("Origin")) !== -1) {
        corsOptions = { origin: true }; // reflect (enable) the requested origin in the CORS response
    } else {
        corsOptions = { origin: false }; // disable CORS for this request
    }
    callback(null, corsOptions); // callback expects two parameters: error and options
};

const port = process.env.PORT;
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(cors())
app.use(cookieParser());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.is("multipart/form-data") == "multipart/form-data") {
        const form = formidable({ multiples: true, maxFileSize: 15 * 1024 * 1024 });
        form.parse(req, (error, fields, files) => {
            if (error) {
                next(error);
            } else {
                (req as any).fields = fields;
                (req as any).files = Object.values(files);
                next();
            }
        });
    } else {
        next();
    }
});

app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.timezone = req.get("TimeZone") !== undefined ? req.get("TimeZone") : "UTC";
    next();
});

app.get("/hello", (req: Request, res: Response) => {
    res.json({ message: "Hello, from router!" });
});

import authRoute from "./routes/auth.route";
app.use("/api", cors(corsOptionsDelegate), authRoute);

import userRoute from "./routes/user.route";
app.use("/api", cors(corsOptionsDelegate), userRoute);

import serviceRoute from "./routes/service.route";
app.use("/api", cors(corsOptionsDelegate), serviceRoute);

import pricingRoutes from "./routes/pricing.routes";
app.use("/api", cors(corsOptionsDelegate), pricingRoutes);

import bookingRoutes from "./routes/booking.routes";
app.use("/api", cors(corsOptionsDelegate), bookingRoutes);

import technicianRoutes from "./routes/technician.routes";
app.use("/api", cors(corsOptionsDelegate), technicianRoutes);

import paymentRoutes from "./routes/payment.routes";
app.use("/api", cors(corsOptionsDelegate), paymentRoutes);


app.listen(port, () => {
    console.log(`Magic is running on port ${port}`);
});

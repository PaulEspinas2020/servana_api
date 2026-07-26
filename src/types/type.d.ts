declare global {
    namespace Express {
        interface Request {
            user: any;
            id: string;
        }
        interface Response {
            user: any;
        }
    }

    interface UserCredentials {
        id: string;
        email: string;
        password?: string;
        firstName: string
        lastName: string;
        role: number;
        isArchived: boolean;
        isEmailVerified?: boolean;
        createdDate: Date;
        phoneNumber?: string | null;
        fcmToken?: string;
    }

    interface UserCredentialsReq {
        uid?: string;
        email: string;
        password: string;
        firstName: string;
        lastName: string;
        role: number;
        phoneNumber?: string | null;
        isEmailVerified: boolean;
        isPhoneVerified: boolean;
        platform?: "web" | "mobile";
        serviceIds?: string[];
    }

    interface UserAddressReq {
        userId: string;
        locationId: string;
        addressOne: string;
        addressTwo: string;
        zipCode: string;
        postTown: string;
        country: string;
        lat: number;
        lon: number;
        label: string;
        isPrimary: boolean;
    }

    interface UserAddress {
        addressId: string;
        userId: string;
        locationId: string;
        addressOne: string;
        addressTwo: string;
        zipCode: string;
        postTown: string;
        country: string;
        lat: number;
        lon: number;
        label: string;
        isPrimary: boolean;
    }

    interface ProfileUpdateReq {
        id: string | undefined;
        birthdate?: string;
        photoUrl?: string;
        photoFile?: string;
        gender?: string;
        phoneNumber?: string;
        mobileNumber?: string;   // ServanaClient alias for phoneNumber
        first_name?: string;     // provider portal direct field
        last_name?: string;      // provider portal direct field
        fullname?: string;       // ServanaClient combined name — split on write
    }

    interface QuoteRequest {
        optionId: number;
        hpKey?: string;        // "1.5hp"
        heightKey?: string;    // "2nd_floor"
        distanceKey?: string;  // "5-10km"
        addonOptionIds?: number[];
        parts?: { part_name: string; qty: number; unit_price: number }[];
    };
}

export { };

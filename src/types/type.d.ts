declare global {
    namespace Express {
        interface Request {
            user: any;
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
        createdDate: Date;
        phoneNumber?: number;
    }

    interface UserCredentialsReq {
        uid?: string;
        email: string;
        password: string;
        firstName: string;
        lastName: string;
        role: number;
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
    }
}

export {};

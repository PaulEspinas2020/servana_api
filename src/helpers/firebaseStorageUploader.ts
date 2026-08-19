import { firebaseConfig } from "../config";
import { randomUUID } from "crypto";

// Storage credentials are needed only when a storage operation actually runs.
// Eagerly importing firebaseApp made unrelated backend modules and unit tests
// require a production service-account file merely because they imported a
// service that happened to reference this helper.
const getStorageBucket = async () => {
    const { getFirebaseAdmin } = await import("../middleware/firebaseApp");
    return getFirebaseAdmin().storage().bucket(firebaseConfig.storageBucket);
};

export interface PrivateStoredFile {
    storagePath: string;
    mimeType: string;
    byteSize: number;
}

/**
 * Stores a protected provider file without a Firebase download token or public
 * ACL. The database stores only storagePath; callers must mint a short-lived
 * signed URL after re-authorizing the provider on every preview request.
 */
export const uploadPrivateFileToStorage = async (
    folder: string,
    fileName: string,
    dataUri: string,
): Promise<PrivateStoredFile> => {
    const mimeType = dataUri.slice(dataUri.indexOf(":") + 1, dataUri.indexOf(";"));
    const extension = mimeType === "application/pdf" ? "pdf" : mimeType.split("/").pop() || "bin";
    const base64String = dataUri.slice(dataUri.indexOf(",") + 1);
    const buffer = Buffer.from(base64String, "base64");
    const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, "_");
    const safeName = fileName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const storagePath = `${safeFolder}/${safeName}.${extension}`;
    const bucket = await getStorageBucket();

    await bucket.file(storagePath).save(buffer, {
        resumable: false,
        validation: "crc32c",
        metadata: {
            contentType: mimeType,
            cacheControl: "private, no-store, max-age=0",
            metadata: {
                servanaVisibility: "private",
            },
        },
    });

    return { storagePath, mimeType, byteSize: buffer.length };
};

export const createPrivatePreviewUrl = async (
    storagePath: string,
    ttlSeconds = 300,
): Promise<{ url: string; expiresAt: string }> => {
    if (!storagePath || storagePath.includes("..") || storagePath.startsWith("/")) {
        throw Object.assign(new Error("Invalid private storage reference"), { statusCode: 422 });
    }
    const boundedTtl = Math.max(30, Math.min(ttlSeconds, 300));
    const expiresAt = new Date(Date.now() + boundedTtl * 1000);
    const bucket = await getStorageBucket();
    const [url] = await bucket.file(storagePath).getSignedUrl({
        action: "read",
        expires: expiresAt,
    });
    return { url, expiresAt: expiresAt.toISOString() };
};

export const deletePrivateStoredFile = async (storagePath: string): Promise<void> => {
    if (!storagePath || storagePath.includes("..") || storagePath.startsWith("/")) return;
    const bucket = await getStorageBucket();
    await bucket.file(storagePath).delete({ ignoreNotFound: true });
};

/** Publishes an immutable, approved public-profile asset. Never use for documents. */
export const publishApprovedProfileMedia = async (
    privateStoragePath: string,
    providerUid: string,
    submissionId: string,
    mimeType: string,
): Promise<{ storagePath: string; url: string }> => {
    if (!privateStoragePath || privateStoragePath.includes("..") || privateStoragePath.startsWith("/")) {
        throw Object.assign(new Error("Invalid private storage reference"), { statusCode: 422 });
    }
    const bucket = await getStorageBucket();
    const extension = mimeType.split('/').pop() || 'jpg';
    const storagePath = `provider-public-profile/${providerUid}/${submissionId}.${extension}`;
    const token = randomUUID();
    await bucket.file(privateStoragePath).copy(bucket.file(storagePath));
    await bucket.file(storagePath).setMetadata({
        contentType: mimeType,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { firebaseStorageDownloadTokens: token, servanaVisibility: 'public-profile' },
    });
    return {
        storagePath,
        url: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`,
    };
};

export const uploadFileToStorage = async (folder: string, fileName: string, dataUri: string): Promise<string> => {
    const bucket = await getStorageBucket();
    return new Promise((resolve, reject) => {
        const mimeType = dataUri.slice(dataUri.indexOf(":") + 1, dataUri.indexOf(";"));
        const extension = mimeType.split("/").pop() || "bin";
        const base64String = dataUri.split(",")[1];
        const buffer = Buffer.from(base64String, "base64");

        const filePath = `${folder}/${fileName}.${extension}`;
        const file = bucket.file(filePath);

        // Embed a download token in the file metadata. Firebase Storage CDN honours
        // firebaseStorageDownloadTokens — the resulting URL works without requiring
        // bucket-level allUsers IAM or per-object ACLs, so it is safe under Uniform
        // bucket-level access policies.
        const downloadToken = randomUUID();
        file.save(buffer, {
            metadata: {
                contentType: mimeType,
                metadata: { firebaseStorageDownloadTokens: downloadToken },
            },
        }, (error) => {
            if (error) {
                console.error(`[Storage] upload failed folder=${folder} file=${fileName}:`, error.message ?? error);
                reject(error);
                return;
            }
            // Firebase Storage download URL — token-authenticated, no IAM dependency.
            const encodedPath = encodeURIComponent(filePath);
            const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
            resolve(downloadUrl);
        });
    });
};

const uploadInStorage = async (folder: string, fileName: string, uploadedFile: any) => {
    const bucket = await getStorageBucket();
    return new Promise((resolve, reject) => {
        const imgType = uploadedFile.slice(uploadedFile.indexOf(":") + 1, uploadedFile.indexOf(";"));

        // const base64 = uploadedFile.slice(uploadedFile.indexOf(",") + 1);
        //   const blob = base64StringToBlob(base64, imgType)
        const base64String = uploadedFile.split(",")[1];
        const buffer = Buffer.from(base64String, "base64");
        const imgExtension = uploadedFile.substring("data:image/".length, uploadedFile.indexOf(";base64"));

        const file = bucket.file(`${folder}/${fileName}.${imgExtension}`);
        const metadata = {
            contentType: imgType,
        };

        file.save(
            buffer,
            {
                metadata,
                public: true, // Optional: If you want the file to be publicly accessible
            },
            (error) => {
                if (error) {
                    console.error("Error uploading file:", error);
                } else {
                    file.getSignedUrl({
                        action: "read",
                        expires: "01-17-2027", // Set expiration date for the URL
                    })
                        .then((urls) => {
                            resolve(urls[0])
                        })
                        .catch((err) => {
                            console.error("Error generating URL:", err);
                            reject(err)
                        });
                }
            }
        );
    });
};

export default uploadInStorage;

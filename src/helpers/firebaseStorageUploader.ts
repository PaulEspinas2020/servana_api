import { firebaseAdmin } from "../middleware/firebaseApp";
import { firebaseConfig } from "../config";
import { randomUUID } from "crypto";

export const uploadFileToStorage = (folder: string, fileName: string, dataUri: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const mimeType = dataUri.slice(dataUri.indexOf(":") + 1, dataUri.indexOf(";"));
        const extension = mimeType.split("/").pop() || "bin";
        const base64String = dataUri.split(",")[1];
        const buffer = Buffer.from(base64String, "base64");

        const bucket = firebaseAdmin.storage().bucket(firebaseConfig.storageBucket);
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

const uploadInStorage = (folder: string, fileName: string, uploadedFile: any) =>
    new Promise((resolve, reject) => {
        console.log("Uploading image ...");

        const imgType = uploadedFile.slice(uploadedFile.indexOf(":") + 1, uploadedFile.indexOf(";"));

        // const base64 = uploadedFile.slice(uploadedFile.indexOf(",") + 1);
        const bucket = firebaseAdmin.storage().bucket(firebaseConfig.storageBucket);

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
                    console.log("File uploaded successfully.");

                    file.getSignedUrl({
                        action: "read",
                        expires: "01-17-2027", // Set expiration date for the URL
                    })
                        .then((urls) => {
                            console.log("Public URL:", urls[0]);
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

export default uploadInStorage;

import { firebaseAdmin } from "../middleware/firebaseApp";
import { firebaseConfig } from "../config";

export const uploadFileToStorage = (folder: string, fileName: string, dataUri: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const mimeType = dataUri.slice(dataUri.indexOf(":") + 1, dataUri.indexOf(";"));
        const extension = mimeType.split("/").pop() || "bin";
        const base64String = dataUri.split(",")[1];
        const buffer = Buffer.from(base64String, "base64");

        const bucket = firebaseAdmin.storage().bucket(firebaseConfig.storageBucket);
        const file = bucket.file(`${folder}/${fileName}.${extension}`);

        // Do NOT pass { public: true } — buckets with "Uniform bucket-level access" reject
        // per-object ACL operations and the save call fails with a 403.
        // Public read access is controlled at the bucket level via IAM (allUsers → Storage Object Viewer).
        file.save(buffer, { metadata: { contentType: mimeType } }, (error) => {
            if (error) {
                console.error(`[Storage] upload failed folder=${folder} file=${fileName}:`, error.message ?? error);
                reject(error);
                return;
            }
            // Public URL accessible when the bucket IAM grants allUsers Storage Object Viewer.
            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;
            resolve(publicUrl);
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

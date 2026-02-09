import { firebaseAdmin } from "../middleware/firebaseApp";

const uploadInStorage = (folder: string, fileName: string, uploadedFile: any) =>
    new Promise((resolve, reject) => {
        console.log("Uploading image ...");

        const imgType = uploadedFile.slice(uploadedFile.indexOf(":") + 1, uploadedFile.indexOf(";"));

        // const base64 = uploadedFile.slice(uploadedFile.indexOf(",") + 1);
        const bucket = firebaseAdmin.storage().bucket();

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

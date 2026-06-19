require("dotenv").config({ path: __dirname + "/../.env" });
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

console.log("Cloud name:", cloudinary.config().cloud_name);
console.log("API key:", cloudinary.config().api_key);

cloudinary.api.ping((err, result) => {
  if (err) {
    console.error("Cloudinary connection FAILED:", err.message);
    process.exit(1);
  }
  console.log("Cloudinary connection OK:", result);
});

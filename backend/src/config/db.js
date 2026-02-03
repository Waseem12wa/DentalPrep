const mongoose = require("mongoose");

const connectDb = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is not set");
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    autoIndex: true
  });
};

module.exports = connectDb;

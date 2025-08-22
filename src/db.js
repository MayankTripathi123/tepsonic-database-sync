// src/db.js
// MongoDB (Mongoose) setup and Product model with a normalized schema
import mongoose from "mongoose";
import config from "./config.js";

export async function initDb() {
  if (mongoose.connection.readyState === 1) return; // already connected
  mongoose.set("strictQuery", true);
  await mongoose.connect(config.mongoUri, {
    // options can be expanded as needed
  });
}

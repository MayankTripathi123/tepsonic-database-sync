import dotenv from "dotenv";
dotenv.config();

const env =
  process.env.NODE_ENV?.toLowerCase() === "production"
    ? "production"
    : "development";

const base = {
  env,
  port: Number(process.env.PORT || 3000),
  syncToDb: (process.env.SYNC_TO_DB || "true").toLowerCase() === "true",
  defaultVendor: process.env.DEFAULT_VENDOR || "wholesalerA",
  cachePrefix: process.env.CACHE_PREFIX || "product-service:",
  mongoUri:
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/product_service",
  vendorApiBaseUrl:
    process.env.VENDOR_API_BASE_URL || "https://api.example-vendor.com",
};

const perEnv = {
  development: {
    cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 15 * 60), // 15 minutes
  },
  production: {
    cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 5 * 60), // 5 minutes
  },
};

const config = { ...base, ...perEnv[env] };

export default config;

import express from "express";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";

const router = express.Router();
const dbName = process.env.DB_NAME;
const uri = process.env.MONGODB_URI;
let client;

async function getClient() {
  if (!client) {
    console.log("🟢 Connecting to MongoDB...");
    client = new MongoClient(uri);
    await client.connect();
    console.log("✅ MongoDB connected");
  }
  return client;
}

// ----------------- HELPER FUNCTIONS -----------------

// Helper function to find existing product only (no creation)
async function findExistingProduct(productData, adminProductsCollection) {
  const name = `${productData.manufacturer || ""} ${
    productData.model || ""
  }`.trim();

  console.log(`🔍 Searching for: "${name}"`);

  // Try exact match first
  let product = await adminProductsCollection.findOne({
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  });

  if (product) {
    console.log(`✅ Exact match found: "${product.name}"`);
    return product;
  }

  // If not found, try partial match
  if (name.length > 3) {
    product = await adminProductsCollection.findOne({
      name: { $regex: escapeRegex(name), $options: "i" },
    });

    if (product) {
      console.log(`✅ Partial match found: "${product.name}" for "${name}"`);
    } else {
      console.log(`❌ No match found for: "${name}"`);
    }
  }

  return product;
}

// Helper function to escape regex special characters
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupItemsByProductAndCondition(items) {
  const grouped = new Map();
  items.forEach((item) => {
    const product = item.product_variation?.product || {};
    const variation = item.product_variation || {};
    const productKey = `${product.manufacturer || ""}_${
      product.model || ""
    }`.trim();
    const conditionKey = variation.grade || "Unknown";
    const groupKey = `${productKey}_${conditionKey}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        product,
        variation,
        condition: conditionKey,
        items: [],
      });
    }
    grouped.get(groupKey).items.push(item);
  });
  return grouped;
}

// Function to create selected options for Wholecell
// Function to create selected options for Wholecell with proper storage+RAM format
async function createSelectedOptionsForWholecell(
  items,
  adminProductsCollection
) {
  const optionsMap = new Map();

  // Helper function to find matching storage+RAM for a given capacity
  function findMatchingStorageSpec(storageSpec, capacity) {
    if (!storageSpec || !capacity) return "Unknown";

    // Split the storage specification into individual options
    const storageOptions = storageSpec.split(", ");

    // Find the option that matches the capacity
    for (const option of storageOptions) {
      if (option.includes(`${capacity}GB`)) {
        return option; // Return the full storage+RAM string
      }
    }

    // If not found, try with just the number (without GB)
    for (const option of storageOptions) {
      if (option.includes(capacity)) {
        return option;
      }
    }

    return "Unknown";
  }

  // Pre-fetch all admin products needed for these items
  const productNames = items
    .filter((item) => item.status === "Available")
    .map((item) => {
      const product = item.product_variation?.product || {};
      return `${product.manufacturer || ""} ${product.model || ""}`.trim();
    })
    .filter((name) => name);

  const adminProducts = await adminProductsCollection
    .find({
      name: { $in: productNames },
    })
    .toArray();

  // Create a map for quick lookup
  const adminProductMap = new Map();
  adminProducts.forEach((product) => {
    adminProductMap.set(product.name.toLowerCase(), product);
  });

  for (const item of items) {
    // Only process available items
    if (item.status !== "Available") continue;

    const product = item.product_variation?.product || {};
    const variation = item.product_variation || {};

    const color = product.color || "Unknown";
    const capacity = product.capacity || ""; // This could be "128", "256", etc.

    // Get the product name to find the matching admin product
    const productName = `${product.manufacturer || ""} ${
      product.model || ""
    }`.trim();
    const adminProduct = adminProductMap.get(productName.toLowerCase());

    let variant;
    if (capacity && adminProduct?.specifications?.storage) {
      // Extract the exact storage+RAM specification that matches this capacity
      variant = findMatchingStorageSpec(
        adminProduct.specifications.storage,
        capacity
      );
    } else if (capacity) {
      // Fallback if no admin product or storage spec found
      variant = `${capacity}GB 4GB RAM`;
    } else {
      variant = "Unknown";
    }

    const optionKey = `${color}_${variant}`;

    if (!optionsMap.has(optionKey)) {
      // Convert cents to dollars and set same value for discount
      const priceInDollars = Math.round(
        (Number(item.total_price_paid) || 0) / 100
      );

      optionsMap.set(optionKey, {
        color,
        variant, // This will now be "128GB 4GB RAM" exactly as in specifications
        stock: 0,
        price: priceInDollars,
        discount: priceInDollars,
        uniqueNumbers: [],
        _id: new ObjectId(),
      });
    }

    const option = optionsMap.get(optionKey);
    option.stock += 1;
    option.uniqueNumbers.push(
      item.esn || item.hex_id || variation.sku || `item_${item.id}`
    );
  }

  return Array.from(optionsMap.values());
}

// Function to merge selected options (combine stock from multiple syncs)
function mergeSelectedOptions(existingOptions, newOptions) {
  const merged = new Map();

  // Add existing options
  existingOptions.forEach((opt) => {
    const key = `${opt.color}_${opt.variant}`;
    merged.set(key, { ...opt });
  });

  // Merge new options
  newOptions.forEach((opt) => {
    const key = `${opt.color}_${opt.variant}`;
    if (merged.has(key)) {
      const existing = merged.get(key);
      existing.stock += opt.stock;
      existing.uniqueNumbers = [
        ...existing.uniqueNumbers,
        ...opt.uniqueNumbers,
      ];
      // Use lower price (both are already in dollars)
      existing.price = Math.min(existing.price, opt.price);
      // For Wholecell, set discount same as price
      existing.discount = existing.price;
    } else {
      merged.set(key, { ...opt });
    }
  });

  return Array.from(merged.values());
}

// ----------------- SYNC FUNCTION FOR WHOLECELL -----------------

async function syncWholecellVendor(vendorApi, db) {
  const vendorProductsCollection = db.collection("tep_vendor_products");
  const adminProductsCollection = db.collection("tep_admin_products");
  const fixedConditionId = new ObjectId("682f3e63402c8b0c279cba1e");

  // Build auth header
  const authHeader =
    "Basic " +
    Buffer.from(`${vendorApi.appId}:${vendorApi.appSecret}`).toString("base64");
  const resp = await axios.get(`${process.env.VENDOR_API_BASE_URL}`, {
    headers: { Accept: "application/json", Authorization: authHeader },
  });

  const vendorItems = Array.isArray(resp.data.data) ? resp.data.data : [];
  console.log(`✅ Wholecell: fetched ${vendorItems.length} items`);

  // Group items by product and condition
  const groupedItems = groupItemsByProductAndCondition(vendorItems);

  // STEP 1: Filter only products that exist in tep_admin_products
  const validGroups = new Map();
  let skippedProducts = 0;

  for (const [groupKey, groupData] of groupedItems.entries()) {
    const existingProduct = await findExistingProduct(
      groupData.product,
      adminProductsCollection
    );

    if (existingProduct) {
      validGroups.set(groupKey, { ...groupData, existingProduct });
      console.log(`✅ Found existing product: ${existingProduct.name}`);
    } else {
      skippedProducts++;
      console.log(
        `⚠️ Skipped non-existing product: ${groupData.product.manufacturer} ${groupData.product.model}`
      );
    }
  }

  console.log(
    `📊 Processing ${validGroups.size} valid products, skipped ${skippedProducts} products`
  );

  // STEP 2: Process only valid products (NO UPDATES to admin products)
  const bulkOps = [];
  let newVendorProducts = 0;
  let updatedVendorProducts = 0;
  let totalStockProcessed = 0;

  for (const [groupKey, groupData] of validGroups.entries()) {
    try {
      const { existingProduct } = groupData;
      const selectedOptions = await createSelectedOptionsForWholecell(
        groupData.items,
        adminProductsCollection
      );
      console.log("SelectedOptions", selectedOptions);

      // Skip if no valid stock options
      if (
        !selectedOptions.length ||
        selectedOptions.every((opt) => opt.stock === 0)
      ) {
        continue;
      }

      // STEP 3: Create/Update vendor product entry with reference to admin product
      const existing = await vendorProductsCollection.findOne({
        vendorId: vendorApi.vendorId,
        product: existingProduct._id,
        condition: fixedConditionId,
      });

      const vendorProductData = {
        vendorId: vendorApi.vendorId,
        product: existingProduct._id, // Reference to existing admin product
        condition: fixedConditionId,
        selectedOptions,
        database: "wholecell", // Database identifier
        updatedAt: new Date(),
      };

      if (existing) {
        // Merge stock with existing options instead of replacing
        const mergedOptions = mergeSelectedOptions(
          existing.selectedOptions,
          selectedOptions
        );
        vendorProductData.selectedOptions = mergedOptions;

        updatedVendorProducts++;
        bulkOps.push({
          updateOne: {
            filter: {
              vendorId: vendorApi.vendorId,
              product: existingProduct._id,
              condition: fixedConditionId,
            },
            update: { $set: vendorProductData },
          },
        });
      } else {
        newVendorProducts++;
        bulkOps.push({
          insertOne: {
            document: { ...vendorProductData, createdAt: new Date() },
          },
        });
      }

      // Count total stock processed
      totalStockProcessed += selectedOptions.reduce(
        (sum, opt) => sum + opt.stock,
        0
      );
    } catch (err) {
      console.error(`❌ Error processing Wholecell group ${groupKey}:`, err);
    }
  }

  // Execute bulk operations
  if (bulkOps.length) {
    await vendorProductsCollection.bulkWrite(bulkOps, { ordered: false });
  }

  return {
    vendorId: vendorApi.vendorId.toString(),
    database: "wholecell",
    totalFetched: vendorItems.length,
    validProducts: validGroups.size,
    skippedProducts,
    newVendorProducts,
    updatedVendorProducts,
    totalStockProcessed,
    totalOperations: bulkOps.length,
  };
}

// ----------------- MAIN ROUTE -----------------

router.get("/", async (req, res) => {
  try {
    console.log("🚀 Starting sync for all vendors...");
    const client = await getClient();
    const db = client.db(dbName);

    // fetch all vendors from tep_admin_wholesale_apis
    const vendorApis = await db
      .collection("tep_admin_wholesale_apis")
      .find({})
      .toArray();

    // For vendors without database field, set it to "wholecell"
    const updatedVendorApis = await Promise.all(
      vendorApis.map(async (api) => {
        if (!api.database) {
          console.log(
            `🔄 Setting database field to "wholecell" for vendor ${api.vendorId}`
          );
          await db
            .collection("tep_admin_wholesale_apis")
            .updateOne({ _id: api._id }, { $set: { database: "wholecell" } });
          return { ...api, database: "wholecell" };
        }
        return api;
      })
    );

    console.log(`📡 Found ${updatedVendorApis.length} vendor API configs`);

    // For Wholecell vendors, use the new sync function
    const results = await Promise.allSettled(
      updatedVendorApis.map((api) => {
        if (api.database === "wholecell") {
          console.log(`🏥 Using Wholecell sync for vendor ${api.vendorId}`);
          return syncWholecellVendor(api, db);
        } else {
          console.log(
            `❌ No sync function for vendor ${api.vendorId} with database ${api.database}`
          );
          return Promise.resolve({
            vendorId: api.vendorId.toString(),
            database: api.database,
            error: "No sync function available for this database type",
          });
        }
      })
    );

    const summary = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return r.value;
      }
      return {
        vendorId: updatedVendorApis[i].vendorId.toString(),
        database: updatedVendorApis[i].database || "default",
        error: r.reason?.message || "Failed",
      };
    });

    res.json({
      message: "Vendor sync complete",
      summary,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Sync error", err);
    res.status(500).json({
      error: "Failed to sync vendors",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Route to sync only Wholecell vendors
router.get("/wholecell", async (req, res) => {
  try {
    console.log("🏥 Starting sync for Wholecell vendors only...");
    const client = await getClient();
    const db = client.db(dbName);

    // fetch only Wholecell vendors
    const vendorApis = await db
      .collection("tep_admin_wholesale_apis")
      .find({ database: "wholecell" })
      .toArray();
    console.log(`📡 Found ${vendorApis.length} Wholecell vendor API configs`);

    if (vendorApis.length === 0) {
      return res.json({
        message: "No Wholecell vendors found",
        summary: [],
        timestamp: new Date().toISOString(),
      });
    }

    // run all Wholecell vendors in parallel
    const results = await Promise.allSettled(
      vendorApis.map((api) => syncWholecellVendor(api, db))
    );

    const summary = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return r.value;
      }
      return {
        vendorId: vendorApis[i].vendorId.toString(),
        database: "wholecell",
        error: r.reason?.message || "Failed",
      };
    });

    res.json({
      message: "Wholecell vendor sync complete",
      summary,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Wholecell sync error", err);
    res.status(500).json({
      error: "Failed to sync Wholecell vendors",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;

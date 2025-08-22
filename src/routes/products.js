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

// ----------------- helper functions (same as your findOrCreateProduct, findOrCreateCondition, etc.) -----------------

async function findOrCreateProduct(productData, db) {
  const productsCollection = db.collection("tep_admin_products");
  const name = `${productData.manufacturer || ""} ${
    productData.model || ""
  }`.trim();

  let product = await productsCollection.findOne({
    name: { $regex: name, $options: "i" },
  });

  if (!product) {
    const newProduct = {
      name,
      manufacturer: productData.manufacturer || "Unknown",
      model: productData.model || "",
      category: productData.manufacturer || "Unknown",
      imagesByColor: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await productsCollection.insertOne(newProduct);
    product = { _id: result.insertedId, ...newProduct };
  }
  return product;
}

async function findOrCreateCondition(grade, db) {
  const conditionsCollection = db.collection("conditions");
  let condition = await conditionsCollection.findOne({
    name: { $regex: grade || "Unknown", $options: "i" },
  });

  if (!condition) {
    const newCondition = {
      name: grade || "Unknown",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await conditionsCollection.insertOne(newCondition);
    condition = { _id: result.insertedId, ...newCondition };
  }
  return condition;
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

function createSelectedOptions(items) {
  const optionsMap = new Map();
  items.forEach((item) => {
    const product = item.product_variation?.product || {};
    const variation = item.product_variation || {};
    const color = product.color || "Unknown";
    const capacity = product.capacity ? `${product.capacity}GB` : "";
    const variant = product.variant || capacity || "Standard";
    const optionKey = `${color}_${variant}`;
    if (!optionsMap.has(optionKey)) {
      optionsMap.set(optionKey, {
        color,
        variant,
        stock: 0,
        price: Number(item.total_price_paid) || 0,
        discount: 0,
        uniqueNumbers: [],
        _id: new ObjectId(),
      });
    }
    const option = optionsMap.get(optionKey);
    if (item.status !== "Sold") {
      option.stock += 1;
      option.uniqueNumbers.push(
        item.esn || item.hex_id || variation.sku || `item_${item.id}`
      );
    }
  });
  return Array.from(optionsMap.values());
}

// ----------------- SYNC FUNCTION (per vendor) -----------------

async function syncVendor(vendorApi, db) {
  const vendorProductsCollection = db.collection("tep_vendor_products");

  // build auth header from vendor API creds
  const authHeader =
    "Basic " +
    Buffer.from(`${vendorApi.appId}:${vendorApi.appSecret}`).toString("base64");

  console.log(authHeader);

  console.log(`🌍 Fetching items for vendorId=${vendorApi.vendorId}...`);
  const resp = await axios.get(`${process.env.VENDOR_API_BASE_URL}`, {
    headers: { Accept: "application/json", Authorization: authHeader },
  });

  const vendorItems = Array.isArray(resp.data.data) ? resp.data.data : [];
  console.log(
    `✅ Vendor ${vendorApi.vendorId}: fetched ${vendorItems.length} items`
  );

  // Group items
  const groupedItems = groupItemsByProductAndCondition(vendorItems);
  const bulkOps = [];
  let newVendorProducts = 0;
  let updatedVendorProducts = 0;
  let markedAsOutOfStock = 0;

  for (const [groupKey, groupData] of groupedItems.entries()) {
    try {
      const product = await findOrCreateProduct(groupData.product, db);
      const selectedOptions = createSelectedOptions(groupData.items);

      if (
        !selectedOptions.length ||
        selectedOptions.every((opt) => opt.stock === 0)
      ) {
        continue;
      }

      const existing = await vendorProductsCollection.findOne({
        vendorId: vendorApi.vendorId,
        product: product._id,
        condition: condition._id,
      });

      const vendorProductData = {
        vendorId: vendorApi.vendorId,
        product: product._id,
        condition: condition._id,
        selectedOptions,
        updatedAt: new Date(),
      };

      if (existing) {
        updatedVendorProducts++;
        bulkOps.push({
          updateOne: {
            filter: {
              vendorId: vendorApi.vendorId,
              product: product._id,
              condition: condition._id,
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
    } catch (err) {
      console.error(`❌ Error processing group ${groupKey}`, err);
    }
  }

  // mark out-of-stock
  const existingVendorProducts = await vendorProductsCollection
    .find({ vendorId: vendorApi.vendorId })
    .toArray();
  const currentCombinations = new Set();
  for (const [groupKey, groupData] of groupedItems.entries()) {
    const product = await findOrCreateProduct(groupData.product, db);
    currentCombinations.add(`${product._id}_${condition._id}`);
  }

  for (const existing of existingVendorProducts) {
    const key = `${existing.product}_${existing.condition}`;
    if (!currentCombinations.has(key)) {
      markedAsOutOfStock++;
      bulkOps.push({
        updateOne: {
          filter: { _id: existing._id },
          update: {
            $set: {
              selectedOptions: existing.selectedOptions.map((opt) => ({
                ...opt,
                stock: 0,
                uniqueNumbers: [],
              })),
              updatedAt: new Date(),
            },
          },
        },
      });
    }
  }

  if (bulkOps.length) {
    await vendorProductsCollection.bulkWrite(bulkOps, { ordered: false });
  }

  return {
    vendorId: vendorApi.vendorId.toString(),
    totalFetched: vendorItems.length,
    groupsProcessed: groupedItems.size,
    newVendorProducts,
    updatedVendorProducts,
    markedAsOutOfStock,
    totalOperations: bulkOps.length,
  };
}

// ----------------- ROUTE -----------------

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
    console.log(`📡 Found ${vendorApis.length} vendor API configs`);

    // run all vendors in parallel
    const results = await Promise.allSettled(
      vendorApis.map((api) => syncVendor(api, db))
    );

    const summary = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        vendorId: vendorApis[i].vendorId.toString(),
        error: r.reason?.message || "Failed",
      };
    });

    res.json({ message: "All vendor sync complete", summary });
  } catch (err) {
    console.error("❌ Sync error", err);
    res.status(500).json({ error: "Failed to sync vendors" });
  }
});

export default router;

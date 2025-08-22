import express from "express";
import axios from "axios";
import { MongoClient } from "mongodb";

const router = express.Router();
const dbName = process.env.DB_NAME;
const uri = process.env.MONGODB_URI;
let client;

// 🔌 Mongo client (singleton)
async function getClient() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client;
}

// 🛠 Enrich product with local images + normalize shape
async function enrichWithLocalImages(item, db) {
  const product = item.product_variation?.product || {};
  const variation = item.product_variation || {};

  const name = `${product.manufacturer || ""} ${product.model || ""} ${
    product.variant || ""
  }`.trim();

  // Lookup in local DB
  const localProduct = await db.collection("tep_admin_products").findOne({
    name: { $regex: name, $options: "i" },
  });

  // WholeCell color fallback
  const wholecellColorImages = product.color
    ? [
        {
          colorName: product.color,
          colorValue: product.color,
          images: [],
          _id: `wholecell-color-${item.id}`,
        },
      ]
    : [];

  const localColorImages = Array.isArray(localProduct?.imagesByColor)
    ? localProduct.imagesByColor
    : [];

  return {
    sku: String(item.product_variation.sku),
    productId: item.product_variation.product.id,
    vendor: "wholecell",
    name: `${product.manufacturer || ""} ${product.model || ""}`.trim(),
    title: `${product.manufacturer || ""} ${product.model || ""}`.trim(),
    description: `${product.variant ? product.variant + " " : ""}${
      product.capacity ? product.capacity + "GB " : ""
    }${product.network || ""}`.trim(),
    price: Number(item.total_price_paid) || 0,
    discount: 0,
    currency: "USD",
    stock: item.status === "Sold" ? 0 : 1,
    inStock: item.status !== "Sold",
    category: localProduct?.category || null,
    categories: [product.manufacturer || "Unknown"],
    brand: product.manufacturer,
    condition: variation.grade || localProduct?.condition || "Unknown",
    imagesByColor: [...wholecellColorImages, ...localColorImages],
    images: [],
    specifications: {
      storage: product.capacity ? `${product.capacity}GB` : null,
      _extra: {
        sku: variation.sku,
        network: product.network,
        variant: product.variant,
        grade: variation.grade,
        esn: item.esn,
        hex_id: item.hex_id,
        warehouse: item.warehouse?.name,
        location: item.location?.name,
        order_id: item.order_id,
        purchase_order_id: item.purchase_order_id,
      },
    },
    tags: [
      product.manufacturer,
      product.model,
      product.color,
      variation.grade,
      item.status,
    ].filter(Boolean),
    isFeatured: false,
    updatedAt: new Date(item.updated_at),
    createdAt: new Date(item.created_at),
  };
}

function aggregateStock(items) {
  const stockMap = {};
  items.forEach((item) => {
    const sku = item.product_variation.sku;
    if (!stockMap[sku]) {
      stockMap[sku] = {
        ...item,
        stock: 1,
      };
    } else {
      stockMap[sku].stock += 1;
    }
  });
  return Object.values(stockMap);
}

router.get("/", async (req, res) => {
  try {
    const vendorUrl =
      "https://api.wholecell.io/api/v1/inventories?status=Available";
    const authHeader =
      "Basic cUh3U2lSNENPdndiUkdpcmdCUk9LQVZoR2JMbGVaeHlQX1lGSExUQmFGaFE6RmJOQ3NibzVTcW80MVo5T3lCdWFtd3NkQUY1dlhQUnpLN2I5LXhVcHE5dlE=";

    // 1️⃣ Fetch vendor items
    const resp = await axios.get(vendorUrl, {
      headers: { Accept: "application/json", Authorization: authHeader },
    });
    const vendorItems = Array.isArray(resp.data.data) ? resp.data.data : [];
    const vendorList = aggregateStock(vendorItems);

    // 2️⃣ Connect DB
    const client = await getClient();
    const db = client.db(dbName);
    const productsCollection = db.collection("products");

    // Ensure index exists
    await productsCollection.createIndex(
      { externalId: 1, vendor: 1 },
      { unique: true, background: true }
    );

    // Load existing products for lookup
    const existingProducts = await productsCollection
      .find({}, { projection: { externalId: 1, stock: 1, updatedAt: 1 } })
      .toArray();

    const externalIdMap = new Map();
    existingProducts.forEach((p) => {
      externalIdMap.set(p.externalId, p);
    });

    // 3️⃣ Process incoming items
    const bulkOps = [];
    let newProducts = 0,
      updatedProducts = 0,
      markedAsOutOfStock = 0;

    const seenExternalIds = new Set();

    // Group by SKU
    const skuGroupedItems = new Map();
    for (const item of vendorList) {
      const sku = item?.product_variation?.sku;
      if (!sku) continue;
      if (!skuGroupedItems.has(sku)) {
        skuGroupedItems.set(sku, { ...item, totalStock: item.stock || 0 });
      } else {
        const existing = skuGroupedItems.get(sku);
        existing.totalStock += item.stock || 0;
      }
    }

    for (const [sku, mergedItem] of skuGroupedItems.entries()) {
      const normalized = await enrichWithLocalImages(mergedItem, db);

      if (
        normalized.stock <= 0 &&
        (!mergedItem.totalStock || mergedItem.totalStock <= 0)
      )
        continue;

      normalized.stock = mergedItem.totalStock;
      seenExternalIds.add(normalized.externalId);

      const existingById = externalIdMap.get(normalized.externalId);
      if (existingById) {
        updatedProducts++;
        bulkOps.push({
          updateOne: {
            filter: {
              externalId: normalized.externalId,
              vendor: normalized.vendor,
            },
            update: { $set: normalized },
            upsert: true,
          },
        });
      } else {
        newProducts++;
        bulkOps.push({ insertOne: { document: normalized } });
      }
    }

    // 4️⃣ Mark missing DB products as stock=0
    for (const existing of existingProducts) {
      if (!seenExternalIds.has(existing.externalId)) {
        markedAsOutOfStock++;
        bulkOps.push({
          updateOne: {
            filter: { externalId: existing.externalId },
            update: {
              $set: { stock: 0, inStock: false, updatedAt: new Date() },
            },
          },
        });
      }
    }

    // 5️⃣ Commit bulk operations
    if (bulkOps.length > 0) {
      await productsCollection.bulkWrite(bulkOps, { ordered: false });
    }

    res.json({
      message: "Products synced successfully",
      summary: {
        totalFetched: vendorList.length,
        newProducts,
        updatedProducts,
        markedAsOutOfStock,
        totalOperations: bulkOps.length,
      },
    });
  } catch (err) {
    console.error(
      "❌ GET /products error:",
      err?.response?.data || err?.message || err
    );
    res.status(500).json({ error: "Failed to sync products" });
  }
});

export default router;

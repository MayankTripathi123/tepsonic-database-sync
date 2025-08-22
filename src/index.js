import express from "express";
import morgan from "morgan";
import config from "./config.js";
import { initDb } from "./db.js";
import productsRoute from "./routes/products.js";

const app = express();

app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, env: config.env });
});

app.use("/products", productsRoute);

async function start() {
  try {
    await Promise.all([initDb()]);

    app.listen(config.port, () => {
      console.log(
        `Product service listening on port ${config.port} [env=${config.env}]`
      );
    });
  } catch (err) {
    console.error("Startup error:", err?.message || err);
    process.exit(1);
  }
}

start();

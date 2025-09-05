import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import pkg from "pg";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------
// Express + Postgres Backend API for Meat Delivery + Borzo Automation
// ---------------------------


const app = express();

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(bodyParser.json());



const { Pool } = pkg;



// Postgres connection pool (NeonDB)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false },
});

// Borzo API client (test environment)
const borzo = axios.create({
  baseURL: process.env.BORZO_BASE_URL || "https://robotapitest-in.borzodelivery.com/api/business/1.6",
  headers: {
    "X-DV-Auth-Token": process.env.BORZO_API_KEY,
    "Content-Type": "application/json",
  },

  //The api is working well on the curl request.
});

// ---------------------------
// Helpers
// ---------------------------

async function query(q, params) {
  const { rows } = await pool.query(q, params);
  return rows;
}

// ---------------------------
// Routes
// ---------------------------

// Products
app.get("/api/products", async (req, res) => {
  try {
    const rows = await query("SELECT * FROM products ORDER BY id ASC");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load products" });
  }
});

// Checkout (create order)
app.post("/api/cart/checkout", async (req, res) => {
  const { cart, address, payMethod, subtotal } = req.body;

  try {
    const order = await query(
      `INSERT INTO orders (customer_name, phone, address_line1, area, city, pincode, pay_method, subtotal, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED') RETURNING *`,
      [address.name, address.phone, address.line1, address.area, address.city, address.pincode, payMethod, subtotal]
    );

    const orderId = order[0].id;

    // insert items
    for (const item of cart) {
      await query(
        `INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1,$2,$3,$4)`,
        [orderId, item.id, item.qty, item.price]
      );
    }

    res.json({ id: orderId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Checkout failed" });
  }
});

// Borzo: create delivery task
app.post("/api/borzo/create-order", async (req, res) => {
  const { orderId, address, items } = req.body;

  try {
    const matter = items.map(i => `${i.qty}x ${i.name}`).join(", ");

    const payload = {
      type: "standard",
      matter,
      vehicle_type_id: 8,
      is_contact_person_notification_enabled: true,
      points: [
        {
          address: "Thane, Mumbai",
          contact_person: {
            phone: "+91-9999999999",
            name: "Vendor",
          },
        },
        {
          address: `${address.line1}, ${address.area}, ${address.city} ${address.pincode}`,
          contact_person: {
            phone: address.phone.startsWith("+91")
              ? address.phone
              : `+91${address.phone}`,
            name: address.name,
          },
          client_order_id: orderId.toString(),
          note: address.note || null,
        }
      ],
    };

    const { data } = await borzo.post("/create-order", payload);

    if (data.order_id) {
      await query(
        `INSERT INTO deliveries (order_id, porter_task_id, status, tracking_url, eta)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, data.order_id, data.status, data.tracking_url || null, data.payment_time || null]
      );
    }

    res.json(data);
  } catch (e) {
    console.error("Borzo error:", e.response?.data || e.message);
    res.status(500).json({ error: "Borzo order creation failed", details: e.response?.data });
  }
});


// Borzo webhook listener
app.post("/api/borzo/webhook", async (req, res) => {
  const event = req.body;
  try {
    await query(
      `UPDATE deliveries SET status=$1 WHERE porter_task_id=$2`,
      [event.status, event.order_id]
    );
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.status(500).send("Webhook update failed");
  }
});

// Orders: get status (frontend polling)
app.get("/api/orders/:id", async (req, res) => {
  try {
    const rows = await query("SELECT * FROM deliveries WHERE order_id=$1", [req.params.id]);
    res.json(rows[0] || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Order status fetch failed" });
  }
});



// Serve React build
app.use(express.static(path.join(__dirname, "frontend/dist")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "frontend/dist", "index.html"));
});

// ---------------------------
// Start server
// ---------------------------

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

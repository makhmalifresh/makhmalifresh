// server.js (ES module)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import pkg from "pg";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import Razorpay from "razorpay";
import crypto from "crypto";
import { adminRouter } from "./adminRoutes.js";
import { verifyUserJWT } from "./verifyUserJWT.js";

const { Pool } = pkg;

/* ---------------------------
   Config / Clients
   --------------------------- */

// Postgres pool (NeonDB)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Borzo client
const borzo = axios.create({
  baseURL:
    process.env.BORZO_BASE_URL ||
    "https://robotapitest-in.borzodelivery.com/api/business/1.6",
  headers: {
    "X-DV-Auth-Token": process.env.BORZO_API_KEY,
    "Content-Type": "application/json",
  },
});

// WhatsApp client (Facebook Graph)
const whatsapp = axios.create({
  baseURL: process.env.WHATSAPP_BASE_URL || "https://graph.facebook.com/v22.0/811413942060929",
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`,
    "Content-Type": "application/json",
  },
});

/* ---------------------------
   Helpers
   --------------------------- */

/**
 * Simple query wrapper returning rows (keeps your existing code expectations).
 * Use: const rows = await query(sql, params);
 */
async function query(q, params = []) {
  const { rows } = await pool.query(q, params);
  return rows;
}

/**
 * Normalize phone numbers:
 * - remove non-digits
 * - convert 10-digit numbers to '91XXXXXXXXXX'
 * - handle leading 0 / +91 / 91
 * Returns normalized string or empty string if input falsy.
 */
function normalizePhoneNumber(phone) {
  if (!phone) return "";

  // Remove all non-digit characters
  let cleaned = phone.toString().replace(/\D/g, "");

  // If it begins with 0 and length 11 (0 + 10), drop leading 0 and add 91
  if (cleaned.length === 11 && cleaned.startsWith("0")) {
    cleaned = cleaned.slice(1);
  }

  // If it's 10 digits, assume local Indian mobile -> add '91'
  if (cleaned.length === 10) {
    cleaned = `91${cleaned}`;
  }

  // If it's already 12 and starts with 91, keep it
  if (cleaned.length === 12 && cleaned.startsWith("91")) {
    return cleaned;
  }

  // If it's longer than 12, trim to first 12 digits (best-effort)
  if (cleaned.length > 12 && cleaned.startsWith("91")) {
    return cleaned.slice(0, 12);
  }

  // If nothing matched, return cleaned (maybe international) — caller can validate length
  return cleaned;
}

function isValidIndianPhone(normalized) {
  return typeof normalized === "string" && normalized.length === 12 && normalized.startsWith("91");
}

/* ---------------------------
   App init
   --------------------------- */
const app = express();

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


app.use(cors());
app.use(bodyParser.json());


/* ---------------------------
   Razorpay endpoints
   --------------------------- */

app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { grandTotal } = req.body;
    if (typeof grandTotal !== "number" || isNaN(grandTotal) || grandTotal <= 0) {
      return res.status(400).json({ error: "Invalid grandTotal" });
    }

    const options = {
      amount: Math.round(grandTotal * 100), // paisa
      currency: "INR",
      receipt: `receipt_order_${Date.now()}`,
    };

    const razorpayOrder = await razorpay.orders.create(options);
    if (!razorpayOrder) {
      throw new Error("Failed to create razorpay order");
    }

    res.json({
      orderId: razorpayOrder.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: razorpayOrder.amount,
    });
  } catch (e) {
    console.error("Razorpay order creation error:", e.message || e);
    res.status(500).json({ error: "Error creating Razorpay order" });
  }
});

app.post("/api/payment/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing verification fields" });
    }
    const shasum = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest("hex");
    if (digest === razorpay_signature) {
      res.json({ status: "success", orderId: razorpay_order_id, paymentId: razorpay_payment_id });
    } else {
      res.status(400).json({ status: "failure", message: "Payment verification failed." });
    }
  } catch (e) {
    console.error("Payment verification error:", e.message || e);
    res.status(500).json({ error: "Payment verification error." });
  }
});

/* ---------------------------
   Public endpoints (products/settings/offers)
   --------------------------- */

app.get("/api/products", async (req, res) => {
  try {
    const rows = await query("SELECT * FROM products WHERE is_available = true ORDER BY id ASC");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load products" });
  }
});

app.get("/api/settings/store-status", async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'is_store_open'");
    if (result.length === 0) {
      return res.json({ setting_key: "is_store_open", setting_value: "false" });
    }
    res.json(result[0]);
  } catch (e) {
    console.error("Error fetching public store status:", e);
    res.status(500).json({ setting_key: "is_store_open", setting_value: "false" });
  }
});

app.get("/api/settings/platform-fee", async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'platform_fee'");
    if (result.length === 0) {
      return res.json({ setting_key: "platform_fee", setting_value: "0" });
    }
    res.json(result[0]);
  } catch (e) {
    console.error("Error fetching platform fee:", e);
    res.status(500).json({ setting_key: "platform_fee", setting_value: "0" });
  }
});

app.get("/api/settings/surge-fee", async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'surge_fee'");
    if (result.length === 0) {
      return res.json({ setting_key: "surge_fee", setting_value: "0" });
    }
    res.json(result[0]);
  } catch (e) {
    console.error("Error fetching surge fee:", e);
    res.status(500).json({ setting_key: "surge_fee", setting_value: "0" });
  }
});

app.get("/api/offers/active", async (req, res) => {
  try {
    const result = await query(
      "SELECT name, description, coupon_code FROM offers WHERE is_active = true ORDER BY created_at DESC"
    );
    res.json(result);
  } catch (e) {
    console.error("Error fetching active offers:", e);
    res.status(500).json({ error: "Failed to fetch offers." });
  }
});

/* ---------------------------
   Coupon validation
   --------------------------- */
app.post("/api/cart/validate-coupon", async (req, res) => {
  const { coupon_code, subtotal } = req.body;
  if (!coupon_code || typeof subtotal !== "number") {
    return res.status(400).json({ error: "Coupon code and subtotal are required." });
  }
  try {
    const couponResult = await query("SELECT * FROM coupons WHERE code = $1 AND is_active = true", [coupon_code.toUpperCase()]);
    const coupon = couponResult[0];
    if (!coupon) return res.status(404).json({ error: "Invalid or expired coupon code." });

    let discount_amount = 0;
    if (coupon.discount_type === "percentage") discount_amount = Math.round(subtotal * (coupon.discount_value / 100));
    else if (coupon.discount_type === "fixed") discount_amount = coupon.discount_value;

    discount_amount = Math.min(discount_amount, subtotal);
    res.json({ message: "Coupon applied successfully!", discount_amount, coupon_code: coupon.code });
  } catch (e) {
    console.error("Coupon validation error:", e.message || e);
    res.status(500).json({ error: "Failed to validate coupon." });
  }
});

/* ---------------------------
   User orders & addresses
   --------------------------- */

app.get("/api/orders/my-orders", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  try {
    const queryStr = `
      SELECT 
        o.*, d.tracking_url,
        (
          SELECT json_agg(json_build_object('name', p.name, 'qty', oi.qty, 'price', oi.price))
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = o.id
        ) as items
      FROM orders o
      LEFT JOIN deliveries d ON o.id = d.order_id
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC;
    `;
    const orders = await query(queryStr, [userId]);
    res.json(orders);
  } catch (e) {
    console.error("Fetch my-orders error:", e.message || e);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

app.get("/api/addresses", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  try {
    const addresses = await query("SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    res.json(addresses);
  } catch (e) {
    console.error("Failed to fetch addresses:", e.message || e);
    res.status(500).json({ error: "Failed to fetch addresses." });
  }
});

app.post("/api/addresses", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  const { customer_name, phone, address_line1, area, city, pincode } = req.body;

  if (!customer_name || !phone || !address_line1 || !city || !pincode) {
    return res.status(400).json({ error: "All address fields are required." });
  }

  try {
    // Normalize phone before saving
    const normalized = normalizePhoneNumber(phone);
    const name = area || city;
    const newAddress = await query(
      `INSERT INTO addresses (user_id, customer_name, phone, address_line1, area, city, pincode, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [userId, customer_name, normalized, address_line1, area, city, pincode, name]
    );
    res.status(201).json(newAddress[0]);
  } catch (e) {
    console.error("Failed to save address:", e.message || e);
    res.status(500).json({ error: "Failed to save address." });
  }
});

/* ---------------------------
   BORZO: fee calc, webhook, status, courier
   --------------------------- */

app.post("/api/borzo/calculate-fee", async (req, res) => {
  const { address, items } = req.body;
  if (!address || !address.line1 || !address.city || !address.pincode) {
    return res.status(400).json({ error: "A complete address is required." });
  }
  try {
    const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
    const totalWeightGrams = items.reduce((sum, item) => sum + (Number(item.weight || 0) * Number(item.qty || 0)), 0);
    const total_weight_kg = totalWeightGrams / 1000;

    const borzoPayload = {
      type: "standard",
      matter,
      total_weight_kg,
      vehicle_type_id: 8,
      is_contact_person_notification_enabled: true,
      is_client_notification_enabled: true,
      points: [
        {
          address: "Makhmali The Fresh Meat Store, Shop No. 1, Mutton Chicken Centre, New Makhmali, Lal Bahadur Shastri Marg, opp. makhmali Talao, Thane, Maharashtra 400601",
          contact_person: { phone: "919867777860", name: "Shoaib Qureshi" },
        },
        {
          address: `${address.line1}, ${address.area}, ${address.city} ${address.pincode}`,
          contact_person: {
            phone: normalizePhoneNumber(address.phone),
            name: address.name,
          },
          note: address.note || null,
        },
      ],
      payment_method: "balance",
    };

    const { data } = await borzo.post("/calculate-order", borzoPayload);
    const paymentAmountString = data?.order?.payment_amount;
    const paymentAmount = parseFloat(paymentAmountString);
    if (isNaN(paymentAmount)) {
      const errorMessage = data?.parameter_errors?.points?.[1]?.address?.[0] || "Could not calculate fee for this address.";
      return res.status(400).json({ error: errorMessage });
    }
    res.json({ delivery_fee: paymentAmount });
  } catch (e) {
    console.error("Borzo fee calculation error:", e.response?.data || e.message || e);
    res.status(500).json({ error: "Failed to calculate delivery fee." });
  }
});

app.post("/api/borzo/webhook", async (req, res) => {
  const event = req.body;
  const borzoOrderId = event?.order?.order_id;
  const newStatus = event?.order?.status;
  if (!borzoOrderId || !newStatus) return res.status(400).send("Invalid webhook payload.");

  try {
    const updateQuery = `
      UPDATE orders SET borzo_status = $1 
      WHERE id = (SELECT order_id FROM deliveries WHERE porter_task_id = $2)`;
    await query(updateQuery, [newStatus, borzoOrderId]);
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook database update failed:", e.message || e);
    res.status(500).send("Webhook processing failed.");
  }
});

app.get("/api/borzo/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const borzoRes = await borzo.get(`/orders?order_id=${orderId}`);
    res.json(borzoRes.data);
  } catch (err) {
    console.error("Borzo order status error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to fetch order status" });
  }
});

app.get("/api/borzo/courier/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const borzoRes = await borzo.get(`/courier?order_id=${orderId}`);
    res.json(borzoRes.data);
  } catch (err) {
    console.error("Borzo courier error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to fetch courier info" });
  }
});

/* ---------------------------
   FINALIZE PAYMENT (Main flow)
   --------------------------- */

app.post("/api/order/finalize-payment", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  const { orderPayload, paymentResponse } = req.body;
  const {
    cart, address, payMethod,
    subtotal, delivery_fee, discount_amount,
    grand_total, platform_fee, surge_fee,
  } = orderPayload;

  /* 1) Verify Razorpay signature */
  try {
    const shasum = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${paymentResponse.razorpay_order_id}|${paymentResponse.razorpay_payment_id}`);
    const digest = shasum.digest("hex");
    if (digest !== paymentResponse.razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed: Invalid signature." });
    }
  } catch (verifyError) {
    console.error("Payment signature verification error:", verifyError.message || verifyError);
    return res.status(500).json({ error: "Payment verification error." });
  }

  /* 2) Begin transaction and create order + items + borzo + deliveries */
  try {
    await query("BEGIN");

    let createdBackendOrderId = null;
    let borzoData = null;

    /* Step A — Create order */
    const orderQuery = `
      INSERT INTO orders (
        user_id, customer_name, phone, address_line1, area, city, pincode,
        pay_method, subtotal, delivery_fee, discount_amount, grand_total,
        platform_fee, surge_fee, status, borzo_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id;
    `;
    const normalizedPhoneForDb = normalizePhoneNumber(address.phone);
    const orderParams = [
      userId,
      address.name,
      normalizedPhoneForDb,
      address.line1,
      address.area,
      address.city,
      address.pincode,
      payMethod,
      Math.round(subtotal),
      Math.round(delivery_fee),
      Math.round(discount_amount),
      Math.round(grand_total),
      Math.round(platform_fee),
      Math.round(surge_fee),
      "PAYMENT_VERIFIED",
      "PENDING",
    ];
    const orderResult = await query(orderQuery, orderParams);
    createdBackendOrderId = orderResult[0].id;

    /* Step B — order_items */
    for (const item of cart) {
      await query(
        `INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1, $2, $3, $4)`,
        [createdBackendOrderId, item.id, item.qty, item.price]
      );
    }

    /* Step C — Borzo create-order */
    const matter = cart.map(i => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
    const totalWeightGrams = cart.reduce((sum, i) => sum + (Number(i.weight || 0) * Number(i.qty || 0)), 0);
    const total_weight_kg = totalWeightGrams / 1000;

    const borzoPayload = {
      type: "standard",
      matter,
      total_weight_kg,
      vehicle_type_id: 8,
      is_contact_person_notification_enabled: true,
      is_client_notification_enabled: true,
      points: [
        {
          address: "Makhmali The Fresh Meat Store, Shop No. 1, Mutton Chicken Centre, New Makhmali, Lal Bahadur Shastri Marg, opp. makhmali Talao, Thane, Maharashtra 400601",
          contact_person: { phone: "919867777860", name: "Shoaib Qureshi" },
        },
        {
          address: `${address.line1}, ${address.area}, ${address.city} ${address.pincode}`,
          contact_person: {
            phone: normalizePhoneNumber(address.phone),
            name: address.name,
          },
          client_order_id: createdBackendOrderId.toString(),
          note: address.note || null,
        },
      ],
      payment_method: "balance",
    };

    const borzoRes = await borzo.post("/create-order", borzoPayload);
    borzoData = borzoRes.data;
    if (!borzoData.order?.order_id) {
      throw new Error("Borzo API failed to return a valid order_id.");
    }

    /* Step D — Save deliveries row */
    await query(
      `INSERT INTO deliveries (order_id, porter_task_id, status, tracking_url, eta)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        createdBackendOrderId,
        borzoData.order.order_id,
        borzoData.order.status,
        borzoData.order.points?.[1]?.tracking_url || null,
        borzoData.order.created_datetime || null,
      ]
    );

    /* Step E — Mark order borzo_status */
    await query(`UPDATE orders SET borzo_status = 'CREATED' WHERE id = $1`, [createdBackendOrderId]);

    /* Commit transaction */
    await query("COMMIT");
    console.log(`✅ Order #${createdBackendOrderId} created and committed.`);

    /* Respond to client immediately (order persisted) */
    res.status(200).json({ status: "success", orderId: createdBackendOrderId });

    /* ---------------------------
       Background: send WhatsApp notifications (non-critical)
       --------------------------- */
    try {
      if (!borzoData) return;

      const orderStatus = borzoData.order?.status === "new" ? "Confirmed" : "Pending";
      const trackingUrl = borzoData.order?.points?.[1]?.tracking_url || "N/A";
      const borzoOrderId = borzoData.order?.order_id || "N/A";
      const fullAddress = `${address.line1} ${address.area} ${address.city} ${address.pincode}`;
      const matterText = matter;

      // Owner message
      const ownerPhone = "919321561224";
      const employeePhone = "918779121361";
      const cus_number = normalizePhoneNumber(address.phone);

      const msg_to_owner = {
        messaging_product: "whatsapp",
        to: ownerPhone,
        type: "template",
        template: {
          name: "order_confirmed_message_to_owner",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: `${borzoOrderId} ${createdBackendOrderId}` },
                { type: "text", text: address.name },
                { type: "text", text: fullAddress },
                { type: "text", text: cus_number },
                { type: "text", text: matterText },
                { type: "text", text: trackingUrl },
              ],
            },
          ],
        },
      };

      const msg_to_employee = {
        messaging_product: "whatsapp",
        to: employeePhone,
        type: "template",
        template: msg_to_owner.template, // reuse same template body
      };

      const msg_to_customer = {
        messaging_product: "whatsapp",
        to: cus_number,
        type: "template",
        template: {
          name: "order_created",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: matterText },
                { type: "text", text: orderStatus },
                { type: "text", text: trackingUrl },
              ],
            },
          ],
        },
      };

      // Fire concurrently and inspect results (do not cause rollback)
      const results = await Promise.allSettled([
        whatsapp.post("/messages", msg_to_owner),
        // whatsapp.post("/messages", msg_to_employee),
        whatsapp.post("/messages", msg_to_customer),
      ]);

      results.forEach((r, i) => {
        const who = ["Owner", "Employee", "Customer"][i];
        if (r.status === "fulfilled") {
          console.log(`📩 ${who} WhatsApp sent for order #${createdBackendOrderId}`);
        } else {
          console.error(`⚠️ ${who} WhatsApp failed:`, r.reason?.response?.data || r.reason?.message || r.reason);
        }
      });
    } catch (msgErr) {
      // Extra safety: message failures must not affect main flow
      console.error("⚠️ WhatsApp background error:", msgErr?.response?.data || msgErr.message || msgErr);
    }
  } catch (err) {
    // Critical failure: rollback DB
    await query("ROLLBACK");
    console.error("❌ CRITICAL CHECKOUT FAILURE:", err.message || err);
    res.status(500).json({
      error: "Order creation failed after payment. Your order was not placed. Please contact support for a refund.",
    });
  }
});

/* ---------------------------
   Admin router
   --------------------------- */
app.use("/api/admin", adminRouter);

/* ---------------------------
   Start server
   --------------------------- */


app.use(express.static(path.join(__dirname, "frontend/dist")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "frontend/dist", "index.html"));
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

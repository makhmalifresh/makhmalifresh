import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import pkg from "pg";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { adminRouter } from "./adminRoutes.js";
import { verifyUserJWT } from './verifyUserJWT.js';
import { query } from './db.js';


//RAZOPAY backend api
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------------------------
// Express + Postgres Backend API
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
});

// Borzo API client
const borzo = axios.create({
  baseURL:
    process.env.BORZO_BASE_URL ||
    "https://robotapitest-in.borzodelivery.com/api/business/1.6",
  headers: {
    "X-DV-Auth-Token": process.env.BORZO_API_KEY,
    "Content-Type": "application/json",
  },
});


const whatsapp = axios.create({
  baseURL: "https://graph.facebook.com/v22.0/811413942060929",
  headers: {
    "Authorization": `Bearer ${process.env.WHATSAPP_API_KEY}`,
    "Content-Type": "application/json"
  }
})

// ---------------------------
// Helpers
// ---------------------------
// async function query(q, params) {
//   const { rows } = await pool.query(q, params);
//   return rows;
// }

// ---------------------------
// Routes
// ---------------------------




//RAZORPAY ROUTES

app.post("/api/payment/create-order", async (req, res) => {
  const { grandTotal } = req.body;

  // Razorpay requires the amount in the smallest currency unit (e.g., paisa for INR)
  const options = {
    amount: Math.round(grandTotal * 100), // Amount in paisa
    currency: "INR",
    receipt: `receipt_order_${new Date().getTime()}`, // A unique receipt ID
  };

  try {
    const razorpayOrder = await razorpay.orders.create(options);
    if (!razorpayOrder) {
      return res.status(500).send("Error creating Razorpay order");
    }
    // Send back the order details and your key_id to the frontend
    res.json({
      orderId: razorpayOrder.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: razorpayOrder.amount
    });
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    res.status(500).send("Error creating Razorpay order");
  }
});


// Endpoint 2: Verify the Payment
// This is a CRITICAL security step. The frontend sends the payment signature,
// and the backend verifies it to confirm the payment is legitimate.
app.post("/api/payment/verify", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  // This is the logic provided by Razorpay to verify the signature
  const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
  shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
  const digest = shasum.digest('hex');

  if (digest === razorpay_signature) {
    // Payment is legitimate
    res.json({ status: 'success', orderId: razorpay_order_id, paymentId: razorpay_payment_id });
  } else {
    // Payment is fraudulent or failed
    res.status(400).json({ status: 'failure', message: 'Payment verification failed.' });
  }
});

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

    // If setting doesn't exist in DB yet, it's safer to say the store is closed.
    if (result.length === 0) {
      return res.json({ setting_key: 'is_store_open', setting_value: 'false' });
    }

    res.json(result[0]);
  } catch (e) {
    console.error("Error fetching public store status:", e);
    // If the database query fails, default to saying the store is closed.
    res.status(500).json({ setting_key: 'is_store_open', setting_value: 'false' });
  }
});


// --- NEW: Public endpoint for customers to get the platform fee ---
app.get("/api/settings/platform-fee", async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'platform_fee'");
    if (result.length === 0) {
      return res.json({ setting_key: 'platform_fee', setting_value: '0' });
    }
    res.json(result[0]);
  } catch (e) {
    console.error("Error fetching public platform fee:", e);
    res.status(500).json({ setting_key: 'platform_fee', setting_value: '0' });
  }
});


// --- NEW: Public endpoint for customers to get the platform fee ---
app.get("/api/settings/surge-fee", async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'surge_fee'");
    if (result.length === 0) {
      return res.json({ setting_key: 'surge_fee', setting_value: '0' });
    }
    res.json(result[0]);
  } catch (e) {
    console.error("Error fetching public surge fee:", e);
    res.status(500).json({ setting_key: 'surge_fee', setting_value: '0' });
  }
});


//OFFER MANAGEMENT SYSTEM
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


//COUPON CODE MANAGEMENT

app.post("/api/cart/validate-coupon", async (req, res) => {
  const { coupon_code, subtotal } = req.body;

  if (!coupon_code || typeof subtotal !== 'number') {
    return res.status(400).json({ error: "Coupon code and subtotal are required." });
  }

  try {
    // 1. Find the coupon in the database.
    const couponResult = await query("SELECT * FROM coupons WHERE code = $1 AND is_active = true", [coupon_code.toUpperCase()]);

    const coupon = couponResult[0];

    // 2. Check if the coupon is valid.
    if (!coupon) {
      return res.status(404).json({ error: "Invalid or expired coupon code." });
    }

    // 3. Calculate the discount amount.
    let discount_amount = 0;
    if (coupon.discount_type === 'percentage') {
      discount_amount = Math.round(subtotal * (coupon.discount_value / 100));
    } else if (coupon.discount_type === 'fixed') {
      discount_amount = coupon.discount_value;
    }

    // 4. Ensure the discount doesn't exceed the subtotal.
    discount_amount = Math.min(discount_amount, subtotal);

    // 5. Send the calculated discount back to the frontend.
    res.json({
      message: "Coupon applied successfully!",
      discount_amount: discount_amount,
      coupon_code: coupon.code
    });

  } catch (e) {
    console.error("Coupon validation error:", e);
    res.status(500).json({ error: "Failed to validate coupon." });
  }
});

// GET all orders for the logged-in user, including their items and tracking links.
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
    console.error("Fetch my-orders error:", e);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

// Borzo: calculate delivery fee
app.post("/api/borzo/calculate-fee", async (req, res) => {
  const { address, items } = req.body;

  if (!address || !address.line1 || !address.city || !address.pincode) {
    return res.status(400).json({ error: "A complete address is required." });
  }

  try {
    // This is the correct, simpler payload for calculating a fee.
    // It does not need 'matter', 'contact_person', or 'items'.
    const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ''}`).join(", ");

    // --- NEW: Calculate the total weight in kilograms ---
    const totalWeightGrams = items.reduce((sum, item) => {
      // Ensure weight and qty are numbers, default to 0 if not
      const weight = Number(item.weight) || 0;
      const qty = Number(item.qty) || 0;
      return sum + (weight * qty);
    }, 0);
    // Convert grams to kilograms for the API
    const total_weight_kg = totalWeightGrams / 1000;
    const payload = {
      type: "standard",
      matter,
      total_weight_kg,
      vehicle_type_id: 8, // bike
      is_contact_person_notification_enabled: true,
      is_client_notification_enabled: true,
      points: [
        {
          address: "Makhmali The Fresh Meat Store, Shop No. 1, Mutton Chicken Centre, New Makhmali, Lal Bahadur Shastri Marg, opp. makhmali Talao, Thane, Maharashtra 400601",
          contact_person: {
            phone: "919867777860",
            name: "Shoaib Qureshi",
          },
        },
        {
          address: `${address.line1}, ${address.area}, ${address.city} ${address.pincode}`,
          contact_person: {
            phone: address.phone.startsWith("+91")
              ? `91${address.phone}`
              : `91${address.phone}`,
            name: address.name,
          },
          note: address.note || null,
        },
      ],
      payment_method: "balance"
    };


    // console.log("Sending payload to Borzo for price calculation:", payload);

    // The endpoint is /calculate-order
    const { data } = await borzo.post("/calculate-order", payload);

    // console.log("Received full response from Borzo:", JSON.stringify(data, null, 2));

    const paymentAmountString = data?.order?.payment_amount;

    const paymentAmount = parseFloat(paymentAmountString);

    if (isNaN(paymentAmount)) {
      console.error("Borzo response did not contain a valid payment_amount.");
      const errorMessage = data?.parameter_errors?.points?.[1]?.address?.[0] || "Could not calculate fee for this address.";
      return res.status(400).json({ error: errorMessage });
    }

    res.json({ delivery_fee: paymentAmount });

  } catch (e) {
    console.error("Borzo fee calculation error:", e.response?.data || e.message);
    res.status(500).json({ error: "Failed to calculate delivery fee." });
  }
});

// Borzo webhook
app.post("/api/borzo/webhook", async (req, res) => {
  const event = req.body;
  const borzoOrderId = event?.order?.order_id;
  const newStatus = event?.order?.status;

  if (!borzoOrderId || !newStatus) {
    return res.status(400).send("Invalid webhook payload.");
  }
  try {
    const updateQuery = `
      UPDATE orders SET borzo_status = $1 
      WHERE id = (SELECT order_id FROM deliveries WHERE porter_task_id = $2)`;
    await query(updateQuery, [newStatus, borzoOrderId]);
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook database update failed:", e);
    res.status(500).send("Webhook processing failed.");
  }
});

// Polling order status (Borzo)
app.get("/api/borzo/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const borzoRes = await borzo.get(`/orders?order_id=${orderId}`);
    res.json(borzoRes.data);
  } catch (err) {
    console.error("Borzo order status error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch order status" });
  }
});

// Courier info + live location
app.get("/api/borzo/courier/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const borzoRes = await borzo.get(`/courier?order_id=${orderId}`);
    res.json(borzoRes.data);
  } catch (err) {
    console.error("Borzo courier error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch courier info" });
  }
});

// server.js

// ... (after other public routes)


app.post("/api/order/finalize-payment", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  const { orderPayload, paymentResponse } = req.body;
  const { cart, address, payMethod, subtotal, delivery_fee, discount_amount, grand_total, platform_fee, surge_fee } = orderPayload;

  // --- 1. VERIFY PAYMENT SIGNATURE ---
  try {
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${paymentResponse.razorpay_order_id}|${paymentResponse.razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== paymentResponse.razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed: Invalid signature.' });
    }
  } catch (verifyError) {
    return res.status(500).json({ error: 'Payment verification error.' });
  }

  // --- 2. BEGIN ATOMIC TRANSACTION ---
  const client = await pool.connect(); // Get one connection from the pool
  try {
    await client.query('BEGIN'); // Start the transaction

    let createdBackendOrderId = null;
    let borzoData = null;
    let matter = "";

    // --- Step A: Create the Order ---
    const orderQuery = `
      INSERT INTO orders (user_id, customer_name, phone, address_line1, area, city, pincode, pay_method, subtotal, delivery_fee, discount_amount, grand_total, platform_fee, surge_fee, status, borzo_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) 
      RETURNING id`;
    const orderParams = [
      userId, address.name, address.phone, address.line1, address.area, address.city, address.pincode,
      payMethod, Math.round(subtotal), Math.round(delivery_fee), Math.round(discount_amount),
      Math.round(grand_total), Math.round(platform_fee), Math.round(surge_fee), 'PAYMENT_VERIFIED', 'PENDING'
    ];
    const orderResult = await client.query(orderQuery, orderParams);
    createdBackendOrderId = orderResult.rows[0].id;

    // --- Step B: Create the Order Items ---
    for (const item of cart) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1, $2, $3, $4)`,
        [createdBackendOrderId, item.id, item.qty, item.price]
      );
    }

    // --- Step C: Create the Borzo Order ---
    matter = cart.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ''}`).join(", ");

    // --- NEW: Calculate the total weight in kilograms ---
    const totalWeightGrams = cart.reduce((sum, item) => {
      // Ensure weight and qty are numbers, default to 0 if not
      const weight = Number(item.weight) || 0;
      const qty = Number(item.qty) || 0;
      return sum + (weight * qty);
    }, 0);
    // Convert grams to kilograms for the API
    const total_weight_kg = totalWeightGrams / 1000;
    const borzoPayload = {
      type: "standard",
      matter,
      total_weight_kg,
      vehicle_type_id: 8, // bike
      is_contact_person_notification_enabled: true,
      is_client_notification_enabled: true,
      points: [
        {
          address: "Makhmali The Fresh Meat Store, Shop No. 1, Mutton Chicken Centre, New Makhmali, Lal Bahadur Shastri Marg, opp. makhmali Talao, Thane, Maharashtra 400601",
          contact_person: {
            phone: "919867777860",
            name: "Shoaib Qureshi",
          },
        },
        {
          address: `${address.line1}, ${address.area}, ${address.city} ${address.pincode}`,
          contact_person: {
            phone: address.phone.startsWith("+91")
              ? `91${address.phone.slice(3)}`
              : `91${address.phone}`,
            name: address.name,
          },
          client_order_id: createdBackendOrderId.toString(),
          note: address.note || null,
        },
      ],
      payment_method: "balance"
    };


    // This is the critical network call inside the transaction
    const borzoRes = await borzo.post("/create-order", borzoPayload);
    // console.log(`Response from axios : ${borzoRes}`);
    borzoData = borzoRes.data;
    // console.log(`Response from borzo.data: ${borzoData}`)

    if (!borzoData.order?.order_id) {
      throw new Error('Borzo API failed to return an order_id.');
    }

    // --- Step D: Save the Delivery Info ---
    await client.query(
      `INSERT INTO deliveries (order_id, porter_task_id, status, tracking_url, eta) VALUES ($1, $2, $3, $4, $5)`,
      [createdBackendOrderId, borzoData.order?.order_id, borzoData.order?.status, borzoData.order?.points[1]?.tracking_url || null, borzoData.order?.created_datetime || null]
    );

    // --- Step E: Mark the Order as Fully Created ---
    await client.query("UPDATE orders SET borzo_status = 'CREATED' WHERE id = $1", [createdBackendOrderId]);

    // --- 3. COMMIT THE TRANSACTION ---
    await client.query('COMMIT'); // Lock in all the changes
    // res.status(200).json({ status: 'success', orderId: createdBackendOrderId });



    try {
      if (!borzoData) return; // Safety check

      const stat = (borzoData.order?.status === "new") ? "Confirmed" : "Pending";
      const trackingUrl = borzoData.order?.points?.[1]?.tracking_url || "N/A";
      const borzoOrderId = borzoData.order?.order_id || "N/A";
      const address_customer = `${address.line1} ${address.area} ${address.city} ${address.pincode}`

      // --- Message to Owner ---
      const msg_to_owner_payload = {
        messaging_product: "whatsapp", to: '919867777860', type: "template",
        template: {
          name: "order_confirmed_message_to_owner", language: { code: "en" },
          components: [
            {
              type: "body", parameters: [
                { type: "text", text: `${borzoOrderId} ${createdBackendOrderId}` },
                { type: "text", text: `${address.name}` },
                { type: "text", text: `${address_customer}` },
                { type: "text", text: `${address.phone}` },
                { type: "text", text: `${matter}` },
                { type: "text", text: `${trackingUrl}` }
              ]
            }
          ]
        }
      };

      // ---- Message to Employee ----
      const msg_to_employee_payload = {
        messaging_product: "whatsapp", to: '918779121361', type: "template",
        template: {
          name: "order_confirmed_message_to_owner", language: { code: "en" },
          components: [
            {
              type: "body", parameters: [
                { type: "text", text: `${borzoOrderId} ${createdBackendOrderId}` },
                { type: "text", text: `${address.name}` },
                { type: "text", text: `${address_customer}` },
                { type: "text", text: `${address.phone}` },
                { type: "text", text: `${matter}` },
                { type: "text", text: `${trackingUrl}` }
              ]
            }
          ]
        }
      };

      // --- Message to Customer ---
      let cus_number = address.phone.startsWith("+91") ? `91${address.phone.slice(3)}` : `91${address.phone}`;
      const msg_to_customer_payload = {
        messaging_product: "whatsapp", to: cus_number, type: "template",
        template: {
          name: "order_created", language: { code: "en" },
          components: [
            {
              type: "body", parameters: [
                { type: "text", text: `${matter}` },
                { type: "text", text: `${stat}` },
                { type: "text", text: `${trackingUrl}` }
              ]
            }
          ]
        }
      };

      // Send all messages concurrently
      // await Promise.all([
        whatsapp.post("/messages", msg_to_owner_payload),
        whatsapp.post("/messages", msg_to_employee_payload),
        whatsapp.post("/messages", msg_to_customer_payload)
      // ]);
      // console.log(`Successfully sent all WhatsApp notifications for order #${createdBackendOrderId}.`);

    } catch (e) {
      // This is a non-critical error. The order was placed, but the messages failed.
      console.error("WhatsApp notification failed:", e.response?.data || e.message);
      // We do NOT send an error back to the user, as their order was successful.
    }

    res.status(200).json({ status: 'success', orderId: createdBackendOrderId });

  } catch (e) {
    // --- 4. ROLLBACK THE TRANSACTION ---
    await client.query('ROLLBACK'); // Something failed. UNDO EVERYTHING.

    console.error("CRITICAL CHECKOUT FAILURE:", e.message);
    // This message is now safe to show, because we know the order was NOT created.
    res.status(500).json({ error: "Order creation failed after payment. Your order was not placed. Please contact support for a refund." });

  }
});


//NEW 
app.get("/api/addresses", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  try {
    const addresses = await query("SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    res.json(addresses);
  } catch (e) {
    console.error("Failed to fetch addresses:", e);
    res.status(500).json({ error: "Failed to fetch addresses." });
  }
});

// POST a new address for the currently logged-in user
app.post("/api/addresses", verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  const { customer_name, phone, address_line1, area, city, pincode } = req.body;

  if (!customer_name || !phone || !address_line1 || !city || !pincode) {
    return res.status(400).json({ error: "All address fields are required." });
  }

  try {
    const newAddressQuery = `
      INSERT INTO addresses (user_id, customer_name, phone, address_line1, area, city, pincode, name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`;
    // We'll use the 'area' or 'city' as a default nickname for the address
    const name = area || city;

    const newAddress = await query(newAddressQuery, [userId, customer_name, phone, address_line1, area, city, pincode, name]);
    res.status(201).json(newAddress[0]);
  } catch (e) {
    console.error("Failed to save address:", e);
    res.status(500).json({ error: "Failed to save address." });
  }
});


//ADMIN ROUTER
app.use('/api/admin', adminRouter);


app.use(express.static(path.join(__dirname, "frontend/dist")));

// 2. The "React Router Catch-All": This MUST be the last route.
//    It handles all other GET requests that are NOT API routes
//    (e.g., /my-orders, /admin/dashboard) and sends them your React app's
//    index.html. React Router then takes over and displays the correct page.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/dist", "index.html"));
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});




// RESPONSE FROM RAZORPAY AFTER HITTING /orders endpoint
// {
//     "amount": 10000,
//     "amount_due": 10000,
//     "amount_paid": 0,
//     "attempts": 0,
//     "created_at": 1757599162,
//     "currency": "INR",
//     "entity": "order",
//     "id": "order_RGJs6Q495dvVCu",
//     "notes":
//     {
//         "notes_key_1": "Tea, Earl Grey, Hot",
//         "notes_key_2": "Tea, Earl Grey… decaf."
//     },
//     "offer_id": null,
//     "receipt": "receipt 1"
// }
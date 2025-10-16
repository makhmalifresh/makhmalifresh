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


// Root
// app.get("/", (req, res) => {
//   res.json({ message: "Makhmali backend running 🚀" });
// });

// Products
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

// In server.js

// ... (after your other public routes like /api/settings/store-status)

// --- NEW: Public endpoint for customers to get active offers for the marquee ---
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

// ... (rest of server.js)

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

    // Optional: Check for expiration date if you have one
    // if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    //   return res.status(400).json({ error: "This coupon has expired." });
    // }

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


// ... (all existing code in server.js)

// --- THIS IS THE CORRECTED CHECKOUT ENDPOINT ---
app.post("/api/cart/checkout", async (req, res) => {
  // Now accepts the full breakdown of the order
  const { cart, address, payMethod, subtotal, delivery_fee, discount_amount, grand_total, platform_fee, surge_fee } = req.body;

  try {
    // CORRECTED: The query now has a $12 placeholder for the 'status' column.
    const orderQuery = `
      INSERT INTO orders (customer_name, phone, address_line1, area, city, pincode, pay_method, subtotal, delivery_fee, discount_amount, grand_total, platform_fee, surge_fee, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
      RETURNING *`;
      
    // CORRECTED: The parameters array now includes the 12th value for the status.
    const orderParams = [
        address.name, address.phone, address.line1, address.area, address.city, address.pincode,
        payMethod, subtotal, delivery_fee, discount_amount, grand_total, platform_fee, surge_fee, 'CREATED'
    ];

    const order = await query(orderQuery, orderParams);
    const orderId = order[0].id;

    // The order_items logic remains correct and does not need to be changed.
    for (const item of cart) {
      await query(
        `INSERT INTO order_items (order_id, product_id, qty, price)
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.id, item.qty, item.price]
      );
    }

    // Respond with the created order ID
    res.json({ id: orderId });
  } catch (e) {
    // IMPROVED: This will now log the specific database error for easier debugging.
    console.error("Checkout database error:", e.detail || e.message); 
    res.status(500).json({ error: "Checkout failed due to a database error." });
  }
});


// ... (the rest of your server.js file)
// Borzo: normal order create delivery order with razorpay
app.post("/api/borzo/create-order", async (req, res) => {
  const { orderId, address, items } = req.body;

  try {
    const matter = items.map((i) => `${i.qty}x ${i.name}`).join(", ");

    const payload = {
      type: "standard",
      matter,
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
          client_order_id: orderId.toString(),
          note: address.note || null,
        },
      ],
    };

    const { data } = await borzo.post("/create-order", payload);
    if (data.order?.order_id) {
      await query(
        `INSERT INTO deliveries (order_id, porter_task_id, status, tracking_url, eta)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          orderId,
          data.order?.order_id,
          data.order?.status,
          data.order?.points?.[1]?.tracking_url || null,
          data.order?.created_datetime || null,
        ]
      );
    }

    res.json(data);
  } catch (e) {
    console.error("Borzo error:", e.response?.data || e.message);
    res
      .status(500)
      .json({ error: "Borzo order creation failed", details: e.response?.data });
  }
});


// Borzo: create delivery order with cash on delivery
app.post("/api/borzo/create-cod-order", async (req, res) => {
  const { orderId, address, items, taking_amount } = req.body;

  try {
    const matter = items.map((i) => `${i.qty}x ${i.name}`).join(", ");

    const payload = {
      type: "standard",
      matter,
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
          is_cod_cash_voucher_required: true,
          taking_amount: parseFloat(taking_amount),
          contact_person: {
            phone: address.phone.startsWith("+91")
              ? `91${address.phone}`
              : `91${address.phone}`,
            name: address.name,
          },
          client_order_id: orderId.toString(),
          note: address.note || null,
        },
      ],
    };

    const { data } = await borzo.post("/create-order", payload);

    if (data.order?.order_id) {
      await query(
        `INSERT INTO deliveries (order_id, porter_task_id, status, tracking_url, eta)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          orderId,
          data.order?.order_id,
          data.order?.status,
          data.order?.points?.[1]?.tracking_url || null,
          data.order?.created_datetime || null,
        ]
      );
    }

    res.json(data);
  } catch (e) {
    console.error("Borzo error:", e.response?.data || e.message);
    res
      .status(500)
      .json({ error: "Borzo order creation failed", details: e.response?.data });
  }
});



// Borzo webhook
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

// Borzo: calculate delivery fee
app.post("/api/borzo/calculate-fee", async (req, res) => {
  const { address } = req.body;

  if (!address || !address.line1 || !address.city || !address.pincode) {
    return res.status(400).json({ error: "A complete address is required." });
  }

  try {
    // This is the correct, simpler payload for calculating a fee.
    // It does not need 'matter', 'contact_person', or 'items'.
    const payload = {
      vehicle_type_id: 8, // bike
      points: [
        { address: "Makhmali The Fresh Meat Store, Shop No. 1, Mutton Chicken Centre, New Makhmali, Lal Bahadur Shastri Marg, opp. makhmali Talao, Thane, Maharashtra 400601" }, // Your fixed pickup address
        { address: `${address.line1}, ${address.area}, ${address.city}, ${address.pincode}` }
      ]
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



//ADMIN ROUTER
app.use('/api/admin', adminRouter);


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
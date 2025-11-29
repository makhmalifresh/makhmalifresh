// index.js
// ES module style. Ensure "type": "module" in package.json

import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import axios from 'axios';
import Razorpay from 'razorpay';
// import { Pool } from 'pg';
import adminRoutes from './adminRoutes.js'; // ensure adminRoutes.js is ES module export
import { verifyUserJWT } from './verifyUserJWT.js'
import dotenv from 'dotenv';
import cors from "cors";
import pool from "./db.js"
import { fileURLToPath } from "url";
import path from 'path';

dotenv.config();

// ---------- Config / Clients ----------
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// app.use(bodyParser.json({ limit: '1mb' }));
app.use(cors());
app.use(bodyParser.json());



// Razorpay client (exactly as you specified)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// DB (Neon)
// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },

//   idleTimeoutMillis: 0,
//   connectionTimeoutMillis: 10000,
//   max:1,
// });



async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// External API clients
const porter = axios.create({
  baseURL: process.env.PORTER_BASE_URL,
  headers: {
    'x-api-key': process.env.PORTER_API_KEY,
    'Content-Type': 'application/json',
  },
});

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
  baseURL: process.env.WHATSAPP_BASE_URL || 'https://graph.facebook.com/v22.0/811413942060929',
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_API_KEY || ''}`,
    'Content-Type': 'application/json'
  }
});

// ---------- Helpers ----------
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


// Sending Whatsapp message functionalities
async function sendWhatsappMessage(phone, template, matter_item, status, tracking_url) {
  await whatsapp.post('/messages', {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: template,
      language: { code: 'en' },
      components: [{
        type: 'body', parameters: [
          { type: "text", text: matter_item },
          { type: "text", text: status },
          { type: "text", text: tracking_url },
        ],
      }]
    }
  });
}

async function whatappMessageToOwner(phone, template, matter_item, cus_number, order_id, name, address, tracking) {
  await whatsapp.post('/messages', {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: template,
      language: { code: 'en' },
      components: [{
        type: 'body', parameters: [
          { type: "text", text: order_id },
          { type: "text", text: name },
          { type: "text", text: address },
          { type: "text", text: cus_number },
          { type: "text", text: matter_item },
          { type: "text", text: tracking },

        ],
      }]
    }
  });
}

// Geocode using LocationIQ (free-ish). Requires LOCATIONIQ_API_KEY env var.
async function geocodeAddressFree(address) {
  const key = process.env.POSITIONSTACK_API_KEY;
  if (!key) throw new Error('Missing POSITIONSTACK_API_KEY');

  const q = encodeURIComponent(
    `${address.line1 || ''} ${address.area || ''} ${address.city || ''} ${address.pincode || ''}`.trim()
  );

  const url = `http://api.positionstack.com/v1/forward?access_key=${key}&query=${q}`;

  const r = await axios.get(url);

  // 👉 Correct access
  console.log(r.data.data[0].latitude, r.data.data[0].longitude);

  if (!r.data.data || r.data.data.length === 0) {
    throw new Error('Geocoding returned no results');
  }

  return {
    lat: Number(r.data.data[0].latitude),
    lng: Number(r.data.data[0].longitude)
  };
}

async function getCoordsForAddress(address) {
  const lat = address?.latitude ?? address?.lat ?? null;
  const lng = address?.longitude ?? address?.lng ?? null;
  if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng) };
  // fallback to free geocoding
  return await geocodeAddressFree(address);
}



/// ---------- Porter helpers (adapt to real Porter contract if needed) ----------
async function porterQuote(address, items) {
  try {
    const dropCoords = await geocodeAddressFree(address);
    const pickupCoords = {
      lat: Number(process.env.STORE_LATITUDE || 19.198890),
      lng: Number(process.env.STORE_LONGITUDE || 72.972017)
    };

    const contact_number = normalizePhoneNumber(address.phone);

    const payload = {
      pickup_details: {
        lat: pickupCoords.lat,
        lng: pickupCoords.lng,
      },
      drop_details: {
        lat: dropCoords.lat,
        lng: dropCoords.lng,
      },
      customer: {
        name: address.name,
        mobile: {
          country_code: '+91',
          number: contact_number.slice(2, 12),
        },
      },
    };

    const response = await porter.post('/v1/get_quote', payload);

    if (!response?.data?.vehicles?.[0]?.fare?.minor_amount) {
      throw new Error('Invalid response from Porter API');
    }

    const fee = response.data.vehicles[0].fare.minor_amount / 100;
    return { fee, raw: response.data };

  } catch (err) {
    console.error("Porter quote error:", err.message);
    const error = new Error(`Porter unavailable: ${err.message}`);
    error.originalError = err;
    throw error;
  }
}




function generatePorterRequestId(clientOrderId = "") {
  const clean = clientOrderId.toString().replace(/[^a-zA-Z0-9]/g, ""); // sanitize
  const uuid32 = crypto.randomUUID().replace(/-/g, ""); // 32 chars
  return (clean + uuid32).slice(0, 32); // prefix your ID, trim to 32
}

/** MAIN FUNCTION */
async function porterCreateOrder(address, items, clientOrderId) {
  const dropCoords = await getCoordsForAddress(address);
  const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");


  const pickupCoords = {
    lat: Number(process.env.STORE_LATITUDE || "19.198890"),
    lng: Number(process.env.STORE_LONGITUDE || "72.972017")
  };

  const contact_number = normalizePhoneNumber(address.phone);

  const payload = {
    request_id: generatePorterRequestId(clientOrderId),

    pickup_details: {
      address: {
        apartment_address: "New Makhmali",
        street_address1: process.env.STORE_ADDRESS || "Shop no.1, Mutton Chicken Centre",
        street_address2: "Lal Bahadur Shastri Marg, Dhobi Ali, Charai, Thane West",
        landmark: "opp. makhmali Talao",
        city: "Thane",
        state: "Maharashtra",
        pincode: "400601",
        country: "India",
        lat: Number(pickupCoords.lat.toFixed(6)),  // ✔ 6 decimals
        lng: Number(pickupCoords.lng.toFixed(6)),
        contact_details: {
          name: process.env.STORE_CONTACT_NAME || "Shoaib Q",
          phone_number: process.env.STORE_CONTACT_PHONE || "919867777860"  // ✔ country code included
        }
      }
    },

    drop_details: {
      address: {
        apartment_address: address.apartment || "",
        street_address1: address.line1,
        street_address2: address.area || "",
        landmark: address.landmark || "",
        city: address.city || "",
        state: "Maharashtra",
        pincode: address.pincode || "",
        country: "India",
        lat: Number(dropCoords.lat.toFixed(6)), // ✔ 6 decimals
        lng: Number(dropCoords.lng.toFixed(6)),
        contact_details: {
          name: address.name,
          phone_number: contact_number  // ✔ must include country code
        }
      }
    },

    delivery_instructions: {
      instructions_list: [
        { type: "text", description: `Fresh meat items: ${matter}` }
      ]
    },

    additional_comments: `Meat order via Al-Makhmali | ClientID: ${clientOrderId || "NA"} | Items: ${matter}`
  };

  try {
    const res = await porter.post("/v1/orders/create", payload);

    console.log("PORTER RESPONSE:", res.data);

    return {
      request_id: res.data.request_id,
      order_id: res.data.order_id,
      tracking_url: res.data.tracking_url,
      estimated_pickup_time: res.data.estimated_pickup_time,
      estimated_fare_details: res.data.estimated_fare_details,
      raw: res.data
    };

  } catch (err) {
    const body = err?.response?.data || err;
    const e = new Error(`Porter booking error: ${JSON.stringify(body)}`);
    e.raw = body;
    throw e;
  }
}


// ---------- Borzo helpers (adapt to actual Borzo endpoints) ----------
async function borzoQuote(address, items) {
  try {
    const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
    const totalWeightGrams = items.reduce((s, i) => s + (Number(i.weight || 0) * Number(i.qty || 0)), 0);
    const total_weight_kg = totalWeightGrams / 1000;

    const payload = {
      type: 'standard',
      matter,
      total_weight_kg,
      vehicle_type_id: 8,
      is_contact_person_notification_enabled: true,
      is_client_notification_enabled: true,
      points: [
        {
          address: process.env.STORE_ADDRESS || 'Makhmali The Fresh Meat Store, Thane',
          contact_person: { phone: process.env.STORE_CONTACT_PHONE || '919867777860', name: process.env.STORE_CONTACT_NAME || 'Shoaib Q' }
        },
        {
          address: `${address.line1 || ''} ${address.area || ''} ${address.city || ''} ${address.pincode || ''}`.trim(),
          contact_person: { phone: normalizePhoneNumber(address.phone), name: address.name },
          note: address.note || null
        }
      ],
      payment_method: 'balance'
    };

    const res = await borzo.post('/calculate-order', payload);

    if (!res.data?.order?.payment_amount) {
      throw new Error('Invalid response from Borzo API');
    }

    const fee = parseFloat(res.data.order.payment_amount);
    return { fee, raw: res.data };

  } catch (err) {
    console.error("Borzo quote error:", err.message);
    const error = new Error(`Borzo unavailable: ${err.message}`);
    error.originalError = err;
    throw error;
  }
}

async function borzoCreateOrder(address, items, clientOrderId) {
  const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
  const totalWeightGrams = items.reduce((s, i) => s + (Number(i.weight || 0) * Number(i.qty || 0)), 0);
  const total_weight_kg = totalWeightGrams / 1000;

  const payload = {
    type: 'standard',
    matter,
    total_weight_kg,
    vehicle_type_id: 8,
    is_contact_person_notification_enabled: true,
    is_client_notification_enabled: true,
    points: [
      {
        address: process.env.STORE_ADDRESS || 'Makhmali The Fresh Meat Store, Thane',
        contact_person: { phone: process.env.STORE_CONTACT_PHONE || '919867777860', name: process.env.STORE_CONTACT_NAME || 'Shoaib Q' }
      },
      {
        address: `${address.line1 || ''} ${address.area || ''} ${address.city || ''} ${address.pincode || ''}`,
        contact_person: { phone: normalizePhoneNumber(address.phone), name: address.name },
        client_order_id: String(clientOrderId),
        note: address.note || null
      }
    ],
    payment_method: 'balance'
  };

  try {
    const res = await borzo.post('/create-order', payload);
    const orderId = res.data?.order?.order_id ?? res.data?.data?.id ?? res.data?.order_id ?? null;
    const status = res.data?.order?.status ?? res.data?.status ?? 'created';
    const tracking_url = res.data?.order?.points?.[1]?.tracking_url ?? null;
    return { order_id: orderId, status, tracking_url, raw: res.data };
  } catch (err) {
    const body = err?.response?.data ?? err.message ?? err;
    const e = new Error(`Borzo booking error: ${JSON.stringify(body)}`);
    e.raw = err?.response?.data ?? null;
    throw e;
  }
}



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
    const dmRows = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'delivery_mode'");
    const deliveryMode = (dmRows[0]?.setting_value || 'manual').toLowerCase();

    let deliveryFee = 0;
    let chosenPartner;
    let errorMessages = [];

    switch (deliveryMode) {
      case 'manual':
        // For manual mode, use a fixed fee or calculate one partner
        try {
          const borzoResult = await borzoQuote(address, items);
          deliveryFee = parseFloat(borzoResult.fee);
        } catch (err) {
          console.error("Manual mode borzo quote failed:", err.message);
          // Fallback to a default fee
          deliveryFee = 200; // Default fallback fee
          errorMessages.push(`Manual calculation failed, using default: ${err.message}`);
        }
        break;

      case 'borzo_only':
        try {
          const borzoResult = await borzoQuote(address, items);
          deliveryFee = parseFloat(borzoResult.fee);
        } catch (err) {
          console.error("Borzo quote failed:", err.message);
          return res.status(400).json({
            error: "Borzo delivery unavailable for this address",
            details: err.message
          });
        }
        break;

      case 'porter_only':
        try {
          const porterResult = await porterQuote(address, items);
          deliveryFee = parseFloat(porterResult.fee);
        } catch (err) {
          console.error("Porter quote failed:", err.message);
          return res.status(400).json({
            error: "Porter delivery unavailable for this address",
            details: err.message
          });
        }
        break;

      case 'automatic_cheapest':
        try {
          // Calculate both and choose cheapest
          const [porterResult, borzoResult] = await Promise.all([
            porterQuote(address, items).catch(err => ({ error: err, fee: null })),
            borzoQuote(address, items).catch(err => ({ error: err, fee: null }))
          ]);

          let porterFee = porterResult.error ? null : parseFloat(porterResult.fee);
          let borzoFee = borzoResult.error ? null : parseFloat(borzoResult.fee);

          if (porterFee === null && borzoFee === null) {
            return res.status(400).json({
              error: "Both delivery partners unavailable for this address",
              details: {
                porter: porterResult.error?.message,
                borzo: borzoResult.error?.message
              }
            });
          }

          // Choose the cheapest available option
          // porterFee=porterFee+3000;
          // borzoFee=borzoFee+1000;
          if (porterFee !== null && borzoFee !== null) {
            deliveryFee = Math.min(porterFee, borzoFee);
            chosenPartner = porterFee <= borzoFee ? "porter" : "borzo";
          } else if (porterFee !== null) {
            deliveryFee = porterFee;
            chosenPartner = "porter";
          } else {
            deliveryFee = borzoFee;
            chosenPartner = "borzo";
          }

        } catch (err) {
          console.error("Automatic cheapest calculation failed:", err.message);
          return res.status(400).json({
            error: "Delivery fee calculation failed",
            details: err.message
          });
        }
        break;

      default:
        return res.status(400).json({ error: "Invalid delivery mode configuration" });
    }

    // Ensure delivery fee is a valid number
    if (isNaN(deliveryFee) || deliveryFee < 0) {
      deliveryFee = 0; //manual fallback
    }

    const response = { delivery_fee: Math.round(deliveryFee), chosen_partner: chosenPartner };

    if (errorMessages.length > 0) {
      response.warnings = errorMessages;
    }

    res.json(response);

  } catch (e) {
    console.error("Fee calculation error:", e.response?.data || e.message || e);
    res.status(500).json({
      error: "Failed to calculate delivery fee.",
      details: e.message
    });
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


// ---------- Main finalize-payment endpoint ----------
/**
 * Expected body:
 * {
 *   orderPayload: { cart: [...], address: {...}, payMethod, subtotal, delivery_fee, discount_amount, grand_total, platform_fee, surge_fee },
 *   paymentResponse: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * }
 */
app.post('/api/order/finalize-payment', verifyUserJWT, async (req, res) => {
  const { userId } = req.auth;
  const { orderPayload, paymentResponse } = req.body;
  if (!orderPayload || !paymentResponse) return res.status(400).json({ error: 'orderPayload and paymentResponse required' });

  // Verify Razorpay signature
  try {
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '');
    shasum.update(`${paymentResponse.razorpay_order_id}|${paymentResponse.razorpay_payment_id}`);
    const digest = shasum.digest('hex');
    if (digest !== paymentResponse.razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed: Invalid signature.' });
    }
  } catch (err) {
    console.error('Payment signature verification error:', err);
    return res.status(500).json({ error: 'Payment verification error' });
  }

  // Save order + items first (so we never lose order)
  const {
    cart = [], address = {}, payMethod, chosen_partner,
    subtotal = 0, delivery_fee = 0, discount_amount = 0, grand_total = 0, platform_fee = 0, surge_fee = 0
  } = orderPayload;

  let createdOrderId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertOrderSql = `
      INSERT INTO orders (
        user_id, customer_name, phone, address_line1, area, city, pincode,
        pay_method, subtotal, delivery_fee, discount_amount, grand_total,
        platform_fee, surge_fee, status, delivery_status, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PAYMENT_VERIFIED','pending',NOW())
      RETURNING id;
    `;
    const phoneNorm = normalizePhoneNumber(address.phone);
    const params = [
      userId,
      address.name || '',
      phoneNorm || '',
      address.line1 || '',
      address.area || '',
      address.city || '',
      address.pincode || '',
      payMethod || '',
      Math.round(subtotal || 0),
      Math.round(delivery_fee || 0),
      Math.round(discount_amount || 0),
      Math.round(grand_total || 0),
      Math.round(platform_fee || 0),
      Math.round(surge_fee || 0)
    ];
    const result = await client.query(insertOrderSql, params);
    createdOrderId = result.rows[0].id;

    const insertItemSql = `INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1,$2,$3,$4)`;
    for (const item of cart) {
      await client.query(insertItemSql, [createdOrderId, item.id, item.qty || 1, Math.round(item.price || 0)]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('DB error creating order:', err);
    return res.status(500).json({ error: 'Failed to create order after payment' });
  } finally {
    client.release();
  }

  // Respond to client immediately
  res.status(200).json({ status: 'success', orderId: createdOrderId });

  // Background booking + notification, wrapped in robust try/catch
  (async () => {
    async function markPending(orderId, partner, errMsg) {
      try {
        const exists = await query('SELECT id FROM deliveries WHERE order_id = $1', [orderId]);
        if (exists.length > 0) {
          await query(
            `UPDATE deliveries SET partner=$1, error_message=$2, status=$3, updated_at=NOW() WHERE order_id=$4`,
            [partner, errMsg || null, 'PENDING', orderId]
          );
        } else {
          await query(
            `INSERT INTO deliveries (order_id, delivery_task_id, partner, status, tracking_url, eta, error_message, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [orderId, null, partner, 'PENDING', null, null, errMsg || null]
          );
        }
        await query(`UPDATE orders SET delivery_status = 'pending' WHERE id = $1`, [orderId]);
        try {
          const items=cart;
          const cus = normalizePhoneNumber(address.phone);
          const fullAddress = `${address.line1} ${address.area} ${address.city} ${address.pincode}`;
          const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");

          if (cus) {
            await sendWhatsappMessage(cus, "order_created", matter, "PENDING", "You’ll receive a WhatsApp update with a tracking link once your order is CONFIRMED.");
            await whatappMessageToOwner("919867777860", "order_confirmed_message_to_owner",matter, address.phone, "PENDING- BOOK ORDER MANUALLY", address.name, fullAddress, "Please Manually Book Order and Resolve in Admin Panel")
            await whatappMessageToOwner("918779121361", "order_confirmed_message_to_owner",matter, address.phone, "PENDING- BOOK ORDER MANUALLY", address.name, fullAddress, "Please Manually Book Order and Resolve in Admin Panel")

          }
        } catch (waErr) {
          console.error('WhatsApp failed after Manual booking:', waErr?.message || waErr);
          await query(`UPDATE deliveries SET error_message = COALESCE(error_message, '') || $1 WHERE order_id = $2`, [` WhatsApp failed: ${waErr?.message || 'unknown'}`, createdOrderId]);
        }
      } catch (innerErr) {
        console.error('Failed to mark pending:', innerErr);
      }
    }

    try {
      const dmRows = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'delivery_mode'");
      const deliveryMode = (dmRows[0]?.setting_value || 'manual').toLowerCase();

      const addr = address;
      const items = cart;


      if (deliveryMode === 'manual') {
        await markPending(createdOrderId, 'manual', 'Manual mode chosen by admin');
        return;
      }

      if (deliveryMode === 'borzo_only') {
        try {
          const bk = await borzoCreateOrder(addr, items, createdOrderId);
          const full_orderId = `${bk.order_id} ${createdOrderId}`;
          const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
          const fullAddress = `${addr.line1} ${addr.area} ${addr.city} ${addr.pincode}`;


          if (!bk.order_id) throw new Error('Borzo returned no order_id');
          await query(
            `INSERT INTO deliveries (order_id, delivery_task_id, partner, status, tracking_url, eta, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
            [createdOrderId, bk.order_id, 'borzo', bk.status || 'created', bk.tracking_url || null, null]
          );
          await query(`UPDATE orders SET delivery_status = 'processing' WHERE id = $1`, [createdOrderId]);
          // WhatsApp best-effort
          try {
            const cus = normalizePhoneNumber(addr.phone);
            if (cus) {
              await sendWhatsappMessage(cus, "order_created", matter, "Confirmed", bk.tracking_url);
              await whatappMessageToOwner("919867777860", "order_confirmed_message_to_owner", matter, cus, `BORZO- ${full_orderId}`, fullAddress, bk.tracking_url)
              await whatappMessageToOwner("918779121361", "order_confirmed_message_to_owner", matter, cus, `BORZO- ${full_orderId}`, fullAddress, bk.tracking_url)

            }
          } catch (waErr) {
            console.error('WhatsApp failed after Borzo booking:', waErr?.message || waErr);
            await query(`UPDATE deliveries SET error_message = COALESCE(error_message, '') || $1 WHERE order_id = $2`, [` WhatsApp failed: ${waErr?.message || 'unknown'}`, createdOrderId]);
          }
        } catch (err) {
          console.error('Borzo booking failed:', err?.message || err);
          await markPending(createdOrderId, 'borzo', `Borzo booking failed: ${err?.message || 'unknown'}`);
        }
        return;
      }

      if (deliveryMode === 'porter_only') {
        try {
          const bk = await porterCreateOrder(addr, items, createdOrderId);
          const full_orderId = `${bk.order_id} ${createdOrderId}`;
          const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
          const fullAddress = `${addr.line1} ${addr.area} ${addr.city} ${addr.pincode}`;


          if (!bk.order_id) throw new Error('Porter returned no order_id');
          await query(
            `INSERT INTO deliveries (order_id, delivery_task_id, partner, status, tracking_url, eta, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
            [createdOrderId, bk.order_id, 'porter', bk.status || 'created', bk.tracking_url || null, null]
          );
          await query(`UPDATE orders SET delivery_status = 'processing' WHERE id = $1`, [createdOrderId]);
          // WhatsApp best-effort
          try {
            const cus = normalizePhoneNumber(addr.phone);
            if (cus) {
              await sendWhatsappMessage(cus, "order_created", matter, "Confirmed", bk.tracking_url);
              await whatappMessageToOwner("919867777860", "order_confirmed_message_to_owner", matter, cus, `PORTER- ${full_orderId}`, fullAddress, bk.tracking_url)
              await whatappMessageToOwner("918779121361", "order_confirmed_message_to_owner", matter, cus, `PORTER- ${full_orderId}`, fullAddress, bk.tracking_url)

            }
          } catch (waErr) {
            console.error('WhatsApp failed after Porter booking:', waErr?.message || waErr);
            await query(`UPDATE deliveries SET error_message = COALESCE(error_message, '') || $1 WHERE order_id = $2`, [` WhatsApp failed: ${waErr?.message || 'unknown'}`, createdOrderId]);
          }
        } catch (err) {
          console.error('Porter booking failed:', err?.message || err);
          await markPending(createdOrderId, 'porter', `Porter booking failed: ${err?.message || 'unknown'}`);
        }
        return;
      }

      // Inside the finalize-payment endpoint, replace the automatic_cheapest section:
      if (deliveryMode === 'automatic_cheapest') {
        const matter = items.map((i) => `${i.qty}x ${i.name}${i.weight ? ` (${i.weight}g)` : ""}`).join(", ");
        const fullAddress = `${addr.line1} ${addr.area} ${addr.city} ${addr.pincode}`;

        try {
          const chosenPartner = chosen_partner;
          console.log(chosenPartner)
          let bookingResult = null;
          // Book with chosen partner
          if (chosenPartner === 'porter') {
            bookingResult = await porterCreateOrder(addr, items, createdOrderId);
            console.log("used porter");
          } else if (chosenPartner == 'borzo') {
            bookingResult = await borzoCreateOrder(addr, items, createdOrderId);
            console.log("used borzo");
          }

          if (!bookingResult.order_id) {
            throw new Error(`${chosenPartner} booking failed: no order ID returned`);
          }

          // Save delivery record
          await query(
            `INSERT INTO deliveries (order_id, delivery_task_id, partner, status, tracking_url, eta, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
            [createdOrderId, bookingResult.order_id, chosenPartner, bookingResult.status || 'created', bookingResult.tracking_url || null, null]
          );

          await query(`UPDATE orders SET delivery_status = 'processing' WHERE id = $1`, [createdOrderId]);
          //whatsapp best efforts 
          try {
            const cus = normalizePhoneNumber(addr.phone);
            if (cus) {
              await sendWhatsappMessage(cus, "order_created", matter, "Confirmed", bookingResult.tracking_url)
              await whatappMessageToOwner("919867777860", "order_confirmed_message_to_owner", matter, cus, `${chosenPartner.toUpperCase()}- ${bookingResult.order_id} ${createdOrderId}`, fullAddress, bookingResult.tracking_url)
              await whatappMessageToOwner("918779121361", "order_confirmed_message_to_owner", matter, cus, `${chosenPartner.toUpperCase()}- ${bookingResult.order_id} ${createdOrderId}`, fullAddress, bookingResult.tracking_url)

            }
          } catch (waErr) {
            console.error('WhatsApp failed after automatic_booking booking:', waErr?.message || waErr);
            await query(`UPDATE deliveries SET error_message = COALESCE(error_message, '') || $1 WHERE order_id = $2`, [` WhatsApp failed: ${waErr?.message || 'unknown'}`, createdOrderId]);
          }

        } catch (err) {
          console.error('automatic_cheapest booking error:', err.message);
          await markPending(createdOrderId, 'automatic', `automatic_cheapest failure: ${err.message}`);
        }
        return;
      }
      // unknown delivery mode
      await markPending(createdOrderId, 'unknown', `Unknown delivery_mode: ${deliveryMode}`);
    } catch (bgErr) {
      console.error('Background error in delivery processing:', bgErr?.message || bgErr);
      try {
        await query(
          `INSERT INTO deliveries (order_id, delivery_task_id, partner, status, error_message, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())`,
          [createdOrderId, null, 'system', 'PENDING', `Background failure: ${bgErr?.message || 'unknown'}`]
        );
        await query(`UPDATE orders SET delivery_status = 'pending' WHERE id = $1`, [createdOrderId]);
        //whatsapp best efforts
        try {
          const cus = normalizePhoneNumber(address.phone);
          if (cus) {
            await sendWhatsappMessage(cus, "order_created", "Please Contact Support for verification", "Pending. Please contact support: 9867777860", "If any amount has been debited, please contact support. Refunds are issued within 3-5 working days.")
          }
        } catch (waErr) {
          console.error('WhatsApp failed after automatic_booking booking:', waErr?.message || waErr);
          await query(`UPDATE deliveries SET error_message = COALESCE(error_message, '') || $1 WHERE order_id = $2`, [` WhatsApp failed: ${waErr?.message || 'unknown'}`, createdOrderId]);
        }

      } catch (dbErr) {
        console.error('Failed to log background failure to DB:', dbErr);
      }
    }
  })();
});


// pool.on("error", (err) => {
//   console.error("Postgres connection error:", err);
// });


app.use(express.static(path.join(__dirname, "frontend/dist")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "frontend/dist", "index.html"));
});

// ---------- Mount admin routes ----------
app.use('/api/admin', adminRoutes);

// ---------- Health & server ----------
app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server started on port ${port}`));










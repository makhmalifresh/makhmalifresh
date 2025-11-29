import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
// import pkg from 'pg';
import 'dotenv/config';
import axios from 'axios';

const router = express.Router();
// const { Pool } = pkg;

import pool from "./db.js"



// --- JWT Configuration ---
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'your-default-super-secret-key';

// --- MIDDLEWARE: Verify Admin JWT ---
export const verifyAdminJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) {
      return res.status(403).json({ error: 'Forbidden: Not an admin token' });
    }
    req.admin = { id: decoded.adminId };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// --- Helper functions ---
function normalizePhoneNumber(phone) {
  if (!phone) return phone;
  let s = String(phone).trim().replace(/\s+/g, '');
  if (s.startsWith('+')) return s;
  if (/^[0-9]{10}$/.test(s)) return '+91' + s;
  if (/^0[0-9]{10}$/.test(s)) return '+91' + s.slice(1);
  return s;
}

async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// WhatsApp client (best-effort)
const whatsapp = axios.create({
  baseURL: process.env.WHATSAPP_BASE_URL || 'https://graph.facebook.com/v22.0/811413942060929',
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_API_KEY || ''}`,
    'Content-Type': 'application/json'
  }
});

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

/* ----------------------
   Public admin login route
   ---------------------- */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const admin = result.rows[0];
    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ adminId: admin.id, isAdmin: true }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ message: 'Login successful', token });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// protect all routes after this middleware
router.use(verifyAdminJWT);

/* ----------------------
   Existing routes (unchanged)
   ---------------------- */

// Store status GET
router.get('/settings/store-status', async (req, res) => {
  try {
    let result = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'is_store_open'");
    if (result.rows.length === 0) {
      await pool.query("INSERT INTO store_settings (setting_key, setting_value) VALUES ('is_store_open', 'true')");
      return res.json({ setting_key: 'is_store_open', setting_value: 'true' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching store status:', error);
    res.status(500).json({ error: 'Failed to fetch store status' });
  }
});

// Store status PUT
router.put('/settings/store-status', async (req, res) => {
  const { isOpen } = req.body;
  if (typeof isOpen !== 'boolean') return res.status(400).json({ error: 'Field "isOpen" must be a boolean.' });
  try {
    const queryText = `
      UPDATE store_settings
      SET setting_value = $1
      WHERE setting_key = 'is_store_open'
      RETURNING setting_key, setting_value;
    `;
    const result = await pool.query(queryText, [isOpen.toString()]);
    res.json({ message: 'Store status updated successfully.', setting: result.rows[0] });
  } catch (error) {
    console.error('Error updating store status:', error);
    res.status(500).json({ error: 'Failed to update store status' });
  }
});

// Platform fee GET/PUT
router.get('/settings/platform-fee', async (req, res) => {
  try {
    const result = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'platform_fee'");
    if (result.rows.length === 0) return res.json({ setting_key: 'platform_fee', setting_value: '0' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching platform fee:', error);
    res.status(500).json({ error: 'Failed to fetch platform fee' });
  }
});
router.put('/settings/platform-fee', async (req, res) => {
  const { fee } = req.body;
  const feeValue = parseInt(fee, 10);
  if (isNaN(feeValue) || feeValue < 0) return res.status(400).json({ error: 'Platform fee must be a non-negative number.' });
  try {
    const queryText = `
      INSERT INTO store_settings (setting_key, setting_value)
      VALUES ('platform_fee', $1)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
      RETURNING setting_key, setting_value;
    `;
    const result = await pool.query(queryText, [feeValue.toString()]);
    res.json({ message: 'Platform fee updated successfully.', setting: result.rows[0] });
  } catch (error) {
    console.error('Error updating platform fee:', error);
    res.status(500).json({ error: 'Failed to update platform fee' });
  }
});

// Surge fee GET/PUT
router.get('/settings/surge-fee', async (req, res) => {
  try {
    const result = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'surge_fee'");
    if (result.rows.length === 0) return res.json({ setting_key: 'surge_fee', setting_value: '0' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching surge fee:', error);
    res.status(500).json({ error: 'Failed to fetch surge fee' });
  }
});
router.put('/settings/surge-fee', async (req, res) => {
  const { surge } = req.body;
  const surgeValue = parseInt(surge, 10);
  if (isNaN(surgeValue) || surgeValue < 0) return res.status(400).json({ error: 'Surge fee must be a non-negative number.' });
  try {
    const queryText = `
      INSERT INTO store_settings (setting_key, setting_value)
      VALUES ('surge_fee', $1)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
      RETURNING setting_key, setting_value;
    `;
    const result = await pool.query(queryText, [surgeValue.toString()]);
    res.json({ message: 'Surge fee updated successfully.', setting: result.rows[0] });
  } catch (error) {
    console.error('Error updating surge fee:', error);
    res.status(500).json({ error: 'Failed to update surge fee' });
  }
});

// Offers, coupons, products, orders routes (kept as-is from your pasted file)
router.get('/offers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});
router.get('/unassigned-coupons', async (req, res) => {
  try {
    const query = `
      SELECT code FROM coupons 
      WHERE is_active = true AND code NOT IN (SELECT coupon_code FROM offers)
      ORDER BY code ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch unassigned coupons' });
  }
});
router.post('/offers', async (req, res) => {
  const { name, description, coupon_code } = req.body;
  if (!name || !description || !coupon_code) return res.status(400).json({ error: 'All fields are required.' });
  try {
    const q = `INSERT INTO offers (name, description, coupon_code) VALUES ($1, $2, $3) RETURNING *`;
    const result = await pool.query(q, [name, description, coupon_code]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This coupon is already used in another offer.' });
    res.status(500).json({ error: 'Failed to create offer' });
  }
});
router.delete('/offers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM offers WHERE id = $1', [id]);
    res.status(200).json({ message: 'Offer deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete offer' });
  }
});

// Coupons CRUD
router.get('/coupons', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});
router.post('/coupons', async (req, res) => {
  console.log('Received request to create coupon with data:', req.body);
  const { code, discount_type, discount_value } = req.body;
  if (!code || !discount_type || !discount_value) return res.status(400).json({ error: 'All fields are required.' });
  try {
    const existingCoupon = await pool.query('SELECT id FROM coupons WHERE code = $1', [code.toUpperCase()]);
    if (existingCoupon.rows.length > 0) return res.status(409).json({ error: 'A coupon with this code already exists.' });
    const queryText = `INSERT INTO coupons (code, discount_type, discount_value) VALUES ($1, $2, $3) RETURNING *;`;
    const params = [code.toUpperCase(), discount_type, parseInt(discount_value, 10)];
    const newCoupon = await pool.query(queryText, params);
    res.status(201).json(newCoupon.rows[0]);
  } catch (error) {
    console.error('Error creating coupon in database:', error);
    res.status(500).json({ error: 'Internal Server Error: Could not create coupon.' });
  }
});
router.put('/coupons/:id', async (req, res) => {
  const { id } = req.params;
  const { code, discount_type, discount_value, is_active, expires_at } = req.body;
  try {
    const queryText = `
      UPDATE coupons
      SET code = $1, discount_type = $2, discount_value = $3, is_active = $4, expires_at = $5
      WHERE id = $6
      RETURNING *;
    `;
    const result = await pool.query(queryText, [code.toUpperCase(), discount_type, discount_value, is_active, expires_at, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Coupon not found.' });
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Another coupon with this code already exists.' });
    console.error('Error updating coupon:', error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});
router.delete('/coupons/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM coupons WHERE id = $1 RETURNING *;', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Coupon not found.' });
    res.status(200).json({ message: 'Coupon deleted successfully.' });
  } catch (error) {
    console.error('Error deleting coupon:', error);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// Product management
router.get('/products', async (req, res) => {
  try {
    const products = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(products.rows);
  } catch (error) {
    console.error('Error fetching products for admin:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});
// router.post('/products', async (req, res) => {
//   const { name, cut, weight, price, img, tags } = req.body;
//   if (!name || !price) return res.status(400).json({ error: 'Name and Price are required fields.' });
//   try {
//     const queryText = `INSERT INTO products (name, cut, weight, price, img, tags) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`;
//     const newProduct = await pool.query(queryText, [name, cut, weight, price, img, tags]);
//     res.status(201).json(newProduct.rows[0]);
//   } catch (error) {
//     console.error('Error creating product:', error);
//     res.status(500).json({ error: 'Failed to create product' });
//   }
// });

router.post('/products', async (req, res) => {
  const { name, cut, img, tags, variants } = req.body; // Removed top-level weight/price

  if (!name || !variants || variants.length === 0) {
    return res.status(400).json({ error: 'Name and at least one variant are required.' });
  }

  try {
    // We store the price of the FIRST variant as the "main" price for sorting/display
    const mainPrice = variants[0].price;
    const mainWeight = variants[0].weight;

    const sql = `
      INSERT INTO products (name, cut, weight, price, img, tags, variants) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING *;
    `;
    // We explicitly cast the variants array to JSON for Postgres
    const params = [name, cut, parseInt(mainWeight) || 0, mainPrice, img, tags, JSON.stringify(variants)];

    const newProduct = await query(sql, params);
    res.status(201).json(newProduct[0]);
  } catch (error) {
    console.error('Error creating product:', error.message);
    res.status(500).json({ error: 'Failed to create product' });
  }
});


router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, cut, img, tags, variants } = req.body;

  if (!name || !variants || variants.length === 0) {
    return res.status(400).json({ error: 'Name and variants are required.' });
  }

  try {
    // Update main price/weight based on the first variant
    const mainPrice = variants[0].price;
    const mainWeight = variants[0].weight;

    const sql = `
      UPDATE products
      SET name = $1, cut = $2, weight = $3, price = $4, img = $5, tags = $6, variants = $7
      WHERE id = $8
      RETURNING *;
    `;
    const params = [name, cut, parseInt(mainWeight) || 0, mainPrice, img, tags, JSON.stringify(variants), id];

    const result = await query(sql, params);
    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product updated successfully.', product: result[0] });
  } catch (error) {
    console.error('Error updating product:', error.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});


router.put('/products/:id/toggle-availability', async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;
  if (typeof is_available !== 'boolean') return res.status(400).json({ error: 'Field "is_available" must be a boolean.' });
  try {
    const queryText = `UPDATE products SET is_available = $1 WHERE id = $2 RETURNING id, name, is_available;`;
    const updatedProduct = await pool.query(queryText, [is_available, id]);
    if (updatedProduct.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product availability updated successfully.', product: updatedProduct.rows[0] });
  } catch (error) {
    console.error('Error toggling product availability:', error);
    res.status(500).json({ error: 'Failed to update product availability' });
  }
});

// Orders list
router.get('/orders', async (req, res) => {
  try {
    const queryStr = `
      SELECT 
        o.*, 
        d.tracking_url, d.partner,
        (
          SELECT json_agg(json_build_object(
            'name', p.name, 
            'qty', oi.qty, 
            'price', oi.price
          ))
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = o.id
        ) as items
      FROM orders o
      LEFT JOIN deliveries d ON o.id = d.order_id
      ORDER BY o.created_at DESC;
    `;
    const result = await pool.query(queryStr);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching orders for admin:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.post('/orders/:orderId/cancel', (req, res) => {
  res.json({ message: `Order ${req.params.orderId} cancelled (placeholder)` });
});

router.get('/settings/delivery-mode', async (req, res) => {
  try {
    const rows = await pool.query(
      "SELECT setting_value FROM store_settings WHERE setting_key = 'delivery_mode'"
    );

    if (rows.rows.length === 0) {
      // If not set yet, default to manual
      return res.json({ setting_value: 'manual' });
    }

    return res.json(rows.rows[0]);
  } catch (error) {
    console.error('Error fetching delivery mode:', error);
    return res.status(500).json({ error: 'Failed to fetch delivery mode' });
  }
});


router.put('/settings/delivery-mode', async (req, res) => {
  const { delivery_mode } = req.body;
  const allowed = ['manual', 'borzo_only', 'porter_only', 'automatic_cheapest'];
  if (!delivery_mode || !allowed.includes(delivery_mode)) {
    return res.status(400).json({ error: `delivery_mode required and must be one of: ${allowed.join(', ')}` });
  }

  try {
    const upsert = `
      INSERT INTO store_settings (setting_key, setting_value)
      VALUES ('delivery_mode', $1)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
      RETURNING setting_key, setting_value;
    `;
    const rows = await query(upsert, [delivery_mode]);
    res.json({ message: 'Delivery mode updated', setting: rows[0] });
  } catch (err) {
    console.error('Failed to update delivery mode:', err);
    res.status(500).json({ error: 'Failed to update delivery mode' });
  }
});

/**
 * GET /api/admin/orders/pending
 * Returns orders with orders.delivery_status = 'pending' OR deliveries.status = 'PENDING'
 */
router.get('/orders/pending', async (req, res) => {
  try {
    const q = `
      SELECT o.*, d.tracking_url, d.partner, d.error_message
      FROM orders o
      LEFT JOIN deliveries d ON o.id = d.order_id
      WHERE o.delivery_status = 'pending' OR o.delivery_status = 'failed'
      ORDER BY o.created_at DESC;
    `;
    const rows = await query(q);
    res.json(rows);
  } catch (err) {
    console.error('Failed to fetch pending orders:', err.message);
    res.status(500).json({ error: 'Failed to fetch pending orders' });
  }
});

/**
 * POST /api/admin/orders/:orderId/manual-book
 * Body: { partner: 'borzo'|'porter'|'manual'|'other', tracking_id?, tracking_url?, status? ('processing'|'shipped'), note? }
 */
router.post('/orders/:orderId/manual-book', async (req, res) => {
  const { orderId } = req.params;
  const { partner_name, tracking_url } = req.body;

  if (!partner_name) {
    return res.status(400).json({ error: 'Partner name is required' });
  }

  try {
    // A) UPSERT into deliveries table
    await query(
      `INSERT INTO deliveries (order_id, partner, delivery_task_id, status, tracking_url, updated_at)
       VALUES ($1, $2, 'MANUAL', 'shipped', $3, NOW())
       ON CONFLICT (order_id) DO UPDATE SET
       partner = $2, 
       status = 'shipped', 
       tracking_url = $3, 
       error_message = NULL, 
       updated_at = NOW()`,
      [orderId, partner_name, tracking_url || null]
    );

    // B) Update orders table
    await query(
      `UPDATE orders SET delivery_status = 'processing' WHERE id = $1`,
      [orderId]
    );

    // C) Send WhatsApp notifications — Best effort
    try {
      // ONE DB CALL: fetch both delivery + order info
      const rows = await query(
        `SELECT 
            o.phone,
            o.customer_name,
            o.address_line1,
            o.area,
            o.city,
            o.pincode,
            d.tracking_url,
            d.partner
         FROM orders o
         LEFT JOIN deliveries d ON d.order_id = o.id
         WHERE o.id = $1`,
        [orderId]
      );

      const data = rows[0];
      if (!data) throw new Error("Order not found");

      const cus = normalizePhoneNumber(data.phone);
      const fullAddress = `${data.address_line1} ${data.area} ${data.city} ${data.pincode}`;

      const productMessage = `Check the admin panel for product details of order ${orderId}`;

      console.log("tracking:", data.tracking_url);
      console.log("partner:", data.partner);
      console.log("address:", fullAddress);

      if (cus) {
        // Send to customer
        await sendWhatsappMessage(
          cus,
          "order_created",
          "which was pending is CONFIRMED now and the tracking link",
          "Below",
          data.tracking_url
        );

        // Send to admin/owner
        // await whatappMessageToOwner(
        //   "919321561224",
        //   "order_confirmed_message_to_owner",
        //   productMessage,         // {{5}}
        //   cus,                    // {{4}}
        //   `${data.partner} - ${orderId}`,                // {{1}} 
        //   data.customer_name,     // {{2}}
        //   fullAddress,            // {{3}}
        //   data.tracking_url       // {{6}}
        // );

      }
    } catch (waErr) {
      console.error("WhatsApp manual update failed:", waErr.message);
      if (waErr.response) {
        console.error("Status:", waErr.response.status);
        console.error("Data:", JSON.stringify(waErr.response.data, null, 2));
        console.error("Headers:", waErr.response.headers);
      } else {
        console.error("Error:", waErr);
      }
      // WhatsApp errors do NOT break the API call
    }

    return res.json({ message: 'Order manually resolved and updated.' });

  } catch (err) {
    console.error('Failed manual resolve:', err.message);
    return res.status(500).json({ error: 'Failed to manually resolve order' });
  }
});

export default router;

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

// We import both the custom 'query' function (for most routes)
// and the 'pool' itself (for the special login route)
import pool, { query } from './db.js';

const router = express.Router();

// --- JWT Configuration ---
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'your-default-super-secret-key';

// --- MIDDLEWARE: Verify Admin JWT (Unchanged) ---
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

// --- ROUTE: Admin Login (Public) ---
// This route is a special case and was already correct.
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const admin = result.rows[0];
    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { adminId: admin.id, isAdmin: true },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ message: 'Login successful', token });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- All routes below this line are protected by the verifyAdminJWT middleware ---
router.use(verifyAdminJWT);

// --- Store Controls (CORRECTED) ---
router.get('/settings/store-status', async (req, res) => {
  try {
    // The 'query' function returns the rows array directly
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'is_store_open'");
    if (result.length === 0) { // FIXED
      await query("INSERT INTO store_settings (setting_key, setting_value) VALUES ('is_store_open', 'true')");
      return res.json({ setting_key: 'is_store_open', setting_value: 'true' });
    }
    res.json(result[0]); // FIXED
  } catch (error) {
    console.error('Error fetching store status:', error.message);
    res.status(500).json({ error: 'Failed to fetch store status' });
  }
});

router.put('/settings/store-status', async (req, res) => {
  const { isOpen } = req.body;
  if (typeof isOpen !== 'boolean') {
    return res.status(400).json({ error: 'Field "isOpen" must be a boolean.' });
  }
  try {
    const sql = `UPDATE store_settings SET setting_value = $1 WHERE setting_key = 'is_store_open' RETURNING setting_key, setting_value;`;
    const result = await query(sql, [isOpen.toString()]);
    res.json({ message: 'Store status updated successfully.', setting: result[0] }); // FIXED
  } catch (error) {
    console.error('Error updating store status:', error.message);
    res.status(500).json({ error: 'Failed to update store status' });
  }
});

// --- Platform Fee (CORRECTED) ---
router.get('/settings/platform-fee', async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'platform_fee'");
    res.json(result[0] || { setting_key: 'platform_fee', setting_value: '0' }); // FIXED
  } catch (error) {
    console.error('Error fetching platform fee:', error.message);
    res.status(500).json({ error: 'Failed to fetch platform fee' });
  }
});

router.put('/settings/platform-fee', async (req, res) => {
  const { fee } = req.body;
  const feeValue = parseInt(fee, 10);
  if (isNaN(feeValue) || feeValue < 0) {
    return res.status(400).json({ error: 'Platform fee must be a non-negative number.' });
  }
  try {
    const sql = `INSERT INTO store_settings (setting_key, setting_value) VALUES ('platform_fee', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value RETURNING *;`;
    const result = await query(sql, [feeValue.toString()]);
    res.json({ message: 'Platform fee updated successfully.', setting: result[0] }); // FIXED
  } catch (error) {
    console.error('Error updating platform fee:', error.message);
    res.status(500).json({ error: 'Failed to update platform fee' });
  }
});

// --- Surge Fee (CORRECTED) ---
router.get('/settings/surge-fee', async (req, res) => {
  try {
    const result = await query("SELECT setting_value FROM store_settings WHERE setting_key = 'surge_fee'");
    res.json(result[0] || { setting_key: 'surge_fee', setting_value: '0' }); // FIXED
  } catch (error) {
    console.error('Error fetching surge fee:', error.message);
    res.status(500).json({ error: 'Failed to fetch surge fee' });
  }
});

router.put('/settings/surge-fee', async (req, res) => {
  const { surge } = req.body;
  const surgeValue = parseInt(surge, 10);
  if (isNaN(surgeValue) || surgeValue < 0) {
    return res.status(400).json({ error: 'Surge fee must be a non-negative number.' });
  }
  try {
    const sql = `INSERT INTO store_settings (setting_key, setting_value) VALUES ('surge_fee', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value RETURNING *;`;
    const result = await query(sql, [surgeValue.toString()]);
    res.json({ message: 'Surge fee updated successfully.', setting: result[0] }); // FIXED
  } catch (error) {
    console.error('Error updating surge fee:', error.message);
    res.status(500).json({ error: 'Failed to update surge fee' });
  }
});

// --- Offer Management (CORRECTED) ---
router.get('/offers', async (req, res) => {
  try {
    const offers = await query('SELECT * FROM offers ORDER BY created_at DESC');
    res.json(offers); // FIXED
  } catch (error) {
    console.error('Error fetching offers:', error.message);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

router.get('/unassigned-coupons', async (req, res) => {
  try {
    const sql = `SELECT code FROM coupons WHERE is_active = true AND code NOT IN (SELECT coupon_code FROM offers) ORDER BY code ASC;`;
    const coupons = await query(sql);
    res.json(coupons); // FIXED
  } catch (error) {
    console.error('Error fetching unassigned coupons:', error.message);
    res.status(500).json({ error: 'Failed to fetch unassigned coupons' });
  }
});

router.post('/offers', async (req, res) => {
  const { name, description, coupon_code } = req.body;
  if (!name || !description || !coupon_code) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const sql = `INSERT INTO offers (name, description, coupon_code) VALUES ($1, $2, $3) RETURNING *`;
    const newOffer = await query(sql, [name, description, coupon_code]);
    res.status(201).json(newOffer[0]); // FIXED
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This coupon is already used in another offer.' });
    }
    console.error('Error creating offer:', error.message);
    res.status(500).json({ error: 'Failed to create offer' });
  }
});

router.delete('/offers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await query('DELETE FROM offers WHERE id = $1', [id]);
    res.status(200).json({ message: 'Offer deleted successfully.' });
  } catch (error) {
    console.error('Error deleting offer:', error.message);
    res.status(500).json({ error: 'Failed to delete offer' });
  }
});

// --- Coupon Management (CORRECTED) ---
router.get('/coupons', async (req, res) => {
  try {
    const coupons = await query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(coupons); // FIXED
  } catch (error) {
    console.error('Error fetching coupons:', error.message);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

router.post('/coupons', async (req, res) => {
  const { code, discount_type, discount_value } = req.body;
  if (!code || !discount_type || !discount_value) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const existingCoupon = await query('SELECT id FROM coupons WHERE code = $1', [code.toUpperCase()]);
    if (existingCoupon.length > 0) { // FIXED
      return res.status(409).json({ error: 'A coupon with this code already exists.' });
    }
    const sql = `INSERT INTO coupons (code, discount_type, discount_value) VALUES ($1, $2, $3) RETURNING *;`;
    const params = [code.toUpperCase(), discount_type, parseInt(discount_value, 10)];
    const newCoupon = await query(sql, params);
    res.status(201).json(newCoupon[0]); // FIXED
  } catch (error) {
    console.error('Error creating coupon in database:', error.message);
    res.status(500).json({ error: 'Internal Server Error: Could not create coupon.' });
  }
});

router.put('/coupons/:id', async (req, res) => {
  const { id } = req.params;
  const { code, discount_type, discount_value, is_active, expires_at } = req.body;
  try {
    const sql = `UPDATE coupons SET code = $1, discount_type = $2, discount_value = $3, is_active = $4, expires_at = $5 WHERE id = $6 RETURNING *;`;
    const result = await query(sql, [code.toUpperCase(), discount_type, discount_value, is_active, expires_at, id]);
    if (result.length === 0) { // FIXED
      return res.status(404).json({ error: 'Coupon not found.' });
    }
    res.json(result[0]); // FIXED
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Another coupon with this code already exists.' });
    }
    console.error('Error updating coupon:', error.message);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

router.delete('/coupons/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query('DELETE FROM coupons WHERE id = $1 RETURNING *;', [id]);
    if (result.length === 0) { // FIXED
      return res.status(404).json({ error: 'Coupon not found.' });
    }
    res.status(200).json({ message: 'Coupon deleted successfully.' });
  } catch (error) {
    console.error('Error deleting coupon:', error.message);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// --- PRODUCT MANAGEMENT (CORRECTED) ---
router.get('/products', async (req, res) => {
  try {
    const products = await query('SELECT * FROM products ORDER BY id DESC');
    res.json(products); // FIXED
  } catch (error) {
    console.error('Error fetching products for admin:', error.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.post('/products', async (req, res) => {
  const { name, cut, weight, price, img, tags } = req.body;
  if (!name || !price) {
    return res.status(400).json({ error: 'Name and Price are required fields.' });
  }
  try {
    const sql = `INSERT INTO products (name, cut, weight, price, img, tags) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`;
    const newProduct = await query(sql, [name, cut, weight, price, img, tags]);
    res.status(201).json(newProduct[0]); // FIXED
  } catch (error) {
    console.error('Error creating product:', error.message);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/products/:id/toggle-availability', async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;
  if (typeof is_available !== 'boolean') {
    return res.status(400).json({ error: 'Field "is_available" must be a boolean.' });
  }
  try {
    const sql = `UPDATE products SET is_available = $1 WHERE id = $2 RETURNING id, name, is_available;`;
    const updatedProduct = await query(sql, [is_available, id]);
    if (updatedProduct.length === 0) { // FIXED
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product availability updated.', product: updatedProduct[0] }); // FIXED
  } catch (error) {
    console.error('Error toggling product availability:', error.message);
    res.status(500).json({ error: 'Failed to update product availability' });
  }
});


router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, cut, weight, price, img, tags } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Name and Price are required.' });
  }

  try {
    const sql = `
      UPDATE products
      SET name = $1, cut = $2, weight = $3, price = $4, img = $5, tags = $6
      WHERE id = $7
      RETURNING *;
    `;
    // Note: 'tags' is expected as an array (e.g., {'Beef', 'Premium'})
    const params = [name, cut, weight, price, img, tags, id];
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

// --- NEW: DELETE a product ---
router.delete('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query('DELETE FROM products WHERE id = $1 RETURNING *;', [id]);
    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.status(200).json({ message: 'Product deleted successfully.' });
  } catch (error) {
    // --- THIS IS THE FIX ---
    // We check for the specific PostgreSQL error code for a foreign key violation.
    if (error.code === '23503') {
      return res.status(409).json({ // 409 Conflict
        error: 'This product cannot be deleted. It is part of one or more past orders. Please make it "Unavailable" instead.'
      });
    }
    console.error('Error deleting product:', error.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// --- Order Management (CORRECTED) ---
router.get('/orders', async (req, res) => {
  try {
    const queryStr = `
      SELECT o.*, d.tracking_url,
        (SELECT json_agg(json_build_object('name', p.name, 'qty', oi.qty, 'price', oi.price))
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = o.id) as items
      FROM orders o
      LEFT JOIN deliveries d ON o.id = d.order_id
      ORDER BY o.created_at DESC;
    `;
    const orders = await query(queryStr);
    res.json(orders); // FIXED
  } catch (error) {
    console.error('Error fetching orders for admin:', error.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.post('/orders/:orderId/cancel', async (req, res) => {
  try {
    const { orderId } = req.params;
    await query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [orderId]);
    res.json({ message: `Order ${orderId} cancelled.` });
  } catch(error) {
    console.error('Error cancelling order:', error.message);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

export const adminRouter = router;
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import 'dotenv/config';

const router = express.Router();
const { Pool } = pkg;

// --- Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

// --- ROUTE: Admin Login (Public) ---
// Path: POST /api/admin/login
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

// --- Store Controls ---


router.get('/settings/store-status', async (req, res) => {
  try {
    let result = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'is_store_open'");

    // If the setting does not exist, create it with a default value of 'true'
    if (result.rows.length === 0) {
      console.log("Store setting not found, creating a default one.");
      await pool.query(
        "INSERT INTO store_settings (setting_key, setting_value) VALUES ('is_store_open', 'true')"
      );
      // Return the newly created default setting
      return res.json({ setting_key: 'is_store_open', setting_value: 'true' });
    }

    // If it exists, return the found setting
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching store status:', error);
    res.status(500).json({ error: 'Failed to fetch store status' });
  }
});
// Path: PUT /api/admin/settings/store-status
router.put('/settings/store-status', async (req, res) => {
  const { isOpen } = req.body;

  if (typeof isOpen !== 'boolean') {
    return res.status(400).json({ error: 'Field "isOpen" must be a boolean.' });
  }

  try {
    const query = `
      UPDATE store_settings
      SET setting_value = $1
      WHERE setting_key = 'is_store_open'
      RETURNING setting_key, setting_value;
    `;
    const result = await pool.query(query, [isOpen.toString()]);
    res.json({
      message: 'Store status updated successfully.',
      setting: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating store status:', error);
    res.status(500).json({ error: 'Failed to update store status' });
  }
});


// --- NEW: Platform Fee Management (Admin Only) ---

// GET the current platform fee
router.get('/settings/platform-fee', async (req, res) => {
  try {
    const result = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'platform_fee'");
    if (result.rows.length === 0) {
      return res.json({ setting_key: 'platform_fee', setting_value: '0' }); // Default to 0 if not set
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching platform fee:', error);
    res.status(500).json({ error: 'Failed to fetch platform fee' });
  }
});

// SET the platform fee (using UPSERT for robustness)
router.put('/settings/platform-fee', async (req, res) => {
  const { fee } = req.body;
  const feeValue = parseInt(fee, 10);

  if (isNaN(feeValue) || feeValue < 0) {
    return res.status(400).json({ error: 'Platform fee must be a non-negative number.' });
  }

  try {
    const query = `
      INSERT INTO store_settings (setting_key, setting_value)
      VALUES ('platform_fee', $1)
      ON CONFLICT (setting_key) 
      DO UPDATE SET setting_value = EXCLUDED.setting_value
      RETURNING setting_key, setting_value;
    `;
    const result = await pool.query(query, [feeValue.toString()]);
    res.json({
      message: 'Platform fee updated successfully.',
      setting: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating platform fee:', error);
    res.status(500).json({ error: 'Failed to update platform fee' });
  }
});


// --- NEW: SURGE Fee Management (Admin Only) ---

// GET the current surge fee
router.get('/settings/surge-fee', async (req, res) => {
  try {
    const result = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'surge_fee'");
    if (result.rows.length === 0) {
      return res.json({ setting_key: 'surge_fee', setting_value: '0' }); // Default to 0 if not set
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching surge fee:', error);
    res.status(500).json({ error: 'Failed to fetch surge fee' });
  }
});

// SET the surge fee (using UPSERT for robustness)
router.put('/settings/surge-fee', async (req, res) => {
  const { surge } = req.body;
  const surgeValue = parseInt(surge, 10);

  if (isNaN(surgeValue) || surgeValue < 0) {
    return res.status(400).json({ error: 'Surge fee must be a non-negative number.' });
  }

  try {
    const query = `
      INSERT INTO store_settings (setting_key, setting_value)
      VALUES ('surge_fee', $1)
      ON CONFLICT (setting_key) 
      DO UPDATE SET setting_value = EXCLUDED.setting_value
      RETURNING setting_key, setting_value;
    `;
    const result = await pool.query(query, [surgeValue.toString()]);
    res.json({
      message: 'Surge fee updated successfully.',
      setting: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating surge fee:', error);
    res.status(500).json({ error: 'Failed to update surge fee' });
  }
});


// In src/api/routes/admin.js

// ... (after your existing product management routes)

// --- NEW: Offer Management (Admin Only) ---

// GET all existing offers
router.get('/offers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// GET coupons that are NOT yet assigned to an offer
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

// CREATE a new offer
router.post('/offers', async (req, res) => {
  const { name, description, coupon_code } = req.body;
  if (!name || !description || !coupon_code) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const query = `
      INSERT INTO offers (name, description, coupon_code) 
      VALUES ($1, $2, $3) RETURNING *`;
    const result = await pool.query(query, [name, description, coupon_code]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // Unique key violation
        return res.status(409).json({ error: 'This coupon is already used in another offer.' });
    }
    res.status(500).json({ error: 'Failed to create offer' });
  }
});

// DELETE an offer
router.delete('/offers/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM offers WHERE id = $1', [id]);
        res.status(200).json({ message: 'Offer deleted successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete offer' });
    }
});


// ... (rest of your admin routes)

// --- Coupon Management (CRUD) ---

// GET all coupons
// Path: GET /api/admin/coupons
router.get('/coupons', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

// CREATE a new coupon
// Path: POST /api/admin/coupons
router.post('/coupons', async (req, res) => {
  const { code, discount_type, discount_value } = req.body;

  // --- Step 1: Add detailed logging to see what the server is receiving ---
  console.log('Received request to create coupon with data:', req.body);

  if (!code || !discount_type || !discount_value) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    // Check for duplicates first
    const existingCoupon = await pool.query('SELECT id FROM coupons WHERE code = $1', [code.toUpperCase()]);
    if (existingCoupon.rows.length > 0) {
      return res.status(409).json({ error: 'A coupon with this code already exists.' });
    }

    const query = `
      INSERT INTO coupons (code, discount_type, discount_value)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    
    // Ensure data types are correct before sending to the database
    const params = [
        code.toUpperCase(), // Store codes consistently
        discount_type,      // This should be 'percentage' or 'fixed'
        parseInt(discount_value, 10) // Ensure this is an integer
    ];

    const newCoupon = await pool.query(query, params);
    res.status(201).json(newCoupon.rows[0]);

  } catch (error) {
    // --- Step 2: Log the specific database error for easier debugging ---
    console.error('Error creating coupon in database:', error);
    res.status(500).json({ error: 'Internal Server Error: Could not create coupon.' });
  }
});


// UPDATE an existing coupon
// Path: PUT /api/admin/coupons/:id
router.put('/coupons/:id', async (req, res) => {
    const { id } = req.params;
    const { code, discount_type, discount_value, is_active, expires_at } = req.body;

    try {
        const query = `
            UPDATE coupons
            SET code = $1, discount_type = $2, discount_value = $3, is_active = $4, expires_at = $5
            WHERE id = $6
            RETURNING *;
        `;
        const result = await pool.query(query, [code.toUpperCase(), discount_type, discount_value, is_active, expires_at, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Coupon not found.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Another coupon with this code already exists.' });
        }
        console.error('Error updating coupon:', error);
        res.status(500).json({ error: 'Failed to update coupon' });
    }
});

// DELETE a coupon
// Path: DELETE /api/admin/coupons/:id
router.delete('/coupons/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM coupons WHERE id = $1 RETURNING *;', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Coupon not found.' });
        }
        res.status(200).json({ message: 'Coupon deleted successfully.' });
    } catch (error) {
        console.error('Error deleting coupon:', error);
        res.status(500).json({ error: 'Failed to delete coupon' });
    }
});

// --- PRODUCT MANAGEMENT ---

// GET all products (for the admin view)
router.get('/products', async (req, res) => {
  try {
    const products = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(products.rows);
  } catch (error) {
    console.error('Error fetching products for admin:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// POST a new product
router.post('/products', async (req, res) => {
  const { name, cut, weight, price, img, tags } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Name and Price are required fields.' });
  }

  try {
    const query = `
      INSERT INTO products (name, cut, weight, price, img, tags)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const newProduct = await pool.query(query, [name, cut, weight, price, img, tags]);
    res.status(201).json(newProduct.rows[0]);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT to toggle a product's availability
router.put('/products/:id/toggle-availability', async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;

  if (typeof is_available !== 'boolean') {
    return res.status(400).json({ error: 'Field "is_available" must be a boolean.' });
  }

  try {
    const query = `
      UPDATE products
      SET is_available = $1
      WHERE id = $2
      RETURNING id, name, is_available;
    `;
    const updatedProduct = await pool.query(query, [is_available, id]);

    if (updatedProduct.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      message: 'Product availability updated successfully.',
      product: updatedProduct.rows[0]
    });
  } catch (error) {
    console.error('Error toggling product availability:', error);
    res.status(500).json({ error: 'Failed to update product availability' });
  }
});






// --- Order Management (Placeholders from before) ---
// In src/api/routes/admin.js

// --- Order Management ---

// This replaces your old placeholder route.
router.get('/orders', async (req, res) => {
  try {
    const queryStr = `
      SELECT 
        o.*, 
        d.tracking_url,
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

// ... (rest of your admin routes)
router.post('/orders/:orderId/cancel', (req, res) => {
  // Logic to cancel an order will go here
  res.json({ message: `Order ${req.params.orderId} cancelled (placeholder)` });
});


export const adminRouter = router;

//SHOW ALL ORDERS
//TRACKING LINKS FOR THEM
//HAVE IT IN A COMPONENT AND RENDER IT NICELY
//ADD PLATFORM FEE
//CHANGING THE STORE TIMINGS FROM THE BACKEND AND GETTING THAT REFLECTED ON THE UI/STATIC PAGE
//BUIDLING SOME STATIC PAGES AND REFACTORING THE UI
//SEEDING THE DATABASE
//CHANGING ALL THE ENV VARIABLE BEFORE PUSHING IT TO PROD
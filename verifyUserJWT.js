import { Clerk } from '@clerk/clerk-sdk-node';
import 'dotenv/config';

// 1. Log to confirm the secret key is being loaded.
// console.log("Clerk Secret Key (first 5):", process.env.CLERK_SECRET_KEY ? process.env.CLERK_SECRET_KEY.substring(0, 5) + "..." : "NOT FOUND");

const clerk = Clerk({ secretKey: process.env.CLERK_SECRET_KEY });

export const verifyUserJWT = async (req, res, next) => {
  
  // 2. Log when the middleware is hit.
  // console.log(`\n--- verifyUserJWT Middleware Triggered for: ${req.method} ${req.url} ---`);
  
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error("Auth Error: No 'Bearer ' token provided in header.");
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  
  const token = authHeader.split(' ')[1];
  
  // 3. Log the token we received.
  
  try {
    // 4. This is the critical step.
    const claims = await clerk.verifyToken(token);
    
    if (!claims.sub) {
      console.error("Auth Error: Token was verified, but it's invalid (no 'sub' claim).");
      return res.status(401).json({ error: 'Unauthorized: Invalid token claims' });
    }
    
    // 5. This is the success log!
    req.auth = { userId: claims.sub };
    next();

  } catch (error) {
    // 6. This is the failure log. This is what we expect to see.
    // console.error("\n!!!!!!!! AUTHENTICATION FAILED !!!!!!!");
    // console.error("Error from clerk.verifyToken(token):", error.message);
    // console.error("\nThis error almost always means your backend CLERK_SECRET_KEY and your frontend VITE_CLERK_PUBLISHABLE_KEY are from DIFFERENT Clerk applications. Please double-check them.");
    // console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n");
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};
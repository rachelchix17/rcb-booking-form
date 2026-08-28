// GET /api/config
// Returns the PUBLISHABLE Stripe key to the front-end.
// The publishable key (pk_test_... / pk_live_...) is safe to expose in the browser.
// This means all Stripe keys live ONLY in Vercel environment variables — you never
// paste a key into the page code.

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';

  if (!publishableKey) {
    return res.status(500).json({
      error: 'Stripe publishable key not configured. Set STRIPE_PUBLISHABLE_KEY in Vercel.',
    });
  }

  // Small cache so the page loads fast; key rarely changes.
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ publishableKey });
};

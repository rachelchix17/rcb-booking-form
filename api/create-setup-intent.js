// POST /api/create-setup-intent
// Creates (or reuses) a Stripe Customer for this booking and a SetupIntent so the
// customer's card can be SAVED with NO charge. The card is charged manually later
// by Michael from the Stripe dashboard.
//
// Requires env var: STRIPE_SECRET_KEY  (sk_test_... for testing, sk_live_... for live)

const Stripe = require('stripe');

function readBody(req) {
  // Vercel usually parses JSON automatically, but guard for raw bodies too.
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured on the server.' });
  }

  const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });

  try {
    const body = await readBody(req);
    const fullName = (body.full_name || '').trim();
    const email = (body.email || '').trim();
    const phone = (body.phone || '').trim();
    const address = (body.address || '').trim();
    const quoteNo = (body.quote_no || '').trim();
    const bookingDate = (body.booking_date || '').trim();

    if (!email && !fullName) {
      return res.status(400).json({ error: 'Missing customer name and email.' });
    }

    // Reuse an existing customer for this quote if one already exists (avoids duplicates
    // if the customer reloads the page), otherwise create a fresh one.
    let customer = null;
    if (quoteNo) {
      const existing = await stripe.customers.search({
        query: `metadata['quote_no']:'${quoteNo.replace(/'/g, "")}'`,
        limit: 1,
      }).catch(() => null);
      if (existing && existing.data && existing.data.length) customer = existing.data[0];
    }

    if (!customer) {
      customer = await stripe.customers.create({
        name: fullName || undefined,
        email: email || undefined,
        phone: phone || undefined,
        // Description is what Michael sees at a glance in the Stripe Customers list.
        description: `RCB Booking ${quoteNo || ''} - ${fullName || email}`.trim(),
        metadata: {
          quote_no: quoteNo,
          booking_date: bookingDate,
          address: address,
          phone: phone,
          source: 'RCB Secure My Booking page',
        },
      });
    }

    // SetupIntent = save the card for future off-session charging, with NO payment now.
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session', // lets Michael charge the saved card later from the dashboard
      metadata: {
        quote_no: quoteNo,
        booking_date: bookingDate,
        full_name: fullName,
      },
    });

    return res.status(200).json({
      clientSecret: setupIntent.client_secret,
      customerId: customer.id,
      setupIntentId: setupIntent.id,
    });
  } catch (err) {
    console.error('create-setup-intent error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create setup intent.' });
  }
};
